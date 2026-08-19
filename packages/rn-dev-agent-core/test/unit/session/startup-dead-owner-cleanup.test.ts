// L4 (ownership simplification): verified-dead startup cleanup replaces adoption as
// the default recovery for new `grouped-v1` sessions.
//
// A proven-dead same-root owner is released by the successor supervisor itself:
// a durable cleanup journal is written on the DEAD session's row before any side
// effect, obligations complete idempotently by exact recorded identity, and claims
// release only after every obligation is durably complete. A live owner — or any
// owner whose death cannot be positively proven — refuses; lease expiry is never
// authority. New grouped sessions mint no adoption or handoff-recipient handles.
// Legacy rows (no model marker) keep the old adoption surface for drain.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { openSessionRegistry } from '../../../dist/session/registry.js';
import { projectPublicAuthorityStatus } from '../../../dist/session/public-status.js';
import {
  runStartupOwnerCleanup,
  startupCleanupFailureMessage,
} from '../../../dist/session/startup-cleanup.js';
import { createSupervisorAuthority } from '../../../dist/session/supervisor-authority.js';
import { WorkerAuthorityRuntime } from '../../../dist/session/runtime.js';
import { createSessionHandler } from '../../../dist/tools/session.js';

const RECOVERY_CAPABILITY = 'recovery-capability';
const LEASE_MS = 30_000;
const MANIFEST_SOURCE = '{"version":1,"dependencies":{},"scripts":{}}';
const MANIFEST_SHA256 = createHash('sha256').update(MANIFEST_SOURCE).digest('hex');
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'rn-l4-startup-cleanup-'));
  roots.push(root);
  let now = 1_000_000;
  const ownerStates = new Map<string, string>();
  const registry = openSessionRegistry(join(root, 'registry.sqlite3'), {
    now: () => now,
    ownerStatus: (owner: { sessionId: string }) => ownerStates.get(owner.sessionId) ?? 'unknown',
    listenerStatus: () => 'absent',
    leaseMs: LEASE_MS,
  });
  const create = (
    sessionId: string,
    worktreeKey: string,
    bindings: Record<string, unknown> = {},
    source: Record<string, unknown> = {},
    identity: { sourceKey?: string; appRootKey?: string } = {},
  ) => {
    ownerStates.set(sessionId, 'match');
    return registry.createSession({
      sessionId,
      sourceKey: identity.sourceKey ?? 'repo',
      worktreeKey,
      appRootKey: identity.appRootKey ?? '.',
      supervisor: { pid: 4000 + roots.length, token: `birth-${sessionId}` },
      source: { kind: 'git', contentRoot: `/src/${worktreeKey}`, ...source },
      bindings,
    });
  };
  return {
    root,
    registry,
    create,
    ownerStates,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function cleanupInput(
  f: ReturnType<typeof fixture>,
  overrides: Partial<{
    sourceKey: string;
    worktreeKey: string;
    appRootKey: string;
    appRoot: string;
  }> = {},
) {
  return {
    registry: f.registry,
    sourceKey: 'repo',
    worktreeKey: 'worktree-1',
    appRootKey: '.',
    appRoot: join(f.root, 'app'),
    ...overrides,
  };
}

/** A dead same-root owner holding source+ports plus runner/recorder/observe/metro/integration. */
function deadSameRootOwner(options: { integration?: Record<string, unknown> | null } = {}) {
  const f = fixture();
  const dead = f.create('dead-owner', 'worktree-1', { metroPort: 8300, observePort: 7400 });
  f.registry.claimResources(dead, [
    { type: 'source', key: 'worktree-1' },
    { type: 'metro-port', key: '8300' },
    { type: 'observe-port', key: '7400' },
    { type: 'device', key: 'ios:sim-1' },
    { type: 'runner', key: 'ios:sim-1:9200' },
    { type: 'recorder', key: 'ios:sim-1' },
  ]);
  const integration =
    options.integration === undefined
      ? {
          version: 1,
          installedBySessionId: 'dead-owner',
          manifestSha256: MANIFEST_SHA256,
          manifestSource: MANIFEST_SOURCE,
        }
      : options.integration;
  f.registry.updateBindings(dead, {
    state: 'device_claimed',
    bindings: {
      device: { platform: 'ios', deviceId: 'sim-1', appId: 'com.example.app' },
      runner: {
        platform: 'ios',
        deviceId: 'sim-1',
        port: 9200,
        capability: 'runner-capability-secret',
        instanceId: 'runner-instance',
        processBirth: 'runner-birth',
        pid: 9911,
      },
      recorder: {
        platform: 'ios',
        deviceId: 'sim-1',
        scope: 'device',
        processBirth: 'rec-birth',
        pid: 9912,
      },
      observe: {
        port: 7400,
        pid: 9913,
        processBirth: 'observe-birth',
        instanceId: 'observe-instance',
        cleanupCapability: 'observe-cleanup-secret',
      },
      metro: {
        mode: 'managed',
        port: 8300,
        pid: 9914,
        instanceId: 'metro-instance',
        managementProof: 'metro-proof',
      },
      ...(integration ? { packageIntegration: integration } : {}),
    },
  });
  f.ownerStates.set('dead-owner', 'mismatch');
  return { ...f, dead };
}

function journalOf(registry: ReturnType<typeof openSessionRegistry>, sessionId: string) {
  return registry.getSessionStatus(sessionId)?.bindings.startupCleanup as
    | {
        journaledAt?: number;
        finishedAt?: number;
        obligations?: Record<
          string,
          { stopRequestedAt?: number | null; completedAt?: number | null } & Record<string, unknown>
        >;
        integration?: {
          requestedAt?: number;
          completedAt?: number | null;
          manifestSha256?: string;
        } | null;
      }
    | null
    | undefined;
}

function executorDeps(f: ReturnType<typeof fixture>, calls: string[]) {
  return {
    stopBoundRecorder: async (binding: Record<string, unknown>) => {
      calls.push(`recorder:${String(binding.processBirth)}`);
      return '';
    },
    stopBoundRunner: async (binding: Record<string, unknown>) => {
      calls.push(`runner:${String(binding.processBirth)}`);
    },
    stopBoundObserve: async (binding: Record<string, unknown>) => {
      calls.push(`observe:${String(binding.processBirth)}`);
    },
    stopManagedMetro: async (
      binding: Record<string, unknown>,
      input: { sessionId: string; signerCapability: string },
    ) => {
      calls.push(`metro:${String(binding.instanceId)}:${input.signerCapability}`);
      return true;
    },
    restoreIntegrationFiles: (input: { appRoot: string; manifestSource?: string }) => {
      calls.push(
        `integration:${createHash('sha256').update(String(input.manifestSource)).digest('hex').slice(0, 8)}`,
      );
    },
    readSessionSecret: (sessionId: string) =>
      sessionId === 'dead-owner' ? { signerCapability: 'dead-signer-capability' } : null,
  };
}

test('L4: startup cleanup journals and removes a dead session physical Android reverse', async () => {
  const f = fixture();
  const dead = f.create('dead-android-owner', 'worktree-1', { metroPort: 8397 });
  f.registry.claimResources(dead, [
    { type: 'source', key: 'worktree-1' },
    { type: 'metro-port', key: '8397' },
    { type: 'device', key: 'android:USB-EXACT' },
  ]);
  const reverse = {
    platform: 'android' as const,
    deviceId: 'USB-EXACT',
    metroPort: 8397,
    local: 'tcp:8397',
    remote: 'tcp:8397',
  };
  f.registry.updateBindings(dead, {
    state: 'device_claimed',
    bindings: {
      device: { platform: 'android', deviceId: 'USB-EXACT', appId: 'dev.example' },
      androidMetroReverse: reverse,
    },
  });
  f.ownerStates.set('dead-android-owner', 'mismatch');
  const calls: unknown[] = [];

  const outcome = await runStartupOwnerCleanup(cleanupInput(f), {
    removeAndroidMetroReverse: (binding) => calls.push(binding),
  });

  assert.equal(outcome.status, 'clean');
  assert.deepEqual(calls, [
    { ...reverse, claimKey: 'android:USB-EXACT', stopRequestedAt: f.now(), completedAt: null },
  ]);
  const terminal = f.registry.getSessionStatus('dead-android-owner');
  assert.equal(terminal?.state, 'released');
  const journal = terminal?.bindings.startupCleanup as
    | { obligations?: { androidMetroReverse?: { completedAt?: unknown } } }
    | undefined;
  assert.equal(journal?.obligations?.androidMetroReverse?.completedAt, f.now());
});

test('L4: the cleanup journal is written on the dead row before any side effect', () => {
  const f = deadSameRootOwner();

  const plan = f.registry.beginStartupOwnerCleanup(f.dead);

  assert.equal(plan.resumed, false);
  const journal = journalOf(f.registry, 'dead-owner');
  assert.ok(journal, 'the journal is durable on the dead session row');
  assert.equal(typeof journal?.journaledAt, 'number');
  for (const resource of ['recorder', 'runner', 'observe', 'metro'] as const) {
    const entry = journal?.obligations?.[resource];
    assert.ok(entry, `${resource} obligation is journaled`);
    assert.equal(typeof entry?.stopRequestedAt, 'number', `${resource} write-before-effect`);
    assert.equal(entry?.completedAt, null);
  }
  assert.equal(journal?.obligations?.runner?.processBirth, 'runner-birth');
  assert.equal(journal?.obligations?.runner?.claimKey, 'ios:sim-1:9200');
  assert.equal(journal?.obligations?.recorder?.claimKey, 'ios:sim-1');
  assert.equal(journal?.obligations?.observe?.claimKey, '7400');
  assert.equal(journal?.obligations?.metro?.claimKey, '8300');
  assert.equal(journal?.integration?.manifestSha256, MANIFEST_SHA256);
  assert.equal(journal?.integration?.completedAt, null);

  // No effect yet: every claim and the session state are untouched.
  assert.equal(f.registry.getClaim('source', 'worktree-1')?.sessionId, 'dead-owner');
  assert.equal(f.registry.getClaim('runner', 'ios:sim-1:9200')?.sessionId, 'dead-owner');
  assert.equal(f.registry.getSessionStatus('dead-owner')?.state, 'device_claimed');
});

test('L4: a live owner refuses cleanup and never gets a journal', () => {
  const f = deadSameRootOwner();
  f.ownerStates.set('dead-owner', 'match');

  assert.throws(
    () => f.registry.beginStartupOwnerCleanup(f.dead),
    (error: { code?: string }) => error.code === 'RESOURCE_CLAIM_CONFLICT',
  );
  // Lease expiry is never authority over a live owner.
  f.advance(LEASE_MS + 60_000);
  assert.throws(
    () => f.registry.beginStartupOwnerCleanup(f.dead),
    (error: { code?: string }) => error.code === 'RESOURCE_CLAIM_CONFLICT',
  );
  assert.equal(journalOf(f.registry, 'dead-owner'), undefined);
  assert.equal(f.registry.getClaim('source', 'worktree-1')?.sessionId, 'dead-owner');
});

test('L4: an owner whose death is unknown refuses cleanup even past its lease', () => {
  const f = deadSameRootOwner();
  f.ownerStates.set('dead-owner', 'unknown');

  assert.throws(
    () => f.registry.beginStartupOwnerCleanup(f.dead),
    (error: { code?: string }) => error.code === 'RESOURCE_CLAIM_CONFLICT',
  );
  f.advance(LEASE_MS + 1);
  assert.throws(
    () => f.registry.beginStartupOwnerCleanup(f.dead),
    (error: { code?: string }) => error.code === 'STALE_LEASE_NOT_RECLAIMABLE',
    'an expired lease with unproven identity is a typed refusal, not authority',
  );
  assert.equal(journalOf(f.registry, 'dead-owner'), undefined);
});

test('L4: an owner that revives after journaling refuses at execution and keeps everything', () => {
  const f = deadSameRootOwner();
  f.registry.beginStartupOwnerCleanup(f.dead);
  f.ownerStates.set('dead-owner', 'match');

  assert.throws(
    () => f.registry.verifyStartupOwnerObligation(f.dead, 'recorder'),
    (error: { code?: string }) => error.code === 'RESOURCE_CLAIM_CONFLICT',
    'death is re-proven before every obligation effect',
  );
  assert.throws(
    () => f.registry.completeStartupOwnerObligation(f.dead, 'recorder'),
    (error: { code?: string }) => error.code === 'RESOURCE_CLAIM_CONFLICT',
  );
  assert.throws(
    () => f.registry.finishStartupOwnerCleanup(f.dead),
    (error: { code?: string }) => error.code === 'RESOURCE_CLAIM_CONFLICT',
  );
  assert.equal(f.registry.getClaim('runner', 'ios:sim-1:9200')?.sessionId, 'dead-owner');
  assert.equal(f.registry.getSessionStatus('dead-owner')?.state, 'device_claimed');
});

test('L4: cleanup methods reject a changed claim epoch', () => {
  const f = deadSameRootOwner();
  const staleRef = { sessionId: f.dead.sessionId, claimEpoch: f.dead.claimEpoch + 1 };

  assert.throws(
    () => f.registry.beginStartupOwnerCleanup(staleRef),
    (error: { code?: string }) => error.code === 'SESSION_OWNER_LOST',
  );

  f.registry.beginStartupOwnerCleanup(f.dead);
  assert.throws(
    () => f.registry.completeStartupOwnerObligation(staleRef, 'recorder'),
    (error: { code?: string }) => error.code === 'SESSION_OWNER_LOST',
  );
  assert.throws(
    () => f.registry.finishStartupOwnerCleanup(staleRef),
    (error: { code?: string }) => error.code === 'SESSION_OWNER_LOST',
  );
});

test('L4: claims release only after every obligation is durably complete', () => {
  const f = deadSameRootOwner();
  f.registry.beginStartupOwnerCleanup(f.dead);
  f.registry.completeStartupOwnerObligation(f.dead, 'recorder');
  f.registry.completeStartupOwnerObligation(f.dead, 'runner');

  assert.throws(
    () => f.registry.finishStartupOwnerCleanup(f.dead),
    (error: { code?: string }) => error.code === 'AUTOMATION_CLEANUP_UNPROVEN',
    'observe is still unproven',
  );
  f.registry.completeStartupOwnerObligation(f.dead, 'observe');
  assert.throws(
    () => f.registry.finishStartupOwnerCleanup(f.dead),
    (error: { code?: string }) => error.code === 'METRO_CLEANUP_PENDING',
    'metro is still unproven',
  );
  f.registry.completeStartupOwnerObligation(f.dead, 'metro');
  assert.throws(
    () => f.registry.finishStartupOwnerCleanup(f.dead),
    (error: { code?: string }) => error.code === 'SESSION_AUTHORITY_REQUIRED',
    'package integration must be restored before release',
  );
  assert.equal(f.registry.getClaim('source', 'worktree-1')?.sessionId, 'dead-owner');

  f.registry.completeStartupOwnerIntegrationRestore(f.dead, { manifestSha256: MANIFEST_SHA256 });
  f.registry.finishStartupOwnerCleanup(f.dead);

  assert.equal(f.registry.getSessionStatus('dead-owner')?.state, 'released');
  assert.equal(f.registry.getClaim('source', 'worktree-1'), null);
  assert.equal(f.registry.getClaim('metro-port', '8300'), null);
  assert.equal(f.registry.getClaim('runner', 'ios:sim-1:9200'), null);
  assert.equal(f.registry.getClaim('device', 'ios:sim-1'), null);
  assert.equal(typeof journalOf(f.registry, 'dead-owner')?.finishedAt, 'number');
});

test('L4: a crash at any obligation boundary resumes the same journal idempotently', () => {
  const f = deadSameRootOwner();
  const first = f.registry.beginStartupOwnerCleanup(f.dead);
  const journaledAt = journalOf(f.registry, 'dead-owner')?.journaledAt;

  // Crash right after journaling: a fresh begin resumes, never re-journals.
  const resumedEarly = f.registry.beginStartupOwnerCleanup(f.dead);
  assert.equal(resumedEarly.resumed, true);
  assert.equal(journalOf(f.registry, 'dead-owner')?.journaledAt, journaledAt);
  assert.equal(
    journalOf(f.registry, 'dead-owner')?.obligations?.recorder?.stopRequestedAt,
    first.obligations.recorder?.stopRequestedAt,
  );

  // Crash after one completed obligation.
  f.registry.completeStartupOwnerObligation(f.dead, 'recorder');
  f.advance(10_000);
  const resumedMid = f.registry.beginStartupOwnerCleanup(f.dead);
  assert.equal(resumedMid.resumed, true);
  assert.equal(typeof resumedMid.obligations.recorder?.completedAt, 'number');
  assert.equal(resumedMid.obligations.runner?.completedAt, null);
  // Completing an already-complete obligation is a no-op, not an error.
  const completedAt = resumedMid.obligations.recorder?.completedAt;
  f.registry.completeStartupOwnerObligation(f.dead, 'recorder');
  assert.equal(
    journalOf(f.registry, 'dead-owner')?.obligations?.recorder?.completedAt,
    completedAt,
  );

  // Crash after all obligations but before finish: resume still finishes.
  f.registry.completeStartupOwnerObligation(f.dead, 'runner');
  f.registry.completeStartupOwnerObligation(f.dead, 'observe');
  f.registry.completeStartupOwnerObligation(f.dead, 'metro');
  f.registry.completeStartupOwnerIntegrationRestore(f.dead, { manifestSha256: MANIFEST_SHA256 });
  assert.equal(f.registry.getClaim('source', 'worktree-1')?.sessionId, 'dead-owner');
  const resumedLate = f.registry.beginStartupOwnerCleanup(f.dead);
  assert.equal(resumedLate.resumed, true);
  f.registry.finishStartupOwnerCleanup(f.dead);
  assert.equal(f.registry.getSessionStatus('dead-owner')?.state, 'released');
});

test('L4: a dead adopter mid-cleanup folds its legacy journal obligations', () => {
  const f = fixture();
  const dead = f.create('dead-adopter', 'worktree-1', { metroPort: 8300, observePort: 7400 });
  f.registry.claimResources(dead, [
    { type: 'source', key: 'worktree-1' },
    { type: 'runner', key: 'ios:sim-1:9200' },
    { type: 'recorder', key: 'ios:sim-1' },
  ]);
  f.registry.updateBindings(dead, {
    state: 'source_bound',
    bindings: {
      handoffCleanup: {
        metro: null,
        observe: null,
        runner: {
          platform: 'ios',
          deviceId: 'sim-1',
          port: 9200,
          capability: 'cap',
          instanceId: 'runner-instance',
          processBirth: 'runner-birth',
          claimKey: 'ios:sim-1:9200',
          stopRequestedAt: 999,
          completedAt: null,
        },
        recorder: {
          platform: 'ios',
          deviceId: 'sim-1',
          scope: 'device',
          processBirth: 'rec-birth',
          claimKey: 'ios:sim-1',
          stopRequestedAt: 999,
          completedAt: 1_000,
        },
      },
    },
  });
  f.ownerStates.set('dead-adopter', 'mismatch');

  const plan = f.registry.beginStartupOwnerCleanup(dead);

  assert.equal(typeof plan.obligations.recorder?.completedAt, 'number', 'completed work is kept');
  assert.equal(plan.obligations.runner?.completedAt, null, 'pending legacy work is folded in');
  assert.equal(plan.obligations.runner?.processBirth, 'runner-birth');
  f.registry.completeStartupOwnerObligation(dead, 'runner');
  f.registry.finishStartupOwnerCleanup(dead);
  assert.equal(f.registry.getSessionStatus('dead-adopter')?.state, 'released');
  assert.equal(f.registry.getClaim('runner', 'ios:sim-1:9200'), null);
});

test('L4: the executor cleans a dead same-root owner end to end with exact identities', async () => {
  const f = deadSameRootOwner();
  const calls: string[] = [];
  const deps = {
    ...executorDeps(f, calls),
    stopBoundRecorder: async (binding: Record<string, unknown>) => {
      assert.equal(
        typeof journalOf(f.registry, 'dead-owner')?.obligations?.recorder?.stopRequestedAt,
        'number',
        'the obligation is durably journaled before its effect runs',
      );
      calls.push(`recorder:${String(binding.processBirth)}`);
      return '';
    },
  };

  const outcome = await runStartupOwnerCleanup(cleanupInput(f), deps);

  assert.equal(outcome.status, 'clean');
  assert.deepEqual(outcome.released, ['dead-owner']);
  assert.deepEqual(calls, [
    'recorder:rec-birth',
    'runner:runner-birth',
    'observe:observe-birth',
    'metro:metro-instance:dead-signer-capability',
    `integration:${MANIFEST_SHA256.slice(0, 8)}`,
  ]);
  assert.equal(f.registry.getSessionStatus('dead-owner')?.state, 'released');
  assert.equal(f.registry.getClaim('source', 'worktree-1'), null);
  assert.equal(f.registry.getSessionStatus('dead-owner')?.bindings.packageIntegration, null);
});

test('L4: the executor is a no-op when nothing conflicts', async () => {
  const f = fixture();
  const outcome = await runStartupOwnerCleanup(cleanupInput(f), executorDeps(f, []));
  assert.deepEqual(outcome, { status: 'clean', released: [], discardedContenders: [] });
});

test('L4: startup cleanup never selects another app root in the same worktree', async () => {
  const f = fixture();
  const otherAppOwner = f.create(
    'other-app-owner',
    'worktree-1',
    {},
    {},
    { appRootKey: 'apps/other' },
  );
  f.registry.claimResources(otherAppOwner, [{ type: 'source', key: 'worktree-1' }]);
  f.ownerStates.set('other-app-owner', 'mismatch');
  const calls: string[] = [];

  const outcome = await runStartupOwnerCleanup(cleanupInput(f), executorDeps(f, calls));

  assert.deepEqual(outcome, { status: 'clean', released: [], discardedContenders: [] });
  assert.deepEqual(calls, []);
  assert.equal(f.registry.getClaim('source', 'worktree-1')?.sessionId, 'other-app-owner');
  assert.equal(journalOf(f.registry, 'other-app-owner'), undefined);
});

test('L4: the executor refuses a live owner without touching it', async () => {
  const f = deadSameRootOwner();
  f.ownerStates.set('dead-owner', 'match');
  const calls: string[] = [];

  const outcome = await runStartupOwnerCleanup(cleanupInput(f), executorDeps(f, calls));

  assert.equal(outcome.status, 'refused');
  assert.equal(outcome.refusal?.code, 'RESOURCE_CLAIM_CONFLICT');
  assert.deepEqual(calls, []);
  assert.equal(f.registry.getClaim('source', 'worktree-1')?.sessionId, 'dead-owner');
  assert.equal(journalOf(f.registry, 'dead-owner'), undefined);
});

test('L4: a failed obligation leaves a resumable journal and a typed refusal', async () => {
  const f = deadSameRootOwner();
  const calls: string[] = [];
  const failing = {
    ...executorDeps(f, calls),
    stopBoundRunner: async () => {
      throw Object.assign(
        new Error('RUNNER_ADOPTION_REQUIRED: runner process identity is unavailable'),
        {
          code: 'RUNNER_ADOPTION_REQUIRED',
        },
      );
    },
  };

  const first = await runStartupOwnerCleanup(cleanupInput(f), failing);
  assert.equal(first.status, 'refused');
  assert.equal(first.refusal?.code, 'RUNNER_ADOPTION_REQUIRED');
  assert.equal(
    typeof journalOf(f.registry, 'dead-owner')?.obligations?.recorder?.completedAt,
    'number',
  );
  assert.equal(journalOf(f.registry, 'dead-owner')?.obligations?.runner?.completedAt, null);
  assert.equal(f.registry.getClaim('source', 'worktree-1')?.sessionId, 'dead-owner');

  const resumeCalls: string[] = [];
  const second = await runStartupOwnerCleanup(cleanupInput(f), executorDeps(f, resumeCalls));
  assert.equal(second.status, 'clean');
  assert.equal(
    resumeCalls.some((call) => call.startsWith('recorder:')),
    false,
    'a completed obligation is never re-run on resume',
  );
  assert.equal(f.registry.getSessionStatus('dead-owner')?.state, 'released');
});

test('L4: an unproven managed-Metro stop refuses with the pending cleanup code', async () => {
  const f = deadSameRootOwner();
  const calls: string[] = [];
  const deps = {
    ...executorDeps(f, calls),
    stopManagedMetro: async () => false,
  };

  const outcome = await runStartupOwnerCleanup(cleanupInput(f), deps);

  assert.equal(outcome.status, 'refused');
  assert.equal(outcome.refusal?.code, 'METRO_CLEANUP_PENDING');
  assert.equal(journalOf(f.registry, 'dead-owner')?.obligations?.metro?.completedAt, null);
  assert.equal(f.registry.getSessionStatus('dead-owner')?.state, 'device_claimed');
});

test('L4: integration restore refuses without a SHA-256-verified manifest', async () => {
  const f = deadSameRootOwner({
    integration: {
      version: 1,
      installedBySessionId: 'dead-owner',
      manifestSha256: MANIFEST_SHA256,
      manifestSource: '{"tampered":true}',
    },
  });
  const calls: string[] = [];

  const outcome = await runStartupOwnerCleanup(cleanupInput(f), executorDeps(f, calls));

  assert.equal(outcome.status, 'refused');
  assert.equal(outcome.refusal?.code, 'SESSION_AUTHORITY_REQUIRED');
  assert.match(String(outcome.refusal?.nextAction ?? ''), /manifest/i);
  assert.equal(
    calls.some((call) => call.startsWith('integration:')),
    false,
    'no restore runs without a verified manifest',
  );
  assert.ok(
    f.registry.getSessionStatus('dead-owner')?.bindings.packageIntegration,
    'the binding is preserved under the refusal fence',
  );
  assert.equal(f.registry.getClaim('source', 'worktree-1')?.sessionId, 'dead-owner');
  assert.equal(f.registry.getSessionStatus('dead-owner')?.state, 'device_claimed');
});

test('L4: integration restore re-proves owner death immediately before its effect', async () => {
  const f = deadSameRootOwner();
  f.registry.beginStartupOwnerCleanup(f.dead);
  for (const resource of ['recorder', 'runner', 'observe', 'metro'] as const) {
    f.registry.completeStartupOwnerObligation(f.dead, resource);
  }
  f.ownerStates.set('dead-owner', 'match');
  const calls: string[] = [];

  const outcome = await runStartupOwnerCleanup(cleanupInput(f), executorDeps(f, calls));

  assert.equal(outcome.status, 'refused');
  assert.equal(outcome.refusal?.code, 'RESOURCE_CLAIM_CONFLICT');
  assert.deepEqual(calls, []);
  assert.ok(f.registry.getSessionStatus('dead-owner')?.bindings.packageIntegration);
  assert.equal(f.registry.getClaim('source', 'worktree-1')?.sessionId, 'dead-owner');
});

test('L4: refusals and journals never leak device identities, tokens, or capabilities', async () => {
  const f = deadSameRootOwner();
  const outcome = await runStartupOwnerCleanup(cleanupInput(f), {
    ...executorDeps(f, []),
    stopBoundRunner: async () => {
      throw Object.assign(new Error('runner stop failed'), { code: 'RUNNER_ADOPTION_REQUIRED' });
    },
  });

  const surfaced = JSON.stringify(outcome);
  assert.equal(outcome.status, 'refused');
  for (const secret of [
    'sim-1',
    'runner-capability-secret',
    'observe-cleanup-secret',
    'dead-signer-capability',
  ]) {
    assert.equal(surfaced.includes(secret), false, `refusal must not leak ${secret}`);
  }
});

test('L4: unexpected startup cleanup failures use one fixed redacted line', () => {
  const line = startupCleanupFailureMessage();
  assert.equal(line, 'rn-dev-agent startup cleanup failed: STARTUP_CLEANUP_FAILED\n');
  assert.doesNotMatch(line, /[/\\]|registry|sqlite|session/i);
});

test('L4: createSupervisorAuthority stamps new sessions as grouped-v1', () => {
  const f = fixture();
  const stateDir = join(f.root, 'state');
  const authority = createSupervisorAuthority({
    stateDir,
    source: {
      kind: 'git',
      sourceKey: 'repo',
      worktreeKey: 'worktree-l4',
      appRootKey: '.',
      appRoot: join(f.root, 'app'),
      contentRoot: join(f.root, 'app'),
    },
    supervisorBirth: { pid: process.pid, token: 'supervisor-birth' },
    uid: 'test-uid',
    startHeartbeat: false,
    ownerStatus: () => 'match',
  });
  try {
    const status = authority.registry.getSessionStatus(authority.session.sessionId);
    assert.equal(status?.source.model, 'grouped-v1');
  } finally {
    void authority.close();
  }
});

/** A grouped-v1 contender blocked on a same-root owner, with a bound recovery worker. */
function groupedContender(
  identities: {
    owner?: { sourceKey?: string; appRootKey?: string };
    contender?: { sourceKey?: string; appRootKey?: string };
  } = {},
) {
  const f = fixture();
  const owner = f.create(
    'owner',
    'worktree-1',
    { metroPort: 8248, observePort: 7396 },
    {},
    identities.owner,
  );
  f.registry.claimResources(owner, [
    { type: 'source', key: 'worktree-1' },
    { type: 'metro-port', key: '8248' },
  ]);
  const contender = f.create(
    'contender',
    'worktree-1',
    { metroPort: 8248, observePort: 7396 },
    { model: 'grouped-v1' },
    identities.contender,
  );
  f.registry.updateBindings(contender, {
    state: 'blocked',
    bindings: {
      recoveryCapabilityHash: createHash('sha256').update(RECOVERY_CAPABILITY).digest('hex'),
      adoptionRequired: { sessionId: owner.sessionId, claimEpoch: owner.claimEpoch },
    },
  });
  f.registry.bindRecoveryWorker(
    contender,
    { instanceId: 'recovery-worker', pid: 9001, token: 'recovery-birth' },
    RECOVERY_CAPABILITY,
  );
  return { ...f, owner, contender };
}

test('L4: a grouped-v1 blocked contender mints no adoption or handoff-recipient handles', () => {
  const f = groupedContender();

  const handles = f.registry.getSessionStatus('contender')?.bindings.recoveryHandles;
  assert.equal(handles, undefined, 'grouped sessions never mint recovery handles');
  assert.equal(
    f.registry.refreshRecoveryHandles(
      f.contender,
      { instanceId: 'recovery-worker' },
      RECOVERY_CAPABILITY,
    ),
    false,
    'there is nothing to rotate',
  );

  const status = f.registry.getSessionStatus('contender');
  assert.ok(status);
  const projected = projectPublicAuthorityStatus(
    { available: true, ...status },
    {
      now: f.now,
      recoveryRequirement: f.registry.inspectRecoveryRequirement('contender'),
    },
  ) as Record<string, Record<string, unknown> | undefined>;
  assert.equal(projected.recovery, undefined, 'status advertises no handle surface');
});

test('L4: grouped recovery guidance names startup cleanup for a dead owner, never adopt_stale', () => {
  const f = groupedContender();

  f.ownerStates.set('owner', 'match');
  const live = f.registry.inspectRecoveryRequirement('contender');
  assert.equal(live.requirement, 'attach');
  assert.equal(live.priorOwner, 'live');
  assert.equal(typeof live.priorOwnerHeartbeatAgeMs, 'number', 'issue-654 heartbeat diagnostics');
  assert.match(live.nextAction, /close|separate worktree/i);

  f.ownerStates.set('owner', 'unknown');
  const unknown = f.registry.inspectRecoveryRequirement('contender');
  assert.equal(unknown.requirement, 'attach');
  assert.equal(unknown.priorOwner, 'unknown');

  f.ownerStates.set('owner', 'mismatch');
  const dead = f.registry.inspectRecoveryRequirement('contender');
  assert.equal(dead.requirement, 'transport-restart');
  assert.equal(dead.priorOwner, 'stale');
  assert.match(dead.nextAction, /session-doctor\.js" repair/);
  assert.match(dead.nextAction, /\/mcp/);
  assert.doesNotMatch(dead.nextAction, /adopt_stale/);
});

test('L4: grouped recovery refuses restart cleanup across app roots', () => {
  const f = groupedContender({ owner: { appRootKey: 'apps/other' } });
  f.ownerStates.set('owner', 'mismatch');

  const requirement = f.registry.inspectRecoveryRequirement('contender');

  assert.equal(requirement.requirement, 'attach');
  assert.equal(requirement.priorOwner, 'stale');
  assert.equal(requirement.priorOwnerHeartbeatAgeMs, undefined);
  assert.match(requirement.nextAction, /different app root/i);
  assert.match(requirement.nextAction, /prior owner's app root|separate worktree/i);
  assert.doesNotMatch(requirement.nextAction, /startup cleanup releases it automatically/i);
});

test('L4: grouped recovery distinguishes declared-manifest source drift', () => {
  const f = groupedContender({ owner: { sourceKey: 'prior-declared-source' } });
  f.ownerStates.set('owner', 'mismatch');

  const requirement = f.registry.inspectRecoveryRequirement('contender');

  assert.equal(requirement.requirement, 'attach');
  assert.equal(requirement.priorOwner, 'stale');
  assert.equal(requirement.priorOwnerHeartbeatAgeMs, undefined);
  assert.match(requirement.nextAction, /different source identity/i);
  assert.match(requirement.nextAction, /restore the declared manifests/i);
  assert.match(requirement.nextAction, /separate worktree/i);
  assert.doesNotMatch(requirement.nextAction, /different app root/i);
  assert.doesNotMatch(requirement.nextAction, /startup cleanup releases it automatically/i);
});

test('L4: grouped adopt_stale refuses before requiring an unminted handle', async () => {
  const f = groupedContender();
  f.ownerStates.set('owner', 'mismatch');
  const runtime = new WorkerAuthorityRuntime(
    f.registry,
    f.contender,
    null,
    true,
    RECOVERY_CAPABILITY,
  );
  const handler = createSessionHandler(runtime as never, { now: f.now });

  const result = await handler({ action: 'adopt_stale' });

  assert.equal(result.isError, true);
  const body = JSON.parse(result.content[0]!.text) as {
    code?: string;
    meta?: { nextAction?: string };
  };
  assert.equal(body.code, 'HANDOFF_NOT_AUTHORIZED');
  assert.match(String(body.meta?.nextAction ?? ''), /startup|restart/i);
  assert.equal(f.registry.getSessionStatus('contender')?.state, 'blocked');
  assert.equal(f.registry.getClaim('source', 'worktree-1')?.sessionId, 'owner');
});

test('L4: a legacy contender without the model marker keeps the adoption surface', () => {
  const f = fixture();
  const owner = f.create('owner', 'worktree-1', { metroPort: 8248, observePort: 7396 });
  f.registry.claimResources(owner, [{ type: 'source', key: 'worktree-1' }]);
  const legacy = f.create('legacy', 'worktree-1', { metroPort: 8248, observePort: 7396 });
  f.registry.updateBindings(legacy, {
    state: 'blocked',
    bindings: {
      recoveryCapabilityHash: createHash('sha256').update(RECOVERY_CAPABILITY).digest('hex'),
      adoptionRequired: { sessionId: owner.sessionId, claimEpoch: owner.claimEpoch },
    },
  });
  f.registry.bindRecoveryWorker(
    legacy,
    { instanceId: 'legacy-worker', pid: 9002, token: 'legacy-birth' },
    RECOVERY_CAPABILITY,
  );

  const handles = f.registry.getSessionStatus('legacy')?.bindings.recoveryHandles as
    | { adoptStale?: { token?: string }; handoffRecipient?: { token?: string } }
    | undefined;
  assert.ok(handles?.adoptStale?.token, 'legacy sessions still mint the adoption handle');
  assert.ok(handles?.handoffRecipient?.token);

  f.ownerStates.set('owner', 'mismatch');
  const requirement = f.registry.inspectRecoveryRequirement('legacy');
  assert.equal(requirement.requirement, 'adoption');
  assert.match(requirement.nextAction, /adopt_stale/);
});
