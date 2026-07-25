import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { openSessionRegistry } from './registry.js';
import { ensureSharedKnowledgeRoot } from './shared-knowledge-root.js';
import { stopManagedMetro } from './managed-metro.js';
import { createAuthorityStateLayout, sessionRuntimeDirectory, writeSessionPublicReceipt, writeSessionSecret, } from './state-root.js';
const RELEASABLE_SESSION_STATES = new Set([
    'active',
    'source_bound',
    'metro_bound',
    'device_claimed',
    'device_bound',
    'runtime_bound',
    'ready',
]);
export function createSupervisorAuthority(input, dependencies = {}) {
    if (!input.supervisorBirth) {
        throw new Error('PROCESS_BIRTH_UNAVAILABLE: supervisor process birth could not be proven conservatively');
    }
    const layout = createAuthorityStateLayout(input.stateDir);
    const registry = openSessionRegistry(layout.registry, {
        ownerStatus: input.ownerStatus,
        leaseMs: 30_000,
    });
    const sessionId = input.sessionId ?? randomUUID();
    const signerCapability = randomBytes(32).toString('base64url');
    const observeCapability = randomBytes(32).toString('base64url');
    const recoveryCapability = randomBytes(32).toString('base64url');
    const session = registry.createSession({
        sessionId,
        sourceKey: input.source.sourceKey,
        worktreeKey: input.source.worktreeKey,
        appRootKey: input.source.appRootKey,
        supervisor: {
            pid: input.supervisorBirth.pid,
            token: input.supervisorBirth.token,
        },
        source: { ...input.source },
    });
    const rollbackInitialization = (error) => {
        let failure = error;
        try {
            const status = registry.getSessionStatus(session.sessionId);
            if (status?.state === 'blocked') {
                registry.discardBlockedSession(session);
            }
            else if (status && status.state !== 'released' && status.state !== 'stale') {
                registry.cancelActiveOperationForSession(session);
                registry.releaseSession(session);
            }
        }
        catch (rollbackError) {
            failure = new AggregateError([error, rollbackError], 'SESSION_INITIALIZATION_ROLLBACK_FAILED: failed to release partial session claims');
        }
        finally {
            registry.close();
        }
        throw failure;
    };
    const initialize = (operation) => {
        try {
            return operation();
        }
        catch (error) {
            return rollbackInitialization(error);
        }
    };
    const metroPort = initialize(() => registry.allocatePort({
        service: 'metro',
        worktreeKey: input.source.worktreeKey,
        uid: input.uid,
        base: 8081,
        span: 200,
    }));
    const observePort = initialize(() => registry.allocatePort({
        service: 'observe',
        worktreeKey: input.source.worktreeKey,
        uid: input.uid,
        base: 7333,
        span: 200,
    }));
    const adoptionRequired = initialize(() => {
        try {
            registry.claimResources(session, [
                { type: 'source', key: input.source.worktreeKey },
                { type: 'metro-port', key: String(metroPort) },
                { type: 'observe-port', key: String(observePort) },
            ], { allowReclaim: false });
            return undefined;
        }
        catch (error) {
            if (error instanceof Error && 'holder' in error) {
                return error.holder;
            }
            throw error;
        }
    });
    const sharedKnowledge = adoptionRequired
        ? { migrated: false }
        : initialize(() => ensureSharedKnowledgeRoot(input.source.appRoot));
    initialize(() => registry.updateBindings(session, {
        state: adoptionRequired ? 'blocked' : 'source_bound',
        bindings: {
            metroPort,
            observePort,
            ...(adoptionRequired
                ? {
                    recoveryCapabilityHash: createHash('sha256').update(recoveryCapability).digest('hex'),
                    adoptionRequired: {
                        sessionId: adoptionRequired.sessionId,
                        claimEpoch: adoptionRequired.claimEpoch,
                    },
                }
                : {}),
        },
    }));
    const secretPath = initialize(() => writeSessionSecret(layout, sessionId, {
        signerCapability,
        observeCapability,
        recoveryCapability,
    }));
    initialize(() => writeSessionPublicReceipt(layout, sessionId, {
        sessionId,
        claimEpoch: session.claimEpoch,
        sourceKind: input.source.kind,
        sourceKey: input.source.sourceKey.slice(0, 12),
        worktreeKey: input.source.worktreeKey.slice(0, 12),
        metroPort,
        observePort,
        sharedKnowledgeMigrated: sharedKnowledge.migrated,
    }));
    let heartbeat = null;
    if (input.startHeartbeat !== false) {
        heartbeat = initialize(() => setInterval(() => {
            void registry.renewSessionWithRetry(session).catch(() => {
                if (heartbeat)
                    clearInterval(heartbeat);
                heartbeat = null;
            });
        }, input.heartbeatMs ?? 5_000));
        heartbeat.unref();
    }
    return {
        layout,
        registry,
        session,
        source: input.source,
        metroPort,
        observePort,
        workerEnvironment: (workerInstance) => ({
            RN_DEV_AGENT_SESSION_ID: session.sessionId,
            RN_DEV_AGENT_CLAIM_EPOCH: String(session.claimEpoch),
            RN_DEV_AGENT_REGISTRY_PATH: layout.registry,
            RN_DEV_AGENT_SESSION_SECRET_PATH: secretPath,
            RN_DEV_AGENT_SESSION_RUNTIME_ROOT: sessionRuntimeDirectory(layout, sessionId),
            RN_DEV_AGENT_WORKER_INSTANCE: workerInstance,
            RN_DEV_AGENT_SOURCE_KEY: input.source.sourceKey,
            RN_DEV_AGENT_WORKTREE_KEY: input.source.worktreeKey,
            RN_DEV_AGENT_APP_ROOT_KEY: input.source.appRootKey,
            RN_DEV_AGENT_METRO_PORT: String(metroPort),
            RN_DEV_AGENT_OBSERVE_PORT: String(observePort),
        }),
        close: async () => {
            if (heartbeat)
                clearInterval(heartbeat);
            try {
                let status = registry.getSessionStatus(session.sessionId);
                if (status && RELEASABLE_SESSION_STATES.has(status.state)) {
                    status = registry.beginSessionClose(session);
                }
                if (status) {
                    const metro = (status.bindings.metroCleanup ?? status.bindings.metro);
                    if (metro?.mode === 'managed' &&
                        !(await (dependencies.stopManagedMetro ?? stopManagedMetro)(metro, {
                            sessionId,
                            signerCapability,
                        }))) {
                        throw new Error('METRO_AUTHORITY_MISMATCH: managed Metro could not be stopped with exact process authority');
                    }
                }
                if (status?.state === 'blocked') {
                    registry.discardBlockedSession(session);
                }
                else if (status?.state === 'closing') {
                    registry.completeSessionClose(session);
                }
            }
            finally {
                registry.close();
            }
        },
    };
}
