import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { openSessionRegistry } from '../../../dist/session/registry.js';

const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-registry-'));
  roots.push(root);
  const path = join(root, 'registry.sqlite3');
  let now = 1_000_000;
  const ownerStates = new Map();
  const registry = openSessionRegistry(path, {
    now: () => now,
    ownerStatus: (owner) => ownerStates.get(owner.sessionId) ?? 'unknown',
    leaseMs: 30_000,
  });
  const create = (sessionId, worktreeKey = sessionId) => {
    ownerStates.set(sessionId, 'match');
    return registry.createSession({
      sessionId,
      sourceKey: 'repo',
      worktreeKey,
      appRootKey: '.',
      supervisor: { pid: sessionId === 'a' ? 101 : 202, token: `birth-${sessionId}` },
    });
  };
  return {
    registry,
    path,
    create,
    ownerStates,
    advance: (ms) => {
      now += ms;
    },
  };
}

async function recordPlatformReceipt(registry, session, platform, receipt) {
  const operation = registry.beginOperation(session, {
    operationId: `snapshot-${platform}`,
    tool: 'device_snapshot',
    profile: 'CSIMDR',
  });
  await registry.runWithOperation(operation, async () => {
    registry.recordPlatformAuthorityReceipt(session, platform, receipt);
  });
  registry.commitPlatformAuthorityReceipts(operation);
  registry.endOperation(operation);
}

test('multi-resource claims are atomic and identify the conflicting axis', () => {
  const { registry, create } = fixture();
  const a = create('a');
  const b = create('b');
  registry.claimResources(a, [
    { type: 'device', key: 'ios:device-1' },
    { type: 'metro-port', key: '8341' },
  ]);

  assert.throws(
    () =>
      registry.claimResources(b, [
        { type: 'observe-port', key: '9341' },
        { type: 'device', key: 'ios:device-1' },
      ]),
    (error) => error.code === 'DEVICE_CLAIM_CONFLICT' && error.holder.sessionId === 'a',
  );
  assert.equal(registry.getClaim('observe-port', '9341'), null);
});

test('a live owner cannot be force-stolen even after its wall-clock lease expires', () => {
  const { registry, create, advance } = fixture();
  const a = create('a');
  const b = create('b');
  registry.claimResources(a, [{ type: 'device', key: 'ios:device-1' }]);
  advance(60_000);

  assert.throws(
    () => registry.claimResources(b, [{ type: 'device', key: 'ios:device-1' }]),
    (error) => error.code === 'DEVICE_CLAIM_CONFLICT',
  );
  assert.doesNotThrow(() => registry.renewSession(a));
});

test('a sole owner wakes after lease expiry and reasserts without silent eviction', () => {
  const { registry, create, advance } = fixture();
  const owner = create('a');
  registry.claimResources(owner, [{ type: 'device', key: 'ios:device-1' }]);
  advance(5 * 60_000);

  assert.doesNotThrow(() => registry.renewSession(owner));
  assert.equal(registry.getClaim('device', 'ios:device-1').sessionId, owner.sessionId);
  assert.equal(registry.getSessionStatus(owner.sessionId).claimEpoch, owner.claimEpoch);
});

test('a contender reclaims only a proven-dead owner and fences its old epoch', () => {
  const { registry, create, ownerStates } = fixture();
  const a = create('a');
  const b = create('b');
  registry.claimResources(a, [{ type: 'device', key: 'ios:device-1' }]);
  ownerStates.set('a', 'mismatch');

  registry.claimResources(b, [{ type: 'device', key: 'ios:device-1' }]);

  assert.equal(registry.getClaim('device', 'ios:device-1').sessionId, 'b');
  assert.throws(
    () => registry.renewSession(a),
    (error) => error.code === 'SESSION_OWNER_LOST',
  );
});

test('startup discovery cannot auto-adopt a dead owner without the explicit transition', () => {
  const { registry, create, ownerStates } = fixture();
  const prior = create('a');
  const next = create('b');
  registry.claimResources(prior, [{ type: 'device', key: 'ios:device-1' }]);
  ownerStates.set('a', 'mismatch');

  assert.throws(
    () =>
      registry.claimResources(next, [{ type: 'device', key: 'ios:device-1' }], {
        allowReclaim: false,
      }),
    (error) =>
      error.code === 'SESSION_AUTHORITY_REQUIRED' && error.holder.sessionId === prior.sessionId,
  );
  assert.equal(registry.getClaim('device', 'ios:device-1').sessionId, prior.sessionId);

  registry.claimResources(next, [{ type: 'device', key: 'ios:device-1' }]);
  assert.equal(registry.getClaim('device', 'ios:device-1').sessionId, next.sessionId);
});

test('unknown process identity refuses stale reclaim', () => {
  const { registry, create, ownerStates, advance } = fixture();
  const a = create('a');
  const b = create('b');
  registry.claimResources(a, [{ type: 'device', key: 'ios:device-1' }]);
  ownerStates.set('a', 'unknown');
  advance(60_000);

  assert.throws(
    () => registry.claimResources(b, [{ type: 'device', key: 'ios:device-1' }]),
    (error) => error.code === 'STALE_LEASE_NOT_RECLAIMABLE',
  );
});

test('active operations prevent release and stale operation epochs cannot complete', () => {
  const { registry, create } = fixture();
  const a = create('a');
  registry.claimResources(a, [{ type: 'device', key: 'ios:device-1' }]);
  const operation = registry.beginOperation(a, {
    operationId: 'operation-a',
    tool: 'device_interact',
    profile: 'native',
  });

  assert.throws(() => registry.releaseSession(a), /SESSION_OPERATION_ACTIVE/);
  registry.endOperation(operation);
  assert.doesNotThrow(() => registry.releaseSession(a));
  assert.throws(() => registry.endOperation(operation), /AUTHORITY_LOST_DURING_OPERATION/);
});

test('deterministic port allocation persists collision resolution per worktree', () => {
  const { registry } = fixture();
  const first = registry.allocatePort({
    service: 'metro',
    worktreeKey: 'worktree-a',
    uid: '501',
    base: 8300,
    span: 1,
  });
  const second = registry.allocatePort({
    service: 'metro',
    worktreeKey: 'worktree-b',
    uid: '501',
    base: 8300,
    span: 4,
  });

  assert.equal(first, 8300);
  assert.notEqual(second, first);
  assert.equal(
    registry.allocatePort({
      service: 'metro',
      worktreeKey: 'worktree-b',
      uid: '501',
      base: 8300,
      span: 4,
    }),
    second,
  );
});

test('graceful handoff is one-time, transfers every claim epoch, and fences the old owner', () => {
  const { registry, create } = fixture();
  const owner = create('a');
  registry.claimResources(owner, [
    { type: 'device', key: 'ios:device-1' },
    { type: 'metro-port', key: '8341' },
    { type: 'runner', key: 'ios:device-1:9100' },
  ]);

  const handoff = registry.prepareHandoff(owner, { targetInstance: 'worker-next' });
  const next = registry.acceptHandoff({
    ...handoff,
    targetInstance: 'worker-next',
    supervisor: { pid: 303, token: 'birth-next' },
  });

  assert.equal(next.claimEpoch, owner.claimEpoch + 1);
  assert.equal(registry.getClaim('device', 'ios:device-1').claimEpoch, next.claimEpoch);
  assert.equal(registry.getClaim('metro-port', '8341').claimEpoch, next.claimEpoch);
  assert.throws(() => registry.renewSession(owner), /SESSION_OWNER_LOST/);
  assert.throws(
    () =>
      registry.acceptHandoff({
        ...handoff,
        targetInstance: 'worker-next',
        supervisor: { pid: 303, token: 'birth-next' },
      }),
    /HANDOFF_ALREADY_CONSUMED/,
  );
});

test('handoff refuses active operations and an invalid capability', () => {
  const { registry, create } = fixture();
  const owner = create('a');
  const operation = registry.beginOperation(owner, {
    operationId: 'operation-a',
    tool: 'device_interact',
    profile: 'native',
  });

  assert.throws(
    () => registry.prepareHandoff(owner, { targetInstance: 'worker-next' }),
    /SESSION_OPERATION_ACTIVE/,
  );
  registry.endOperation(operation);
  const handoff = registry.prepareHandoff(owner, { targetInstance: 'worker-next' });
  assert.throws(
    () =>
      registry.acceptHandoff({
        ...handoff,
        token: 'wrong-token',
        targetInstance: 'worker-next',
        supervisor: { pid: 303, token: 'birth-next' },
      }),
    /HANDOFF_TOKEN_INVALID/,
  );
});

test('handoff into a live target transfers claims once and drops bundle and runner authority', () => {
  const { registry, create } = fixture();
  const owner = create('a', 'shared-worktree');
  const target = create('b', 'shared-worktree');
  registry.bindWorker(target, {
    instanceId: 'worker-next',
    pid: 202,
    token: 'birth-worker-next',
  });
  registry.updateBindings(target, {
    state: 'blocked',
    bindings: { recoveryCapabilityHash: 'recovery-target' },
  });
  registry.claimResources(owner, [
    { type: 'device', key: 'ios:device-1' },
    { type: 'metro-port', key: '8341' },
    { type: 'runner', key: 'ios:device-1:9100' },
  ]);
  registry.updateBindings(owner, {
    state: 'ready',
    bindings: {
      device: { platform: 'ios', deviceId: 'device-1' },
      bundle: { targetId: 'old-target' },
      runner: {
        platform: 'ios',
        deviceId: 'device-1',
        port: 9100,
        instanceId: 'old-runner',
        capability: 'runner-capability',
      },
    },
  });
  const handoff = registry.prepareHandoff(owner, { targetInstance: 'worker-next' });

  const cleanup = registry.acceptHandoffInto(target, {
    ...handoff,
    targetInstance: 'worker-next',
  });
  assert.equal(cleanup.runner?.instanceId, 'old-runner');
  registry.beginHandoffCleanupResource(target, 'worker-next', 'runner');
  registry.completeHandoffCleanupResource(target, 'worker-next', 'runner');
  registry.finishHandoffCleanup(target, 'worker-next');

  assert.equal(registry.getClaim('device', 'ios:device-1').sessionId, target.sessionId);
  assert.equal(registry.getClaim('metro-port', '8341').sessionId, target.sessionId);
  assert.equal(registry.getSessionStatus(owner.sessionId).state, 'released');
  assert.equal(registry.getSessionStatus(target.sessionId).bindings.bundle, null);
  assert.equal(registry.getSessionStatus(target.sessionId).bindings.runner, null);
  assert.throws(
    () =>
      registry.acceptHandoffInto(target, {
        ...handoff,
        targetInstance: 'worker-next',
      }),
    /SESSION_OWNER_LOST/,
  );
});

test('only the active operation context may advance transition authority', async () => {
  const { registry, create } = fixture();
  const owner = create('a');
  const operation = registry.beginOperation(owner, {
    operationId: 'operation-a',
    tool: 'rn_session',
    profile: 'transition:CS>CS',
  });

  assert.throws(
    () => registry.updateBindings(owner, { bindings: { metro: { port: 8341 } } }),
    /not owned by the active operation fence/,
  );
  await registry.runWithOperation(operation, async () => {
    registry.updateBindings(owner, { bindings: { metro: { port: 8341 } } });
  });

  assert.doesNotThrow(() => registry.verifyOperation(operation));
  registry.endOperation(operation);
});

test('blocked recovery atomically adopts only a proven-stale exact source owner', () => {
  const { registry, create, ownerStates } = fixture();
  const prior = create('a', 'shared-worktree');
  const target = create('b', 'shared-worktree');
  registry.claimResources(prior, [
    { type: 'source', key: 'shared-worktree' },
    { type: 'device', key: 'ios:device-a' },
  ]);
  registry.updateBindings(prior, {
    state: 'device_bound',
    bindings: {
      metroPort: 8341,
      device: { platform: 'ios', deviceId: 'device-a' },
      install: { installGeneration: 'install-a' },
    },
  });
  registry.bindWorker(target, {
    instanceId: 'recovery-worker',
    pid: 202,
    token: 'recovery-birth',
  });
  registry.updateBindings(target, {
    state: 'blocked',
    bindings: { metroPort: 8341, recoveryCapabilityHash: 'recovery-target' },
  });
  ownerStates.set(prior.sessionId, 'mismatch');

  registry.adoptStaleIntoBlocked(target, prior.sessionId, 'recovery-worker');

  assert.equal(registry.getSessionStatus(target.sessionId)?.state, 'source_bound');
  assert.equal(registry.getClaim('source', 'shared-worktree')?.sessionId, target.sessionId);
  assert.equal(registry.getSessionStatus(prior.sessionId)?.state, 'stale');
});

test('busy retries yield to heartbeats instead of blocking the worker event loop', async () => {
  const { registry, path, create } = fixture();
  const owner = create('a');
  const blocker = new DatabaseSync(path);
  blocker.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE');
  let ticks = 0;
  const heartbeat = setInterval(() => {
    ticks += 1;
  }, 2);
  setTimeout(() => blocker.exec('COMMIT'), 25);

  try {
    await registry.claimResourcesWithRetry(owner, [{ type: 'device', key: 'ios:device-1' }], {
      timeoutMs: 250,
      retryDelayMs: 4,
    });
    assert.ok(ticks >= 1);
  } finally {
    clearInterval(heartbeat);
    blocker.close();
  }
});

test('runtime target replacement advances the binding and operation fence atomically', () => {
  const { registry, create } = fixture();
  const owner = create('a');
  registry.claimResources(owner, [{ type: 'target', key: '8193:old-target' }]);
  registry.updateBindings(owner, {
    state: 'ready',
    bindings: { bundle: { targetId: 'old-target' } },
  });
  const operation = registry.beginOperation(owner, {
    operationId: 'reload-1',
    tool: 'cdp_reload',
    profile: 'CSIMBD',
  });

  const advanced = registry.replaceBindingsDuringOperation(operation, {
    bindings: { bundle: { targetId: 'new-target' } },
    releaseResources: [{ type: 'target', key: '8193:old-target' }],
    claimResources: [{ type: 'target', key: '8193:new-target' }],
  });

  assert.equal(advanced.authorityVersion, operation.authorityVersion + 1);
  assert.equal(registry.getClaim('target', '8193:old-target'), null);
  assert.equal(registry.getClaim('target', '8193:new-target').sessionId, 'a');
  assert.equal(registry.getSessionStatus('a').bindings.bundle.targetId, 'new-target');
  assert.doesNotThrow(() => registry.verifyOperation(advanced));
  assert.throws(
    () => registry.verifyOperation(operation),
    (error) => error.code === 'AUTHORITY_LOST_DURING_OPERATION',
  );
});

test('runtime target replacement refuses a target claimed by another live session', () => {
  const { registry, create } = fixture();
  const owner = create('a');
  const other = create('b');
  registry.claimResources(other, [{ type: 'target', key: '8193:foreign-target' }]);
  const operation = registry.beginOperation(owner, {
    operationId: 'reload-2',
    tool: 'cdp_reload',
    profile: 'CSIMBD',
  });

  assert.throws(
    () =>
      registry.replaceBindingsDuringOperation(operation, {
        bindings: { bundle: { targetId: 'foreign-target' } },
        claimResources: [{ type: 'target', key: '8193:foreign-target' }],
      }),
    (error) => error.code === 'TARGET_CLAIM_CONFLICT',
  );
  assert.doesNotThrow(() => registry.verifyOperation(operation));
});

test('registry refuses a schema newer than version 4 without downgrading it', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-schema-'));
  roots.push(root);
  const path = join(root, 'registry.sqlite3');
  const future = new DatabaseSync(path);
  future.exec(`
    CREATE TABLE authority_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO authority_meta(key, value) VALUES ('schema_version', '5');
  `);
  future.close();

  assert.throws(
    () => openSessionRegistry(path, { ownerStatus: () => 'unknown' }),
    /AUTHORITY_STORE_UNAVAILABLE.*schema 5 is newer than supported schema 4/,
  );

  const unchanged = new DatabaseSync(path);
  assert.equal(
    unchanged.prepare('SELECT value FROM authority_meta WHERE key = ?').get('schema_version').value,
    '5',
  );
  unchanged.close();
});

test('worker replacement removes obsolete operation rows before advancing authority', () => {
  const { registry, create } = fixture();
  const owner = create('a');
  registry.beginOperation(owner, {
    operationId: 'stale-worker-operation',
    tool: 'device_press',
    profile: 'CSIMDR',
  });

  registry.bindWorker(owner, {
    instanceId: 'replacement-worker',
    pid: 303,
    token: 'replacement-birth',
  });

  assert.doesNotThrow(() => registry.releaseSession(owner));
});

test('device rebinding atomically invalidates every prior device-derived authority', () => {
  const { registry, create } = fixture();
  const owner = create('a');
  registry.claimResources(owner, [
    { type: 'source', key: 'worktree' },
    { type: 'device', key: 'ios:device-a' },
    { type: 'target', key: '8193:target-a' },
    { type: 'runner', key: 'ios:device-a:9100' },
  ]);
  registry.updateBindings(owner, {
    state: 'ready',
    bindings: {
      device: { platform: 'ios', deviceId: 'device-a', appId: 'dev.example' },
      install: { artifactDigest: 'artifact-a', installGeneration: 'generation-a' },
      bundle: { targetId: 'target-a' },
      runner: { instanceId: 'runner-a' },
      observe: { instanceId: 'observe-a' },
      proof: { runId: 'proof-a' },
    },
  });

  registry.replaceDeviceAuthority(owner, {
    device: { platform: 'android', deviceId: 'device-b', appId: 'dev.example' },
    install: {
      platform: 'android',
      deviceId: 'device-b',
      appId: 'dev.example',
      artifactDigest: 'artifact-b',
      installGeneration: 'generation-b',
      buildGeneration: 2,
    },
  });

  const status = registry.getSessionStatus(owner.sessionId);
  assert.equal(registry.getClaim('device', 'ios:device-a'), null);
  assert.equal(registry.getClaim('target', '8193:target-a'), null);
  assert.equal(registry.getClaim('runner', 'ios:device-a:9100'), null);
  assert.equal(registry.getClaim('device', 'android:device-b')?.sessionId, owner.sessionId);
  assert.equal(status?.bindings.bundle, null);
  assert.equal(status?.bindings.runner, null);
  assert.equal(status?.bindings.observe, null);
  assert.equal(status?.bindings.proof, null);
});

test('handoff transfers only safe claims and requires fresh live-resource bindings', () => {
  const { registry, create } = fixture();
  const owner = create('a', 'shared-worktree');
  const target = create('b', 'shared-worktree');
  registry.bindWorker(target, {
    instanceId: 'worker-next',
    pid: 202,
    token: 'birth-worker-next',
  });
  registry.updateBindings(target, {
    state: 'blocked',
    bindings: { recoveryCapabilityHash: 'recovery-target' },
  });
  registry.claimResources(owner, [
    { type: 'source', key: 'shared-worktree' },
    { type: 'metro-port', key: '8341' },
    { type: 'device', key: 'ios:device-1' },
    { type: 'target', key: '8341:target-1' },
    { type: 'runner', key: 'ios:device-1:9100' },
  ]);
  registry.updateBindings(owner, {
    state: 'ready',
    bindings: {
      metro: { port: 8341 },
      device: { platform: 'ios', deviceId: 'device-1' },
      install: { artifactDigest: 'artifact-1' },
      bundle: { targetId: 'target-1' },
      runner: {
        platform: 'ios',
        deviceId: 'device-1',
        port: 9100,
        instanceId: 'runner-1',
        capability: 'runner-capability',
      },
      observe: { instanceId: 'observe-1' },
      proof: { runId: 'proof-1' },
    },
  });
  const handoff = registry.prepareHandoff(owner, { targetInstance: 'worker-next' });

  const cleanup = registry.acceptHandoffInto(target, {
    ...handoff,
    targetInstance: 'worker-next',
  });
  assert.equal(cleanup.observe?.instanceId, 'observe-1');
  assert.equal(cleanup.runner?.instanceId, 'runner-1');
  registry.beginHandoffCleanupResource(target, 'worker-next', 'runner');
  registry.completeHandoffCleanupResource(target, 'worker-next', 'runner');
  registry.beginHandoffCleanupResource(target, 'worker-next', 'observe');
  registry.completeHandoffCleanupResource(target, 'worker-next', 'observe');
  registry.finishHandoffCleanup(target, 'worker-next');

  const status = registry.getSessionStatus(target.sessionId);
  assert.equal(registry.getClaim('source', 'shared-worktree')?.sessionId, target.sessionId);
  assert.equal(registry.getClaim('target', '8341:target-1'), null);
  assert.equal(registry.getClaim('runner', 'ios:device-1:9100'), null);
  assert.equal(status?.bindings.bundle, null);
  assert.equal(status?.bindings.runner, null);
  assert.equal(status?.bindings.observe, null);
  assert.equal(status?.bindings.proof, null);
});

test('handoff cancellation and explicit expiry recovery restore the unchanged owner', () => {
  const { registry, create, advance } = fixture();
  const owner = create('a');
  registry.claimResources(owner, [{ type: 'device', key: 'ios:device-1' }]);
  const cancelled = registry.prepareHandoff(owner, {
    targetInstance: 'worker-next',
    ttlMs: 15_000,
  });
  registry.cancelHandoff(owner, cancelled.handoffId);
  assert.equal(registry.getSessionStatus(owner.sessionId)?.state, 'active');
  assert.throws(
    () =>
      registry.acceptHandoff({
        ...cancelled,
        targetInstance: 'worker-next',
        supervisor: { pid: 303, token: 'birth-next' },
      }),
    /HANDOFF_ALREADY_CONSUMED/,
  );

  const expired = registry.prepareHandoff(owner, {
    targetInstance: 'worker-next',
    ttlMs: 15_000,
  });
  advance(15_001);
  assert.equal(registry.getSessionStatus(owner.sessionId)?.state, 'handoff');
  registry.cancelHandoff(owner, expired.handoffId);
  assert.equal(registry.getSessionStatus(owner.sessionId)?.state, 'active');
});

test('opaque recovery handles authorize only their bounded transition', () => {
  const { registry, create } = fixture();
  const owner = create('a', 'shared-worktree');
  const target = create('b', 'shared-worktree');
  const capability = 'recovery-capability';
  registry.updateBindings(target, {
    state: 'blocked',
    bindings: {
      recoveryCapabilityHash: createHash('sha256').update(capability).digest('hex'),
    },
  });
  registry.bindRecoveryWorker(
    target,
    { instanceId: 'recovery-worker', pid: 202, token: 'recovery-birth' },
    capability,
  );
  const status = registry.getSessionStatus(target.sessionId);
  const handle = status?.bindings.recoveryHandles?.handoffRecipient?.token;

  assert.equal(typeof handle, 'string');
  assert.throws(
    () => registry.prepareHandoffForHandle(owner, { targetHandle: 'forged' }),
    /HANDOFF_TARGET_MISMATCH/,
  );
  assert.doesNotThrow(() =>
    registry.prepareHandoffForHandle(owner, { targetHandle: String(handle) }),
  );
  assert.equal(
    registry.getSessionStatus(target.sessionId)?.bindings.recoveryHandles.handoffRecipient,
    null,
  );
});

test('persistent platform receipts reject exact authority replacement', async () => {
  const { registry, create } = fixture();
  const owner = create('a');
  registry.claimResources(owner, [
    { type: 'device', key: 'ios:device-a' },
    { type: 'runner', key: 'ios:device-a:runner-a' },
  ]);
  registry.updateBindings(owner, {
    state: 'ready',
    bindings: {
      device: { platform: 'ios', deviceId: 'device-a', appId: 'dev.example' },
      install: {
        buildGeneration: 1,
        installGeneration: 'install-a',
        artifactDigest: 'artifact-a',
      },
      runner: {
        port: 9100,
        instanceId: 'runner-a',
        pid: 303,
        processBirth: 'runner-birth-a',
        capability: 'runner-capability-a',
      },
    },
  });
  const receipt = {
    sessionId: owner.sessionId,
    claimEpoch: owner.claimEpoch,
    sourceKey: 'repo',
    worktreeKey: 'a',
    appRootKey: '.',
    platform: 'ios',
    deviceId: 'device-a',
    appId: 'dev.example',
    buildGeneration: 1,
    installGeneration: 'install-a',
    artifactDigest: 'artifact-a',
    runnerInstanceId: 'runner-a',
    runnerPid: 303,
    runnerProcessBirth: 'runner-birth-a',
    runnerCapabilityHash: createHash('sha256').update('runner-capability-a').digest('hex'),
    runnerPort: 9100,
    runnerClaim: 'ios:device-a:runner-a',
    deviceClaim: 'ios:device-a',
  };
  const provisional = registry.beginOperation(owner, {
    operationId: 'snapshot-provisional',
    tool: 'device_snapshot',
    profile: 'CSIMDR',
  });
  await registry.runWithOperation(provisional, async () => {
    registry.recordPlatformAuthorityReceipt(owner, 'ios', receipt);
  });
  registry.cancelOperation(provisional);
  registry.commitPlatformAuthorityReceipts(provisional);
  assert.equal(registry.validatePlatformAuthorityReceipt(owner, 'ios', receipt), false);
  assert.equal(registry.getClaim('runner-receipt', receipt.runnerClaim), null);
  assert.equal(registry.getClaim('device-receipt', receipt.deviceClaim), null);

  await recordPlatformReceipt(registry, owner, 'ios', receipt);
  assert.equal(registry.validatePlatformAuthorityReceipt(owner, 'ios', receipt), true);
  assert.equal(
    registry.getPlatformAuthorityProbe(owner, 'ios', receipt)?.capability,
    'runner-capability-a',
  );

  registry.replaceDeviceAuthority(owner, {
    device: { platform: 'ios', deviceId: 'device-b', appId: 'dev.example' },
  });
  assert.equal(registry.validatePlatformAuthorityReceipt(owner, 'ios', receipt), false);
});

test('retained platform receipt claims block runner and device authority reuse', async () => {
  const { registry, create } = fixture();
  const owner = create('a');
  const contender = create('b');
  registry.claimResources(owner, [
    { type: 'device', key: 'ios:device-a' },
    { type: 'runner', key: 'ios:device-a:9100' },
  ]);
  registry.updateBindings(owner, {
    state: 'ready',
    bindings: {
      device: { platform: 'ios', deviceId: 'device-a', appId: 'dev.example' },
      install: {
        buildGeneration: 1,
        installGeneration: 'install-a',
        artifactDigest: 'artifact-a',
      },
      runner: {
        port: 9100,
        instanceId: 'runner-a',
        pid: 303,
        processBirth: 'runner-birth-a',
        capability: 'runner-capability-a',
      },
    },
  });
  const receipt = {
    sessionId: owner.sessionId,
    claimEpoch: owner.claimEpoch,
    sourceKey: 'repo',
    worktreeKey: 'a',
    appRootKey: '.',
    platform: 'ios',
    deviceId: 'device-a',
    appId: 'dev.example',
    buildGeneration: 1,
    installGeneration: 'install-a',
    artifactDigest: 'artifact-a',
    runnerInstanceId: 'runner-a',
    runnerPid: 303,
    runnerProcessBirth: 'runner-birth-a',
    runnerCapabilityHash: createHash('sha256').update('runner-capability-a').digest('hex'),
    runnerPort: 9100,
    runnerClaim: 'ios:device-a:9100',
    deviceClaim: 'ios:device-a',
  };
  await recordPlatformReceipt(registry, owner, 'ios', receipt);
  registry.replaceDeviceAuthority(owner, {
    device: { platform: 'android', deviceId: 'device-b', appId: 'dev.example' },
  });

  assert.equal(registry.validatePlatformAuthorityReceipt(owner, 'ios', receipt), true);
  assert.throws(
    () =>
      registry.claimResources(contender, [
        { type: 'runner', key: 'ios:device-a:9100' },
      ]),
    /RUNNER_CLAIM_CONFLICT/,
  );
  assert.throws(
    () => registry.claimResources(contender, [{ type: 'device', key: 'ios:device-a' }]),
    /DEVICE_CLAIM_CONFLICT/,
  );
});

test('handoff cleanup retains runner claim until its durable checkpoint', () => {
  const { registry, create } = fixture();
  const owner = create('a', 'shared-worktree');
  const target = create('b', 'shared-worktree');
  registry.bindWorker(target, {
    instanceId: 'worker-next',
    pid: 202,
    token: 'birth-worker-next',
  });
  registry.updateBindings(target, {
    state: 'blocked',
    bindings: { recoveryCapabilityHash: 'recovery-target' },
  });
  registry.claimResources(owner, [{ type: 'runner', key: 'ios:device-a:9100' }]);
  registry.updateBindings(owner, {
    state: 'ready',
    bindings: {
      runner: {
        platform: 'ios',
        deviceId: 'device-a',
        port: 9100,
        instanceId: 'runner-a',
        capability: 'runner-capability-a',
      },
    },
  });
  const handoff = registry.prepareHandoff(owner, { targetInstance: 'worker-next' });
  registry.acceptHandoffInto(target, { ...handoff, targetInstance: 'worker-next' });

  assert.equal(registry.getClaim('runner', 'ios:device-a:9100')?.sessionId, target.sessionId);
  assert.throws(
    () => registry.finishHandoffCleanup(target, 'worker-next'),
    /runner cleanup has not been durably completed/,
  );
  registry.beginHandoffCleanupResource(target, 'worker-next', 'runner');
  registry.completeHandoffCleanupResource(target, 'worker-next', 'runner');
  assert.equal(registry.getClaim('runner', 'ios:device-a:9100'), null);
  assert.doesNotThrow(() => registry.finishHandoffCleanup(target, 'worker-next'));
});
