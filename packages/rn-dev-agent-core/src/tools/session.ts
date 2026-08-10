import { authorityErrorMeta, SessionAuthorityError } from '../session/registry.js';
import type { WorkerAuthorityRuntime, WorkerAuthorityStatus } from '../session/runtime.js';
import { failResult, okResult, type ToolResult } from '../utils.js';
import type { ToolErrorCode } from '../types.js';
import { verifyBuildReceipt, type BuildReceipt } from '../session/build-receipt.js';
import {
  captureInstallGeneration,
  type InstalledArtifactIdentity,
} from '../session/install-authority.js';
import { captureMetroBinding, type MetroBinding } from '../session/metro-binding.js';
import type {
  BundleAuthorityBinding,
  BundleAuthorityPromotion,
} from '../session/dev-client-authority.js';
import type { SessionRef, SessionRegistry, SessionStatus } from '../session/registry.js';
import {
  applyPackageIntegration,
  inspectPackageIntegrationFileState,
  previewMetroIntegration,
  previewPackageIntegration,
  readPackageIntegrationInputs,
  restorePackageIntegrationFiles,
  serializePackageIntegrationManifest,
  type PackageIntegrationFileState,
  type PackageIntegrationManifest,
} from '../session/package-integration.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { inspectSessionOwner } from '../session/process-owner.js';
import { inspectInstallIdentity } from '../session/install-identity-inspection.js';
import { projectPublicAuthorityStatus } from '../session/public-status.js';
import { probeProcessBirth, type ProcessBirthProbe } from '../session/process-birth.js';
import {
  inspectManagedMetroCleanupEvidence,
  inspectManagedMetroLifecycle,
  probeManagedMetroListener,
  stopManagedMetro,
  stopManagedMetroWithEvidence,
  type ManagedMetroBinding,
  type ManagedMetroCleanupEvidence,
  type ManagedMetroCleanupResult,
  type ManagedMetroLifecycleInspection,
  type ManagedMetroListenerProbe,
} from '../session/managed-metro.js';
import { arbiter } from '../lifecycle/device-arbiter.js';
import {
  stopBoundObserve,
  stopBoundRecorder,
  stopBoundRunner,
} from '../session/process-cleanup.js';
import { deviceExistsOnHost } from '../session/device-existence.js';
import {
  ensureAndroidMetroReverse,
  removeAndroidMetroReverse,
  type AndroidMetroReverseBinding,
  type AndroidMetroReverseResult,
} from '../session/android-metro-reverse.js';

type SessionToolAction =
  | 'status'
  | 'bind_device'
  | 'bind_metro'
  | 'pin_dev_client'
  | 'prepare_handoff'
  | 'cancel_handoff'
  | 'accept_handoff'
  | 'adopt_stale'
  | 'release_stale_device'
  | 'recover_arbiter'
  | 'preview_integration'
  | 'apply_integration'
  | 'restore_integration'
  | 'stop_metro'
  | 'release';

interface SessionToolFields {
  appId?: string;
  devClientUrl?: string;
  buildReceipt?: Record<string, unknown>;
  metroPort?: number;
  metroPid?: number;
  metroInstanceId?: string;
  buildGeneration?: number;
  mode?: 'managed' | 'external';
  targetHandle?: string;
  ttlMs?: number;
  handoffId?: string;
  token?: string;
  adoptionHandle?: string;
  confirmed?: boolean;
  force?: boolean;
}

type StaleDeviceReleaseInput = SessionToolFields &
  (
    | {
        action: 'release_stale_device';
        platform: 'ios' | 'android';
        deviceId: string;
        releaseHandle?: string;
      }
    | {
        action: 'release_stale_device';
        platform?: never;
        deviceId?: never;
        releaseHandle?: never;
      }
  );

type OtherSessionToolInput = SessionToolFields & {
  action: Exclude<SessionToolAction, 'release_stale_device'>;
  platform?: 'ios' | 'android';
  deviceId?: string;
  releaseHandle?: never;
};

export type SessionToolInput = StaleDeviceReleaseInput | OtherSessionToolInput;

export interface ManagedMetroStatusDependencies {
  getSignerCapability?: (sessionId?: string) => string | null;
  inspectManagedMetroLifecycle?: typeof inspectManagedMetroLifecycle;
  inspectInstallIdentity?: typeof inspectInstallIdentity;
  now?: () => number;
  onBundleInvalidated?: () => void;
}

interface SessionHandlerDependencies extends ManagedMetroStatusDependencies {
  captureInstallGeneration?: (
    target: Pick<InstalledArtifactIdentity, 'platform' | 'deviceId' | 'appId'>,
  ) => string;
  captureMetro?: (input: {
    port: number;
    pid: number;
    instanceId: string;
    sourceRoot: string;
    buildGeneration: number;
  }) => Promise<MetroBinding>;
  pinDevClient?: (
    status: SessionStatus,
    options: { force: boolean },
    commitBundle: (bundle: BundleAuthorityBinding, promotion: BundleAuthorityPromotion) => void,
  ) => Promise<BundleAuthorityBinding>;
  stopHandoffObserve?: (binding: Record<string, unknown>) => Promise<void>;
  stopHandoffRunner?: (binding: Record<string, unknown>) => Promise<void>;
  stopHandoffRecorder?: (binding: Record<string, unknown>) => Promise<void>;
  probeProcessBirth?: (pid: number) => ProcessBirthProbe;
  probeListener?: (port: number) => ManagedMetroListenerProbe;
  signalProcess?: (pid: number, signal: NodeJS.Signals) => void;
  stopManagedMetro?: typeof stopManagedMetro;
  stopManagedMetroWithEvidence?: typeof stopManagedMetroWithEvidence;
  evidenceSocketExists?: (path: string) => boolean;
  removeEvidenceSocket?: (path: string) => void;
  resetArbiter?: (reason: string) => {
    clearedOps: number;
    hadFlow: boolean;
    reason: string;
  };
  cleanupTimeoutMs?: number;
  deviceExists?: (platform: 'ios' | 'android', deviceId: string) => boolean;
  requestWorkerRecycle?: () => boolean;
  ensureAndroidMetroReverse?: (
    input: Parameters<typeof ensureAndroidMetroReverse>[0],
  ) => AndroidMetroReverseResult;
  removeAndroidMetroReverse?: (binding: AndroidMetroReverseBinding) => void;
}

type SessionMetroBinding =
  | Partial<ManagedMetroBinding>
  | (Partial<MetroBinding> & { mode: 'external' });

function sameAndroidMetroReverse(
  current: unknown,
  next: AndroidMetroReverseBinding | null,
): boolean {
  if (!current || !next) return current === next;
  const binding = current as Partial<AndroidMetroReverseBinding>;
  return (
    binding.platform === next.platform &&
    binding.deviceId === next.deviceId &&
    binding.metroPort === next.metroPort &&
    binding.local === next.local &&
    binding.remote === next.remote
  );
}

function sameMetroAuthority(
  current: Record<string, unknown> | undefined,
  next: MetroBinding & { mode: 'managed' | 'external' },
): boolean {
  return (
    current?.port === next.port &&
    current.pid === next.pid &&
    current.birth === next.birth &&
    current.instanceId === next.instanceId &&
    current.servingRoot === next.servingRoot &&
    current.buildGeneration === next.buildGeneration &&
    current.mode === next.mode
  );
}

interface IntegrationBindingShape {
  version?: unknown;
  installedBySessionId?: unknown;
  manifestSha256?: unknown;
  manifestSource?: unknown;
  installation?: { phase?: unknown; manifestSource?: unknown };
  restoration?: { phase?: unknown; manifestSource?: unknown };
}

function verifiedManifestSource(candidate: unknown, manifestSha256: unknown): string | undefined {
  if (typeof candidate !== 'string' || typeof manifestSha256 !== 'string') return undefined;
  return createHash('sha256').update(candidate).digest('hex') === manifestSha256
    ? candidate
    : undefined;
}

function durableBindingManifestSource(
  binding: IntegrationBindingShape | undefined,
): string | undefined {
  return verifiedManifestSource(binding?.manifestSource, binding?.manifestSha256);
}

function durableRestorationMaterial(
  binding: IntegrationBindingShape | null | undefined,
): string | undefined {
  const restoration =
    binding?.restoration?.phase === 'started' ? binding.restoration.manifestSource : undefined;
  const installation =
    binding?.installation?.phase === 'started' ? binding.installation.manifestSource : undefined;
  return (
    verifiedManifestSource(restoration, binding?.manifestSha256) ??
    verifiedManifestSource(installation, binding?.manifestSha256) ??
    durableBindingManifestSource(binding ?? undefined)
  );
}

const MANIFEST_RECOVERY_GUIDANCE =
  'Restore the exact integration manifest at .rn-agent/integration/rn-session-integration.json from your own version control history or backups so it matches the manifest SHA-256 recorded on the binding';

const TRANSFER_RECOVERY_GUIDANCE =
  'Ownership transfer requires SHA-256-verified restoration material already durable inside the registry binding, and on-disk manifest bytes never authorize a transfer; if the owning session is still alive, restore the exact integration manifest at .rn-agent/integration/rn-session-integration.json from your own version control history or backups and let that owner run restore_integration with confirmed=true, otherwise recover from a trusted session-state-plus-manifest backup while the refusal fence remains.';

const MISSING_DIGEST_GUIDANCE =
  'No trusted manifest SHA-256 digest is recorded on this binding, so no manifest bytes can be verified against it; operator recovery from a trusted session-state-plus-manifest backup is required while the refusal fence remains.';

function hasTrustedManifestDigest(binding: IntegrationBindingShape | null | undefined): boolean {
  return (
    typeof binding?.manifestSha256 === 'string' && /^[0-9a-f]{64}$/.test(binding.manifestSha256)
  );
}

function manifestRecoveryNextAction(
  binding: IntegrationBindingShape | null | undefined,
  retry: string,
): string {
  return hasTrustedManifestDigest(binding)
    ? `${MANIFEST_RECOVERY_GUIDANCE}, then ${retry}.`
    : MISSING_DIGEST_GUIDANCE;
}

function manifestTransferNextAction(binding: IntegrationBindingShape | null | undefined): string {
  return hasTrustedManifestDigest(binding) ? TRANSFER_RECOVERY_GUIDANCE : MISSING_DIGEST_GUIDANCE;
}

function describeIntegrationFileDiagnostics(appRoot: string): string {
  let state: PackageIntegrationFileState;
  if (!appRoot) {
    state = { verdict: 'partial', markers: ['app-root-unavailable'] };
  } else {
    try {
      state = inspectPackageIntegrationFileState(appRoot);
    } catch {
      state = { verdict: 'partial', markers: ['integration-files-uninspectable'] };
    }
  }
  return `${state.verdict}: ${state.markers.join(', ') || 'no-integration-markers'}`;
}

function assertPackageIntegrationInactive(
  bindings: Record<string, unknown>,
  action: 'apply_integration' | 'restore_integration',
): void {
  const activeBindings = [
    'metro',
    'metroCleanup',
    'runner',
    'observe',
    'recorder',
    'proof',
    'pendingBuild',
    'handoffCleanup',
  ].filter((binding) => bindings[binding] != null);
  if (activeBindings.length > 0) {
    const guidance =
      action === 'apply_integration' &&
      activeBindings.length === 1 &&
      activeBindings[0] === 'observe'
        ? '; run observe action "stop" for this session, then retry apply_integration'
        : '';
    throw new SessionAuthorityError(
      'SESSION_AUTHORITY_REQUIRED',
      `${action} requires releasing active ${activeBindings.join(', ')} authority${guidance}`,
    );
  }
}

async function stopHandoffObserve(
  binding: Record<string, unknown>,
  listenerProbe?: Parameters<typeof stopBoundObserve>[1],
  processProbe?: Parameters<typeof stopBoundObserve>[2],
  timeoutMs = 2_000,
): Promise<void> {
  const stopRequestedAt = Number(binding.stopRequestedAt);
  if (!Number.isFinite(stopRequestedAt)) {
    throw new SessionAuthorityError(
      'OBSERVE_AUTHORITY_MISMATCH',
      'source Observe cleanup authority is incomplete',
    );
  }
  await stopBoundObserve(binding, listenerProbe, processProbe, timeoutMs);
}

async function stopHandoffRunner(
  binding: Record<string, unknown>,
  processProbe: (pid: number) => ProcessBirthProbe = probeProcessBirth,
  signalProcess: (pid: number, signal: NodeJS.Signals) => void = process.kill,
  timeoutMs = 2_000,
): Promise<void> {
  const claimKey = String(binding.claimKey ?? '');
  const stopRequestedAt = Number(binding.stopRequestedAt);
  if (!claimKey || !Number.isFinite(stopRequestedAt)) {
    throw new SessionAuthorityError(
      'RUNNER_ADOPTION_REQUIRED',
      'source runner cleanup identity is incomplete',
    );
  }
  await stopBoundRunner(binding, processProbe, signalProcess, timeoutMs);
}

function authorityFailure(error: unknown): ToolResult {
  if (error instanceof SessionAuthorityError) {
    return failResult(error.message, error.code as ToolErrorCode, authorityErrorMeta(error));
  }
  const message = error instanceof Error ? error.message : String(error);
  const code = /^([A-Z][A-Z0-9_]+):/.exec(message)?.[1] ?? 'SESSION_AUTHORITY_REQUIRED';
  return failResult(message, code as ToolErrorCode);
}

function required(value: string | number | undefined, name: string): string | number {
  if (value === undefined || value === '') {
    throw new SessionAuthorityError(
      'SESSION_AUTHORITY_REQUIRED',
      `${name} is required for this session transition`,
    );
  }
  return value;
}

function describeMetroCleanupEvidence(evidence: ManagedMetroCleanupEvidence): string {
  const port =
    evidence.port.status === 'listening' ? `listening:${evidence.port.pid}` : evidence.port.status;
  return `launcher=${evidence.launcher}, listener=${evidence.listener}, port=${port}, evidenceSocket=${evidence.evidenceSocket}`;
}

export function reconcileManagedMetroStatus(
  runtime: WorkerAuthorityRuntime,
  dependencies: ManagedMetroStatusDependencies = {},
): WorkerAuthorityStatus {
  const authority = runtime.status();
  const metro = authority.available
    ? (authority.bindings.metro as Record<string, unknown> | null | undefined)
    : null;
  if (!authority.available || metro?.mode !== 'managed') return authority;
  const signerCapability = dependencies.getSignerCapability?.(authority.sessionId);
  const inspection: ManagedMetroLifecycleInspection = signerCapability
    ? (dependencies.inspectManagedMetroLifecycle ?? inspectManagedMetroLifecycle)(metro, {
        sessionId: authority.sessionId,
        signerCapability,
      })
    : {
        status: 'lost',
        code: 'METRO_MANAGEMENT_PROOF_INVALID',
        reason: 'managed Metro session signer is unavailable',
      };
  if (inspection.status === 'live') return authority;
  const { registry, session } = runtime.requireAvailable();
  const priorTargetId = (authority.bindings.bundle as { targetId?: unknown } | null | undefined)
    ?.targetId;
  const metroPort = Number(authority.bindings.metroPort);
  const metroTerminal = {
    code: inspection.code,
    reason: inspection.reason,
    phase: authority.bindings.bundle ? 'after-bind' : 'before-bind',
    observedAt: (dependencies.now ?? Date.now)(),
    instanceId: metro.instanceId,
  };
  registry.updateBindings(session, {
    expectedAuthorityVersion: authority.authorityVersion,
    state: authority.bindings.install
      ? 'device_bound'
      : authority.bindings.device
        ? 'device_claimed'
        : 'source_bound',
    bindings: {
      metro: null,
      metroCleanup: metro,
      metroTerminal,
      bundle: null,
    },
    releaseResources:
      typeof priorTargetId === 'string' && Number.isSafeInteger(metroPort)
        ? [{ type: 'target', key: `${metroPort}:${priorTargetId}` }]
        : [],
  });
  dependencies.onBundleInvalidated?.();
  return runtime.status();
}

async function completeStaleDeviceCleanupPlan(
  registry: SessionRegistry,
  session: SessionRef,
  workerInstance: string,
  plan: {
    androidMetroReverse?: Record<string, unknown> | null;
    runner: Record<string, unknown> | null;
    recorder: Record<string, unknown> | null;
  },
  dependencies: SessionHandlerDependencies,
): Promise<string[]> {
  const completed: string[] = [];
  if (plan.androidMetroReverse && typeof plan.androidMetroReverse.completedAt !== 'number') {
    if (!dependencies.removeAndroidMetroReverse) {
      throw new SessionAuthorityError(
        'PHYSICAL_ANDROID_METRO_CLEANUP_UNPROVEN',
        'physical Android Metro cleanup integration is unavailable',
      );
    }
    dependencies.removeAndroidMetroReverse(
      plan.androidMetroReverse as unknown as AndroidMetroReverseBinding,
    );
    registry.completeStaleResourceRelease(session, workerInstance, 'androidMetroReverse');
    completed.push('androidMetroReverse');
  }
  if (plan.recorder && typeof plan.recorder.completedAt !== 'number') {
    await (dependencies.stopHandoffRecorder ?? stopBoundRecorder)(plan.recorder);
    registry.completeStaleResourceRelease(session, workerInstance, 'recorder');
    completed.push('recorder');
  }
  if (plan.runner && typeof plan.runner.completedAt !== 'number') {
    if (dependencies.stopHandoffRunner) {
      await dependencies.stopHandoffRunner(plan.runner);
    } else {
      await stopHandoffRunner(
        plan.runner,
        dependencies.probeProcessBirth,
        dependencies.signalProcess,
        dependencies.cleanupTimeoutMs,
      );
    }
    registry.completeStaleResourceRelease(session, workerInstance, 'runner');
    completed.push('runner');
  }
  return completed;
}

/**
 * GH #672 / ADR L5 (captain-approved D3): a proven-dead device owner is released
 * inline by `bind_device` under `confirmed: true` — no capability token is minted,
 * death is re-proven from durable state at execution, and only the exact device
 * family transfers through the same journaled cleanup engine `release_stale_device`
 * uses. Without confirmation, the refusal names the confirmed retry and nothing
 * mutates.
 */
async function withInlineStaleDeviceCleanup<T>(
  registry: SessionRegistry,
  session: SessionRef,
  dependencies: SessionHandlerDependencies,
  input: { platform: 'ios' | 'android'; deviceId: string; appId: string; confirmed?: boolean },
  requireWorkerInstance: () => string,
  revalidate: () => void,
  operation: () => T,
): Promise<T> {
  const target = { platform: input.platform, deviceId: input.deviceId };
  try {
    return operation();
  } catch (error) {
    if (
      !(error instanceof SessionAuthorityError) ||
      error.code !== 'SESSION_AUTHORITY_REQUIRED' ||
      !error.message.includes('proven-stale device owner')
    ) {
      throw error;
    }
    if (input.confirmed !== true) {
      let inspection;
      try {
        inspection = registry.inspectStaleDeviceRelease(session, target);
      } catch (inspectError) {
        throw inspectError instanceof SessionAuthorityError ? inspectError : error;
      }
      throw new SessionAuthorityError(
        'STALE_DEVICE_RELEASE_REQUIRED',
        `exact ${target.platform} device ${target.deviceId} is claimed by a proven-dead owner; ` +
          'confirm the exact device, runner, and recorder cleanup before rebinding',
        error.holder,
        {
          axis: 'D',
          nextAction:
            `rn_session({ action: "bind_device", platform: "${target.platform}", ` +
            `deviceId: "${target.deviceId}", appId: "${input.appId}", confirmed: true }). ` +
            `This releases only the exact device cleanup obligations (${
              inspection.obligations.length ? inspection.obligations.join(', ') : 'none'
            }) after re-proving the owner's death, and never the dead owner source, ` +
            'package-integration, or Metro authority. release_stale_device with ' +
            'confirmed: true remains a compatible alias.',
        },
      );
    }
    const workerInstance = requireWorkerInstance();
    const plan = registry.beginConfirmedStaleDeviceRelease(session, workerInstance, target);
    await completeStaleDeviceCleanupPlan(registry, session, workerInstance, plan, dependencies);
    registry.finishStaleResourceRelease(session, workerInstance);
    revalidate();
    return operation();
  }
}

function ensurePhysicalAndroidMetroReachability(
  registry: SessionRegistry,
  session: SessionRef,
  status: SessionStatus,
  dependencies: SessionHandlerDependencies,
): SessionStatus {
  const device = status.bindings.device as
    | { platform?: unknown; deviceId?: unknown }
    | null
    | undefined;
  if (device?.platform !== 'android' || typeof device.deviceId !== 'string') return status;
  const metroPort = Number(status.bindings.metroPort);
  const existing = status.bindings.androidMetroReverse as
    | AndroidMetroReverseBinding
    | null
    | undefined;
  if (!dependencies.ensureAndroidMetroReverse) return status;
  const result = dependencies.ensureAndroidMetroReverse({
    deviceId: device.deviceId,
    metroPort,
    binding: existing,
  });
  if (sameAndroidMetroReverse(existing ?? null, result.binding)) return status;
  try {
    registry.updateBindings(session, {
      expectedAuthorityVersion: status.authorityVersion,
      bindings: { androidMetroReverse: result.binding },
    });
  } catch (error) {
    if (result.created && result.binding) {
      try {
        (dependencies.removeAndroidMetroReverse ?? removeAndroidMetroReverse)(result.binding);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'PHYSICAL_ANDROID_METRO_CLEANUP_UNPROVEN: adb reverse was created but its authority binding could not be persisted or safely cleaned',
        );
      }
    }
    throw error;
  }
  const current = registry.getSessionStatus(session.sessionId);
  if (!current) {
    throw new SessionAuthorityError(
      'SESSION_OWNER_LOST',
      'session disappeared after physical Android Metro reachability was established',
    );
  }
  return current;
}

function removeSessionAndroidMetroReverse(
  registry: SessionRegistry,
  session: SessionRef,
  status: SessionStatus,
  dependencies: SessionHandlerDependencies,
): SessionStatus {
  const binding = status.bindings.androidMetroReverse as
    | AndroidMetroReverseBinding
    | null
    | undefined;
  if (!binding) return status;
  if (!dependencies.removeAndroidMetroReverse) {
    throw new SessionAuthorityError(
      'PHYSICAL_ANDROID_METRO_CLEANUP_UNPROVEN',
      'physical Android Metro cleanup integration is unavailable',
    );
  }
  dependencies.removeAndroidMetroReverse(binding);
  registry.updateBindings(session, {
    expectedAuthorityVersion: status.authorityVersion,
    bindings: { androidMetroReverse: null },
  });
  const current = registry.getSessionStatus(session.sessionId);
  if (!current) {
    throw new SessionAuthorityError(
      'SESSION_OWNER_LOST',
      'session disappeared after physical Android Metro reachability cleanup',
    );
  }
  return current;
}

export function createSessionHandler(
  runtime: WorkerAuthorityRuntime,
  dependencies: SessionHandlerDependencies = {},
): (input: SessionToolInput) => Promise<ToolResult> {
  return async (input) => {
    if (input.action === 'status') {
      try {
        // GH #672: rotate before projecting, so status can never advertise an adoption
        // handle that adopt_stale would then refuse as expired.
        runtime.refreshRecoveryHandles();
        const projectedAuthority = reconcileManagedMetroStatus(runtime, dependencies);
        const installIdentity = projectedAuthority.available
          ? (dependencies.inspectInstallIdentity ?? inspectInstallIdentity)(
              projectedAuthority.bindings.install as Record<string, unknown> | null | undefined,
            )
          : null;
        return okResult({
          authoritative: false,
          authority: projectPublicAuthorityStatus(projectedAuthority, {
            includeSessionId: true,
            now: dependencies.now,
            recoveryRequirement: runtime.inspectRecoveryRequirement(),
            installIdentity,
          }),
        });
      } catch (error) {
        return authorityFailure(error);
      }
    }

    try {
      const isRecovery = input.action === 'accept_handoff' || input.action === 'adopt_stale';
      const { registry, session } = isRecovery
        ? runtime.requireRecovery()
        : runtime.requireOperational();
      if (input.action === 'recover_arbiter') {
        if (input.confirmed !== true) {
          throw new SessionAuthorityError(
            'SESSION_AUTHORITY_REQUIRED',
            'recover_arbiter requires confirmed=true',
          );
        }
        const arbiterReset = (dependencies.resetArbiter ?? ((reason) => arbiter.reset(reason)))(
          'manual via fenced rn_session',
        );
        return okResult({
          arbiterReset,
          session: projectPublicAuthorityStatus(runtime.status()),
        });
      }

      if (input.action === 'release_stale_device') {
        const hasPlatform = input.platform !== undefined;
        const hasDeviceId = input.deviceId !== undefined;
        if (hasPlatform !== hasDeviceId) {
          throw new SessionAuthorityError(
            'DEVICE_AUTHORITY_MISMATCH',
            'platform and deviceId must both be supplied or both omitted for journal resumption',
          );
        }
        const target =
          hasPlatform && hasDeviceId
            ? { platform: input.platform as 'ios' | 'android', deviceId: input.deviceId as string }
            : undefined;
        const releaseHandle = input.releaseHandle;
        const current = registry.getSessionStatus(session.sessionId);
        const workerInstance = current?.worker.instanceId;
        if (!workerInstance) {
          throw new SessionAuthorityError(
            'HANDOFF_NOT_AUTHORIZED',
            'release worker identity is unavailable',
          );
        }
        const offer = current?.bindings.staleDeviceRelease as
          | { platform?: unknown; deviceId?: unknown }
          | null
          | undefined;
        const journal = current?.bindings.staleDeviceCleanup as
          | { platform?: unknown; deviceId?: unknown }
          | null
          | undefined;
        const authority = journal ?? offer;
        if (
          target &&
          authority &&
          (authority.platform !== target.platform || authority.deviceId !== target.deviceId)
        ) {
          throw new SessionAuthorityError(
            'DEVICE_AUTHORITY_MISMATCH',
            'the stale release request does not match the exact cleanup journal or offer',
            undefined,
            {
              axis: 'D',
              nextAction: 'Run rn_session with action "status" for the exact recovery.',
            },
          );
        }
        if (!journal && !target) {
          throw new SessionAuthorityError(
            'DEVICE_AUTHORITY_MISMATCH',
            'platform and deviceId are required for the initial stale device transfer',
          );
        }
        let plan;
        if (!journal && typeof releaseHandle !== 'string') {
          // ADR L5 (captain-approved D3): confirmed: true replaces the release-offer
          // capability token; death is re-proven from durable state in the transfer.
          if (input.confirmed !== true) {
            throw new SessionAuthorityError(
              'SESSION_AUTHORITY_REQUIRED',
              'the initial stale device transfer requires confirmed: true',
              undefined,
              {
                axis: 'D',
                nextAction:
                  `rn_session({ action: "release_stale_device", platform: "${target!.platform}", ` +
                  `deviceId: "${target!.deviceId}", confirmed: true }), or re-run bind_device ` +
                  'with confirmed: true to release and rebind in one step.',
              },
            );
          }
          plan = registry.beginConfirmedStaleDeviceRelease(session, workerInstance, target!);
        } else {
          plan = registry.beginStaleResourceRelease(session, releaseHandle, workerInstance, target);
        }
        const completed = await completeStaleDeviceCleanupPlan(
          registry,
          session,
          workerInstance,
          plan,
          dependencies,
        );
        registry.finishStaleResourceRelease(session, workerInstance);
        return okResult({
          released: { platform: plan.platform, cleanupCompleted: completed },
          session: projectPublicAuthorityStatus(runtime.status(), { now: dependencies.now }),
          nextAction:
            'The exact device, runner, and recorder claims are released. Re-run bind_device to claim the device.',
        });
      }

      if (input.action === 'bind_device') {
        const platform = required(input.platform, 'platform') as 'ios' | 'android';
        const deviceId = required(input.deviceId, 'deviceId') as string;
        const appId = required(input.appId, 'appId') as string;
        let status = registry.getSessionStatus(session.sessionId);
        const signer = dependencies.getSignerCapability?.();
        if (!status) {
          throw new SessionAuthorityError(
            'SESSION_AUTHORITY_REQUIRED',
            'session disappeared before device binding',
          );
        }
        if (status.bindings.runner || status.bindings.observe || status.bindings.proof) {
          throw new SessionAuthorityError(
            'DEVICE_AUTHORITY_MISMATCH',
            'device rebinding requires runner, Observe, or proof authority to be released first',
          );
        }
        const requireWorkerInstance = () => {
          const workerInstance = status!.worker.instanceId;
          if (!workerInstance) {
            throw new SessionAuthorityError(
              'HANDOFF_NOT_AUTHORIZED',
              'release worker identity is unavailable',
            );
          }
          return workerInstance;
        };
        // ADR L5: an interrupted exact-device cleanup journal resumes token-lessly on a
        // bare bind of the same target; a different target keeps refusing below.
        const cleanupJournal = status.bindings.staleDeviceCleanup as
          | { platform?: unknown; deviceId?: unknown }
          | null
          | undefined;
        if (
          cleanupJournal &&
          cleanupJournal.platform === platform &&
          cleanupJournal.deviceId === deviceId
        ) {
          const workerInstance = requireWorkerInstance();
          const plan = registry.beginConfirmedStaleDeviceRelease(session, workerInstance, {
            platform,
            deviceId,
          });
          await completeStaleDeviceCleanupPlan(
            registry,
            session,
            workerInstance,
            plan,
            dependencies,
          );
          registry.finishStaleResourceRelease(session, workerInstance);
        }
        const requireExactDevice = () => {
          let deviceExists: boolean;
          try {
            deviceExists = (dependencies.deviceExists ?? deviceExistsOnHost)(platform, deviceId);
          } catch (error) {
            throw new SessionAuthorityError(
              'DEVICE_DISCOVERY_UNAVAILABLE',
              `could not verify exact ${platform} device ${deviceId}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
          if (!deviceExists) {
            throw new SessionAuthorityError(
              'DEVICE_NOT_FOUND',
              `exact ${platform} device ${deviceId} does not exist or is unavailable`,
            );
          }
        };
        requireExactDevice();
        const retainedReverse = status.bindings.androidMetroReverse as
          | AndroidMetroReverseBinding
          | null
          | undefined;
        if (retainedReverse && (platform !== 'android' || retainedReverse.deviceId !== deviceId)) {
          status = removeSessionAndroidMetroReverse(registry, session, status, dependencies);
        }
        const currentInstall = status.bindings.install as Record<string, unknown> | undefined;
        if (
          !input.buildReceipt &&
          currentInstall &&
          (currentInstall.platform !== platform ||
            currentInstall.deviceId !== deviceId ||
            currentInstall.appId !== appId)
        ) {
          throw new SessionAuthorityError(
            'DEVICE_RECEIPT_INCOMPATIBLE',
            'cannot replace exact-device authority while an incompatible install receipt is bound',
          );
        }
        if (!input.buildReceipt) {
          const invalidatesBundle = Boolean(status.bindings.bundle);
          await withInlineStaleDeviceCleanup(
            registry,
            session,
            dependencies,
            { platform, deviceId, appId, confirmed: input.confirmed },
            requireWorkerInstance,
            requireExactDevice,
            () =>
              registry.replaceDeviceAuthority(session, {
                resource: { type: 'device', key: `${platform}:${deviceId}` },
                device: {
                  platform,
                  deviceId,
                  appId,
                  ...(input.devClientUrl ? { devClientUrl: input.devClientUrl } : {}),
                },
              }),
          );
          if (invalidatesBundle) dependencies.onBundleInvalidated?.();
          return okResult({
            session: projectPublicAuthorityStatus(runtime.status()),
            buildReceiptRequired: true,
          });
        }
        if (!signer) {
          throw new SessionAuthorityError(
            'APP_INSTALL_IDENTITY_CHANGED',
            'the session signer is unavailable for build receipt verification',
          );
        }
        const receipt = verifyBuildReceipt(input.buildReceipt as unknown as BuildReceipt, signer, {
          sessionId: session.sessionId,
          sourceKey: status.sourceKey,
          worktreeKey: status.worktreeKey,
          appRootKey: status.appRootKey,
          platform,
          deviceId,
          appId,
          metroPort: Number(status.bindings.metroPort),
        });
        const requireInstallGeneration = () => {
          const observedGeneration = (
            dependencies.captureInstallGeneration ?? captureInstallGeneration
          )({
            platform,
            deviceId,
            appId,
          });
          if (observedGeneration !== receipt.installGeneration) {
            throw new SessionAuthorityError(
              'APP_INSTALL_IDENTITY_CHANGED',
              'installed artifact generation does not match the signed build receipt',
            );
          }
        };
        requireInstallGeneration();
        await withInlineStaleDeviceCleanup(
          registry,
          session,
          dependencies,
          { platform, deviceId, appId, confirmed: input.confirmed },
          requireWorkerInstance,
          () => {
            requireExactDevice();
            requireInstallGeneration();
          },
          () =>
            registry.replaceDeviceAuthority(session, {
              resource: { type: 'device', key: `${platform}:${deviceId}` },
              device: { platform, deviceId, appId },
              install: { ...receipt },
            }),
        );
        if (status.bindings.bundle) dependencies.onBundleInvalidated?.();
        return okResult({ session: projectPublicAuthorityStatus(runtime.status()) });
      }

      if (input.action === 'bind_metro') {
        if (input.mode === 'managed') {
          throw new SessionAuthorityError(
            'METRO_AUTHORITY_MISMATCH',
            'managed Metro authority can only be established by the verified managed launcher',
          );
        }
        const port = required(input.metroPort, 'metroPort') as number;
        const pid = required(input.metroPid, 'metroPid') as number;
        const instanceId = required(input.metroInstanceId, 'metroInstanceId') as string;
        const buildGeneration = required(input.buildGeneration, 'buildGeneration') as number;
        const status = registry.getSessionStatus(session.sessionId);
        if (status?.bindings.metroPort !== port) {
          throw new SessionAuthorityError(
            'METRO_PORT_CLAIM_CONFLICT',
            'requested Metro port does not match the session allocation',
          );
        }
        const sourceRoot = String(status.source.contentRoot ?? '');
        const metro = await (dependencies.captureMetro ?? captureMetroBinding)({
          port,
          pid,
          instanceId,
          sourceRoot,
          buildGeneration,
        });
        const nextMetro = { ...metro, mode: 'external' as const };
        const priorMetro = status.bindings.metro as Record<string, unknown> | undefined;
        const priorBundle = status.bindings.bundle as Record<string, unknown> | undefined;
        const priorTargetId = priorBundle?.targetId;
        const metroUnchanged = sameMetroAuthority(priorMetro, nextMetro);
        registry.claimResources(session, [{ type: 'metro-port', key: String(port) }]);
        registry.updateBindings(session, {
          state: metroUnchanged
            ? status.state
            : status.bindings.install
              ? 'device_bound'
              : 'metro_bound',
          bindings: metroUnchanged ? { metro: nextMetro } : { metro: nextMetro, bundle: null },
          releaseResources:
            !metroUnchanged && typeof priorTargetId === 'string'
              ? [{ type: 'target', key: `${String(status.bindings.metroPort)}:${priorTargetId}` }]
              : [],
        });
        if (!metroUnchanged && priorBundle) dependencies.onBundleInvalidated?.();
        return okResult({ session: projectPublicAuthorityStatus(runtime.status()) });
      }

      if (input.action === 'pin_dev_client') {
        let status = registry.getSessionStatus(session.sessionId);
        if (!status || !dependencies.pinDevClient) {
          throw new SessionAuthorityError(
            'BUNDLE_HANDSHAKE_UNAVAILABLE',
            'pinning integration is unavailable',
          );
        }
        for (const requiredBinding of ['install', 'metro', 'device']) {
          if (!status.bindings[requiredBinding]) {
            throw new SessionAuthorityError(
              'BUNDLE_HANDSHAKE_UNAVAILABLE',
              `${requiredBinding} must be bound before pinning`,
            );
          }
        }
        status = ensurePhysicalAndroidMetroReachability(registry, session, status, dependencies);
        const priorTargetId = (status.bindings.bundle as { targetId?: unknown } | null | undefined)
          ?.targetId;
        const priorBundle = status.bindings.bundle ?? null;
        const priorState = status.state;
        const priorAuthorityVersion = status.authorityVersion;
        const devicePlatform = (status.bindings.device as { platform?: unknown } | undefined)
          ?.platform;
        const atomicAndroidReplacement = devicePlatform === 'android';
        if (
          input.force === true &&
          !atomicAndroidReplacement &&
          typeof priorTargetId === 'string'
        ) {
          registry.releaseResources(session, [
            { type: 'target', key: `${String(status.bindings.metroPort)}:${priorTargetId}` },
          ]);
          registry.updateBindings(session, {
            state: 'device_bound',
            bindings: { bundle: null },
          });
          dependencies.onBundleInvalidated?.();
        }
        await dependencies.pinDevClient(
          status,
          { force: input.force === true },
          (candidate, promotion) => {
            const candidateTarget = {
              type: 'target' as const,
              key: `${candidate.metroPort}:${candidate.targetId}`,
            };
            const targetChanged = priorTargetId !== candidate.targetId;
            const priorTarget =
              typeof priorTargetId === 'string' && targetChanged
                ? {
                    type: 'target' as const,
                    key: `${candidate.metroPort}:${priorTargetId}`,
                  }
                : null;
            let committed = false;
            try {
              registry.updateBindings(session, {
                state: 'ready',
                bindings: { bundle: candidate },
                expectedAuthorityVersion: atomicAndroidReplacement
                  ? priorAuthorityVersion
                  : undefined,
                releaseResources: atomicAndroidReplacement && priorTarget ? [priorTarget] : [],
                claimResources: [candidateTarget],
                probeClaimOwners: true,
                assertBeforeCommit: promotion.assertActive,
                onCommitted: () => {
                  committed = true;
                },
              });
              promotion.assertActive();
              promotion.publish();
            } catch (error) {
              if (committed && atomicAndroidReplacement) {
                registry.updateBindings(session, {
                  state: priorState,
                  bindings: { bundle: priorBundle },
                  expectedAuthorityVersion: priorAuthorityVersion + 1,
                  releaseResources: targetChanged ? [candidateTarget] : [],
                  claimResources: priorTarget ? [priorTarget] : [],
                });
              }
              throw error;
            }
          },
        );
        return okResult({ session: projectPublicAuthorityStatus(runtime.status()) });
      }

      if (input.action === 'prepare_handoff') {
        const targetHandle = required(input.targetHandle, 'targetHandle') as string;
        return okResult(
          registry.prepareHandoffForHandle(session, {
            targetHandle,
            ...(input.ttlMs === undefined ? {} : { ttlMs: input.ttlMs }),
          }),
        );
      }

      if (input.action === 'cancel_handoff') {
        const handoffId = required(input.handoffId, 'handoffId') as string;
        registry.cancelHandoff(session, handoffId);
        return okResult({
          cancelled: true,
          session: projectPublicAuthorityStatus(runtime.status()),
        });
      }

      if (input.action === 'stop_metro') {
        let status = registry.getSessionStatus(session.sessionId);
        if (!status) {
          throw new SessionAuthorityError(
            'SESSION_AUTHORITY_REQUIRED',
            'session disappeared before managed Metro cleanup',
          );
        }
        if (status.bindings.runner) {
          throw new SessionAuthorityError(
            'SESSION_AUTHORITY_REQUIRED',
            'stop_metro requires device_snapshot action=close before releasing active runner authority',
          );
        }
        const metro = (status.bindings.metroCleanup ?? status.bindings.metro) as
          | SessionMetroBinding
          | null
          | undefined;
        if (!metro) {
          const metroPort = Number(status.bindings.metroPort);
          if (Number.isSafeInteger(metroPort)) {
            let listener: ManagedMetroListenerProbe = { status: 'unknown' };
            try {
              listener = (dependencies.probeListener ?? probeManagedMetroListener)(metroPort);
            } catch {}
            if (listener.status !== 'absent') {
              const listenerIdentity =
                listener.status === 'listening' && typeof listener.pid === 'number'
                  ? ` by listener pid ${listener.pid}`
                  : '';
              throw new SessionAuthorityError(
                'METRO_CLEANUP_PENDING',
                `allocated Metro port ${metroPort} is still ${listener.status}${listenerIdentity} after cleanup authority was invalidated; do not signal an unbound process, wait for managed launcher cleanup, then retry rn_session stop_metro`,
              );
            }
          }
          status = removeSessionAndroidMetroReverse(registry, session, status, dependencies);
          return okResult({
            stopped: false,
            alreadyStopped: true,
            session: projectPublicAuthorityStatus(runtime.status()),
          });
        }
        const metroPort = Number(status.bindings.metroPort);
        if (!Number.isSafeInteger(metroPort) || metro.port !== metroPort) {
          throw new SessionAuthorityError(
            'METRO_AUTHORITY_MISMATCH',
            'Metro cleanup binding does not match the exact allocated session port',
          );
        }
        const signerCapability = dependencies.getSignerCapability?.();
        const runtimeEvidenceSocket =
          metro.mode === 'managed' && typeof metro.runtimeEvidenceSocket === 'string'
            ? metro.runtimeEvidenceSocket
            : undefined;
        let socketReferencedByOtherSession = true;
        if (runtimeEvidenceSocket) {
          try {
            socketReferencedByOtherSession = registry.isMetroEvidenceSocketReferencedByOtherSession(
              session.sessionId,
              runtimeEvidenceSocket,
            );
          } catch {}
        }
        const evidenceDependencies = {
          authorizeEvidenceSocketRemoval: () =>
            input.confirmed === true && !socketReferencedByOtherSession,
          ...(dependencies.evidenceSocketExists
            ? { exists: dependencies.evidenceSocketExists }
            : {}),
          ...(dependencies.probeProcessBirth ? { probeBirth: dependencies.probeProcessBirth } : {}),
          ...(dependencies.probeListener ? { probeListener: dependencies.probeListener } : {}),
          ...(dependencies.removeEvidenceSocket
            ? { removeEvidenceSocket: dependencies.removeEvidenceSocket }
            : {}),
        };
        let cleanup: ManagedMetroCleanupResult;
        if (metro.mode === 'managed') {
          if (dependencies.stopManagedMetroWithEvidence) {
            cleanup = await dependencies.stopManagedMetroWithEvidence(
              metro,
              {
                sessionId: session.sessionId,
                signerCapability: signerCapability ?? '',
              },
              evidenceDependencies,
            );
          } else if (dependencies.stopManagedMetro && signerCapability) {
            const stopped = await dependencies.stopManagedMetro(metro, {
              sessionId: session.sessionId,
              signerCapability,
            });
            const evidence = stopped
              ? {
                  complete: true,
                  launcher: 'absent' as const,
                  listener: 'absent' as const,
                  port: { status: 'absent' as const },
                  evidenceSocket: 'absent' as const,
                }
              : inspectManagedMetroCleanupEvidence(
                  metro as Record<string, unknown>,
                  evidenceDependencies,
                );
            cleanup = { authenticated: stopped, stopped, evidence };
          } else {
            cleanup = await stopManagedMetroWithEvidence(
              metro,
              {
                sessionId: session.sessionId,
                signerCapability: signerCapability ?? '',
              },
              evidenceDependencies,
            );
          }
        } else {
          const evidence = inspectManagedMetroCleanupEvidence(
            metro as Record<string, unknown>,
            evidenceDependencies,
          );
          cleanup = { authenticated: false, stopped: false, evidence };
        }
        const onlySocketRemains =
          cleanup.evidence.launcher === 'absent' &&
          cleanup.evidence.listener === 'absent' &&
          cleanup.evidence.port.status === 'absent' &&
          cleanup.evidence.evidenceSocket === 'present';
        if (!cleanup.authenticated && onlySocketRemains && input.confirmed !== true) {
          throw new SessionAuthorityError(
            'SESSION_AUTHORITY_REQUIRED',
            'confirmed=true is required to remove the stale session-owned Metro evidence socket',
          );
        }
        if (!cleanup.authenticated && onlySocketRemains && socketReferencedByOtherSession) {
          throw new SessionAuthorityError(
            'METRO_AUTHORITY_MISMATCH',
            'the Metro evidence socket remains referenced by another session; recover that owning session before retrying rn_session stop_metro',
          );
        }
        if (!cleanup.evidence.complete) {
          const socketRecovery =
            onlySocketRemains && runtimeEvidenceSocket
              ? `; remove the exact session-owned socket ${runtimeEvidenceSocket} through its filesystem owner, then retry rn_session stop_metro`
              : '; stop the exact owning process and retry rn_session stop_metro';
          throw new SessionAuthorityError(
            'METRO_AUTHORITY_MISMATCH',
            `Metro cleanup is unresolved (${describeMetroCleanupEvidence(cleanup.evidence)})${socketRecovery}`,
          );
        }
        if (!cleanup.authenticated && input.confirmed !== true) {
          throw new SessionAuthorityError(
            'SESSION_AUTHORITY_REQUIRED',
            'non-signaling Metro authority release requires confirmed=true after exact process, listener, and socket absence is verified',
          );
        }
        status = removeSessionAndroidMetroReverse(registry, session, status, dependencies);
        const priorTargetId = (status.bindings.bundle as { targetId?: unknown } | null | undefined)
          ?.targetId;
        registry.updateBindings(session, {
          expectedAuthorityVersion: status.authorityVersion,
          state: status.bindings.install
            ? 'device_bound'
            : status.bindings.device
              ? 'device_claimed'
              : 'source_bound',
          bindings: {
            metro: null,
            metroCleanup: null,
            metroTerminal: null,
            bundle: null,
          },
          releaseResources:
            typeof priorTargetId === 'string' && Number.isSafeInteger(metroPort)
              ? [{ type: 'target', key: `${metroPort}:${priorTargetId}` }]
              : [],
        });
        if (status.bindings.bundle) dependencies.onBundleInvalidated?.();
        return okResult({
          stopped: cleanup.stopped,
          alreadyStopped: !cleanup.stopped,
          bindingReleased: !cleanup.authenticated,
          session: projectPublicAuthorityStatus(runtime.status()),
          nextAction: 'Retry the managed Metro/build command for the literal Expo native build.',
          alternativeAction:
            'To tear down instead, restore package integration with confirmed=true, then release the exact session.',
        });
      }

      if (
        input.action === 'preview_integration' ||
        input.action === 'apply_integration' ||
        input.action === 'restore_integration'
      ) {
        const status = registry.getSessionStatus(session.sessionId);
        const appRoot = String(status?.source.appRoot ?? '');
        if (!status || !appRoot) {
          throw new SessionAuthorityError(
            'SOURCE_WORKTREE_MISMATCH',
            'session app root is unavailable for integration',
          );
        }
        const packagePath = join(appRoot, 'package.json');
        const integrationInputs = readPackageIntegrationInputs(appRoot);
        const manifestPath = join(
          appRoot,
          '.rn-agent',
          'integration',
          'rn-session-integration.json',
        );
        const packageJson = JSON.parse(integrationInputs.packageJson) as Record<string, unknown>;
        const integrationBinding = status.bindings.packageIntegration as
          | IntegrationBindingShape
          | undefined;
        const installationManifestSource =
          integrationBinding?.installation?.phase === 'started' &&
          typeof integrationBinding.installation.manifestSource === 'string'
            ? integrationBinding.installation.manifestSource
            : undefined;
        const restorationManifestSource =
          integrationBinding?.restoration?.phase === 'started' &&
          typeof integrationBinding.restoration.manifestSource === 'string'
            ? integrationBinding.restoration.manifestSource
            : undefined;
        const manifestSource =
          input.action === 'restore_integration' && integrationBinding
            ? (verifiedManifestSource(
                integrationInputs.manifest,
                integrationBinding?.manifestSha256,
              ) ??
              verifiedManifestSource(
                restorationManifestSource,
                integrationBinding?.manifestSha256,
              ) ??
              verifiedManifestSource(
                installationManifestSource,
                integrationBinding?.manifestSha256,
              ) ??
              durableBindingManifestSource(integrationBinding))
            : (integrationInputs.manifest ??
              restorationManifestSource ??
              installationManifestSource ??
              durableBindingManifestSource(integrationBinding));
        let existing: PackageIntegrationManifest | undefined;
        try {
          existing =
            manifestSource === undefined
              ? undefined
              : (JSON.parse(manifestSource) as PackageIntegrationManifest);
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
        }
        const sessionCli =
          process.env.RN_DEV_AGENT_SESSION_CLI ??
          join(dirname(fileURLToPath(import.meta.url)), '..', 'rn-session.js');
        const stateDir = process.env.RN_DEV_AGENT_STATE_DIR;
        if (input.action === 'restore_integration') {
          if (input.confirmed !== true) {
            throw new SessionAuthorityError(
              'SESSION_AUTHORITY_REQUIRED',
              'restore_integration requires confirmed=true',
            );
          }
          if (!existing) {
            if (!integrationBinding) {
              throw new SessionAuthorityError(
                'SESSION_AUTHORITY_REQUIRED',
                'integration manifest is unavailable for restoration',
                undefined,
                {
                  nextAction:
                    'No package-integration binding is active for this session; proceed to release.',
                },
              );
            }
            throw new SessionAuthorityError(
              'SESSION_AUTHORITY_REQUIRED',
              `integration restoration requires a SHA-256-verified manifest and none is available; the binding is preserved and canonical files were inspected for diagnostics only (${describeIntegrationFileDiagnostics(appRoot)})`,
              undefined,
              {
                nextAction: manifestRecoveryNextAction(
                  integrationBinding,
                  'retry restore_integration with confirmed=true',
                ),
              },
            );
          }
          assertPackageIntegrationInactive(status.bindings, input.action);
          const manifestSha256 = createHash('sha256')
            .update(manifestSource ?? '')
            .digest('hex');
          if (
            integrationBinding?.version !== 1 ||
            typeof integrationBinding.installedBySessionId !== 'string' ||
            integrationBinding.manifestSha256 !== manifestSha256
          ) {
            throw new SessionAuthorityError(
              'SESSION_AUTHORITY_REQUIRED',
              'integration restoration requires the transferred manifest authority binding',
            );
          }
          if (restorationManifestSource !== manifestSource) {
            registry.updateBindings(session, {
              bindings: {
                packageIntegration: {
                  ...integrationBinding,
                  restoration: { phase: 'started', manifestSource },
                },
              },
            });
          }
          restorePackageIntegrationFiles({ appRoot, manifestSource });
          registry.updateBindings(session, {
            bindings: { packageIntegration: null },
          });
          return okResult({ restored: true, packagePath, manifestPath });
        }
        const preview = previewPackageIntegration(packageJson, existing, sessionCli, stateDir);
        const metroConfigPath = integrationInputs.metroConfig.path;
        const metroBefore = integrationInputs.metroConfig.contents;
        const metroAfter = previewMetroIntegration(metroBefore);
        if (input.action === 'preview_integration') {
          return okResult({
            confirmed: false,
            packagePath,
            before: packageJson,
            after: preview.packageJson,
            metroConfigPath,
            metroBefore,
            metroAfter,
            manifest: preview.manifest,
          });
        }
        if (input.confirmed !== true) {
          throw new SessionAuthorityError(
            'SESSION_AUTHORITY_REQUIRED',
            'apply_integration requires confirmed=true after reviewing preview_integration',
          );
        }
        assertPackageIntegrationInactive(status.bindings, input.action);
        if (integrationBinding && !installationManifestSource) {
          throw new SessionAuthorityError(
            'SESSION_AUTHORITY_REQUIRED',
            'package integration is already owned by an active session lifecycle',
            undefined,
            {
              nextAction:
                'Run restore_integration with confirmed=true to restore or reconcile the owning integration binding, then retry apply_integration.',
            },
          );
        }
        preview.manifest.metroConfig = metroConfigPath.slice(appRoot.length + 1);
        const expectedManifestSource =
          installationManifestSource ?? serializePackageIntegrationManifest(preview.manifest);
        const expectedManifestSha256 = createHash('sha256')
          .update(expectedManifestSource)
          .digest('hex');
        if (
          installationManifestSource &&
          (integrationBinding?.version !== 1 ||
            integrationBinding.installedBySessionId !== session.sessionId ||
            integrationBinding.manifestSha256 !== expectedManifestSha256)
        ) {
          throw new SessionAuthorityError(
            'SESSION_AUTHORITY_REQUIRED',
            'integration installation requires the original session manifest authority binding',
          );
        }
        if (!installationManifestSource) {
          registry.updateBindings(session, {
            bindings: {
              packageIntegration: {
                version: 1,
                installedBySessionId: session.sessionId,
                manifestSha256: expectedManifestSha256,
                installation: { phase: 'started', manifestSource: expectedManifestSource },
              },
            },
          });
        }
        try {
          applyPackageIntegration({ appRoot, sessionCli, stateDir });
          const installedManifest = readPackageIntegrationInputs(appRoot).manifest;
          if (!installedManifest) {
            throw new Error('SESSION_INTEGRATION_PATH_UNSAFE: applied manifest is unavailable');
          }
          if (
            createHash('sha256').update(installedManifest).digest('hex') !== expectedManifestSha256
          ) {
            throw new SessionAuthorityError(
              'SESSION_AUTHORITY_REQUIRED',
              'applied integration manifest no longer matches its durable installation authority',
            );
          }
          registry.updateBindings(session, {
            bindings: {
              packageIntegration: {
                version: 1,
                installedBySessionId: session.sessionId,
                manifestSha256: expectedManifestSha256,
                manifestSource: expectedManifestSource,
              },
            },
          });
        } catch (error) {
          try {
            restorePackageIntegrationFiles({
              appRoot,
              manifestSource: expectedManifestSource,
            });
            registry.updateBindings(session, {
              bindings: { packageIntegration: null },
            });
          } catch (rollbackError) {
            throw new AggregateError([error, rollbackError]);
          }
          throw error;
        }
        return okResult({ applied: true, packagePath, manifestPath });
      }

      if (input.action === 'accept_handoff') {
        const handoffId = required(input.handoffId, 'handoffId') as string;
        const token = required(input.token, 'token') as string;
        const status = registry.getSessionStatus(session.sessionId);
        if (!status?.worker.instanceId) {
          throw new SessionAuthorityError(
            'HANDOFF_NOT_AUTHORIZED',
            'target worker identity is unavailable',
          );
        }
        if (status.state !== 'handoff_cleanup') {
          registry.validateHandoffInto(session, {
            handoffId,
            token,
            targetInstance: status.worker.instanceId,
          });
        } else {
          registry.validateHandoffCleanupResumption(session, {
            handoffId,
            token,
            targetInstance: status.worker.instanceId,
          });
        }
        let cleanup = status.bindings.handoffCleanup as
          | {
              metro?: Record<string, unknown>;
              observe?: Record<string, unknown>;
              runner?: Record<string, unknown>;
              recorder?: Record<string, unknown>;
            }
          | undefined;
        const priorSessionId = registry.getHandoffOwner(handoffId);
        const priorStatus = priorSessionId ? registry.getSessionStatus(priorSessionId) : null;
        const priorRunner = (cleanup?.runner ?? priorStatus?.bindings.runner) as
          | {
              platform?: unknown;
              deviceId?: unknown;
              pid?: unknown;
              processBirth?: unknown;
            }
          | undefined;
        const acceptAppRoot = String(status.source.appRoot ?? '');
        if (status.state === 'handoff_cleanup') {
          const transferredBinding = status.bindings.packageIntegration as
            | IntegrationBindingShape
            | null
            | undefined;
          if (transferredBinding && !durableRestorationMaterial(transferredBinding)) {
            throw new SessionAuthorityError(
              'SESSION_AUTHORITY_REQUIRED',
              `resumed handoff cleanup carries package-integration authority without a SHA-256-verified restoration manifest; cleanup refuses before any lifecycle mutation, and canonical files were inspected for diagnostics only (${describeIntegrationFileDiagnostics(acceptAppRoot)})`,
              undefined,
              { nextAction: manifestTransferNextAction(transferredBinding) },
            );
          }
        } else {
          const donorBinding = priorStatus?.bindings.packageIntegration as
            | IntegrationBindingShape
            | null
            | undefined;
          if (donorBinding && !durableRestorationMaterial(donorBinding)) {
            throw new SessionAuthorityError(
              'SESSION_AUTHORITY_REQUIRED',
              `handoff donor carries package-integration authority without a SHA-256-verified restoration manifest; acceptance refuses before any reservation, cleanup, transfer, or registry mutation, and canonical files were inspected for diagnostics only (${describeIntegrationFileDiagnostics(acceptAppRoot)})`,
              undefined,
              { nextAction: manifestTransferNextAction(donorBinding) },
            );
          }
        }
        if (
          status.state !== 'handoff_cleanup' &&
          priorRunner &&
          (typeof priorRunner.pid !== 'number' ||
            typeof priorRunner.processBirth !== 'string' ||
            inspectSessionOwner({
              sessionId: priorSessionId ?? 'unknown',
              pid: priorRunner.pid,
              token: priorRunner.processBirth,
            }) !== 'match')
        ) {
          throw new SessionAuthorityError(
            'RUNNER_ADOPTION_REQUIRED',
            'prior runner process identity cannot be proven for capability rotation',
          );
        }
        if (status.state !== 'handoff_cleanup') {
          const priorManagedMetro =
            priorStatus?.bindings.metro &&
            typeof priorStatus.bindings.metro === 'object' &&
            (priorStatus.bindings.metro as Record<string, unknown>).mode === 'managed'
              ? (priorStatus.bindings.metro as ManagedMetroBinding)
              : null;
          let signerCapability: string | null = null;
          if (priorManagedMetro) {
            if (!priorSessionId) {
              throw new SessionAuthorityError(
                'METRO_AUTHORITY_MISMATCH',
                'managed Metro handoff source authority is unavailable',
              );
            }
            signerCapability = dependencies.getSignerCapability?.(priorSessionId) ?? null;
            if (!signerCapability) {
              throw new SessionAuthorityError(
                'SESSION_AUTHORITY_REQUIRED',
                'managed Metro handoff requires the source session signer capability',
              );
            }
          }
          const reservation = registry.reserveManagedMetroHandoffCleanup(session, {
            handoffId,
            token,
            targetInstance: status.worker.instanceId,
          });
          if (reservation && reservation.phase !== 'shutdown_completed') {
            const sourceSessionId = reservation.metro.sourceSessionId;
            if (typeof sourceSessionId !== 'string' || !signerCapability) {
              throw new SessionAuthorityError(
                'SESSION_AUTHORITY_REQUIRED',
                'managed Metro handoff reservation requires the source session signer capability',
              );
            }
            const stopped = await (dependencies.stopManagedMetro ?? stopManagedMetro)(
              reservation.metro,
              {
                sessionId: sourceSessionId,
                signerCapability,
              },
            );
            if (!stopped) {
              registry.refuseManagedMetroHandoffCleanup(session, {
                handoffId,
                token,
                targetInstance: status.worker.instanceId,
              });
              throw new SessionAuthorityError(
                'METRO_AUTHORITY_MISMATCH',
                'managed Metro shutdown was refused; the handoff was cancelled and donor authority was restored',
              );
            }
            registry.completeManagedMetroHandoffCleanup(session, {
              handoffId,
              token,
              targetInstance: status.worker.instanceId,
            });
          }
          cleanup = registry.acceptHandoffInto(session, {
            handoffId,
            token,
            targetInstance: status.worker.instanceId,
          });
        }
        if (cleanup?.recorder && typeof cleanup.recorder.completedAt !== 'number') {
          const recorderCleanup = registry.beginHandoffCleanupResource(
            session,
            status.worker.instanceId,
            'recorder',
          );
          if (!recorderCleanup) {
            throw new SessionAuthorityError(
              'RECORDING_AUTHORITY_MISMATCH',
              'recorder cleanup binding disappeared while fenced',
            );
          }
          await (dependencies.stopHandoffRecorder ?? stopBoundRecorder)(recorderCleanup);
          registry.completeHandoffCleanupResource(session, status.worker.instanceId, 'recorder');
        }
        const afterRecorder = registry.getSessionStatus(session.sessionId);
        cleanup = afterRecorder?.bindings.handoffCleanup as typeof cleanup;
        if (cleanup?.runner && typeof cleanup.runner.completedAt !== 'number') {
          const runnerCleanup = registry.beginHandoffCleanupResource(
            session,
            status.worker.instanceId,
            'runner',
          );
          if (!runnerCleanup) {
            throw new SessionAuthorityError(
              'RUNNER_ADOPTION_REQUIRED',
              'runner cleanup binding disappeared while fenced',
            );
          }
          if (dependencies.stopHandoffRunner) {
            await dependencies.stopHandoffRunner(runnerCleanup);
          } else {
            await stopHandoffRunner(
              runnerCleanup,
              dependencies.probeProcessBirth,
              dependencies.signalProcess,
              dependencies.cleanupTimeoutMs,
            );
          }
          registry.completeHandoffCleanupResource(session, status.worker.instanceId, 'runner');
        }
        const afterRunner = registry.getSessionStatus(session.sessionId);
        cleanup = afterRunner?.bindings.handoffCleanup as typeof cleanup;
        if (cleanup?.observe && typeof cleanup.observe.completedAt !== 'number') {
          const observeCleanup = registry.beginHandoffCleanupResource(
            session,
            status.worker.instanceId,
            'observe',
          );
          if (!observeCleanup) {
            throw new SessionAuthorityError(
              'OBSERVE_AUTHORITY_MISMATCH',
              'Observe cleanup binding disappeared while fenced',
            );
          }
          if (dependencies.stopHandoffObserve) {
            await dependencies.stopHandoffObserve(observeCleanup);
          } else {
            await stopHandoffObserve(
              observeCleanup,
              dependencies.probeListener,
              dependencies.probeProcessBirth,
              dependencies.cleanupTimeoutMs,
            );
          }
          registry.completeHandoffCleanupResource(session, status.worker.instanceId, 'observe');
        }
        const afterObserve = registry.getSessionStatus(session.sessionId);
        cleanup = afterObserve?.bindings.handoffCleanup as typeof cleanup;
        if (cleanup?.metro && typeof cleanup.metro.completedAt !== 'number') {
          const metroCleanup = registry.beginHandoffCleanupResource(
            session,
            status.worker.instanceId,
            'metro',
          );
          if (!metroCleanup || typeof metroCleanup.sourceSessionId !== 'string') {
            throw new SessionAuthorityError(
              'METRO_AUTHORITY_MISMATCH',
              'managed Metro cleanup binding disappeared while fenced',
            );
          }
          const signerCapability = dependencies.getSignerCapability?.(metroCleanup.sourceSessionId);
          if (!signerCapability) {
            throw new SessionAuthorityError(
              'SESSION_AUTHORITY_REQUIRED',
              'managed Metro handoff cleanup requires the source session signer capability',
            );
          }
          const stopped = await (dependencies.stopManagedMetro ?? stopManagedMetro)(metroCleanup, {
            sessionId: metroCleanup.sourceSessionId,
            signerCapability,
          });
          if (!stopped) {
            throw new SessionAuthorityError(
              'METRO_AUTHORITY_MISMATCH',
              'managed Metro could not be stopped with its source session authority',
            );
          }
          registry.completeHandoffCleanupResource(session, status.worker.instanceId, 'metro');
        }
        registry.finishHandoffCleanup(session, status.worker.instanceId);
        const acceptedStatus = registry.getSessionStatus(session.sessionId);
        const transferredIntegration = acceptedStatus?.bindings.packageIntegration as
          | { installedBySessionId?: unknown }
          | undefined;
        return okResult({
          accepted: true,
          session: projectPublicAuthorityStatus(runtime.status()),
          runnerCapabilityRotated: Boolean(priorRunner),
          integrationRestoration:
            typeof transferredIntegration?.installedBySessionId === 'string'
              ? {
                  required: true,
                  action: 'restore_integration',
                  ownerSessionId: session.sessionId,
                  installedBySessionId: transferredIntegration.installedBySessionId,
                }
              : { required: false },
          nextAction:
            typeof transferredIntegration?.installedBySessionId === 'string'
              ? 'The recipient now owns integration restoration; call restore_integration with confirmed=true before release.'
              : 'Reopen the exact device runner and pin the dev client before authoritative tools.',
        });
      }

      if (input.action === 'adopt_stale') {
        const current = registry.getSessionStatus(session.sessionId);
        if (current?.source.model === 'grouped-v1') {
          throw new SessionAuthorityError(
            'HANDOFF_NOT_AUTHORIZED',
            'this session never mints adoption handles; a proven-dead same-root owner is released automatically at startup',
            undefined,
            {
              nextAction:
                'Restart the MCP transport (/mcp) so startup cleanup releases a dead owner, or close the live owner session.',
            },
          );
        }
        const adoptionHandle = required(input.adoptionHandle, 'adoptionHandle') as string;
        if (!current?.worker.instanceId) {
          throw new SessionAuthorityError(
            'HANDOFF_NOT_AUTHORIZED',
            'recovery worker identity is unavailable',
          );
        }
        const adoptionAppRoot = String(current.source.appRoot ?? '');
        const refuseManifestlessBinding = (
          subject: string,
          binding: IntegrationBindingShape | null | undefined,
        ): never => {
          throw new SessionAuthorityError(
            'SESSION_AUTHORITY_REQUIRED',
            `${subject} without a SHA-256-verified restoration manifest; recovery refuses before any transfer, cleanup, or registry mutation, and canonical files were inspected for diagnostics only (${describeIntegrationFileDiagnostics(adoptionAppRoot)})`,
            undefined,
            { nextAction: manifestTransferNextAction(binding) },
          );
        };
        if (current.state !== 'handoff_cleanup') {
          registry.validateStaleAdoption(session, adoptionHandle, current.worker.instanceId);
          const recoveryHandles = current.bindings.recoveryHandles as
            | { adoptStale?: { priorSessionId?: unknown } }
            | undefined;
          const priorSessionId =
            typeof recoveryHandles?.adoptStale?.priorSessionId === 'string'
              ? recoveryHandles.adoptStale.priorSessionId
              : undefined;
          const priorIntegration = priorSessionId
            ? (registry.getSessionStatus(priorSessionId)?.bindings.packageIntegration as
                | IntegrationBindingShape
                | undefined)
            : undefined;
          if (priorIntegration && !durableRestorationMaterial(priorIntegration)) {
            refuseManifestlessBinding(
              'stale session carries package-integration authority',
              priorIntegration,
            );
          }
          registry.adoptStaleWithHandle(session, adoptionHandle, current.worker.instanceId, {
            expectedTargetAuthorityVersion: current.authorityVersion,
          });
        } else {
          registry.verifyStaleAdoptionResumption(
            session,
            adoptionHandle,
            current.worker.instanceId,
          );
          const transferredBinding = current.bindings.packageIntegration as
            | IntegrationBindingShape
            | null
            | undefined;
          if (transferredBinding && !durableRestorationMaterial(transferredBinding)) {
            refuseManifestlessBinding(
              'resumed stale adoption carries package-integration authority',
              transferredBinding,
            );
          }
        }
        const adopted = registry.getSessionStatus(session.sessionId);
        const cleanup = adopted?.bindings.handoffCleanup as
          | {
              metro?: Record<string, unknown>;
              runner?: Record<string, unknown>;
              observe?: Record<string, unknown>;
              recorder?: Record<string, unknown>;
            }
          | undefined;
        if (cleanup?.recorder && typeof cleanup.recorder.completedAt !== 'number') {
          const recorderCleanup = registry.beginHandoffCleanupResource(
            session,
            current.worker.instanceId,
            'recorder',
          );
          if (!recorderCleanup) {
            throw new SessionAuthorityError(
              'RECORDING_AUTHORITY_MISMATCH',
              'stale recorder cleanup binding disappeared while fenced',
            );
          }
          await (dependencies.stopHandoffRecorder ?? stopBoundRecorder)(recorderCleanup);
          registry.completeHandoffCleanupResource(session, current.worker.instanceId, 'recorder');
        }
        if (cleanup?.runner && typeof cleanup.runner.completedAt !== 'number') {
          const runnerCleanup = registry.beginHandoffCleanupResource(
            session,
            current.worker.instanceId,
            'runner',
          );
          if (!runnerCleanup) {
            throw new SessionAuthorityError(
              'RUNNER_ADOPTION_REQUIRED',
              'stale runner cleanup binding disappeared while fenced',
            );
          }
          if (dependencies.stopHandoffRunner) {
            await dependencies.stopHandoffRunner(runnerCleanup);
          } else {
            await stopHandoffRunner(
              runnerCleanup,
              dependencies.probeProcessBirth,
              dependencies.signalProcess,
              dependencies.cleanupTimeoutMs,
            );
          }
          registry.completeHandoffCleanupResource(session, current.worker.instanceId, 'runner');
        }
        if (cleanup?.observe && typeof cleanup.observe.completedAt !== 'number') {
          const observeCleanup = registry.beginHandoffCleanupResource(
            session,
            current.worker.instanceId,
            'observe',
          );
          if (!observeCleanup) {
            throw new SessionAuthorityError(
              'OBSERVE_AUTHORITY_MISMATCH',
              'stale Observe cleanup binding disappeared while fenced',
            );
          }
          if (dependencies.stopHandoffObserve) {
            await dependencies.stopHandoffObserve(observeCleanup);
          } else {
            await stopHandoffObserve(
              observeCleanup,
              dependencies.probeListener,
              dependencies.probeProcessBirth,
              dependencies.cleanupTimeoutMs,
            );
          }
          registry.completeHandoffCleanupResource(session, current.worker.instanceId, 'observe');
        }
        if (cleanup?.metro && typeof cleanup.metro.completedAt !== 'number') {
          const metroCleanup = registry.beginHandoffCleanupResource(
            session,
            current.worker.instanceId,
            'metro',
          );
          if (!metroCleanup || typeof metroCleanup.sourceSessionId !== 'string') {
            throw new SessionAuthorityError(
              'METRO_AUTHORITY_MISMATCH',
              'stale Metro cleanup binding disappeared while fenced',
            );
          }
          const signerCapability = dependencies.getSignerCapability?.(metroCleanup.sourceSessionId);
          if (!signerCapability) {
            throw new SessionAuthorityError(
              'SESSION_AUTHORITY_REQUIRED',
              'stale Metro cleanup requires the source session signer capability',
            );
          }
          const stopped = await (dependencies.stopManagedMetro ?? stopManagedMetro)(metroCleanup, {
            sessionId: metroCleanup.sourceSessionId,
            signerCapability,
          });
          if (!stopped) {
            throw new SessionAuthorityError(
              'METRO_AUTHORITY_MISMATCH',
              'stale managed Metro could not be stopped with exact process authority',
            );
          }
          registry.completeHandoffCleanupResource(session, current.worker.instanceId, 'metro');
        }
        if (adopted?.state === 'handoff_cleanup') {
          registry.finishHandoffCleanup(session, current.worker.instanceId);
        }
        const settled = registry.getSessionStatus(session.sessionId);
        const transferredIntegration = settled?.bindings.packageIntegration as
          | IntegrationBindingShape
          | undefined;
        const integrationOutcome: Record<string, unknown> = transferredIntegration
          ? {
              integrationRestoration: {
                required: true,
                action: 'restore_integration',
                installedBySessionId: transferredIntegration.installedBySessionId,
              },
              nextAction:
                'The adopter now owns integration restoration; call restore_integration with confirmed=true before release.',
            }
          : {
              integrationRestoration: { required: false },
            };
        return okResult({
          adopted: true,
          session: projectPublicAuthorityStatus(runtime.status()),
          ...integrationOutcome,
          runner: {
            adopted: false,
            reason:
              'runner capability is never crash-adopted; reopen the exact device to bind a fresh runner',
          },
        });
      }

      let status = registry.getSessionStatus(session.sessionId);
      if (!status) {
        throw new SessionAuthorityError(
          'SESSION_AUTHORITY_REQUIRED',
          'session disappeared before release cleanup',
        );
      }
      if (status.bindings.packageIntegration) {
        throw new SessionAuthorityError(
          'SESSION_AUTHORITY_REQUIRED',
          'package integration must be restored before session release',
        );
      }
      status = removeSessionAndroidMetroReverse(registry, session, status, dependencies);
      const metro = status.bindings.metro as Partial<ManagedMetroBinding> | null | undefined;
      const runner = status.bindings.runner as Record<string, unknown> | null | undefined;
      const recorder = status.bindings.recorder as Record<string, unknown> | null | undefined;
      if (recorder) {
        const claimKey = `${String(recorder.platform)}:${String(recorder.deviceId)}`;
        if (
          !status.claims.some(
            (claim) =>
              claim.type === 'recorder' &&
              claim.key === claimKey &&
              claim.sessionId === session.sessionId &&
              claim.claimEpoch === session.claimEpoch,
          )
        ) {
          throw new SessionAuthorityError(
            'RECORDING_AUTHORITY_MISMATCH',
            'recorder cleanup claim no longer matches the authenticated binding',
          );
        }
        await (dependencies.stopHandoffRecorder ?? stopBoundRecorder)(recorder);
      }
      if (runner) {
        const claimKey = `${String(runner.platform)}:${String(runner.deviceId)}:${String(
          runner.port,
        )}`;
        if (
          !status.claims.some(
            (claim) =>
              claim.type === 'runner' &&
              claim.key === claimKey &&
              claim.sessionId === session.sessionId &&
              claim.claimEpoch === session.claimEpoch,
          )
        ) {
          throw new SessionAuthorityError(
            'RUNNER_OWNERSHIP_MISMATCH',
            'runner cleanup claim no longer matches the authenticated binding',
          );
        }
        const cleanup = { ...runner, claimKey, stopRequestedAt: Date.now() };
        if (dependencies.stopHandoffRunner) {
          await dependencies.stopHandoffRunner(cleanup);
        } else {
          await stopBoundRunner(
            cleanup,
            dependencies.probeProcessBirth,
            dependencies.signalProcess,
            dependencies.cleanupTimeoutMs,
          );
        }
      }
      const observe = status.bindings.observe as Record<string, unknown> | null | undefined;
      if (observe) {
        const port = String(observe.port);
        if (
          status.bindings.observePort !== observe.port ||
          !status.claims.some(
            (claim) =>
              claim.type === 'observe-port' &&
              claim.key === port &&
              claim.sessionId === session.sessionId &&
              claim.claimEpoch === session.claimEpoch,
          )
        ) {
          throw new SessionAuthorityError(
            'OBSERVE_AUTHORITY_MISMATCH',
            'Observe cleanup claim no longer matches the authenticated binding',
          );
        }
        const cleanup = { ...observe, stopRequestedAt: Date.now() };
        if (dependencies.stopHandoffObserve) {
          await dependencies.stopHandoffObserve(cleanup);
        } else {
          await stopBoundObserve(
            cleanup,
            dependencies.probeListener,
            dependencies.probeProcessBirth,
            dependencies.cleanupTimeoutMs,
          );
        }
      }
      if (metro?.mode === 'managed') {
        const signerCapability = dependencies.getSignerCapability?.();
        if (!signerCapability) {
          throw new SessionAuthorityError(
            'SESSION_AUTHORITY_REQUIRED',
            'managed Metro release requires the session signer capability',
          );
        }
        const stopped = await (dependencies.stopManagedMetro ?? stopManagedMetro)(metro, {
          sessionId: session.sessionId,
          signerCapability,
        });
        if (!stopped) {
          throw new SessionAuthorityError(
            'METRO_AUTHORITY_MISMATCH',
            'managed Metro could not be stopped with exact process authority',
          );
        }
      }
      registry.releaseSession(session);
      if (status.bindings.bundle) dependencies.onBundleInvalidated?.();
      // GH #706: the released row can never be transitioned again. Ask the supervisor
      // to resolve a fresh session so the next call is not a dead end.
      let recycleRequested = false;
      try {
        recycleRequested = dependencies.requestWorkerRecycle?.() === true;
      } catch {
        /* release already succeeded; recovery falls back to a transport restart */
      }
      return okResult({
        released: true,
        sessionId: session.sessionId,
        recycleRequested,
        nextAction: recycleRequested
          ? 'A fresh session is minted automatically; retry rn_session (bind_device, apply_integration) on this worktree.'
          : 'No supervisor can mint a successor here; restart the MCP transport before the next rn_session action on this worktree.',
      });
    } catch (error) {
      return authorityFailure(error);
    }
  };
}
