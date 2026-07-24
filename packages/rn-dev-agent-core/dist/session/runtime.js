import { readProcessBirth } from './process-birth.js';
import { inspectSessionOwner } from './process-owner.js';
import { openSessionRegistry, SessionAuthorityError, } from './registry.js';
import { readJsonStateFile } from '../util/secure-state-file.js';
export class WorkerAuthorityRuntime {
    available;
    #registry;
    #session;
    #unavailable;
    #recoveryOnly;
    constructor(registry, session, unavailable, recoveryOnly = false) {
        this.#registry = registry;
        this.#session = session;
        this.#unavailable = unavailable;
        this.available = registry !== null && session !== null;
        this.#recoveryOnly = recoveryOnly;
    }
    requireAvailable() {
        if (!this.#registry || !this.#session) {
            throw new SessionAuthorityError(this.#unavailable?.code ?? 'SESSION_NOT_INITIALIZED', this.#unavailable?.reason ?? 'authority session is unavailable');
        }
        return { registry: this.#registry, session: this.#session };
    }
    requireOperational() {
        const available = this.requireAvailable();
        const status = this.status();
        if (status.available && (status.state === 'blocked' || status.state === 'handoff_cleanup')) {
            throw new SessionAuthorityError('SESSION_AUTHORITY_REQUIRED', 'blocked contender exposes only accept_handoff and adopt_stale recovery');
        }
        return available;
    }
    requireRecovery() {
        const available = this.requireAvailable();
        const status = this.status();
        if (!this.#recoveryOnly ||
            !status.available ||
            (status.state !== 'blocked' && status.state !== 'handoff_cleanup')) {
            throw new SessionAuthorityError('HANDOFF_NOT_AUTHORIZED', 'session is not a capability-bound recovery contender');
        }
        return available;
    }
    status() {
        if (!this.#registry || !this.#session) {
            return {
                available: false,
                code: this.#unavailable?.code ?? 'SESSION_NOT_INITIALIZED',
                reason: this.#unavailable?.reason ?? 'authority session is unavailable',
            };
        }
        const status = this.#registry.getSessionStatus(this.#session.sessionId);
        if (!status) {
            return {
                available: false,
                code: 'SESSION_OWNER_LOST',
                reason: 'session is no longer present in the authority registry',
            };
        }
        return { available: true, ...status };
    }
    close() {
        this.#registry?.close();
    }
}
function unavailable(reason, fallbackCode) {
    const matched = /^([A-Z][A-Z0-9_]+):/.exec(reason);
    return new WorkerAuthorityRuntime(null, null, {
        code: matched?.[1] ?? fallbackCode,
        reason,
    });
}
export function createWorkerAuthorityRuntime(environment = process.env, dependencies = {}) {
    if (environment.RN_DEV_AGENT_AUTHORITY_ERROR) {
        return unavailable(environment.RN_DEV_AGENT_AUTHORITY_ERROR, 'AUTHORITY_STORE_UNAVAILABLE');
    }
    const sessionId = environment.RN_DEV_AGENT_SESSION_ID;
    const claimEpoch = Number(environment.RN_DEV_AGENT_CLAIM_EPOCH);
    const registryPath = environment.RN_DEV_AGENT_REGISTRY_PATH;
    const workerInstance = environment.RN_DEV_AGENT_WORKER_INSTANCE;
    if (!sessionId ||
        !Number.isSafeInteger(claimEpoch) ||
        claimEpoch < 1 ||
        !registryPath ||
        !workerInstance) {
        return unavailable('SESSION_NOT_INITIALIZED: supervisor did not provide a complete authority context', 'SESSION_NOT_INITIALIZED');
    }
    const birth = (dependencies.readBirth ?? readProcessBirth)(process.pid);
    if (!birth) {
        return unavailable('PROCESS_BIRTH_UNAVAILABLE: worker process birth could not be proven conservatively', 'PROCESS_BIRTH_UNAVAILABLE');
    }
    try {
        const registry = openSessionRegistry(registryPath, {
            ownerStatus: dependencies.ownerStatus ?? inspectSessionOwner,
        });
        const session = { sessionId, claimEpoch };
        const status = registry.getSessionStatus(sessionId);
        const recoveryOnly = status?.state === 'blocked' || status?.state === 'handoff_cleanup';
        if (recoveryOnly) {
            const secretPath = environment.RN_DEV_AGENT_SESSION_SECRET_PATH;
            const recoveryCapability = secretPath
                ? readJsonStateFile(secretPath)?.recoveryCapability
                : null;
            if (!recoveryCapability) {
                throw new SessionAuthorityError('HANDOFF_NOT_AUTHORIZED', 'blocked recovery capability is unavailable');
            }
            registry.bindRecoveryWorker(session, { instanceId: workerInstance, pid: birth.pid, token: birth.token }, recoveryCapability);
        }
        else {
            registry.bindWorker(session, {
                instanceId: workerInstance,
                pid: birth.pid,
                token: birth.token,
            });
        }
        return new WorkerAuthorityRuntime(registry, session, null, recoveryOnly);
    }
    catch (error) {
        return unavailable(error instanceof Error
            ? error.message
            : 'AUTHORITY_STORE_UNAVAILABLE: worker authority could not be opened', 'AUTHORITY_STORE_UNAVAILABLE');
    }
}
let sharedRuntime = null;
export function getWorkerAuthorityRuntime() {
    sharedRuntime ??= createWorkerAuthorityRuntime();
    return sharedRuntime;
}
