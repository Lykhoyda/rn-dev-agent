import { inspectAuthorityMigration } from './migration-diagnostic.js';
// GH #672: an expired handle must never be advertised — `validateStaleAdoption`
// refuses it, which is what made a freshly fetched status look self-contradictory.
// The caller refreshes before projecting; anything still expired here is reported
// as expired with a typed refresh action instead of being offered as usable.
function liveHandle(handle, now) {
    if (typeof handle?.token !== 'string')
        return undefined;
    if (typeof handle.expiresMs === 'number' && handle.expiresMs <= now)
        return undefined;
    return handle.token;
}
export function projectPublicAuthorityStatus(status, options = {}) {
    if (!status.available) {
        return {
            available: false,
            code: status.code,
        };
    }
    const now = (options.now ?? Date.now)();
    const recovery = status.bindings.recoveryHandles;
    const adoptionHandle = liveHandle(recovery?.adoptStale, now);
    const recoveryStatus = (status.state === 'blocked' || status.state === 'handoff_cleanup') && recovery
        ? {
            handoffRecipientHandle: liveHandle(recovery.handoffRecipient, now),
            handoffRecipientExpiresMs: typeof recovery.handoffRecipient?.expiresMs === 'number'
                ? recovery.handoffRecipient.expiresMs
                : undefined,
            adoptionRequired: Boolean(recovery.adoptStale),
            adoptionHandle,
            adoptionExpiresMs: typeof recovery.adoptStale?.expiresMs === 'number'
                ? recovery.adoptStale.expiresMs
                : undefined,
            ...(recovery.adoptStale && !adoptionHandle
                ? {
                    adoptionHandleExpired: true,
                    adoptionRefreshAction: 'The advertised adoption handle expired and could not be rotated. Re-run rn_session({ action: "status" }) to mint a fresh one.',
                }
                : {}),
        }
        : undefined;
    const staleRelease = status.bindings.staleDeviceRelease;
    const releaseHandle = liveHandle(staleRelease ?? undefined, now);
    const metro = status.bindings.metro;
    const metroTerminal = status.bindings.metroTerminal;
    return {
        available: true,
        ...(options.includeSessionId ? { sessionId: status.sessionId } : {}),
        state: status.state,
        sourceKind: status.source.kind,
        metroPort: status.bindings.metroPort,
        observePort: status.bindings.observePort,
        platform: status.bindings.device?.platform,
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
        sandbox: metro?.runtimeEvidenceAuthority === 'managed-sandbox-v1'
            ? 'managed-sandbox-v1'
            : 'unavailable',
        bundleBound: Boolean(status.bindings.bundle),
        runnerBound: Boolean(status.bindings.runner),
        recorderBound: Boolean(status.bindings.recorder),
        ...(recoveryStatus ? { recovery: recoveryStatus } : {}),
        ...(options.recoveryRequirement && options.recoveryRequirement.requirement !== 'none'
            ? {
                recoveryRequirement: {
                    requirement: options.recoveryRequirement.requirement,
                    priorOwner: options.recoveryRequirement.priorOwner,
                    nextAction: options.recoveryRequirement.nextAction,
                },
            }
            : {}),
        ...(staleRelease
            ? {
                staleDeviceRelease: {
                    platform: staleRelease.platform,
                    releaseHandle,
                    expiresMs: typeof staleRelease.expiresMs === 'number' ? staleRelease.expiresMs : undefined,
                    obligations: Array.isArray(staleRelease.obligations) ? staleRelease.obligations : [],
                    ...(releaseHandle
                        ? {}
                        : {
                            expired: true,
                            nextAction: 'The stale device release offer expired. Re-run rn_session({ action: "bind_device" }) to mint a fresh one.',
                        }),
                },
            }
            : {}),
        migration: inspectAuthorityMigration(status),
    };
}
