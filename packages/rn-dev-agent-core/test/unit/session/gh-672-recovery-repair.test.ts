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
// L4 update: NEW sessions are `grouped-v1` and mint no adoption or handoff-recipient
// handles at all — a proven-dead same-root owner is released by automatic startup
// cleanup instead (see startup-dead-owner-cleanup.test.ts). The handle-minting tests
// below pin the LEGACY axes-v1 drain surface: rows without the model marker (created
// by pre-L4 supervisors) keep the full adoption surface until it retires. The
// non-steal, death-re-proof, journal, and redaction tests are version-independent.
//
// Everything here runs on a fake clock over a disposable SQLite registry.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { createAuthorityGate } from '../../../dist/session/authority-gate.js';
import { createBuildReceipt } from '../../../dist/session/build-receipt.js';
import { openSessionRegistry } from '../../../dist/session/registry.js';
import { projectPublicAuthorityStatus } from '../../../dist/session/public-status.js';
import { WorkerAuthorityRuntime } from '../../../dist/session/runtime.js';
import { createSessionHandler } from '../../../dist/tools/session.js';

const HANDLE_TTL_MS = 5 * 60_000;
const RECOVERY_CAPABILITY = 'recovery-capability';
const RECOVERY_WORKER = 'recovery-worker';
const RECORDER_SCOPE = 'a'.repeat(64);
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
      source: { kind: 'git', contentRoot: process.cwd(), appRoot: process.cwd() },
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

function withAuthorityGate(
  runtime: WorkerAuthorityRuntime,
  handler: ReturnType<typeof createSessionHandler>,
): ReturnType<typeof createSessionHandler> {
  return createAuthorityGate(runtime as never, {
    probe: async ({ axis }) => ({ axis, identity: `${axis}-stable` }),
  }).wrap('rn_session', handler as never) as ReturnType<typeof createSessionHandler>;
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

test('GH#672 legacy axes-v1: status never advertises an adoption handle that adopt_stale would refuse', () => {
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

test('GH#672 legacy axes-v1: a still-fresh adoption handle survives a refresh unchanged', () => {
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

test('GH#672 legacy axes-v1: grace rotation keeps both tokens valid only through the prior expiry', () => {
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

test('GH#672 legacy axes-v1: status calls straddling renewal preserve the earlier returned handle', () => {
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

test('GH#672 legacy axes-v1: handoff recipient overlap accepts the prior token', () => {
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

test('GH#672 legacy axes-v1: handoff cleanup status exposes a rotatable authenticated resume handle', () => {
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

test('GH#672 legacy axes-v1: source recovery completes on the handle status advertises after expiry', () => {
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
function deadDeviceOwner(
  identityOverrides: {
    runner?: Record<string, unknown>;
    recorder?: Record<string, unknown>;
  } = {},
) {
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
      install: {
        platform: 'ios',
        deviceId: 'sim-1',
        appId: 'com.example.app',
        digest: 'dead-install',
      },
      runner: {
        platform: 'ios',
        deviceId: 'sim-1',
        port: 9200,
        pid: 9201,
        capability: 'runner-capability',
        instanceId: 'runner-instance',
        processBirth: 'runner-birth',
        ...identityOverrides.runner,
      },
      recorder: {
        phase: 'recording',
        platform: 'ios',
        deviceId: 'sim-1',
        scope: RECORDER_SCOPE,
        script: 'record_proof.sh',
        pid: 9202,
        processBirth: 'rec-birth',
        ...identityOverrides.recorder,
      },
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
  assert.equal(plan.recorder?.scope, RECORDER_SCOPE);
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

  const resumed = f.registry.beginStaleResourceRelease(f.live, undefined, 'live-worker', {
    platform: 'ios',
    deviceId: 'sim-1',
  });
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

test('GH#672: the handler exposes and resumes an expired journal before device rebinding', async () => {
  const f = deadDeviceOwner();
  const offer = f.registry.prepareStaleResourceRelease(f.live, {
    platform: 'ios',
    deviceId: 'sim-1',
  });
  f.registry.beginStaleResourceRelease(f.live, offer.token, 'live-worker');
  f.registry.completeStaleResourceRelease(f.live, 'live-worker', 'recorder');
  f.advance(HANDLE_TTL_MS + 1);
  const stopped: string[] = [];
  const runtime = new WorkerAuthorityRuntime(f.registry, f.live, null);
  const handler = createSessionHandler(runtime as never, {
    now: f.now,
    deviceExists: () => true,
    stopHandoffRunner: async () => {
      stopped.push('runner');
    },
    stopHandoffRecorder: async () => {
      stopped.push('recorder');
    },
  });

  // L5: the journal only blocks acquisition of OTHER devices; the journaled
  // device itself resumes token-lessly through a bare bind (covered below).
  const refusedBind = await handler({
    action: 'bind_device',
    platform: 'ios',
    deviceId: 'sim-2',
    appId: 'com.example.app',
  });
  const refusedBody = envelope(refusedBind);
  assert.equal(refusedBind.isError, true);
  assert.equal(refusedBody.code, 'AUTOMATION_CLEANUP_UNPROVEN');
  assert.match(String(refusedBody.meta?.nextAction), /release_stale_device/);
  assert.match(String(refusedBody.meta?.nextAction), /bind_device/);
  assert.equal(f.registry.getClaim('runner', 'ios:sim-1:9200')?.sessionId, 'live');

  const statusResult = await handler({ action: 'status' });
  const authority = envelope(statusResult).data.authority as unknown as {
    staleDeviceCleanup?: {
      platform?: string;
      obligations?: string[];
      nextAction?: string;
    };
    staleDeviceRelease?: { releaseHandle?: string; expired?: boolean; nextAction?: string };
  };
  assert.deepEqual(
    authority.staleDeviceCleanup?.obligations,
    ['runner'],
    'status omits the already-completed recorder obligation on retry',
  );
  assert.equal(authority.staleDeviceCleanup?.platform, 'ios');
  assert.match(String(authority.staleDeviceCleanup?.nextAction), /release_stale_device/);
  assert.doesNotMatch(String(authority.staleDeviceCleanup?.nextAction), /releaseHandle/);
  assert.equal(JSON.stringify(authority).includes('sim-1'), false);
  assert.equal(authority.staleDeviceRelease, undefined);

  const wrongDevice = await handler({
    action: 'release_stale_device',
    platform: 'ios',
    deviceId: 'sim-2',
  });
  assert.equal(wrongDevice.isError, true);
  assert.equal(envelope(wrongDevice).code, 'DEVICE_AUTHORITY_MISMATCH');
  assert.equal(f.registry.getClaim('device', 'ios:sim-1')?.sessionId, 'live');

  const other = f.create('other-session', 'worktree-other');
  f.registry.bindWorker(other, {
    instanceId: 'other-worker',
    pid: 9300,
    token: 'other-worker-birth',
  });
  const otherHandler = createSessionHandler(
    new WorkerAuthorityRuntime(f.registry, other, null) as never,
    { deviceExists: () => true },
  );
  const crossSession = await otherHandler({
    action: 'release_stale_device',
  });
  assert.equal(crossSession.isError, true);
  assert.equal(envelope(crossSession).code, 'DEVICE_AUTHORITY_MISMATCH');

  const staleEpochRuntime = new WorkerAuthorityRuntime(
    f.registry,
    { sessionId: f.live.sessionId, claimEpoch: f.live.claimEpoch + 1 },
    null,
  );
  const staleEpochHandler = withAuthorityGate(
    staleEpochRuntime,
    createSessionHandler(staleEpochRuntime as never, { deviceExists: () => true }),
  );
  const crossEpoch = await staleEpochHandler({ action: 'release_stale_device' });
  assert.equal(crossEpoch.isError, true);
  assert.equal(envelope(crossEpoch).code, 'SESSION_OWNER_LOST');
  assert.equal(f.registry.getClaim('device', 'ios:sim-1')?.sessionId, 'live');

  const authorityVersionBeforeRetry = f.registry.getSessionStatus('live')?.authorityVersion;
  const resumed = await withAuthorityGate(
    runtime,
    handler,
  )({
    action: 'release_stale_device',
  });
  assert.equal(resumed.isError, undefined, resumed.content[0]!.text);
  assert.equal(envelope(resumed).ok, true);
  assert.deepEqual(stopped, ['runner'], 'the completed recorder obligation is not repeated');
  assert.equal(
    f.registry.getSessionStatus('live')?.authorityVersion,
    authorityVersionBeforeRetry! + 1,
  );
  assert.equal(f.registry.getClaim('device', 'ios:sim-1'), null);
  assert.equal(f.registry.getClaim('runner', 'ios:sim-1:9200'), null);
  assert.equal(f.registry.getClaim('recorder', 'ios:sim-1'), null);

  const bound = await handler({
    action: 'bind_device',
    platform: 'ios',
    deviceId: 'sim-1',
    appId: 'com.example.app',
  });
  assert.equal(bound.isError, undefined, bound.content[0]!.text);
  assert.equal(f.registry.getClaim('device', 'ios:sim-1')?.sessionId, 'live');
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
      runner: {
        platform: 'ios',
        deviceId: 'sim_1',
        port: 9200,
        pid: 9201,
        capability: 'runner-capability',
        instanceId: 'runner-instance',
        processBirth: 'runner-birth',
      },
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

  assert.throws(
    () =>
      f.registry.beginStaleResourceRelease(f.live, undefined, 'live-worker', {
        platform: 'ios',
        deviceId: 'sim-1',
      }),
    (error: { code?: string }) => error.code === 'SESSION_OWNER_LOST',
  );

  const transferred = f.registry.getSessionStatus('adopter');
  const cleanup = transferred?.bindings.handoffCleanup as {
    runner?: Record<string, unknown>;
    recorder?: Record<string, unknown>;
  };
  assert.equal(cleanup.runner?.port, 9200);
  assert.equal(typeof cleanup.recorder?.completedAt, 'number');
  assert.equal(f.registry.getClaim('device', 'ios:sim-1')?.sessionId, 'adopter');
  assert.equal(f.registry.getClaim('runner', 'ios:sim-1:9200')?.sessionId, 'adopter');
  const projected = advertisedRecovery(f.registry, 'adopter', f.now());
  assert.match(String(projected.staleDeviceCleanup?.nextAction), /action: "adopt_stale"/);

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

test('GH#672/L5: an unconfirmed bind refuses without minting and confirmed cleans inline', async () => {
  const f = deadDeviceOwner();
  const runtime = new WorkerAuthorityRuntime(f.registry, f.live, null);
  const handler = createSessionHandler(runtime as never, { deviceExists: () => true });
  const authorityVersionBefore = f.registry.getSessionStatus('live')?.authorityVersion;

  const refused = await handler({
    action: 'bind_device',
    platform: 'ios',
    deviceId: 'sim-1',
    appId: 'com.example.app',
  });

  const body = envelope(refused);
  assert.equal(refused.isError, true);
  assert.equal(body.code, 'STALE_DEVICE_RELEASE_REQUIRED');
  assert.match(String(body.meta?.nextAction), /"bind_device"/);
  assert.match(String(body.meta?.nextAction), /confirmed: true/);
  assert.match(String(body.meta?.nextAction), /runner/);
  assert.doesNotMatch(String(body.meta?.nextAction), /releaseHandle/);
  assert.equal(
    f.registry.getSessionStatus('live')?.bindings.staleDeviceRelease,
    undefined,
    'the unconfirmed refusal mints no capability token',
  );
  assert.equal(
    f.registry.getSessionStatus('live')?.bindings.staleDeviceCleanup,
    undefined,
    'the unconfirmed refusal writes no journal',
  );
  assert.equal(f.registry.getSessionStatus('live')?.authorityVersion, authorityVersionBefore);
  assert.equal(f.registry.getClaim('device', 'ios:sim-1')?.sessionId, 'dead-device-owner');
  assert.equal(f.registry.getClaim('runner', 'ios:sim-1:9200')?.sessionId, 'dead-device-owner');

  const stopped: string[] = [];
  const confirmedHandler = withAuthorityGate(
    runtime,
    createSessionHandler(runtime as never, {
      deviceExists: () => true,
      stopHandoffRunner: async () => {
        stopped.push('runner');
      },
      stopHandoffRecorder: async () => {
        stopped.push('recorder');
      },
    }),
  );
  const bound = await confirmedHandler({
    action: 'bind_device',
    platform: 'ios',
    deviceId: 'sim-1',
    appId: 'com.example.app',
    confirmed: true,
  });
  assert.equal(bound.isError, undefined, bound.content[0]!.text);
  assert.equal(envelope(bound).ok, true);
  assert.deepEqual(stopped, ['recorder', 'runner']);
  assert.equal(f.registry.getClaim('device', 'ios:sim-1')?.sessionId, 'live');
  assert.equal(f.registry.getClaim('runner', 'ios:sim-1:9200'), null);
  assert.equal(f.registry.getClaim('recorder', 'ios:sim-1'), null);
  assert.equal(f.registry.getSessionStatus('live')?.bindings.staleDeviceCleanup, null);
  assert.ok(
    f.registry.getSessionStatus('live')!.authorityVersion > authorityVersionBefore!,
    'the fenced journal commit advances the authority generation',
  );
  assert.equal(f.registry.getClaim('source', 'worktree-mine')?.sessionId, 'live');
  assert.equal(f.registry.getClaim('metro-port', '8248')?.sessionId, 'live');
  assert.equal(f.registry.getClaim('source', 'worktree-foreign')?.sessionId, 'dead-device-owner');
  assert.equal(f.registry.getClaim('metro-port', '8300')?.sessionId, 'dead-device-owner');
  const deadAfter = f.registry.getSessionStatus('dead-device-owner');
  assert.ok(deadAfter?.bindings.install, 'the dead owner keeps install authority');
  assert.ok(
    deadAfter?.bindings.packageIntegration,
    'the dead owner keeps package-integration authority',
  );
  assert.equal(
    (deadAfter?.bindings.deviceReleased as { toSessionId?: string })?.toSessionId,
    'live',
    'the dead owner keeps a durable record of what left and to whom',
  );
});

test('GH#672/L5: release_stale_device transfers with confirmed: true and no capability token', async () => {
  const f = deadDeviceOwner();
  const runtime = new WorkerAuthorityRuntime(f.registry, f.live, null);
  const stopped: string[] = [];
  const handler = withAuthorityGate(
    runtime,
    createSessionHandler(runtime as never, {
      deviceExists: () => true,
      stopHandoffRunner: async () => {
        stopped.push('runner');
      },
      stopHandoffRecorder: async () => {
        stopped.push('recorder');
      },
    }),
  );
  const authorityVersionBefore = f.registry.getSessionStatus('live')?.authorityVersion;

  const unconfirmed = await handler({
    action: 'release_stale_device',
    platform: 'ios',
    deviceId: 'sim-1',
  });
  assert.equal(unconfirmed.isError, true);
  assert.equal(envelope(unconfirmed).code, 'SESSION_AUTHORITY_REQUIRED');
  assert.match(String(envelope(unconfirmed).meta?.nextAction), /confirmed: true/);
  assert.equal(f.registry.getSessionStatus('live')?.bindings.staleDeviceCleanup, undefined);
  assert.equal(f.registry.getSessionStatus('live')?.authorityVersion, authorityVersionBefore);
  assert.equal(f.registry.getClaim('device', 'ios:sim-1')?.sessionId, 'dead-device-owner');

  const released = await handler({
    action: 'release_stale_device',
    platform: 'ios',
    deviceId: 'sim-1',
    confirmed: true,
  });
  assert.equal(released.isError, undefined, released.content[0]!.text);
  assert.equal(envelope(released).ok, true);
  assert.deepEqual(stopped, ['recorder', 'runner']);
  assert.equal(f.registry.getClaim('device', 'ios:sim-1'), null);
  assert.equal(f.registry.getClaim('runner', 'ios:sim-1:9200'), null);
  assert.equal(f.registry.getClaim('recorder', 'ios:sim-1'), null);
  assert.equal(f.registry.getSessionStatus('live')?.authorityVersion, authorityVersionBefore! + 1);
});

test('GH#672/L5: a legacy release offer and handle still complete through the alias', async () => {
  const f = deadDeviceOwner();
  const runtime = new WorkerAuthorityRuntime(f.registry, f.live, null);
  const offer = f.registry.prepareStaleResourceRelease(f.live, {
    platform: 'ios',
    deviceId: 'sim-1',
  });
  const stopped: string[] = [];
  const handler = withAuthorityGate(
    runtime,
    createSessionHandler(runtime as never, {
      deviceExists: () => true,
      stopHandoffRunner: async () => {
        stopped.push('runner');
      },
      stopHandoffRecorder: async () => {
        stopped.push('recorder');
      },
    }),
  );
  const released = await handler({
    action: 'release_stale_device',
    platform: 'ios',
    deviceId: 'sim-1',
    releaseHandle: offer.token,
  });
  assert.equal(released.isError, undefined, released.content[0]!.text);
  assert.deepEqual(stopped, ['recorder', 'runner']);
  assert.equal(f.registry.getClaim('device', 'ios:sim-1'), null);
  assert.equal(f.registry.getSessionStatus('live')?.bindings.staleDeviceRelease, null);
});

test('GH#672/L5: a crash between obligations resumes token-lessly via bare bind_device', async () => {
  const f = deadDeviceOwner();
  const runtime = new WorkerAuthorityRuntime(f.registry, f.live, null);
  const stopped: string[] = [];
  let failRunnerStop = true;
  const handler = createSessionHandler(runtime as never, {
    deviceExists: () => true,
    stopHandoffRunner: async () => {
      if (failRunnerStop) throw new Error('runner stop interrupted');
      stopped.push('runner');
    },
    stopHandoffRecorder: async () => {
      stopped.push('recorder');
    },
  });

  const interrupted = await handler({
    action: 'bind_device',
    platform: 'ios',
    deviceId: 'sim-1',
    appId: 'com.example.app',
    confirmed: true,
  });
  assert.equal(interrupted.isError, true);
  assert.deepEqual(stopped, ['recorder']);
  const journal = f.registry.getSessionStatus('live')?.bindings.staleDeviceCleanup as {
    recorder?: { completedAt?: unknown };
    runner?: { completedAt?: unknown };
  };
  assert.equal(typeof journal?.recorder?.completedAt, 'number');
  assert.equal(journal?.runner?.completedAt, null);
  assert.equal(f.registry.getClaim('device', 'ios:sim-1')?.sessionId, 'live');

  failRunnerStop = false;
  const resumed = await handler({
    action: 'bind_device',
    platform: 'ios',
    deviceId: 'sim-1',
    appId: 'com.example.app',
  });
  assert.equal(resumed.isError, undefined, resumed.content[0]!.text);
  assert.deepEqual(stopped, ['recorder', 'runner'], 'the completed recorder is not re-stopped');
  assert.equal(f.registry.getSessionStatus('live')?.bindings.staleDeviceCleanup, null);
  assert.equal(f.registry.getClaim('device', 'ios:sim-1')?.sessionId, 'live');
  assert.equal(f.registry.getClaim('runner', 'ios:sim-1:9200'), null);
  assert.equal(f.registry.getClaim('recorder', 'ios:sim-1'), null);
});

test('GH#672/L5: the confirmed transfer refuses live, unknown, split, and foreign-worker cases without mutation', () => {
  const f = deadDeviceOwner();
  const target = { platform: 'ios', deviceId: 'sim-1' };

  f.ownerStates.set('dead-device-owner', 'match');
  assert.throws(
    () => f.registry.beginConfirmedStaleDeviceRelease(f.live, 'live-worker', target),
    (error: { code?: string }) => error.code === 'DEVICE_CLAIM_CONFLICT',
    'a live owner is never released',
  );

  f.ownerStates.set('dead-device-owner', 'unknown');
  assert.throws(
    () => f.registry.beginConfirmedStaleDeviceRelease(f.live, 'live-worker', target),
    (error: { code?: string }) => error.code === 'STALE_LEASE_NOT_RECLAIMABLE',
    'an unprovable identity is treated as live',
  );

  f.ownerStates.set('dead-device-owner', 'mismatch');
  assert.throws(
    () => f.registry.beginConfirmedStaleDeviceRelease(f.live, 'other-worker', target),
    (error: { code?: string }) => error.code === 'HANDOFF_TARGET_MISMATCH',
    'a foreign worker cannot run the confirmed transfer',
  );
  assert.throws(
    () =>
      f.registry.beginConfirmedStaleDeviceRelease(
        { sessionId: f.live.sessionId, claimEpoch: f.live.claimEpoch + 1 },
        'live-worker',
        target,
      ),
    (error: { code?: string }) => error.code === 'SESSION_OWNER_LOST',
    'a changed claim epoch refuses',
  );
  assert.throws(
    () =>
      f.registry.beginConfirmedStaleDeviceRelease(f.live, 'live-worker', {
        platform: 'ios',
        deviceId: 'sim-9',
      }),
    (error: { code?: string }) => error.code === 'DEVICE_CLAIM_CONFLICT',
    'no foreign claim means nothing to release',
  );

  const splitter = f.create('splitter', 'worktree-splitter');
  f.registry.claimResources(splitter, [{ type: 'runner', key: 'ios:sim-1:9999' }]);
  f.ownerStates.set('splitter', 'mismatch');
  assert.throws(
    () => f.registry.beginConfirmedStaleDeviceRelease(f.live, 'live-worker', target),
    (error: { code?: string }) => error.code === 'DEVICE_CLAIM_CONFLICT',
    'claims split across owners must be released explicitly',
  );

  assert.equal(f.registry.getClaim('device', 'ios:sim-1')?.sessionId, 'dead-device-owner');
  assert.equal(f.registry.getClaim('runner', 'ios:sim-1:9200')?.sessionId, 'dead-device-owner');
  assert.equal(f.registry.getSessionStatus('live')?.bindings.staleDeviceCleanup, undefined);
  assert.ok(f.registry.getSessionStatus('dead-device-owner')?.bindings.runner);
});

test('GH#672/L5: partial device families refuse before either release path mutates', () => {
  const f = fixture();
  const dead = f.create('dead', 'worktree-foreign');
  f.registry.claimResources(dead, [{ type: 'device', key: 'ios:sim-1' }]);
  f.registry.updateBindings(dead, {
    state: 'device_claimed',
    bindings: {
      device: { platform: 'ios', deviceId: 'sim-1' },
      runner: {
        platform: 'ios',
        deviceId: 'sim-1',
        port: 9200,
        pid: 9201,
        capability: 'runner-capability',
        instanceId: 'runner-instance',
        processBirth: 'runner-birth',
      },
    },
  });
  const live = f.create('live', 'worktree-mine');
  f.registry.bindWorker(live, { instanceId: 'live-worker', pid: 9100, token: 'live-birth' });
  f.ownerStates.set('dead', 'mismatch');
  const target = { platform: 'ios', deviceId: 'sim-1' };
  const authorityVersion = f.registry.getSessionStatus('live')?.authorityVersion;

  assert.throws(
    () => f.registry.inspectStaleDeviceRelease(live, target),
    (error: { code?: string }) => error.code === 'RUNNER_OWNERSHIP_MISMATCH',
  );
  assert.throws(
    () => f.registry.prepareStaleResourceRelease(live, target),
    (error: { code?: string }) => error.code === 'RUNNER_OWNERSHIP_MISMATCH',
  );
  assert.throws(
    () => f.registry.beginConfirmedStaleDeviceRelease(live, 'live-worker', target),
    (error: { code?: string }) => error.code === 'RUNNER_OWNERSHIP_MISMATCH',
  );
  assert.equal(f.registry.getClaim('device', 'ios:sim-1')?.sessionId, 'dead');
  assert.ok(f.registry.getSessionStatus('dead')?.bindings.runner);
  assert.equal(f.registry.getSessionStatus('live')?.bindings.staleDeviceRelease, undefined);
  assert.equal(f.registry.getSessionStatus('live')?.bindings.staleDeviceCleanup, undefined);
  assert.equal(f.registry.getSessionStatus('live')?.authorityVersion, authorityVersion);
});

function assertIncompleteCleanupIdentityRefusesWithoutMutation(
  f: ReturnType<typeof deadDeviceOwner>,
  code: string,
) {
  const target = { platform: 'ios', deviceId: 'sim-1' };
  const deadBefore = f.registry.getSessionStatus('dead-device-owner');
  const liveBefore = f.registry.getSessionStatus('live');
  const claimsBefore = [
    f.registry.getClaim('device', 'ios:sim-1'),
    f.registry.getClaim('runner', 'ios:sim-1:9200'),
    f.registry.getClaim('recorder', 'ios:sim-1'),
  ];

  for (const release of [
    () => f.registry.inspectStaleDeviceRelease(f.live, target),
    () => f.registry.prepareStaleResourceRelease(f.live, target),
    () => f.registry.beginConfirmedStaleDeviceRelease(f.live, 'live-worker', target),
  ]) {
    assert.throws(release, (error: { code?: string }) => error.code === code);
  }

  assert.deepEqual(f.registry.getSessionStatus('dead-device-owner'), deadBefore);
  assert.deepEqual(f.registry.getSessionStatus('live'), liveBefore);
  assert.deepEqual(
    [
      f.registry.getClaim('device', 'ios:sim-1'),
      f.registry.getClaim('runner', 'ios:sim-1:9200'),
      f.registry.getClaim('recorder', 'ios:sim-1'),
    ],
    claimsBefore,
  );
}

test('GH#672/L5: incomplete runner cleanup identity refuses before transfer', () => {
  const f = deadDeviceOwner({ runner: { pid: undefined } });

  assertIncompleteCleanupIdentityRefusesWithoutMutation(f, 'RUNNER_ADOPTION_REQUIRED');
});

test('GH#672/L5: incomplete recorder cleanup identity refuses before transfer', () => {
  const f = deadDeviceOwner({ recorder: { script: undefined } });

  assertIncompleteCleanupIdentityRefusesWithoutMutation(f, 'RECORDING_AUTHORITY_MISMATCH');
});

test('GH#672/L5: neighboring bindings refuse without releasing their claims', () => {
  const f = fixture();
  const dead = f.create('dead', 'worktree-foreign');
  f.registry.claimResources(dead, [
    { type: 'device', key: 'ios:sim-1' },
    { type: 'runner', key: 'ios:sim-2:9300' },
  ]);
  f.registry.updateBindings(dead, {
    state: 'device_claimed',
    bindings: {
      device: { platform: 'ios', deviceId: 'sim-1' },
      runner: { platform: 'ios', deviceId: 'sim-2', port: 9300 },
    },
  });
  const live = f.create('live', 'worktree-mine');
  f.registry.bindWorker(live, { instanceId: 'live-worker', pid: 9100, token: 'live-birth' });
  f.ownerStates.set('dead', 'mismatch');

  assert.throws(
    () =>
      f.registry.beginConfirmedStaleDeviceRelease(live, 'live-worker', {
        platform: 'ios',
        deviceId: 'sim-1',
      }),
    (error: { code?: string }) => error.code === 'RUNNER_OWNERSHIP_MISMATCH',
  );
  assert.equal(f.registry.getClaim('device', 'ios:sim-1')?.sessionId, 'dead');
  assert.equal(f.registry.getClaim('runner', 'ios:sim-2:9300')?.sessionId, 'dead');
  assert.equal(f.registry.getSessionStatus('live')?.bindings.staleDeviceCleanup, undefined);
});

test('GH#672/L5: contender recorder authority makes the exact family ambiguous', () => {
  const f = fixture();
  const dead = f.create('dead', 'worktree-foreign');
  f.registry.claimResources(dead, [
    { type: 'device', key: 'ios:sim-1' },
    { type: 'runner', key: 'ios:sim-1:9200' },
  ]);
  f.registry.updateBindings(dead, {
    state: 'device_claimed',
    bindings: {
      device: { platform: 'ios', deviceId: 'sim-1' },
      runner: { platform: 'ios', deviceId: 'sim-1', port: 9200 },
    },
  });
  const live = f.create('live', 'worktree-mine');
  f.registry.bindWorker(live, { instanceId: 'live-worker', pid: 9100, token: 'live-birth' });
  f.registry.claimResources(live, [{ type: 'recorder', key: 'ios:sim-1' }]);
  f.registry.updateBindings(live, {
    bindings: { recorder: { platform: 'ios', deviceId: 'sim-1', scope: 'device' } },
  });
  f.ownerStates.set('dead', 'mismatch');

  assert.throws(
    () =>
      f.registry.beginConfirmedStaleDeviceRelease(live, 'live-worker', {
        platform: 'ios',
        deviceId: 'sim-1',
      }),
    (error: { code?: string }) => error.code === 'DEVICE_CLAIM_CONFLICT',
  );
  assert.equal(f.registry.getClaim('device', 'ios:sim-1')?.sessionId, 'dead');
  assert.equal(f.registry.getClaim('recorder', 'ios:sim-1')?.sessionId, 'live');
  assert.ok(f.registry.getSessionStatus('live')?.bindings.recorder);
  assert.equal(f.registry.getSessionStatus('live')?.bindings.staleDeviceCleanup, undefined);
});

test('GH#672/L5: finish refuses authority not proven by its cleanup journal', () => {
  const f = deadDeviceOwner();
  const target = { platform: 'ios', deviceId: 'sim-1' };
  f.registry.beginConfirmedStaleDeviceRelease(f.live, 'live-worker', target);
  f.registry.completeStaleResourceRelease(f.live, 'live-worker', 'recorder');
  f.registry.completeStaleResourceRelease(f.live, 'live-worker', 'runner');
  f.registry.claimResources(f.live, [{ type: 'runner-receipt', key: 'ios:sim-1:9200' }]);
  const authorityVersion = f.registry.getSessionStatus('live')?.authorityVersion;

  assert.throws(
    () => f.registry.finishStaleResourceRelease(f.live, 'live-worker'),
    (error: { code?: string }) => error.code === 'DEVICE_AUTHORITY_MISMATCH',
  );
  assert.equal(f.registry.getClaim('device', 'ios:sim-1')?.sessionId, 'live');
  assert.equal(f.registry.getClaim('runner-receipt', 'ios:sim-1:9200')?.sessionId, 'live');
  assert.ok(f.registry.getSessionStatus('live')?.bindings.staleDeviceCleanup);
  assert.equal(f.registry.getSessionStatus('live')?.authorityVersion, authorityVersion);
});

test('GH#672/L5: confirmed bind rechecks exact device existence after cleanup', async () => {
  const f = deadDeviceOwner();
  const runtime = new WorkerAuthorityRuntime(f.registry, f.live, null);
  let deviceChecks = 0;
  const handler = withAuthorityGate(
    runtime,
    createSessionHandler(runtime as never, {
      deviceExists: () => ++deviceChecks === 1,
      stopHandoffRunner: async () => {},
      stopHandoffRecorder: async () => {},
    }),
  );

  const result = await handler({
    action: 'bind_device',
    platform: 'ios',
    deviceId: 'sim-1',
    appId: 'com.example.app',
    confirmed: true,
  });

  assert.equal(result.isError, true);
  assert.equal(envelope(result).code, 'DEVICE_NOT_FOUND');
  assert.equal(deviceChecks, 2);
  assert.equal(f.registry.getClaim('device', 'ios:sim-1'), null);
  assert.equal(f.registry.getSessionStatus('live')?.bindings.device, undefined);
});

test('GH#672/L5: confirmed bind rechecks install generation after cleanup', async () => {
  const f = deadDeviceOwner();
  const runtime = new WorkerAuthorityRuntime(f.registry, f.live, null);
  const receipt = createBuildReceipt(
    {
      sessionId: f.live.sessionId,
      sourceKey: 'repo',
      worktreeKey: 'worktree-mine',
      appRootKey: '.',
      platform: 'ios',
      deviceId: 'sim-1',
      appId: 'com.example.app',
      metroPort: 8248,
      artifactDigest: 'artifact-before-cleanup',
      installGeneration: 'install-before-cleanup',
      buildGeneration: 1,
      buildKind: 'expo',
    },
    'signer',
  );
  let generationChecks = 0;
  const handler = withAuthorityGate(
    runtime,
    createSessionHandler(runtime as never, {
      deviceExists: () => true,
      getSignerCapability: () => 'signer',
      captureInstallGeneration: () =>
        ++generationChecks === 1 ? 'install-before-cleanup' : 'install-after-cleanup',
      stopHandoffRunner: async () => {},
      stopHandoffRecorder: async () => {},
    }),
  );

  const result = await handler({
    action: 'bind_device',
    platform: 'ios',
    deviceId: 'sim-1',
    appId: 'com.example.app',
    buildReceipt: receipt,
    confirmed: true,
  });

  assert.equal(result.isError, true);
  assert.equal(envelope(result).code, 'APP_INSTALL_IDENTITY_CHANGED');
  assert.equal(generationChecks, 2);
  assert.equal(f.registry.getClaim('device', 'ios:sim-1'), null);
  assert.equal(f.registry.getSessionStatus('live')?.bindings.install, undefined);
});

test('GH#672/L5: an owner that revives before the confirmed retry keeps its device', async () => {
  const f = deadDeviceOwner();
  const runtime = new WorkerAuthorityRuntime(f.registry, f.live, null);
  const handler = createSessionHandler(runtime as never, { deviceExists: () => true });

  f.ownerStates.set('dead-device-owner', 'match');
  const refused = await handler({
    action: 'bind_device',
    platform: 'ios',
    deviceId: 'sim-1',
    appId: 'com.example.app',
    confirmed: true,
  });
  assert.equal(refused.isError, true);
  assert.equal(envelope(refused).code, 'DEVICE_CLAIM_CONFLICT');
  assert.equal(f.registry.getClaim('device', 'ios:sim-1')?.sessionId, 'dead-device-owner');
  assert.ok(f.registry.getSessionStatus('dead-device-owner')?.bindings.runner);
});

test('GH#672/L5: a wildcard device id never releases a neighbour runner through the confirmed path', () => {
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
      runner: {
        platform: 'ios',
        deviceId: 'sim_1',
        port: 9200,
        pid: 9201,
        capability: 'runner-capability',
        instanceId: 'runner-instance',
        processBirth: 'runner-birth',
      },
    },
  });
  const live = f.create('live', 'worktree-mine');
  f.registry.bindWorker(live, { instanceId: 'live-worker', pid: 9100, token: 'live-birth' });
  f.ownerStates.set('dead', 'mismatch');

  f.registry.beginConfirmedStaleDeviceRelease(live, 'live-worker', {
    platform: 'ios',
    deviceId: 'sim_1',
  });

  assert.equal(f.registry.getClaim('runner', 'ios:sim_1:9200')?.sessionId, 'live');
  assert.equal(
    f.registry.getClaim('runner', 'ios:simX1:9300')?.sessionId,
    'dead',
    'the `_` in a device id must not match another device as a LIKE wildcard',
  );
});

test('GH#672: foreign target or handle cannot produce a stale-device release commit', async () => {
  const f = deadDeviceOwner();
  const runtime = new WorkerAuthorityRuntime(f.registry, f.live, null);
  const offer = f.registry.prepareStaleResourceRelease(f.live, {
    platform: 'ios',
    deviceId: 'sim-1',
  });
  const handler = withAuthorityGate(
    runtime,
    createSessionHandler(runtime as never, { deviceExists: () => true }),
  );
  const authorityVersion = f.registry.getSessionStatus('live')?.authorityVersion;

  const wrongTarget = await handler({
    action: 'release_stale_device',
    platform: 'android',
    deviceId: 'emulator-5554',
    releaseHandle: offer.token,
  });
  assert.equal(wrongTarget.isError, true);
  assert.equal(envelope(wrongTarget).code, 'DEVICE_AUTHORITY_MISMATCH');

  const foreignHandle = await handler({
    action: 'release_stale_device',
    platform: 'ios',
    deviceId: 'sim-1',
    releaseHandle: 'foreign-release-handle',
  });
  assert.equal(foreignHandle.isError, true);
  assert.equal(envelope(foreignHandle).code, 'HANDOFF_NOT_AUTHORIZED');
  assert.equal(f.registry.getSessionStatus('live')?.authorityVersion, authorityVersion);
  assert.equal(f.registry.getSessionStatus('live')?.bindings.staleDeviceCleanup, undefined);
  assert.equal(f.registry.getClaim('device', 'ios:sim-1')?.sessionId, 'dead-device-owner');
  assert.equal(f.registry.getClaim('runner', 'ios:sim-1:9200')?.sessionId, 'dead-device-owner');
});

test('GH#672: a live device owner remains untouched through the public authority gate', async () => {
  const f = deadDeviceOwner();
  f.ownerStates.set('dead-device-owner', 'match');
  const runtime = new WorkerAuthorityRuntime(f.registry, f.live, null);
  const handler = withAuthorityGate(
    runtime,
    createSessionHandler(runtime as never, { deviceExists: () => true }),
  );
  const authorityVersion = f.registry.getSessionStatus('live')?.authorityVersion;

  const refused = await handler({
    action: 'bind_device',
    platform: 'ios',
    deviceId: 'sim-1',
    appId: 'com.example.app',
  });

  assert.equal(refused.isError, true);
  assert.equal(envelope(refused).code, 'DEVICE_CLAIM_CONFLICT');
  assert.equal(f.registry.getSessionStatus('live')?.authorityVersion, authorityVersion);
  assert.equal(f.registry.getSessionStatus('live')?.bindings.staleDeviceRelease, undefined);
  assert.equal(f.registry.getClaim('device', 'ios:sim-1')?.sessionId, 'dead-device-owner');
  assert.equal(f.registry.getClaim('runner', 'ios:sim-1:9200')?.sessionId, 'dead-device-owner');
});

test('GH#672 legacy axes-v1: the status action itself rotates an expired adoption handle', async () => {
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

test('GH#672/L4 default: a grouped-v1 contender mints nothing and status names startup cleanup', async () => {
  const f = fixture();
  const owner = f.create('a', 'worktree-1', { metroPort: 8248, observePort: 7396 });
  f.registry.claimResources(owner, [
    { type: 'source', key: 'worktree-1' },
    { type: 'metro-port', key: '8248' },
  ]);
  f.ownerStates.set('grouped', 'match');
  const contender = f.registry.createSession({
    sessionId: 'grouped',
    sourceKey: 'repo',
    worktreeKey: 'worktree-1',
    appRootKey: '.',
    supervisor: { pid: 4900, token: 'birth-grouped' },
    source: { kind: 'git', contentRoot: '/src/worktree-1', model: 'grouped-v1' },
    bindings: { metroPort: 8248, observePort: 7396 },
  });
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
  f.ownerStates.set('a', 'mismatch');

  const runtime = new WorkerAuthorityRuntime(
    f.registry,
    contender,
    null,
    true,
    RECOVERY_CAPABILITY,
  );
  const handler = createSessionHandler(runtime as never, { now: f.now });
  const result = await handler({ action: 'status' });
  const authority = envelope(result).data.authority as unknown as {
    recovery?: Record<string, unknown>;
    recoveryRequirement?: { requirement?: string; nextAction?: string };
  };

  assert.equal(authority.recovery, undefined, 'no handle surface exists to advertise');
  assert.equal(authority.recoveryRequirement?.requirement, 'transport-restart');
  assert.doesNotMatch(String(authority.recoveryRequirement?.nextAction), /adopt_stale/);

  const adopt = await handler({ action: 'adopt_stale', adoptionHandle: 'anything' });
  assert.equal(adopt.isError, true);
  assert.equal(envelope(adopt).code, 'HANDOFF_NOT_AUTHORIZED');
  assert.equal(f.registry.getClaim('source', 'worktree-1')?.sessionId, 'a');
});
