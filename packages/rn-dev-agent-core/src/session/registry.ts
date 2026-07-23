import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  openAuthorityStore,
  type AuthorityDatabase,
  type AuthorityDatabaseCtor,
} from './authority-store.js';

export type OwnerStatus = 'match' | 'mismatch' | 'unknown';

export interface SessionRef {
  sessionId: string;
  claimEpoch: number;
}

export interface SessionOwner {
  sessionId: string;
  pid: number;
  token: string;
}

export interface ResourceClaim {
  type: string;
  key: string;
}

export interface ClaimedResource extends ResourceClaim {
  sessionId: string;
  claimEpoch: number;
  leaseUntilMs: number;
}

export interface OperationRef {
  operationId: string;
  sessionId: string;
  claimEpoch: number;
  authorityVersion: number;
}

export interface HandoffCapability {
  handoffId: string;
  token: string;
}

export interface SessionRegistryDependencies {
  now?: () => number;
  ownerStatus: (owner: SessionOwner) => OwnerStatus;
  leaseMs?: number;
  sqliteCtor?: AuthorityDatabaseCtor | null;
}

interface SessionRow {
  session_id: string;
  source_key: string;
  worktree_key: string;
  app_root_key: string;
  state: string;
  claim_epoch: number;
  authority_version: number;
  supervisor_pid: number;
  supervisor_birth: string;
  worker_instance: string | null;
  worker_pid: number | null;
  worker_birth: string | null;
  lease_until_ms: number;
  source_json: string;
  bindings_json: string;
}

interface ClaimRow {
  resource_type: string;
  resource_key: string;
  session_id: string;
  claim_epoch: number;
  lease_until_ms: number;
}

interface AllocationRow {
  port: number;
}

export interface SessionStatus {
  sessionId: string;
  sourceKey: string;
  worktreeKey: string;
  appRootKey: string;
  state: string;
  claimEpoch: number;
  authorityVersion: number;
  leaseUntilMs: number;
  source: Record<string, unknown>;
  bindings: Record<string, unknown>;
  claims: ClaimedResource[];
  worker: {
    instanceId: string | null;
    pid: number | null;
    birthAvailable: boolean;
  };
}

export interface ControllerBinding {
  sessionId: string;
  claimEpoch: number;
  authorityVersion: number;
  supervisor: { pid: number; token: string };
  worker: { instanceId: string | null; pid: number | null; token: string | null };
}

export class SessionAuthorityError extends Error {
  readonly code: string;
  readonly holder?: { sessionId: string; claimEpoch: number };
  readonly details?: {
    axis?: string;
    expected?: string;
    observed?: string;
    nextAction?: string;
  };

  constructor(
    code: string,
    message: string,
    holder?: { sessionId: string; claimEpoch: number },
    details?: {
      axis?: string;
      expected?: string;
      observed?: string;
      nextAction?: string;
    },
  ) {
    super(`${code}: ${message}`);
    this.name = 'SessionAuthorityError';
    this.code = code;
    this.holder = holder;
    this.details = details;
  }
}

const errorAxes: Record<string, string> = {
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

export function shortAuthorityIdentity(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

export function authorityErrorMeta(error: SessionAuthorityError): Record<string, unknown> {
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
    nextAction:
      error.details?.nextAction ??
      'Run rn_session with action "status" and repair the named authority axis.',
  };
}

const conflictCodes: Record<string, string> = {
  device: 'DEVICE_CLAIM_CONFLICT',
  target: 'TARGET_CLAIM_CONFLICT',
  'metro-port': 'METRO_PORT_CLAIM_CONFLICT',
  'observe-port': 'OBSERVE_PORT_CLAIM_CONFLICT',
  runner: 'RUNNER_CLAIM_CONFLICT',
};

function asSession(row: Record<string, unknown> | undefined): SessionRow | null {
  return row ? (row as unknown as SessionRow) : null;
}

function asClaim(row: Record<string, unknown> | undefined): ClaimRow | null {
  return row ? (row as unknown as ClaimRow) : null;
}

function claimConflict(claim: ClaimRow): SessionAuthorityError {
  const code = conflictCodes[claim.resource_type] ?? 'RESOURCE_CLAIM_CONFLICT';
  return new SessionAuthorityError(code, `${claim.resource_type}:${claim.resource_key} is held`, {
    sessionId: claim.session_id,
    claimEpoch: claim.claim_epoch,
  });
}

function isOperationalState(state: string): boolean {
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

function isFenceableState(state: string): boolean {
  return isOperationalState(state) || state === 'handoff';
}

export class SessionRegistry {
  readonly #database: AuthorityDatabase;
  readonly #close: () => void;
  readonly #secureFiles: () => void;
  readonly #now: () => number;
  readonly #ownerStatus: (owner: SessionOwner) => OwnerStatus;
  readonly #leaseMs: number;

  constructor(
    database: AuthorityDatabase,
    close: () => void,
    secureFiles: () => void,
    dependencies: SessionRegistryDependencies,
  ) {
    this.#database = database;
    this.#close = close;
    this.#secureFiles = secureFiles;
    this.#now = dependencies.now ?? Date.now;
    this.#ownerStatus = dependencies.ownerStatus;
    this.#leaseMs = dependencies.leaseMs ?? 30_000;
    this.#initialize();
  }

  close(): void {
    this.#close();
  }

  createSession(input: {
    sessionId: string;
    sourceKey: string;
    worktreeKey: string;
    appRootKey: string;
    supervisor: { pid: number; token: string };
    worker?: { instanceId: string; pid: number; token: string };
    source?: Record<string, unknown>;
    bindings?: Record<string, unknown>;
  }): SessionRef {
    const now = this.#now();
    this.#database
      .prepare(
        `INSERT INTO sessions(
          session_id, source_key, worktree_key, app_root_key, state,
          claim_epoch, authority_version, supervisor_pid, supervisor_birth,
          worker_instance, worker_pid, worker_birth, heartbeat_ms, lease_until_ms,
          source_json, bindings_json, created_ms, updated_ms
        ) VALUES (?, ?, ?, ?, 'active', 1, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.sessionId,
        input.sourceKey,
        input.worktreeKey,
        input.appRootKey,
        input.supervisor.pid,
        input.supervisor.token,
        input.worker?.instanceId ?? null,
        input.worker?.pid ?? null,
        input.worker?.token ?? null,
        now,
        now + this.#leaseMs,
        JSON.stringify(input.source ?? {}),
        JSON.stringify(input.bindings ?? {}),
        now,
        now,
      );
    this.#secureFiles();
    return { sessionId: input.sessionId, claimEpoch: 1 };
  }

  claimResources(
    session: SessionRef,
    resources: readonly ResourceClaim[],
    options: { allowReclaim?: boolean } = {},
  ): SessionRef {
    const unique = new Map(
      resources.map((resource) => [`${resource.type}\0${resource.key}`, resource]),
    );
    if (unique.size !== resources.length) {
      throw new SessionAuthorityError('DUPLICATE_RESOURCE_CLAIM', 'claim set contains duplicates');
    }

    const probes = this.#probeClaimOwners(session, resources);
    const now = this.#now();

    return this.#transaction(() => {
      const owner = this.#requireSession(session);
      const reclaim = new Set<string>();

      for (const resource of resources) {
        const claim = this.#findClaim(resource.type, resource.key);
        if (
          !claim ||
          (claim.session_id === session.sessionId && claim.claim_epoch === session.claimEpoch)
        ) {
          continue;
        }

        const probe = probes.get(claim.session_id);
        if (!probe || probe.claimEpoch !== claim.claim_epoch) {
          throw claimConflict(claim);
        }
        if (probe.status === 'match') throw claimConflict(claim);
        if (probe.status === 'unknown') {
          if (claim.lease_until_ms < now) {
            throw new SessionAuthorityError(
              'STALE_LEASE_NOT_RECLAIMABLE',
              'expired lease owner identity could not be proven',
              { sessionId: claim.session_id, claimEpoch: claim.claim_epoch },
            );
          }
          throw claimConflict(claim);
        }
        if (options.allowReclaim === false) {
          throw new SessionAuthorityError(
            'SESSION_AUTHORITY_REQUIRED',
            'a proven-stale owner requires explicit adopt_stale before claims transfer',
            { sessionId: claim.session_id, claimEpoch: claim.claim_epoch },
          );
        }
        reclaim.add(claim.session_id);
      }

      for (const sessionId of reclaim) this.#fenceSession(sessionId, now);

      const leaseUntil = now + this.#leaseMs;
      for (const resource of resources) {
        this.#database
          .prepare(
            `INSERT INTO claims(
              resource_type, resource_key, session_id, claim_epoch, lease_until_ms
            ) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(resource_type, resource_key) DO UPDATE SET
              session_id = excluded.session_id,
              claim_epoch = excluded.claim_epoch,
              lease_until_ms = excluded.lease_until_ms`,
          )
          .run(resource.type, resource.key, session.sessionId, session.claimEpoch, leaseUntil);
      }
      this.#database
        .prepare(
          `UPDATE sessions
           SET authority_version = authority_version + 1, updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ?`,
        )
        .run(now, owner.session_id, owner.claim_epoch);
      return session;
    });
  }

  releaseResources(session: SessionRef, resources: readonly ResourceClaim[]): void {
    const now = this.#now();
    this.#transaction(() => {
      this.#requireSession(session);
      for (const resource of resources) {
        this.#database
          .prepare(
            `DELETE FROM claims
             WHERE resource_type = ? AND resource_key = ?
               AND session_id = ? AND claim_epoch = ?`,
          )
          .run(resource.type, resource.key, session.sessionId, session.claimEpoch);
      }
      this.#database
        .prepare(
          `UPDATE sessions SET authority_version = authority_version + 1, updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ?`,
        )
        .run(now, session.sessionId, session.claimEpoch);
    });
  }

  async claimResourcesWithRetry(
    session: SessionRef,
    resources: readonly ResourceClaim[],
    options: { timeoutMs?: number; retryDelayMs?: number } = {},
  ): Promise<SessionRef> {
    return this.#retry(
      () => this.claimResources(session, resources),
      options.timeoutMs ?? 1_000,
      options.retryDelayMs ?? 5,
    );
  }

  renewSession(session: SessionRef): void {
    const now = this.#now();
    this.#transaction(() => {
      this.#requireSession(session);
      const leaseUntil = now + this.#leaseMs;
      this.#database
        .prepare(
          `UPDATE sessions
           SET heartbeat_ms = ?, lease_until_ms = ?, updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ?`,
        )
        .run(now, leaseUntil, now, session.sessionId, session.claimEpoch);
      this.#database
        .prepare(
          `UPDATE claims SET lease_until_ms = ?
           WHERE session_id = ? AND claim_epoch = ?`,
        )
        .run(leaseUntil, session.sessionId, session.claimEpoch);
    });
  }

  async renewSessionWithRetry(
    session: SessionRef,
    options: { timeoutMs?: number; retryDelayMs?: number } = {},
  ): Promise<void> {
    return this.#retry(
      () => this.renewSession(session),
      options.timeoutMs ?? 1_000,
      options.retryDelayMs ?? 5,
    );
  }

  bindWorker(
    session: SessionRef,
    worker: { instanceId: string; pid: number; token: string },
  ): void {
    const now = this.#now();
    this.#transaction(() => {
      this.#requireSession(session);
      this.#database
        .prepare('DELETE FROM operations WHERE session_id = ? AND claim_epoch = ?')
        .run(session.sessionId, session.claimEpoch);
      this.#database
        .prepare(
          `UPDATE sessions
           SET worker_instance = ?, worker_pid = ?, worker_birth = ?,
               authority_version = authority_version + 1, updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ?`,
        )
        .run(
          worker.instanceId,
          worker.pid,
          worker.token,
          now,
          session.sessionId,
          session.claimEpoch,
        );
    });
  }

  replaceDeviceAuthority(
    session: SessionRef,
    input: {
      device: Record<string, unknown>;
      install?: Record<string, unknown>;
      resource?: ResourceClaim;
    },
  ): void {
    const resource =
      input.resource ??
      ({
        type: 'device',
        key: `${String(input.device.platform)}:${String(input.device.deviceId)}`,
      } satisfies ResourceClaim);
    const probes = this.#probeClaimOwners(session, [resource]);
    const now = this.#now();
    this.#transaction(() => {
      const current = this.#requireSession(session);
      const claim = this.#findClaim(resource.type, resource.key);
      if (
        claim &&
        (claim.session_id !== session.sessionId || claim.claim_epoch !== session.claimEpoch)
      ) {
        const probe = probes.get(claim.session_id);
        if (!probe || probe.claimEpoch !== claim.claim_epoch || probe.status !== 'mismatch') {
          throw claimConflict(claim);
        }
        throw new SessionAuthorityError(
          'SESSION_AUTHORITY_REQUIRED',
          'a proven-stale device owner requires explicit adopt_stale before rebinding',
          { sessionId: claim.session_id, claimEpoch: claim.claim_epoch },
        );
      }
      this.#database
        .prepare(
          `DELETE FROM claims
           WHERE session_id = ? AND claim_epoch = ?
             AND resource_type IN ('device', 'target', 'runner')`,
        )
        .run(session.sessionId, session.claimEpoch);
      this.#database
        .prepare(
          `INSERT INTO claims(
            resource_type, resource_key, session_id, claim_epoch, lease_until_ms
          ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          resource.type,
          resource.key,
          session.sessionId,
          session.claimEpoch,
          now + this.#leaseMs,
        );
      const bindings = {
        ...(JSON.parse(current.bindings_json) as Record<string, unknown>),
        device: input.device,
        install: input.install ?? null,
        bundle: null,
        runner: null,
        observe: null,
        proof: null,
        pendingBuild: null,
      };
      this.#database
        .prepare(
          `UPDATE sessions
           SET state = ?, bindings_json = ?, authority_version = authority_version + 1,
               updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ?`,
        )
        .run(
          input.install ? 'device_bound' : 'device_claimed',
          JSON.stringify(bindings),
          now,
          session.sessionId,
          session.claimEpoch,
        );
    });
  }

  updateBindings(
    session: SessionRef,
    input: {
      state?: string;
      bindings: Record<string, unknown>;
      expectedAuthorityVersion?: number;
    },
  ): void {
    const now = this.#now();
    this.#transaction(() => {
      const current = this.#requireSession(session);
      if (
        input.expectedAuthorityVersion !== undefined &&
        current.authority_version !== input.expectedAuthorityVersion
      ) {
        throw new SessionAuthorityError(
          'AUTHORITY_LOST_DURING_OPERATION',
          'session authority version changed before binding commit',
        );
      }
      const bindings = {
        ...(JSON.parse(current.bindings_json) as Record<string, unknown>),
        ...input.bindings,
      };
      this.#database
        .prepare(
          `UPDATE sessions
           SET state = ?, bindings_json = ?, authority_version = authority_version + 1,
               updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ?`,
        )
        .run(
          input.state ?? current.state,
          JSON.stringify(bindings),
          now,
          session.sessionId,
          session.claimEpoch,
        );
    });
  }

  replaceBindingsDuringOperation(
    operation: OperationRef,
    input: {
      state?: string;
      bindings: Record<string, unknown>;
      releaseResources?: readonly ResourceClaim[];
      claimResources?: readonly ResourceClaim[];
    },
  ): OperationRef {
    const now = this.#now();
    return this.#transaction(() => {
      const current = asSession(
        this.#database
          .prepare(
            `SELECT state, claim_epoch, authority_version, bindings_json
             FROM sessions WHERE session_id = ?`,
          )
          .get(operation.sessionId),
      );
      const active = this.#database
        .prepare(
          `SELECT operation_id FROM operations
           WHERE operation_id = ? AND session_id = ? AND claim_epoch = ?
             AND authority_version = ?`,
        )
        .get(
          operation.operationId,
          operation.sessionId,
          operation.claimEpoch,
          operation.authorityVersion,
        );
      if (
        !current ||
        !isOperationalState(current.state) ||
        current.claim_epoch !== operation.claimEpoch ||
        current.authority_version !== operation.authorityVersion ||
        !active
      ) {
        throw new SessionAuthorityError(
          'AUTHORITY_LOST_DURING_OPERATION',
          'operation fence no longer matches current authority',
        );
      }

      for (const resource of input.claimResources ?? []) {
        const claim = this.#findClaim(resource.type, resource.key);
        if (
          claim &&
          (claim.session_id !== operation.sessionId || claim.claim_epoch !== operation.claimEpoch)
        ) {
          throw claimConflict(claim);
        }
      }
      for (const resource of input.releaseResources ?? []) {
        this.#database
          .prepare(
            `DELETE FROM claims
             WHERE resource_type = ? AND resource_key = ?
               AND session_id = ? AND claim_epoch = ?`,
          )
          .run(resource.type, resource.key, operation.sessionId, operation.claimEpoch);
      }
      const leaseUntil = now + this.#leaseMs;
      for (const resource of input.claimResources ?? []) {
        this.#database
          .prepare(
            `INSERT INTO claims(
              resource_type, resource_key, session_id, claim_epoch, lease_until_ms
            ) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(resource_type, resource_key) DO UPDATE SET
              session_id = excluded.session_id,
              claim_epoch = excluded.claim_epoch,
              lease_until_ms = excluded.lease_until_ms`,
          )
          .run(resource.type, resource.key, operation.sessionId, operation.claimEpoch, leaseUntil);
      }

      const nextAuthorityVersion = operation.authorityVersion + 1;
      const bindings = {
        ...(JSON.parse(current.bindings_json) as Record<string, unknown>),
        ...input.bindings,
      };
      this.#database
        .prepare(
          `UPDATE sessions
           SET state = ?, bindings_json = ?, authority_version = ?, updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ? AND authority_version = ?`,
        )
        .run(
          input.state ?? current.state,
          JSON.stringify(bindings),
          nextAuthorityVersion,
          now,
          operation.sessionId,
          operation.claimEpoch,
          operation.authorityVersion,
        );
      this.#database
        .prepare(
          `UPDATE operations SET authority_version = ?, lease_until_ms = ?
           WHERE operation_id = ? AND session_id = ? AND claim_epoch = ?
             AND authority_version = ?`,
        )
        .run(
          nextAuthorityVersion,
          leaseUntil,
          operation.operationId,
          operation.sessionId,
          operation.claimEpoch,
          operation.authorityVersion,
        );
      return { ...operation, authorityVersion: nextAuthorityVersion };
    });
  }

  getSessionStatus(sessionId: string): SessionStatus | null {
    const row = asSession(
      this.#database
        .prepare(
          `SELECT session_id, source_key, worktree_key, app_root_key, state,
                  claim_epoch, authority_version, supervisor_pid, supervisor_birth,
                  worker_instance, worker_pid, worker_birth, lease_until_ms,
                  source_json, bindings_json
           FROM sessions WHERE session_id = ?`,
        )
        .get(sessionId),
    );
    if (!row) return null;
    const claims = this.#database
      .prepare(
        `SELECT resource_type, resource_key, session_id, claim_epoch, lease_until_ms
         FROM claims WHERE session_id = ? AND claim_epoch = ?
         ORDER BY resource_type, resource_key`,
      )
      .all(sessionId, row.claim_epoch)
      .map((claim) => {
        const typed = claim as unknown as ClaimRow;
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
      source: JSON.parse(row.source_json) as Record<string, unknown>,
      bindings: JSON.parse(row.bindings_json) as Record<string, unknown>,
      claims,
      worker: {
        instanceId: row.worker_instance,
        pid: row.worker_pid,
        birthAvailable: row.worker_birth !== null,
      },
    };
  }

  countOtherOperationalSessions(sessionId: string): number {
    const rows = this.#database
      .prepare(
        `SELECT state FROM sessions
         WHERE session_id <> ?`,
      )
      .all(sessionId) as Array<{ state?: unknown }>;
    return rows.filter((row) => typeof row.state === 'string' && isOperationalState(row.state))
      .length;
  }

  findSessionsByWorktree(worktreeKey: string): SessionStatus[] {
    const rows = this.#database
      .prepare(
        `SELECT session_id FROM sessions
         WHERE worktree_key = ? AND state NOT IN ('released', 'stale')
         ORDER BY updated_ms DESC`,
      )
      .all(worktreeKey);
    return rows
      .map((row) => this.getSessionStatus(String((row as Record<string, unknown>).session_id)))
      .filter((status): status is SessionStatus => status !== null);
  }

  getControllerBinding(session: SessionRef): ControllerBinding {
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

  releaseSession(session: SessionRef): void {
    const now = this.#now();
    this.#transaction(() => {
      this.#requireSession(session);
      const active = this.#database
        .prepare(
          `SELECT operation_id, profile FROM operations
           WHERE session_id = ? AND claim_epoch = ? LIMIT 1`,
        )
        .get(session.sessionId, session.claimEpoch) as { profile?: unknown } | undefined;
      if (active && !String(active.profile).startsWith('transition:')) {
        throw new SessionAuthorityError(
          'SESSION_OPERATION_ACTIVE',
          'session cannot be released while an operation is active',
        );
      }
      if (active) {
        this.#database
          .prepare('DELETE FROM operations WHERE session_id = ? AND claim_epoch = ?')
          .run(session.sessionId, session.claimEpoch);
      }
      this.#database
        .prepare('DELETE FROM claims WHERE session_id = ? AND claim_epoch = ?')
        .run(session.sessionId, session.claimEpoch);
      this.#database
        .prepare(
          `UPDATE sessions
           SET state = 'released', claim_epoch = claim_epoch + 1,
               authority_version = authority_version + 1, updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ?`,
        )
        .run(now, session.sessionId, session.claimEpoch);
    });
  }

  discardBlockedSession(session: SessionRef): void {
    const now = this.#now();
    this.#transaction(() => {
      const row = asSession(
        this.#database
          .prepare('SELECT state, claim_epoch FROM sessions WHERE session_id = ?')
          .get(session.sessionId),
      );
      if (!row || row.state !== 'blocked' || row.claim_epoch !== session.claimEpoch) {
        throw new SessionAuthorityError(
          'SESSION_OWNER_LOST',
          'only the unchanged blocked session may be discarded',
        );
      }
      const claim = this.#database
        .prepare('SELECT resource_key FROM claims WHERE session_id = ? LIMIT 1')
        .get(session.sessionId);
      if (claim) {
        throw new SessionAuthorityError(
          'SESSION_AUTHORITY_REQUIRED',
          'blocked session unexpectedly owns resource claims',
        );
      }
      this.#database
        .prepare(
          `UPDATE sessions
           SET state = 'released', claim_epoch = claim_epoch + 1,
               authority_version = authority_version + 1, updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ?`,
        )
        .run(now, session.sessionId, session.claimEpoch);
    });
  }

  prepareHandoff(
    session: SessionRef,
    input: { targetInstance: string; ttlMs?: number },
  ): HandoffCapability {
    const now = this.#now();
    const handoffId = randomBytes(16).toString('hex');
    const token = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(token).digest('hex');
    this.#transaction(() => {
      this.#requireSession(session);
      const active = this.#database
        .prepare(
          `SELECT operation_id, profile FROM operations
           WHERE session_id = ? AND claim_epoch = ? LIMIT 1`,
        )
        .get(session.sessionId, session.claimEpoch) as { profile?: unknown } | undefined;
      if (active && !String(active.profile).startsWith('transition:')) {
        throw new SessionAuthorityError(
          'SESSION_OPERATION_ACTIVE',
          'session cannot enter handoff while an operation is active',
        );
      }
      this.#database
        .prepare(
          `INSERT INTO handoffs(
            handoff_id, session_id, claim_epoch, target_instance,
            token_hash, source_state, expires_ms, consumed_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
        )
        .run(
          handoffId,
          session.sessionId,
          session.claimEpoch,
          input.targetInstance,
          tokenHash,
          this.#requireSession(session).state,
          now + (input.ttlMs ?? 15_000),
        );
      this.#database
        .prepare(
          `UPDATE sessions
           SET state = 'handoff', authority_version = authority_version + 1, updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ?`,
        )
        .run(now, session.sessionId, session.claimEpoch);
    });
    return { handoffId, token };
  }

  cancelHandoff(session: SessionRef, handoffId: string): void {
    const now = this.#now();
    this.#transaction(() => {
      const handoff = this.#database
        .prepare(
          `SELECT session_id, claim_epoch, source_state, consumed_ms
           FROM handoffs WHERE handoff_id = ?`,
        )
        .get(handoffId) as
        | {
            session_id: string;
            claim_epoch: number;
            source_state: string;
            consumed_ms: number | null;
          }
        | undefined;
      if (
        !handoff ||
        handoff.session_id !== session.sessionId ||
        handoff.claim_epoch !== session.claimEpoch
      ) {
        throw new SessionAuthorityError('HANDOFF_NOT_FOUND', 'handoff does not belong to session');
      }
      if (handoff.consumed_ms !== null) {
        throw new SessionAuthorityError('HANDOFF_ALREADY_CONSUMED', 'handoff is already terminal');
      }
      const row = asSession(
        this.#database
          .prepare('SELECT state, claim_epoch FROM sessions WHERE session_id = ?')
          .get(session.sessionId),
      );
      if (!row || row.state !== 'handoff' || row.claim_epoch !== session.claimEpoch) {
        throw new SessionAuthorityError('SESSION_OWNER_LOST', 'handoff source owner changed');
      }
      this.#database
        .prepare(
          `UPDATE sessions
           SET state = ?, authority_version = authority_version + 1, updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ?`,
        )
        .run(handoff.source_state, now, session.sessionId, session.claimEpoch);
      this.#database
        .prepare('UPDATE handoffs SET consumed_ms = ? WHERE handoff_id = ?')
        .run(now, handoffId);
    });
  }

  getHandoffOwner(handoffId: string): string | null {
    const row = this.#database
      .prepare('SELECT session_id FROM handoffs WHERE handoff_id = ?')
      .get(handoffId) as { session_id?: unknown } | undefined;
    return typeof row?.session_id === 'string' ? row.session_id : null;
  }

  validateHandoffInto(
    target: SessionRef,
    input: { handoffId: string; token: string; targetInstance: string },
  ): void {
    const targetRow = this.#requireSession(target);
    if (targetRow.worker_instance !== input.targetInstance) {
      throw new SessionAuthorityError(
        'HANDOFF_TARGET_MISMATCH',
        'handoff target is not the current fenced worker instance',
      );
    }
    const handoff = this.#database
      .prepare(
        `SELECT session_id, claim_epoch, target_instance, token_hash, expires_ms, consumed_ms
         FROM handoffs WHERE handoff_id = ?`,
      )
      .get(input.handoffId) as
      | {
          session_id: string;
          claim_epoch: number;
          target_instance: string;
          token_hash: string;
          expires_ms: number;
          consumed_ms: number | null;
        }
      | undefined;
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
      throw new SessionAuthorityError(
        'HANDOFF_TARGET_MISMATCH',
        'handoff target instance does not match',
      );
    }
    const expected = Buffer.from(handoff.token_hash, 'hex');
    const actual = createHash('sha256').update(input.token).digest();
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw new SessionAuthorityError('HANDOFF_TOKEN_INVALID', 'handoff capability is invalid');
    }
    const prior = this.getSessionStatus(handoff.session_id);
    if (
      !prior ||
      prior.state !== 'handoff' ||
      prior.claimEpoch !== handoff.claim_epoch ||
      prior.sourceKey !== targetRow.source_key ||
      prior.worktreeKey !== targetRow.worktree_key ||
      prior.appRootKey !== targetRow.app_root_key
    ) {
      throw new SessionAuthorityError(
        'HANDOFF_NOT_AUTHORIZED',
        'handoff no longer matches the exact source owner',
      );
    }
  }

  acceptHandoff(input: {
    handoffId: string;
    token: string;
    targetInstance: string;
    supervisor: { pid: number; token: string };
  }): SessionRef {
    const now = this.#now();
    return this.#transaction(() => {
      const handoff = this.#database
        .prepare(
          `SELECT handoff_id, session_id, claim_epoch, target_instance,
                  token_hash, expires_ms, consumed_ms
           FROM handoffs WHERE handoff_id = ?`,
        )
        .get(input.handoffId) as
        | {
            handoff_id: string;
            session_id: string;
            claim_epoch: number;
            target_instance: string;
            token_hash: string;
            expires_ms: number;
            consumed_ms: number | null;
          }
        | undefined;
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
        throw new SessionAuthorityError(
          'HANDOFF_TARGET_MISMATCH',
          'handoff target instance does not match',
        );
      }
      const expected = Buffer.from(handoff.token_hash, 'hex');
      const actual = Buffer.from(createHash('sha256').update(input.token).digest('hex'), 'hex');
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
        throw new SessionAuthorityError('HANDOFF_TOKEN_INVALID', 'handoff capability is invalid');
      }

      const session = asSession(
        this.#database
          .prepare(
            `SELECT session_id, state, claim_epoch, authority_version,
                    supervisor_pid, supervisor_birth, lease_until_ms, bindings_json
             FROM sessions WHERE session_id = ?`,
          )
          .get(handoff.session_id),
      );
      if (!session || session.state !== 'handoff' || session.claim_epoch !== handoff.claim_epoch) {
        throw new SessionAuthorityError(
          'SESSION_OWNER_LOST',
          'handoff no longer matches the session claim epoch',
        );
      }

      const nextEpoch = session.claim_epoch + 1;
      const leaseUntil = now + this.#leaseMs;
      this.#database
        .prepare(
          `DELETE FROM claims
           WHERE session_id = ? AND claim_epoch = ?
             AND resource_type NOT IN ('source', 'metro-port', 'observe-port', 'device')`,
        )
        .run(session.session_id, session.claim_epoch);
      this.#database
        .prepare(
          `UPDATE claims SET claim_epoch = ?, lease_until_ms = ?
           WHERE session_id = ? AND claim_epoch = ?`,
        )
        .run(nextEpoch, leaseUntil, session.session_id, session.claim_epoch);
      this.#database
        .prepare(
          `UPDATE sessions
           SET state = 'source_bound', claim_epoch = ?, authority_version = authority_version + 1,
               supervisor_pid = ?, supervisor_birth = ?, heartbeat_ms = ?,
               lease_until_ms = ?, bindings_json = ?, updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ?`,
        )
        .run(
          nextEpoch,
          input.supervisor.pid,
          input.supervisor.token,
          now,
          leaseUntil,
          JSON.stringify({
            ...JSON.parse(session.bindings_json),
            bundle: null,
            runner: null,
            observe: null,
            proof: null,
            pendingBuild: null,
          }),
          now,
          session.session_id,
          session.claim_epoch,
        );
      this.#database
        .prepare('UPDATE handoffs SET consumed_ms = ? WHERE handoff_id = ?')
        .run(now, handoff.handoff_id);
      return { sessionId: session.session_id, claimEpoch: nextEpoch };
    });
  }

  acceptHandoffInto(
    target: SessionRef,
    input: { handoffId: string; token: string; targetInstance: string },
  ): SessionRef {
    const now = this.#now();
    return this.#transaction(() => {
      const targetRow = this.#requireSession(target);
      if (targetRow.worker_instance !== input.targetInstance) {
        throw new SessionAuthorityError(
          'HANDOFF_TARGET_MISMATCH',
          'handoff target is not the current fenced worker instance',
        );
      }
      const handoff = this.#database
        .prepare(
          `SELECT handoff_id, session_id, claim_epoch, target_instance,
                  token_hash, expires_ms, consumed_ms
           FROM handoffs WHERE handoff_id = ?`,
        )
        .get(input.handoffId) as
        | {
            handoff_id: string;
            session_id: string;
            claim_epoch: number;
            target_instance: string;
            token_hash: string;
            expires_ms: number;
            consumed_ms: number | null;
          }
        | undefined;
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
        throw new SessionAuthorityError(
          'HANDOFF_TARGET_MISMATCH',
          'handoff target instance does not match',
        );
      }
      const expected = Buffer.from(handoff.token_hash, 'hex');
      const actual = createHash('sha256').update(input.token).digest();
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
        throw new SessionAuthorityError('HANDOFF_TOKEN_INVALID', 'handoff capability is invalid');
      }
      const prior = asSession(
        this.#database
          .prepare(
            `SELECT session_id, source_key, worktree_key, app_root_key, state,
                    claim_epoch, authority_version, bindings_json
             FROM sessions WHERE session_id = ?`,
          )
          .get(handoff.session_id),
      );
      if (!prior || prior.state !== 'handoff' || prior.claim_epoch !== handoff.claim_epoch) {
        throw new SessionAuthorityError(
          'HANDOFF_NOT_AUTHORIZED',
          'handoff no longer matches the live owner epoch',
        );
      }
      if (
        prior.source_key !== targetRow.source_key ||
        prior.worktree_key !== targetRow.worktree_key ||
        prior.app_root_key !== targetRow.app_root_key
      ) {
        throw new SessionAuthorityError(
          'SOURCE_WORKTREE_MISMATCH',
          'handoff source does not match the target session',
        );
      }
      const active = this.#database
        .prepare(
          `SELECT operation_id FROM operations
           WHERE session_id = ?
              OR (session_id = ? AND profile NOT LIKE 'transition:%')
           LIMIT 1`,
        )
        .get(prior.session_id, target.sessionId);
      if (active) {
        throw new SessionAuthorityError(
          'SESSION_OPERATION_ACTIVE',
          'handoff cannot transfer while either session has an active operation',
        );
      }

      this.#database
        .prepare(
          `DELETE FROM claims
           WHERE session_id = ? AND claim_epoch = ?`,
        )
        .run(target.sessionId, target.claimEpoch);
      this.#database
        .prepare(
          `DELETE FROM claims
           WHERE session_id = ? AND claim_epoch = ?
             AND resource_type NOT IN ('source', 'metro-port', 'observe-port', 'device')`,
        )
        .run(prior.session_id, prior.claim_epoch);
      this.#database
        .prepare(
          `UPDATE claims SET session_id = ?, claim_epoch = ?, lease_until_ms = ?
           WHERE session_id = ? AND claim_epoch = ?`,
        )
        .run(
          target.sessionId,
          target.claimEpoch,
          now + this.#leaseMs,
          prior.session_id,
          prior.claim_epoch,
        );
      const bindings = JSON.parse(prior.bindings_json) as Record<string, unknown>;
      this.#database
        .prepare(
          `UPDATE sessions
           SET state = 'source_bound', bindings_json = ?,
               authority_version = authority_version + 1, updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ?`,
        )
        .run(
          JSON.stringify({
            ...bindings,
            bundle: null,
            runner: null,
            observe: null,
            proof: null,
            pendingBuild: null,
          }),
          now,
          target.sessionId,
          target.claimEpoch,
        );
      this.#database
        .prepare(
          `UPDATE sessions
           SET state = 'released', claim_epoch = claim_epoch + 1,
               authority_version = authority_version + 1, updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ?`,
        )
        .run(now, prior.session_id, prior.claim_epoch);
      this.#database
        .prepare('UPDATE handoffs SET consumed_ms = ? WHERE handoff_id = ?')
        .run(now, handoff.handoff_id);
      return target;
    });
  }

  beginOperation(
    session: SessionRef,
    operation: { operationId: string; tool: string; profile: string },
  ): OperationRef {
    const now = this.#now();
    return this.#transaction(() => {
      const owner = this.#requireSession(session);
      const active = this.#database
        .prepare(
          `SELECT operation_id FROM operations
           WHERE session_id = ? AND claim_epoch = ? LIMIT 1`,
        )
        .get(session.sessionId, session.claimEpoch);
      if (active) {
        throw new SessionAuthorityError(
          'OPERATION_ALREADY_IN_PROGRESS',
          'session already has an active fenced operation',
        );
      }
      this.#database
        .prepare(
          `INSERT INTO operations(
            operation_id, session_id, claim_epoch, authority_version,
            tool, profile, started_ms, lease_until_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          operation.operationId,
          session.sessionId,
          session.claimEpoch,
          owner.authority_version,
          operation.tool,
          operation.profile,
          now,
          now + this.#leaseMs,
        );
      return {
        operationId: operation.operationId,
        sessionId: session.sessionId,
        claimEpoch: session.claimEpoch,
        authorityVersion: owner.authority_version,
      };
    });
  }

  refreshOperation(operation: OperationRef): OperationRef {
    const now = this.#now();
    return this.#transaction(() => {
      const session = asSession(
        this.#database
          .prepare(
            `SELECT state, claim_epoch, authority_version
             FROM sessions WHERE session_id = ?`,
          )
          .get(operation.sessionId),
      );
      const active = this.#database
        .prepare(
          `SELECT authority_version FROM operations
           WHERE operation_id = ? AND session_id = ? AND claim_epoch = ?`,
        )
        .get(operation.operationId, operation.sessionId, operation.claimEpoch) as
        | { authority_version?: unknown }
        | undefined;
      if (
        !session ||
        !isFenceableState(session.state) ||
        session.claim_epoch !== operation.claimEpoch ||
        active?.authority_version !== operation.authorityVersion ||
        session.authority_version < operation.authorityVersion
      ) {
        throw new SessionAuthorityError(
          'AUTHORITY_LOST_DURING_OPERATION',
          'transition fence no longer matches current authority',
        );
      }
      this.#database
        .prepare(
          `UPDATE operations SET authority_version = ?, lease_until_ms = ?
           WHERE operation_id = ? AND authority_version = ?`,
        )
        .run(
          session.authority_version,
          now + this.#leaseMs,
          operation.operationId,
          operation.authorityVersion,
        );
      return { ...operation, authorityVersion: session.authority_version };
    });
  }

  endOperation(operation: OperationRef): void {
    this.#transaction(() => {
      const session = asSession(
        this.#database
          .prepare(
            `SELECT state, claim_epoch, authority_version
             FROM sessions WHERE session_id = ?`,
          )
          .get(operation.sessionId),
      );
      const active = this.#database
        .prepare(
          `SELECT operation_id FROM operations
           WHERE operation_id = ? AND session_id = ? AND claim_epoch = ?
             AND authority_version = ?`,
        )
        .get(
          operation.operationId,
          operation.sessionId,
          operation.claimEpoch,
          operation.authorityVersion,
        );
      if (
        !session ||
        !isFenceableState(session.state) ||
        session.claim_epoch !== operation.claimEpoch ||
        session.authority_version !== operation.authorityVersion ||
        !active
      ) {
        throw new SessionAuthorityError(
          'AUTHORITY_LOST_DURING_OPERATION',
          'operation fence no longer matches current authority',
        );
      }
      this.#database
        .prepare('DELETE FROM operations WHERE operation_id = ?')
        .run(operation.operationId);
    });
  }

  cancelOperation(operation: OperationRef): void {
    this.#transaction(() => {
      this.#database
        .prepare(
          `DELETE FROM operations
           WHERE operation_id = ? AND session_id = ? AND claim_epoch = ?
             AND authority_version = ?`,
        )
        .run(
          operation.operationId,
          operation.sessionId,
          operation.claimEpoch,
          operation.authorityVersion,
        );
    });
  }

  verifyOperation(operation: OperationRef): void {
    const session = asSession(
      this.#database
        .prepare(
          `SELECT state, claim_epoch, authority_version
           FROM sessions WHERE session_id = ?`,
        )
        .get(operation.sessionId),
    );
    const active = this.#database
      .prepare(
        `SELECT operation_id FROM operations
         WHERE operation_id = ? AND session_id = ? AND claim_epoch = ?
           AND authority_version = ?`,
      )
      .get(
        operation.operationId,
        operation.sessionId,
        operation.claimEpoch,
        operation.authorityVersion,
      );
    if (
      !session ||
      !isFenceableState(session.state) ||
      session.claim_epoch !== operation.claimEpoch ||
      session.authority_version !== operation.authorityVersion ||
      !active
    ) {
      throw new SessionAuthorityError(
        'AUTHORITY_LOST_DURING_OPERATION',
        'operation fence no longer matches current authority',
      );
    }
  }

  renewOperation(operation: OperationRef): void {
    const now = this.#now();
    this.#transaction(() => {
      this.verifyOperation(operation);
      this.#database
        .prepare('UPDATE operations SET lease_until_ms = ? WHERE operation_id = ?')
        .run(now + this.#leaseMs, operation.operationId);
    });
  }

  getClaim(type: string, key: string): ClaimedResource | null {
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

  allocatePort(input: {
    service: string;
    worktreeKey: string;
    uid: string;
    base: number;
    span: number;
  }): number {
    if (
      !Number.isSafeInteger(input.base) ||
      input.base < 1 ||
      !Number.isSafeInteger(input.span) ||
      input.span < 1 ||
      input.base + input.span > 65_536
    ) {
      throw new SessionAuthorityError('INVALID_PORT_RANGE', 'port allocation range is invalid');
    }

    return this.#transaction(() => {
      const existing = this.#database
        .prepare('SELECT port FROM allocations WHERE service = ? AND worktree_key = ?')
        .get(input.service, input.worktreeKey) as AllocationRow | undefined;
      if (existing) return existing.port;

      const digest = createHash('sha256')
        .update(`${input.uid}\0${input.worktreeKey}\0${input.service}`)
        .digest();
      const preferred = digest.readUInt32BE(0) % input.span;
      for (let offset = 0; offset < input.span; offset += 1) {
        const port = input.base + ((preferred + offset) % input.span);
        const occupied = this.#database
          .prepare('SELECT worktree_key FROM allocations WHERE service = ? AND port = ?')
          .get(input.service, port);
        if (occupied) continue;
        this.#database
          .prepare(
            `INSERT INTO allocations(service, worktree_key, port, generation)
             VALUES (?, ?, ?, 1)`,
          )
          .run(input.service, input.worktreeKey, port);
        return port;
      }
      throw new SessionAuthorityError(
        'PORT_RANGE_EXHAUSTED',
        `no ${input.service} port is available in the configured range`,
      );
    });
  }

  #initialize(): void {
    const schema = this.#database
      .prepare('SELECT value FROM authority_meta WHERE key = ?')
      .get('schema_version')?.value;
    const version = Number(schema);
    if (!Number.isSafeInteger(version) || version < 1 || version > 3) {
      throw new SessionAuthorityError(
        'AUTHORITY_STORE_UNAVAILABLE',
        version > 3
          ? `authority registry schema ${version} is newer than supported schema 3`
          : 'authority registry schema version is invalid',
      );
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
      `);
      if (version < 3) {
        const columns = this.#database.prepare('PRAGMA table_info(handoffs)').all();
        if (!columns.some((column) => column.name === 'source_state')) {
          this.#database.exec(
            "ALTER TABLE handoffs ADD COLUMN source_state TEXT NOT NULL DEFAULT 'active';",
          );
        }
      }
      this.#database.exec(
        "UPDATE authority_meta SET value = '3' WHERE key = 'schema_version';",
      );
      this.#database.exec('COMMIT');
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
    this.#secureFiles();
  }

  #probeClaimOwners(
    session: SessionRef,
    resources: readonly ResourceClaim[],
  ): Map<string, { claimEpoch: number; status: OwnerStatus }> {
    const owners = new Map<string, { claimEpoch: number; status: OwnerStatus }>();
    for (const resource of resources) {
      const claim = this.#findClaim(resource.type, resource.key);
      if (!claim || claim.session_id === session.sessionId || owners.has(claim.session_id)) {
        continue;
      }
      const owner = asSession(
        this.#database
          .prepare(
            `SELECT session_id, claim_epoch, supervisor_pid, supervisor_birth
             FROM sessions WHERE session_id = ?`,
          )
          .get(claim.session_id),
      );
      let status: OwnerStatus = 'unknown';
      if (owner && owner.claim_epoch === claim.claim_epoch) {
        try {
          status = this.#ownerStatus({
            sessionId: owner.session_id,
            pid: owner.supervisor_pid,
            token: owner.supervisor_birth,
          });
        } catch {
          status = 'unknown';
        }
      }
      owners.set(claim.session_id, { claimEpoch: claim.claim_epoch, status });
    }
    return owners;
  }

  #requireSession(session: SessionRef): SessionRow {
    const row = asSession(
      this.#database
        .prepare(
          `SELECT session_id, state, claim_epoch, authority_version,
                  source_key, worktree_key, app_root_key,
                  supervisor_pid, supervisor_birth, worker_instance, worker_pid,
                  worker_birth, lease_until_ms, source_json, bindings_json
           FROM sessions WHERE session_id = ?`,
        )
        .get(session.sessionId),
    );
    if (!row || !isOperationalState(row.state) || row.claim_epoch !== session.claimEpoch) {
      throw new SessionAuthorityError(
        'SESSION_OWNER_LOST',
        'session owner no longer matches the active claim epoch',
      );
    }
    return row;
  }

  #findClaim(type: string, key: string): ClaimRow | null {
    return asClaim(
      this.#database
        .prepare(
          `SELECT resource_type, resource_key, session_id, claim_epoch, lease_until_ms
           FROM claims WHERE resource_type = ? AND resource_key = ?`,
        )
        .get(type, key),
    );
  }

  #fenceSession(sessionId: string, now: number): void {
    this.#database.prepare('DELETE FROM claims WHERE session_id = ?').run(sessionId);
    this.#database.prepare('DELETE FROM operations WHERE session_id = ?').run(sessionId);
    this.#database
      .prepare(
        `UPDATE sessions
         SET state = 'stale', claim_epoch = claim_epoch + 1,
             authority_version = authority_version + 1, updated_ms = ?
         WHERE session_id = ?`,
      )
      .run(now, sessionId);
  }

  #transaction<T>(operation: () => T): T {
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.#database.exec('COMMIT');
      this.#secureFiles();
      return result;
    } catch (error) {
      this.#database.exec('ROLLBACK');
      this.#secureFiles();
      throw error;
    }
  }

  async #retry<T>(operation: () => T, timeoutMs: number, retryDelayMs: number): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        return operation();
      } catch (error) {
        const code = (error as { code?: string }).code;
        const message = error instanceof Error ? error.message : '';
        if (code !== 'SQLITE_BUSY' && !/database is (?:locked|busy)/i.test(message)) throw error;
        if (Date.now() >= deadline) {
          throw new SessionAuthorityError(
            'AUTHORITY_STORE_BUSY',
            'authority registry remained contended past the retry deadline',
          );
        }
        await new Promise<void>((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }
  }
}

export function openSessionRegistry(
  path: string,
  dependencies: SessionRegistryDependencies,
): SessionRegistry {
  const store = openAuthorityStore(path, { sqliteCtor: dependencies.sqliteCtor });
  try {
    return new SessionRegistry(store.database, store.close, store.secureFiles, dependencies);
  } catch (error) {
    store.close();
    throw error;
  }
}
