// GH #672: drive two built supervisors over stdio and prove a same-root contender cannot steal a live owner's lock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { startSupervisor } from '../helpers/supervisor-harness.js';

const PARENT_WATCH_MS = 400;
const OWNERSHIP_CHECKS = 3;

function lockPathIn(dir) {
  const entry = readdirSync(dir).find((name) =>
    /^rn-dev-agent-cdp-\d+-[0-9a-f]{8}\.lock$/.test(name),
  );
  return entry ? join(dir, entry) : null;
}

async function readLockBody(dir) {
  const path = lockPathIn(dir);
  if (!path) return null;
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

async function handshake(supervisor, clientName) {
  const id = supervisor.send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: clientName, version: '0.0.0' },
  });
  const init = JSON.parse(await supervisor.nextLine());
  assert.equal(init.id, id, `${clientName}: initialize must be answered first`);
  supervisor.notify('notifications/initialized');
}

async function sessionStatus(supervisor) {
  supervisor.send('tools/call', {
    name: 'rn_session',
    arguments: { action: 'status' },
  });
  const call = JSON.parse(await supervisor.nextLine());
  return JSON.parse(call.result?.content?.[0]?.text ?? '{}');
}

async function toolNames(supervisor) {
  supervisor.send('tools/list');
  const list = JSON.parse(await supervisor.nextLine());
  return (list.result?.tools ?? []).map((tool) => tool.name).sort();
}

async function callTool(supervisor, name, args = {}) {
  supervisor.send('tools/call', { name, arguments: args });
  const call = JSON.parse(await supervisor.nextLine());
  return JSON.parse(call.result?.content?.[0]?.text ?? '{}');
}

// A requested worker reload can answer an in-flight call with a JSON-RPC error; poll past it.
async function waitForStatus(supervisor, predicate, what, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await sessionStatus(supervisor);
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, PARENT_WATCH_MS / 2));
  }
  assert.fail(`${what}; last status: ${JSON.stringify(last)}`);
}

function readRegistry(stateHome) {
  const path = join(stateHome, 'rn-dev-agent', 'v2', 'registry.sqlite3');
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return {
      sessions: database.prepare('SELECT session_id, state, bindings_json FROM sessions').all(),
      claims: database.prepare('SELECT resource_type, resource_key, session_id FROM claims').all(),
      allocations: database.prepare('SELECT service, port FROM allocations').all(),
    };
  } finally {
    database.close();
  }
}

test(
  'GH#672/#991: a second same-root supervisor waits read-only without stealing the lock or killing the owner',
  { timeout: 120_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'rn-agent-gh672-'));
    const project = join(root, 'project');
    const stateHome = join(root, 'state');
    const lockDir = join(root, 'lock');
    let owner = null;
    let contender = null;
    try {
      for (const dir of [project, stateHome, lockDir]) {
        await mkdir(dir, { recursive: true });
      }
      await writeFile(
        join(project, 'package.json'),
        JSON.stringify({
          name: 'gh672-fixture',
          version: '0.0.0',
          dependencies: {},
        }),
        'utf8',
      );

      const env = {
        XDG_STATE_HOME: stateHome,
        TMPDIR: lockDir,
        RN_DEV_AGENT_DECLARED_ROOT: project,
        RN_DEV_AGENT_DECLARED_MANIFESTS: 'package.json',
        RN_AGENT_OBSERVE_AUTOSTART: '0',
        RN_DEV_AGENT_PARENT_WATCH_MS: String(PARENT_WATCH_MS),
      };

      owner = startSupervisor({
        cwd: project,
        env,
        noLock: false,
        lineTimeoutMs: 30_000,
      });
      await handshake(owner, 'gh672-owner');
      const ownerStatus = await sessionStatus(owner);
      assert.equal(ownerStatus.ok, true, `owner status failed: ${JSON.stringify(ownerStatus)}`);
      const ownerAuthority = ownerStatus.data.authority;
      assert.equal(ownerAuthority.available, true, 'owner must hold a real authority session');
      assert.equal(ownerAuthority.state, 'source_bound', 'owner must own the source claim');

      const ownerLock = await readLockBody(lockDir);
      assert.ok(ownerLock, 'the real owner wrote a single-instance lock');
      const ownerPid = ownerLock.pid;
      assert.doesNotThrow(
        () => process.kill(ownerPid, 0),
        'the lock is held by a live owner supervisor',
      );

      const ownerTools = await toolNames(owner);
      contender = startSupervisor({
        cwd: project,
        env,
        noLock: false,
        lineTimeoutMs: 30_000,
      });
      await handshake(contender, 'gh672-contender');
      assert.deepEqual(
        await toolNames(contender),
        ownerTools,
        'the contender lists the full tool surface so an upgrade needs no tools/list_changed',
      );
      const refusal = await sessionStatus(contender);
      assert.equal(refusal.ok, false, `contender must refuse: ${JSON.stringify(refusal)}`);
      assert.equal(refusal.code, 'SAME_ROOT_OWNER_LIVE');
      assert.match(refusal.error, new RegExp(`pid ${ownerPid}\\b`), 'the refusal names the owner');
      const operational = await callTool(contender, 'cdp_status');
      assert.equal(operational.code, 'SAME_ROOT_OWNER_LIVE', 'operational tools refuse too');
      assert.equal(contender.child.exitCode, null, 'the contender stays connected');
      assert.match(
        contender.stderrText(),
        /Another rn-dev-agent MCP already owns this project root/,
        'the documented conflict diagnostic still reaches the MCP log',
      );

      // Span several REAL ownership checks: each parent-watch tick re-validates the
      // lock and self-terminates the owner if it was stolen.
      const start = Date.now();
      const deadline = start + PARENT_WATCH_MS * (OWNERSHIP_CHECKS + 2) + 4_000;
      let beats = 0;
      let lastSeen = ownerLock.lastHeartbeat;
      while (beats < OWNERSHIP_CHECKS && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, PARENT_WATCH_MS / 2));
        const body = await readLockBody(lockDir);
        assert.ok(body, 'the owner lock must never disappear while the owner is alive');
        assert.equal(body.pid, ownerPid, 'no contender may rewrite the live owner lock');
        if (typeof body.lastHeartbeat === 'number' && body.lastHeartbeat > lastSeen) {
          lastSeen = body.lastHeartbeat;
          beats += 1;
        }
      }
      assert.ok(
        beats >= OWNERSHIP_CHECKS,
        `expected at least ${OWNERSHIP_CHECKS} ownership checks, observed ${beats}`,
      );

      assert.equal(owner.child.exitCode, null, 'the owner must still be running');
      assert.doesNotThrow(
        () => process.kill(ownerPid, 0),
        'the lock-owning supervisor stays alive',
      );
      assert.equal(
        /single-instance lock reclaimed/.test(owner.stderrText()),
        false,
        'the owner must never observe its lock being reclaimed',
      );

      const afterStatus = await sessionStatus(owner);
      assert.equal(afterStatus.ok, true, 'the owner transport must still answer');
      assert.equal(afterStatus.data.authority.state, 'source_bound');
      assert.equal(
        afterStatus.data.authority.metroPort,
        ownerAuthority.metroPort,
        'the owner keeps its original Metro allocation',
      );

      const registry = readRegistry(stateHome);
      assert.equal(
        registry.sessions.length,
        1,
        `exactly one session row expected, got ${JSON.stringify(registry.sessions)}`,
      );
      assert.equal(registry.sessions[0].state, 'source_bound');
      const metroPorts = registry.allocations.filter((row) => row.service === 'metro');
      assert.equal(
        metroPorts.length,
        1,
        `exactly one Metro allocation expected, got ${JSON.stringify(registry.allocations)}`,
      );

      assert.equal(
        typeof (await readLockBody(lockDir)).identity,
        'string',
        'the lock records the owner entrypoint identity the contender matched against',
      );
      assert.equal(contender.child.exitCode, null, 'the contender waited through every check');
      assert.equal(
        (await sessionStatus(contender)).code,
        'SAME_ROOT_OWNER_LIVE',
        'a live owner is never taken over',
      );

      contender.child.kill('SIGTERM');
      await new Promise((resolve) => contender.child.on('exit', resolve));
      contender = null;
      owner.child.kill('SIGTERM');
      const ownerExit = await new Promise((resolve) => owner.child.on('exit', resolve));
      assert.equal(ownerExit, 0, 'the owner exits cleanly on SIGTERM');
      owner = null;
    } finally {
      if (contender) contender.child.kill('SIGKILL');
      if (owner) owner.child.kill('SIGKILL');
      await rm(root, { recursive: true, force: true });
    }
  },
);

// L4: a kill -9'd owner is a PROVEN-dead same-root session. A restarting supervisor
// must release it via the automatic journaled startup cleanup — no adoption handle,
// no blocked contender — and then run the normal happy path.
test(
  'GH#672/L4: a kill -9 owner is released by automatic startup cleanup on restart',
  { timeout: 120_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'rn-agent-gh672-l4-'));
    const project = join(root, 'project');
    const stateHome = join(root, 'state');
    const lockDir = join(root, 'lock');
    let owner = null;
    let successor = null;
    try {
      for (const dir of [project, stateHome, lockDir]) {
        await mkdir(dir, { recursive: true });
      }
      await writeFile(
        join(project, 'package.json'),
        JSON.stringify({
          name: 'gh672-l4-fixture',
          version: '0.0.0',
          dependencies: {},
        }),
        'utf8',
      );
      const env = {
        XDG_STATE_HOME: stateHome,
        TMPDIR: lockDir,
        RN_DEV_AGENT_DECLARED_ROOT: project,
        RN_DEV_AGENT_DECLARED_MANIFESTS: 'package.json',
        RN_AGENT_OBSERVE_AUTOSTART: '0',
        RN_DEV_AGENT_PARENT_WATCH_MS: String(PARENT_WATCH_MS),
      };

      owner = startSupervisor({
        cwd: project,
        env,
        noLock: false,
        lineTimeoutMs: 30_000,
      });
      await handshake(owner, 'gh672-l4-owner');
      const ownerStatus = await sessionStatus(owner);
      assert.equal(ownerStatus.ok, true, `owner status failed: ${JSON.stringify(ownerStatus)}`);
      assert.equal(ownerStatus.data.authority.state, 'source_bound');
      const ownerLock = await readLockBody(lockDir);
      assert.ok(ownerLock, 'the real owner wrote a single-instance lock');
      const ownerPid = ownerLock.pid;
      const deadSessionId = readRegistry(stateHome).sessions[0].session_id;

      const ownerExit = new Promise((resolve) => owner.child.on('exit', resolve));
      process.kill(ownerPid, 'SIGKILL');
      await ownerExit;
      owner = null;

      successor = startSupervisor({
        cwd: project,
        env,
        noLock: false,
        lineTimeoutMs: 30_000,
      });
      await handshake(successor, 'gh672-l4-successor');
      const successorStatus = await sessionStatus(successor);
      assert.equal(
        successorStatus.ok,
        true,
        `successor status failed: ${JSON.stringify(successorStatus)}`,
      );
      assert.equal(
        successorStatus.data.authority.state,
        'source_bound',
        `the successor must own the source claim after automatic cleanup; stderr:\n${successor
          .stderrText()
          .slice(-1500)}`,
      );
      assert.match(
        successor.stderrText(),
        /startup cleanup: released 1 proven-dead session/,
        'the successor reports the automatic journaled cleanup it performed',
      );
      assert.equal(
        /Another rn-dev-agent MCP already owns this project root/.test(successor.stderrText()),
        false,
        'a dead owner must never be reported as a live lock conflict',
      );

      const registry = readRegistry(stateHome);
      const dead = registry.sessions.find((row) => row.session_id === deadSessionId);
      assert.equal(dead?.state, 'released', 'the dead owner row is terminally released');
      const journal = JSON.parse(dead.bindings_json).startupCleanup;
      assert.equal(typeof journal?.finishedAt, 'number', 'the cleanup journal is durably finished');
      const successorRow = registry.sessions.find(
        (row) => row.session_id !== deadSessionId && row.state === 'source_bound',
      );
      assert.ok(
        successorRow,
        `expected a source_bound successor: ${JSON.stringify(registry.sessions)}`,
      );
      const sourceClaims = registry.claims.filter((claim) => claim.resource_type === 'source');
      assert.equal(sourceClaims.length, 1, 'exactly one source claim after cleanup');
      assert.equal(sourceClaims[0].session_id, successorRow.session_id);
      const metroPorts = registry.allocations.filter((row) => row.service === 'metro');
      assert.equal(metroPorts.length, 1, 'the worktree Metro allocation is reused, not duplicated');

      successor.child.kill('SIGTERM');
      const successorExit = await new Promise((resolve) => successor.child.on('exit', resolve));
      assert.equal(successorExit, 0, 'the successor exits cleanly on SIGTERM');
      successor = null;
    } finally {
      if (successor) successor.child.kill('SIGKILL');
      if (owner) owner.child.kill('SIGKILL');
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'GH#991: a waiting contender upgrades in place after a clean or crashed owner exit and names each new owner',
  { timeout: 180_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'rn-agent-gh991-'));
    const project = join(root, 'project');
    const stateHome = join(root, 'state');
    const lockDir = join(root, 'lock');
    const running = [];
    try {
      for (const dir of [project, stateHome, lockDir]) {
        await mkdir(dir, { recursive: true });
      }
      await writeFile(
        join(project, 'package.json'),
        JSON.stringify({
          name: 'gh991-fixture',
          version: '0.0.0',
          dependencies: {},
        }),
        'utf8',
      );
      const env = {
        XDG_STATE_HOME: stateHome,
        TMPDIR: lockDir,
        RN_DEV_AGENT_DECLARED_ROOT: project,
        RN_DEV_AGENT_DECLARED_MANIFESTS: 'package.json',
        RN_AGENT_OBSERVE_AUTOSTART: '0',
        RN_DEV_AGENT_PARENT_WATCH_MS: String(PARENT_WATCH_MS),
      };
      const start = (name) => {
        const supervisor = startSupervisor({
          cwd: project,
          env,
          noLock: false,
          lineTimeoutMs: 30_000,
        });
        supervisor.name = name;
        running.push(supervisor);
        return supervisor;
      };

      const owner = start('owner');
      await handshake(owner, 'gh991-owner');
      assert.equal((await sessionStatus(owner)).data?.authority?.state, 'source_bound');
      const ownerPid = (await readLockBody(lockDir)).pid;
      const ownerSessionId = readRegistry(stateHome).sessions[0].session_id;

      const contenders = [start('first'), start('second')];
      for (const contender of contenders) {
        await handshake(contender, `gh991-${contender.name}`);
        const refusal = await sessionStatus(contender);
        assert.equal(refusal.code, 'SAME_ROOT_OWNER_LIVE');
        assert.match(refusal.error, new RegExp(`pid ${ownerPid}\\b`));
      }

      owner.child.kill('SIGTERM');
      assert.equal(await new Promise((resolve) => owner.child.on('exit', resolve)), 0);
      running.splice(running.indexOf(owner), 1);

      const deadline = Date.now() + 20_000;
      let winner = null;
      while (!winner && Date.now() < deadline) {
        for (const contender of contenders) {
          const status = await sessionStatus(contender);
          if (status.ok && status.data?.authority?.state === 'source_bound') winner = contender;
        }
        if (!winner) await new Promise((resolve) => setTimeout(resolve, PARENT_WATCH_MS / 2));
      }
      assert.ok(
        winner,
        `no contender upgraded after the owner exited; stderr:\n${contenders
          .map((contender) => contender.stderrText().slice(-1200))
          .join('\n---\n')}`,
      );
      assert.equal(winner.child.exitCode, null, 'the winner upgraded without a host restart');
      assert.match(winner.stderrText(), /upgrading to a full worker/);

      const newOwnerPid = (await readLockBody(lockDir)).pid;
      assert.notEqual(newOwnerPid, ownerPid, 'the lock moved to the winner');
      const loser = contenders.find((contender) => contender !== winner);
      const refreshed = await waitForStatus(
        loser,
        (status) =>
          status.code === 'SAME_ROOT_OWNER_LIVE' && status.error.includes(`pid ${newOwnerPid}`),
        'the waiting contender must name the new owner',
      );
      assert.doesNotMatch(refreshed.error, new RegExp(`pid ${ownerPid}\\b`));
      assert.equal(loser.child.exitCode, null);

      const registry = readRegistry(stateHome);
      const sourceClaims = registry.claims.filter((claim) => claim.resource_type === 'source');
      assert.equal(sourceClaims.length, 1, `one source claim: ${JSON.stringify(registry.claims)}`);
      assert.notEqual(
        sourceClaims[0].session_id,
        ownerSessionId,
        'the winner minted its own session',
      );
      assert.equal(
        registry.allocations.filter((row) => row.service === 'metro').length,
        1,
        'the upgrade reuses the worktree Metro allocation',
      );

      const winnerSessionId = sourceClaims[0].session_id;
      const winnerExit = new Promise((resolve) => winner.child.on('exit', resolve));
      assert.equal(newOwnerPid, winner.child.pid, 'the lock names the winner supervisor');
      winner.child.kill('SIGKILL');
      await winnerExit;
      running.splice(running.indexOf(winner), 1);

      await waitForStatus(
        loser,
        (status) => status.ok && status.data?.authority?.state === 'source_bound',
        'the waiting contender must take over from a crashed owner',
      );
      assert.equal(loser.child.exitCode, null, 'the crash takeover also needs no host restart');
      assert.match(
        loser.stderrText(),
        /startup cleanup: released 1 proven-dead session/,
        'the upgrade runs journaled startup cleanup for the crashed owner',
      );
      const afterCrash = readRegistry(stateHome);
      assert.equal(
        afterCrash.sessions.find((row) => row.session_id === winnerSessionId)?.state,
        'released',
      );
      const crashClaims = afterCrash.claims.filter((claim) => claim.resource_type === 'source');
      assert.equal(crashClaims.length, 1);
      assert.notEqual(crashClaims[0].session_id, winnerSessionId);

      loser.child.kill('SIGTERM');
      assert.equal(await new Promise((resolve) => loser.child.on('exit', resolve)), 0);
      running.splice(running.indexOf(loser), 1);
    } finally {
      await Promise.all(
        running.map((supervisor) => {
          if (supervisor.child.exitCode !== null || supervisor.child.signalCode !== null) return;
          const exited = new Promise((resolve) => supervisor.child.on('exit', resolve));
          supervisor.child.kill('SIGKILL');
          return exited;
        }),
      );
      await rm(root, { recursive: true, force: true });
    }
  },
);
