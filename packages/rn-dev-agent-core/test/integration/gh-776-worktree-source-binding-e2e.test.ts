// GH #776: drive the real supervisor + worker over stdio with the transport
// started in a repository's PRIMARY checkout while the branch work lives in a
// LINKED git worktree — the exact mismatch that silently mutated the wrong tree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSupervisor } from '../helpers/supervisor-harness.js';

const transcript: string[] = [];

function record(label, payload) {
  transcript.push(`\n=== ${label} ===\n${JSON.stringify(payload, null, 2)}`);
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return (result.stdout ?? '').trim();
}

async function handshake(supervisor) {
  const id = supervisor.send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'gh776-client', version: '0.0.0' },
  });
  const init = JSON.parse(await supervisor.nextLine());
  assert.equal(init.id, id, 'initialize must be answered first');
  supervisor.notify('notifications/initialized');
}

async function callOnce(supervisor, args) {
  const id = supervisor.send('tools/call', { name: 'rn_session', arguments: args });
  const reply = JSON.parse(await supervisor.nextLine());
  assert.equal(reply.id, id);
  if (reply.error) return { transportError: reply.error.message };
  return JSON.parse(reply.result?.content?.[0]?.text ?? '{}');
}

// The axis-C fence re-proves the worker's process birth through a signed helper
// with a 2s budget and fails closed when that budget is blown. On a machine busy
// enough to do that, the refusal is a probe artifact, not a session verdict, so
// the call is retried before it is read as one.
async function callSession(supervisor, args) {
  let reply = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    reply = await callOnce(supervisor, args);
    if (reply.code !== 'SESSION_OWNER_LOST') return reply;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return reply;
}

// The supervisor proves its own process birth once at boot through a signed
// helper with a 2s budget; a machine busy enough to blow that budget boots
// without a session at all, so a fresh transport is spawned instead.
async function bootSupervisorWithSession(stateRoot, options) {
  let last = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    // A retried transport gets its own state home: the abandoned attempt's
    // registry rows are owned by a controller that no longer exists.
    const stateHome = join(stateRoot, `attempt-${attempt}`);
    await mkdir(stateHome, { recursive: true });
    const supervisor = startSupervisor({
      ...options,
      env: { ...options.env, XDG_STATE_HOME: stateHome },
    });
    await handshake(supervisor);
    const status = await callSession(supervisor, { action: 'status' });
    last = status;
    if (status.data?.authority?.available === true)
      return { supervisor, authority: status.data.authority };
    supervisor.child.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.fail(`the transport never resolved a session; last status: ${JSON.stringify(last)}`);
}

async function waitForFreshSession(supervisor, releasedSessionId) {
  const deadline = Date.now() + 30_000;
  let last = null;
  while (Date.now() < deadline) {
    const status = await callSession(supervisor, { action: 'status' });
    last = status;
    const authority = status.data?.authority;
    if (authority?.available === true && authority.sessionId !== releasedSessionId)
      return authority;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.fail(`no successor session was minted; last status: ${JSON.stringify(last)}`);
}

async function writeApp(root, name) {
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({
      name,
      version: '0.0.0',
      scripts: { ios: 'expo run:ios', android: 'expo run:android' },
      dependencies: { expo: '52.0.0', react: '18.3.1', 'react-native': '0.76.0' },
    }),
    'utf8',
  );
  await writeFile(
    join(root, 'metro.config.js'),
    "const { getDefaultConfig } = require('expo/metro-config');\nmodule.exports = getDefaultConfig(__dirname);\n",
    'utf8',
  );
  await writeFile(join(root, 'app.json'), JSON.stringify({ expo: { name } }), 'utf8');
}

test(
  'GH#776: bind_source rebinds a linked worktree and the fence names both roots end-to-end',
  { timeout: 180_000 },
  async () => {
    const root = realpathSync(await mkdtemp(join(tmpdir(), 'rn-agent-gh776-e2e-')));
    const primary = join(root, 'primary');
    const linked = join(root, 'linked');
    const stateHome = join(root, 'state');
    const lockDir = join(root, 'lock');
    let supervisor = null;
    try {
      for (const dir of [primary, stateHome, lockDir]) await mkdir(dir, { recursive: true });
      git(root, ['init', '-q', primary]);
      git(primary, ['config', 'user.email', 'fixture@example.test']);
      git(primary, ['config', 'user.name', 'fixture']);
      git(primary, ['config', 'commit.gpgsign', 'false']);
      await writeApp(primary, 'gh776-primary');
      git(primary, ['add', '-A']);
      git(primary, ['commit', '-qm', 'init']);
      git(primary, ['worktree', 'add', '-q', linked, '-b', 'fm/issue-776']);
      await writeApp(linked, 'gh776-linked');

      // The transport boots in the PRIMARY checkout, exactly like an MCP harness
      // whose startup cwd is the repo's main tree.
      const booted = await bootSupervisorWithSession(stateHome, {
        cwd: primary,
        env: {
          TMPDIR: lockDir,
          RN_AGENT_OBSERVE_AUTOSTART: '0',
        },
        lineTimeoutMs: 30_000,
      });
      supervisor = booted.supervisor;
      const bootSession = booted.authority;
      record('1. status — transport booted in the PRIMARY checkout', bootSession);

      // (2) The mismatch is a typed refusal naming BOTH paths, reachable end-to-end.
      const fenced = await callSession(supervisor, {
        action: 'preview_integration',
        projectRoot: linked,
      });
      record('2. preview_integration on the linked worktree — refused before mutating', fenced);
      assert.equal(fenced.code, 'SOURCE_ROOT_DIVERGENCE', JSON.stringify(fenced));
      assert.ok(String(fenced.error).includes(primary), 'refusal names the bound root');
      assert.ok(String(fenced.error).includes(linked), 'refusal names the declared root');

      // (1) Explicit bind to the intended project root.
      const rebind = await callSession(supervisor, { action: 'bind_source', projectRoot: linked });
      record('3. bind_source projectRoot=<linked worktree>', rebind);
      assert.equal(rebind.ok, true, `bind_source failed: ${JSON.stringify(rebind)}`);
      assert.equal(rebind.data.released, true);
      assert.equal(rebind.data.successorRoot, linked);
      assert.equal(rebind.data.recycleRequested, true);

      const fresh = await waitForFreshSession(supervisor, bootSession.sessionId);
      record('4. status — successor session minted on the linked worktree', fresh);
      assert.equal(fresh.state, 'source_bound');

      // (3) Managed integration now targets the linked worktree instead of refusing.
      const preview = await callSession(supervisor, {
        action: 'preview_integration',
        projectRoot: linked,
      });
      record('5. preview_integration on the linked worktree after rebind — accepted', preview);
      assert.equal(preview.ok, true, `preview_integration failed: ${JSON.stringify(preview)}`);

      // The fence follows the new binding: the primary checkout is now foreign.
      const reversed = await callSession(supervisor, {
        action: 'preview_integration',
        projectRoot: primary,
      });
      record('6. preview_integration on the PRIMARY checkout after rebind — refused', reversed);
      assert.equal(reversed.code, 'SOURCE_ROOT_DIVERGENCE', JSON.stringify(reversed));
      assert.ok(
        String(reversed.error).includes(`session source is bound to ${linked}`),
        'the successor really owns the linked worktree',
      );
      assert.ok(String(reversed.error).includes(primary), 'refusal names the declared root');

      console.log(transcript.join('\n'));
    } finally {
      supervisor?.child.kill('SIGTERM');
      await rm(root, { force: true, recursive: true });
    }
  },
);
