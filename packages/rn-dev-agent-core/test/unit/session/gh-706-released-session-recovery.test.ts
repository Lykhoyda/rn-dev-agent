import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { readProcessBirth } from '../../../dist/session/process-birth.js';
import { openSessionRegistry } from '../../../dist/session/registry.js';
import { resolveSourceIdentity } from '../../../dist/session/source-identity.js';
import { createAuthorityStateLayout } from '../../../dist/session/state-root.js';
import { createWorkerAuthorityRuntime } from '../../../dist/session/runtime.js';
import {
  createSupervisorAuthority,
  resolveSupervisorAuthorityForSpawn,
  supervisorSessionIsTerminal,
} from '../../../dist/session/supervisor-authority.js';
import { createSessionHandler } from '../../../dist/tools/session.js';

const cliPath = new URL('../../../dist/rn-session.js', import.meta.url).pathname;

const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

const source = {
  kind: 'git',
  contentRoot: '/repo',
  appRoot: '/repo/apps/mobile',
  sourceKey: 'source-key',
  worktreeKey: 'worktree-key',
  appRootKey: 'app-key',
  head: 'abc123',
};

function mintSupervisor(stateDir) {
  return createSupervisorAuthority({
    stateDir,
    source,
    supervisorBirth: { pid: process.pid, source: 'darwin-ps', token: 'supervisor-birth' },
    uid: '501',
    startHeartbeat: false,
    ownerStatus: () => 'match',
  });
}

function workerRuntime(environment) {
  return createWorkerAuthorityRuntime(environment, {
    readBirth: () => ({ pid: process.pid, source: 'darwin-ps', token: 'worker-birth' }),
    ownerStatus: () => 'match',
  });
}

test('release mints a fresh session in-band and the next bind_device works', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'rn-gh706-'));
  roots.push(stateDir);
  const released = mintSupervisor(stateDir);
  const releasedRuntime = workerRuntime(released.workerEnvironment('worker-a'));
  let recycleRequests = 0;
  const releasedHandler = createSessionHandler(releasedRuntime, {
    deviceExists: () => true,
    requestWorkerRecycle: () => {
      recycleRequests += 1;
      return true;
    },
  });

  const release = await releasedHandler({ action: 'release', confirmed: true });
  assert.notEqual(release.isError, true);
  assert.equal(recycleRequests, 1);
  assert.match(JSON.stringify(release), /A fresh session is minted automatically/);

  // The released row is the dead end reported in GH #706.
  const deadEnd = await releasedHandler({
    action: 'bind_device',
    platform: 'ios',
    deviceId: 'SIM-1',
    appId: 'dev.example',
  });
  assert.equal(deadEnd.isError, true);
  assert.match(JSON.stringify(deadEnd), /SESSION_OWNER_LOST/);
  releasedRuntime.close();

  assert.equal(supervisorSessionIsTerminal(released), true);
  const resolution = resolveSupervisorAuthorityForSpawn(released, () => mintSupervisor(stateDir));
  assert.equal(resolution.minted, true);
  assert.equal(resolution.error, null);
  const fresh = resolution.authority;
  assert.notEqual(fresh.session.sessionId, released.session.sessionId);

  const freshRuntime = workerRuntime(fresh.workerEnvironment('worker-b'));
  try {
    const freshHandler = createSessionHandler(freshRuntime, { deviceExists: () => true });
    const status = freshRuntime.status();
    assert.equal(status.available, true);
    assert.equal(status.state, 'source_bound');
    const bound = await freshHandler({
      action: 'bind_device',
      platform: 'ios',
      deviceId: 'SIM-1',
      appId: 'dev.example',
    });
    assert.notEqual(bound.isError, true);
    assert.match(JSON.stringify(bound), /buildReceiptRequired/);
  } finally {
    freshRuntime.close();
    await fresh.close();
  }
});

test('release without an available recycle tells the caller a transport restart is required', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'rn-gh706-unsupervised-'));
  roots.push(stateDir);
  const supervisor = mintSupervisor(stateDir);
  const runtime = workerRuntime(supervisor.workerEnvironment('worker-a'));
  try {
    const handler = createSessionHandler(runtime, {
      deviceExists: () => true,
      requestWorkerRecycle: () => false,
    });
    const release = await handler({ action: 'release', confirmed: true });
    assert.notEqual(release.isError, true);
    const body = JSON.parse(release.content[0].text);
    assert.equal(body.data.recycleRequested, false);
    assert.match(body.data.nextAction, /restart the MCP transport/);
    assert.doesNotMatch(body.data.nextAction, /minted automatically/);
  } finally {
    runtime.close();
    await supervisor.close();
  }
});

test('a live session is never replaced by a freshly minted one', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'rn-gh706-live-'));
  roots.push(stateDir);
  const live = mintSupervisor(stateDir);
  try {
    assert.equal(supervisorSessionIsTerminal(live), false);
    const resolution = resolveSupervisorAuthorityForSpawn(live, () => {
      throw new Error('a live session must never be re-minted');
    });
    assert.equal(resolution.minted, false);
    assert.equal(resolution.authority, live);
  } finally {
    await live.close();
  }
});

test('the build CLI ignores released and proven-stale rows for worktree matching', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-gh706-cli-'));
  roots.push(root);
  const appRoot = join(root, 'app');
  const stateHome = join(root, 'state');
  execFileSync('git', ['init', '-q', appRoot]);
  execFileSync('git', ['-C', appRoot, 'config', 'user.email', 'test@example.invalid']);
  execFileSync('git', ['-C', appRoot, 'config', 'user.name', 'Test']);
  writeFileSync(join(appRoot, 'package.json'), '{}\n');
  execFileSync('git', ['-C', appRoot, 'add', 'package.json']);
  execFileSync('git', ['-C', appRoot, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture']);

  const previousStateHome = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = stateHome;
  try {
    const identity = resolveSourceIdentity(appRoot);
    const keys = {
      sourceKey: identity.sourceKey,
      worktreeKey: identity.worktreeKey,
      appRootKey: identity.appRootKey,
    };
    const layout = createAuthorityStateLayout();
    const registry = openSessionRegistry(layout.registry, { ownerStatus: () => 'match' });
    const releasedSession = registry.createSession({
      sessionId: 'session-released',
      ...keys,
      supervisor: { pid: process.pid, token: readProcessBirth(process.pid)?.token ?? 'fixture' },
      source: { ...identity },
    });
    registry.releaseSession(releasedSession);
    registry.createSession({
      sessionId: 'session-proven-stale',
      ...keys,
      supervisor: { pid: process.pid, token: 'dead-birth' },
      source: { ...identity },
      bindings: { metroPort: 8194 },
    });
    const live = registry.createSession({
      sessionId: 'session-live',
      ...keys,
      supervisor: { pid: process.pid, token: readProcessBirth(process.pid)?.token ?? 'fixture' },
      source: { ...identity },
      bindings: { metroPort: 8193 },
    });
    registry.updateBindings(live, {
      state: 'device_claimed',
      bindings: { device: { platform: 'ios', deviceId: 'SIM-1', appId: 'dev.example' } },
    });
    registry.close();

    const result = spawnSync(process.execPath, [cliPath, 'build-json'], {
      cwd: appRoot,
      env: { ...process.env, XDG_STATE_HOME: stateHome },
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).sessionId, 'session-live');
  } finally {
    if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousStateHome;
  }
});

test('released and proven-stale rows never count as live worktree sessions', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-gh706-worktree-'));
  roots.push(root);
  const registryPath = join(root, 'registry.sqlite3');
  const registry = openSessionRegistry(registryPath, {
    ownerStatus: (owner) => (owner.token === 'live-birth' ? 'match' : 'mismatch'),
  });
  try {
    const releasedSession = registry.createSession({
      sessionId: 'session-released',
      sourceKey: 'source',
      worktreeKey: 'worktree',
      appRootKey: 'app',
      supervisor: { pid: process.pid, token: 'live-birth' },
    });
    registry.releaseSession(releasedSession);
    registry.createSession({
      sessionId: 'session-proven-stale',
      sourceKey: 'source',
      worktreeKey: 'worktree',
      appRootKey: 'app',
      supervisor: { pid: process.pid, token: 'dead-birth' },
    });
    registry.createSession({
      sessionId: 'session-live',
      sourceKey: 'source',
      worktreeKey: 'worktree',
      appRootKey: 'app',
      supervisor: { pid: process.pid, token: 'live-birth' },
    });

    assert.deepEqual(
      registry.findSessionsByWorktree('worktree').map((status) => status.sessionId),
      ['session-live'],
    );
  } finally {
    registry.close();
  }
});
