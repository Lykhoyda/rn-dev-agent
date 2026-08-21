import type { InstallIdentityInspection } from './install-identity-inspection.js';
import { inspectAuthorityMigration } from './migration-diagnostic.js';
import { authorityRemedyNextAction, type RecoveryRequirementInspection } from './registry.js';
import type { WorkerAuthorityStatus } from './runtime.js';
import { readLoginPrologueOutcome } from '../domain/login-prologue.js';

interface BoundedHandle {
  token?: unknown;
  expiresMs?: unknown;
}

export type PublicSessionPhase = 'selected' | 'building' | 'running' | 'closing';

const SELECTED_STATES = new Set(['active', 'source_bound', 'device_claimed', 'metro_bound']);
const RUNNING_STATES = new Set(['device_bound', 'runtime_bound', 'ready']);

// ADR §2.3 (L0): non-operational states keep only their internal name in `detail`.
function derivePublicPhase(state: string, buildPending: boolean): PublicSessionPhase | undefined {
  if (state === 'closing') return 'closing';
  if (!SELECTED_STATES.has(state) && !RUNNING_STATES.has(state)) return undefined;
  if (buildPending) return 'building';
  return RUNNING_STATES.has(state) ? 'running' : 'selected';
}

// GH #672: an expired handle must never be advertised — `validateStaleAdoption`
// refuses it, which is what made a freshly fetched status look self-contradictory.
// The caller refreshes before projecting; anything still expired here is reported
// as expired with a typed refresh action instead of being offered as usable.
function liveHandle(handle: BoundedHandle | undefined, now: number): string | undefined {
  if (typeof handle?.token !== 'string') return undefined;
  if (typeof handle.expiresMs === 'number' && handle.expiresMs <= now) return undefined;
  return handle.token;
}

function installIdentityRefusal(
  inspection: InstallIdentityInspection | null | undefined,
  proofBound: boolean,
): Record<string, unknown> {
  if (inspection?.verdict === 'changed') {
    return {
      state: 'install_identity_changed',
      detail:
        inspection.reason ?? 'installed artifact identity no longer matches the session build',
      nextAction:
        'The installed app is no longer the attested session build. Rebuild and re-attest it ' +
        '(rn_session build, or bind_device with a fresh signed build receipt), then re-open the device session.',
    };
  }
  if (inspection?.verdict === 'reissue-pending' && proofBound) {
    return {
      state: 'install_identity_reissue_blocked',
      detail: 'the app was reinstalled while a strict proof run is bound',
      nextAction:
        'The app was reinstalled during a strict proof run, so gated tools refuse ' +
        'APP_INSTALL_IDENTITY_CHANGED and the gate does not re-issue the receipt under the attestation. ' +
        'Discard the run (proof_capture action "discard"), then capture the proof again.',
    };
  }
  return {};
}

export function projectPublicAuthorityStatus(
  status: WorkerAuthorityStatus,
  options: {
    includeSessionId?: boolean;
    now?: () => number;
    recoveryRequirement?: RecoveryRequirementInspection;
    installIdentity?: InstallIdentityInspection | null;
  } = {},
): Record<string, unknown> {
  if (!status.available) {
    const nextAction = authorityRemedyNextAction(status.code);
    return {
      available: false,
      code: status.code,
      ...(nextAction ? { nextAction } : {}),
    };
  }
  const now = (options.now ?? Date.now)();
  const recovery = status.bindings.recoveryHandles as
    | {
        handoffRecipient?: BoundedHandle;
        adoptStale?: BoundedHandle;
      }
    | undefined;
  const adoptionHandle = liveHandle(recovery?.adoptStale, now);
  const recoveryStatus =
    (status.state === 'blocked' || status.state === 'handoff_cleanup') && recovery
      ? {
          handoffRecipientHandle: liveHandle(recovery.handoffRecipient, now),
          handoffRecipientExpiresMs:
            typeof recovery.handoffRecipient?.expiresMs === 'number'
              ? recovery.handoffRecipient.expiresMs
              : undefined,
          adoptionRequired: Boolean(recovery.adoptStale),
          adoptionHandle,
          adoptionExpiresMs:
            typeof recovery.adoptStale?.expiresMs === 'number'
              ? recovery.adoptStale.expiresMs
              : undefined,
          ...(recovery.adoptStale && !adoptionHandle
            ? {
                adoptionHandleExpired: true,
                adoptionRefreshAction:
                  'The advertised adoption handle expired and could not be rotated. Re-run rn_session({ action: "status" }) to mint a fresh one.',
              }
            : {}),
        }
      : undefined;
  const staleRelease = status.bindings.staleDeviceRelease as
    | (BoundedHandle & { platform?: unknown; obligations?: unknown })
    | null
    | undefined;
  const staleCleanup = status.bindings.staleDeviceCleanup as
    | {
        platform?: unknown;
        runner?: unknown;
        recorder?: unknown;
      }
    | null
    | undefined;
  const cleanupPlatform =
    typeof staleCleanup?.platform === 'string' ? staleCleanup.platform : undefined;
  const cleanupNextAction = cleanupPlatform
    ? status.state === 'handoff_cleanup'
      ? 'rn_session({ action: "adopt_stale", adoptionHandle })'
      : 'rn_session({ action: "release_stale_device" })'
    : undefined;
  const releaseHandle = cleanupNextAction ? undefined : liveHandle(staleRelease ?? undefined, now);
  const pendingCleanupObligations = (['runner', 'recorder'] as const).filter((resource) => {
    const binding = staleCleanup?.[resource];
    return (
      binding !== null &&
      typeof binding === 'object' &&
      typeof (binding as Record<string, unknown>).completedAt !== 'number'
    );
  });
  const metro = status.bindings.metro as Record<string, unknown> | undefined;
  const metroTerminal = status.bindings.metroTerminal as
    | { code?: unknown; reason?: unknown; phase?: unknown; observedAt?: unknown }
    | undefined;
  const projectedMetroTerminal = metroTerminal
    ? {
        code: metroTerminal.code,
        reason: metroTerminal.reason,
        phase: metroTerminal.phase,
        observedAt: metroTerminal.observedAt,
      }
    : undefined;
  const sandbox =
    metro?.runtimeEvidenceAuthority === 'managed-sandbox-v1' ? 'managed-sandbox-v1' : 'unavailable';
  const loginPrologue = readLoginPrologueOutcome(status.bindings.loginPrologue);
  const phase = derivePublicPhase(status.state, Boolean(status.bindings.pendingBuild));
  return {
    available: true,
    ...(options.includeSessionId ? { sessionId: status.sessionId } : {}),
    state: status.state,
    ...(phase ? { phase } : {}),
    detail: status.state,
    sourceKind: status.source.kind,
    metroPort: status.bindings.metroPort,
    observePort: status.bindings.observePort,
    platform: (status.bindings.device as Record<string, unknown> | undefined)?.platform,
    deviceBound: Boolean(status.bindings.device),
    installBound: Boolean(status.bindings.install),
    metroBound: Boolean(status.bindings.metro),
    ...(projectedMetroTerminal ? { metroTerminal: projectedMetroTerminal } : {}),
    sandbox,
    bundleBound: Boolean(status.bindings.bundle),
    runnerBound: Boolean(status.bindings.runner),
    recorderBound: Boolean(status.bindings.recorder),
    session: {
      sourceKind: status.source.kind,
      metroPort: status.bindings.metroPort,
      observePort: status.bindings.observePort,
      observe: Boolean(status.bindings.observe),
    },
    target: {
      platform: (status.bindings.device as Record<string, unknown> | undefined)?.platform,
      deviceBound: Boolean(status.bindings.device),
      installBound: Boolean(status.bindings.install),
    },
    runtime: {
      metroBound: Boolean(status.bindings.metro),
      bundleBound: Boolean(status.bindings.bundle),
      sandbox,
      ...(projectedMetroTerminal ? { metroTerminal: projectedMetroTerminal } : {}),
    },
    automation: {
      runnerBound: Boolean(status.bindings.runner),
      recorderBound: Boolean(status.bindings.recorder),
    },
    proof: Boolean(status.bindings.proof),
    // ADR §5.2 (L3): strict proof is an opt-in overlay outside the four groups, never a group.
    proofOverlay: { active: Boolean(status.bindings.proof) },
    ...(loginPrologue
      ? {
          loginPrologue: {
            state: loginPrologue.state,
            alias: loginPrologue.alias,
            actionId: loginPrologue.actionId,
            startedAt: loginPrologue.startedAt,
            endedAt: loginPrologue.endedAt,
            elapsedMs: loginPrologue.elapsedMs,
            failureCode: loginPrologue.failure?.code,
            runId: loginPrologue.runRecord?.runId,
            overrideCount: loginPrologue.overrides?.length ?? 0,
            lastOverride: loginPrologue.overrides?.at(-1),
          },
        }
      : {}),
    ...(options.installIdentity ? { installIdentity: options.installIdentity.verdict } : {}),
    // A live axis-I refusal means every gated tool refuses too — status must
    // not read `ready` while that is true. A pending re-issue reads ready only
    // because the gate heals it, which it does not do under a bound proof run.
    ...installIdentityRefusal(options.installIdentity, Boolean(status.bindings.proof)),
    ...(recoveryStatus ? { recovery: recoveryStatus } : {}),
    ...(cleanupNextAction
      ? {
          staleDeviceCleanup: {
            platform: cleanupPlatform,
            obligations: pendingCleanupObligations,
            nextAction: cleanupNextAction,
          },
        }
      : {}),
    // Retained cleanup refusals follow the identifier-free staleDeviceCleanup discipline.
    ...(options.recoveryRequirement?.startupCleanupBlocked
      ? {
          startupCleanupBlocked: {
            code: options.recoveryRequirement.startupCleanupBlocked.code,
            reason: options.recoveryRequirement.startupCleanupBlocked.reason,
            nextAction: options.recoveryRequirement.nextAction,
          },
        }
      : {}),
    ...(options.recoveryRequirement && options.recoveryRequirement.requirement !== 'none'
      ? {
          recoveryRequirement: {
            requirement: options.recoveryRequirement.requirement,
            priorOwner: options.recoveryRequirement.priorOwner,
            ...(typeof options.recoveryRequirement.priorOwnerHeartbeatAgeMs === 'number'
              ? { priorOwnerHeartbeatAgeMs: options.recoveryRequirement.priorOwnerHeartbeatAgeMs }
              : {}),
            nextAction: options.recoveryRequirement.nextAction,
          },
        }
      : {}),
    ...(staleRelease && !cleanupNextAction
      ? {
          staleDeviceRelease: {
            platform: staleRelease.platform,
            releaseHandle,
            expiresMs:
              typeof staleRelease.expiresMs === 'number' ? staleRelease.expiresMs : undefined,
            obligations: Array.isArray(staleRelease.obligations) ? staleRelease.obligations : [],
            ...(releaseHandle
              ? {}
              : {
                  expired: true,
                  nextAction:
                    cleanupNextAction ??
                    'The stale device release offer expired. Re-run rn_session({ action: "bind_device", confirmed: true }) to release the proven-dead owner inline.',
                }),
          },
        }
      : {}),
    migration: inspectAuthorityMigration(status),
  };
}
