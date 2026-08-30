import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'node:test';
import { createAuthorityGate } from '../../../dist/session/authority-gate.js';
import { openSessionRegistry, SessionAuthorityError } from '../../../dist/session/registry.js';
import { sessionRecoveryRemedy } from '../../../dist/session/recovery-remedy.js';
import { projectPublicAuthorityStatus } from '../../../dist/session/public-status.js';
import { runStartupOwnerCleanup } from '../../../dist/session/startup-cleanup.js';
import { WorkerAuthorityRuntime } from '../../../dist/session/runtime.js';
import { createSessionHandler } from '../../../dist/tools/session.js';

const CORE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const RECOVERY_CAPABILITY = 'recovery-capability';
const RECOVERY_WORKER = 'recovery-worker';
const MANIFEST_SOURCE = '{"version":1,"dependencies":{},"scripts":{}}';
const MANIFEST_SHA256 = createHash('sha256').update(MANIFEST_SOURCE).digest('hex');
const UNVERIFIABLE_SHA256 = createHash('sha256').update('never-written-bytes').digest('hex');
const AUTOMATIC_RELEASE_PROMISE = sessionRecoveryRemedy(
  'The prior owner is proven dead and is released automatically.',
);
const ONLY_AVAILABLE_ACTION =
  'this session does not own this worktree; rn_session({ action: "status" }) is the only available action';

/**
 * Every `rn_session` action, with arguments valid enough that argument validation
 * can never stand in for the ownership refusal. `recovery` marks the two actions
 * routed through `requireRecovery` rather than `requireOperational`.
 */
const SESSION_ACTIONS: readonly {
  action: string;
  args?: Record<string, unknown>;
  recovery?: true;
}[] = [
  { action: 'status' },
  { action: 'preview_integration' },
  { action: 'apply_integration' },
  { action: 'restore_integration' },
  {
    action: 'accept_handoff',
    args: { handoffId: 'handoff-1', token: 'handoff-token' },
    recovery: true,
  },
  { action: 'adopt_stale', args: { adoptionHandle: 'adoption-handle' }, recovery: true },
  {
    action: 'release_stale_device',
    args: { platform: 'ios', deviceId: 'sim-1', releaseHandle: 'release-handle' },
  },
  { action: 'bind_device', args: { platform: 'ios', deviceId: 'sim-1', appId: 'com.example.app' } },
  {
    action: 'bind_metro',
    args: {
      mode: 'external',
      metroPort: 8300,
      metroPid: 8301,
      metroInstanceId: 'metro-instance',
      buildGeneration: 1,
    },
  },
  { action: 'pin_dev_client', args: { force: false } },
  { action: 'prepare_handoff', args: { targetHandle: 'target-handle', ttlMs: 60_000 } },
  { action: 'cancel_handoff', args: { handoffId: 'handoff-1' } },
  { action: 'recover_arbiter', args: { confirmed: true } },
  { action: 'stop_metro' },
  { action: 'release' },
];

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

type Fixture = ReturnType<typeof fixture>;
type OwnerLiveness = 'mismatch' | 'match' | 'unknown';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'rn-new-session-recovery-'));
  roots.push(root);
  let now = 1_000_000;
  const ownerStates = new Map<string, string>();
  const registry = openSessionRegistry(join(root, 'registry.sqlite3'), {
    now: () => now,
    ownerStatus: (owner: { sessionId: string }) => ownerStates.get(owner.sessionId) ?? 'unknown',
    listenerStatus: () => 'absent',
    leaseMs: 30_000,
  });
  const create = (
    sessionId: string,
    bindings: Record<string, unknown> = {},
    source: Record<string, unknown> = {},
  ) => {
    ownerStates.set(sessionId, 'match');
    return registry.createSession({
      sessionId,
      sourceKey: 'repo',
      worktreeKey: 'worktree-1',
      appRootKey: '.',
      supervisor: { pid: 4000 + ownerStates.size, token: `birth-${sessionId}` },
      source: { kind: 'git', contentRoot: '/src/worktree-1', ...source },
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

/** A dead same-root owner with the four cleanup obligations plus package integration. */
function deadOwner(f: Fixture, integration: Record<string, unknown> | null) {
  const owner = f.create('prior-owner', { metroPort: 8300, observePort: 7400 });
  f.registry.claimResources(owner, [
    { type: 'source', key: 'worktree-1' },
    { type: 'metro-port', key: '8300' },
    { type: 'observe-port', key: '7400' },
    { type: 'device', key: 'ios:sim-1' },
    { type: 'runner', key: 'ios:sim-1:9200' },
    { type: 'recorder', key: 'ios:sim-1' },
  ]);
  f.registry.updateBindings(owner, {
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
  return owner;
}

/** A blocked contender fenced behind `owner`, `grouped-v1` unless told otherwise. */
function blockedContender(
  f: Fixture,
  owner: { sessionId: string; claimEpoch: number },
  model = 'grouped-v1',
) {
  const contender = f.create(
    'contender',
    { metroPort: 8300, observePort: 7400 },
    model ? { model } : {},
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
    { instanceId: RECOVERY_WORKER, pid: 9001, token: 'recovery-birth' },
    RECOVERY_CAPABILITY,
  );
  return contender;
}

/** Owner + contender in one call; `liveness` is the only variable between paths. */
function contenderFacing(
  liveness: OwnerLiveness,
  options: { model?: string; integration?: Record<string, unknown> | null } = {},
) {
  const f = fixture();
  const owner = deadOwner(
    f,
    options.integration === undefined
      ? {
          version: 1,
          installedBySessionId: 'prior-owner',
          manifestSha256: MANIFEST_SHA256,
          manifestSource: MANIFEST_SOURCE,
        }
      : options.integration,
  );
  const contender = blockedContender(f, owner, options.model ?? 'grouped-v1');
  f.ownerStates.set('prior-owner', liveness);
  return { ...f, owner, contender };
}

function runtimeFor(f: Fixture, contender: { sessionId: string; claimEpoch: number }) {
  return new WorkerAuthorityRuntime(f.registry, contender, null, true, RECOVERY_CAPABILITY);
}

function envelope(result: unknown) {
  const payload = result as { content: { text: string }[] };
  return JSON.parse(payload.content[0].text) as {
    ok: boolean;
    code?: string;
    error?: string;
    data?: Record<string, unknown>;
    meta?: Record<string, unknown>;
  };
}

function gatedRefusal(runtime: WorkerAuthorityRuntime, tool: string) {
  const gate = createAuthorityGate(runtime as never, {
    probe: async ({ axis }: { axis: string }) => ({ axis, identity: `${axis}-stable` }),
  });
  const wrapped = gate.wrap(tool, (async () => {
    throw new Error(`${tool} handler must never run for a blocked contender`);
  }) as never) as (args: Record<string, unknown>) => Promise<unknown>;
  return wrapped;
}

function statusOf(f: Fixture, sessionId: string) {
  const status = f.registry.getSessionStatus(sessionId);
  assert.ok(status);
  return projectPublicAuthorityStatus(
    { available: true, ...status },
    { now: f.now, recoveryRequirement: f.registry.inspectRecoveryRequirement(sessionId) },
  ) as Record<string, unknown>;
}

function cleanupInput(f: Fixture) {
  return {
    registry: f.registry,
    sourceKey: 'repo',
    worktreeKey: 'worktree-1',
    appRootKey: '.',
    appRoot: join(f.root, 'app'),
  };
}

function executorDeps() {
  return {
    stopBoundRecorder: async () => '',
    stopBoundRunner: async () => {},
    stopBoundObserve: async () => {},
    stopManagedMetro: async () => true,
    restoreIntegrationFiles: () => {},
    readSessionSecret: () => ({ signerCapability: 'dead-signer-capability' }),
  };
}

function ownerSnapshot(f: Fixture) {
  const status = f.registry.getSessionStatus('prior-owner');
  return JSON.stringify({
    state: status?.state,
    authorityVersion: status?.authorityVersion,
    claimEpoch: status?.claimEpoch,
    bindings: status?.bindings,
    sourceClaim: f.registry.getClaim('source', 'worktree-1'),
    deviceClaim: f.registry.getClaim('device', 'ios:sim-1'),
  });
}

test('R1: a gated-tool refusal carries the session’s own recovery requirement', async () => {
  for (const liveness of ['mismatch', 'match', 'unknown'] as const) {
    const f = contenderFacing(liveness);
    const runtime = runtimeFor(f, f.contender);
    const expected = f.registry.inspectRecoveryRequirement('contender');
    assert.notEqual(expected.nextAction, '', `${liveness}: the requirement is measurable`);

    for (const tool of ['maestro_run', 'cdp_run_action']) {
      const result = envelope(
        await gatedRefusal(runtime, tool)({ flowPath: 'flow.yaml', platform: 'ios' }),
      );
      assert.equal(result.ok, false, `${liveness}/${tool} refuses`);
      assert.equal(result.code, 'SESSION_AUTHORITY_REQUIRED');
      assert.equal(
        result.meta?.nextAction,
        expected.nextAction,
        `${liveness}/${tool} names the measured remedy`,
      );
      assert.equal(result.meta?.axis, 'C', 'the refused axis is unchanged');
      assert.equal(
        result.error,
        `SESSION_AUTHORITY_REQUIRED: ${ONLY_AVAILABLE_ACTION}`,
        `${liveness}/${tool} shares the one tool-agnostic refusal`,
      );
    }
  }
});

test('R2: the refusal never names an action the blocked contender cannot reach', async () => {
  const f = contenderFacing('mismatch');
  const runtime = runtimeFor(f, f.contender);
  const handler = createSessionHandler(runtime as never, { now: f.now });

  const before = ownerSnapshot(f);
  const reachable = new Set<string>();
  for (const { action, args, recovery } of SESSION_ACTIONS) {
    const result = envelope(await handler({ action, ...args } as never));
    if (result.ok) {
      reachable.add(action);
      continue;
    }
    // Operational actions must be stopped by ownership itself, never by argument
    // validation — that is what makes this table an invariant lock.
    if (action !== 'status' && !recovery) {
      assert.equal(
        result.code,
        'SESSION_AUTHORITY_REQUIRED',
        `${action} must refuse on ownership, not on arguments`,
      );
    }
  }
  assert.deepEqual([...reachable], ['status'], 'exactly one rn_session action is reachable');
  assert.equal(
    ownerSnapshot(f),
    before,
    'no attempted action mutates owner state, claims, or the authority version',
  );

  const refusal = envelope(await gatedRefusal(runtime, 'maestro_run')({ platform: 'ios' }));
  const message = String(refusal.error);
  for (const { action } of SESSION_ACTIONS) {
    if (reachable.has(action)) continue;
    assert.doesNotMatch(message, new RegExp(action), `refusal must not name ${action}`);
  }
  assert.match(message, /status/, 'the refusal names the one reachable action');
});

test('R3: a blocked contender always retains exactly one exit', async () => {
  for (const model of ['grouped-v1', '']) {
    for (const liveness of ['mismatch', 'match', 'unknown'] as const) {
      const f = contenderFacing(liveness, { model });
      const runtime = runtimeFor(f, f.contender);
      const handler = createSessionHandler(runtime as never, { now: f.now });
      const result = envelope(await handler({ action: 'status' }));
      assert.equal(result.ok, true, `${model || 'axes-v1'}/${liveness}: status stays reachable`);
      const authority = result.data?.authority as { recoveryRequirement?: { nextAction?: string } };
      assert.notEqual(
        authority.recoveryRequirement?.nextAction,
        undefined,
        `${model || 'axes-v1'}/${liveness}: status names a remedy`,
      );
    }
  }
});

test('R4: a refused startup cleanup is legible, and identifier-free, in the contender status', async () => {
  const f = contenderFacing('mismatch', {
    integration: {
      version: 1,
      installedBySessionId: 'prior-owner',
      manifestSha256: UNVERIFIABLE_SHA256,
    },
  });

  const outcome = await runStartupOwnerCleanup(cleanupInput(f), executorDeps());
  assert.equal(outcome.status, 'refused');
  assert.equal(outcome.refusal?.code, 'SESSION_AUTHORITY_REQUIRED');

  const projected = statusOf(f, 'contender');
  const blocked = projected.startupCleanupBlocked as Record<string, string> | undefined;
  assert.ok(blocked, 'the retained refusal reaches public status');
  assert.equal(blocked.code, 'SESSION_AUTHORITY_REQUIRED');
  assert.match(blocked.reason, /SHA-256-verified manifest/);
  assert.match(blocked.nextAction, /rn-session-integration\.json/);

  const serialized = JSON.stringify(blocked);
  for (const identifier of [
    'prior-owner',
    'sim-1',
    'runner-capability-secret',
    'observe-cleanup-secret',
    'dead-signer-capability',
    UNVERIFIABLE_SHA256,
    f.root,
    '9911',
  ]) {
    assert.doesNotMatch(serialized, new RegExp(identifier), `projection must redact ${identifier}`);
  }
});

// ── R4b ─────────────────────────────────────────────────────────────────────
// Being a SessionAuthorityError is not evidence of redaction: a claim conflict renders
// `device:<udid> is held`, and process cleanup wraps the underlying adb/recorder message
// with its serials, PIDs, and paths. None of that may survive the outcome boundary.
test('R4b: a producer diagnostic never reaches the log, the journal, or public status', async () => {
  const leaks = [
    {
      code: 'RESOURCE_CLAIM_CONFLICT',
      message: 'device:00008130-001A2B3C4D5E is held',
      nextAction: 'Free device:00008130-001A2B3C4D5E, then retry.',
    },
    {
      code: 'AUTOMATION_CLEANUP_UNPROVEN',
      message:
        'adb -s emulator-5554 shell am force-stop failed: pid 44219 (/Users/dev/Library/Logs/x)',
      nextAction: 'Kill pid 44219 on emulator-5554 and clear /Users/dev/Library/Logs/x.',
    },
    {
      code: 'STARTUP_CLEANUP_FAILED',
      message: 'ENOENT: /Users/dev/.rn-agent/state/secret.json',
      nextAction: 'Recreate /Users/dev/.rn-agent/state/secret.json.',
    },
  ];

  for (const leak of leaks) {
    const f = contenderFacing('mismatch');
    const outcome = await runStartupOwnerCleanup(cleanupInput(f), {
      ...executorDeps(),
      stopBoundRunner: async () => {
        // A producer-authored remedy is exactly as untrusted as the reason.
        throw new SessionAuthorityError(leak.code, leak.message, undefined, {
          nextAction: leak.nextAction,
        });
      },
    });
    assert.equal(outcome.status, 'refused');
    assert.equal(outcome.refusal?.code, leak.code, 'the typed code survives verbatim');

    const projected = statusOf(f, 'contender');
    const surfaces = JSON.stringify([outcome.refusal, projected.startupCleanupBlocked]);
    for (const identifier of [
      '00008130-001A2B3C4D5E',
      'emulator-5554',
      '44219',
      '/Users/dev',
      'secret.json',
    ]) {
      assert.doesNotMatch(
        surfaces,
        new RegExp(identifier),
        `${leak.code} must not leak ${identifier}`,
      );
    }
    // A redacted refusal is still actionable, not a bare code.
    assert.match(String(outcome.refusal?.message), new RegExp(leak.code));
    // GH #792: the remedy names a command a headless client can actually run.
    assert.match(String(outcome.refusal?.nextAction), /session-doctor\.js" repair/);
    assert.match(
      String((projected.startupCleanupBlocked as Record<string, string>).nextAction),
      /session-doctor\.js" repair/,
    );
  }
});

test('R5: transport-restart is promised only where it converges', async () => {
  const refused = contenderFacing('mismatch', {
    integration: {
      version: 1,
      installedBySessionId: 'prior-owner',
      manifestSha256: UNVERIFIABLE_SHA256,
    },
  });
  await runStartupOwnerCleanup(cleanupInput(refused), executorDeps());
  const blockedRequirement = refused.registry.inspectRecoveryRequirement('contender');
  assert.equal(blockedRequirement.requirement, 'transport-restart');
  assert.equal(blockedRequirement.priorOwner, 'stale');
  assert.notEqual(blockedRequirement.nextAction, AUTOMATIC_RELEASE_PROMISE);
  assert.doesNotMatch(blockedRequirement.nextAction, /automatically/);
  assert.match(blockedRequirement.nextAction, /Restore the exact integration manifest/);

  // D1 non-regression: an ordinary verifiable-manifest owner keeps the promise verbatim.
  const ordinary = contenderFacing('mismatch');
  const ordinaryRequirement = ordinary.registry.inspectRecoveryRequirement('contender');
  assert.equal(ordinaryRequirement.requirement, 'transport-restart');
  assert.equal(ordinaryRequirement.nextAction, AUTOMATIC_RELEASE_PROMISE);
  assert.equal(ordinaryRequirement.startupCleanupBlocked, undefined);
  assert.equal(statusOf(ordinary, 'contender').startupCleanupBlocked, undefined);

  const outcome = await runStartupOwnerCleanup(cleanupInput(ordinary), executorDeps());
  assert.equal(outcome.status, 'clean');
  assert.deepEqual(outcome.released, ['prior-owner']);
  assert.equal(ordinary.registry.getClaim('source', 'worktree-1'), null);
});

test('GH#801: missing managed-Metro stop proof is reported as unrecoverable in-band', async () => {
  const missingProof = contenderFacing('mismatch');
  const retainedRuntimeEvidencePath = join(missingProof.root, 'metro-runtime-evidence.jsonl');
  writeFileSync(retainedRuntimeEvidencePath, '{"kind":"retained-runtime-evidence"}\n');
  const metroBeforeCleanup = missingProof.registry.getSessionStatus('prior-owner')?.bindings.metro;
  assert.ok(metroBeforeCleanup && typeof metroBeforeCleanup === 'object');
  missingProof.registry.updateBindings(missingProof.owner, {
    bindings: {
      metro: {
        ...(metroBeforeCleanup as Record<string, unknown>),
        runtimeEvidencePath: retainedRuntimeEvidencePath,
      },
    },
  });
  const outcome = await runStartupOwnerCleanup(cleanupInput(missingProof), {
    ...executorDeps(),
    stopManagedMetro: async () => false,
    verifyManagedMetroStopProof: () => false,
    inspectManagedMetroCleanupEvidence: () => ({
      complete: true,
      launcher: 'absent',
      listener: 'absent',
      port: { status: 'absent' },
      evidenceSocket: 'absent',
    }),
  });

  assert.equal(outcome.status, 'refused');
  assert.equal(outcome.refusal?.code, 'METRO_CLEANUP_PENDING');
  const missingRequirement = missingProof.registry.inspectRecoveryRequirement('contender');
  assert.equal(missingRequirement.requirement, 'unrecoverable-in-band');
  assert.equal(missingRequirement.priorOwner, 'stale');
  assert.equal(missingRequirement.startupCleanupBlocked?.code, 'METRO_CLEANUP_PENDING');
  assert.equal(missingRequirement.startupCleanupBlocked?.cause, 'managed-metro-stop-proof-missing');
  assert.match(missingRequirement.nextAction, /no supported in-band recovery/i);
  assert.doesNotMatch(
    missingRequirement.nextAction,
    /reconnect|restart|session-doctor\.js" repair/i,
  );
  const priorStatus = missingProof.registry.getSessionStatus('prior-owner');
  assert.ok(priorStatus);
  assert.equal(
    (
      priorStatus.bindings.startupCleanup as {
        obligations?: { metro?: { completedAt?: number | null } };
      }
    ).obligations?.metro?.completedAt,
    null,
    'the diagnostic does not discharge the cleanup obligation',
  );
  assert.equal(
    missingProof.registry.getClaim('source', 'worktree-1')?.sessionId,
    'prior-owner',
    'the diagnostic does not release authority',
  );
  const projected = statusOf(missingProof, 'contender');
  assert.equal(
    (projected.recoveryRequirement as { requirement?: string }).requirement,
    'unrecoverable-in-band',
  );
  assert.equal(
    (projected.startupCleanupBlocked as { cause?: string }).cause,
    'managed-metro-stop-proof-missing',
  );

  const legacy = contenderFacing('mismatch');
  const legacyMetro = {
    mode: 'managed',
    port: 8300,
    pid: 9914,
    birth: 'metro-birth',
    launcherPid: 9915,
    launcherBirth: 'launcher-birth',
    instanceId: 'metro-instance',
    runtimeEvidencePath: join(legacy.root, 'missing-runtime-evidence.jsonl'),
    runtimeEvidenceSocket: join(legacy.root, 'missing-runtime-evidence.sock'),
  };
  legacy.registry.updateBindings(legacy.owner, {
    bindings: {
      metro: {
        ...legacyMetro,
        managementProof: createHmac('sha256', 'dead-signer-capability')
          .update(
            [
              'prior-owner',
              legacyMetro.port,
              legacyMetro.pid,
              legacyMetro.birth,
              legacyMetro.launcherPid,
              legacyMetro.launcherBirth,
              legacyMetro.instanceId,
              legacyMetro.runtimeEvidencePath,
              legacyMetro.runtimeEvidenceSocket,
            ].join('\0'),
          )
          .digest('hex'),
      },
    },
  });
  await runStartupOwnerCleanup(cleanupInput(legacy), {
    ...executorDeps(),
    stopManagedMetro: async () => false,
    inspectManagedMetroCleanupEvidence: () => ({
      complete: true,
      launcher: 'absent',
      listener: 'absent',
      port: { status: 'absent' },
      evidenceSocket: 'absent',
    }),
  });
  const legacyRequirement = legacy.registry.inspectRecoveryRequirement('contender');
  assert.equal(legacyRequirement.requirement, 'transport-restart');
  assert.equal(legacyRequirement.startupCleanupBlocked?.cause, undefined);

  const retryable = contenderFacing('mismatch');
  await runStartupOwnerCleanup(cleanupInput(retryable), {
    ...executorDeps(),
    stopManagedMetro: async () => false,
    verifyManagedMetroStopProof: () => true,
    inspectManagedMetroCleanupEvidence: () => ({
      complete: false,
      launcher: 'present',
      listener: 'absent',
      port: { status: 'absent' },
      evidenceSocket: 'absent',
    }),
  });
  const retryableRequirement = retryable.registry.inspectRecoveryRequirement('contender');
  assert.equal(retryableRequirement.requirement, 'transport-restart');
  assert.equal(retryableRequirement.startupCleanupBlocked?.cause, undefined);
});

test('R6: repeated restarts surface the same refusal and release nothing', async () => {
  const f = contenderFacing('mismatch', {
    integration: {
      version: 1,
      installedBySessionId: 'prior-owner',
      manifestSha256: UNVERIFIABLE_SHA256,
    },
  });
  const before = ownerSnapshot(f);

  const surfaced: string[] = [];
  for (let pass = 0; pass < 3; pass += 1) {
    const outcome = await runStartupOwnerCleanup(cleanupInput(f), executorDeps());
    assert.equal(outcome.status, 'refused', `pass ${pass + 1} refuses`);
    assert.deepEqual(outcome.released, [], `pass ${pass + 1} releases nothing`);
    assert.ok(
      statusOf(f, 'contender').startupCleanupBlocked,
      `pass ${pass + 1} keeps the reason surfaced instead of promising convergence`,
    );
    surfaced.push(
      JSON.stringify([
        outcome.refusal?.code,
        outcome.refusal?.message,
        outcome.refusal?.nextAction,
        statusOf(f, 'contender').startupCleanupBlocked,
      ]),
    );
    f.advance(60_000);
  }
  assert.equal(new Set(surfaced).size, 1, 'the surfaced reason is stable across passes');
  assert.equal(f.registry.getClaim('source', 'worktree-1')?.sessionId, 'prior-owner');
  assert.equal(
    JSON.parse(before).authorityVersion,
    JSON.parse(ownerSnapshot(f)).authorityVersion,
    'a deterministic refusal never advances the owner authority version',
  );
});

test('R7: learned-action discovery is authority-independent', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'rn-learned-actions-'));
  roots.push(workspace);
  mkdirSync(join(workspace, '.rn-agent', 'actions'), { recursive: true });
  writeFileSync(
    join(workspace, '.rn-agent', 'actions', 'add-task.yaml'),
    '# id: add-task\n# intent: Add a task\nappId: com.example.app\n---\n- launchApp\n',
  );
  const listing = () =>
    execFileSync(
      process.execPath,
      [
        join(CORE_ROOT, 'dist', 'learned-actions.js'),
        '--json',
        '--section',
        'b',
        '--workspace-root',
        workspace,
        '--memory-cwd',
        workspace,
      ],
      { encoding: 'utf8' },
    );

  const outputs = new Set<string>();
  outputs.add(listing()); // healthy: no session at all
  for (const liveness of ['mismatch', 'match', 'unknown'] as const) {
    contenderFacing(liveness);
    outputs.add(listing());
  }
  assert.equal(outputs.size, 1, 'the listing is identical under every ownership state');
  assert.match([...outputs][0], /add-task/);
});

test('R8: a live or unknown owner is never adopted through any path', async () => {
  for (const liveness of ['match', 'unknown'] as const) {
    for (const model of ['grouped-v1', '']) {
      const f = contenderFacing(liveness, { model });
      const runtime = runtimeFor(f, f.contender);
      const handler = createSessionHandler(runtime as never, { now: f.now });
      const before = ownerSnapshot(f);

      const replay = envelope(await gatedRefusal(runtime, 'cdp_run_action')({ actionId: 'x' }));
      assert.equal(replay.ok, false);
      const adopt = envelope(
        await handler({ action: 'adopt_stale', adoptionHandle: 'anything' } as never),
      );
      assert.equal(adopt.ok, false, `${liveness}/${model || 'axes-v1'}: adoption refuses`);
      const cleanup = await runStartupOwnerCleanup(cleanupInput(f), executorDeps());
      assert.equal(cleanup.status, 'refused');
      assert.deepEqual(cleanup.released, []);

      assert.equal(
        ownerSnapshot(f),
        before,
        `${liveness}/${model || 'axes-v1'}: owner state, claims, and authority version are unchanged`,
      );
    }
  }
});
