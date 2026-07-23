import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
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
  registry.claimResources(owner, [
    { type: 'device', key: 'ios:device-1' },
    { type: 'metro-port', key: '8341' },
  ]);
  registry.updateBindings(owner, {
    state: 'ready',
    bindings: {
      device: { platform: 'ios', deviceId: 'device-1' },
      bundle: { targetId: 'old-target' },
      runner: { instanceId: 'old-runner' },
    },
  });
  const handoff = registry.prepareHandoff(owner, { targetInstance: 'worker-next' });

  registry.acceptHandoffInto(target, {
    ...handoff,
    targetInstance: 'worker-next',
  });

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
    /HANDOFF_ALREADY_CONSUMED/,
  );
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
    assert.ok(ticks >= 2);
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

test('registry migrates schema 1 to 2 but refuses a newer schema without downgrading it', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-schema-'));
  roots.push(root);
  const path = join(root, 'registry.sqlite3');
  const future = new DatabaseSync(path);
  future.exec(`
    CREATE TABLE authority_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO authority_meta(key, value) VALUES ('schema_version', '3');
  `);
  future.close();

  assert.throws(
    () => openSessionRegistry(path, { ownerStatus: () => 'unknown' }),
    /AUTHORITY_STORE_UNAVAILABLE.*schema 3 is newer than supported schema 2/,
  );

  const unchanged = new DatabaseSync(path);
  assert.equal(
    unchanged.prepare('SELECT value FROM authority_meta WHERE key = ?').get('schema_version').value,
    '3',
  );
  unchanged.close();
});
