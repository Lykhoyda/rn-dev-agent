import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { createSupervisorAuthority } from '../../../dist/session/supervisor-authority.js';

const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

test('supervisor creates one source-and-port session inherited by worker respawns', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'rn-supervisor-authority-'));
  roots.push(stateDir);
  const source = {
    kind: 'git',
    contentRoot: '/repo',
    appRoot: '/repo/apps/mobile',
    sourceKey: 'source-key',
    worktreeKey: 'worktree-key',
    appRootKey: 'app-key',
    head: 'abc123',
  };
  const authority = createSupervisorAuthority({
    stateDir,
    source,
    supervisorBirth: { pid: 101, source: 'darwin-ps', token: 'supervisor-birth' },
    uid: '501',
    startHeartbeat: false,
    ownerStatus: () => 'match',
  });

  try {
    const first = authority.workerEnvironment('worker-a');
    const second = authority.workerEnvironment('worker-b');
    assert.equal(first.RN_DEV_AGENT_SESSION_ID, second.RN_DEV_AGENT_SESSION_ID);
    assert.equal(first.RN_DEV_AGENT_CLAIM_EPOCH, '1');
    assert.notEqual(first.RN_DEV_AGENT_WORKER_INSTANCE, second.RN_DEV_AGENT_WORKER_INSTANCE);
    assert.match(first.RN_DEV_AGENT_METRO_PORT, /^\d+$/);
    assert.match(first.RN_DEV_AGENT_OBSERVE_PORT, /^\d+$/);

    const status = authority.registry.getSessionStatus(authority.session.sessionId);
    assert.equal(status.state, 'source_bound');
    assert.deepEqual(
      status.claims.map((claim) => claim.type),
      ['metro-port', 'observe-port', 'source'],
    );
  } finally {
    authority.close();
  }
});

test('supervisor refuses to manufacture authority without process-birth proof', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'rn-supervisor-authority-'));
  roots.push(stateDir);

  assert.throws(
    () =>
      createSupervisorAuthority({
        stateDir,
        source: {
          kind: 'declared-root',
          contentRoot: '/repo',
          appRoot: '/repo',
          sourceKey: 'source-key',
          worktreeKey: 'worktree-key',
          appRootKey: 'app-key',
          manifestDigest: 'manifest',
        },
        supervisorBirth: null,
        uid: '501',
        startHeartbeat: false,
        ownerStatus: () => 'unknown',
      }),
    /PROCESS_BIRTH_UNAVAILABLE/,
  );
});
