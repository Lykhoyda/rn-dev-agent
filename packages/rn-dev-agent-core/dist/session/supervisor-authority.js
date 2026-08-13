import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { stopBoundObserve, stopBoundRecorder, stopBoundRunner } from './process-cleanup.js';
import { openSessionRegistry } from './registry.js';
import { stopManagedMetro } from './managed-metro.js';
import { removeAndroidMetroReverse, } from './android-metro-reverse.js';
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
/** GH #706/#767: released, stale, or blocked-with-absent-prior rows cannot be reused. */
export function supervisorSessionIsTerminal(authority) {
    try {
        const state = authority.registry.getSessionStatus(authority.session.sessionId)?.state;
        if (state === undefined || state === 'released' || state === 'stale')
            return true;
        if (state !== 'blocked')
            return false;
        const requirement = authority.registry.inspectRecoveryRequirement(authority.session.sessionId);
        return requirement.requirement === 'transport-restart' && requirement.priorOwner === 'absent';
    }
    catch {
        return false;
    }
}
/** GH #706: a terminal row is replaced by a freshly minted successor. */
export function resolveSupervisorAuthorityForSpawn(current, mint) {
    if (!current || !supervisorSessionIsTerminal(current)) {
        return { authority: current, error: null, minted: false };
    }
    const closeTerminal = () => {
        void current.close().catch(() => {
            /* a terminal session owns nothing; cleanup refusals must not block the successor */
        });
    };
    try {
        const authority = mint();
        closeTerminal();
        return { authority, error: null, minted: true };
    }
    catch (error) {
        closeTerminal();
        return {
            authority: null,
            error: error instanceof Error
                ? error.message
                : 'AUTHORITY_STORE_UNAVAILABLE: authority session could not be initialized',
            minted: false,
        };
    }
}
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
        // L4: the session-model discriminator lives in write-once source_json until the
        // schema-v5 column lands; grouped-v1 sessions never mint recovery handles.
        source: { ...input.source, model: 'grouped-v1' },
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
            ]);
            return undefined;
        }
        catch (error) {
            if (error instanceof Error && 'holder' in error) {
                return error.holder;
            }
            throw error;
        }
    });
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
            RN_DEV_AGENT_STATE_DIR: dirname(layout.root),
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
                if (status?.bindings.packageIntegration &&
                    (status.bindings.metroCleanup ?? status.bindings.metro)) {
                    return;
                }
                if (status && RELEASABLE_SESSION_STATES.has(status.state)) {
                    status = registry.beginSessionClose(session);
                }
                if (status) {
                    const androidMetroReverse = status.bindings.androidMetroReverse;
                    if (androidMetroReverse) {
                        (dependencies.removeAndroidMetroReverse ?? removeAndroidMetroReverse)(androidMetroReverse);
                    }
                    const recorder = status.bindings.recorder;
                    if (recorder) {
                        const claimKey = `${String(recorder.platform)}:${String(recorder.deviceId)}`;
                        if (!status.claims.some((claim) => claim.type === 'recorder' &&
                            claim.key === claimKey &&
                            claim.sessionId === session.sessionId &&
                            claim.claimEpoch === session.claimEpoch)) {
                            throw new Error('RECORDING_AUTHORITY_MISMATCH: recorder cleanup claim no longer matches the closing binding');
                        }
                        await (dependencies.stopBoundRecorder ?? stopBoundRecorder)(recorder);
                    }
                    const runner = status.bindings.runner;
                    if (runner) {
                        const claimKey = `${String(runner.platform)}:${String(runner.deviceId)}:${String(runner.port)}`;
                        if (!status.claims.some((claim) => claim.type === 'runner' &&
                            claim.key === claimKey &&
                            claim.sessionId === session.sessionId &&
                            claim.claimEpoch === session.claimEpoch)) {
                            throw new Error('RUNNER_OWNERSHIP_MISMATCH: runner cleanup claim no longer matches the closing binding');
                        }
                        await (dependencies.stopBoundRunner ?? stopBoundRunner)(runner);
                    }
                    const observe = status.bindings.observe;
                    if (observe) {
                        const port = String(observe.port);
                        if (status.bindings.observePort !== observe.port ||
                            !status.claims.some((claim) => claim.type === 'observe-port' &&
                                claim.key === port &&
                                claim.sessionId === session.sessionId &&
                                claim.claimEpoch === session.claimEpoch)) {
                            throw new Error('OBSERVE_AUTHORITY_MISMATCH: Observe cleanup claim no longer matches the closing binding');
                        }
                        await (dependencies.stopBoundObserve ?? stopBoundObserve)(observe);
                    }
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
