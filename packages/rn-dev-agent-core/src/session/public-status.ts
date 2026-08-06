import { inspectAuthorityMigration } from './migration-diagnostic.js';
import type { RecoveryRequirementInspection } from './registry.js';
import type { WorkerAuthorityStatus } from './runtime.js';

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

export function projectPublicAuthorityStatus(
  status: WorkerAuthorityStatus,
  options: {
    includeSessionId?: boolean;
    now?: () => number;
    recoveryRequirement?: RecoveryRequirementInspection;
  } = {},
): Record<string, unknown> {
  if (!status.available) {
    return {
      available: false,
      code: status.code,
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
    ...(options.recoveryRequirement && options.recoveryRequirement.requirement !== 'none'
      ? {
          recoveryRequirement: {
            requirement: options.recoveryRequirement.requirement,
            priorOwner: options.recoveryRequirement.priorOwner,
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
                    'The stale device release offer expired. Re-run rn_session({ action: "bind_device" }) to mint a fresh one.',
                }),
          },
        }
      : {}),
    migration: inspectAuthorityMigration(status),
  };
}
