import { inspectAuthorityMigration } from './migration-diagnostic.js';
import type { WorkerAuthorityStatus } from './runtime.js';

export function projectPublicAuthorityStatus(
  status: WorkerAuthorityStatus,
  options: { includeSessionId?: boolean } = {},
): Record<string, unknown> {
  if (!status.available) {
    return {
      available: false,
      code: status.code,
    };
  }
  const recovery = status.bindings.recoveryHandles as
    | {
        handoffRecipient?: { token?: unknown; expiresMs?: unknown };
        adoptStale?: { token?: unknown; expiresMs?: unknown };
      }
    | undefined;
  const recoveryStatus =
    status.state === 'blocked' && recovery
      ? {
          handoffRecipientHandle:
            typeof recovery.handoffRecipient?.token === 'string'
              ? recovery.handoffRecipient.token
              : undefined,
          handoffRecipientExpiresMs:
            typeof recovery.handoffRecipient?.expiresMs === 'number'
              ? recovery.handoffRecipient.expiresMs
              : undefined,
          adoptionRequired: Boolean(recovery.adoptStale),
          adoptionHandle:
            typeof recovery.adoptStale?.token === 'string' ? recovery.adoptStale.token : undefined,
          adoptionExpiresMs:
            typeof recovery.adoptStale?.expiresMs === 'number'
              ? recovery.adoptStale.expiresMs
              : undefined,
        }
      : undefined;
  const metro = status.bindings.metro as Record<string, unknown> | undefined;
  const metroTerminal = status.bindings.metroTerminal as
    | { code?: unknown; reason?: unknown; phase?: unknown; observedAt?: unknown }
    | undefined;
  return {
    available: true,
    ...(options.includeSessionId ? { sessionId: status.sessionId } : {}),
    state: status.state,
    sourceKind: status.source.kind,
    metroPort: status.bindings.metroPort,
    observePort: status.bindings.observePort,
    platform: (status.bindings.device as Record<string, unknown> | undefined)?.platform,
    deviceBound: Boolean(status.bindings.device),
    installBound: Boolean(status.bindings.install),
    metroBound: Boolean(status.bindings.metro),
    ...(metroTerminal
      ? {
          metroTerminal: {
            code: metroTerminal.code,
            reason: metroTerminal.reason,
            phase: metroTerminal.phase,
            observedAt: metroTerminal.observedAt,
          },
        }
      : {}),
    sandbox:
      metro?.runtimeEvidenceAuthority === 'managed-sandbox-v1'
        ? 'managed-sandbox-v1'
        : 'unavailable',
    bundleBound: Boolean(status.bindings.bundle),
    runnerBound: Boolean(status.bindings.runner),
    recorderBound: Boolean(status.bindings.recorder),
    ...(recoveryStatus ? { recovery: recoveryStatus } : {}),
    migration: inspectAuthorityMigration(status),
  };
}
