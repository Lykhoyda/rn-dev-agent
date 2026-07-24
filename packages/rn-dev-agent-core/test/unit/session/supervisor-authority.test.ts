import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

test('supervisor close is idempotent after the session was already released', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'rn-supervisor-authority-'));
  roots.push(stateDir);
  const authority = createSupervisorAuthority({
    stateDir,
    source: {
      kind: 'git',
      contentRoot: '/repo',
      appRoot: '/repo',
      sourceKey: 'source-key',
      worktreeKey: 'worktree-key',
      appRootKey: 'app-key',
      head: 'abc123',
    },
    supervisorBirth: { pid: 101, source: 'linux-proc', token: 'supervisor-birth' },
    uid: '501',
    startHeartbeat: false,
    ownerStatus: () => 'match',
  });

  authority.registry.releaseSession(authority.session);
  assert.doesNotThrow(() => authority.close());
});

test('a supervisor without the source claim stays blocked and exposes the full adoption ID', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'rn-supervisor-authority-'));
  roots.push(stateDir);
  const source = {
    kind: 'git' as const,
    contentRoot: '/repo',
    appRoot: '/repo/apps/mobile',
    sourceKey: 'source-key',
    worktreeKey: 'worktree-key',
    appRootKey: 'app-key',
    head: 'abc123',
  };
  const priorId = '11111111-2222-3333-4444-555555555555';
  const prior = createSupervisorAuthority({
    stateDir,
    source,
    sessionId: priorId,
    supervisorBirth: { pid: 101, source: 'linux-proc', token: 'prior-birth' },
    uid: '501',
    startHeartbeat: false,
    ownerStatus: (owner) => (owner.sessionId === priorId ? 'match' : 'unknown'),
  });
  const blocked = createSupervisorAuthority({
    stateDir,
    source,
    supervisorBirth: { pid: 202, source: 'linux-proc', token: 'blocked-birth' },
    uid: '501',
    startHeartbeat: false,
    ownerStatus: (owner) => (owner.sessionId === priorId ? 'match' : 'unknown'),
  });

  try {
    const status = blocked.registry.getSessionStatus(blocked.session.sessionId);
    assert.ok(status);
    assert.equal(status.state, 'blocked');
    assert.equal((status.bindings.adoptionRequired as { sessionId?: string }).sessionId, priorId);
    assert.throws(
      () =>
        blocked.registry.bindWorker(blocked.session, {
          instanceId: 'blocked-worker',
          pid: 203,
          token: 'blocked-worker-birth',
        }),
      /SESSION_OWNER_LOST/,
    );
    const environment = blocked.workerEnvironment('blocked-worker');
    const secret = JSON.parse(readFileSync(environment.RN_DEV_AGENT_SESSION_SECRET_PATH, 'utf8'));
    blocked.registry.bindRecoveryWorker(
      blocked.session,
      {
        instanceId: 'blocked-worker',
        pid: 203,
        token: 'blocked-worker-birth',
      },
      secret.recoveryCapability,
    );
    assert.equal(
      blocked.registry.getSessionStatus(blocked.session.sessionId)?.worker.instanceId,
      'blocked-worker',
    );
    assert.throws(
      () => blocked.registry.getControllerBinding(blocked.session),
      /SESSION_OWNER_LOST/,
    );
  } finally {
    blocked.close();
    prior.close();
  }
});
