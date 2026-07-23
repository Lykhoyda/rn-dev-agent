import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { openAuthorityStore, } from './authority-store.js';
export class SessionAuthorityError extends Error {
    code;
    holder;
    details;
    constructor(code, message, holder, details) {
        super(`${code}: ${message}`);
        this.name = 'SessionAuthorityError';
        this.code = code;
        this.holder = holder;
        this.details = details;
    }
}
const errorAxes = {
    SESSION_AUTHORITY_REQUIRED: 'C',
    SESSION_OWNER_LOST: 'C',
    OPERATION_ALREADY_IN_PROGRESS: 'C',
    SOURCE_WORKTREE_MISMATCH: 'S',
    SOURCE_REVISION_NOT_BUNDLED: 'S',
    APP_INSTALL_IDENTITY_CHANGED: 'I',
    METRO_PORT_CLAIM_CONFLICT: 'M',
    PORT_OCCUPIED_UNOWNED: 'M',
    METRO_AUTHORITY_MISMATCH: 'M',
    METRO_INSTANCE_CHANGED: 'M',
    BUNDLE_HANDSHAKE_UNAVAILABLE: 'B',
    BUNDLE_IDENTITY_MISMATCH: 'B',
    CDP_TARGET_AUTHORITY_MISMATCH: 'B',
    TARGET_CLAIM_CONFLICT: 'B',
    DEVICE_CLAIM_CONFLICT: 'D',
    DEVICE_AUTHORITY_MISMATCH: 'D',
    PLATFORM_AUTHORITY_MISMATCH: 'D',
    RUNNER_OWNERSHIP_MISMATCH: 'R',
    RUNNER_ADOPTION_REQUIRED: 'R',
    OBSERVE_AUTHORITY_MISMATCH: 'O',
    PROOF_AUTHORITY_MISMATCH: 'P',
};
export function shortAuthorityIdentity(value) {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}
export function authorityErrorMeta(error) {
    return {
        axis: error.details?.axis ?? errorAxes[error.code],
        expected: error.details?.expected,
        observed: error.details?.observed,
        holder: error.holder
            ? {
                sessionId: error.holder.sessionId.slice(0, 12),
                claimEpoch: error.holder.claimEpoch,
            }
            : undefined,
        nextAction: error.details?.nextAction ??
            'Run rn_session with action "status" and repair the named authority axis.',
    };
}
const conflictCodes = {
    device: 'DEVICE_CLAIM_CONFLICT',
    'device-receipt': 'DEVICE_CLAIM_CONFLICT',
    target: 'TARGET_CLAIM_CONFLICT',
    'metro-port': 'METRO_PORT_CLAIM_CONFLICT',
    'observe-port': 'OBSERVE_PORT_CLAIM_CONFLICT',
    runner: 'RUNNER_CLAIM_CONFLICT',
    'runner-receipt': 'RUNNER_CLAIM_CONFLICT',
};
function asSession(row) {
    return row ? row : null;
}
function asClaim(row) {
    return row ? row : null;
}
function claimConflict(claim) {
    const code = conflictCodes[claim.resource_type] ?? 'RESOURCE_CLAIM_CONFLICT';
    return new SessionAuthorityError(code, `${claim.resource_type}:${claim.resource_key} is held`, {
        sessionId: claim.session_id,
        claimEpoch: claim.claim_epoch,
    });
}
function isOperationalState(state) {
    return new Set([
        'active',
        'source_bound',
        'metro_bound',
        'device_claimed',
        'device_bound',
        'runtime_bound',
        'ready',
    ]).has(state);
}
function isFenceableState(state) {
    return isOperationalState(state) || state === 'handoff';
}
function bindingsRunnerPresent(bindingsJson) {
    const bindings = JSON.parse(bindingsJson);
    return Boolean(bindings.runner && typeof bindings.runner === 'object');
}
export class SessionRegistry {
    #database;
    #close;
    #secureFiles;
    #now;
    #ownerStatus;
    #leaseMs;
    #operationContext = new AsyncLocalStorage();
    #pendingPlatformReceipts = new Map();
    constructor(database, close, secureFiles, dependencies) {
        this.#database = database;
        this.#close = close;
        this.#secureFiles = secureFiles;
        this.#now = dependencies.now ?? Date.now;
        this.#ownerStatus = dependencies.ownerStatus;
        this.#leaseMs = dependencies.leaseMs ?? 30_000;
        this.#initialize();
    }
    close() {
        this.#close();
    }
    runWithOperation(operation, callback) {
        return this.#operationContext.run(operation, callback);
    }
    createSession(input) {
        const now = this.#now();
        this.#database
            .prepare(`INSERT INTO sessions(
          session_id, source_key, worktree_key, app_root_key, state,
          claim_epoch, authority_version, supervisor_pid, supervisor_birth,
          worker_instance, worker_pid, worker_birth, heartbeat_ms, lease_until_ms,
          source_json, bindings_json, created_ms, updated_ms
        ) VALUES (?, ?, ?, ?, 'active', 1, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(input.sessionId, input.sourceKey, input.worktreeKey, input.appRootKey, input.supervisor.pid, input.supervisor.token, input.worker?.instanceId ?? null, input.worker?.pid ?? null, input.worker?.token ?? null, now, now + this.#leaseMs, JSON.stringify(input.source ?? {}), JSON.stringify(input.bindings ?? {}), now, now);
        this.#secureFiles();
        return { sessionId: input.sessionId, claimEpoch: 1 };
    }
    claimResources(session, resources, options = {}) {
        const unique = new Map(resources.map((resource) => [`${resource.type}\0${resource.key}`, resource]));
        if (unique.size !== resources.length) {
            throw new SessionAuthorityError('DUPLICATE_RESOURCE_CLAIM', 'claim set contains duplicates');
        }
        const probes = this.#probeClaimOwners(session, resources);
        const now = this.#now();
        return this.#transaction(() => {
            const owner = this.#requireSession(session);
            const reclaim = new Set();
            for (const resource of resources) {
                const claim = this.#findConflictingClaim(resource);
                if (!claim ||
                    (claim.session_id === session.sessionId && claim.claim_epoch === session.claimEpoch)) {
                    continue;
                }
                const probe = probes.get(claim.session_id);
                if (!probe || probe.claimEpoch !== claim.claim_epoch) {
                    throw claimConflict(claim);
                }
                if (probe.status === 'match')
                    throw claimConflict(claim);
                if (probe.status === 'unknown') {
                    if (claim.lease_until_ms < now) {
                        throw new SessionAuthorityError('STALE_LEASE_NOT_RECLAIMABLE', 'expired lease owner identity could not be proven', { sessionId: claim.session_id, claimEpoch: claim.claim_epoch });
                    }
                    throw claimConflict(claim);
                }
                if (options.allowReclaim === false) {
                    throw new SessionAuthorityError('SESSION_AUTHORITY_REQUIRED', 'a proven-stale owner requires explicit adopt_stale before claims transfer', { sessionId: claim.session_id, claimEpoch: claim.claim_epoch });
                }
                reclaim.add(claim.session_id);
            }
            for (const sessionId of reclaim)
                this.#fenceSession(sessionId, now);
            const leaseUntil = now + this.#leaseMs;
            for (const resource of resources) {
                this.#database
                    .prepare(`INSERT INTO claims(
              resource_type, resource_key, session_id, claim_epoch, lease_until_ms
            ) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(resource_type, resource_key) DO UPDATE SET
              session_id = excluded.session_id,
              claim_epoch = excluded.claim_epoch,
              lease_until_ms = excluded.lease_until_ms`)
                    .run(resource.type, resource.key, session.sessionId, session.claimEpoch, leaseUntil);
            }
            this.#database
                .prepare(`UPDATE sessions
           SET authority_version = authority_version + 1, updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ?`)
                .run(now, owner.session_id, owner.claim_epoch);
            this.#advanceActiveOperationFence(session, owner.authority_version, owner.authority_version + 1);
            return session;
        });
    }
    releaseResources(session, resources) {
        const now = this.#now();
        this.#transaction(() => {
            const current = this.#requireSession(session);
            for (const resource of resources) {
                if (resource.type === 'runner' || resource.type === 'device') {
                    const rows = this.#database
                        .prepare(`SELECT platform, receipt_json FROM platform_authority_receipts
               WHERE session_id = ? AND claim_epoch = ?`)
                        .all(session.sessionId, session.claimEpoch);
                    for (const row of rows) {
                        const persisted = JSON.parse(row.receipt_json);
                        const receipt = persisted.receipt && typeof persisted.receipt === 'object'
                            ? persisted.receipt
                            : persisted;
                        if ((resource.type === 'runner' && receipt.runnerClaim === resource.key) ||
                            (resource.type === 'device' && receipt.deviceClaim === resource.key)) {
                            this.#invalidatePlatformReceipt(session, row.platform);
                        }
                    }
                }
                this.#database
                    .prepare(`DELETE FROM claims
             WHERE resource_type = ? AND resource_key = ?
               AND session_id = ? AND claim_epoch = ?`)
                    .run(resource.type, resource.key, session.sessionId, session.claimEpoch);
            }
            this.#database
                .prepare(`UPDATE sessions SET authority_version = authority_version + 1, updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ?`)
                .run(now, session.sessionId, session.claimEpoch);
            this.#advanceActiveOperationFence(session, current.authority_version, current.authority_version + 1);
        });
    }
    async claimResourcesWithRetry(session, resources, options = {}) {
        return this.#retry(() => this.claimResources(session, resources), options.timeoutMs ?? 1_000, options.retryDelayMs ?? 5);
    }
    renewSession(session) {
        const now = this.#now();
        this.#transaction(() => {
            this.#requireSession(session);
            const leaseUntil = now + this.#leaseMs;
            this.#database
                .prepare(`UPDATE sessions
           SET heartbeat_ms = ?, lease_until_ms = ?, updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ?`)
                .run(now, leaseUntil, now, session.sessionId, session.claimEpoch);
            this.#database
                .prepare(`UPDATE claims SET lease_until_ms = ?
           WHERE session_id = ? AND claim_epoch = ?`)
                .run(leaseUntil, session.sessionId, session.claimEpoch);
        });
    }
    async renewSessionWithRetry(session, options = {}) {
        return this.#retry(() => this.renewSession(session), options.timeoutMs ?? 1_000, options.retryDelayMs ?? 5);
    }
    bindWorker(session, worker) {
        const now = this.#now();
        this.#transaction(() => {
            this.#requireSession(session);
            this.#database
                .prepare('DELETE FROM operations WHERE session_id = ? AND claim_epoch = ?')
                .run(session.sessionId, session.claimEpoch);
            this.#database
                .prepare(`UPDATE sessions
           SET worker_instance = ?, worker_pid = ?, worker_birth = ?,
               authority_version = authority_version + 1, updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ?`)
                .run(worker.instanceId, worker.pid, worker.token, now, session.sessionId, session.claimEpoch);
        });
    }
    bindRecoveryWorker(session, worker, capability) {
        const now = this.#now();
        this.#transaction(() => {
            const row = this.#requireRecoverableSession(session);
            const bindings = JSON.parse(row.bindings_json);
            const expected = Buffer.from(String(bindings.recoveryCapabilityHash ?? ''), 'hex');
            const actual = createHash('sha256').update(capability).digest();
            if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
                throw new SessionAuthorityError('HANDOFF_NOT_AUTHORIZED', 'blocked recovery capability is invalid');
            }
            const adoptionRequired = bindings.adoptionRequired;
            const expiresMs = now + 5 * 60_000;
            const recoveryHandles = {
                handoffRecipient: {
                    token: randomBytes(32).toString('base64url'),
                    expiresMs,
                    workerInstance: worker.instanceId,
                },
                ...(typeof adoptionRequired?.sessionId === 'string'
                    ? {
                        adoptStale: {
                            token: randomBytes(32).toString('base64url'),
                            expiresMs,
                            priorSessionId: adoptionRequired.sessionId,
                            priorClaimEpoch: adoptionRequired.claimEpoch,
                        },
                    }
                    : {}),
            };
            this.#database
                .prepare('DELETE FROM operations WHERE session_id = ? AND claim_epoch = ?')
                .run(session.sessionId, session.claimEpoch);
            this.#database
                .prepare(`UPDATE sessions
           SET worker_instance = ?, worker_pid = ?, worker_birth = ?,
               bindings_json = ?, authority_version = authority_version + 1, updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ?
             AND state IN ('blocked', 'handoff_cleanup')`)
                .run(worker.instanceId, worker.pid, worker.token, JSON.stringify({ ...bindings, recoveryHandles }), now, session.sessionId, session.claimEpoch);
        });
    }
    replaceDeviceAuthority(session, input) {
        const resource = input.resource ??
            {
                type: 'device',
                key: `${String(input.device.platform)}:${String(input.device.deviceId)}`,
            };
        const probes = this.#probeClaimOwners(session, [resource]);
        const now = this.#now();
        this.#transaction(() => {
            const current = this.#requireSession(session);
            const claim = this.#findConflictingClaim(resource);
            if (claim &&
                (claim.session_id !== session.sessionId || claim.claim_epoch !== session.claimEpoch)) {
                const probe = probes.get(claim.session_id);
                if (!probe || probe.claimEpoch !== claim.claim_epoch || probe.status !== 'mismatch') {
                    throw claimConflict(claim);
                }
                throw new SessionAuthorityError('SESSION_AUTHORITY_REQUIRED', 'a proven-stale device owner requires explicit adopt_stale before rebinding', { sessionId: claim.session_id, claimEpoch: claim.claim_epoch });
            }
            this.#database
                .prepare(`DELETE FROM claims
           WHERE session_id = ? AND claim_epoch = ?
             AND resource_type IN ('device', 'target', 'runner')`)
                .run(session.sessionId, session.claimEpoch);
            this.#database
                .prepare(`INSERT INTO claims(
            resource_type, resource_key, session_id, claim_epoch, lease_until_ms
          ) VALUES (?, ?, ?, ?, ?)`)
                .run(resource.type, resource.key, session.sessionId, session.claimEpoch, now + this.#leaseMs);
            const bindings = {
                ...JSON.parse(current.bindings_json),
                device: input.device,
                install: input.install ?? null,
                bundle: null,
                runner: null,
                observe: null,
                proof: null,
                pendingBuild: null,
            };
            this.#invalidatePlatformReceipt(session, String(input.device.platform));
            this.#database
                .prepare(`UPDATE sessions
           SET state = ?, bindings_json = ?, authority_version = authority_version + 1,
               updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ?`)
                .run(input.install ? 'device_bound' : 'device_claimed', JSON.stringify(bindings), now, session.sessionId, session.claimEpoch);
            this.#advanceActiveOperationFence(session, current.authority_version, current.authority_version + 1);
        });
    }
    updateBindings(session, input) {
        const now = this.#now();
        this.#transaction(() => {
            const current = this.#requireSession(session);
            if (input.expectedAuthorityVersion !== undefined &&
                current.authority_version !== input.expectedAuthorityVersion) {
                throw new SessionAuthorityError('AUTHORITY_LOST_DURING_OPERATION', 'session authority version changed before binding commit');
            }
            const bindings = {
                ...JSON.parse(current.bindings_json),
                ...input.bindings,
            };
            if (Object.hasOwn(input.bindings, 'device') ||
                Object.hasOwn(input.bindings, 'install') ||
                Object.hasOwn(input.bindings, 'runner')) {
                const currentBindings = JSON.parse(current.bindings_json);
                const platform = String((input.bindings.device ?? currentBindings.device)
                    ?.platform ?? '');
                if (platform) {
                    this.#invalidatePlatformReceipt(session, platform);
                }
            }
            this.#database
                .prepare(`UPDATE sessions
           SET state = ?, bindings_json = ?, authority_version = authority_version + 1,
               updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ?`)
                .run(input.state ?? current.state, JSON.stringify(bindings), now, session.sessionId, session.claimEpoch);
            this.#advanceActiveOperationFence(session, current.authority_version, current.authority_version + 1);
        });
    }
    replaceBindingsDuringOperation(operation, input) {
        const now = this.#now();
        return this.#transaction(() => {
            const current = asSession(this.#database
                .prepare(`SELECT state, claim_epoch, authority_version, bindings_json
             FROM sessions WHERE session_id = ?`)
                .get(operation.sessionId));
            const active = this.#database
                .prepare(`SELECT operation_id FROM operations
           WHERE operation_id = ? AND session_id = ? AND claim_epoch = ?
             AND authority_version = ?`)
                .get(operation.operationId, operation.sessionId, operation.claimEpoch, operation.authorityVersion);
            if (!current ||
                !isOperationalState(current.state) ||
                current.claim_epoch !== operation.claimEpoch ||
                current.authority_version !== operation.authorityVersion ||
                !active) {
                throw new SessionAuthorityError('AUTHORITY_LOST_DURING_OPERATION', 'operation fence no longer matches current authority');
            }
            for (const resource of input.claimResources ?? []) {
                const claim = this.#findConflictingClaim(resource);
                if (claim &&
                    (claim.session_id !== operation.sessionId || claim.claim_epoch !== operation.claimEpoch)) {
                    throw claimConflict(claim);
                }
            }
            for (const resource of input.releaseResources ?? []) {
                this.#database
                    .prepare(`DELETE FROM claims
             WHERE resource_type = ? AND resource_key = ?
               AND session_id = ? AND claim_epoch = ?`)
                    .run(resource.type, resource.key, operation.sessionId, operation.claimEpoch);
            }
            const leaseUntil = now + this.#leaseMs;
            for (const resource of input.claimResources ?? []) {
                this.#database
                    .prepare(`INSERT INTO claims(
              resource_type, resource_key, session_id, claim_epoch, lease_until_ms
            ) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(resource_type, resource_key) DO UPDATE SET
              session_id = excluded.session_id,
              claim_epoch = excluded.claim_epoch,
              lease_until_ms = excluded.lease_until_ms`)
                    .run(resource.type, resource.key, operation.sessionId, operation.claimEpoch, leaseUntil);
            }
            const nextAuthorityVersion = operation.authorityVersion + 1;
            const bindings = {
                ...JSON.parse(current.bindings_json),
                ...input.bindings,
            };
            this.#database
                .prepare(`UPDATE sessions
           SET state = ?, bindings_json = ?, authority_version = ?, updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ? AND authority_version = ?`)
                .run(input.state ?? current.state, JSON.stringify(bindings), nextAuthorityVersion, now, operation.sessionId, operation.claimEpoch, operation.authorityVersion);
            this.#database
                .prepare(`UPDATE operations SET authority_version = ?, lease_until_ms = ?
           WHERE operation_id = ? AND session_id = ? AND claim_epoch = ?
             AND authority_version = ?`)
                .run(nextAuthorityVersion, leaseUntil, operation.operationId, operation.sessionId, operation.claimEpoch, operation.authorityVersion);
            const context = this.#operationContext.getStore();
            if (context?.operationId === operation.operationId) {
                context.authorityVersion = nextAuthorityVersion;
            }
            return { ...operation, authorityVersion: nextAuthorityVersion };
        });
    }
    getSessionStatus(sessionId) {
        const row = asSession(this.#database
            .prepare(`SELECT session_id, source_key, worktree_key, app_root_key, state,
                  claim_epoch, authority_version, supervisor_pid, supervisor_birth,
                  worker_instance, worker_pid, worker_birth, lease_until_ms,
                  source_json, bindings_json
           FROM sessions WHERE session_id = ?`)
            .get(sessionId));
        if (!row)
            return null;
        const claims = this.#database
            .prepare(`SELECT resource_type, resource_key, session_id, claim_epoch, lease_until_ms
         FROM claims WHERE session_id = ? AND claim_epoch = ?
         ORDER BY resource_type, resource_key`)
            .all(sessionId, row.claim_epoch)
            .map((claim) => {
            const typed = claim;
            return {
                type: typed.resource_type,
                key: typed.resource_key,
                sessionId: typed.session_id,
                claimEpoch: typed.claim_epoch,
                leaseUntilMs: typed.lease_until_ms,
            };
        });
        return {
            sessionId: row.session_id,
            sourceKey: row.source_key,
            worktreeKey: row.worktree_key,
            appRootKey: row.app_root_key,
            state: row.state,
            claimEpoch: row.claim_epoch,
            authorityVersion: row.authority_version,
            leaseUntilMs: row.lease_until_ms,
            source: JSON.parse(row.source_json),
            bindings: JSON.parse(row.bindings_json),
            claims,
            worker: {
                instanceId: row.worker_instance,
                pid: row.worker_pid,
                birthAvailable: row.worker_birth !== null,
            },
        };
    }
    countOtherOperationalSessions(sessionId) {
        const rows = this.#database
            .prepare(`SELECT state FROM sessions
         WHERE session_id <> ?`)
            .all(sessionId);
        return rows.filter((row) => typeof row.state === 'string' && isOperationalState(row.state))
            .length;
    }
    findSessionsByWorktree(worktreeKey) {
        const rows = this.#database
            .prepare(`SELECT session_id FROM sessions
         WHERE worktree_key = ? AND state NOT IN ('released', 'stale')
         ORDER BY updated_ms DESC`)
            .all(worktreeKey);
        return rows
            .map((row) => this.getSessionStatus(String(row.session_id)))
            .filter((status) => status !== null);
    }
    getControllerBinding(session) {
        const row = this.#requireSession(session);
        return {
            sessionId: row.session_id,
            claimEpoch: row.claim_epoch,
            authorityVersion: row.authority_version,
            supervisor: { pid: row.supervisor_pid, token: row.supervisor_birth },
            worker: {
                instanceId: row.worker_instance,
                pid: row.worker_pid,
                token: row.worker_birth,
            },
        };
    }
    releaseSession(session) {
        const now = this.#now();
        this.#transaction(() => {
            this.#requireSession(session);
            const active = this.#database
                .prepare(`SELECT operation_id, profile FROM operations
           WHERE session_id = ? AND claim_epoch = ? LIMIT 1`)
                .get(session.sessionId, session.claimEpoch);
            if (active && !String(active.profile).startsWith('transition:')) {
                throw new SessionAuthorityError('SESSION_OPERATION_ACTIVE', 'session cannot be released while an operation is active');
            }
            if (active) {
                const context = this.#operationContext.getStore();
                if (!context ||
                    context.operationId !== active.operation_id ||
                    context.sessionId !== session.sessionId ||
                    context.claimEpoch !== session.claimEpoch) {
                    throw new SessionAuthorityError('AUTHORITY_LOST_DURING_OPERATION', 'session release is not owned by the active operation fence');
                }
                this.#database
                    .prepare('DELETE FROM operations WHERE session_id = ? AND claim_epoch = ?')
                    .run(session.sessionId, session.claimEpoch);
            }
            this.#database
                .prepare('DELETE FROM claims WHERE session_id = ? AND claim_epoch = ?')
                .run(session.sessionId, session.claimEpoch);
            this.#database
                .prepare(`UPDATE sessions
           SET state = 'released', claim_epoch = claim_epoch + 1,
               authority_version = authority_version + 1, updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ?`)
                .run(now, session.sessionId, session.claimEpoch);
        });
    }
    discardBlockedSession(session) {
        const now = this.#now();
        this.#transaction(() => {
            const row = asSession(this.#database
                .prepare('SELECT state, claim_epoch FROM sessions WHERE session_id = ?')
                .get(session.sessionId));
            if (!row || row.state !== 'blocked' || row.claim_epoch !== session.claimEpoch) {
                throw new SessionAuthorityError('SESSION_OWNER_LOST', 'only the unchanged blocked session may be discarded');
            }
            const claim = this.#database
                .prepare('SELECT resource_key FROM claims WHERE session_id = ? LIMIT 1')
                .get(session.sessionId);
            if (claim) {
                throw new SessionAuthorityError('SESSION_AUTHORITY_REQUIRED', 'blocked session unexpectedly owns resource claims');
            }
            this.#database
                .prepare(`UPDATE sessions
           SET state = 'released', claim_epoch = claim_epoch + 1,
               authority_version = authority_version + 1, updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ?`)
                .run(now, session.sessionId, session.claimEpoch);
        });
    }
    prepareHandoff(session, input) {
        const now = this.#now();
        const handoffId = randomBytes(16).toString('hex');
        const token = randomBytes(32).toString('base64url');
        const tokenHash = createHash('sha256').update(token).digest('hex');
        this.#transaction(() => {
            const current = this.#requireSession(session);
            let targetInstance = input.targetInstance;
            if (input.targetHandle) {
                const targets = this.#database
                    .prepare(`SELECT session_id, bindings_json FROM sessions
             WHERE state = 'blocked' AND source_key = ? AND worktree_key = ? AND app_root_key = ?`)
                    .all(current.source_key, current.worktree_key, current.app_root_key);
                for (const target of targets) {
                    const bindings = JSON.parse(target.bindings_json);
                    const handles = bindings.recoveryHandles;
                    const handle = handles?.handoffRecipient;
                    if (typeof handle?.token === 'string' &&
                        typeof handle.expiresMs === 'number' &&
                        handle.expiresMs >= now &&
                        this.#capabilityMatches(handle.token, input.targetHandle)) {
                        targetInstance =
                            typeof handle.workerInstance === 'string' ? handle.workerInstance : undefined;
                        this.#database
                            .prepare('UPDATE sessions SET bindings_json = ? WHERE session_id = ?')
                            .run(JSON.stringify({
                            ...bindings,
                            recoveryHandles: { ...handles, handoffRecipient: null },
                        }), target.session_id);
                        break;
                    }
                }
            }
            if (!targetInstance) {
                throw new SessionAuthorityError('HANDOFF_TARGET_MISMATCH', 'handoff recipient capability is invalid or expired');
            }
            const active = this.#database
                .prepare(`SELECT operation_id, profile FROM operations
           WHERE session_id = ? AND claim_epoch = ? LIMIT 1`)
                .get(session.sessionId, session.claimEpoch);
            if (active && !String(active.profile).startsWith('transition:')) {
                throw new SessionAuthorityError('SESSION_OPERATION_ACTIVE', 'session cannot enter handoff while an operation is active');
            }
            this.#database
                .prepare(`INSERT INTO handoffs(
            handoff_id, session_id, claim_epoch, target_instance,
            token_hash, source_state, expires_ms, consumed_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`)
                .run(handoffId, session.sessionId, session.claimEpoch, targetInstance, tokenHash, this.#requireSession(session).state, now + (input.ttlMs ?? 15_000));
            this.#database
                .prepare(`UPDATE sessions
           SET state = 'handoff', authority_version = authority_version + 1, updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ?`)
                .run(now, session.sessionId, session.claimEpoch);
            this.#advanceActiveOperationFence(session, current.authority_version, current.authority_version + 1);
        });
        return { handoffId, token };
    }
    prepareHandoffForHandle(session, input) {
        return this.prepareHandoff(session, input);
    }
    cancelHandoff(session, handoffId) {
        const now = this.#now();
        this.#transaction(() => {
            const handoff = this.#database
                .prepare(`SELECT session_id, claim_epoch, source_state, consumed_ms
           FROM handoffs WHERE handoff_id = ?`)
                .get(handoffId);
            if (!handoff ||
                handoff.session_id !== session.sessionId ||
                handoff.claim_epoch !== session.claimEpoch) {
                throw new SessionAuthorityError('HANDOFF_NOT_FOUND', 'handoff does not belong to session');
            }
            if (handoff.consumed_ms !== null) {
                throw new SessionAuthorityError('HANDOFF_ALREADY_CONSUMED', 'handoff is already terminal');
            }
            const row = asSession(this.#database
                .prepare('SELECT state, claim_epoch FROM sessions WHERE session_id = ?')
                .get(session.sessionId));
            if (!row || row.state !== 'handoff' || row.claim_epoch !== session.claimEpoch) {
                throw new SessionAuthorityError('SESSION_OWNER_LOST', 'handoff source owner changed');
            }
            this.#database
                .prepare(`UPDATE sessions
           SET state = ?, authority_version = authority_version + 1, updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ?`)
                .run(handoff.source_state, now, session.sessionId, session.claimEpoch);
            this.#database
                .prepare('UPDATE handoffs SET consumed_ms = ? WHERE handoff_id = ?')
                .run(now, handoffId);
        });
    }
    getHandoffOwner(handoffId) {
        const row = this.#database
            .prepare('SELECT session_id FROM handoffs WHERE handoff_id = ?')
            .get(handoffId);
        return typeof row?.session_id === 'string' ? row.session_id : null;
    }
    validateHandoffInto(target, input) {
        const targetRow = this.#requireRecoverableSession(target);
        if (targetRow.state !== 'blocked') {
            throw new SessionAuthorityError('HANDOFF_NOT_AUTHORIZED', 'handoff acceptance is not available during cleanup');
        }
        if (targetRow.worker_instance !== input.targetInstance) {
            throw new SessionAuthorityError('HANDOFF_TARGET_MISMATCH', 'handoff target is not the current fenced worker instance');
        }
        const handoff = this.#database
            .prepare(`SELECT session_id, claim_epoch, target_instance, token_hash, expires_ms, consumed_ms
         FROM handoffs WHERE handoff_id = ?`)
            .get(input.handoffId);
        if (!handoff) {
            throw new SessionAuthorityError('HANDOFF_NOT_FOUND', 'handoff does not exist');
        }
        if (handoff.consumed_ms !== null) {
            throw new SessionAuthorityError('HANDOFF_ALREADY_CONSUMED', 'handoff is already terminal');
        }
        if (handoff.expires_ms < this.#now()) {
            throw new SessionAuthorityError('HANDOFF_EXPIRED', 'handoff capability expired');
        }
        if (handoff.target_instance !== input.targetInstance) {
            throw new SessionAuthorityError('HANDOFF_TARGET_MISMATCH', 'handoff target instance does not match');
        }
        const expected = Buffer.from(handoff.token_hash, 'hex');
        const actual = createHash('sha256').update(input.token).digest();
        if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
            throw new SessionAuthorityError('HANDOFF_TOKEN_INVALID', 'handoff capability is invalid');
        }
        const prior = this.getSessionStatus(handoff.session_id);
        if (!prior ||
            prior.state !== 'handoff' ||
            prior.claimEpoch !== handoff.claim_epoch ||
            prior.sourceKey !== targetRow.source_key ||
            prior.worktreeKey !== targetRow.worktree_key ||
            prior.appRootKey !== targetRow.app_root_key) {
            throw new SessionAuthorityError('HANDOFF_NOT_AUTHORIZED', 'handoff no longer matches the exact source owner');
        }
    }
    acceptHandoff(input) {
        const now = this.#now();
        return this.#transaction(() => {
            const handoff = this.#database
                .prepare(`SELECT handoff_id, session_id, claim_epoch, target_instance,
                  token_hash, expires_ms, consumed_ms
           FROM handoffs WHERE handoff_id = ?`)
                .get(input.handoffId);
            if (!handoff) {
                throw new SessionAuthorityError('HANDOFF_NOT_FOUND', 'handoff does not exist');
            }
            if (handoff.consumed_ms !== null) {
                throw new SessionAuthorityError('HANDOFF_ALREADY_CONSUMED', 'handoff was already accepted');
            }
            if (handoff.expires_ms < now) {
                throw new SessionAuthorityError('HANDOFF_EXPIRED', 'handoff capability expired');
            }
            if (handoff.target_instance !== input.targetInstance) {
                throw new SessionAuthorityError('HANDOFF_TARGET_MISMATCH', 'handoff target instance does not match');
            }
            const expected = Buffer.from(handoff.token_hash, 'hex');
            const actual = Buffer.from(createHash('sha256').update(input.token).digest('hex'), 'hex');
            if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
                throw new SessionAuthorityError('HANDOFF_TOKEN_INVALID', 'handoff capability is invalid');
            }
            const session = asSession(this.#database
                .prepare(`SELECT session_id, state, claim_epoch, authority_version,
                    supervisor_pid, supervisor_birth, lease_until_ms, bindings_json
             FROM sessions WHERE session_id = ?`)
                .get(handoff.session_id));
            if (!session || session.state !== 'handoff' || session.claim_epoch !== handoff.claim_epoch) {
                throw new SessionAuthorityError('SESSION_OWNER_LOST', 'handoff no longer matches the session claim epoch');
            }
            const nextEpoch = session.claim_epoch + 1;
            const leaseUntil = now + this.#leaseMs;
            this.#database
                .prepare(`DELETE FROM claims
           WHERE session_id = ? AND claim_epoch = ?
             AND resource_type NOT IN ('source', 'metro-port', 'observe-port', 'device')`)
                .run(session.session_id, session.claim_epoch);
            this.#database
                .prepare(`UPDATE claims SET claim_epoch = ?, lease_until_ms = ?
           WHERE session_id = ? AND claim_epoch = ?`)
                .run(nextEpoch, leaseUntil, session.session_id, session.claim_epoch);
            this.#database
                .prepare(`UPDATE sessions
           SET state = 'source_bound', claim_epoch = ?, authority_version = authority_version + 1,
               supervisor_pid = ?, supervisor_birth = ?, heartbeat_ms = ?,
               lease_until_ms = ?, bindings_json = ?, updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ?`)
                .run(nextEpoch, input.supervisor.pid, input.supervisor.token, now, leaseUntil, JSON.stringify({
                ...JSON.parse(session.bindings_json),
                bundle: null,
                runner: null,
                observe: null,
                proof: null,
                pendingBuild: null,
            }), now, session.session_id, session.claim_epoch);
            this.#database
                .prepare('UPDATE handoffs SET consumed_ms = ? WHERE handoff_id = ?')
                .run(now, handoff.handoff_id);
            return { sessionId: session.session_id, claimEpoch: nextEpoch };
        });
    }
    acceptHandoffInto(target, input) {
        const now = this.#now();
        return this.#transaction(() => {
            const targetRow = this.#requireRecoverableSession(target);
            if (targetRow.state !== 'blocked') {
                throw new SessionAuthorityError('HANDOFF_NOT_AUTHORIZED', 'handoff acceptance is not available during cleanup');
            }
            if (targetRow.worker_instance !== input.targetInstance) {
                throw new SessionAuthorityError('HANDOFF_TARGET_MISMATCH', 'handoff target is not the current fenced worker instance');
            }
            const handoff = this.#database
                .prepare(`SELECT handoff_id, session_id, claim_epoch, target_instance,
                  token_hash, expires_ms, consumed_ms
           FROM handoffs WHERE handoff_id = ?`)
                .get(input.handoffId);
            if (!handoff) {
                throw new SessionAuthorityError('HANDOFF_NOT_FOUND', 'handoff does not exist');
            }
            if (handoff.consumed_ms !== null) {
                throw new SessionAuthorityError('HANDOFF_ALREADY_CONSUMED', 'handoff was already accepted');
            }
            if (handoff.expires_ms < now) {
                throw new SessionAuthorityError('HANDOFF_EXPIRED', 'handoff capability expired');
            }
            if (handoff.target_instance !== input.targetInstance) {
                throw new SessionAuthorityError('HANDOFF_TARGET_MISMATCH', 'handoff target instance does not match');
            }
            const expected = Buffer.from(handoff.token_hash, 'hex');
            const actual = createHash('sha256').update(input.token).digest();
            if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
                throw new SessionAuthorityError('HANDOFF_TOKEN_INVALID', 'handoff capability is invalid');
            }
            const prior = asSession(this.#database
                .prepare(`SELECT session_id, source_key, worktree_key, app_root_key, state,
                    claim_epoch, authority_version, bindings_json
             FROM sessions WHERE session_id = ?`)
                .get(handoff.session_id));
            if (!prior || prior.state !== 'handoff' || prior.claim_epoch !== handoff.claim_epoch) {
                throw new SessionAuthorityError('HANDOFF_NOT_AUTHORIZED', 'handoff no longer matches the live owner epoch');
            }
            if (prior.source_key !== targetRow.source_key ||
                prior.worktree_key !== targetRow.worktree_key ||
                prior.app_root_key !== targetRow.app_root_key) {
                throw new SessionAuthorityError('SOURCE_WORKTREE_MISMATCH', 'handoff source does not match the target session');
            }
            const active = this.#database
                .prepare(`SELECT operation_id FROM operations
           WHERE session_id = ?
              OR (session_id = ? AND profile NOT LIKE 'transition:%')
           LIMIT 1`)
                .get(prior.session_id, target.sessionId);
            if (active) {
                throw new SessionAuthorityError('SESSION_OPERATION_ACTIVE', 'handoff cannot transfer while either session has an active operation');
            }
            const priorRunnerClaim = this.#database
                .prepare(`SELECT resource_key FROM claims
           WHERE session_id = ? AND claim_epoch = ? AND resource_type = 'runner'`)
                .get(prior.session_id, prior.claim_epoch);
            if (bindingsRunnerPresent(prior.bindings_json) && !priorRunnerClaim?.resource_key) {
                throw new SessionAuthorityError('RUNNER_OWNERSHIP_MISMATCH', 'handoff runner binding has no exclusive cleanup claim');
            }
            this.#database
                .prepare(`DELETE FROM claims
           WHERE session_id = ? AND claim_epoch = ?`)
                .run(target.sessionId, target.claimEpoch);
            this.#database
                .prepare(`DELETE FROM claims
           WHERE session_id = ? AND claim_epoch = ?
             AND resource_type NOT IN ('source', 'metro-port', 'observe-port', 'device', 'runner')`)
                .run(prior.session_id, prior.claim_epoch);
            this.#database
                .prepare(`UPDATE claims SET session_id = ?, claim_epoch = ?, lease_until_ms = ?
           WHERE session_id = ? AND claim_epoch = ?`)
                .run(target.sessionId, target.claimEpoch, now + this.#leaseMs, prior.session_id, prior.claim_epoch);
            const bindings = JSON.parse(prior.bindings_json);
            const targetBindings = JSON.parse(targetRow.bindings_json);
            this.#database
                .prepare(`UPDATE sessions
           SET state = 'handoff_cleanup', bindings_json = ?,
               authority_version = authority_version + 1, updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ?`)
                .run(JSON.stringify({
                ...bindings,
                bundle: null,
                runner: null,
                observe: null,
                proof: null,
                pendingBuild: null,
                recoveryCapabilityHash: targetBindings.recoveryCapabilityHash,
                handoffCleanup: {
                    observe: bindings.observe && typeof bindings.observe === 'object'
                        ? {
                            ...bindings.observe,
                            stopRequestedAt: null,
                            completedAt: null,
                        }
                        : null,
                    runner: bindings.runner && typeof bindings.runner === 'object'
                        ? {
                            ...bindings.runner,
                            claimKey: priorRunnerClaim?.resource_key,
                            stopRequestedAt: null,
                            completedAt: null,
                        }
                        : null,
                },
            }), now, target.sessionId, target.claimEpoch);
            this.#database
                .prepare(`UPDATE sessions
           SET state = 'released', claim_epoch = claim_epoch + 1,
               authority_version = authority_version + 1, updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ?`)
                .run(now, prior.session_id, prior.claim_epoch);
            this.#database
                .prepare('UPDATE handoffs SET consumed_ms = ? WHERE handoff_id = ?')
                .run(now, handoff.handoff_id);
            return {
                ...this.getSessionStatus(target.sessionId)?.bindings.handoffCleanup,
            };
        });
    }
    beginHandoffCleanupResource(target, targetInstance, resource) {
        const now = this.#now();
        return this.#transaction(() => {
            const row = this.#requireHandoffCleanupOwner(target, targetInstance);
            const bindings = JSON.parse(row.bindings_json);
            const cleanup = bindings.handoffCleanup;
            const current = cleanup?.[resource];
            if (!current || typeof current !== 'object')
                return null;
            const binding = current;
            if (typeof binding.completedAt === 'number')
                return binding;
            if (resource === 'runner') {
                const claimKey = String(binding.claimKey ?? '');
                const expectedClaimKey = `${String(binding.platform)}:${String(binding.deviceId)}:${String(binding.port)}`;
                const claim = this.#findClaim('runner', claimKey);
                if (!claimKey ||
                    claimKey !== expectedClaimKey ||
                    claim?.session_id !== target.sessionId ||
                    claim.claim_epoch !== target.claimEpoch ||
                    typeof binding.capability !== 'string' ||
                    typeof binding.instanceId !== 'string') {
                    throw new SessionAuthorityError('RUNNER_OWNERSHIP_MISMATCH', 'handoff runner cleanup claim no longer matches the authenticated binding');
                }
            }
            const requested = {
                ...binding,
                stopRequestedAt: typeof binding.stopRequestedAt === 'number' ? binding.stopRequestedAt : now,
            };
            this.#database
                .prepare(`UPDATE sessions SET bindings_json = ?, updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ? AND state = 'handoff_cleanup'`)
                .run(JSON.stringify({
                ...bindings,
                handoffCleanup: { ...cleanup, [resource]: requested },
            }), now, target.sessionId, target.claimEpoch);
            return requested;
        });
    }
    completeHandoffCleanupResource(target, targetInstance, resource) {
        const now = this.#now();
        this.#transaction(() => {
            const row = this.#requireHandoffCleanupOwner(target, targetInstance);
            const bindings = JSON.parse(row.bindings_json);
            const cleanup = bindings.handoffCleanup;
            const current = cleanup?.[resource];
            if (!current || typeof current !== 'object')
                return;
            const binding = current;
            if (typeof binding.stopRequestedAt !== 'number') {
                throw new SessionAuthorityError('HANDOFF_NOT_AUTHORIZED', `${resource} cleanup was not durably requested`);
            }
            if (typeof binding.completedAt === 'number')
                return;
            if (resource === 'runner') {
                this.#database
                    .prepare(`DELETE FROM claims
             WHERE resource_type = 'runner' AND resource_key = ?
               AND session_id = ? AND claim_epoch = ?`)
                    .run(String(binding.claimKey), target.sessionId, target.claimEpoch);
            }
            this.#database
                .prepare(`UPDATE sessions SET bindings_json = ?, updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ? AND state = 'handoff_cleanup'`)
                .run(JSON.stringify({
                ...bindings,
                handoffCleanup: {
                    ...cleanup,
                    [resource]: { ...binding, completedAt: now },
                },
            }), now, target.sessionId, target.claimEpoch);
        });
    }
    finishHandoffCleanup(target, targetInstance) {
        const now = this.#now();
        this.#transaction(() => {
            const row = asSession(this.#database
                .prepare(`SELECT state, claim_epoch, worker_instance, bindings_json
             FROM sessions WHERE session_id = ?`)
                .get(target.sessionId));
            if (!row ||
                row.state !== 'handoff_cleanup' ||
                row.claim_epoch !== target.claimEpoch ||
                row.worker_instance !== targetInstance) {
                throw new SessionAuthorityError('HANDOFF_NOT_AUTHORIZED', 'handoff cleanup is not owned by this recovery worker');
            }
            const bindings = JSON.parse(row.bindings_json);
            const cleanup = bindings.handoffCleanup;
            for (const resource of ['runner', 'observe']) {
                const binding = cleanup?.[resource];
                if (binding &&
                    typeof binding === 'object' &&
                    typeof binding.completedAt !== 'number') {
                    throw new SessionAuthorityError('HANDOFF_NOT_AUTHORIZED', `${resource} cleanup has not been durably completed`);
                }
            }
            this.#database
                .prepare(`UPDATE sessions
           SET state = 'source_bound', bindings_json = ?,
               authority_version = authority_version + 1, updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ? AND state = 'handoff_cleanup'`)
                .run(JSON.stringify({
                ...bindings,
                handoffCleanup: null,
            }), now, target.sessionId, target.claimEpoch);
        });
    }
    recordPlatformAuthorityReceipt(session, platform, receipt) {
        const operation = this.#operationContext.getStore();
        if (!operation ||
            operation.sessionId !== session.sessionId ||
            operation.claimEpoch !== session.claimEpoch) {
            throw new SessionAuthorityError('AUTHORITY_LOST_DURING_OPERATION', 'platform receipt recording requires the active operation fence');
        }
        this.verifyOperation(operation);
        const staged = this.#platformReceiptFromCurrentAuthority(session, platform, receipt);
        const pending = this.#pendingPlatformReceipts.get(operation.operationId) ?? [];
        pending.push(staged);
        this.#pendingPlatformReceipts.set(operation.operationId, pending);
    }
    commitPlatformAuthorityReceipts(operation) {
        const pending = this.#pendingPlatformReceipts.get(operation.operationId) ?? [];
        if (pending.length === 0)
            return;
        const now = this.#now();
        this.#transaction(() => {
            this.verifyOperation(operation);
            for (const staged of pending) {
                const current = this.#platformReceiptFromCurrentAuthority(staged.session, staged.platform, staged.receipt);
                const runnerClaim = String(staged.receipt.runnerClaim);
                const deviceClaim = String(staged.receipt.deviceClaim);
                for (const resource of [
                    { type: 'runner-receipt', key: runnerClaim },
                    { type: 'device-receipt', key: deviceClaim },
                ]) {
                    const existing = this.#findClaim(resource.type, resource.key);
                    if (existing &&
                        (existing.session_id !== staged.session.sessionId ||
                            existing.claim_epoch !== staged.session.claimEpoch)) {
                        throw claimConflict(existing);
                    }
                }
                this.#invalidatePlatformReceipt(staged.session, staged.platform);
                for (const resource of [
                    { type: 'runner-receipt', key: runnerClaim },
                    { type: 'device-receipt', key: deviceClaim },
                ]) {
                    this.#database
                        .prepare(`INSERT INTO claims(
                 resource_type, resource_key, session_id, claim_epoch, lease_until_ms
               ) VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(resource_type, resource_key) DO UPDATE SET
                 session_id = excluded.session_id,
                 claim_epoch = excluded.claim_epoch,
                 lease_until_ms = excluded.lease_until_ms`)
                        .run(resource.type, resource.key, staged.session.sessionId, staged.session.claimEpoch, now + this.#leaseMs);
                }
                this.#database
                    .prepare(`INSERT INTO platform_authority_receipts(
               session_id, claim_epoch, platform, receipt_json, updated_ms
             ) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(session_id, platform) DO UPDATE SET
               claim_epoch = excluded.claim_epoch,
               receipt_json = excluded.receipt_json,
               updated_ms = excluded.updated_ms`)
                    .run(staged.session.sessionId, staged.session.claimEpoch, staged.platform, JSON.stringify({ receipt: staged.receipt, probe: current.probe }), now);
            }
        });
        this.#pendingPlatformReceipts.delete(operation.operationId);
    }
    validatePlatformAuthorityReceipt(session, platform, receipt) {
        const row = this.#database
            .prepare(`SELECT claim_epoch, receipt_json FROM platform_authority_receipts
         WHERE session_id = ? AND platform = ?`)
            .get(session.sessionId, platform);
        const persisted = typeof row?.receipt_json === 'string'
            ? JSON.parse(row.receipt_json)
            : null;
        const persistedReceipt = persisted?.receipt && typeof persisted.receipt === 'object'
            ? persisted.receipt
            : persisted;
        const runnerClaim = this.#findClaim('runner-receipt', String(receipt.runnerClaim));
        const deviceClaim = this.#findClaim('device-receipt', String(receipt.deviceClaim));
        return (row?.claim_epoch === session.claimEpoch &&
            JSON.stringify(persistedReceipt) === JSON.stringify(receipt) &&
            runnerClaim?.session_id === session.sessionId &&
            runnerClaim.claim_epoch === session.claimEpoch &&
            deviceClaim?.session_id === session.sessionId &&
            deviceClaim.claim_epoch === session.claimEpoch);
    }
    getPlatformAuthorityProbe(session, platform, receipt) {
        if (!this.validatePlatformAuthorityReceipt(session, platform, receipt))
            return null;
        const row = this.#database
            .prepare(`SELECT receipt_json FROM platform_authority_receipts
         WHERE session_id = ? AND claim_epoch = ? AND platform = ?`)
            .get(session.sessionId, session.claimEpoch, platform);
        if (typeof row?.receipt_json !== 'string')
            return null;
        const persisted = JSON.parse(row.receipt_json);
        const probe = persisted.probe;
        if (!probe ||
            createHash('sha256').update(probe.capability).digest('hex') !== receipt.runnerCapabilityHash) {
            return null;
        }
        return probe;
    }
    adoptStaleIntoBlocked(target, priorSessionId, targetInstance) {
        const priorStatus = this.getSessionStatus(priorSessionId);
        if (!priorStatus) {
            throw new SessionAuthorityError('SESSION_OWNER_LOST', 'stale session is unavailable');
        }
        const owner = asSession(this.#database
            .prepare(`SELECT supervisor_pid, supervisor_birth FROM sessions WHERE session_id = ?`)
            .get(priorSessionId));
        if (!owner ||
            this.#ownerStatus({
                sessionId: priorSessionId,
                pid: owner.supervisor_pid,
                token: owner.supervisor_birth,
            }) !== 'mismatch') {
            throw new SessionAuthorityError('SESSION_AUTHORITY_REQUIRED', 'prior source owner is not proven stale');
        }
        const now = this.#now();
        this.#transaction(() => {
            const targetRow = this.#requireRecoverableSession(target);
            if (targetRow.state !== 'blocked') {
                throw new SessionAuthorityError('HANDOFF_NOT_AUTHORIZED', 'stale adoption is not available during handoff cleanup');
            }
            if (targetRow.worker_instance !== targetInstance) {
                throw new SessionAuthorityError('HANDOFF_TARGET_MISMATCH', 'stale adoption target is not the recovery worker');
            }
            const prior = asSession(this.#database
                .prepare(`SELECT session_id, source_key, worktree_key, app_root_key, state,
                    claim_epoch, bindings_json
             FROM sessions WHERE session_id = ?`)
                .get(priorSessionId));
            if (!prior ||
                prior.claim_epoch !== priorStatus.claimEpoch ||
                prior.source_key !== targetRow.source_key ||
                prior.worktree_key !== targetRow.worktree_key ||
                prior.app_root_key !== targetRow.app_root_key) {
                throw new SessionAuthorityError('SOURCE_WORKTREE_MISMATCH', 'stale session does not belong to this exact source worktree');
            }
            this.#database
                .prepare(`DELETE FROM claims
           WHERE session_id = ? AND claim_epoch = ?
             AND resource_type NOT IN ('source', 'metro-port', 'observe-port', 'device')`)
                .run(prior.session_id, prior.claim_epoch);
            this.#database
                .prepare(`UPDATE claims SET session_id = ?, claim_epoch = ?, lease_until_ms = ?
           WHERE session_id = ? AND claim_epoch = ?`)
                .run(target.sessionId, target.claimEpoch, now + this.#leaseMs, prior.session_id, prior.claim_epoch);
            const priorBindings = JSON.parse(prior.bindings_json);
            const targetBindings = JSON.parse(targetRow.bindings_json);
            const sameMetro = Number(priorBindings.metro?.port) ===
                Number(targetBindings.metroPort);
            this.#database
                .prepare(`UPDATE sessions
           SET state = ?, bindings_json = ?, authority_version = authority_version + 1,
               updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ? AND state = 'blocked'`)
                .run(sameMetro && priorBindings.device ? 'device_bound' : 'source_bound', JSON.stringify({
                ...targetBindings,
                adoptionRequired: null,
                recoveryHandles: null,
                metro: sameMetro ? priorBindings.metro : null,
                device: priorBindings.device ?? null,
                install: priorBindings.install ?? null,
                bundle: null,
                runner: null,
                observe: null,
                proof: null,
            }), now, target.sessionId, target.claimEpoch);
            this.#fenceSession(prior.session_id, now);
        });
    }
    adoptStaleWithHandle(target, handle, targetInstance) {
        const targetStatus = this.getSessionStatus(target.sessionId);
        const recovery = targetStatus?.bindings.recoveryHandles;
        const adoption = recovery?.adoptStale;
        if (targetStatus?.state !== 'blocked' ||
            typeof adoption?.token !== 'string' ||
            typeof adoption.expiresMs !== 'number' ||
            adoption.expiresMs < this.#now() ||
            typeof adoption.priorSessionId !== 'string' ||
            !this.#capabilityMatches(adoption.token, handle)) {
            throw new SessionAuthorityError('HANDOFF_NOT_AUTHORIZED', 'stale adoption capability is invalid or expired');
        }
        const prior = this.getSessionStatus(adoption.priorSessionId);
        if (prior?.claimEpoch !== adoption.priorClaimEpoch) {
            throw new SessionAuthorityError('SESSION_OWNER_LOST', 'stale adoption capability no longer matches the prior claim epoch');
        }
        this.adoptStaleIntoBlocked(target, adoption.priorSessionId, targetInstance);
    }
    beginOperation(session, operation) {
        const now = this.#now();
        return this.#transaction(() => {
            const owner = this.#requireSession(session);
            const active = this.#database
                .prepare(`SELECT operation_id FROM operations
           WHERE session_id = ? AND claim_epoch = ? LIMIT 1`)
                .get(session.sessionId, session.claimEpoch);
            if (active) {
                throw new SessionAuthorityError('OPERATION_ALREADY_IN_PROGRESS', 'session already has an active fenced operation');
            }
            this.#database
                .prepare(`INSERT INTO operations(
            operation_id, session_id, claim_epoch, authority_version,
            tool, profile, started_ms, lease_until_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
                .run(operation.operationId, session.sessionId, session.claimEpoch, owner.authority_version, operation.tool, operation.profile, now, now + this.#leaseMs);
            return {
                operationId: operation.operationId,
                sessionId: session.sessionId,
                claimEpoch: session.claimEpoch,
                authorityVersion: owner.authority_version,
            };
        });
    }
    refreshOperation(operation) {
        this.verifyOperation(operation);
        return operation;
    }
    endOperation(operation) {
        this.#transaction(() => {
            const session = asSession(this.#database
                .prepare(`SELECT state, claim_epoch, authority_version
             FROM sessions WHERE session_id = ?`)
                .get(operation.sessionId));
            const active = this.#database
                .prepare(`SELECT operation_id FROM operations
           WHERE operation_id = ? AND session_id = ? AND claim_epoch = ?
             AND authority_version = ?`)
                .get(operation.operationId, operation.sessionId, operation.claimEpoch, operation.authorityVersion);
            if (!session ||
                !isFenceableState(session.state) ||
                session.claim_epoch !== operation.claimEpoch ||
                session.authority_version !== operation.authorityVersion ||
                !active) {
                throw new SessionAuthorityError('AUTHORITY_LOST_DURING_OPERATION', 'operation fence no longer matches current authority');
            }
            this.#database
                .prepare('DELETE FROM operations WHERE operation_id = ?')
                .run(operation.operationId);
        });
        this.#pendingPlatformReceipts.delete(operation.operationId);
    }
    cancelOperation(operation) {
        this.#transaction(() => {
            this.#database
                .prepare(`DELETE FROM operations
           WHERE operation_id = ? AND session_id = ? AND claim_epoch = ?
             AND authority_version = ?`)
                .run(operation.operationId, operation.sessionId, operation.claimEpoch, operation.authorityVersion);
        });
        this.#pendingPlatformReceipts.delete(operation.operationId);
    }
    verifyOperation(operation) {
        const session = asSession(this.#database
            .prepare(`SELECT state, claim_epoch, authority_version
           FROM sessions WHERE session_id = ?`)
            .get(operation.sessionId));
        const active = this.#database
            .prepare(`SELECT operation_id FROM operations
         WHERE operation_id = ? AND session_id = ? AND claim_epoch = ?
           AND authority_version = ?`)
            .get(operation.operationId, operation.sessionId, operation.claimEpoch, operation.authorityVersion);
        if (!session ||
            !isFenceableState(session.state) ||
            session.claim_epoch !== operation.claimEpoch ||
            session.authority_version !== operation.authorityVersion ||
            !active) {
            throw new SessionAuthorityError('AUTHORITY_LOST_DURING_OPERATION', 'operation fence no longer matches current authority');
        }
    }
    renewOperation(operation) {
        const now = this.#now();
        this.#transaction(() => {
            this.verifyOperation(operation);
            this.#database
                .prepare('UPDATE operations SET lease_until_ms = ? WHERE operation_id = ?')
                .run(now + this.#leaseMs, operation.operationId);
        });
    }
    getClaim(type, key) {
        const claim = this.#findClaim(type, key);
        return claim
            ? {
                type: claim.resource_type,
                key: claim.resource_key,
                sessionId: claim.session_id,
                claimEpoch: claim.claim_epoch,
                leaseUntilMs: claim.lease_until_ms,
            }
            : null;
    }
    allocatePort(input) {
        if (!Number.isSafeInteger(input.base) ||
            input.base < 1 ||
            !Number.isSafeInteger(input.span) ||
            input.span < 1 ||
            input.base + input.span > 65_536) {
            throw new SessionAuthorityError('INVALID_PORT_RANGE', 'port allocation range is invalid');
        }
        return this.#transaction(() => {
            const existing = this.#database
                .prepare('SELECT port FROM allocations WHERE service = ? AND worktree_key = ?')
                .get(input.service, input.worktreeKey);
            if (existing)
                return existing.port;
            const digest = createHash('sha256')
                .update(`${input.uid}\0${input.worktreeKey}\0${input.service}`)
                .digest();
            const preferred = digest.readUInt32BE(0) % input.span;
            for (let offset = 0; offset < input.span; offset += 1) {
                const port = input.base + ((preferred + offset) % input.span);
                const occupied = this.#database
                    .prepare('SELECT worktree_key FROM allocations WHERE service = ? AND port = ?')
                    .get(input.service, port);
                if (occupied)
                    continue;
                this.#database
                    .prepare(`INSERT INTO allocations(service, worktree_key, port, generation)
             VALUES (?, ?, ?, 1)`)
                    .run(input.service, input.worktreeKey, port);
                return port;
            }
            throw new SessionAuthorityError('PORT_RANGE_EXHAUSTED', `no ${input.service} port is available in the configured range`);
        });
    }
    #initialize() {
        const schema = this.#database
            .prepare('SELECT value FROM authority_meta WHERE key = ?')
            .get('schema_version')?.value;
        const version = Number(schema);
        if (!Number.isSafeInteger(version) || version < 1 || version > 4) {
            throw new SessionAuthorityError('AUTHORITY_STORE_UNAVAILABLE', version > 4
                ? `authority registry schema ${version} is newer than supported schema 4`
                : 'authority registry schema version is invalid');
        }
        this.#database.exec('BEGIN IMMEDIATE');
        try {
            this.#database.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        source_key TEXT NOT NULL,
        worktree_key TEXT NOT NULL,
        app_root_key TEXT NOT NULL,
        state TEXT NOT NULL,
        claim_epoch INTEGER NOT NULL,
        authority_version INTEGER NOT NULL,
        supervisor_pid INTEGER NOT NULL,
        supervisor_birth TEXT NOT NULL,
        worker_instance TEXT,
        worker_pid INTEGER,
        worker_birth TEXT,
        heartbeat_ms INTEGER NOT NULL,
        lease_until_ms INTEGER NOT NULL,
        source_json TEXT NOT NULL,
        bindings_json TEXT NOT NULL,
        created_ms INTEGER NOT NULL,
        updated_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS claims (
        resource_type TEXT NOT NULL,
        resource_key TEXT NOT NULL,
        session_id TEXT NOT NULL,
        claim_epoch INTEGER NOT NULL,
        lease_until_ms INTEGER NOT NULL,
        PRIMARY KEY(resource_type, resource_key)
      );
      CREATE INDEX IF NOT EXISTS claims_session_idx
        ON claims(session_id, claim_epoch);
      CREATE TABLE IF NOT EXISTS operations (
        operation_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        claim_epoch INTEGER NOT NULL,
        authority_version INTEGER NOT NULL,
        tool TEXT NOT NULL,
        profile TEXT NOT NULL,
        started_ms INTEGER NOT NULL,
        lease_until_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS operations_session_idx
        ON operations(session_id, claim_epoch);
      CREATE TABLE IF NOT EXISTS allocations (
        service TEXT NOT NULL,
        worktree_key TEXT NOT NULL,
        port INTEGER NOT NULL,
        generation INTEGER NOT NULL,
        PRIMARY KEY(service, worktree_key),
        UNIQUE(service, port)
      );
      CREATE TABLE IF NOT EXISTS handoffs (
        handoff_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        claim_epoch INTEGER NOT NULL,
        target_instance TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        expires_ms INTEGER NOT NULL,
        consumed_ms INTEGER
      );
      CREATE TABLE IF NOT EXISTS platform_authority_receipts (
        session_id TEXT NOT NULL,
        claim_epoch INTEGER NOT NULL,
        platform TEXT NOT NULL,
        receipt_json TEXT NOT NULL,
        updated_ms INTEGER NOT NULL,
        PRIMARY KEY(session_id, platform)
      );
      `);
            if (version < 3) {
                const columns = this.#database.prepare('PRAGMA table_info(handoffs)').all();
                if (!columns.some((column) => column.name === 'source_state')) {
                    this.#database.exec("ALTER TABLE handoffs ADD COLUMN source_state TEXT NOT NULL DEFAULT 'active';");
                }
            }
            this.#database.exec("UPDATE authority_meta SET value = '4' WHERE key = 'schema_version';");
            this.#database.exec('COMMIT');
        }
        catch (error) {
            this.#database.exec('ROLLBACK');
            throw error;
        }
        this.#secureFiles();
    }
    #probeClaimOwners(session, resources) {
        const owners = new Map();
        for (const resource of resources) {
            const claim = this.#findConflictingClaim(resource);
            if (!claim || claim.session_id === session.sessionId || owners.has(claim.session_id)) {
                continue;
            }
            const owner = asSession(this.#database
                .prepare(`SELECT session_id, claim_epoch, supervisor_pid, supervisor_birth
             FROM sessions WHERE session_id = ?`)
                .get(claim.session_id));
            let status = 'unknown';
            if (owner && owner.claim_epoch === claim.claim_epoch) {
                try {
                    status = this.#ownerStatus({
                        sessionId: owner.session_id,
                        pid: owner.supervisor_pid,
                        token: owner.supervisor_birth,
                    });
                }
                catch {
                    status = 'unknown';
                }
            }
            owners.set(claim.session_id, { claimEpoch: claim.claim_epoch, status });
        }
        return owners;
    }
    #requireSession(session) {
        const row = asSession(this.#database
            .prepare(`SELECT session_id, state, claim_epoch, authority_version,
                  source_key, worktree_key, app_root_key,
                  supervisor_pid, supervisor_birth, worker_instance, worker_pid,
                  worker_birth, lease_until_ms, source_json, bindings_json
           FROM sessions WHERE session_id = ?`)
            .get(session.sessionId));
        if (!row || !isOperationalState(row.state) || row.claim_epoch !== session.claimEpoch) {
            throw new SessionAuthorityError('SESSION_OWNER_LOST', 'session owner no longer matches the active claim epoch');
        }
        return row;
    }
    #requireRecoverableSession(session) {
        const row = asSession(this.#database
            .prepare(`SELECT session_id, state, claim_epoch, authority_version,
                  source_key, worktree_key, app_root_key,
                  supervisor_pid, supervisor_birth, worker_instance, worker_pid,
                  worker_birth, lease_until_ms, source_json, bindings_json
           FROM sessions WHERE session_id = ?`)
            .get(session.sessionId));
        if (!row ||
            (row.state !== 'blocked' && row.state !== 'handoff_cleanup') ||
            row.claim_epoch !== session.claimEpoch) {
            throw new SessionAuthorityError('SESSION_OWNER_LOST', 'session is not an unchanged recovery contender');
        }
        return row;
    }
    #requireHandoffCleanupOwner(session, targetInstance) {
        const row = this.#requireRecoverableSession(session);
        if (row.state !== 'handoff_cleanup' || row.worker_instance !== targetInstance) {
            throw new SessionAuthorityError('HANDOFF_NOT_AUTHORIZED', 'handoff cleanup is not owned by this recovery worker');
        }
        return row;
    }
    #advanceActiveOperationFence(session, priorAuthorityVersion, nextAuthorityVersion) {
        const active = this.#database
            .prepare(`SELECT operation_id, authority_version FROM operations
         WHERE session_id = ? AND claim_epoch = ? LIMIT 1`)
            .get(session.sessionId, session.claimEpoch);
        if (!active)
            return;
        const context = this.#operationContext.getStore();
        if (!context ||
            context.operationId !== active.operation_id ||
            context.sessionId !== session.sessionId ||
            context.claimEpoch !== session.claimEpoch ||
            context.authorityVersion !== priorAuthorityVersion ||
            active.authority_version !== priorAuthorityVersion) {
            throw new SessionAuthorityError('AUTHORITY_LOST_DURING_OPERATION', 'authority mutation is not owned by the active operation fence');
        }
        const changed = this.#database
            .prepare(`UPDATE operations SET authority_version = ?, lease_until_ms = ?
         WHERE operation_id = ? AND session_id = ? AND claim_epoch = ?
           AND authority_version = ?`)
            .run(nextAuthorityVersion, this.#now() + this.#leaseMs, context.operationId, session.sessionId, session.claimEpoch, priorAuthorityVersion);
        if (changed.changes === 0) {
            throw new SessionAuthorityError('AUTHORITY_LOST_DURING_OPERATION', 'operation fence did not advance atomically');
        }
        context.authorityVersion = nextAuthorityVersion;
    }
    #findClaim(type, key) {
        return asClaim(this.#database
            .prepare(`SELECT resource_type, resource_key, session_id, claim_epoch, lease_until_ms
           FROM claims WHERE resource_type = ? AND resource_key = ?`)
            .get(type, key));
    }
    #findConflictingClaim(resource) {
        return (this.#findClaim(resource.type, resource.key) ??
            (resource.type === 'runner'
                ? this.#findClaim('runner-receipt', resource.key)
                : resource.type === 'device'
                    ? this.#findClaim('device-receipt', resource.key)
                    : null));
    }
    #platformReceiptFromCurrentAuthority(session, platform, receipt) {
        const row = this.#requireSession(session);
        const bindings = JSON.parse(row.bindings_json);
        const device = bindings.device;
        const install = bindings.install;
        const runner = bindings.runner;
        const runnerClaim = this.#database
            .prepare(`SELECT resource_key FROM claims
         WHERE session_id = ? AND claim_epoch = ? AND resource_type = 'runner'`)
            .get(session.sessionId, session.claimEpoch);
        const deviceClaim = this.#database
            .prepare(`SELECT resource_key FROM claims
         WHERE session_id = ? AND claim_epoch = ? AND resource_type = 'device'`)
            .get(session.sessionId, session.claimEpoch);
        const runnerCapabilityHash = typeof runner?.capability === 'string'
            ? createHash('sha256').update(runner.capability).digest('hex')
            : null;
        if (device?.platform !== platform ||
            receipt.sessionId !== session.sessionId ||
            receipt.claimEpoch !== session.claimEpoch ||
            receipt.sourceKey !== row.source_key ||
            receipt.worktreeKey !== row.worktree_key ||
            receipt.appRootKey !== row.app_root_key ||
            receipt.deviceId !== device.deviceId ||
            receipt.appId !== device.appId ||
            receipt.installGeneration !== install?.installGeneration ||
            receipt.artifactDigest !== install?.artifactDigest ||
            receipt.runnerInstanceId !== runner?.instanceId ||
            receipt.runnerPid !== runner?.pid ||
            receipt.runnerProcessBirth !== runner?.processBirth ||
            receipt.runnerPort !== runner?.port ||
            receipt.runnerClaim !== runnerClaim?.resource_key ||
            receipt.deviceClaim !== deviceClaim?.resource_key ||
            receipt.runnerCapabilityHash !== runnerCapabilityHash ||
            typeof runner?.port !== 'number' ||
            typeof runner.capability !== 'string' ||
            typeof runner.instanceId !== 'string' ||
            typeof runner.pid !== 'number' ||
            typeof runner.processBirth !== 'string' ||
            typeof device?.deviceId !== 'string' ||
            typeof device.appId !== 'string' ||
            typeof install?.installGeneration !== 'string') {
            throw new SessionAuthorityError('RUNNER_OWNERSHIP_MISMATCH', 'snapshot receipt does not match exact persistent platform authority');
        }
        return {
            session,
            platform,
            receipt,
            probe: {
                platform,
                port: runner.port,
                capability: runner.capability,
                instanceId: runner.instanceId,
                sessionId: session.sessionId,
                claimEpoch: session.claimEpoch,
                deviceId: device.deviceId,
                appId: device.appId,
                pid: runner.pid,
                processBirth: runner.processBirth,
                installGeneration: install.installGeneration,
            },
        };
    }
    #invalidatePlatformReceipt(session, platform) {
        const row = this.#database
            .prepare(`SELECT receipt_json FROM platform_authority_receipts
         WHERE session_id = ? AND claim_epoch = ? AND platform = ?`)
            .get(session.sessionId, session.claimEpoch, platform);
        if (typeof row?.receipt_json === 'string') {
            const persisted = JSON.parse(row.receipt_json);
            const receipt = persisted.receipt && typeof persisted.receipt === 'object'
                ? persisted.receipt
                : persisted;
            if (typeof receipt.runnerClaim === 'string') {
                this.#database
                    .prepare(`DELETE FROM claims
             WHERE resource_type = 'runner-receipt' AND resource_key = ?
               AND session_id = ? AND claim_epoch = ?`)
                    .run(receipt.runnerClaim, session.sessionId, session.claimEpoch);
            }
            if (typeof receipt.deviceClaim === 'string') {
                this.#database
                    .prepare(`DELETE FROM claims
             WHERE resource_type = 'device-receipt' AND resource_key = ?
               AND session_id = ? AND claim_epoch = ?`)
                    .run(receipt.deviceClaim, session.sessionId, session.claimEpoch);
            }
        }
        this.#database
            .prepare(`DELETE FROM platform_authority_receipts
         WHERE session_id = ? AND claim_epoch = ? AND platform = ?`)
            .run(session.sessionId, session.claimEpoch, platform);
    }
    #capabilityMatches(expected, actual) {
        const expectedDigest = createHash('sha256').update(expected).digest();
        const actualDigest = createHash('sha256').update(actual).digest();
        return timingSafeEqual(expectedDigest, actualDigest);
    }
    #fenceSession(sessionId, now) {
        this.#database.prepare('DELETE FROM claims WHERE session_id = ?').run(sessionId);
        this.#database.prepare('DELETE FROM operations WHERE session_id = ?').run(sessionId);
        this.#database
            .prepare(`UPDATE sessions
         SET state = 'stale', claim_epoch = claim_epoch + 1,
             authority_version = authority_version + 1, updated_ms = ?
         WHERE session_id = ?`)
            .run(now, sessionId);
    }
    #transaction(operation) {
        this.#database.exec('BEGIN IMMEDIATE');
        try {
            const result = operation();
            this.#database.exec('COMMIT');
            this.#secureFiles();
            return result;
        }
        catch (error) {
            this.#database.exec('ROLLBACK');
            this.#secureFiles();
            throw error;
        }
    }
    async #retry(operation, timeoutMs, retryDelayMs) {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            try {
                return operation();
            }
            catch (error) {
                const code = error.code;
                const message = error instanceof Error ? error.message : '';
                if (code !== 'SQLITE_BUSY' && !/database is (?:locked|busy)/i.test(message))
                    throw error;
                if (Date.now() >= deadline) {
                    throw new SessionAuthorityError('AUTHORITY_STORE_BUSY', 'authority registry remained contended past the retry deadline');
                }
                await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
            }
        }
    }
}
export function openSessionRegistry(path, dependencies) {
    const store = openAuthorityStore(path, { sqliteCtor: dependencies.sqliteCtor });
    try {
        return new SessionRegistry(store.database, store.close, store.secureFiles, dependencies);
    }
    catch (error) {
        store.close();
        throw error;
    }
}
