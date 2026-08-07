// GH #706: drive the real supervisor + worker and prove `release` recovers in-band —
// worker recycle request → SIGUSR2 → respawn → freshly resolved session.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSupervisor } from '../helpers/supervisor-harness.js';

async function handshake(supervisor) {
  const id = supervisor.send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'gh706-client', version: '0.0.0' },
  });
  const init = JSON.parse(await supervisor.nextLine());
  assert.equal(init.id, id, 'initialize must be answered first');
  supervisor.notify('notifications/initialized');
}

async function callSession(supervisor, args) {
  const id = supervisor.send('tools/call', { name: 'rn_session', arguments: args });
  const reply = JSON.parse(await supervisor.nextLine());
  assert.equal(reply.id, id);
  if (reply.error) return { transportError: reply.error.message };
  return JSON.parse(reply.result?.content?.[0]?.text ?? '{}');
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
  assert.fail(
    `no fresh session was resolved after release; last status: ${JSON.stringify(last)}\n` +
      `supervisor stderr:\n${supervisor.stderrText().slice(-1500)}`,
  );
}

test(
  'GH#706: release recycles the worker and the respawned one gets a freshly minted session',
  { timeout: 120_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'rn-agent-gh706-'));
    const project = join(root, 'project');
    const stateHome = join(root, 'state');
    const lockDir = join(root, 'lock');
    let supervisor = null;
    try {
      for (const dir of [project, stateHome, lockDir]) await mkdir(dir, { recursive: true });
      await writeFile(
        join(project, 'package.json'),
        JSON.stringify({ name: 'gh706-fixture', version: '0.0.0', dependencies: {} }),
        'utf8',
      );

      supervisor = startSupervisor({
        cwd: project,
        env: {
          XDG_STATE_HOME: stateHome,
          TMPDIR: lockDir,
          RN_DEV_AGENT_DECLARED_ROOT: project,
          RN_DEV_AGENT_DECLARED_MANIFESTS: 'package.json',
          RN_AGENT_OBSERVE_AUTOSTART: '0',
        },
        lineTimeoutMs: 30_000,
      });
      await handshake(supervisor);

      const before = await callSession(supervisor, { action: 'status' });
      assert.equal(before.ok, true, `status failed: ${JSON.stringify(before)}`);
      const released = before.data.authority;
      assert.equal(released.available, true, 'the worker must start with a real session');
      assert.ok(released.sessionId, 'status exposes the session id');

      const release = await callSession(supervisor, { action: 'release', confirmed: true });
      assert.equal(release.ok, true, `release failed: ${JSON.stringify(release)}`);
      assert.equal(release.data.released, true);
      assert.equal(
        release.data.recycleRequested,
        true,
        'a supervised worker must actually request the recycle it advertises',
      );

      const fresh = await waitForFreshSession(supervisor, released.sessionId);
      assert.equal(fresh.state, 'source_bound', 'the successor owns the source claim');

      const bound = await callSession(supervisor, {
        action: 'bind_device',
        platform: 'ios',
        deviceId: 'SIM-GH706',
        appId: 'dev.example.gh706',
      });
      assert.doesNotMatch(
        JSON.stringify(bound),
        /SESSION_OWNER_LOST/,
        'the post-release chain must not hit the GH #706 dead end',
      );
    } finally {
      supervisor?.child.kill('SIGTERM');
      await rm(root, { force: true, recursive: true });
    }
  },
);
