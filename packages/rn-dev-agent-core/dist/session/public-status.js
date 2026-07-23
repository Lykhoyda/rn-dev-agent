import { inspectAuthorityMigration } from './migration-diagnostic.js';
export function projectPublicAuthorityStatus(status) {
    if (!status.available) {
        return {
            available: false,
            code: status.code,
        };
    }
    return {
        available: true,
        sessionId: status.sessionId.slice(0, 12),
        claimEpoch: status.claimEpoch,
        state: status.state,
        authorityVersion: status.authorityVersion,
        sourceKind: status.source.kind,
        metroPort: status.bindings.metroPort,
        observePort: status.bindings.observePort,
        platform: status.bindings.device?.platform,
        deviceBound: Boolean(status.bindings.device),
        installBound: Boolean(status.bindings.install),
        metroBound: Boolean(status.bindings.metro),
        bundleBound: Boolean(status.bindings.bundle),
        runnerBound: Boolean(status.bindings.runner),
        migration: inspectAuthorityMigration(status),
    };
}
