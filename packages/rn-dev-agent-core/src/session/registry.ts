import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  openAuthorityStore,
  type AuthorityDatabase,
  type AuthorityDatabaseCtor,
} from './authority-store.js';
import {
  hasCompleteRecorderCleanupIdentity,
  hasCompleteRunnerCleanupIdentity,
} from './cleanup-identity.js';
import { NON_GIT_DECLARATION_NEXT_ACTION } from './declared-source-contract.js';
import { probeMetroListener } from './metro-binding.js';
import type { AuthorityAxis } from './tool-profiles.js';

const INITIALIZATION_WAIT = new Int32Array(new SharedArrayBuffer(4));
export const AUTHORITY_REGISTRY_SCHEMA_VERSION = 4;

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

export interface PlatformAuthorityProbe {
  platform: string;
  port: number;
  capability: string;
  instanceId: string;
  sessionId: string;
  claimEpoch: number;
  deviceId: string;
  appId: string;
  pid: number;
  processBirth: string;
  installGeneration: string;
}

export interface HandoffCapability {
  handoffId: string;
  token: string;
}

export interface HandoffCleanupPlan {
  handoffId?: string;
  targetSessionId?: string;
  targetClaimEpoch?: number;
  metro?: Record<string, unknown>;
  observe?: Record<string, unknown>;
  runner?: Record<string, unknown>;
  recorder?: Record<string, unknown>;
}

export interface ManagedMetroHandoffReservation {
  handoffId: string;
  sourceClaimEpoch: number;
  targetSessionId: string;
  targetClaimEpoch: number;
  targetInstance: string;
  phase: 'shutdown_reserved' | 'shutdown_completed';
  metro: Record<string, unknown>;
}

interface HandoffIntoInput {
  handoffId: string;
  token: string;
  targetInstance: string;
}

interface HandoffIntoContext {
  targetRow: SessionRow;
  handoff: {
    handoff_id: string;
    session_id: string;
    claim_epoch: number;
    target_instance: string;
    token_hash: string;
    expires_ms: number;
    consumed_ms: number | null;
  };
  prior: SessionRow;
  bindings: Record<string, unknown>;
  reservation: ManagedMetroHandoffReservation | null;
}

function referencesMetroEvidenceSocket(value: unknown, path: string): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => referencesMetroEvidenceSocket(entry, path));
  }
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (record.runtimeEvidenceSocket === path) return true;
  return Object.values(record).some((entry) => referencesMetroEvidenceSocket(entry, path));
}

export interface SessionRegistryDependencies {
  now?: () => number;
  ownerStatus: (owner: SessionOwner) => OwnerStatus;
  listenerStatus?: (port: number) => 'absent' | 'listening' | 'unknown';
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
  heartbeat_ms: number;
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
  worktree_key: string;
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
  private supplementalMeta?: Record<string, unknown>;
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

  attachMeta(meta: Record<string, unknown>): void {
    this.supplementalMeta = { ...this.supplementalMeta, ...meta };
  }

  getSupplementalMeta(): Record<string, unknown> {
    return { ...this.supplementalMeta };
  }
}

// GH #672: recovery handles are bounded. `status` rotates one that is expired or
// inside the renewal window, so an advertised handle always validates; a fresher
// handle is returned unchanged so a caller that just read one can still use it.
const RECOVERY_HANDLE_TTL_MS = 5 * 60_000;
const RECOVERY_HANDLE_RENEW_MS = 60_000;

export type RecoveryRequirement = 'none' | 'adoption' | 'attach' | 'transport-restart';

export interface StartupCleanupBlocker {
  code: string;
  reason: string;
  nextAction?: string;
}

export interface RecoveryRequirementInspection {
  requirement: RecoveryRequirement;
  priorOwner: 'stale' | 'live' | 'unknown' | 'absent';
  /** L4 (issue 654): bounded holder heartbeat age, surfaced only for grouped-v1 contenders. */
  priorOwnerHeartbeatAgeMs?: number;
  startupCleanupBlocked?: StartupCleanupBlocker;
  nextAction: string;
}

export type StartupCleanupResource =
  | 'androidMetroReverse'
  | 'recorder'
  | 'runner'
  | 'observe'
  | 'metro';

export interface StartupOwnerCleanupPlan {
  resumed: boolean;
  obligations: Partial<Record<StartupCleanupResource, Record<string, unknown>>>;
  integration: Record<string, unknown> | null;
}

export interface StaleResourceReleaseOffer {
  token: string;
  expiresMs: number;
  priorSessionId: string;
  priorClaimEpoch: number;
  obligations: readonly ('androidMetroReverse' | 'runner' | 'recorder')[];
}

export type StaleReleaseObligation = 'androidMetroReverse' | 'runner' | 'recorder';

interface StaleDeviceFamily {
  claims: ClaimRow[];
  androidMetroReverse: Record<string, unknown> | null;
  runner: Record<string, unknown> | null;
  recorder: Record<string, unknown> | null;
}

const errorAxes: Record<string, string> = {
  SESSION_AUTHORITY_REQUIRED: 'C',
  SESSION_OWNER_LOST: 'C',
  OPERATION_ALREADY_IN_PROGRESS: 'C',
  SOURCE_WORKTREE_MISMATCH: 'S',
  SOURCE_REVISION_NOT_BUNDLED: 'S',
  NON_GIT_MANIFEST_REQUIRED: 'S',
  APP_INSTALL_IDENTITY_CHANGED: 'I',
  METRO_PORT_CLAIM_CONFLICT: 'M',
  PORT_OCCUPIED_UNOWNED: 'M',
  METRO_AUTHORITY_MISMATCH: 'M',
  METRO_INSTANCE_CHANGED: 'M',
  METRO_ORIGIN_MISMATCH: 'A',
  BUNDLE_HANDSHAKE_UNAVAILABLE: 'B',
  BUNDLE_IDENTITY_MISMATCH: 'B',
  CDP_TARGET_AUTHORITY_MISMATCH: 'B',
  TARGET_CLAIM_CONFLICT: 'B',
  DEVICE_CLAIM_CONFLICT: 'D',
  DEVICE_DISCOVERY_UNAVAILABLE: 'D',
  DEVICE_NOT_FOUND: 'D',
  DEVICE_RECEIPT_INCOMPATIBLE: 'D',
  DEVICE_AUTHORITY_MISMATCH: 'D',
  PLATFORM_AUTHORITY_MISMATCH: 'D',
  RUNNER_OWNERSHIP_MISMATCH: 'R',
  RUNNER_ADOPTION_REQUIRED: 'R',
  AUTOMATION_CLEANUP_UNPROVEN: 'R',
  OBSERVE_AUTHORITY_MISMATCH: 'O',
  PROOF_AUTHORITY_MISMATCH: 'P',
};

// Codes whose repair is a named declaration/configuration path, not another status read.
const errorNextActions: Record<string, string> = {
  NON_GIT_MANIFEST_REQUIRED: NON_GIT_DECLARATION_NEXT_ACTION,
};

export function authorityRemedyNextAction(code: string): string | undefined {
  return errorNextActions[code];
}

export function shortAuthorityIdentity(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

export function authorityErrorMeta(error: SessionAuthorityError): Record<string, unknown> {
  return {
    ...error.getSupplementalMeta(),
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
      errorNextActions[error.code] ??
      'Run rn_session with action "status" and repair the named authority axis.',
  };
}

const conflictCodes: Record<string, string> = {
  device: 'DEVICE_CLAIM_CONFLICT',
  'device-receipt': 'DEVICE_CLAIM_CONFLICT',
  target: 'TARGET_CLAIM_CONFLICT',
  'metro-port': 'METRO_PORT_CLAIM_CONFLICT',
  'observe-port': 'OBSERVE_PORT_CLAIM_CONFLICT',
  runner: 'RUNNER_CLAIM_CONFLICT',
  'runner-receipt': 'RUNNER_CLAIM_CONFLICT',
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

function readStartupCleanupBlocker(bindingsJson: string): StartupCleanupBlocker | undefined {
  let journal: Record<string, unknown> | undefined;
  try {
    const bindings = JSON.parse(bindingsJson) as Record<string, unknown>;
    const value = bindings.startupCleanup;
    journal = value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
  if (!journal || typeof journal.finishedAt === 'number') return undefined;
  const refusal = journal.refusal;
  if (!refusal || typeof refusal !== 'object') return undefined;
  const record = refusal as Record<string, unknown>;
  if (typeof record.code !== 'string' || typeof record.reason !== 'string') return undefined;
  return {
    code: record.code,
    reason: record.reason,
    ...(typeof record.nextAction === 'string' ? { nextAction: record.nextAction } : {}),
  };
}

function bindingsRunnerPresent(bindingsJson: string): boolean {
  const bindings = JSON.parse(bindingsJson) as Record<string, unknown>;
  return Boolean(bindings.runner && typeof bindings.runner === 'object');
}

function managedMetroHandoffReservation(
  bindings: Record<string, unknown>,
): ManagedMetroHandoffReservation | null {
  const value = bindings.managedMetroHandoffReservation;
  if (value === null || value === undefined) return null;
  if (
    typeof value !== 'object' ||
    typeof (value as Record<string, unknown>).handoffId !== 'string' ||
    typeof (value as Record<string, unknown>).sourceClaimEpoch !== 'number' ||
    typeof (value as Record<string, unknown>).targetSessionId !== 'string' ||
    typeof (value as Record<string, unknown>).targetClaimEpoch !== 'number' ||
    typeof (value as Record<string, unknown>).targetInstance !== 'string' ||
    !['shutdown_reserved', 'shutdown_completed'].includes(
      String((value as Record<string, unknown>).phase),
    ) ||
    typeof (value as Record<string, unknown>).metro !== 'object' ||
    (value as Record<string, unknown>).metro === null ||
    typeof ((value as Record<string, unknown>).metro as Record<string, unknown>).sourceSessionId !==
      'string'
  ) {
    throw new SessionAuthorityError(
      'HANDOFF_NOT_AUTHORIZED',
      'managed Metro handoff reservation is malformed',
    );
  }
  return value as ManagedMetroHandoffReservation;
}

export class SessionRegistry {
  readonly #database: AuthorityDatabase;
  readonly #close: () => void;
  readonly #secureFiles: () => void;
  readonly #now: () => number;
  readonly #ownerStatus: (owner: SessionOwner) => OwnerStatus;
  readonly #listenerStatus: (port: number) => 'absent' | 'listening' | 'unknown';
  readonly #leaseMs: number;
  readonly #operationContext = new AsyncLocalStorage<OperationRef>();
  readonly #pendingPlatformReceipts = new Map<
    string,
    {
      session: SessionRef;
      platform: string;
      receipt: Record<string, unknown>;
      probe: PlatformAuthorityProbe;
    }[]
  >();

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
    this.#listenerStatus =
      dependencies.listenerStatus ?? ((port) => probeMetroListener(port).status);
    this.#leaseMs = dependencies.leaseMs ?? 30_000;
    this.#initializeWithRetry();
  }

  close(): void {
    this.#close();
  }

  runWithOperation<T>(operation: OperationRef, callback: () => Promise<T>): Promise<T> {
    return this.#operationContext.run(operation, callback);
  }

  currentOperation(): OperationRef | undefined {
    const operation = this.#operationContext.getStore();
    if (!operation) return undefined;
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
    return session &&
      isFenceableState(session.state) &&
      session.claim_epoch === operation.claimEpoch &&
      session.authority_version === operation.authorityVersion &&
      active
      ? operation
      : undefined;
  }

  hasActiveBundleOperation(session: SessionRef): boolean {
    return Boolean(
      this.#database
        .prepare(
          `SELECT operation_id FROM operations
           WHERE session_id = ? AND claim_epoch = ? AND instr(profile, 'B') > 0
           LIMIT 1`,
        )
        .get(session.sessionId, session.claimEpoch),
    );
  }

  operationHasAxis(operation: OperationRef, axis: AuthorityAxis): boolean {
    this.verifyOperation(operation);
    const pendingAxis = `~${axis}`;
    return Boolean(
      this.#database
        .prepare(
          `SELECT operation_id FROM operations
           WHERE operation_id = ? AND session_id = ? AND claim_epoch = ?
             AND authority_version = ?
             AND instr(replace(profile, ?, ''), ?) > 0`,
        )
        .get(
          operation.operationId,
          operation.sessionId,
          operation.claimEpoch,
          operation.authorityVersion,
          pendingAxis,
          axis,
        ),
    );
  }

  beginOperationAxisAdmission(operation: OperationRef, axis: AuthorityAxis): void {
    const pendingAxis = `~${axis}`;
    this.#transaction(() => {
      this.verifyOperation(operation);
      this.#database
        .prepare(
          `UPDATE operations
           SET profile = CASE
             WHEN instr(replace(profile, ?, ''), ?) > 0 OR instr(profile, ?) > 0 THEN profile
             ELSE profile || ?
           END
           WHERE operation_id = ? AND session_id = ? AND claim_epoch = ?
             AND authority_version = ?`,
        )
        .run(
          pendingAxis,
          axis,
          pendingAxis,
          pendingAxis,
          operation.operationId,
          operation.sessionId,
          operation.claimEpoch,
          operation.authorityVersion,
        );
    });
  }

  completeOperationAxisAdmission(
    operation: OperationRef,
    axis: AuthorityAxis,
    admitted: boolean,
  ): void {
    const pendingAxis = `~${axis}`;
    this.#transaction(() => {
      this.verifyOperation(operation);
      this.#database
        .prepare(
          `UPDATE operations
           SET profile = CASE
             WHEN ? = 0 THEN replace(profile, ?, '')
             WHEN instr(replace(profile, ?, ''), ?) > 0 THEN replace(profile, ?, '')
             ELSE replace(profile, ?, '') || ?
           END
           WHERE operation_id = ? AND session_id = ? AND claim_epoch = ?
             AND authority_version = ?`,
        )
        .run(
          admitted ? 1 : 0,
          pendingAxis,
          pendingAxis,
          axis,
          pendingAxis,
          pendingAxis,
          axis,
          operation.operationId,
          operation.sessionId,
          operation.claimEpoch,
          operation.authorityVersion,
        );
    });
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

  claimResources(session: SessionRef, resources: readonly ResourceClaim[]): SessionRef {
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
      const bindings = JSON.parse(owner.bindings_json) as Record<string, unknown>;
      if (resources.some((resource) => resource.type === 'device')) {
        this.#assertNoStaleDeviceCleanup(bindings);
      }

      this.#assertClaimsAvailable(session, resources, probes, now);

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
      this.#advanceActiveOperationFence(
        session,
        owner.authority_version,
        owner.authority_version + 1,
      );
      return session;
    });
  }

  releaseResources(session: SessionRef, resources: readonly ResourceClaim[]): void {
    const now = this.#now();
    this.#transaction(() => {
      const current = this.#requireSession(session);
      for (const resource of resources) {
        if (resource.type === 'runner' || resource.type === 'device') {
          const rows = this.#database
            .prepare(
              `SELECT platform, receipt_json FROM platform_authority_receipts
               WHERE session_id = ? AND claim_epoch = ?`,
            )
            .all(session.sessionId, session.claimEpoch) as {
            platform: string;
            receipt_json: string;
          }[];
          for (const row of rows) {
            const persisted = JSON.parse(row.receipt_json) as Record<string, unknown>;
            const receipt =
              persisted.receipt && typeof persisted.receipt === 'object'
                ? (persisted.receipt as Record<string, unknown>)
                : persisted;
            if (
              (resource.type === 'runner' && receipt.runnerClaim === resource.key) ||
              (resource.type === 'device' && receipt.deviceClaim === resource.key)
            ) {
              this.#invalidatePlatformReceipt(session, row.platform);
            }
          }
        }
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
      this.#advanceActiveOperationFence(
        session,
        current.authority_version,
        current.authority_version + 1,
      );
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

  bindRecoveryWorker(
    session: SessionRef,
    worker: { instanceId: string; pid: number; token: string },
    capability: string,
  ): void {
    const now = this.#now();
    this.#transaction(() => {
      const row = this.#requireRecoverableSession(session);
      const bindings = JSON.parse(row.bindings_json) as Record<string, unknown>;
      const expected = Buffer.from(String(bindings.recoveryCapabilityHash ?? ''), 'hex');
      const actual = createHash('sha256').update(capability).digest();
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
        throw new SessionAuthorityError(
          'HANDOFF_NOT_AUTHORIZED',
          'blocked recovery capability is invalid',
        );
      }
      const pendingHandoffs = this.#database
        .prepare(
          `SELECT handoff.handoff_id, handoff.claim_epoch, handoff.target_instance,
                  donor.session_id, donor.claim_epoch AS donor_claim_epoch,
                  donor.bindings_json
           FROM handoffs handoff
           JOIN sessions donor ON donor.session_id = handoff.session_id
           WHERE handoff.consumed_ms IS NULL
             AND donor.state = 'handoff'
             AND donor.source_key = ?
             AND donor.worktree_key = ?
             AND donor.app_root_key = ?`,
        )
        .all(row.source_key, row.worktree_key, row.app_root_key) as {
        handoff_id: string;
        claim_epoch: number;
        target_instance: string;
        session_id: string;
        donor_claim_epoch: number;
        bindings_json: string;
      }[];
      const adoptionRequired = bindings.adoptionRequired as
        | { sessionId?: unknown; claimEpoch?: unknown }
        | undefined;
      type HandoffRotation = {
        handoff: (typeof pendingHandoffs)[number];
        donorBindings: Record<string, unknown>;
        reservation: ManagedMetroHandoffReservation;
      };
      const rotations = pendingHandoffs.flatMap<HandoffRotation>((handoff) => {
        const donorBindings = JSON.parse(handoff.bindings_json) as Record<string, unknown>;
        const reservation = managedMetroHandoffReservation(donorBindings);
        if (!reservation) return [];
        if (
          reservation.handoffId !== handoff.handoff_id ||
          reservation.sourceClaimEpoch !== handoff.claim_epoch ||
          reservation.sourceClaimEpoch !== handoff.donor_claim_epoch ||
          reservation.metro.sourceSessionId !== handoff.session_id
        ) {
          throw new SessionAuthorityError(
            'HANDOFF_NOT_AUTHORIZED',
            'managed Metro handoff reservation no longer matches the recovery worker fence',
          );
        }
        if (
          reservation.targetSessionId !== session.sessionId ||
          reservation.targetClaimEpoch !== session.claimEpoch
        ) {
          return [];
        }
        if (
          reservation.targetInstance !== row.worker_instance ||
          handoff.target_instance !== row.worker_instance
        ) {
          throw new SessionAuthorityError(
            'HANDOFF_NOT_AUTHORIZED',
            'managed Metro handoff reservation no longer matches the recovery worker fence',
          );
        }
        return [{ handoff, donorBindings, reservation }];
      });
      if (rotations.length > 1) {
        throw new SessionAuthorityError(
          'HANDOFF_NOT_AUTHORIZED',
          'multiple managed Metro handoffs target the same recovery session',
        );
      }
      const rotation = rotations[0];
      if (rotation) {
        const rotatedReservation: ManagedMetroHandoffReservation = {
          ...rotation.reservation,
          targetSessionId: session.sessionId,
          targetClaimEpoch: session.claimEpoch,
          targetInstance: worker.instanceId,
        };
        const handoffChanged = this.#database
          .prepare(
            `UPDATE handoffs SET target_instance = ?
             WHERE handoff_id = ? AND target_instance = ? AND consumed_ms IS NULL`,
          )
          .run(
            worker.instanceId,
            rotation.handoff.handoff_id,
            rotation.reservation.targetInstance,
          ) as { changes: number };
        if (handoffChanged.changes !== 1) {
          throw new SessionAuthorityError(
            'HANDOFF_NOT_AUTHORIZED',
            'managed Metro handoff target changed during recovery worker rotation',
          );
        }
        const donorChanged = this.#database
          .prepare(
            `UPDATE sessions
             SET bindings_json = ?, authority_version = authority_version + 1, updated_ms = ?
             WHERE session_id = ? AND claim_epoch = ? AND state = 'handoff'`,
          )
          .run(
            JSON.stringify({
              ...rotation.donorBindings,
              managedMetroHandoffReservation: rotatedReservation,
            }),
            now,
            rotation.handoff.session_id,
            rotation.handoff.donor_claim_epoch,
          ) as { changes: number };
        if (donorChanged.changes !== 1) {
          throw new SessionAuthorityError(
            'HANDOFF_NOT_AUTHORIZED',
            'managed Metro donor authority changed during recovery worker rotation',
          );
        }
      }
      // L4: grouped-v1 sessions never mint adoption or handoff-recipient handles —
      // a proven-dead same-root owner is released by startup cleanup instead.
      const grouped =
        (JSON.parse(row.source_json) as Record<string, unknown>).model === 'grouped-v1';
      const expiresMs = now + RECOVERY_HANDLE_TTL_MS;
      const priorHandles = bindings.recoveryHandles as
        | { adoptStale?: Record<string, unknown> }
        | null
        | undefined;
      const resumableAdoptStale =
        row.state === 'handoff_cleanup' &&
        priorHandles?.adoptStale &&
        typeof priorHandles.adoptStale === 'object'
          ? priorHandles.adoptStale
          : undefined;
      const reboundAdoptStale = resumableAdoptStale
        ? {
            ...resumableAdoptStale,
            previous:
              typeof resumableAdoptStale.token === 'string' &&
              typeof resumableAdoptStale.expiresMs === 'number' &&
              resumableAdoptStale.expiresMs >= now
                ? {
                    token: resumableAdoptStale.token,
                    expiresMs: resumableAdoptStale.expiresMs,
                  }
                : undefined,
            token: randomBytes(32).toString('base64url'),
            expiresMs,
          }
        : undefined;
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
          : reboundAdoptStale
            ? { adoptStale: reboundAdoptStale }
            : {}),
      };
      this.#database
        .prepare('DELETE FROM operations WHERE session_id = ? AND claim_epoch = ?')
        .run(session.sessionId, session.claimEpoch);
      this.#database
        .prepare(
          `UPDATE sessions
           SET worker_instance = ?, worker_pid = ?, worker_birth = ?,
               bindings_json = ?, authority_version = authority_version + 1, updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ?
             AND state IN ('blocked', 'handoff_cleanup')`,
        )
        .run(
          worker.instanceId,
          worker.pid,
          worker.token,
          grouped ? JSON.stringify(bindings) : JSON.stringify({ ...bindings, recoveryHandles }),
          now,
          session.sessionId,
          session.claimEpoch,
        );
    });
  }

  /**
   * GH #672: rotate a recovery handle that is expired or about to expire, so `status`
   * can never advertise a token `validateStaleAdoption` will refuse. Capability- and
   * worker-bound, re-reads durable state, and leaves a still-fresh handle untouched.
   * Returns whether anything rotated.
   */
  refreshRecoveryHandles(
    session: SessionRef,
    worker: { instanceId: string },
    capability: string,
  ): boolean {
    const now = this.#now();
    return this.#transaction(() => {
      const row = this.#requireRecoverableSession(session);
      const bindings = JSON.parse(row.bindings_json) as Record<string, unknown>;
      const expected = Buffer.from(String(bindings.recoveryCapabilityHash ?? ''), 'hex');
      const actual = createHash('sha256').update(capability).digest();
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
        throw new SessionAuthorityError(
          'HANDOFF_NOT_AUTHORIZED',
          'blocked recovery capability is invalid',
        );
      }
      if (row.worker_instance !== worker.instanceId) {
        throw new SessionAuthorityError(
          'HANDOFF_TARGET_MISMATCH',
          'recovery handle refresh is not owned by this recovery worker',
        );
      }
      const handles = bindings.recoveryHandles as Record<string, unknown> | null | undefined;
      if (!handles || typeof handles !== 'object') return false;
      const expiresMs = now + RECOVERY_HANDLE_TTL_MS;
      let changed = false;
      const next: Record<string, unknown> = { ...handles };
      for (const name of ['handoffRecipient', 'adoptStale'] as const) {
        const handle = handles[name];
        if (!handle || typeof handle !== 'object') continue;
        const current = handle as Record<string, unknown>;
        const previous = current.previous as Record<string, unknown> | null | undefined;
        const previousExpired =
          previous && typeof previous.expiresMs === 'number' && previous.expiresMs < now;
        const retained = previousExpired ? { ...current, previous: undefined } : current;
        if (previousExpired) changed = true;
        if (
          typeof current.expiresMs === 'number' &&
          current.expiresMs > now + RECOVERY_HANDLE_RENEW_MS
        ) {
          next[name] = retained;
          continue;
        }
        next[name] = {
          ...retained,
          previous:
            typeof current.token === 'string' &&
            typeof current.expiresMs === 'number' &&
            current.expiresMs >= now
              ? { token: current.token, expiresMs: current.expiresMs }
              : undefined,
          token: randomBytes(32).toString('base64url'),
          expiresMs,
        };
        changed = true;
      }
      if (!changed) return false;
      this.#database
        .prepare(
          `UPDATE sessions SET bindings_json = ?, updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ?
             AND state IN ('blocked', 'handoff_cleanup')`,
        )
        .run(
          JSON.stringify({ ...bindings, recoveryHandles: next }),
          now,
          session.sessionId,
          session.claimEpoch,
        );
      return true;
    });
  }

  /**
   * GH #672: distinguish the three real recovery answers for a blocked contender.
   * A dead prior owner is adoptable; a LIVE one never is (the caller must close it or
   * use another worktree); an owner whose identity cannot be proven is treated as live.
   * A vanished claim epoch only needs a fresh transport.
   */
  inspectRecoveryRequirement(sessionId: string): RecoveryRequirementInspection {
    const row = asSession(
      this.#database
        .prepare(
          `SELECT source_key, worktree_key, app_root_key, state, source_json, bindings_json
           FROM sessions WHERE session_id = ?`,
        )
        .get(sessionId),
    );
    if (!row || (row.state !== 'blocked' && row.state !== 'handoff_cleanup')) {
      return { requirement: 'none', priorOwner: 'absent', nextAction: '' };
    }
    if (row.state === 'handoff_cleanup') {
      return {
        requirement: 'adoption',
        priorOwner: 'stale',
        nextAction:
          'Resume the transferred cleanup with rn_session({ action: "adopt_stale", adoptionHandle }).',
      };
    }
    const grouped = (JSON.parse(row.source_json) as Record<string, unknown>).model === 'grouped-v1';
    const bindings = JSON.parse(row.bindings_json) as Record<string, unknown>;
    const adoptionRequired = bindings.adoptionRequired as
      | { sessionId?: unknown; claimEpoch?: unknown }
      | null
      | undefined;
    const priorSessionId =
      typeof adoptionRequired?.sessionId === 'string' ? adoptionRequired.sessionId : null;
    const prior = priorSessionId
      ? asSession(
          this.#database
            .prepare(
              `SELECT session_id, source_key, worktree_key, app_root_key, claim_epoch,
                      supervisor_pid, supervisor_birth, heartbeat_ms, bindings_json
               FROM sessions WHERE session_id = ?`,
            )
            .get(priorSessionId),
        )
      : null;
    if (!prior || prior.claim_epoch !== adoptionRequired?.claimEpoch) {
      return {
        requirement: 'transport-restart',
        priorOwner: 'absent',
        nextAction:
          'The blocking claim epoch is gone. Restart the MCP transport (/mcp) to start a clean session.',
      };
    }
    let status: OwnerStatus = 'unknown';
    try {
      status = this.#ownerStatus({
        sessionId: prior.session_id,
        pid: prior.supervisor_pid,
        token: prior.supervisor_birth,
      });
    } catch {
      status = 'unknown';
    }
    if (status === 'mismatch') {
      if (grouped) {
        const isSameAppRoot =
          prior.worktree_key === row.worktree_key && prior.app_root_key === row.app_root_key;
        if (!isSameAppRoot) {
          return {
            requirement: 'attach',
            priorOwner: 'stale',
            nextAction:
              "The proven-dead owner belongs to a different app root in this worktree, so startup cleanup cannot release it here. Start and close rn-dev-agent from the prior owner's app root to release its authority, or use a separate worktree.",
          };
        }
        if (prior.source_key !== row.source_key) {
          return {
            requirement: 'attach',
            priorOwner: 'stale',
            nextAction:
              'The proven-dead owner has a different source identity for this app root, so startup cleanup cannot release it under the current declared manifests. Restore the declared manifests that produced the prior identity, start and close rn-dev-agent to release its authority, then reapply the manifest changes; otherwise use a separate worktree.',
          };
        }
        // Only cleanup without a retained refusal may promise automatic convergence.
        const blocked = readStartupCleanupBlocker(prior.bindings_json);
        if (blocked) {
          return {
            requirement: 'transport-restart',
            priorOwner: 'stale',
            startupCleanupBlocked: blocked,
            nextAction:
              blocked.nextAction ??
              `Startup cleanup refused with ${blocked.code} and will refuse again on the next restart: ${blocked.reason}. Resolve that refusal before restarting the MCP transport.`,
          };
        }
        return {
          requirement: 'transport-restart',
          priorOwner: 'stale',
          nextAction:
            'The prior owner is proven dead. Restart the MCP transport (/mcp); startup cleanup releases it automatically.',
        };
      }
      return {
        requirement: 'adoption',
        priorOwner: 'stale',
        nextAction:
          'The prior owner is proven dead. Adopt it with rn_session({ action: "adopt_stale", adoptionHandle }).',
      };
    }
    const heartbeatAgeMs = Math.min(
      Math.max(0, this.#now() - (typeof prior.heartbeat_ms === 'number' ? prior.heartbeat_ms : 0)),
      24 * 3_600_000,
    );
    return {
      requirement: 'attach',
      priorOwner: status === 'match' ? 'live' : 'unknown',
      ...(grouped ? { priorOwnerHeartbeatAgeMs: heartbeatAgeMs } : {}),
      nextAction:
        status === 'match'
          ? 'Another live rn-dev-agent supervisor owns this worktree. Close it or work in a separate worktree; a live owner is never adopted.'
          : 'The prior owner identity could not be proven, so it is treated as live. Close the other session or re-run once its process state is observable.',
    };
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
      const currentBindings = JSON.parse(current.bindings_json) as Record<string, unknown>;
      this.#assertNoStaleDeviceCleanup(currentBindings);
      const claim = this.#findConflictingClaim(resource);
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
        ...currentBindings,
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
      this.#advanceActiveOperationFence(
        session,
        current.authority_version,
        current.authority_version + 1,
      );
    });
  }

  /**
   * GH #672: device-family claims held by a proven-dead owner discovered AFTER startup.
   * Startup adoption only exists for source/port conflicts, so a dead device/runner owner
   * left `bind_device` demanding an `adopt_stale` handle that no path could mint. This
   * offers a bounded, capability-authenticated release for the exact device only — it
   * never transfers source, package-integration, Metro, or port authority, so a dead
   * owner from a foreign worktree can be cleaned up without adopting its session.
   * ADR L5: new code no longer mints these offers; `beginConfirmedStaleDeviceRelease`
   * is the default path. This mint stays only as the trivially revertible legacy path.
   */
  prepareStaleResourceRelease(
    session: SessionRef,
    target: { platform: string; deviceId: string },
  ): StaleResourceReleaseOffer {
    const deviceKey = `${target.platform}:${target.deviceId}`;
    const now = this.#now();
    return this.#transaction(() => {
      const current = this.#requireSession(session);
      const prior = this.#requireSingleProvenDeadDeviceOwner(session, deviceKey);
      const family = this.#requireExactStaleDeviceFamily(session, prior, target);
      const obligations: StaleReleaseObligation[] = [];
      if (family.androidMetroReverse) obligations.push('androidMetroReverse');
      if (family.runner) obligations.push('runner');
      if (family.recorder) obligations.push('recorder');
      const offer: StaleResourceReleaseOffer = {
        token: randomBytes(32).toString('base64url'),
        expiresMs: now + RECOVERY_HANDLE_TTL_MS,
        priorSessionId: prior.session_id,
        priorClaimEpoch: prior.claim_epoch,
        obligations,
      };
      const bindings = JSON.parse(current.bindings_json) as Record<string, unknown>;
      this.#database
        .prepare(
          `UPDATE sessions SET bindings_json = ?, updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ?`,
        )
        .run(
          JSON.stringify({
            ...bindings,
            staleDeviceRelease: {
              ...offer,
              platform: target.platform,
              deviceId: target.deviceId,
              priorSupervisorPid: prior.supervisor_pid,
              deathProvenAt: now,
            },
          }),
          now,
          session.sessionId,
          session.claimEpoch,
        );
      return offer;
    });
  }

  /**
   * ADR L5: read-only view of what a confirmed inline release would transfer. Proves
   * the owner's death and computes the exact obligations without minting a capability
   * or writing any state.
   */
  inspectStaleDeviceRelease(
    session: SessionRef,
    target: { platform: string; deviceId: string },
  ): { priorSessionId: string; priorClaimEpoch: number; obligations: StaleReleaseObligation[] } {
    const deviceKey = `${target.platform}:${target.deviceId}`;
    this.#requireSession(session);
    const prior = this.#requireSingleProvenDeadDeviceOwner(session, deviceKey);
    const family = this.#requireExactStaleDeviceFamily(session, prior, target);
    const obligations: StaleReleaseObligation[] = [];
    if (family.androidMetroReverse) obligations.push('androidMetroReverse');
    if (family.runner) obligations.push('runner');
    if (family.recorder) obligations.push('recorder');
    return {
      priorSessionId: prior.session_id,
      priorClaimEpoch: prior.claim_epoch,
      obligations,
    };
  }

  /**
   * ADR L5 (captain-approved D3): confirmed inline replacement for the capability-token
   * transfer. Authorization is the caller's explicit confirmation plus positive death
   * proof re-read from durable state inside this transaction, scoped to the exact
   * requested device. An existing journal resumes token-lessly; nothing is minted and
   * nothing expires.
   */
  beginConfirmedStaleDeviceRelease(
    session: SessionRef,
    workerInstance: string,
    target: { platform: string; deviceId: string },
  ): {
    platform: string;
    deviceId: string;
    androidMetroReverse?: Record<string, unknown> | null;
    runner: Record<string, unknown> | null;
    recorder: Record<string, unknown> | null;
  } {
    const now = this.#now();
    return this.#transaction(() => {
      const current = this.#requireSession(session);
      const bindings = JSON.parse(current.bindings_json) as Record<string, unknown>;
      if (current.worker_instance !== workerInstance) {
        throw new SessionAuthorityError(
          'HANDOFF_TARGET_MISMATCH',
          'stale device release is not owned by this worker',
        );
      }
      const resumed = bindings.staleDeviceCleanup as Record<string, unknown> | null | undefined;
      if (resumed) {
        this.#assertStaleReleaseJournalScope(current, resumed, target);
        return {
          platform: String(resumed.platform),
          deviceId: String(resumed.deviceId),
          ...(resumed.androidMetroReverse
            ? { androidMetroReverse: resumed.androidMetroReverse as Record<string, unknown> }
            : {}),
          runner: (resumed.runner as Record<string, unknown> | null) ?? null,
          recorder: (resumed.recorder as Record<string, unknown> | null) ?? null,
        };
      }
      const deviceKey = `${target.platform}:${target.deviceId}`;
      const prior = this.#requireSingleProvenDeadDeviceOwner(session, deviceKey);
      return this.#transferStaleDeviceAuthority(session, bindings, prior, target, now);
    });
  }

  /**
   * GH #672: take over the dead owner's exact device-family claims and its cleanup
   * obligations. Every proof is re-read from durable state here, not trusted from the
   * mint: a prior owner that came back to life, changed epoch, or cannot be identified
   * refuses even with a valid handle.
   */
  beginStaleResourceRelease(
    session: SessionRef,
    handle: string | undefined,
    workerInstance: string,
    target?: { platform: string; deviceId: string },
  ): {
    platform: string;
    deviceId: string;
    androidMetroReverse?: Record<string, unknown> | null;
    runner: Record<string, unknown> | null;
    recorder: Record<string, unknown> | null;
  } {
    const now = this.#now();
    return this.#transaction(() => {
      const current = this.#requireSession(session);
      const bindings = JSON.parse(current.bindings_json) as Record<string, unknown>;
      if (current.worker_instance !== workerInstance) {
        throw new SessionAuthorityError(
          'HANDOFF_TARGET_MISMATCH',
          'stale device release is not owned by this worker',
        );
      }
      const resumed = bindings.staleDeviceCleanup as Record<string, unknown> | null | undefined;
      if (resumed) {
        this.#assertStaleReleaseJournalScope(current, resumed, target);
        return {
          platform: String(resumed.platform),
          deviceId: String(resumed.deviceId),
          ...(resumed.androidMetroReverse
            ? { androidMetroReverse: resumed.androidMetroReverse as Record<string, unknown> }
            : {}),
          runner: (resumed.runner as Record<string, unknown> | null) ?? null,
          recorder: (resumed.recorder as Record<string, unknown> | null) ?? null,
        };
      }
      const offer = bindings.staleDeviceRelease as Record<string, unknown> | null | undefined;
      if (
        !offer ||
        typeof offer.token !== 'string' ||
        typeof offer.expiresMs !== 'number' ||
        typeof offer.platform !== 'string' ||
        typeof offer.deviceId !== 'string' ||
        typeof offer.priorSessionId !== 'string' ||
        typeof offer.priorClaimEpoch !== 'number' ||
        typeof handle !== 'string' ||
        !this.#capabilityMatches(offer.token, handle)
      ) {
        throw new SessionAuthorityError(
          'HANDOFF_NOT_AUTHORIZED',
          'stale device release capability is invalid or expired',
        );
      }
      const platform = offer.platform;
      const deviceId = offer.deviceId;
      if (target && (target.platform !== platform || target.deviceId !== deviceId)) {
        throw new SessionAuthorityError(
          'DEVICE_AUTHORITY_MISMATCH',
          'stale device release offer does not match the requested exact device',
          undefined,
          { axis: 'D', nextAction: 'Run rn_session with action "status" for the exact recovery.' },
        );
      }
      if (offer.expiresMs < now) {
        throw new SessionAuthorityError(
          'HANDOFF_NOT_AUTHORIZED',
          'stale device release capability is invalid or expired',
        );
      }
      const prior = this.#requireProvenDeadOwner(offer.priorSessionId, offer.priorClaimEpoch);
      return this.#transferStaleDeviceAuthority(
        session,
        bindings,
        prior,
        { platform, deviceId },
        now,
      );
    });
  }

  #transferStaleDeviceAuthority(
    session: SessionRef,
    bindings: Record<string, unknown>,
    prior: SessionRow,
    target: { platform: string; deviceId: string },
    now: number,
  ): {
    platform: string;
    deviceId: string;
    androidMetroReverse?: Record<string, unknown> | null;
    runner: Record<string, unknown> | null;
    recorder: Record<string, unknown> | null;
  } {
    const { platform, deviceId } = target;
    const deviceKey = `${platform}:${deviceId}`;
    const priorBindings = JSON.parse(prior.bindings_json) as Record<string, unknown>;
    const family = this.#requireExactStaleDeviceFamily(session, prior, target);
    const { androidMetroReverse, runner, recorder } = family;
    for (const claim of family.claims) {
      this.#database
        .prepare(
          `UPDATE claims SET session_id = ?, claim_epoch = ?, lease_until_ms = ?
           WHERE resource_type = ? AND resource_key = ?
             AND session_id = ? AND claim_epoch = ?`,
        )
        .run(
          session.sessionId,
          session.claimEpoch,
          now + this.#leaseMs,
          claim.resource_type,
          claim.resource_key,
          prior.session_id,
          prior.claim_epoch,
        );
    }
    const runnerClaimKey = runner ? `${platform}:${deviceId}:${String(runner.port)}` : null;
    const cleanup = {
      platform,
      deviceId,
      priorSessionId: prior.session_id,
      priorClaimEpoch: prior.claim_epoch,
      transferredAt: now,
      ...(androidMetroReverse
        ? {
            androidMetroReverse: {
              ...androidMetroReverse,
              claimKey: deviceKey,
              stopRequestedAt: now,
              completedAt: null,
            },
          }
        : {}),
      runner: runner
        ? { ...runner, claimKey: runnerClaimKey, stopRequestedAt: now, completedAt: null }
        : null,
      recorder: recorder
        ? { ...recorder, claimKey: deviceKey, stopRequestedAt: now, completedAt: null }
        : null,
    };
    this.#database
      .prepare(
        `UPDATE sessions SET bindings_json = ?, updated_ms = ?
         WHERE session_id = ? AND claim_epoch = ?`,
      )
      .run(
        JSON.stringify({ ...bindings, staleDeviceCleanup: cleanup }),
        now,
        session.sessionId,
        session.claimEpoch,
      );
    // The dead owner keeps a durable record of WHAT left and to whom: its cleanup
    // journal must survive, but it must never be replayed by a later adoption.
    this.#database
      .prepare(
        `UPDATE sessions SET bindings_json = ?, updated_ms = ?
         WHERE session_id = ? AND claim_epoch = ?`,
      )
      .run(
        JSON.stringify({
          ...priorBindings,
          device: null,
          androidMetroReverse: null,
          runner: null,
          recorder: null,
          deviceReleased: {
            toSessionId: session.sessionId,
            toClaimEpoch: session.claimEpoch,
            at: now,
            platform,
            deviceId,
            device: priorBindings.device ?? null,
            androidMetroReverse,
            runner,
            recorder,
          },
        }),
        now,
        prior.session_id,
        prior.claim_epoch,
      );
    return {
      platform,
      deviceId,
      ...(cleanup.androidMetroReverse ? { androidMetroReverse: cleanup.androidMetroReverse } : {}),
      runner: cleanup.runner,
      recorder: cleanup.recorder,
    };
  }

  #requireSingleProvenDeadDeviceOwner(session: SessionRef, deviceKey: string): SessionRow {
    const claims = this.#deviceFamilyClaims(deviceKey);
    if (claims.length === 0) {
      throw new SessionAuthorityError(
        'DEVICE_CLAIM_CONFLICT',
        `no foreign claim on ${deviceKey} needs release`,
      );
    }
    const owners = new Set(claims.map((claim) => `${claim.session_id}\0${claim.claim_epoch}`));
    if (owners.size !== 1) {
      throw new SessionAuthorityError(
        'DEVICE_CLAIM_CONFLICT',
        `${deviceKey} is split across several claim epochs; release each owner explicitly`,
      );
    }
    if (
      claims[0]!.session_id === session.sessionId &&
      claims[0]!.claim_epoch === session.claimEpoch
    ) {
      throw new SessionAuthorityError(
        'DEVICE_CLAIM_CONFLICT',
        `no foreign claim on ${deviceKey} needs release`,
      );
    }
    return this.#requireProvenDeadOwner(claims[0]!.session_id, claims[0]!.claim_epoch);
  }

  #requireExactStaleDeviceFamily(
    session: SessionRef,
    prior: SessionRow,
    target: { platform: string; deviceId: string },
  ): StaleDeviceFamily {
    const deviceKey = `${target.platform}:${target.deviceId}`;
    const claims = this.#deviceFamilyClaims(deviceKey);
    if (
      claims.length === 0 ||
      claims.some(
        (claim) => claim.session_id !== prior.session_id || claim.claim_epoch !== prior.claim_epoch,
      )
    ) {
      throw new SessionAuthorityError(
        'DEVICE_CLAIM_CONFLICT',
        `${deviceKey} is split across several claim epochs; release each owner explicitly`,
      );
    }
    if (
      claims.some(
        (claim) =>
          claim.resource_type === 'device-receipt' || claim.resource_type === 'runner-receipt',
      )
    ) {
      throw new SessionAuthorityError(
        'DEVICE_AUTHORITY_MISMATCH',
        'stale device cleanup cannot transfer platform validation receipt authority',
      );
    }
    const bindings = JSON.parse(prior.bindings_json) as Record<string, unknown>;
    if (!this.#bindingMatchesDevice(bindings.device, target)) {
      throw new SessionAuthorityError(
        'DEVICE_AUTHORITY_MISMATCH',
        'stale device claim does not match its owner binding',
      );
    }
    const deviceClaims = claims.filter((claim) => claim.resource_type === 'device');
    if (deviceClaims.length !== 1 || deviceClaims[0]!.resource_key !== deviceKey) {
      throw new SessionAuthorityError(
        'DEVICE_AUTHORITY_MISMATCH',
        'stale device binding has no exclusive cleanup claim',
      );
    }
    const current = this.#requireSession(session);
    const currentBindings = JSON.parse(current.bindings_json) as Record<string, unknown>;
    if (
      this.#bindingMatchesDevice(currentBindings.device, target) ||
      this.#bindingMatchesDevice(currentBindings.runner, target) ||
      this.#bindingMatchesDevice(currentBindings.recorder, target)
    ) {
      throw new SessionAuthorityError(
        'DEVICE_AUTHORITY_MISMATCH',
        'stale device cleanup conflicts with existing target bindings',
      );
    }
    const reverseValue = bindings.androidMetroReverse;
    const androidMetroReverse =
      reverseValue &&
      typeof reverseValue === 'object' &&
      target.platform === 'android' &&
      (reverseValue as Record<string, unknown>).platform === 'android' &&
      (reverseValue as Record<string, unknown>).deviceId === target.deviceId &&
      Number.isSafeInteger((reverseValue as Record<string, unknown>).metroPort) &&
      (reverseValue as Record<string, unknown>).local ===
        `tcp:${String((reverseValue as Record<string, unknown>).metroPort)}` &&
      (reverseValue as Record<string, unknown>).remote ===
        `tcp:${String((reverseValue as Record<string, unknown>).metroPort)}`
        ? (reverseValue as Record<string, unknown>)
        : null;
    if (reverseValue !== null && reverseValue !== undefined && !androidMetroReverse) {
      throw new SessionAuthorityError(
        'PHYSICAL_ANDROID_METRO_CLEANUP_UNPROVEN',
        'stale physical Android Metro reverse binding does not match the exact device and port',
      );
    }
    const runnerClaims = claims.filter((claim) => claim.resource_type === 'runner');
    const runnerValue = bindings.runner;
    const runner = this.#bindingMatchesDevice(runnerValue, target)
      ? (runnerValue as Record<string, unknown>)
      : null;
    if (runnerValue !== null && runnerValue !== undefined && !runner) {
      throw new SessionAuthorityError(
        'RUNNER_OWNERSHIP_MISMATCH',
        'stale runner binding targets another device',
      );
    }
    if (runner && !hasCompleteRunnerCleanupIdentity(runner)) {
      throw new SessionAuthorityError(
        'RUNNER_ADOPTION_REQUIRED',
        'stale runner cleanup identity is incomplete',
      );
    }
    const runnerClaimKey = runner ? `${deviceKey}:${String(runner.port)}` : null;
    if (
      runnerClaims.length !== (runner ? 1 : 0) ||
      (runner && runnerClaims[0]!.resource_key !== runnerClaimKey)
    ) {
      throw new SessionAuthorityError(
        'RUNNER_OWNERSHIP_MISMATCH',
        'stale runner binding has no exclusive cleanup claim',
      );
    }
    const recorderClaims = claims.filter((claim) => claim.resource_type === 'recorder');
    const recorderValue = bindings.recorder;
    const recorder = this.#bindingMatchesDevice(recorderValue, target)
      ? (recorderValue as Record<string, unknown>)
      : null;
    if (recorderValue !== null && recorderValue !== undefined && !recorder) {
      throw new SessionAuthorityError(
        'RECORDING_AUTHORITY_MISMATCH',
        'stale recorder binding targets another device',
      );
    }
    if (recorder && !hasCompleteRecorderCleanupIdentity(recorder)) {
      throw new SessionAuthorityError(
        'RECORDING_AUTHORITY_MISMATCH',
        'stale recorder cleanup identity is incomplete',
      );
    }
    if (
      recorderClaims.length !== (recorder ? 1 : 0) ||
      (recorder && recorderClaims[0]!.resource_key !== deviceKey)
    ) {
      throw new SessionAuthorityError(
        'RECORDING_AUTHORITY_MISMATCH',
        'stale recorder binding has no exclusive cleanup claim',
      );
    }
    return { claims, androidMetroReverse, runner, recorder };
  }

  completeStaleResourceRelease(
    session: SessionRef,
    workerInstance: string,
    resource: StaleReleaseObligation,
  ): void {
    const now = this.#now();
    this.#transaction(() => {
      const { row, bindings, cleanup } = this.#requireStaleReleaseOwner(session, workerInstance);
      const binding = cleanup[resource];
      if (!binding || typeof binding !== 'object') return;
      const entry = binding as Record<string, unknown>;
      if (typeof entry.stopRequestedAt !== 'number') {
        throw new SessionAuthorityError(
          'SESSION_AUTHORITY_REQUIRED',
          `${resource} release was not durably requested`,
        );
      }
      if (typeof entry.completedAt === 'number') return;
      if (resource !== 'androidMetroReverse') {
        const claimType = resource === 'runner' ? 'runner' : 'recorder';
        this.#database
          .prepare(
            `DELETE FROM claims
             WHERE resource_type = ? AND resource_key = ?
               AND session_id = ? AND claim_epoch = ?`,
          )
          .run(claimType, String(entry.claimKey), session.sessionId, session.claimEpoch);
      }
      this.#database
        .prepare(
          `UPDATE sessions SET bindings_json = ?, updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ?`,
        )
        .run(
          JSON.stringify({
            ...bindings,
            staleDeviceCleanup: { ...cleanup, [resource]: { ...entry, completedAt: now } },
          }),
          now,
          row.session_id,
          row.claim_epoch,
        );
    });
  }

  finishStaleResourceRelease(session: SessionRef, workerInstance: string): void {
    const now = this.#now();
    this.#transaction(() => {
      const { row, bindings, cleanup } = this.#requireStaleReleaseOwner(session, workerInstance);
      for (const resource of ['androidMetroReverse', 'runner', 'recorder'] as const) {
        const binding = cleanup[resource];
        if (
          binding &&
          typeof binding === 'object' &&
          typeof (binding as Record<string, unknown>).completedAt !== 'number'
        ) {
          throw new SessionAuthorityError(
            'AUTOMATION_CLEANUP_UNPROVEN',
            `${resource} release has not been durably completed`,
          );
        }
      }
      const deviceKey = `${String(cleanup.platform)}:${String(cleanup.deviceId)}`;
      const unrelatedClaim = this.#deviceFamilyClaims(deviceKey).find(
        (claim) => claim.resource_type !== 'device',
      );
      if (unrelatedClaim) {
        throw new SessionAuthorityError(
          'DEVICE_AUTHORITY_MISMATCH',
          'stale device cleanup found authority outside its completed journal',
        );
      }
      this.#database
        .prepare(
          `DELETE FROM claims
           WHERE resource_type = 'device' AND resource_key = ?
             AND session_id = ? AND claim_epoch = ?`,
        )
        .run(deviceKey, session.sessionId, session.claimEpoch);
      const nextAuthorityVersion = row.authority_version + 1;
      this.#database
        .prepare(
          `UPDATE sessions
           SET bindings_json = ?, authority_version = ?, updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ? AND authority_version = ?`,
        )
        .run(
          JSON.stringify({ ...bindings, staleDeviceCleanup: null, staleDeviceRelease: null }),
          nextAuthorityVersion,
          now,
          row.session_id,
          row.claim_epoch,
          row.authority_version,
        );
      this.#advanceActiveOperationFence(session, row.authority_version, nextAuthorityVersion, true);
    });
  }

  /**
   * L4: verified-dead startup cleanup. The durable journal lives on the DEAD session's
   * row and is written before any side effect; claims release only in finish, after
   * every obligation is durably complete. Death is positively re-proven by every method.
   */
  findStartupCleanupCandidate(input: {
    sourceKey: string;
    worktreeKey: string;
    appRootKey: string;
  }): SessionRef | null {
    const claim = this.#findClaim('source', input.worktreeKey);
    if (!claim) return null;
    const row = asSession(
      this.#database
        .prepare(
          `SELECT session_id, source_key, worktree_key, app_root_key, claim_epoch
           FROM sessions WHERE session_id = ?`,
        )
        .get(claim.session_id),
    );
    if (
      !row ||
      row.claim_epoch !== claim.claim_epoch ||
      row.source_key !== input.sourceKey ||
      row.worktree_key !== input.worktreeKey ||
      row.app_root_key !== input.appRootKey
    ) {
      return null;
    }
    return { sessionId: claim.session_id, claimEpoch: claim.claim_epoch };
  }

  beginStartupOwnerCleanup(prior: SessionRef): StartupOwnerCleanupPlan {
    const now = this.#now();
    return this.#transaction(() => {
      const row = this.#requireProvenDeadStartupOwner(prior);
      const bindings = JSON.parse(row.bindings_json) as Record<string, unknown>;
      const existing = bindings.startupCleanup as Record<string, unknown> | null | undefined;
      if (existing && typeof existing === 'object' && typeof existing.finishedAt !== 'number') {
        return {
          resumed: true,
          obligations: (existing.obligations ?? {}) as StartupOwnerCleanupPlan['obligations'],
          integration: (existing.integration ?? null) as StartupOwnerCleanupPlan['integration'],
        };
      }
      const record = (value: unknown): Record<string, unknown> | null =>
        value && typeof value === 'object' ? { ...(value as Record<string, unknown>) } : null;
      const obligation = (
        source: Record<string, unknown> | null,
        claimKey: string | null,
      ): Record<string, unknown> | undefined =>
        source
          ? {
              ...source,
              claimKey: String(source.claimKey ?? claimKey ?? ''),
              stopRequestedAt:
                typeof source.stopRequestedAt === 'number' ? source.stopRequestedAt : now,
              completedAt: typeof source.completedAt === 'number' ? source.completedAt : null,
            }
          : undefined;
      const handoffCleanup = record(bindings.handoffCleanup);
      const staleDevice = record(bindings.staleDeviceCleanup);
      const androidMetroReverseSource =
        record(bindings.androidMetroReverse) ?? record(staleDevice?.androidMetroReverse);
      const recorderSource =
        record(bindings.recorder) ??
        record(staleDevice?.recorder) ??
        record(handoffCleanup?.recorder);
      const runnerSource =
        record(bindings.runner) ?? record(staleDevice?.runner) ?? record(handoffCleanup?.runner);
      const observeSource = record(bindings.observe) ?? record(handoffCleanup?.observe);
      const liveMetro = record(bindings.metroCleanup) ?? record(bindings.metro);
      const metroSource =
        liveMetro && liveMetro.mode === 'managed' ? liveMetro : record(handoffCleanup?.metro);
      const obligations: StartupOwnerCleanupPlan['obligations'] = {};
      const androidMetroReverseEntry = obligation(
        androidMetroReverseSource,
        androidMetroReverseSource ? `android:${String(androidMetroReverseSource.deviceId)}` : null,
      );
      if (androidMetroReverseEntry) {
        obligations.androidMetroReverse = androidMetroReverseEntry;
      }
      const recorderEntry = obligation(
        recorderSource,
        recorderSource
          ? `${String(recorderSource.platform)}:${String(recorderSource.deviceId)}`
          : null,
      );
      if (recorderEntry) obligations.recorder = recorderEntry;
      const runnerEntry = obligation(
        runnerSource,
        runnerSource
          ? `${String(runnerSource.platform)}:${String(runnerSource.deviceId)}:${String(
              runnerSource.port,
            )}`
          : null,
      );
      if (runnerEntry) obligations.runner = runnerEntry;
      const observeEntry = obligation(
        observeSource,
        observeSource ? String(observeSource.port) : null,
      );
      if (observeEntry) obligations.observe = observeEntry;
      const metroEntry = obligation(metroSource, metroSource ? String(metroSource.port) : null);
      if (metroEntry) obligations.metro = metroEntry;
      const integrationBinding = record(bindings.packageIntegration);
      const integration = integrationBinding
        ? {
            installedBySessionId: integrationBinding.installedBySessionId ?? null,
            manifestSha256: integrationBinding.manifestSha256 ?? null,
            requestedAt: now,
            completedAt: null,
          }
        : null;
      this.#database
        .prepare(
          `UPDATE sessions SET bindings_json = ?, updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ?`,
        )
        .run(
          JSON.stringify({
            ...bindings,
            startupCleanup: { journaledAt: now, obligations, integration },
          }),
          now,
          row.session_id,
          row.claim_epoch,
        );
      return { resumed: false, obligations, integration };
    });
  }

  /** Re-recording an identical cleanup refusal is a no-op across repeated restarts. */
  recordStartupCleanupRefusal(prior: SessionRef, refusal: StartupCleanupBlocker): void {
    const now = this.#now();
    this.#transaction(() => {
      const row = this.#requireProvenDeadStartupOwner(prior);
      const { bindings, journal } = this.#requireStartupCleanupJournal(row);
      if (typeof journal.finishedAt === 'number') return;
      const existing = journal.refusal as Record<string, unknown> | undefined;
      if (
        existing &&
        existing.code === refusal.code &&
        existing.reason === refusal.reason &&
        existing.nextAction === refusal.nextAction
      ) {
        return;
      }
      this.#database
        .prepare(
          `UPDATE sessions SET bindings_json = ?, updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ?`,
        )
        .run(
          JSON.stringify({
            ...bindings,
            startupCleanup: {
              ...journal,
              refusal: {
                code: refusal.code,
                reason: refusal.reason,
                ...(refusal.nextAction ? { nextAction: refusal.nextAction } : {}),
              },
            },
          }),
          now,
          row.session_id,
          row.claim_epoch,
        );
    });
  }

  verifyStartupOwnerObligation(
    prior: SessionRef,
    resource: StartupCleanupResource,
  ): Record<string, unknown> | null {
    const row = this.#requireProvenDeadStartupOwner(prior);
    const { journal } = this.#requireStartupCleanupJournal(row);
    const entry = (journal.obligations as Record<string, unknown> | undefined)?.[resource];
    if (!entry || typeof entry !== 'object') return null;
    const binding = entry as Record<string, unknown>;
    if (typeof binding.completedAt === 'number') return binding;
    this.#assertStartupObligationScope(row, resource, binding);
    return binding;
  }

  completeStartupOwnerObligation(prior: SessionRef, resource: StartupCleanupResource): void {
    const now = this.#now();
    this.#transaction(() => {
      const row = this.#requireProvenDeadStartupOwner(prior);
      const { bindings, journal } = this.#requireStartupCleanupJournal(row);
      const obligations = (journal.obligations ?? {}) as Record<string, unknown>;
      const entry = obligations[resource];
      if (!entry || typeof entry !== 'object') return;
      const binding = entry as Record<string, unknown>;
      if (typeof binding.completedAt === 'number') return;
      if (typeof binding.stopRequestedAt !== 'number') {
        throw new SessionAuthorityError(
          'SESSION_AUTHORITY_REQUIRED',
          `${resource} cleanup was not durably requested`,
        );
      }
      this.#assertStartupObligationScope(row, resource, binding);
      this.#database
        .prepare(
          `UPDATE sessions SET bindings_json = ?, updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ?`,
        )
        .run(
          JSON.stringify({
            ...bindings,
            startupCleanup: {
              ...journal,
              obligations: { ...obligations, [resource]: { ...binding, completedAt: now } },
            },
          }),
          now,
          row.session_id,
          row.claim_epoch,
        );
    });
  }

  completeStartupOwnerIntegrationRestore(
    prior: SessionRef,
    input: { manifestSha256: string },
  ): void {
    const now = this.#now();
    this.#transaction(() => {
      const row = this.#requireProvenDeadStartupOwner(prior);
      const { bindings, journal } = this.#requireStartupCleanupJournal(row);
      const integration = journal.integration as Record<string, unknown> | null | undefined;
      if (!integration || typeof integration !== 'object') return;
      if (typeof integration.completedAt === 'number') return;
      const binding = bindings.packageIntegration as Record<string, unknown> | null | undefined;
      if (
        !binding ||
        typeof binding !== 'object' ||
        binding.manifestSha256 !== input.manifestSha256 ||
        integration.manifestSha256 !== input.manifestSha256
      ) {
        throw new SessionAuthorityError(
          'SESSION_AUTHORITY_REQUIRED',
          'integration restoration requires the recorded manifest authority',
        );
      }
      this.#database
        .prepare(
          `UPDATE sessions SET bindings_json = ?, updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ?`,
        )
        .run(
          JSON.stringify({
            ...bindings,
            packageIntegration: null,
            startupCleanup: { ...journal, integration: { ...integration, completedAt: now } },
          }),
          now,
          row.session_id,
          row.claim_epoch,
        );
    });
  }

  verifyStartupOwnerIntegrationRestore(
    prior: SessionRef,
    input: {
      sourceKey: string;
      worktreeKey: string;
      appRootKey: string;
      manifestSha256: string;
    },
  ): void {
    const row = this.#requireProvenDeadStartupOwner(prior);
    this.#assertStartupSourceScope(row, input);
    const { bindings, journal } = this.#requireStartupCleanupJournal(row);
    const integration = journal.integration as Record<string, unknown> | null | undefined;
    const binding = bindings.packageIntegration as Record<string, unknown> | null | undefined;
    if (
      !integration ||
      typeof integration !== 'object' ||
      typeof integration.completedAt === 'number' ||
      !binding ||
      typeof binding !== 'object' ||
      binding.manifestSha256 !== input.manifestSha256 ||
      integration.manifestSha256 !== input.manifestSha256
    ) {
      throw new SessionAuthorityError(
        'SESSION_AUTHORITY_REQUIRED',
        'integration restoration requires the active startup journal and recorded manifest authority',
      );
    }
  }

  finishStartupOwnerCleanup(prior: SessionRef): void {
    const now = this.#now();
    this.#transaction(() => {
      const row = this.#requireProvenDeadStartupOwner(prior);
      const { bindings, journal } = this.#requireStartupCleanupJournal(row);
      const obligations = (journal.obligations ?? {}) as Record<string, unknown>;
      for (const resource of ['androidMetroReverse', 'recorder', 'runner', 'observe'] as const) {
        const entry = obligations[resource];
        if (
          entry &&
          typeof entry === 'object' &&
          typeof (entry as Record<string, unknown>).completedAt !== 'number'
        ) {
          throw new SessionAuthorityError(
            'AUTOMATION_CLEANUP_UNPROVEN',
            `${resource} cleanup has not been durably completed`,
          );
        }
      }
      const metro = obligations.metro;
      if (
        metro &&
        typeof metro === 'object' &&
        typeof (metro as Record<string, unknown>).completedAt !== 'number'
      ) {
        throw new SessionAuthorityError(
          'METRO_CLEANUP_PENDING',
          'managed Metro cleanup has not been durably completed',
        );
      }
      this.#requireIntegrationRestored(bindings);
      this.#database
        .prepare('DELETE FROM claims WHERE session_id = ? AND claim_epoch = ?')
        .run(row.session_id, row.claim_epoch);
      this.#database
        .prepare(
          `UPDATE sessions
           SET state = 'released', claim_epoch = claim_epoch + 1,
               authority_version = authority_version + 1, bindings_json = ?, updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ?`,
        )
        .run(
          JSON.stringify({ ...bindings, startupCleanup: { ...journal, finishedAt: now } }),
          now,
          row.session_id,
          row.claim_epoch,
        );
    });
  }

  #requireProvenDeadStartupOwner(prior: SessionRef): SessionRow {
    const row = asSession(
      this.#database
        .prepare(
          `SELECT session_id, source_key, worktree_key, app_root_key,
                  claim_epoch, state, supervisor_pid, supervisor_birth,
                  lease_until_ms, bindings_json
           FROM sessions WHERE session_id = ?`,
        )
        .get(prior.sessionId),
    );
    if (!row || row.claim_epoch !== prior.claimEpoch) {
      throw new SessionAuthorityError(
        'SESSION_OWNER_LOST',
        'the startup cleanup owner no longer matches the proven claim epoch',
      );
    }
    let status: OwnerStatus = 'unknown';
    try {
      status = this.#ownerStatus({
        sessionId: row.session_id,
        pid: row.supervisor_pid,
        token: row.supervisor_birth,
      });
    } catch {
      status = 'unknown';
    }
    if (status === 'match') {
      throw new SessionAuthorityError(
        'RESOURCE_CLAIM_CONFLICT',
        'the same-root owner is live; a live owner is never released',
        { sessionId: row.session_id, claimEpoch: row.claim_epoch },
      );
    }
    if (status !== 'mismatch') {
      if (row.lease_until_ms < this.#now()) {
        throw new SessionAuthorityError(
          'STALE_LEASE_NOT_RECLAIMABLE',
          'expired lease owner identity could not be proven',
          { sessionId: row.session_id, claimEpoch: row.claim_epoch },
        );
      }
      throw new SessionAuthorityError(
        'RESOURCE_CLAIM_CONFLICT',
        'the same-root owner identity could not be proven, so it is treated as live',
        { sessionId: row.session_id, claimEpoch: row.claim_epoch },
      );
    }
    return row;
  }

  #requireStartupCleanupJournal(row: SessionRow): {
    bindings: Record<string, unknown>;
    journal: Record<string, unknown>;
  } {
    const bindings = JSON.parse(row.bindings_json) as Record<string, unknown>;
    const journal = bindings.startupCleanup;
    if (!journal || typeof journal !== 'object') {
      throw new SessionAuthorityError(
        'SESSION_AUTHORITY_REQUIRED',
        'no startup cleanup is in progress',
      );
    }
    return { bindings, journal: journal as Record<string, unknown> };
  }

  #assertStartupSourceScope(
    row: SessionRow,
    input: { sourceKey: string; worktreeKey: string; appRootKey: string },
  ): void {
    if (
      row.source_key !== input.sourceKey ||
      row.worktree_key !== input.worktreeKey ||
      row.app_root_key !== input.appRootKey
    ) {
      throw new SessionAuthorityError(
        'SESSION_AUTHORITY_REQUIRED',
        'startup cleanup no longer matches the exact source and app root',
      );
    }
  }

  #assertStartupObligationScope(
    row: SessionRow,
    resource: StartupCleanupResource,
    entry: Record<string, unknown>,
  ): void {
    const claimType =
      resource === 'observe'
        ? 'observe-port'
        : resource === 'metro'
          ? 'metro-port'
          : resource === 'androidMetroReverse'
            ? 'device'
            : resource;
    const claimKey = String(entry.claimKey ?? '');
    const claim = this.#findClaim(claimType, claimKey);
    if (
      !claimKey ||
      claim?.session_id !== row.session_id ||
      claim.claim_epoch !== row.claim_epoch
    ) {
      const codes = {
        androidMetroReverse: 'PHYSICAL_ANDROID_METRO_CLEANUP_UNPROVEN',
        recorder: 'RECORDING_AUTHORITY_MISMATCH',
        runner: 'RUNNER_OWNERSHIP_MISMATCH',
        observe: 'OBSERVE_AUTHORITY_MISMATCH',
        metro: 'METRO_AUTHORITY_MISMATCH',
      } as const;
      throw new SessionAuthorityError(
        codes[resource],
        `startup ${resource} cleanup journal no longer owns its exact claim`,
      );
    }
  }

  #requireStaleReleaseOwner(
    session: SessionRef,
    workerInstance: string,
  ): {
    row: SessionRow;
    bindings: Record<string, unknown>;
    cleanup: Record<string, unknown>;
  } {
    const row = this.#requireSession(session);
    if (row.worker_instance !== workerInstance) {
      throw new SessionAuthorityError(
        'HANDOFF_TARGET_MISMATCH',
        'stale device release is not owned by this worker',
      );
    }
    const bindings = JSON.parse(row.bindings_json) as Record<string, unknown>;
    const cleanup = bindings.staleDeviceCleanup;
    if (!cleanup || typeof cleanup !== 'object') {
      throw new SessionAuthorityError(
        'SESSION_AUTHORITY_REQUIRED',
        'no stale device release is in progress',
      );
    }
    const journal = cleanup as Record<string, unknown>;
    this.#assertStaleReleaseJournalScope(row, journal);
    return { row, bindings, cleanup: journal };
  }

  #assertNoStaleDeviceCleanup(bindings: Record<string, unknown>): void {
    const cleanup = bindings.staleDeviceCleanup as Record<string, unknown> | null | undefined;
    if (!cleanup || typeof cleanup.platform !== 'string' || typeof cleanup.deviceId !== 'string') {
      return;
    }
    throw new SessionAuthorityError(
      'AUTOMATION_CLEANUP_UNPROVEN',
      'stale device cleanup journal is incomplete',
      undefined,
      {
        axis: 'D',
        nextAction:
          'Resume it with rn_session({ action: "bind_device" }) for the exact journaled device ' +
          'or rn_session({ action: "release_stale_device" }) before binding any other device.',
      },
    );
  }

  #assertStaleReleaseJournalScope(
    row: SessionRow,
    cleanup: Record<string, unknown>,
    target?: { platform: string; deviceId: string },
  ): void {
    if (
      typeof cleanup.platform !== 'string' ||
      typeof cleanup.deviceId !== 'string' ||
      (target && (cleanup.platform !== target.platform || cleanup.deviceId !== target.deviceId))
    ) {
      throw new SessionAuthorityError(
        'DEVICE_AUTHORITY_MISMATCH',
        'stale device cleanup journal does not match the requested exact device',
        undefined,
        { axis: 'D', nextAction: 'Run rn_session with action "status" for the exact recovery.' },
      );
    }
    const deviceKey = `${cleanup.platform}:${cleanup.deviceId}`;
    const deviceClaim = this.#findClaim('device', deviceKey);
    if (deviceClaim?.session_id !== row.session_id || deviceClaim.claim_epoch !== row.claim_epoch) {
      throw new SessionAuthorityError(
        'DEVICE_AUTHORITY_MISMATCH',
        'stale device cleanup journal no longer owns its exact device claim',
      );
    }
    const reverse = cleanup.androidMetroReverse;
    if (
      reverse &&
      typeof reverse === 'object' &&
      typeof (reverse as Record<string, unknown>).completedAt !== 'number' &&
      String((reverse as Record<string, unknown>).claimKey ?? '') !== deviceKey
    ) {
      throw new SessionAuthorityError(
        'PHYSICAL_ANDROID_METRO_CLEANUP_UNPROVEN',
        'stale physical Android Metro cleanup journal no longer matches its exact device claim',
      );
    }
    for (const resource of ['runner', 'recorder'] as const) {
      const entry = cleanup[resource];
      if (
        !entry ||
        typeof entry !== 'object' ||
        typeof (entry as Record<string, unknown>).completedAt === 'number'
      ) {
        continue;
      }
      const binding = entry as Record<string, unknown>;
      const claimType = resource === 'runner' ? 'runner' : 'recorder';
      const expectedKey =
        resource === 'runner' ? `${deviceKey}:${String(binding.port)}` : deviceKey;
      const claimKey = String(binding.claimKey ?? '');
      const claim = this.#findClaim(claimType, claimKey);
      if (
        claimKey !== expectedKey ||
        claim?.session_id !== row.session_id ||
        claim.claim_epoch !== row.claim_epoch
      ) {
        throw new SessionAuthorityError(
          resource === 'runner' ? 'RUNNER_OWNERSHIP_MISMATCH' : 'RECORDING_AUTHORITY_MISMATCH',
          `stale ${resource} cleanup journal no longer owns its exact claim`,
        );
      }
    }
  }

  #deviceFamilyClaims(deviceKey: string): ClaimRow[] {
    return this.#database
      .prepare(
        `SELECT resource_type, resource_key, session_id, claim_epoch, lease_until_ms
         FROM claims
         WHERE (resource_type IN ('device', 'device-receipt', 'recorder') AND resource_key = ?)
            OR (resource_type IN ('runner', 'runner-receipt') AND resource_key LIKE ? ESCAPE '\\')
         ORDER BY resource_type, resource_key`,
      )
      .all(deviceKey, `${deviceKey.replace(/[\\%_]/g, '\\$&')}:%`) as unknown as ClaimRow[];
  }

  #bindingMatchesDevice(binding: unknown, target: { platform: string; deviceId: string }): boolean {
    if (!binding || typeof binding !== 'object') return false;
    const record = binding as Record<string, unknown>;
    return record.platform === target.platform && record.deviceId === target.deviceId;
  }

  #requireProvenDeadOwner(sessionId: string, claimEpoch: number): SessionRow {
    const prior = asSession(
      this.#database
        .prepare(
          `SELECT session_id, claim_epoch, state, supervisor_pid, supervisor_birth, bindings_json
           FROM sessions WHERE session_id = ?`,
        )
        .get(sessionId),
    );
    if (!prior || prior.claim_epoch !== claimEpoch) {
      throw new SessionAuthorityError(
        'SESSION_OWNER_LOST',
        'the released owner no longer matches the proven claim epoch',
      );
    }
    let status: OwnerStatus = 'unknown';
    try {
      status = this.#ownerStatus({
        sessionId: prior.session_id,
        pid: prior.supervisor_pid,
        token: prior.supervisor_birth,
      });
    } catch {
      status = 'unknown';
    }
    if (status === 'match') {
      throw new SessionAuthorityError(
        'DEVICE_CLAIM_CONFLICT',
        'the device owner is live; a live owner is never released',
        { sessionId: prior.session_id, claimEpoch: prior.claim_epoch },
      );
    }
    if (status !== 'mismatch') {
      throw new SessionAuthorityError(
        'STALE_LEASE_NOT_RECLAIMABLE',
        'the device owner identity could not be proven, so it is treated as live',
        { sessionId: prior.session_id, claimEpoch: prior.claim_epoch },
      );
    }
    return prior;
  }

  updateBindings(
    session: SessionRef,
    input: {
      state?: string;
      bindings: Record<string, unknown>;
      expectedAuthorityVersion?: number;
      releaseResources?: readonly ResourceClaim[];
      claimResources?: readonly ResourceClaim[];
      probeClaimOwners?: boolean;
      assertBeforeCommit?: () => void;
      onCommitted?: () => void;
    },
  ): void {
    const claimed = input.claimResources ?? [];
    const probes =
      input.probeClaimOwners && claimed.length > 0
        ? this.#probeClaimOwners(session, claimed)
        : null;
    const now = this.#now();
    this.#transaction(
      () => {
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
        this.#assertClaimsAvailable(session, claimed, probes, now);
        if (Object.hasOwn(input.bindings, 'device') || Object.hasOwn(input.bindings, 'install')) {
          const currentBindings = JSON.parse(current.bindings_json) as Record<string, unknown>;
          const platform = String(
            (
              (input.bindings.device ?? currentBindings.device) as
                | Record<string, unknown>
                | undefined
            )?.platform ?? '',
          );
          if (platform) {
            this.#invalidatePlatformReceipt(session, platform);
          }
        }
        for (const resource of input.releaseResources ?? []) {
          this.#database
            .prepare(
              `DELETE FROM claims
             WHERE resource_type = ? AND resource_key = ?
               AND session_id = ? AND claim_epoch = ?`,
            )
            .run(resource.type, resource.key, session.sessionId, session.claimEpoch);
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
            .run(resource.type, resource.key, session.sessionId, session.claimEpoch, leaseUntil);
        }
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
        this.#advanceActiveOperationFence(
          session,
          current.authority_version,
          current.authority_version + 1,
        );
      },
      input.assertBeforeCommit,
      input.onCommitted,
    );
  }

  replaceBindingsDuringOperation(
    operation: OperationRef,
    input: {
      state?: string;
      bindings: Record<string, unknown>;
      releaseResources?: readonly ResourceClaim[];
      claimResources?: readonly ResourceClaim[];
      assertBeforeCommit?: () => void;
      onCommitted?: (operation: OperationRef) => void;
    },
  ): OperationRef {
    const now = this.#now();
    return this.#transaction(
      () => {
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
          const claim = this.#findConflictingClaim(resource);
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
            .run(
              resource.type,
              resource.key,
              operation.sessionId,
              operation.claimEpoch,
              leaseUntil,
            );
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
        const context = this.#operationContext.getStore();
        if (context?.operationId === operation.operationId) {
          context.authorityVersion = nextAuthorityVersion;
        }
        return { ...operation, authorityVersion: nextAuthorityVersion };
      },
      input.assertBeforeCommit,
      input.onCommitted,
    );
  }

  endOperationWithBindings(operation: OperationRef, bindings: Record<string, unknown>): void {
    const now = this.#now();
    this.#transaction(() => {
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
      const nextBindings = {
        ...(JSON.parse(current.bindings_json) as Record<string, unknown>),
        ...bindings,
      };
      this.#database
        .prepare(
          `UPDATE sessions
           SET bindings_json = ?, authority_version = authority_version + 1, updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ? AND authority_version = ?`,
        )
        .run(
          JSON.stringify(nextBindings),
          now,
          operation.sessionId,
          operation.claimEpoch,
          operation.authorityVersion,
        );
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
    this.#pendingPlatformReceipts.delete(operation.operationId);
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

  isMetroEvidenceSocketReferencedByOtherSession(sessionId: string, path: string): boolean {
    const rows = this.#database
      .prepare(
        `SELECT bindings_json FROM sessions
         WHERE session_id <> ? AND state <> 'released'`,
      )
      .all(sessionId) as Array<{ bindings_json?: unknown }>;
    return rows.some((row) => {
      try {
        return referencesMetroEvidenceSocket(JSON.parse(String(row.bindings_json)), path);
      } catch {
        return true;
      }
    });
  }

  // GH #706: released and proven-stale rows are not live sessions, so they never
  // count towards the "multiple live sessions match this worktree" refusal.
  findSessionsByWorktree(worktreeKey: string): SessionStatus[] {
    const rows = this.#database
      .prepare(
        `SELECT session_id, supervisor_pid, supervisor_birth FROM sessions
         WHERE worktree_key = ? AND state NOT IN ('released', 'stale')
         ORDER BY updated_ms DESC`,
      )
      .all(worktreeKey) as Array<{
      session_id: string;
      supervisor_pid: number;
      supervisor_birth: string;
    }>;
    return rows
      .filter((row) => !this.#supervisorProvenDead(row))
      .map((row) => this.getSessionStatus(row.session_id))
      .filter((status): status is SessionStatus => status !== null);
  }

  #supervisorProvenDead(row: {
    session_id: string;
    supervisor_pid: number;
    supervisor_birth: string;
  }): boolean {
    try {
      return (
        this.#ownerStatus({
          sessionId: row.session_id,
          pid: row.supervisor_pid,
          token: row.supervisor_birth,
        }) === 'mismatch'
      );
    } catch {
      return false;
    }
  }

  getControllerBinding(session: SessionRef): ControllerBinding {
    const row = this.#requireSession(session);
    return this.#controllerBinding(row);
  }

  getHandoffCancellationControllerBinding(session: SessionRef): ControllerBinding {
    const row = this.#requireHandoffSession(session);
    return this.#controllerBinding(row);
  }

  #controllerBinding(row: SessionRow): ControllerBinding {
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

  beginSessionClose(session: SessionRef): SessionStatus {
    const now = this.#now();
    const operationIds = this.#transaction(() => {
      const current = this.#requireSession(session);
      const active = this.#database
        .prepare(
          `SELECT operation_id, profile FROM operations
           WHERE session_id = ? AND claim_epoch = ? LIMIT 1`,
        )
        .get(session.sessionId, session.claimEpoch) as
        | { operation_id?: unknown; profile?: unknown }
        | undefined;
      const bindings = JSON.parse(current.bindings_json) as Record<string, unknown>;
      this.#requireIntegrationRestored(bindings);
      const metro = (bindings.metroCleanup ?? bindings.metro) as
        | Record<string, unknown>
        | undefined;
      if (active?.profile === 'transition:ensure-metro' && metro?.mode !== 'managed') {
        throw new SessionAuthorityError(
          'SESSION_OPERATION_ACTIVE',
          'managed Metro transition has not published exact cleanup authority',
        );
      }
      const rows = this.#database
        .prepare(
          `SELECT operation_id FROM operations
           WHERE session_id = ? AND claim_epoch = ?`,
        )
        .all(session.sessionId, session.claimEpoch) as Array<{ operation_id?: unknown }>;
      this.#database
        .prepare('DELETE FROM operations WHERE session_id = ? AND claim_epoch = ?')
        .run(session.sessionId, session.claimEpoch);
      this.#database
        .prepare(
          `UPDATE sessions
           SET state = 'closing', authority_version = authority_version + 1, updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ?`,
        )
        .run(now, session.sessionId, session.claimEpoch);
      return rows.map((row) => String(row.operation_id));
    });
    for (const operationId of operationIds) {
      this.#pendingPlatformReceipts.delete(operationId);
    }
    const status = this.getSessionStatus(session.sessionId);
    if (!status || status.state !== 'closing') {
      throw new SessionAuthorityError(
        'SESSION_OWNER_LOST',
        'session close reservation did not persist',
      );
    }
    return status;
  }

  completeSessionClose(session: SessionRef): void {
    const now = this.#now();
    this.#transaction(() => {
      const row = asSession(
        this.#database
          .prepare('SELECT state, claim_epoch, bindings_json FROM sessions WHERE session_id = ?')
          .get(session.sessionId),
      );
      if (!row || row.state !== 'closing' || row.claim_epoch !== session.claimEpoch) {
        throw new SessionAuthorityError(
          'SESSION_OWNER_LOST',
          'only the unchanged closing session may be released',
        );
      }
      this.#requireIntegrationRestored(
        JSON.parse(String(row.bindings_json)) as Record<string, unknown>,
      );
      this.#database
        .prepare('DELETE FROM claims WHERE session_id = ? AND claim_epoch = ?')
        .run(session.sessionId, session.claimEpoch);
      this.#database
        .prepare(
          `UPDATE sessions
           SET state = 'released', claim_epoch = claim_epoch + 1,
               authority_version = authority_version + 1, updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ? AND state = 'closing'`,
        )
        .run(now, session.sessionId, session.claimEpoch);
    });
  }

  releaseSession(session: SessionRef): void {
    const now = this.#now();
    this.#transaction(() => {
      const current = this.#requireSession(session);
      this.#requireIntegrationRestored(
        JSON.parse(current.bindings_json) as Record<string, unknown>,
      );
      const active = this.#database
        .prepare(
          `SELECT operation_id, profile FROM operations
           WHERE session_id = ? AND claim_epoch = ? LIMIT 1`,
        )
        .get(session.sessionId, session.claimEpoch) as
        | { operation_id?: unknown; profile?: unknown }
        | undefined;
      if (active && !String(active.profile).startsWith('transition:')) {
        throw new SessionAuthorityError(
          'SESSION_OPERATION_ACTIVE',
          'session cannot be released while an operation is active',
        );
      }
      if (active) {
        const context = this.#operationContext.getStore();
        if (
          !context ||
          context.operationId !== active.operation_id ||
          context.sessionId !== session.sessionId ||
          context.claimEpoch !== session.claimEpoch
        ) {
          throw new SessionAuthorityError(
            'AUTHORITY_LOST_DURING_OPERATION',
            'session release is not owned by the active operation fence',
          );
        }
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
    input: { targetInstance?: string; targetHandle?: string; ttlMs?: number },
  ): HandoffCapability {
    const now = this.#now();
    const handoffId = randomBytes(16).toString('hex');
    const token = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(token).digest('hex');
    this.#transaction(() => {
      const current = this.#requireSession(session);
      let targetInstance = input.targetInstance;
      if (input.targetHandle) {
        const targets = this.#database
          .prepare(
            `SELECT session_id, bindings_json FROM sessions
             WHERE state = 'blocked' AND source_key = ? AND worktree_key = ? AND app_root_key = ?`,
          )
          .all(current.source_key, current.worktree_key, current.app_root_key) as {
          session_id: string;
          bindings_json: string;
        }[];
        for (const target of targets) {
          const bindings = JSON.parse(target.bindings_json) as Record<string, unknown>;
          const handles = bindings.recoveryHandles as
            | {
                handoffRecipient?: {
                  token?: unknown;
                  expiresMs?: unknown;
                  workerInstance?: unknown;
                };
              }
            | undefined;
          const handle = handles?.handoffRecipient;
          if (
            handle &&
            this.#recoveryHandleMatches(
              handle as unknown as Record<string, unknown>,
              input.targetHandle,
              now,
            )
          ) {
            targetInstance =
              typeof handle.workerInstance === 'string' ? handle.workerInstance : undefined;
            this.#database
              .prepare('UPDATE sessions SET bindings_json = ? WHERE session_id = ?')
              .run(
                JSON.stringify({
                  ...bindings,
                  recoveryHandles: { ...handles, handoffRecipient: null },
                }),
                target.session_id,
              );
            break;
          }
        }
      }
      if (!targetInstance) {
        throw new SessionAuthorityError(
          'HANDOFF_TARGET_MISMATCH',
          'handoff recipient capability is invalid or expired',
        );
      }
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
          targetInstance,
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
      this.#advanceActiveOperationFence(
        session,
        current.authority_version,
        current.authority_version + 1,
      );
    });
    return { handoffId, token };
  }

  prepareHandoffForHandle(
    session: SessionRef,
    input: { targetHandle: string; ttlMs?: number },
  ): HandoffCapability {
    return this.prepareHandoff(session, input);
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
          .prepare(
            `SELECT state, claim_epoch, authority_version, bindings_json
             FROM sessions WHERE session_id = ?`,
          )
          .get(session.sessionId),
      );
      if (!row || row.state !== 'handoff' || row.claim_epoch !== session.claimEpoch) {
        throw new SessionAuthorityError('SESSION_OWNER_LOST', 'handoff source owner changed');
      }
      const bindings = JSON.parse(row.bindings_json) as Record<string, unknown>;
      if (bindings.managedMetroHandoffReservation) {
        throw new SessionAuthorityError(
          'HANDOFF_NOT_AUTHORIZED',
          'handoff cancellation is fenced while managed Metro shutdown is reserved',
        );
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
      this.#advanceActiveOperationFence(session, row.authority_version, row.authority_version + 1);
    });
  }

  getHandoffOwner(handoffId: string): string | null {
    const row = this.#database
      .prepare('SELECT session_id FROM handoffs WHERE handoff_id = ?')
      .get(handoffId) as { session_id?: unknown } | undefined;
    return typeof row?.session_id === 'string' ? row.session_id : null;
  }

  reserveManagedMetroHandoffCleanup(
    target: SessionRef,
    input: HandoffIntoInput,
  ): ManagedMetroHandoffReservation | null {
    const now = this.#now();
    return this.#transaction(() => {
      const context = this.#requireHandoffIntoContext(target, input, {
        allowExactReservationAfterExpiry: true,
        commitRecipientRotation: true,
      });
      const active = this.#database
        .prepare(
          `SELECT operation_id FROM operations
           WHERE session_id = ?
              OR (session_id = ? AND profile NOT LIKE 'transition:%')
           LIMIT 1`,
        )
        .get(context.prior.session_id, target.sessionId);
      if (active) {
        throw new SessionAuthorityError(
          'SESSION_OPERATION_ACTIVE',
          'handoff cleanup cannot be reserved while either session has an active operation',
        );
      }
      const managedMetro =
        context.bindings.metro &&
        typeof context.bindings.metro === 'object' &&
        (context.bindings.metro as Record<string, unknown>).mode === 'managed'
          ? (context.bindings.metro as Record<string, unknown>)
          : null;
      if (!managedMetro) return null;
      if (context.reservation) return context.reservation;

      const reservation: ManagedMetroHandoffReservation = {
        handoffId: context.handoff.handoff_id,
        sourceClaimEpoch: context.handoff.claim_epoch,
        targetSessionId: target.sessionId,
        targetClaimEpoch: target.claimEpoch,
        targetInstance: input.targetInstance,
        phase: 'shutdown_reserved',
        metro: {
          ...managedMetro,
          sourceSessionId: context.prior.session_id,
          stopRequestedAt: now,
          completedAt: null,
        },
      };
      this.#database
        .prepare(
          `UPDATE sessions
           SET bindings_json = ?, authority_version = authority_version + 1, updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ? AND state = 'handoff'`,
        )
        .run(
          JSON.stringify({
            ...context.bindings,
            managedMetroHandoffReservation: reservation,
          }),
          now,
          context.prior.session_id,
          context.prior.claim_epoch,
        );
      return reservation;
    });
  }

  completeManagedMetroHandoffCleanup(
    target: SessionRef,
    input: HandoffIntoInput,
  ): ManagedMetroHandoffReservation {
    const now = this.#now();
    return this.#transaction(() => {
      const context = this.#requireHandoffIntoContext(target, input, {
        allowExactReservationAfterExpiry: true,
        commitRecipientRotation: true,
      });
      const reservation = context.reservation;
      if (!reservation) {
        throw new SessionAuthorityError(
          'HANDOFF_NOT_AUTHORIZED',
          'managed Metro shutdown has no durable handoff reservation',
        );
      }
      if (reservation.phase === 'shutdown_completed') return reservation;
      const completed: ManagedMetroHandoffReservation = {
        ...reservation,
        phase: 'shutdown_completed',
        metro: { ...reservation.metro, completedAt: now },
      };
      this.#database
        .prepare(
          `UPDATE sessions
           SET bindings_json = ?, authority_version = authority_version + 1, updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ? AND state = 'handoff'`,
        )
        .run(
          JSON.stringify({
            ...context.bindings,
            managedMetroHandoffReservation: completed,
          }),
          now,
          context.prior.session_id,
          context.prior.claim_epoch,
        );
      return completed;
    });
  }

  refuseManagedMetroHandoffCleanup(target: SessionRef, input: HandoffIntoInput): void {
    const now = this.#now();
    this.#transaction(() => {
      const context = this.#requireHandoffIntoContext(target, input, {
        allowExactReservationAfterExpiry: true,
        commitRecipientRotation: true,
      });
      const reservation = context.reservation;
      if (!reservation || reservation.phase !== 'shutdown_reserved') {
        throw new SessionAuthorityError(
          'HANDOFF_NOT_AUTHORIZED',
          'managed Metro shutdown refusal does not match an active reservation',
        );
      }
      const sourceState = this.#database
        .prepare('SELECT source_state FROM handoffs WHERE handoff_id = ?')
        .get(input.handoffId) as { source_state?: unknown } | undefined;
      if (typeof sourceState?.source_state !== 'string') {
        throw new SessionAuthorityError(
          'HANDOFF_NOT_AUTHORIZED',
          'handoff source state is unavailable for donor restoration',
        );
      }
      this.#database
        .prepare(
          `UPDATE sessions
           SET state = ?, bindings_json = ?, authority_version = authority_version + 1,
               updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ? AND state = 'handoff'`,
        )
        .run(
          sourceState.source_state,
          JSON.stringify({
            ...context.bindings,
            managedMetroHandoffReservation: null,
          }),
          now,
          context.prior.session_id,
          context.prior.claim_epoch,
        );
      this.#database
        .prepare('UPDATE handoffs SET consumed_ms = ? WHERE handoff_id = ?')
        .run(now, input.handoffId);
    });
  }

  validateHandoffInto(
    target: SessionRef,
    input: { handoffId: string; token: string; targetInstance: string },
  ): void {
    this.#transaction(() => {
      this.#requireHandoffIntoContext(target, input, {
        allowExactReservationAfterExpiry: false,
        commitRecipientRotation: false,
      });
    });
  }

  validateHandoffCleanupResumption(target: SessionRef, input: HandoffIntoInput): void {
    this.#transaction(() => {
      const row = asSession(
        this.#database
          .prepare(
            `SELECT state, claim_epoch, worker_instance, bindings_json
             FROM sessions WHERE session_id = ?`,
          )
          .get(target.sessionId),
      );
      const bindings = row ? (JSON.parse(row.bindings_json) as Record<string, unknown>) : {};
      const cleanup =
        bindings.handoffCleanup && typeof bindings.handoffCleanup === 'object'
          ? (bindings.handoffCleanup as Record<string, unknown>)
          : null;
      const handoff = this.#database
        .prepare('SELECT token_hash, consumed_ms FROM handoffs WHERE handoff_id = ?')
        .get(input.handoffId) as { token_hash?: unknown; consumed_ms?: unknown } | undefined;
      const expected = Buffer.from(
        typeof handoff?.token_hash === 'string' ? handoff.token_hash : '',
        'hex',
      );
      const actual = createHash('sha256').update(input.token).digest();
      const tokenMatches = expected.length === actual.length && timingSafeEqual(expected, actual);
      if (
        !row ||
        row.state !== 'handoff_cleanup' ||
        row.claim_epoch !== target.claimEpoch ||
        row.worker_instance !== input.targetInstance ||
        cleanup?.handoffId !== input.handoffId ||
        cleanup?.targetSessionId !== target.sessionId ||
        cleanup?.targetClaimEpoch !== target.claimEpoch ||
        typeof handoff?.consumed_ms !== 'number' ||
        !tokenMatches
      ) {
        throw new SessionAuthorityError(
          'HANDOFF_NOT_AUTHORIZED',
          'handoff cleanup resumption requires the original handoff capability',
        );
      }
    });
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
      const sessionBindings = JSON.parse(session.bindings_json) as Record<string, unknown>;
      if (
        sessionBindings.metro &&
        typeof sessionBindings.metro === 'object' &&
        (sessionBindings.metro as Record<string, unknown>).mode === 'managed'
      ) {
        throw new SessionAuthorityError(
          'METRO_AUTHORITY_MISMATCH',
          'managed Metro handoff requires durable cleanup through a blocked recipient',
        );
      }

      const nextEpoch = session.claim_epoch + 1;
      const leaseUntil = now + this.#leaseMs;
      this.#database
        .prepare(
          `DELETE FROM claims
           WHERE session_id = ? AND claim_epoch = ?
             AND resource_type NOT IN ('source', 'metro-port', 'observe-port', 'device', 'recorder')`,
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
            ...sessionBindings,
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

  acceptHandoffInto(target: SessionRef, input: HandoffIntoInput): HandoffCleanupPlan {
    const now = this.#now();
    return this.#transaction(() => {
      const context = this.#requireHandoffIntoContext(target, input, {
        allowExactReservationAfterExpiry: true,
        commitRecipientRotation: true,
      });
      const { targetRow, handoff, prior, bindings } = context;
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
      const priorRunnerClaim = this.#database
        .prepare(
          `SELECT resource_key FROM claims
           WHERE session_id = ? AND claim_epoch = ? AND resource_type = 'runner'`,
        )
        .get(prior.session_id, prior.claim_epoch) as { resource_key?: unknown } | undefined;
      if (bindingsRunnerPresent(prior.bindings_json) && !priorRunnerClaim?.resource_key) {
        throw new SessionAuthorityError(
          'RUNNER_OWNERSHIP_MISMATCH',
          'handoff runner binding has no exclusive cleanup claim',
        );
      }
      const managedMetro =
        bindings.metro &&
        typeof bindings.metro === 'object' &&
        (bindings.metro as Record<string, unknown>).mode === 'managed'
          ? (bindings.metro as Record<string, unknown>)
          : null;
      if (
        managedMetro &&
        (!context.reservation ||
          context.reservation.phase !== 'shutdown_completed' ||
          typeof context.reservation.metro.completedAt !== 'number')
      ) {
        throw new SessionAuthorityError(
          'METRO_AUTHORITY_MISMATCH',
          'managed Metro shutdown reservation must be durably completed before ownership transfers',
        );
      }
      const priorRecorderClaim = this.#database
        .prepare(
          `SELECT resource_key FROM claims
           WHERE session_id = ? AND claim_epoch = ? AND resource_type = 'recorder'`,
        )
        .get(prior.session_id, prior.claim_epoch) as { resource_key?: unknown } | undefined;
      if (bindings.recorder && !priorRecorderClaim?.resource_key) {
        throw new SessionAuthorityError(
          'RECORDING_AUTHORITY_MISMATCH',
          'handoff recorder binding has no exclusive cleanup claim',
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
             AND resource_type NOT IN ('source', 'metro-port', 'observe-port', 'device', 'runner', 'recorder')`,
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
      const targetBindings = JSON.parse(targetRow.bindings_json) as Record<string, unknown>;
      this.#database
        .prepare(
          `UPDATE sessions
           SET state = 'handoff_cleanup', bindings_json = ?,
               authority_version = authority_version + 1, updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ?`,
        )
        .run(
          JSON.stringify({
            ...bindings,
            managedMetroHandoffReservation: null,
            metro: managedMetro ? null : bindings.metro,
            bundle: null,
            runner: null,
            recorder: null,
            observe: null,
            proof: null,
            pendingBuild: null,
            recoveryCapabilityHash: targetBindings.recoveryCapabilityHash,
            handoffCleanup: {
              handoffId: handoff.handoff_id,
              targetSessionId: target.sessionId,
              targetClaimEpoch: target.claimEpoch,
              metro: null,
              observe:
                bindings.observe && typeof bindings.observe === 'object'
                  ? {
                      ...(bindings.observe as Record<string, unknown>),
                      stopRequestedAt: null,
                      completedAt: null,
                    }
                  : null,
              runner:
                bindings.runner && typeof bindings.runner === 'object'
                  ? {
                      ...(bindings.runner as Record<string, unknown>),
                      claimKey: priorRunnerClaim?.resource_key,
                      stopRequestedAt: null,
                      completedAt: null,
                    }
                  : null,
              recorder:
                bindings.recorder && typeof bindings.recorder === 'object'
                  ? {
                      ...(bindings.recorder as Record<string, unknown>),
                      claimKey: priorRecorderClaim?.resource_key,
                      stopRequestedAt: null,
                      completedAt: null,
                    }
                  : null,
            },
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
      return {
        ...(this.getSessionStatus(target.sessionId)?.bindings.handoffCleanup as
          | HandoffCleanupPlan
          | undefined),
      };
    });
  }

  beginHandoffCleanupResource(
    target: SessionRef,
    targetInstance: string,
    resource: 'metro' | 'runner' | 'observe' | 'recorder',
  ): Record<string, unknown> | null {
    const now = this.#now();
    return this.#transaction(() => {
      const row = this.#requireHandoffCleanupOwner(target, targetInstance);
      const bindings = JSON.parse(row.bindings_json) as Record<string, unknown>;
      const cleanup = bindings.handoffCleanup as Record<string, unknown> | undefined;
      const current = cleanup?.[resource];
      if (!current || typeof current !== 'object') return null;
      const binding = current as Record<string, unknown>;
      if (typeof binding.completedAt === 'number') return binding;
      if (resource === 'runner') {
        const claimKey = String(binding.claimKey ?? '');
        const expectedClaimKey = `${String(binding.platform)}:${String(
          binding.deviceId,
        )}:${String(binding.port)}`;
        const claim = this.#findClaim('runner', claimKey);
        if (
          !claimKey ||
          claimKey !== expectedClaimKey ||
          claim?.session_id !== target.sessionId ||
          claim.claim_epoch !== target.claimEpoch ||
          typeof binding.capability !== 'string' ||
          typeof binding.instanceId !== 'string'
        ) {
          throw new SessionAuthorityError(
            'RUNNER_OWNERSHIP_MISMATCH',
            'handoff runner cleanup claim no longer matches the authenticated binding',
          );
        }
      }
      if (resource === 'recorder') {
        const claimKey = String(binding.claimKey ?? '');
        const expectedClaimKey = `${String(binding.platform)}:${String(binding.deviceId)}`;
        const claim = this.#findClaim('recorder', claimKey);
        if (
          !claimKey ||
          claimKey !== expectedClaimKey ||
          claim?.session_id !== target.sessionId ||
          claim.claim_epoch !== target.claimEpoch ||
          typeof binding.scope !== 'string' ||
          (binding.phase !== 'starting' && typeof binding.processBirth !== 'string')
        ) {
          throw new SessionAuthorityError(
            'RECORDING_AUTHORITY_MISMATCH',
            'handoff recorder cleanup claim no longer matches the authenticated binding',
          );
        }
      }
      if (resource === 'metro') {
        const claim = this.#findClaim('metro-port', String(binding.port));
        if (
          binding.port !== bindings.metroPort ||
          claim?.session_id !== target.sessionId ||
          claim.claim_epoch !== target.claimEpoch
        ) {
          throw new SessionAuthorityError(
            'METRO_AUTHORITY_MISMATCH',
            'handoff Metro cleanup claim no longer matches the authenticated binding',
          );
        }
      }
      if (resource === 'observe') {
        const claim = this.#findClaim('observe-port', String(binding.port));
        if (
          binding.port !== bindings.observePort ||
          claim?.session_id !== target.sessionId ||
          claim.claim_epoch !== target.claimEpoch
        ) {
          throw new SessionAuthorityError(
            'OBSERVE_AUTHORITY_MISMATCH',
            'handoff Observe cleanup claim no longer matches the authenticated binding',
          );
        }
      }
      const requested = {
        ...binding,
        stopRequestedAt:
          typeof binding.stopRequestedAt === 'number' ? binding.stopRequestedAt : now,
      };
      this.#database
        .prepare(
          `UPDATE sessions SET bindings_json = ?, updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ? AND state = 'handoff_cleanup'`,
        )
        .run(
          JSON.stringify({
            ...bindings,
            handoffCleanup: { ...cleanup, [resource]: requested },
          }),
          now,
          target.sessionId,
          target.claimEpoch,
        );
      return requested;
    });
  }

  completeHandoffCleanupResource(
    target: SessionRef,
    targetInstance: string,
    resource: 'metro' | 'runner' | 'observe' | 'recorder',
  ): void {
    const now = this.#now();
    this.#transaction(() => {
      const row = this.#requireHandoffCleanupOwner(target, targetInstance);
      const bindings = JSON.parse(row.bindings_json) as Record<string, unknown>;
      const cleanup = bindings.handoffCleanup as Record<string, unknown> | undefined;
      const current = cleanup?.[resource];
      if (!current || typeof current !== 'object') return;
      const binding = current as Record<string, unknown>;
      if (typeof binding.stopRequestedAt !== 'number') {
        throw new SessionAuthorityError(
          'HANDOFF_NOT_AUTHORIZED',
          `${resource} cleanup was not durably requested`,
        );
      }
      if (typeof binding.completedAt === 'number') return;
      if (resource === 'runner') {
        this.#database
          .prepare(
            `DELETE FROM claims
             WHERE resource_type = 'runner' AND resource_key = ?
               AND session_id = ? AND claim_epoch = ?`,
          )
          .run(String(binding.claimKey), target.sessionId, target.claimEpoch);
      }
      if (resource === 'recorder') {
        this.#database
          .prepare(
            `DELETE FROM claims
             WHERE resource_type = 'recorder' AND resource_key = ?
               AND session_id = ? AND claim_epoch = ?`,
          )
          .run(String(binding.claimKey), target.sessionId, target.claimEpoch);
      }
      this.#database
        .prepare(
          `UPDATE sessions SET bindings_json = ?, updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ? AND state = 'handoff_cleanup'`,
        )
        .run(
          JSON.stringify({
            ...bindings,
            handoffCleanup: {
              ...cleanup,
              [resource]: { ...binding, completedAt: now },
            },
          }),
          now,
          target.sessionId,
          target.claimEpoch,
        );
    });
  }

  finishHandoffCleanup(target: SessionRef, targetInstance: string): void {
    const now = this.#now();
    this.#transaction(() => {
      const row = asSession(
        this.#database
          .prepare(
            `SELECT state, claim_epoch, worker_instance, bindings_json
             FROM sessions WHERE session_id = ?`,
          )
          .get(target.sessionId),
      );
      if (
        !row ||
        row.state !== 'handoff_cleanup' ||
        row.claim_epoch !== target.claimEpoch ||
        row.worker_instance !== targetInstance
      ) {
        throw new SessionAuthorityError(
          'HANDOFF_NOT_AUTHORIZED',
          'handoff cleanup is not owned by this recovery worker',
        );
      }
      const bindings = JSON.parse(row.bindings_json) as Record<string, unknown>;
      const cleanup = bindings.handoffCleanup as Record<string, unknown> | undefined;
      for (const resource of ['metro', 'runner', 'observe', 'recorder'] as const) {
        const binding = cleanup?.[resource];
        if (
          binding &&
          typeof binding === 'object' &&
          typeof (binding as Record<string, unknown>).completedAt !== 'number'
        ) {
          throw new SessionAuthorityError(
            'HANDOFF_NOT_AUTHORIZED',
            `${resource} cleanup has not been durably completed`,
          );
        }
      }
      const staleDeviceCleanup = bindings.staleDeviceCleanup as
        | Record<string, unknown>
        | null
        | undefined;
      if (
        staleDeviceCleanup &&
        typeof staleDeviceCleanup.platform === 'string' &&
        typeof staleDeviceCleanup.deviceId === 'string'
      ) {
        const deviceKey = `${staleDeviceCleanup.platform}:${staleDeviceCleanup.deviceId}`;
        for (const claim of this.#deviceFamilyClaims(deviceKey)) {
          if (claim.session_id !== target.sessionId || claim.claim_epoch !== target.claimEpoch) {
            continue;
          }
          this.#database
            .prepare(
              `DELETE FROM claims
               WHERE resource_type = ? AND resource_key = ?
                 AND session_id = ? AND claim_epoch = ?`,
            )
            .run(claim.resource_type, claim.resource_key, target.sessionId, target.claimEpoch);
        }
      }
      this.#database
        .prepare(
          `UPDATE sessions
           SET state = 'source_bound', bindings_json = ?,
               authority_version = authority_version + 1, updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ? AND state = 'handoff_cleanup'`,
        )
        .run(
          JSON.stringify({
            ...bindings,
            handoffCleanup: null,
            recoveryHandles: null,
            staleDeviceCleanup: null,
            staleDeviceRelease: null,
          }),
          now,
          target.sessionId,
          target.claimEpoch,
        );
    });
  }

  recordPlatformAuthorityReceipt(
    session: SessionRef,
    platform: string,
    receipt: Record<string, unknown>,
  ): void {
    const operation = this.#operationContext.getStore();
    if (
      !operation ||
      operation.sessionId !== session.sessionId ||
      operation.claimEpoch !== session.claimEpoch
    ) {
      throw new SessionAuthorityError(
        'AUTHORITY_LOST_DURING_OPERATION',
        'platform receipt recording requires the active operation fence',
      );
    }
    this.verifyOperation(operation);
    const staged = this.#platformReceiptFromCurrentAuthority(session, platform, receipt);
    const pending = this.#pendingPlatformReceipts.get(operation.operationId) ?? [];
    pending.push(staged);
    this.#pendingPlatformReceipts.set(operation.operationId, pending);
  }

  commitPlatformAuthorityReceipts(operation: OperationRef): void {
    const pending = this.#pendingPlatformReceipts.get(operation.operationId) ?? [];
    if (pending.length === 0) return;
    const now = this.#now();
    this.#transaction(() => {
      this.verifyOperation(operation);
      for (const staged of pending) {
        const current = this.#platformReceiptFromCurrentAuthority(
          staged.session,
          staged.platform,
          staged.receipt,
        );
        this.#invalidatePlatformReceipt(staged.session, staged.platform);
        this.#database
          .prepare(
            `INSERT INTO platform_authority_receipts(
               session_id, claim_epoch, platform, receipt_json, updated_ms
             ) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(session_id, platform) DO UPDATE SET
               claim_epoch = excluded.claim_epoch,
               receipt_json = excluded.receipt_json,
               updated_ms = excluded.updated_ms`,
          )
          .run(
            staged.session.sessionId,
            staged.session.claimEpoch,
            staged.platform,
            JSON.stringify({ receipt: staged.receipt, probe: current.probe }),
            now,
          );
      }
    });
    this.#pendingPlatformReceipts.delete(operation.operationId);
  }

  validatePlatformAuthorityReceipt(
    session: SessionRef,
    platform: string,
    receipt: Record<string, unknown>,
  ): boolean {
    const row = this.#database
      .prepare(
        `SELECT claim_epoch, receipt_json FROM platform_authority_receipts
         WHERE session_id = ? AND platform = ?`,
      )
      .get(session.sessionId, platform) as
      | { claim_epoch?: unknown; receipt_json?: unknown }
      | undefined;
    const persisted =
      typeof row?.receipt_json === 'string'
        ? (JSON.parse(row.receipt_json) as Record<string, unknown>)
        : null;
    const persistedReceipt =
      persisted?.receipt && typeof persisted.receipt === 'object'
        ? (persisted.receipt as Record<string, unknown>)
        : persisted;
    return (
      row?.claim_epoch === session.claimEpoch &&
      JSON.stringify(persistedReceipt) === JSON.stringify(receipt)
    );
  }

  getPlatformAuthorityProbe(
    session: SessionRef,
    platform: string,
    receipt: Record<string, unknown>,
  ): PlatformAuthorityProbe | null {
    if (!this.validatePlatformAuthorityReceipt(session, platform, receipt)) return null;
    const row = this.#database
      .prepare(
        `SELECT receipt_json FROM platform_authority_receipts
         WHERE session_id = ? AND claim_epoch = ? AND platform = ?`,
      )
      .get(session.sessionId, session.claimEpoch, platform) as
      | { receipt_json?: unknown }
      | undefined;
    if (typeof row?.receipt_json !== 'string') return null;
    const persisted = JSON.parse(row.receipt_json) as { probe?: PlatformAuthorityProbe };
    const probe = persisted.probe;
    if (
      !probe ||
      createHash('sha256').update(probe.capability).digest('hex') !== receipt.runnerCapabilityHash
    ) {
      return null;
    }
    return probe;
  }

  adoptStaleIntoBlocked(
    target: SessionRef,
    priorSessionId: string,
    targetInstance: string,
    options: { expectedTargetAuthorityVersion?: number } = {},
  ): void {
    const priorStatus = this.getSessionStatus(priorSessionId);
    if (!priorStatus) {
      throw new SessionAuthorityError('SESSION_OWNER_LOST', 'stale session is unavailable');
    }
    const owner = asSession(
      this.#database
        .prepare(`SELECT supervisor_pid, supervisor_birth FROM sessions WHERE session_id = ?`)
        .get(priorSessionId),
    );
    if (
      !owner ||
      this.#ownerStatus({
        sessionId: priorSessionId,
        pid: owner.supervisor_pid,
        token: owner.supervisor_birth,
      }) !== 'mismatch'
    ) {
      throw new SessionAuthorityError(
        'SESSION_AUTHORITY_REQUIRED',
        'prior source owner is not proven stale',
      );
    }
    const now = this.#now();
    this.#transaction(() => {
      const targetRow = this.#requireRecoverableSession(target);
      if (targetRow.state !== 'blocked') {
        throw new SessionAuthorityError(
          'HANDOFF_NOT_AUTHORIZED',
          'stale adoption is not available during handoff cleanup',
        );
      }
      if (
        options.expectedTargetAuthorityVersion !== undefined &&
        targetRow.authority_version !== options.expectedTargetAuthorityVersion
      ) {
        throw new SessionAuthorityError(
          'AUTHORITY_LOST_DURING_OPERATION',
          'session authority version changed after the adoption preflight proof',
        );
      }
      if (targetRow.worker_instance !== targetInstance) {
        throw new SessionAuthorityError(
          'HANDOFF_TARGET_MISMATCH',
          'stale adoption target is not the recovery worker',
        );
      }
      const prior = asSession(
        this.#database
          .prepare(
            `SELECT session_id, source_key, worktree_key, app_root_key, state,
                    claim_epoch, bindings_json
             FROM sessions WHERE session_id = ?`,
          )
          .get(priorSessionId),
      );
      if (
        !prior ||
        prior.claim_epoch !== priorStatus.claimEpoch ||
        prior.source_key !== targetRow.source_key ||
        prior.worktree_key !== targetRow.worktree_key ||
        prior.app_root_key !== targetRow.app_root_key
      ) {
        throw new SessionAuthorityError(
          'SOURCE_WORKTREE_MISMATCH',
          'stale session does not belong to this exact source worktree',
        );
      }
      const priorBindings = JSON.parse(prior.bindings_json) as Record<string, unknown>;
      const targetBindings = JSON.parse(targetRow.bindings_json) as Record<string, unknown>;
      const priorStaleDeviceCleanup =
        priorBindings.staleDeviceCleanup && typeof priorBindings.staleDeviceCleanup === 'object'
          ? (priorBindings.staleDeviceCleanup as Record<string, unknown>)
          : null;
      const priorCleanup =
        priorBindings.handoffCleanup && typeof priorBindings.handoffCleanup === 'object'
          ? (priorBindings.handoffCleanup as Record<string, unknown>)
          : null;
      const resumesCleanup = prior.state === 'handoff_cleanup' && priorCleanup !== null;
      if (prior.state === 'handoff_cleanup' && !resumesCleanup) {
        throw new SessionAuthorityError(
          'HANDOFF_NOT_AUTHORIZED',
          'stale handoff cleanup state has no durable cleanup plan',
        );
      }
      if (resumesCleanup) {
        const mergedCleanup = this.#mergeStaleDeviceCleanup(priorCleanup, priorStaleDeviceCleanup);
        const resumesMetroCleanup =
          mergedCleanup.metro !== null && typeof mergedCleanup.metro === 'object';
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
        this.#database
          .prepare(
            `UPDATE sessions
             SET state = 'handoff_cleanup', bindings_json = ?,
                 authority_version = authority_version + 1, updated_ms = ?
             WHERE session_id = ? AND claim_epoch = ? AND state = 'blocked'`,
          )
          .run(
            JSON.stringify({
              ...targetBindings,
              adoptionRequired: null,
              recoveryHandles: targetBindings.recoveryHandles,
              metro: resumesMetroCleanup ? null : (priorBindings.metro ?? null),
              metroCleanup: resumesMetroCleanup ? null : (priorBindings.metroCleanup ?? null),
              device: priorBindings.device ?? null,
              install: priorBindings.install ?? null,
              packageIntegration: priorBindings.packageIntegration ?? null,
              bundle: null,
              runner: null,
              recorder: null,
              observe: null,
              proof: null,
              handoffCleanup: mergedCleanup,
              staleDeviceCleanup: priorStaleDeviceCleanup,
            }),
            now,
            target.sessionId,
            target.claimEpoch,
          );
        this.#fenceSession(prior.session_id, now);
        return;
      }
      const activeOperation = this.#database
        .prepare(
          `SELECT profile FROM operations
           WHERE session_id = ? AND claim_epoch = ? LIMIT 1`,
        )
        .get(prior.session_id, prior.claim_epoch) as { profile?: unknown } | undefined;
      const priorMetro =
        priorBindings.metro && typeof priorBindings.metro === 'object'
          ? (priorBindings.metro as Record<string, unknown>)
          : null;
      const metroCleanup =
        priorBindings.metroCleanup && typeof priorBindings.metroCleanup === 'object'
          ? (priorBindings.metroCleanup as Record<string, unknown>)
          : priorMetro?.mode === 'managed'
            ? priorMetro
            : null;
      const runnerCleanup =
        priorBindings.runner && typeof priorBindings.runner === 'object'
          ? (priorBindings.runner as Record<string, unknown>)
          : priorStaleDeviceCleanup?.runner && typeof priorStaleDeviceCleanup.runner === 'object'
            ? (priorStaleDeviceCleanup.runner as Record<string, unknown>)
            : null;
      const observeCleanup =
        priorBindings.observe && typeof priorBindings.observe === 'object'
          ? (priorBindings.observe as Record<string, unknown>)
          : null;
      const recorderCleanup =
        priorBindings.recorder && typeof priorBindings.recorder === 'object'
          ? (priorBindings.recorder as Record<string, unknown>)
          : priorStaleDeviceCleanup?.recorder &&
              typeof priorStaleDeviceCleanup.recorder === 'object'
            ? (priorStaleDeviceCleanup.recorder as Record<string, unknown>)
            : null;
      const runnerFromStale = runnerCleanup === priorStaleDeviceCleanup?.runner;
      const recorderFromStale = recorderCleanup === priorStaleDeviceCleanup?.recorder;
      if (
        activeOperation?.profile === 'transition:ensure-metro' &&
        !metroCleanup &&
        !priorBindings.metro
      ) {
        throw new SessionAuthorityError(
          'SESSION_OPERATION_ACTIVE',
          'stale Metro transition has not published exact cleanup authority',
        );
      }
      let runnerClaimKey: string | null = null;
      if (runnerCleanup) {
        runnerClaimKey = runnerFromStale
          ? String(runnerCleanup.claimKey)
          : `${String(runnerCleanup.platform)}:${String(runnerCleanup.deviceId)}:${String(
              runnerCleanup.port,
            )}`;
        if (typeof runnerCleanup.completedAt !== 'number') {
          const runnerClaim = this.#findClaim('runner', runnerClaimKey);
          if (
            runnerClaim?.session_id !== prior.session_id ||
            runnerClaim.claim_epoch !== prior.claim_epoch
          ) {
            throw new SessionAuthorityError(
              'RUNNER_OWNERSHIP_MISMATCH',
              'stale runner cleanup claim no longer matches the authenticated binding',
            );
          }
        }
      }
      let recorderClaimKey: string | null = null;
      if (recorderCleanup) {
        recorderClaimKey = recorderFromStale
          ? String(recorderCleanup.claimKey)
          : `${String(recorderCleanup.platform)}:${String(recorderCleanup.deviceId)}`;
        if (typeof recorderCleanup.completedAt !== 'number') {
          const recorderClaim = this.#findClaim('recorder', recorderClaimKey);
          if (
            recorderClaim?.session_id !== prior.session_id ||
            recorderClaim.claim_epoch !== prior.claim_epoch
          ) {
            throw new SessionAuthorityError(
              'RECORDING_AUTHORITY_MISMATCH',
              'stale recorder cleanup claim no longer matches the authenticated binding',
            );
          }
        }
      }
      if (observeCleanup) {
        const observePort = String(observeCleanup.port);
        const observeClaim = this.#findClaim('observe-port', observePort);
        if (
          priorBindings.observePort !== observeCleanup.port ||
          observeClaim?.session_id !== prior.session_id ||
          observeClaim.claim_epoch !== prior.claim_epoch
        ) {
          throw new SessionAuthorityError(
            'OBSERVE_AUTHORITY_MISMATCH',
            'stale Observe cleanup claim no longer matches the authenticated binding',
          );
        }
      }
      this.#database
        .prepare(
          `DELETE FROM claims
           WHERE session_id = ? AND claim_epoch = ?
             AND resource_type NOT IN ('source', 'metro-port', 'observe-port', 'device', 'runner', 'recorder')`,
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
      const cleanupRequired = Boolean(
        metroCleanup ||
        runnerCleanup ||
        observeCleanup ||
        recorderCleanup ||
        priorStaleDeviceCleanup,
      );
      const sameMetro = Number(priorMetro?.port) === Number(targetBindings.metroPort);
      this.#database
        .prepare(
          `UPDATE sessions
           SET state = ?, bindings_json = ?, authority_version = authority_version + 1,
               updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ? AND state = 'blocked'`,
        )
        .run(
          cleanupRequired
            ? 'handoff_cleanup'
            : sameMetro && priorBindings.device
              ? 'device_bound'
              : 'source_bound',
          JSON.stringify({
            ...targetBindings,
            adoptionRequired: null,
            recoveryHandles: cleanupRequired ? targetBindings.recoveryHandles : null,
            metro: metroCleanup ? null : sameMetro ? priorBindings.metro : null,
            metroCleanup: null,
            device: priorBindings.device ?? null,
            install: priorBindings.install ?? null,
            packageIntegration: priorBindings.packageIntegration ?? null,
            bundle: null,
            runner: null,
            recorder: null,
            observe: null,
            proof: null,
            staleDeviceCleanup: priorStaleDeviceCleanup,
            handoffCleanup: cleanupRequired
              ? {
                  metro: metroCleanup
                    ? {
                        ...metroCleanup,
                        sourceSessionId: prior.session_id,
                        stopRequestedAt: null,
                        completedAt: null,
                      }
                    : null,
                  runner: runnerCleanup
                    ? runnerFromStale
                      ? runnerCleanup
                      : {
                          ...runnerCleanup,
                          claimKey: runnerClaimKey,
                          stopRequestedAt: null,
                          completedAt: null,
                        }
                    : null,
                  recorder: recorderCleanup
                    ? recorderFromStale
                      ? recorderCleanup
                      : {
                          ...recorderCleanup,
                          claimKey: recorderClaimKey,
                          stopRequestedAt: null,
                          completedAt: null,
                        }
                    : null,
                  observe: observeCleanup
                    ? {
                        ...observeCleanup,
                        stopRequestedAt: null,
                        completedAt: null,
                      }
                    : null,
                }
              : null,
          }),
          now,
          target.sessionId,
          target.claimEpoch,
        );
      this.#fenceSession(prior.session_id, now);
    });
  }

  #requireStaleAdoptionContext(
    target: SessionRef,
    handle: string,
    targetInstance: string,
  ): { priorSessionId: string } {
    const targetStatus = this.getSessionStatus(target.sessionId);
    const recovery = targetStatus?.bindings.recoveryHandles as
      | {
          adoptStale?: {
            token?: unknown;
            expiresMs?: unknown;
            priorSessionId?: unknown;
            priorClaimEpoch?: unknown;
          };
        }
      | undefined;
    const adoption = recovery?.adoptStale;
    if (
      targetStatus?.state !== 'blocked' ||
      targetStatus.claimEpoch !== target.claimEpoch ||
      typeof adoption?.token !== 'string' ||
      typeof adoption.expiresMs !== 'number' ||
      typeof adoption.priorSessionId !== 'string' ||
      !this.#recoveryHandleMatches(adoption as Record<string, unknown>, handle, this.#now())
    ) {
      throw new SessionAuthorityError(
        'HANDOFF_NOT_AUTHORIZED',
        'stale adoption capability is invalid or expired',
      );
    }
    if (targetStatus.worker.instanceId !== targetInstance) {
      throw new SessionAuthorityError(
        'HANDOFF_TARGET_MISMATCH',
        'stale adoption target is not the recovery worker',
      );
    }
    const prior = this.getSessionStatus(adoption.priorSessionId);
    if (!prior || prior.claimEpoch !== adoption.priorClaimEpoch) {
      throw new SessionAuthorityError(
        'SESSION_OWNER_LOST',
        'stale adoption capability no longer matches the prior claim epoch',
      );
    }
    if (
      prior.sourceKey !== targetStatus.sourceKey ||
      prior.worktreeKey !== targetStatus.worktreeKey ||
      prior.appRootKey !== targetStatus.appRootKey
    ) {
      throw new SessionAuthorityError(
        'SOURCE_WORKTREE_MISMATCH',
        'stale session does not belong to this exact source worktree',
      );
    }
    return { priorSessionId: adoption.priorSessionId };
  }

  validateStaleAdoption(target: SessionRef, handle: string, targetInstance: string): void {
    this.#requireStaleAdoptionContext(target, handle, targetInstance);
  }

  adoptStaleWithHandle(
    target: SessionRef,
    handle: string,
    targetInstance: string,
    options: { expectedTargetAuthorityVersion?: number } = {},
  ): void {
    const { priorSessionId } = this.#requireStaleAdoptionContext(target, handle, targetInstance);
    this.adoptStaleIntoBlocked(target, priorSessionId, targetInstance, options);
  }

  verifyStaleAdoptionResumption(target: SessionRef, handle: string, targetInstance: string): void {
    const status = this.getSessionStatus(target.sessionId);
    const recovery = status?.bindings.recoveryHandles as
      | { adoptStale?: Record<string, unknown> }
      | undefined;
    const adoption = recovery?.adoptStale;
    if (
      status?.state !== 'handoff_cleanup' ||
      status.claimEpoch !== target.claimEpoch ||
      status.worker.instanceId !== targetInstance ||
      !adoption ||
      !this.#recoveryHandleMatches(adoption, handle, this.#now())
    ) {
      throw new SessionAuthorityError(
        'HANDOFF_NOT_AUTHORIZED',
        'stale adoption resumption requires the original adoption capability',
      );
    }
  }

  beginOperation(
    session: SessionRef,
    operation: { operationId: string; tool: string; profile: string },
  ): OperationRef {
    return this.#beginOperation(session, operation, false);
  }

  beginHandoffCancellationOperation(
    session: SessionRef,
    operation: { operationId: string; tool: string; profile: string },
  ): OperationRef {
    return this.#beginOperation(session, operation, true);
  }

  #beginOperation(
    session: SessionRef,
    operation: { operationId: string; tool: string; profile: string },
    handoffCancellation: boolean,
  ): OperationRef {
    const now = this.#now();
    return this.#transaction(() => {
      const owner = handoffCancellation
        ? this.#requireHandoffSession(session)
        : this.#requireSession(session);
      if (
        handoffCancellation &&
        (JSON.parse(owner.bindings_json) as Record<string, unknown>).managedMetroHandoffReservation
      ) {
        throw new SessionAuthorityError(
          'HANDOFF_NOT_AUTHORIZED',
          'handoff cancellation is fenced while managed Metro shutdown is reserved',
        );
      }
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
    this.verifyOperation(operation);
    return operation;
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
    this.#pendingPlatformReceipts.delete(operation.operationId);
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
    this.#pendingPlatformReceipts.delete(operation.operationId);
  }

  cancelActiveOperationForSession(session: SessionRef): void {
    const operationIds = this.#transaction(() => {
      this.#requireSession(session);
      const rows = this.#database
        .prepare(
          `SELECT operation_id FROM operations
           WHERE session_id = ? AND claim_epoch = ?`,
        )
        .all(session.sessionId, session.claimEpoch) as Array<{ operation_id?: unknown }>;
      this.#database
        .prepare('DELETE FROM operations WHERE session_id = ? AND claim_epoch = ?')
        .run(session.sessionId, session.claimEpoch);
      return rows.map((row) => String(row.operation_id));
    });
    for (const operationId of operationIds) {
      this.#pendingPlatformReceipts.delete(operationId);
    }
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
      if (existing) {
        const claim = this.#findClaim(`${input.service}-port`, String(existing.port));
        const listenerStatus = claim ? 'absent' : this.#listenerStatus(existing.port);
        if (listenerStatus === 'absent') return existing.port;
        if (listenerStatus === 'unknown') {
          throw new SessionAuthorityError(
            'PORT_LISTENER_PROBE_UNAVAILABLE',
            `listener ownership for ${input.service} port ${existing.port} is unavailable`,
          );
        }
        this.#database
          .prepare('DELETE FROM allocations WHERE service = ? AND worktree_key = ?')
          .run(input.service, input.worktreeKey);
      }

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
        const listenerStatus = this.#listenerStatus(port);
        if (listenerStatus === 'listening') continue;
        if (listenerStatus === 'unknown') {
          throw new SessionAuthorityError(
            'PORT_LISTENER_PROBE_UNAVAILABLE',
            `listener ownership for ${input.service} port ${port} is unavailable`,
          );
        }
        this.#database
          .prepare(
            `INSERT INTO allocations(service, worktree_key, port, generation)
             VALUES (?, ?, ?, 1)`,
          )
          .run(input.service, input.worktreeKey, port);
        return port;
      }
      const orphanRows = this.#database
        .prepare(
          `SELECT allocation.worktree_key, allocation.port
           FROM allocations allocation
           WHERE allocation.service = ?
             AND allocation.port >= ?
             AND allocation.port < ?
             AND NOT EXISTS (
               SELECT 1 FROM sessions session
               WHERE session.worktree_key = allocation.worktree_key
                 AND session.state NOT IN ('released', 'stale')
             )
           ORDER BY allocation.generation ASC, allocation.worktree_key ASC
           `,
        )
        .all(input.service, input.base, input.base + input.span);
      for (const row of orphanRows) {
        if (!Number.isSafeInteger(row.port) || typeof row.worktree_key !== 'string') {
          throw new SessionAuthorityError(
            'AUTHORITY_STORE_INVALID',
            'persisted port allocation is malformed',
          );
        }
        const orphan = { port: row.port as number, worktree_key: row.worktree_key };
        const listenerStatus = this.#listenerStatus(orphan.port);
        if (listenerStatus === 'listening') continue;
        if (listenerStatus === 'unknown') {
          throw new SessionAuthorityError(
            'PORT_LISTENER_PROBE_UNAVAILABLE',
            `listener ownership for ${input.service} port ${orphan.port} is unavailable`,
          );
        }
        this.#database
          .prepare(
            `DELETE FROM allocations
             WHERE service = ? AND worktree_key = ? AND port = ?`,
          )
          .run(input.service, orphan.worktree_key, orphan.port);
        this.#database
          .prepare(
            `INSERT INTO allocations(service, worktree_key, port, generation)
             VALUES (?, ?, ?, 1)`,
          )
          .run(input.service, input.worktreeKey, orphan.port);
        return orphan.port;
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
    if (
      !Number.isSafeInteger(version) ||
      version < 1 ||
      version > AUTHORITY_REGISTRY_SCHEMA_VERSION
    ) {
      throw new SessionAuthorityError(
        'AUTHORITY_STORE_UNAVAILABLE',
        version > 4
          ? `authority registry schema ${version} is newer than supported schema ${AUTHORITY_REGISTRY_SCHEMA_VERSION}`
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
          this.#database.exec(
            "ALTER TABLE handoffs ADD COLUMN source_state TEXT NOT NULL DEFAULT 'active';",
          );
        }
      }
      this.#database.exec(
        `UPDATE authority_meta SET value = '${AUTHORITY_REGISTRY_SCHEMA_VERSION}' WHERE key = 'schema_version';`,
      );
      this.#database.exec('COMMIT');
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
    this.#secureFiles();
  }

  #initializeWithRetry(): void {
    const deadline = Date.now() + 1_000;
    for (;;) {
      try {
        this.#initialize();
        return;
      } catch (error) {
        const code = (error as { code?: string }).code;
        const message = error instanceof Error ? error.message : '';
        if (code !== 'SQLITE_BUSY' && !/database is (?:locked|busy)/i.test(message)) throw error;
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw error;
        Atomics.wait(INITIALIZATION_WAIT, 0, 0, Math.min(25, remaining));
      }
    }
  }

  #probeClaimOwners(
    session: SessionRef,
    resources: readonly ResourceClaim[],
  ): Map<string, { claimEpoch: number; status: OwnerStatus }> {
    const owners = new Map<string, { claimEpoch: number; status: OwnerStatus }>();
    for (const resource of resources) {
      const claim = this.#findConflictingClaim(resource);
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

  #assertClaimsAvailable(
    session: SessionRef,
    resources: readonly ResourceClaim[],
    probes: Map<string, { claimEpoch: number; status: OwnerStatus }> | null,
    now: number,
  ): void {
    for (const resource of resources) {
      const claim = this.#findConflictingClaim(resource);
      if (
        !claim ||
        (claim.session_id === session.sessionId && claim.claim_epoch === session.claimEpoch)
      ) {
        continue;
      }
      if (!probes) throw claimConflict(claim);

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
      throw new SessionAuthorityError(
        'SESSION_AUTHORITY_REQUIRED',
        'a proven-stale owner requires explicit adopt_stale before claims transfer',
        { sessionId: claim.session_id, claimEpoch: claim.claim_epoch },
      );
    }
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

  #requireIntegrationRestored(bindings: Record<string, unknown>): void {
    if (bindings.packageIntegration) {
      throw new SessionAuthorityError(
        'SESSION_AUTHORITY_REQUIRED',
        'package integration must be restored before session release',
      );
    }
  }

  #requireFenceableSession(session: SessionRef): SessionRow {
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
    if (!row || !isFenceableState(row.state) || row.claim_epoch !== session.claimEpoch) {
      throw new SessionAuthorityError(
        'SESSION_OWNER_LOST',
        'session owner no longer matches the fenceable claim epoch',
      );
    }
    return row;
  }

  #requireHandoffSession(session: SessionRef): SessionRow {
    const row = this.#requireFenceableSession(session);
    if (row.state !== 'handoff') {
      throw new SessionAuthorityError(
        'SESSION_OWNER_LOST',
        'session owner no longer matches the handoff claim epoch',
      );
    }
    return row;
  }

  #requireRecoverableSession(session: SessionRef): SessionRow {
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
    if (
      !row ||
      (row.state !== 'blocked' && row.state !== 'handoff_cleanup') ||
      row.claim_epoch !== session.claimEpoch
    ) {
      throw new SessionAuthorityError(
        'SESSION_OWNER_LOST',
        'session is not an unchanged recovery contender',
      );
    }
    return row;
  }

  #requireHandoffCleanupOwner(session: SessionRef, targetInstance: string): SessionRow {
    const row = this.#requireRecoverableSession(session);
    if (row.state !== 'handoff_cleanup' || row.worker_instance !== targetInstance) {
      throw new SessionAuthorityError(
        'HANDOFF_NOT_AUTHORIZED',
        'handoff cleanup is not owned by this recovery worker',
      );
    }
    return row;
  }

  #requireHandoffIntoContext(
    target: SessionRef,
    input: HandoffIntoInput,
    options: { allowExactReservationAfterExpiry: boolean; commitRecipientRotation: boolean },
  ): HandoffIntoContext {
    const { allowExactReservationAfterExpiry, commitRecipientRotation } = options;
    const targetRow = this.#requireRecoverableSession(target);
    if (targetRow.state !== 'blocked') {
      throw new SessionAuthorityError(
        'HANDOFF_NOT_AUTHORIZED',
        'handoff acceptance is not available during cleanup',
      );
    }
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
      .get(input.handoffId) as HandoffIntoContext['handoff'] | undefined;
    if (!handoff) {
      throw new SessionAuthorityError('HANDOFF_NOT_FOUND', 'handoff does not exist');
    }
    const expected = Buffer.from(handoff.token_hash, 'hex');
    const actual = createHash('sha256').update(input.token).digest();
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw new SessionAuthorityError('HANDOFF_TOKEN_INVALID', 'handoff capability is invalid');
    }
    if (handoff.consumed_ms !== null) {
      throw new SessionAuthorityError('HANDOFF_ALREADY_CONSUMED', 'handoff was already accepted');
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
    let bindings = JSON.parse(prior.bindings_json) as Record<string, unknown>;
    let reservation = managedMetroHandoffReservation(bindings);
    let exactReservation =
      reservation?.handoffId === handoff.handoff_id &&
      reservation.sourceClaimEpoch === handoff.claim_epoch &&
      reservation.targetSessionId === target.sessionId &&
      reservation.targetClaimEpoch === target.claimEpoch &&
      reservation.targetInstance === input.targetInstance &&
      reservation.metro?.sourceSessionId === prior.session_id;
    if (handoff.target_instance !== input.targetInstance || (reservation && !exactReservation)) {
      const targetBindings = JSON.parse(targetRow.bindings_json) as Record<string, unknown>;
      const adoptionRequired = targetBindings.adoptionRequired as
        | { sessionId?: unknown; claimEpoch?: unknown }
        | undefined;
      const priorTarget = reservation
        ? asSession(
            this.#database
              .prepare(
                `SELECT session_id, source_key, worktree_key, app_root_key, state,
                        claim_epoch, supervisor_pid, supervisor_birth
                 FROM sessions WHERE session_id = ?`,
              )
              .get(reservation.targetSessionId),
          )
        : null;
      const priorTargetTerminal =
        priorTarget !== null &&
        (priorTarget.state === 'released' || priorTarget.state === 'stale') &&
        priorTarget.claim_epoch === reservation!.targetClaimEpoch + 1;
      let priorTargetDead = false;
      if (
        priorTarget?.state === 'blocked' &&
        priorTarget.claim_epoch === reservation?.targetClaimEpoch
      ) {
        try {
          priorTargetDead =
            this.#ownerStatus({
              sessionId: priorTarget.session_id,
              pid: priorTarget.supervisor_pid,
              token: priorTarget.supervisor_birth,
            }) === 'mismatch';
        } catch {
          priorTargetDead = false;
        }
      }
      if (
        !reservation ||
        reservation.handoffId !== handoff.handoff_id ||
        reservation.sourceClaimEpoch !== handoff.claim_epoch ||
        reservation.metro.sourceSessionId !== prior.session_id ||
        reservation.targetInstance !== handoff.target_instance ||
        adoptionRequired?.sessionId !== prior.session_id ||
        adoptionRequired.claimEpoch !== prior.claim_epoch ||
        !priorTarget ||
        priorTarget.source_key !== targetRow.source_key ||
        priorTarget.worktree_key !== targetRow.worktree_key ||
        priorTarget.app_root_key !== targetRow.app_root_key ||
        (!priorTargetTerminal && !priorTargetDead)
      ) {
        throw new SessionAuthorityError(
          'HANDOFF_NOT_AUTHORIZED',
          'managed Metro cleanup reservation belongs to a different handoff recipient',
        );
      }
      if (handoff.expires_ms < this.#now() && !allowExactReservationAfterExpiry) {
        throw new SessionAuthorityError('HANDOFF_EXPIRED', 'handoff capability expired');
      }
      const rotatedReservation: ManagedMetroHandoffReservation = {
        ...reservation,
        targetSessionId: target.sessionId,
        targetClaimEpoch: target.claimEpoch,
        targetInstance: input.targetInstance,
      };
      if (commitRecipientRotation) {
        const handoffChanged = this.#database
          .prepare(
            `UPDATE handoffs SET target_instance = ?
             WHERE handoff_id = ? AND target_instance = ? AND consumed_ms IS NULL`,
          )
          .run(input.targetInstance, handoff.handoff_id, reservation.targetInstance) as {
          changes: number;
        };
        if (handoffChanged.changes !== 1) {
          throw new SessionAuthorityError(
            'HANDOFF_NOT_AUTHORIZED',
            'managed Metro handoff target changed during recipient rotation',
          );
        }
        bindings = {
          ...bindings,
          managedMetroHandoffReservation: rotatedReservation,
        };
        const donorChanged = this.#database
          .prepare(
            `UPDATE sessions
             SET bindings_json = ?, authority_version = authority_version + 1, updated_ms = ?
             WHERE session_id = ? AND claim_epoch = ? AND state = 'handoff'`,
          )
          .run(JSON.stringify(bindings), this.#now(), prior.session_id, prior.claim_epoch) as {
          changes: number;
        };
        if (donorChanged.changes !== 1) {
          throw new SessionAuthorityError(
            'HANDOFF_NOT_AUTHORIZED',
            'managed Metro donor authority changed during recipient rotation',
          );
        }
        if (priorTarget.state === 'blocked') {
          this.#fenceSession(priorTarget.session_id, this.#now());
        }
      }
      handoff.target_instance = input.targetInstance;
      reservation = rotatedReservation;
      exactReservation = true;
    }
    if (
      handoff.expires_ms < this.#now() &&
      !(allowExactReservationAfterExpiry && exactReservation)
    ) {
      throw new SessionAuthorityError('HANDOFF_EXPIRED', 'handoff capability expired');
    }
    return {
      targetRow,
      handoff,
      prior,
      bindings,
      reservation: exactReservation ? reservation : null,
    };
  }

  #advanceActiveOperationFence(
    session: SessionRef,
    priorAuthorityVersion: number,
    nextAuthorityVersion: number,
    requireActiveFence = false,
  ): void {
    const active = this.#database
      .prepare(
        `SELECT operation_id, authority_version FROM operations
         WHERE session_id = ? AND claim_epoch = ? LIMIT 1`,
      )
      .get(session.sessionId, session.claimEpoch) as
      | { operation_id?: unknown; authority_version?: unknown }
      | undefined;
    const context = this.#operationContext.getStore();
    if (!active) {
      if (
        requireActiveFence &&
        context?.sessionId === session.sessionId &&
        context.claimEpoch === session.claimEpoch
      ) {
        throw new SessionAuthorityError(
          'AUTHORITY_LOST_DURING_OPERATION',
          'active operation fence disappeared before authority commit',
        );
      }
      return;
    }
    if (
      !context ||
      context.operationId !== active.operation_id ||
      context.sessionId !== session.sessionId ||
      context.claimEpoch !== session.claimEpoch ||
      context.authorityVersion !== priorAuthorityVersion ||
      active.authority_version !== priorAuthorityVersion
    ) {
      throw new SessionAuthorityError(
        'AUTHORITY_LOST_DURING_OPERATION',
        'authority mutation is not owned by the active operation fence',
      );
    }
    const changed = this.#database
      .prepare(
        `UPDATE operations SET authority_version = ?, lease_until_ms = ?
         WHERE operation_id = ? AND session_id = ? AND claim_epoch = ?
           AND authority_version = ?`,
      )
      .run(
        nextAuthorityVersion,
        this.#now() + this.#leaseMs,
        context.operationId,
        session.sessionId,
        session.claimEpoch,
        priorAuthorityVersion,
      ) as { changes?: number };
    if (changed.changes === 0) {
      throw new SessionAuthorityError(
        'AUTHORITY_LOST_DURING_OPERATION',
        'operation fence did not advance atomically',
      );
    }
    context.authorityVersion = nextAuthorityVersion;
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

  #findConflictingClaim(resource: ResourceClaim): ClaimRow | null {
    return (
      this.#findClaim(resource.type, resource.key) ??
      (resource.type === 'runner'
        ? this.#findClaim('runner-receipt', resource.key)
        : resource.type === 'device'
          ? this.#findClaim('device-receipt', resource.key)
          : null)
    );
  }

  #platformReceiptFromCurrentAuthority(
    session: SessionRef,
    platform: string,
    receipt: Record<string, unknown>,
  ): {
    session: SessionRef;
    platform: string;
    receipt: Record<string, unknown>;
    probe: PlatformAuthorityProbe;
  } {
    const row = this.#requireSession(session);
    const bindings = JSON.parse(row.bindings_json) as Record<string, unknown>;
    const device = bindings.device as Record<string, unknown> | undefined;
    const install = bindings.install as Record<string, unknown> | undefined;
    const runner = bindings.runner as Record<string, unknown> | undefined;
    const runnerClaim = this.#database
      .prepare(
        `SELECT resource_key FROM claims
         WHERE session_id = ? AND claim_epoch = ? AND resource_type = 'runner'`,
      )
      .get(session.sessionId, session.claimEpoch) as { resource_key?: unknown } | undefined;
    const deviceClaim = this.#database
      .prepare(
        `SELECT resource_key FROM claims
         WHERE session_id = ? AND claim_epoch = ? AND resource_type = 'device'`,
      )
      .get(session.sessionId, session.claimEpoch) as { resource_key?: unknown } | undefined;
    const runnerCapabilityHash =
      typeof runner?.capability === 'string'
        ? createHash('sha256').update(runner.capability).digest('hex')
        : null;
    if (
      device?.platform !== platform ||
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
      typeof install?.installGeneration !== 'string'
    ) {
      throw new SessionAuthorityError(
        'RUNNER_OWNERSHIP_MISMATCH',
        'snapshot receipt does not match exact persistent platform authority',
      );
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

  #invalidatePlatformReceipt(session: SessionRef, platform: string): void {
    const row = this.#database
      .prepare(
        `SELECT receipt_json FROM platform_authority_receipts
         WHERE session_id = ? AND claim_epoch = ? AND platform = ?`,
      )
      .get(session.sessionId, session.claimEpoch, platform) as
      | { receipt_json?: unknown }
      | undefined;
    if (typeof row?.receipt_json === 'string') {
      const persisted = JSON.parse(row.receipt_json) as Record<string, unknown>;
      const receipt =
        persisted.receipt && typeof persisted.receipt === 'object'
          ? (persisted.receipt as Record<string, unknown>)
          : persisted;
      if (typeof receipt.runnerClaim === 'string') {
        this.#database
          .prepare(
            `DELETE FROM claims
             WHERE resource_type = 'runner-receipt' AND resource_key = ?
               AND session_id = ? AND claim_epoch = ?`,
          )
          .run(receipt.runnerClaim, session.sessionId, session.claimEpoch);
      }
      if (typeof receipt.deviceClaim === 'string') {
        this.#database
          .prepare(
            `DELETE FROM claims
             WHERE resource_type = 'device-receipt' AND resource_key = ?
               AND session_id = ? AND claim_epoch = ?`,
          )
          .run(receipt.deviceClaim, session.sessionId, session.claimEpoch);
      }
    }
    this.#database
      .prepare(
        `DELETE FROM platform_authority_receipts
         WHERE session_id = ? AND claim_epoch = ? AND platform = ?`,
      )
      .run(session.sessionId, session.claimEpoch, platform);
  }

  #capabilityMatches(expected: string, actual: string): boolean {
    const expectedDigest = createHash('sha256').update(expected).digest();
    const actualDigest = createHash('sha256').update(actual).digest();
    return timingSafeEqual(expectedDigest, actualDigest);
  }

  #recoveryHandleMatches(handle: Record<string, unknown>, actual: string, now: number): boolean {
    if (
      typeof handle.token === 'string' &&
      typeof handle.expiresMs === 'number' &&
      handle.expiresMs >= now &&
      this.#capabilityMatches(handle.token, actual)
    ) {
      return true;
    }
    const previous = handle.previous as Record<string, unknown> | null | undefined;
    return Boolean(
      previous &&
      typeof previous.token === 'string' &&
      typeof previous.expiresMs === 'number' &&
      previous.expiresMs >= now &&
      this.#capabilityMatches(previous.token, actual),
    );
  }

  #mergeStaleDeviceCleanup(
    cleanup: Record<string, unknown>,
    staleDeviceCleanup: Record<string, unknown> | null,
  ): Record<string, unknown> {
    if (!staleDeviceCleanup) return cleanup;
    const merged = { ...cleanup };
    for (const resource of ['runner', 'recorder'] as const) {
      const current = cleanup[resource];
      const stale = staleDeviceCleanup[resource];
      if (!stale || typeof stale !== 'object') continue;
      if (current && typeof current === 'object') {
        const currentKey = (current as Record<string, unknown>).claimKey;
        const staleKey = (stale as Record<string, unknown>).claimKey;
        if (currentKey !== staleKey) {
          throw new SessionAuthorityError(
            'HANDOFF_NOT_AUTHORIZED',
            `stale ${resource} cleanup conflicts with the existing handoff plan`,
          );
        }
      } else {
        merged[resource] = stale;
      }
    }
    return merged;
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

  #transaction<T>(
    operation: () => T,
    assertBeforeCommit?: () => void,
    onCommitted?: (result: T) => void,
  ): T {
    this.#database.exec('BEGIN IMMEDIATE');
    const context = this.#operationContext.getStore();
    const priorContextAuthorityVersion = context?.authorityVersion;
    let committed = false;
    try {
      const result = operation();
      assertBeforeCommit?.();
      this.#database.exec('COMMIT');
      committed = true;
      try {
        onCommitted?.(result);
      } finally {
        this.#secureFiles();
      }
      return result;
    } catch (error) {
      if (!committed) {
        try {
          this.#database.exec('ROLLBACK');
        } finally {
          if (context && priorContextAuthorityVersion !== undefined) {
            context.authorityVersion = priorContextAuthorityVersion;
          }
          this.#secureFiles();
        }
      }
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
