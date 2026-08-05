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
    const staleCleanup = status.bindings.staleDeviceCleanup;
    const cleanupPlatform = typeof staleCleanup?.platform === 'string' ? staleCleanup.platform : undefined;
    const cleanupDeviceId = typeof staleCleanup?.deviceId === 'string' ? staleCleanup.deviceId : undefined;
    const cleanupNextAction = cleanupPlatform && cleanupDeviceId
        ? status.state === 'handoff_cleanup'
            ? 'rn_session({ action: "adopt_stale", adoptionHandle })'
            : `rn_session({ action: "release_stale_device", platform: ${JSON.stringify(cleanupPlatform)}, deviceId: ${JSON.stringify(cleanupDeviceId)} })`
        : undefined;
    const releaseHandle = cleanupNextAction ? undefined : liveHandle(staleRelease ?? undefined, now);
    const pendingCleanupObligations = ['runner', 'recorder'].filter((resource) => {
        const binding = staleCleanup?.[resource];
        return (binding !== null &&
            typeof binding === 'object' &&
            typeof binding.completedAt !== 'number');
    });
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
        ...(cleanupNextAction
            ? {
                staleDeviceCleanup: {
                    platform: cleanupPlatform,
                    deviceId: cleanupDeviceId,
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
                    expiresMs: typeof staleRelease.expiresMs === 'number' ? staleRelease.expiresMs : undefined,
                    obligations: Array.isArray(staleRelease.obligations) ? staleRelease.obligations : [],
                    ...(releaseHandle
                        ? {}
                        : {
                            expired: true,
                            nextAction: cleanupNextAction ??
                                'The stale device release offer expired. Re-run rn_session({ action: "bind_device" }) to mint a fresh one.',
                        }),
                },
            }
            : {}),
        migration: inspectAuthorityMigration(status),
    };
}
