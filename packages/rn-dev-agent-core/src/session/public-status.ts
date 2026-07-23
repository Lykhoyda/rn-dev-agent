import { inspectAuthorityMigration } from './migration-diagnostic.js';
import type { WorkerAuthorityStatus } from './runtime.js';

export function projectPublicAuthorityStatus(status: WorkerAuthorityStatus): Record<string, unknown> {
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
            typeof recovery.adoptStale?.token === 'string'
              ? recovery.adoptStale.token
              : undefined,
          adoptionExpiresMs:
            typeof recovery.adoptStale?.expiresMs === 'number'
              ? recovery.adoptStale.expiresMs
              : undefined,
        }
      : undefined;
  return {
    available: true,
    state: status.state,
    sourceKind: status.source.kind,
    metroPort: status.bindings.metroPort,
    observePort: status.bindings.observePort,
    platform: (status.bindings.device as Record<string, unknown> | undefined)?.platform,
    deviceBound: Boolean(status.bindings.device),
    installBound: Boolean(status.bindings.install),
    metroBound: Boolean(status.bindings.metro),
    bundleBound: Boolean(status.bindings.bundle),
    runnerBound: Boolean(status.bindings.runner),
    ...(recoveryStatus ? { recovery: recoveryStatus } : {}),
    migration: inspectAuthorityMigration(status),
  };
}
