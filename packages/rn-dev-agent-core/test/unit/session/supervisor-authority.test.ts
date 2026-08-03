import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { createSupervisorAuthority } from '../../../dist/session/supervisor-authority.js';
import { openSessionRegistry } from '../../../dist/session/registry.js';
import { createAuthorityStateLayout } from '../../../dist/session/state-root.js';

const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

test('supervisor creates one source-and-port session inherited by worker respawns', async () => {
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
    await authority.close();
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

test('supervisor initialization releases claims when shared knowledge setup fails', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-supervisor-init-rollback-'));
  roots.push(root);
  const stateDir = join(root, 'state');
  const project = join(root, 'project');
  const corpus = join(root, 'corpus');
  mkdirSync(project);
  mkdirSync(corpus);
  mkdirSync(join(root, 'foreign'));
  symlinkSync(join(root, 'foreign'), join(corpus, 'nested-link'));
  symlinkSync(corpus, join(project, '.rn-agent'));

  assert.throws(
    () =>
      createSupervisorAuthority({
        stateDir,
        sessionId: 'failed-initialization',
        source: {
          kind: 'git',
          contentRoot: project,
          appRoot: project,
          sourceKey: 'source-key',
          worktreeKey: 'worktree-key',
          appRootKey: 'app-key',
          head: 'abc123',
        },
        supervisorBirth: { pid: 101, source: 'linux-proc', token: 'supervisor-birth' },
        uid: '501',
        startHeartbeat: false,
        ownerStatus: () => 'match',
      }),
    /SHARED_KNOWLEDGE_ROOT_UNSAFE/,
  );

  const registry = openSessionRegistry(createAuthorityStateLayout(stateDir).registry, {
    ownerStatus: () => 'match',
  });
  try {
    const status = registry.getSessionStatus('failed-initialization');
    assert.equal(status?.state, 'released');
    assert.deepEqual(status?.claims, []);
  } finally {
    registry.close();
  }
});

test('supervisor close is idempotent after the session was already released', async () => {
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
  await assert.doesNotReject(authority.close());
});

test('supervisor close cancels an interrupted operation before releasing claims', async () => {
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
  authority.registry.beginOperation(authority.session, {
    operationId: 'interrupted-operation',
    tool: 'device_snapshot',
    profile: 'CSIMDR',
  });

  await assert.doesNotReject(authority.close());

  const registry = openSessionRegistry(authority.layout.registry, {
    ownerStatus: () => 'match',
  });
  try {
    const status = registry.getSessionStatus(authority.session.sessionId);
    assert.equal(status?.state, 'released');
    assert.deepEqual(status?.claims, []);
  } finally {
    registry.close();
  }
});

test('supervisor close atomically blocks operation admission before Metro teardown', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'rn-supervisor-authority-'));
  roots.push(stateDir);
  let signalStopStarted: (() => void) | undefined;
  let finishStop: ((stopped: boolean) => void) | undefined;
  const stopStarted = new Promise<void>((resolve) => {
    signalStopStarted = resolve;
  });
  const stopResult = new Promise<boolean>((resolve) => {
    finishStop = resolve;
  });
  const authority = createSupervisorAuthority(
    {
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
    },
    {
      stopManagedMetro: async () => {
        signalStopStarted?.();
        return stopResult;
      },
    },
  );
  authority.registry.updateBindings(authority.session, {
    bindings: {
      metro: {
        mode: 'managed',
        port: authority.metroPort,
      },
    },
  });

  const close = authority.close();
  await stopStarted;

  assert.equal(authority.registry.getSessionStatus(authority.session.sessionId)?.state, 'closing');
  assert.throws(
    () =>
      authority.registry.beginOperation(authority.session, {
        operationId: 'late-operation',
        tool: 'rn-session ensure-metro',
        profile: 'transition:ensure-metro',
      }),
    /SESSION_OWNER_LOST/,
  );

  finishStop?.(true);
  await assert.doesNotReject(close);
});

test('supervisor close preserves session-owned Metro while package integration remains installed', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'rn-supervisor-authority-'));
  roots.push(stateDir);
  const stoppedBindings = [];
  const authority = createSupervisorAuthority(
    {
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
    },
    {
      stopManagedMetro: async (binding) => {
        stoppedBindings.push(binding);
        return true;
      },
    },
  );
  const metro = {
    mode: 'managed',
    port: authority.metroPort,
    instanceId: 'persistent-metro',
  };
  authority.registry.updateBindings(authority.session, {
    state: 'ready',
    bindings: {
      metro,
      packageIntegration: {
        version: 1,
        installedBySessionId: authority.session.sessionId,
        manifestSha256: 'a'.repeat(64),
      },
    },
  });

  await assert.doesNotReject(authority.close());
  assert.deepEqual(stoppedBindings, []);

  const registry = openSessionRegistry(authority.layout.registry, {
    ownerStatus: () => 'match',
  });
  try {
    const status = registry.getSessionStatus(authority.session.sessionId);
    assert.equal(status?.state, 'ready');
    assert.deepEqual(status?.bindings.metro, metro);
    assert.ok(status?.bindings.packageIntegration);
  } finally {
    registry.close();
  }
});

test('supervisor close proves runner and Observe cleanup before releasing claims', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'rn-supervisor-authority-'));
  roots.push(stateDir);
  const stoppedRunners = [];
  const stoppedObserveServers = [];
  const authority = createSupervisorAuthority(
    {
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
    },
    {
      stopBoundRunner: async (binding) => {
        stoppedRunners.push(binding);
      },
      stopBoundObserve: async (binding) => {
        stoppedObserveServers.push(binding);
      },
    },
  );
  const runner = {
    platform: 'ios',
    deviceId: 'device-a',
    port: 8100,
    pid: 201,
    processBirth: 'runner-birth',
    instanceId: 'runner-a',
    capability: 'runner-capability',
  };
  const observe = {
    port: authority.observePort,
    pid: 202,
    processBirth: 'observe-birth',
    instanceId: 'observe-a',
    cleanupCapability: 'observe-capability',
  };
  authority.registry.claimResources(authority.session, [
    { type: 'runner', key: 'ios:device-a:8100' },
  ]);
  authority.registry.updateBindings(authority.session, {
    bindings: { runner, observe },
  });

  await assert.doesNotReject(authority.close());
  assert.deepEqual(stoppedRunners, [runner]);
  assert.deepEqual(stoppedObserveServers, [observe]);

  const registry = openSessionRegistry(authority.layout.registry, {
    ownerStatus: () => 'match',
  });
  try {
    const status = registry.getSessionStatus(authority.session.sessionId);
    assert.equal(status?.state, 'released');
    assert.deepEqual(status?.claims, []);
  } finally {
    registry.close();
  }
});

test('supervisor close retains claims when runner or Observe cleanup is unproven', async (t) => {
  for (const failedResource of ['runner', 'observe']) {
    await t.test(failedResource, async () => {
      const stateDir = mkdtempSync(join(tmpdir(), 'rn-supervisor-authority-'));
      roots.push(stateDir);
      const authority = createSupervisorAuthority(
        {
          stateDir,
          source: {
            kind: 'git',
            contentRoot: '/repo',
            appRoot: '/repo',
            sourceKey: `source-key-${failedResource}`,
            worktreeKey: `worktree-key-${failedResource}`,
            appRootKey: `app-key-${failedResource}`,
            head: 'abc123',
          },
          supervisorBirth: { pid: 101, source: 'linux-proc', token: 'supervisor-birth' },
          uid: '501',
          startHeartbeat: false,
          ownerStatus: () => 'match',
        },
        {
          stopBoundRunner: async () => {
            if (failedResource === 'runner') throw new Error('RUNNER_ADOPTION_REQUIRED');
          },
          stopBoundObserve: async () => {
            if (failedResource === 'observe') throw new Error('OBSERVE_AUTHORITY_MISMATCH');
          },
        },
      );
      authority.registry.claimResources(authority.session, [
        { type: 'runner', key: 'ios:device-a:8100' },
      ]);
      authority.registry.updateBindings(authority.session, {
        bindings: {
          runner: {
            platform: 'ios',
            deviceId: 'device-a',
            port: 8100,
            pid: 201,
            processBirth: 'runner-birth',
            instanceId: 'runner-a',
            capability: 'runner-capability',
          },
          observe: {
            port: authority.observePort,
            pid: 202,
            processBirth: 'observe-birth',
            instanceId: 'observe-a',
            cleanupCapability: 'observe-capability',
          },
        },
      });

      await assert.rejects(authority.close(), new RegExp(failedResource.toUpperCase()));

      const registry = openSessionRegistry(authority.layout.registry, {
        ownerStatus: () => 'match',
      });
      try {
        const status = registry.getSessionStatus(authority.session.sessionId);
        assert.equal(status?.state, 'closing');
        assert.deepEqual(
          status?.claims.map((claim) => claim.type),
          ['metro-port', 'observe-port', 'runner', 'source'],
        );
      } finally {
        registry.close();
      }
    });
  }
});

test('supervisor close retains an unpublished managed Metro transition', async () => {
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
  authority.registry.beginOperation(authority.session, {
    operationId: 'starting-metro',
    tool: 'rn-session ensure-metro',
    profile: 'transition:ensure-metro',
  });

  await assert.rejects(authority.close(), /SESSION_OPERATION_ACTIVE/);

  const registry = openSessionRegistry(authority.layout.registry, {
    ownerStatus: () => 'match',
  });
  try {
    assert.equal(registry.getSessionStatus(authority.session.sessionId)?.state, 'source_bound');
    assert.throws(
      () =>
        registry.beginOperation(authority.session, {
          operationId: 'replacement-operation',
          tool: 'device_snapshot',
          profile: 'CSIMDR',
        }),
      /OPERATION_ALREADY_IN_PROGRESS/,
    );
  } finally {
    registry.close();
  }
});

test('supervisor close retains authority when durable Metro cleanup is unproven', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'rn-supervisor-authority-'));
  roots.push(stateDir);
  const stoppedBindings = [];
  const authority = createSupervisorAuthority(
    {
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
    },
    {
      stopManagedMetro: async (binding) => {
        stoppedBindings.push(binding);
        return false;
      },
    },
  );
  let operation = authority.registry.beginOperation(authority.session, {
    operationId: 'interrupted-metro-start',
    tool: 'rn-session ensure-metro',
    profile: 'transition:ensure-metro',
  });
  const metroCleanup = {
    mode: 'managed',
    port: authority.metroPort,
    pid: 301,
    birth: 'listener-birth',
    launcherPid: 302,
    launcherBirth: 'launcher-birth',
    instanceId: 'metro-a',
    managementProof: 'proof',
  };
  await authority.registry.runWithOperation(operation, async () => {
    operation = authority.registry.replaceBindingsDuringOperation(operation, {
      bindings: { metroCleanup },
    });
  });

  await assert.rejects(authority.close(), /METRO_AUTHORITY_MISMATCH/);
  assert.deepEqual(stoppedBindings, [metroCleanup]);

  const registry = openSessionRegistry(authority.layout.registry, {
    ownerStatus: () => 'match',
  });
  try {
    const status = registry.getSessionStatus(authority.session.sessionId);
    assert.equal(status?.state, 'closing');
    assert.deepEqual(status?.bindings.metroCleanup, metroCleanup);
    assert.throws(
      () =>
        registry.beginOperation(authority.session, {
          operationId: 'replacement-operation',
          tool: 'device_snapshot',
          profile: 'CSIMDR',
        }),
      /SESSION_OWNER_LOST/,
    );
  } finally {
    registry.close();
  }
});

test('a supervisor without the source claim stays blocked and exposes the full adoption ID', async () => {
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
    await blocked.close();
    await prior.close();
  }
});

test('supervisor close recovers authenticated automation before releasing the session', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'rn-supervisor-automation-'));
  roots.push(stateDir);
  const calls: unknown[] = [];
  const authority = createSupervisorAuthority(
    {
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
    },
    {
      inspectAutomation: () => ({ invocationId: 'owned' }) as never,
      recoverAutomation: async (input) => {
        calls.push(input);
        return { recovered: true };
      },
    },
  );
  authority.registry.updateBindings(authority.session, {
    state: 'device_bound',
    bindings: { device: { platform: 'ios', deviceId: 'UDID-A', appId: 'com.example' } },
  });

  await authority.close();
  assert.deepEqual(calls, [
    {
      sessionId: authority.session.sessionId,
      claimEpoch: authority.session.claimEpoch,
      platform: 'ios',
      deviceId: 'UDID-A',
    },
  ]);
});
