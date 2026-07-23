import { randomBytes, randomUUID } from 'node:crypto';
import type { ProcessBirth } from './process-birth.js';
import type { OwnerStatus, SessionRef, SessionRegistry } from './registry.js';
import { openSessionRegistry } from './registry.js';
import type { SourceIdentity } from './source-identity.js';
import { ensureSharedKnowledgeRoot } from './shared-knowledge-root.js';
import { stopManagedMetro, type ManagedMetroBinding } from './managed-metro.js';
import {
  createAuthorityStateLayout,
  sessionRuntimeDirectory,
  writeSessionPublicReceipt,
  writeSessionSecret,
  type AuthorityStateLayout,
} from './state-root.js';

export interface SupervisorAuthority {
  layout: AuthorityStateLayout;
  registry: SessionRegistry;
  session: SessionRef;
  source: SourceIdentity;
  metroPort: number;
  observePort: number;
  workerEnvironment(workerInstance: string): NodeJS.ProcessEnv;
  close(): void;
}

export function createSupervisorAuthority(input: {
  stateDir?: string;
  source: SourceIdentity;
  supervisorBirth: ProcessBirth | null;
  uid: string;
  sessionId?: string;
  heartbeatMs?: number;
  startHeartbeat?: boolean;
  ownerStatus: (owner: { sessionId: string; pid: number; token: string }) => OwnerStatus;
}): SupervisorAuthority {
  if (!input.supervisorBirth) {
    throw new Error(
      'PROCESS_BIRTH_UNAVAILABLE: supervisor process birth could not be proven conservatively',
    );
  }
  const layout = createAuthorityStateLayout(input.stateDir);
  const sharedKnowledge = ensureSharedKnowledgeRoot(input.source.appRoot);
  const registry = openSessionRegistry(layout.registry, {
    ownerStatus: input.ownerStatus,
    leaseMs: 30_000,
  });
  const sessionId = input.sessionId ?? randomUUID();
  const signerCapability = randomBytes(32).toString('base64url');
  const observeCapability = randomBytes(32).toString('base64url');
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
  const metroPort = registry.allocatePort({
    service: 'metro',
    worktreeKey: input.source.worktreeKey,
    uid: input.uid,
    base: 8081,
    span: 200,
  });
  const observePort = registry.allocatePort({
    service: 'observe',
    worktreeKey: input.source.worktreeKey,
    uid: input.uid,
    base: 7333,
    span: 200,
  });
  let adoptionRequired: { sessionId: string; claimEpoch: number } | undefined;
  try {
    registry.claimResources(
      session,
      [
        { type: 'source', key: input.source.worktreeKey },
        { type: 'metro-port', key: String(metroPort) },
        { type: 'observe-port', key: String(observePort) },
      ],
      { allowReclaim: false },
    );
  } catch (error) {
    if (error instanceof Error && 'holder' in error) {
      adoptionRequired = (error as { holder?: { sessionId: string; claimEpoch: number } }).holder;
    } else {
      throw error;
    }
  }
  registry.updateBindings(session, {
    state: adoptionRequired ? 'creating' : 'source_bound',
    bindings: {
      metroPort,
      observePort,
      ...(adoptionRequired
        ? {
            adoptionRequired: {
              sessionId: adoptionRequired.sessionId.slice(0, 12),
              claimEpoch: adoptionRequired.claimEpoch,
            },
          }
        : {}),
    },
  });
  const secretPath = writeSessionSecret(layout, sessionId, {
    signerCapability,
    observeCapability,
  });
  writeSessionPublicReceipt(layout, sessionId, {
    sessionId,
    claimEpoch: session.claimEpoch,
    sourceKind: input.source.kind,
    sourceKey: input.source.sourceKey.slice(0, 12),
    worktreeKey: input.source.worktreeKey.slice(0, 12),
    metroPort,
    observePort,
    sharedKnowledgeMigrated: sharedKnowledge.migrated,
  });

  let heartbeat: NodeJS.Timeout | null = null;
  if (input.startHeartbeat !== false) {
    heartbeat = setInterval(() => {
      void registry.renewSessionWithRetry(session).catch(() => {
        if (heartbeat) clearInterval(heartbeat);
        heartbeat = null;
      });
    }, input.heartbeatMs ?? 5_000);
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
    close: () => {
      if (heartbeat) clearInterval(heartbeat);
      try {
        const status = registry.getSessionStatus(session.sessionId);
        if (status) {
          stopManagedMetro(status.bindings.metro as Partial<ManagedMetroBinding> | undefined, {
            sessionId,
            signerCapability,
          });
        }
        registry.releaseSession(session);
      } finally {
        registry.close();
      }
    },
  };
}
