// GH #672: the stale-authority adoption deadlock and its two reachable exits.
//
// 1. A blocked contender's adoption handle lives five minutes, but `status` kept
//    advertising it forever. A freshly fetched status therefore handed out a token
//    `adopt_stale` immediately refused as expired — recovery with no supported exit.
// 2. A proven-dead device/runner owner discovered AFTER startup demanded `adopt_stale`,
//    but adoption handles are only minted at startup for source/port conflicts, so the
//    advertised policy was unreachable. A device owner in a foreign worktree also must
//    never be whole-session adopted.
//
// Everything here runs on a fake clock over a disposable SQLite registry.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { openSessionRegistry } from '../../../dist/session/registry.js';
import { projectPublicAuthorityStatus } from '../../../dist/session/public-status.js';
import { WorkerAuthorityRuntime } from '../../../dist/session/runtime.js';
import { createSessionHandler } from '../../../dist/tools/session.js';

const HANDLE_TTL_MS = 5 * 60_000;
const RECOVERY_CAPABILITY = 'recovery-capability';
const RECOVERY_WORKER = 'recovery-worker';
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'rn-gh672-recovery-'));
  roots.push(root);
  let now = 1_000_000;
  const ownerStates = new Map<string, string>();
  const registry = openSessionRegistry(join(root, 'registry.sqlite3'), {
    now: () => now,
    ownerStatus: (owner: { sessionId: string }) => ownerStates.get(owner.sessionId) ?? 'unknown',
    listenerStatus: () => 'absent',
    leaseMs: 30_000,
  });
  const create = (sessionId: string, worktreeKey: string, bindings = {}) => {
    ownerStates.set(sessionId, 'match');
    return registry.createSession({
      sessionId,
      sourceKey: 'repo',
      worktreeKey,
      appRootKey: '.',
      supervisor: { pid: 4000 + roots.length, token: `birth-${sessionId}` },
      source: { kind: 'git', contentRoot: `/src/${worktreeKey}` },
      bindings,
    });
  };
  return {
    registry,
    create,
    ownerStates,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

/** Owner `a` holds the worktree; contender `b` is fenced blocked with a recovery worker. */
function blockedContender() {
  const f = fixture();
  const owner = f.create('a', 'worktree-1', { metroPort: 8248, observePort: 7396 });
  f.registry.claimResources(owner, [
    { type: 'source', key: 'worktree-1' },
    { type: 'metro-port', key: '8248' },
  ]);
  const contender = f.create('b', 'worktree-1', { metroPort: 8248, observePort: 7396 });
  f.registry.updateBindings(contender, {
    state: 'blocked',
    bindings: {
      recoveryCapabilityHash: createHash('sha256').update(RECOVERY_CAPABILITY).digest('hex'),
      adoptionRequired: { sessionId: owner.sessionId, claimEpoch: owner.claimEpoch },
    },
  });
  f.registry.bindRecoveryWorker(
    contender,
    { instanceId: RECOVERY_WORKER, pid: 9001, token: 'recovery-birth' },
    RECOVERY_CAPABILITY,
  );
  return { ...f, owner, contender };
}

function adoptionHandle(registry: ReturnType<typeof openSessionRegistry>, sessionId: string) {
  const handles = registry.getSessionStatus(sessionId)?.bindings.recoveryHandles as
    | {
        adoptStale?: {
          token?: string;
          expiresMs?: number;
          previous?: { token?: string; expiresMs?: number };
        };
      }
    | undefined;
  return handles?.adoptStale;
}

function advertisedRecovery(
  registry: ReturnType<typeof openSessionRegistry>,
  sessionId: string,
  now: number,
) {
  const status = registry.getSessionStatus(sessionId);
  assert.ok(status);
  const projected = projectPublicAuthorityStatus(
    { available: true, ...status },
    { now: () => now, recoveryRequirement: registry.inspectRecoveryRequirement(sessionId) },
  );
  return projected as Record<string, Record<string, unknown> | undefined>;
}

test('GH#672: status never advertises an adoption handle that adopt_stale would refuse', () => {
  const f = blockedContender();
  const minted = adoptionHandle(f.registry, 'b');
  assert.ok(minted?.token, 'a blocked contender is offered an adoption handle');
  f.registry.validateStaleAdoption(f.contender, minted.token, RECOVERY_WORKER);

  // The reported deadlock: five minutes later the same handle is still stored, still
  // advertised, and no longer valid.
  f.advance(HANDLE_TTL_MS + 1);
  assert.throws(
    () => f.registry.validateStaleAdoption(f.contender, minted.token!, RECOVERY_WORKER),
    (error: { code?: string }) => error.code === 'HANDOFF_NOT_AUTHORIZED',
  );
  const expiredView = advertisedRecovery(f.registry, 'b', f.now());
  assert.equal(expiredView.recovery?.adoptionHandle, undefined);
  assert.equal(expiredView.recovery?.adoptionHandleExpired, true);

  assert.equal(
    f.registry.refreshRecoveryHandles(
      f.contender,
      { instanceId: RECOVERY_WORKER },
      RECOVERY_CAPABILITY,
    ),
    true,
  );
  const rotated = adoptionHandle(f.registry, 'b');
  assert.notEqual(rotated?.token, minted.token, 'the expired token is replaced, not extended');
  f.registry.validateStaleAdoption(f.contender, rotated!.token!, RECOVERY_WORKER);
  const freshView = advertisedRecovery(f.registry, 'b', f.now());
  assert.equal(freshView.recovery?.adoptionHandle, rotated?.token);
});

test('GH#672: a still-fresh adoption handle survives a refresh unchanged', () => {
  const f = blockedContender();
  const minted = adoptionHandle(f.registry, 'b');
  f.advance(10_000);

  assert.equal(
    f.registry.refreshRecoveryHandles(
      f.contender,
      { instanceId: RECOVERY_WORKER },
      RECOVERY_CAPABILITY,
    ),
    false,
    'a handle a caller may have just read must not be invalidated',
  );
  assert.equal(adoptionHandle(f.registry, 'b')?.token, minted?.token);
});

test('GH#672: grace rotation keeps both tokens valid only through the prior expiry', () => {
  const f = blockedContender();
  const original = adoptionHandle(f.registry, 'b')!;
  f.advance(HANDLE_TTL_MS - 60_000);

  assert.equal(
    f.registry.refreshRecoveryHandles(
      f.contender,
      { instanceId: RECOVERY_WORKER },
      RECOVERY_CAPABILITY,
    ),
    true,
  );
  const replacement = adoptionHandle(f.registry, 'b')!;
  assert.notEqual(replacement.token, original.token);
  assert.equal(replacement.previous?.token, original.token);
  assert.equal(replacement.previous?.expiresMs, original.expiresMs);
  f.registry.validateStaleAdoption(f.contender, original.token!, RECOVERY_WORKER);
  f.registry.validateStaleAdoption(f.contender, replacement.token!, RECOVERY_WORKER);

  f.advance(60_001);
  assert.throws(
    () => f.registry.validateStaleAdoption(f.contender, original.token!, RECOVERY_WORKER),
    (error: { code?: string }) => error.code === 'HANDOFF_NOT_AUTHORIZED',
  );
  assert.equal(
    f.registry.refreshRecoveryHandles(
      f.contender,
      { instanceId: RECOVERY_WORKER },
      RECOVERY_CAPABILITY,
    ),
    true,
  );
  assert.equal(adoptionHandle(f.registry, 'b')?.previous, undefined);
});

test('GH#672: status calls straddling renewal preserve the earlier returned handle', () => {
  const f = blockedContender();
  f.advance(HANDLE_TTL_MS - 60_001);
  const earlier = adoptionHandle(f.registry, 'b')!;
  assert.equal(
    f.registry.refreshRecoveryHandles(
      f.contender,
      { instanceId: RECOVERY_WORKER },
      RECOVERY_CAPABILITY,
    ),
    false,
  );

  f.advance(2);
  assert.equal(
    f.registry.refreshRecoveryHandles(
      f.contender,
      { instanceId: RECOVERY_WORKER },
      RECOVERY_CAPABILITY,
    ),
    true,
  );
  f.registry.validateStaleAdoption(f.contender, earlier.token!, RECOVERY_WORKER);
});

test('GH#672: handoff recipient overlap accepts the prior token', () => {
  const f = blockedContender();
  const handles = f.registry.getSessionStatus('b')?.bindings.recoveryHandles as {
    handoffRecipient?: { token?: string };
  };
  const prior = handles.handoffRecipient?.token;
  f.advance(HANDLE_TTL_MS - 60_000);
  f.registry.refreshRecoveryHandles(
    f.contender,
    { instanceId: RECOVERY_WORKER },
    RECOVERY_CAPABILITY,
  );

  const handoff = f.registry.prepareHandoff(f.owner, { targetHandle: prior });
  assert.ok(handoff.handoffId);
});

test('GH#672: a rotated token cannot authorize another session', () => {
  const f = blockedContender();
  const other = f.create('c', 'worktree-1', { metroPort: 8248, observePort: 7396 });
  f.registry.updateBindings(other, {
    state: 'blocked',
    bindings: {
      recoveryCapabilityHash: createHash('sha256').update(RECOVERY_CAPABILITY).digest('hex'),
      adoptionRequired: { sessionId: f.owner.sessionId, claimEpoch: f.owner.claimEpoch },
    },
  });
  f.registry.bindRecoveryWorker(
    other,
    { instanceId: 'other-recovery-worker', pid: 9002, token: 'other-recovery-birth' },
    RECOVERY_CAPABILITY,
  );
  f.advance(HANDLE_TTL_MS - 60_000);
  f.registry.refreshRecoveryHandles(
    f.contender,
    { instanceId: RECOVERY_WORKER },
    RECOVERY_CAPABILITY,
  );
  const token = adoptionHandle(f.registry, 'b')?.token;

  assert.throws(
    () => f.registry.validateStaleAdoption(other, token!, 'other-recovery-worker'),
    (error: { code?: string }) => error.code === 'HANDOFF_NOT_AUTHORIZED',
  );
});

test('GH#672: handoff cleanup status exposes a rotatable authenticated resume handle', () => {
  const f = blockedContender();
  f.registry.claimResources(f.owner, [{ type: 'runner', key: 'ios:sim-1:9200' }]);
  f.registry.updateBindings(f.owner, {
    state: 'device_claimed',
    bindings: {
      device: { platform: 'ios', deviceId: 'sim-1' },
      runner: {
        platform: 'ios',
        deviceId: 'sim-1',
        port: 9200,
        capability: 'runner-capability',
        instanceId: 'runner-instance',
      },
    },
  });
  f.ownerStates.set('a', 'mismatch');
  const original = adoptionHandle(f.registry, 'b')!;
  f.registry.adoptStaleWithHandle(f.contender, original.token!, RECOVERY_WORKER);
  f.advance(HANDLE_TTL_MS - 60_000);
  f.registry.refreshRecoveryHandles(
    f.contender,
    { instanceId: RECOVERY_WORKER },
    RECOVERY_CAPABILITY,
  );
  const replacement = adoptionHandle(f.registry, 'b')!;
  const projected = advertisedRecovery(f.registry, 'b', f.now());

  assert.equal(projected.recovery?.adoptionHandle, replacement.token);
  f.registry.verifyStaleAdoptionResumption(f.contender, original.token!, RECOVERY_WORKER);
  f.registry.verifyStaleAdoptionResumption(f.contender, replacement.token!, RECOVERY_WORKER);
});

test('GH#672: handle refresh is capability- and worker-bound', () => {
  const f = blockedContender();
  f.advance(HANDLE_TTL_MS + 1);

  assert.throws(
    () =>
      f.registry.refreshRecoveryHandles(f.contender, { instanceId: RECOVERY_WORKER }, 'guessed'),
    (error: { code?: string }) => error.code === 'HANDOFF_NOT_AUTHORIZED',
  );
  assert.throws(
    () =>
      f.registry.refreshRecoveryHandles(
        f.contender,
        { instanceId: 'other-worker' },
        RECOVERY_CAPABILITY,
      ),
    (error: { code?: string }) => error.code === 'HANDOFF_TARGET_MISMATCH',
  );
  assert.equal(adoptionHandle(f.registry, 'b')?.expiresMs, 1_000_000 + HANDLE_TTL_MS);
});

test('GH#672: a refreshed handle still cannot steal a live owner past its lease', () => {
  const f = blockedContender();
  f.advance(HANDLE_TTL_MS + 60_000); // well past both the handle TTL and the 30s lease
  f.registry.refreshRecoveryHandles(
    f.contender,
    { instanceId: RECOVERY_WORKER },
    RECOVERY_CAPABILITY,
  );
  const rotated = adoptionHandle(f.registry, 'b');

  assert.throws(
    () => f.registry.adoptStaleWithHandle(f.contender, rotated!.token!, RECOVERY_WORKER),
    (error: { code?: string; message?: string }) =>
      error.code === 'SESSION_AUTHORITY_REQUIRED' && /not proven stale/.test(error.message ?? ''),
    'lease expiry alone never transfers a live owner',
  );
  assert.equal(f.registry.getSessionStatus('a')?.state, 'active', 'the live owner is not fenced');
  assert.equal(f.registry.getClaim('source', 'worktree-1')?.sessionId, 'a');
});

test('GH#672: recovery requirement separates adoption, attach, and transport restart', () => {
  const f = blockedContender();

  f.ownerStates.set('a', 'match');
  assert.deepEqual(
    {
      ...f.registry.inspectRecoveryRequirement('b'),
      nextAction: undefined,
    },
    { requirement: 'attach', priorOwner: 'live', nextAction: undefined },
  );

  f.ownerStates.set('a', 'unknown');
  assert.equal(f.registry.inspectRecoveryRequirement('b').priorOwner, 'unknown');
  assert.equal(f.registry.inspectRecoveryRequirement('b').requirement, 'attach');

  f.ownerStates.set('a', 'mismatch');
  const adoptable = f.registry.inspectRecoveryRequirement('b');
  assert.equal(adoptable.requirement, 'adoption');
  assert.match(adoptable.nextAction, /adopt_stale/);

  f.registry.releaseSession(f.owner);
  const gone = f.registry.inspectRecoveryRequirement('b');
  assert.equal(gone.requirement, 'transport-restart');
  assert.match(gone.nextAction, /Restart the MCP transport/);
});

test('GH#672: source recovery completes on the handle status advertises after expiry', () => {
  const f = blockedContender();
  f.advance(HANDLE_TTL_MS + 1);
  f.ownerStates.set('a', 'mismatch');

  f.registry.refreshRecoveryHandles(
    f.contender,
    { instanceId: RECOVERY_WORKER },
    RECOVERY_CAPABILITY,
  );
  const advertised = advertisedRecovery(f.registry, 'b', f.now());
  const handle = advertised.recovery?.adoptionHandle as string;
  assert.ok(handle, 'status advertises a usable handle once the prior owner is proven dead');
  assert.equal(advertised.recoveryRequirement?.requirement, 'adoption');

  f.registry.adoptStaleWithHandle(f.contender, handle, RECOVERY_WORKER);

  assert.equal(f.registry.getSessionStatus('b')?.state, 'source_bound');
  assert.equal(f.registry.getClaim('source', 'worktree-1')?.sessionId, 'b');
  assert.equal(f.registry.getSessionStatus('a')?.state, 'stale');
});

/** A dead owner in ANOTHER worktree holding the exact device, its runner and recorder. */
function deadDeviceOwner() {
  const f = fixture();
  const dead = f.create('dead-device-owner', 'worktree-foreign', {
    metroPort: 8300,
    observePort: 7400,
  });
  f.registry.claimResources(dead, [
    { type: 'source', key: 'worktree-foreign' },
    { type: 'metro-port', key: '8300' },
    { type: 'device', key: 'ios:sim-1' },
    { type: 'runner', key: 'ios:sim-1:9200' },
    { type: 'recorder', key: 'ios:sim-1' },
  ]);
  f.registry.updateBindings(dead, {
    state: 'device_claimed',
    bindings: {
      device: { platform: 'ios', deviceId: 'sim-1', appId: 'com.example.app' },
      runner: {
        platform: 'ios',
        deviceId: 'sim-1',
        port: 9200,
        capability: 'runner-capability',
        instanceId: 'runner-instance',
        processBirth: 'runner-birth',
      },
      recorder: { platform: 'ios', deviceId: 'sim-1', scope: 'device', processBirth: 'rec-birth' },
      packageIntegration: { installedBySessionId: 'dead-device-owner', manifestSha256: 'abc' },
    },
  });
  const live = f.create('live', 'worktree-mine', { metroPort: 8248, observePort: 7396 });
  f.registry.claimResources(live, [
    { type: 'source', key: 'worktree-mine' },
    { type: 'metro-port', key: '8248' },
  ]);
  f.registry.bindWorker(live, { instanceId: 'live-worker', pid: 9100, token: 'live-birth' });
  f.ownerStates.set('dead-device-owner', 'mismatch');
  return { ...f, dead, live };
}

test('GH#672: a dead device owner is released without adopting its source or package authority', () => {
  const f = deadDeviceOwner();

  const offer = f.registry.prepareStaleResourceRelease(f.live, {
    platform: 'ios',
    deviceId: 'sim-1',
  });
  assert.deepEqual([...offer.obligations].sort(), ['recorder', 'runner']);
  assert.equal(offer.priorSessionId, 'dead-device-owner');

  const plan = f.registry.beginStaleResourceRelease(f.live, offer.token, 'live-worker');
  assert.equal(plan.runner?.port, 9200);
  assert.equal(plan.recorder?.scope, 'device');
  assert.equal(f.registry.getClaim('device', 'ios:sim-1')?.sessionId, 'live');
  assert.equal(f.registry.getClaim('runner', 'ios:sim-1:9200')?.sessionId, 'live');

  // The dead owner keeps everything that is NOT device-scoped.
  const deadAfter = f.registry.getSessionStatus('dead-device-owner');
  assert.equal(f.registry.getClaim('source', 'worktree-foreign')?.sessionId, 'dead-device-owner');
  assert.equal(f.registry.getClaim('metro-port', '8300')?.sessionId, 'dead-device-owner');
  assert.ok(deadAfter?.bindings.packageIntegration, 'package-integration duty is never taken over');
  assert.equal(deadAfter?.bindings.runner, null);
  assert.equal(
    (deadAfter?.bindings.deviceReleased as { toSessionId?: string })?.toSessionId,
    'live',
    'the dead owner keeps a durable record of what left and to whom',
  );

  f.registry.completeStaleResourceRelease(f.live, 'live-worker', 'recorder');
  f.registry.completeStaleResourceRelease(f.live, 'live-worker', 'runner');
  f.registry.finishStaleResourceRelease(f.live, 'live-worker');

  assert.equal(f.registry.getClaim('device', 'ios:sim-1'), null);
  assert.equal(f.registry.getClaim('runner', 'ios:sim-1:9200'), null);
  assert.equal(f.registry.getClaim('recorder', 'ios:sim-1'), null);
  assert.equal(f.registry.getSessionStatus('live')?.bindings.staleDeviceCleanup, null);

  f.registry.claimResources(f.live, [{ type: 'device', key: 'ios:sim-1' }]);
  assert.equal(f.registry.getClaim('device', 'ios:sim-1')?.sessionId, 'live');
});

test('GH#672: device release refuses a live owner and an unprovable identity', () => {
  const f = deadDeviceOwner();

  f.ownerStates.set('dead-device-owner', 'match');
  assert.throws(
    () => f.registry.prepareStaleResourceRelease(f.live, { platform: 'ios', deviceId: 'sim-1' }),
    (error: { code?: string }) => error.code === 'DEVICE_CLAIM_CONFLICT',
  );

  f.ownerStates.set('dead-device-owner', 'unknown');
  assert.throws(
    () => f.registry.prepareStaleResourceRelease(f.live, { platform: 'ios', deviceId: 'sim-1' }),
    (error: { code?: string }) => error.code === 'STALE_LEASE_NOT_RECLAIMABLE',
  );
  assert.equal(f.registry.getClaim('device', 'ios:sim-1')?.sessionId, 'dead-device-owner');
});

test('GH#672: an owner that revives between offer and release keeps its device', () => {
  const f = deadDeviceOwner();
  const offer = f.registry.prepareStaleResourceRelease(f.live, {
    platform: 'ios',
    deviceId: 'sim-1',
  });

  f.ownerStates.set('dead-device-owner', 'match');
  assert.throws(
    () => f.registry.beginStaleResourceRelease(f.live, offer.token, 'live-worker'),
    (error: { code?: string }) => error.code === 'DEVICE_CLAIM_CONFLICT',
    'death is re-proven from durable state at execution, never trusted from the offer',
  );
  assert.equal(f.registry.getClaim('device', 'ios:sim-1')?.sessionId, 'dead-device-owner');
  assert.ok(f.registry.getSessionStatus('dead-device-owner')?.bindings.runner);
});

test('GH#672: an expired release offer refuses and a foreign worker cannot use it', () => {
  const f = deadDeviceOwner();
  const offer = f.registry.prepareStaleResourceRelease(f.live, {
    platform: 'ios',
    deviceId: 'sim-1',
  });

  assert.throws(
    () => f.registry.beginStaleResourceRelease(f.live, offer.token, 'other-worker'),
    (error: { code?: string }) => error.code === 'HANDOFF_TARGET_MISMATCH',
  );
  f.advance(HANDLE_TTL_MS + 1);
  assert.throws(
    () => f.registry.beginStaleResourceRelease(f.live, offer.token, 'live-worker'),
    (error: { code?: string }) => error.code === 'HANDOFF_NOT_AUTHORIZED',
  );
  assert.equal(f.registry.getClaim('device', 'ios:sim-1')?.sessionId, 'dead-device-owner');
});

test('GH#672: a crash mid-release resumes the durable journal instead of restarting it', () => {
  const f = deadDeviceOwner();
  const offer = f.registry.prepareStaleResourceRelease(f.live, {
    platform: 'ios',
    deviceId: 'sim-1',
  });
  f.registry.beginStaleResourceRelease(f.live, offer.token, 'live-worker');
  f.registry.completeStaleResourceRelease(f.live, 'live-worker', 'recorder');
  f.advance(HANDLE_TTL_MS + 1);

  const resumed = f.registry.beginStaleResourceRelease(f.live, offer.token, 'live-worker');
  assert.equal(typeof resumed.recorder?.completedAt, 'number');
  assert.equal(resumed.runner?.completedAt, null);
  assert.equal(resumed.runner?.port, 9200);

  assert.throws(
    () => f.registry.finishStaleResourceRelease(f.live, 'live-worker'),
    (error: { code?: string }) => error.code === 'AUTOMATION_CLEANUP_UNPROVEN',
    'the device is never freed while a cleanup obligation is unproven',
  );
  assert.equal(f.registry.getClaim('device', 'ios:sim-1')?.sessionId, 'live');

  f.registry.completeStaleResourceRelease(f.live, 'live-worker', 'runner');
  f.registry.finishStaleResourceRelease(f.live, 'live-worker');
  assert.equal(f.registry.getClaim('device', 'ios:sim-1'), null);
});

test('GH#672: device rebinding is refused while its cleanup journal is incomplete', () => {
  const f = deadDeviceOwner();
  const offer = f.registry.prepareStaleResourceRelease(f.live, {
    platform: 'ios',
    deviceId: 'sim-1',
  });
  f.registry.beginStaleResourceRelease(f.live, offer.token, 'live-worker');

  assert.throws(
    () => f.registry.claimResources(f.live, [{ type: 'device', key: 'ios:sim-1' }]),
    (error: { code?: string }) => error.code === 'AUTOMATION_CLEANUP_UNPROVEN',
  );
  f.registry.claimResources(f.live, [{ type: 'device', key: 'ios:sim-2' }]);
  assert.equal(f.registry.getClaim('device', 'ios:sim-2')?.sessionId, 'live');
});

test('GH#672: releasing a device with no foreign claim is refused, not silently granted', () => {
  const f = deadDeviceOwner();
  assert.throws(
    () => f.registry.prepareStaleResourceRelease(f.live, { platform: 'ios', deviceId: 'sim-9' }),
    (error: { code?: string }) => error.code === 'DEVICE_CLAIM_CONFLICT',
  );
});

test('GH#672: a device id containing a SQL wildcard never releases a neighbour runner', () => {
  const f = fixture();
  const dead = f.create('dead', 'worktree-foreign');
  f.registry.claimResources(dead, [
    { type: 'device', key: 'ios:sim_1' },
    { type: 'runner', key: 'ios:sim_1:9200' },
    { type: 'runner', key: 'ios:simX1:9300' },
  ]);
  f.registry.updateBindings(dead, {
    state: 'device_claimed',
    bindings: {
      device: { platform: 'ios', deviceId: 'sim_1' },
      runner: { platform: 'ios', deviceId: 'sim_1', port: 9200 },
    },
  });
  const live = f.create('live', 'worktree-mine');
  f.registry.bindWorker(live, { instanceId: 'live-worker', pid: 9100, token: 'live-birth' });
  f.ownerStates.set('dead', 'mismatch');

  const offer = f.registry.prepareStaleResourceRelease(live, {
    platform: 'ios',
    deviceId: 'sim_1',
  });
  f.registry.beginStaleResourceRelease(live, offer.token, 'live-worker');

  assert.equal(f.registry.getClaim('runner', 'ios:sim_1:9200')?.sessionId, 'live');
  assert.equal(
    f.registry.getClaim('runner', 'ios:simX1:9300')?.sessionId,
    'dead',
    'the `_` in a device id must not match another device as a LIKE wildcard',
  );
});

test('GH#672: stale adoption inherits every transferred device cleanup obligation', async () => {
  const f = deadDeviceOwner();
  const offer = f.registry.prepareStaleResourceRelease(f.live, {
    platform: 'ios',
    deviceId: 'sim-1',
  });
  f.registry.beginStaleResourceRelease(f.live, offer.token, 'live-worker');
  f.registry.completeStaleResourceRelease(f.live, 'live-worker', 'recorder');
  f.ownerStates.set('live', 'mismatch');

  const adopter = f.create('adopter', 'worktree-mine', {
    metroPort: 8248,
    observePort: 7396,
  });
  f.registry.updateBindings(adopter, {
    state: 'blocked',
    bindings: {
      recoveryCapabilityHash: createHash('sha256').update(RECOVERY_CAPABILITY).digest('hex'),
      adoptionRequired: { sessionId: f.live.sessionId, claimEpoch: f.live.claimEpoch },
    },
  });
  f.registry.bindRecoveryWorker(
    adopter,
    { instanceId: 'adopter-worker', pid: 9200, token: 'adopter-birth' },
    RECOVERY_CAPABILITY,
  );
  const handle = adoptionHandle(f.registry, 'adopter')?.token;
  f.registry.adoptStaleWithHandle(adopter, handle!, 'adopter-worker');

  const transferred = f.registry.getSessionStatus('adopter');
  const cleanup = transferred?.bindings.handoffCleanup as {
    runner?: Record<string, unknown>;
    recorder?: Record<string, unknown>;
  };
  assert.equal(cleanup.runner?.port, 9200);
  assert.equal(typeof cleanup.recorder?.completedAt, 'number');
  assert.equal(f.registry.getClaim('device', 'ios:sim-1')?.sessionId, 'adopter');
  assert.equal(f.registry.getClaim('runner', 'ios:sim-1:9200')?.sessionId, 'adopter');

  const stopped: string[] = [];
  const runtime = new WorkerAuthorityRuntime(f.registry, adopter, null, true, RECOVERY_CAPABILITY);
  const handler = createSessionHandler(runtime as never, {
    deviceExists: () => true,
    stopHandoffRunner: async () => {
      stopped.push('runner');
    },
    stopHandoffRecorder: async () => {
      stopped.push('recorder');
    },
  });
  const result = await handler({ action: 'adopt_stale', adoptionHandle: handle });

  assert.equal(result.isError, undefined, result.content[0]!.text);
  assert.deepEqual(stopped, ['runner']);
  assert.equal(f.registry.getSessionStatus('adopter')?.state, 'source_bound');
  assert.equal(f.registry.getClaim('device', 'ios:sim-1'), null);
  assert.equal(f.registry.getClaim('runner', 'ios:sim-1:9200'), null);
  assert.equal(f.registry.getClaim('recorder', 'ios:sim-1'), null);
});

function envelope(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0]!.text) as {
    ok: boolean;
    data: Record<string, never>;
    error?: string;
    code?: string;
    meta?: Record<string, never>;
  };
}

test('GH#672: bind_device turns an unreachable adopt_stale demand into a named release path', async () => {
  const f = deadDeviceOwner();
  const runtime = new WorkerAuthorityRuntime(f.registry, f.live, null);
  const handler = createSessionHandler(runtime as never, { deviceExists: () => true });

  const refused = await handler({
    action: 'bind_device',
    platform: 'ios',
    deviceId: 'sim-1',
    appId: 'com.example.app',
  });

  const body = envelope(refused);
  assert.equal(refused.isError, true);
  assert.equal(body.code, 'STALE_DEVICE_RELEASE_REQUIRED');
  assert.match(String(body.meta?.nextAction), /release_stale_device/);
  assert.match(String(body.meta?.nextAction), /runner/);
  assert.equal(f.registry.getClaim('device', 'ios:sim-1')?.sessionId, 'dead-device-owner');

  const offer = f.registry.getSessionStatus('live')?.bindings.staleDeviceRelease as {
    token: string;
  };
  const stopped: string[] = [];
  const releaseHandler = createSessionHandler(runtime as never, {
    deviceExists: () => true,
    stopHandoffRunner: async () => {
      stopped.push('runner');
    },
    stopHandoffRecorder: async () => {
      stopped.push('recorder');
    },
  });
  const released = await releaseHandler({
    action: 'release_stale_device',
    platform: 'ios',
    deviceId: 'sim-1',
    releaseHandle: offer.token,
  });
  assert.equal(released.isError, undefined, released.content[0]!.text);
  assert.deepEqual(stopped, ['recorder', 'runner']);
  assert.equal(f.registry.getClaim('device', 'ios:sim-1'), null);

  const bound = await handler({
    action: 'bind_device',
    platform: 'ios',
    deviceId: 'sim-1',
    appId: 'com.example.app',
  });
  assert.equal(bound.isError, undefined, bound.content[0]!.text);
  assert.equal(f.registry.getClaim('device', 'ios:sim-1')?.sessionId, 'live');
});

test('GH#672: a release handle minted for one device cannot free another', async () => {
  const f = deadDeviceOwner();
  const runtime = new WorkerAuthorityRuntime(f.registry, f.live, null);
  const offer = f.registry.prepareStaleResourceRelease(f.live, {
    platform: 'ios',
    deviceId: 'sim-1',
  });
  const handler = createSessionHandler(runtime as never, { deviceExists: () => true });

  const refused = await handler({
    action: 'release_stale_device',
    platform: 'android',
    deviceId: 'emulator-5554',
    releaseHandle: offer.token,
  });

  assert.equal(refused.isError, true);
  assert.equal(envelope(refused).code, 'DEVICE_AUTHORITY_MISMATCH');
  assert.equal(f.registry.getClaim('device', 'ios:sim-1')?.sessionId, 'dead-device-owner');
});

test('GH#672: the status action itself rotates an expired adoption handle', async () => {
  const f = blockedContender();
  const stale = adoptionHandle(f.registry, 'b')?.token;
  f.advance(HANDLE_TTL_MS + 1);
  f.ownerStates.set('a', 'mismatch');

  const runtime = new WorkerAuthorityRuntime(
    f.registry,
    f.contender,
    null,
    true,
    RECOVERY_CAPABILITY,
  );
  const handler = createSessionHandler(runtime as never, { now: f.now });

  const result = await handler({ action: 'status' });
  const authority = envelope(result).data.authority as unknown as {
    recovery?: { adoptionHandle?: string; adoptionHandleExpired?: boolean };
    recoveryRequirement?: { requirement?: string };
  };

  assert.ok(authority.recovery?.adoptionHandle, 'status hands out a usable handle');
  assert.notEqual(authority.recovery.adoptionHandle, stale);
  assert.equal(authority.recovery.adoptionHandleExpired, undefined);
  assert.equal(authority.recoveryRequirement?.requirement, 'adoption');

  f.registry.validateStaleAdoption(
    f.contender,
    authority.recovery.adoptionHandle!,
    RECOVERY_WORKER,
  );
});
