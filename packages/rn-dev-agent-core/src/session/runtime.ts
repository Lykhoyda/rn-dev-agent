import type { ProcessBirth } from './process-birth.js';
import { readProcessBirth } from './process-birth.js';
import { inspectSessionOwner } from './process-owner.js';
import {
  openSessionRegistry,
  SessionAuthorityError,
  type OwnerStatus,
  type SessionRef,
  type SessionRegistry,
  type SessionStatus,
} from './registry.js';

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

  constructor(
    registry: SessionRegistry | null,
    session: SessionRef | null,
    unavailable: { code: string; reason: string } | null,
  ) {
    this.#registry = registry;
    this.#session = session;
    this.#unavailable = unavailable;
    this.available = registry !== null && session !== null;
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
    registry.bindWorker(session, {
      instanceId: workerInstance,
      pid: birth.pid,
      token: birth.token,
    });
    return new WorkerAuthorityRuntime(registry, session, null);
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
