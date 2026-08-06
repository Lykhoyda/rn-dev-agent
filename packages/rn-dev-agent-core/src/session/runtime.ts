import type { ProcessBirth } from './process-birth.js';
import { readProcessBirth } from './process-birth.js';
import { inspectSessionOwner } from './process-owner.js';
import {
  openSessionRegistry,
  SessionAuthorityError,
  type OwnerStatus,
  type RecoveryRequirementInspection,
  type SessionRef,
  type SessionRegistry,
  type SessionStatus,
} from './registry.js';
import { readJsonStateFile } from '../util/secure-state-file.js';

export const BLOCKED_CONTENDER_REFUSAL =
  'this session does not own this worktree; rn_session({ action: "status" }) is the only available action';

interface WorkerAuthorityDependencies {
  readBirth?: (pid: number) => ProcessBirth | null;
  ownerStatus?: (owner: { sessionId: string; pid: number; token: string }) => OwnerStatus;
}

export type WorkerAuthorityStatus =
  | {
      available: false;
      code: string;
      reason: string;
    }
  | (SessionStatus & { available: true });

export class WorkerAuthorityRuntime {
  readonly available: boolean;
  readonly #registry: SessionRegistry | null;
  readonly #session: SessionRef | null;
  readonly #unavailable: { code: string; reason: string } | null;
  readonly #recoveryOnly: boolean;
  readonly #recoveryCapability: string | null;

  constructor(
    registry: SessionRegistry | null,
    session: SessionRef | null,
    unavailable: { code: string; reason: string } | null,
    recoveryOnly = false,
    recoveryCapability: string | null = null,
  ) {
    this.#registry = registry;
    this.#session = session;
    this.#unavailable = unavailable;
    this.available = registry !== null && session !== null;
    this.#recoveryOnly = recoveryOnly;
    this.#recoveryCapability = recoveryCapability;
  }

  requireAvailable(): { registry: SessionRegistry; session: SessionRef } {
    if (!this.#registry || !this.#session) {
      throw new SessionAuthorityError(
        this.#unavailable?.code ?? 'SESSION_NOT_INITIALIZED',
        this.#unavailable?.reason ?? 'authority session is unavailable',
      );
    }
    return { registry: this.#registry, session: this.#session };
  }

  requireOperational(): { registry: SessionRegistry; session: SessionRef } {
    const available = this.requireAvailable();
    const status = this.status();
    if (status.available && (status.state === 'blocked' || status.state === 'handoff_cleanup')) {
      throw this.blockedContenderError();
    }
    return available;
  }

  /** Gated refusals carry the current session's measured recovery next action. */
  blockedContenderError(): SessionAuthorityError {
    const nextAction = this.inspectRecoveryRequirement()?.nextAction;
    return new SessionAuthorityError(
      'SESSION_AUTHORITY_REQUIRED',
      BLOCKED_CONTENDER_REFUSAL,
      undefined,
      nextAction ? { nextAction } : undefined,
    );
  }

  requireRecovery(): { registry: SessionRegistry; session: SessionRef } {
    const available = this.requireAvailable();
    const status = this.status();
    if (
      !this.#recoveryOnly ||
      !status.available ||
      (status.state !== 'blocked' && status.state !== 'handoff_cleanup')
    ) {
      throw new SessionAuthorityError(
        'HANDOFF_NOT_AUTHORIZED',
        'session is not a capability-bound recovery contender',
      );
    }
    return available;
  }

  /**
   * GH #672: rotate an expired recovery handle before it is advertised. Best-effort by
   * design — a refresh failure must degrade `status` to an honest expired handle, never
   * turn a diagnostic call into an authority error.
   */
  refreshRecoveryHandles(): boolean {
    if (!this.#registry || !this.#session || !this.#recoveryOnly || !this.#recoveryCapability) {
      return false;
    }
    try {
      const status = this.#registry.getSessionStatus(this.#session.sessionId);
      const instanceId = status?.worker.instanceId;
      if (
        !status ||
        !instanceId ||
        (status.state !== 'blocked' && status.state !== 'handoff_cleanup')
      ) {
        return false;
      }
      return this.#registry.refreshRecoveryHandles(
        this.#session,
        { instanceId },
        this.#recoveryCapability,
      );
    } catch {
      return false;
    }
  }

  inspectRecoveryRequirement(): RecoveryRequirementInspection | undefined {
    if (!this.#registry || !this.#session) return undefined;
    try {
      return this.#registry.inspectRecoveryRequirement(this.#session.sessionId);
    } catch {
      return undefined;
    }
  }

  status(): WorkerAuthorityStatus {
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

  close(): void {
    this.#registry?.close();
  }
}

function unavailable(reason: string, fallbackCode: string): WorkerAuthorityRuntime {
  const matched = /^([A-Z][A-Z0-9_]+):/.exec(reason);
  return new WorkerAuthorityRuntime(null, null, {
    code: matched?.[1] ?? fallbackCode,
    reason,
  });
}

export function createWorkerAuthorityRuntime(
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: WorkerAuthorityDependencies = {},
): WorkerAuthorityRuntime {
  if (environment.RN_DEV_AGENT_AUTHORITY_ERROR) {
    return unavailable(environment.RN_DEV_AGENT_AUTHORITY_ERROR, 'AUTHORITY_STORE_UNAVAILABLE');
  }
  const sessionId = environment.RN_DEV_AGENT_SESSION_ID;
  const claimEpoch = Number(environment.RN_DEV_AGENT_CLAIM_EPOCH);
  const registryPath = environment.RN_DEV_AGENT_REGISTRY_PATH;
  const workerInstance = environment.RN_DEV_AGENT_WORKER_INSTANCE;
  if (
    !sessionId ||
    !Number.isSafeInteger(claimEpoch) ||
    claimEpoch < 1 ||
    !registryPath ||
    !workerInstance
  ) {
    return unavailable(
      'SESSION_NOT_INITIALIZED: supervisor did not provide a complete authority context',
      'SESSION_NOT_INITIALIZED',
    );
  }
  const birth = (dependencies.readBirth ?? readProcessBirth)(process.pid);
  if (!birth) {
    return unavailable(
      'PROCESS_BIRTH_UNAVAILABLE: worker process birth could not be proven conservatively',
      'PROCESS_BIRTH_UNAVAILABLE',
    );
  }

  try {
    const registry = openSessionRegistry(registryPath, {
      ownerStatus: dependencies.ownerStatus ?? inspectSessionOwner,
    });
    const session = { sessionId, claimEpoch };
    const status = registry.getSessionStatus(sessionId);
    const recoveryOnly = status?.state === 'blocked' || status?.state === 'handoff_cleanup';
    let recoveryCapability: string | null = null;
    if (recoveryOnly) {
      const secretPath = environment.RN_DEV_AGENT_SESSION_SECRET_PATH;
      recoveryCapability = secretPath
        ? (readJsonStateFile<{ recoveryCapability?: string }>(secretPath)?.recoveryCapability ??
          null)
        : null;
      if (!recoveryCapability) {
        throw new SessionAuthorityError(
          'HANDOFF_NOT_AUTHORIZED',
          'blocked recovery capability is unavailable',
        );
      }
      registry.bindRecoveryWorker(
        session,
        { instanceId: workerInstance, pid: birth.pid, token: birth.token },
        recoveryCapability,
      );
    } else {
      registry.bindWorker(session, {
        instanceId: workerInstance,
        pid: birth.pid,
        token: birth.token,
      });
    }
    return new WorkerAuthorityRuntime(registry, session, null, recoveryOnly, recoveryCapability);
  } catch (error) {
    return unavailable(
      error instanceof Error
        ? error.message
        : 'AUTHORITY_STORE_UNAVAILABLE: worker authority could not be opened',
      'AUTHORITY_STORE_UNAVAILABLE',
    );
  }
}

let sharedRuntime: WorkerAuthorityRuntime | null = null;

export function getWorkerAuthorityRuntime(): WorkerAuthorityRuntime {
  sharedRuntime ??= createWorkerAuthorityRuntime();
  return sharedRuntime;
}
