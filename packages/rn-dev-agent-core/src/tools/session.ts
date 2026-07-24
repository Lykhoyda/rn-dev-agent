import { authorityErrorMeta, SessionAuthorityError } from '../session/registry.js';
import type { WorkerAuthorityRuntime } from '../session/runtime.js';
import { failResult, okResult, type ToolResult } from '../utils.js';
import type { ToolErrorCode } from '../types.js';
import { verifyBuildReceipt, type BuildReceipt } from '../session/build-receipt.js';
import {
  captureInstallGeneration,
  type InstalledArtifactIdentity,
} from '../session/install-authority.js';
import { captureMetroBinding, type MetroBinding } from '../session/metro-binding.js';
import type { BundleAuthorityBinding } from '../session/dev-client-authority.js';
import type { SessionStatus } from '../session/registry.js';
import {
  applyPackageIntegration,
  previewMetroIntegration,
  previewPackageIntegration,
  restorePackageIntegrationFiles,
  type PackageIntegrationManifest,
} from '../session/package-integration.js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectSessionOwner } from '../session/process-owner.js';
import { projectPublicAuthorityStatus } from '../session/public-status.js';
import { probeProcessBirth, type ProcessBirthProbe } from '../session/process-birth.js';
import {
  probeManagedMetroListener,
  type ManagedMetroListenerProbe,
} from '../session/managed-metro.js';

export interface SessionToolInput {
  action:
    | 'status'
    | 'bind_device'
    | 'bind_metro'
    | 'pin_dev_client'
    | 'prepare_handoff'
    | 'cancel_handoff'
    | 'accept_handoff'
    | 'adopt_stale'
    | 'preview_integration'
    | 'apply_integration'
    | 'restore_integration'
    | 'release';
  platform?: 'ios' | 'android';
  deviceId?: string;
  appId?: string;
  devClientUrl?: string;
  buildReceipt?: Record<string, unknown>;
  metroPort?: number;
  metroPid?: number;
  metroInstanceId?: string;
  buildGeneration?: number;
  mode?: 'managed' | 'external';
  targetHandle?: string;
  handoffId?: string;
  token?: string;
  adoptionHandle?: string;
  confirmed?: boolean;
}

interface SessionHandlerDependencies {
  getSignerCapability?: () => string | null;
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
  pinDevClient?: (status: SessionStatus) => Promise<BundleAuthorityBinding>;
  stopHandoffObserve?: (binding: Record<string, unknown>) => Promise<void>;
  stopHandoffRunner?: (binding: Record<string, unknown>) => Promise<void>;
  probeProcessBirth?: (pid: number) => ProcessBirthProbe;
  probeListener?: (port: number) => ManagedMetroListenerProbe;
  signalProcess?: (pid: number, signal: NodeJS.Signals) => void;
  cleanupTimeoutMs?: number;
}

async function waitForExactStopped(
  probe: () => 'running' | 'stopped' | 'unknown',
  timeoutMs: number,
  message: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const status = probe();
    if (status === 'stopped') return;
    if (status === 'unknown') {
      throw new SessionAuthorityError(
        'HANDOFF_NOT_AUTHORIZED',
        `${message}; shutdown identity is unknown`,
      );
    }
    if (Date.now() >= deadline) {
      throw new SessionAuthorityError('HANDOFF_NOT_AUTHORIZED', message);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}

async function stopHandoffObserve(
  binding: Record<string, unknown>,
  listenerProbe: (port: number) => ManagedMetroListenerProbe = probeManagedMetroListener,
  processProbe: (pid: number) => ProcessBirthProbe = probeProcessBirth,
  timeoutMs = 2_000,
): Promise<void> {
  const port = Number(binding.port);
  const pid = Number(binding.pid);
  const expectedBirth = String(binding.processBirth ?? '');
  const instanceId = String(binding.instanceId ?? '');
  const capability = String(binding.cleanupCapability ?? '');
  const stopRequestedAt = Number(binding.stopRequestedAt);
  if (
    !Number.isSafeInteger(port) ||
    !Number.isSafeInteger(pid) ||
    !expectedBirth ||
    !instanceId ||
    !capability ||
    !Number.isFinite(stopRequestedAt)
  ) {
    throw new SessionAuthorityError(
      'OBSERVE_AUTHORITY_MISMATCH',
      'source Observe cleanup authority is incomplete',
    );
  }
  const currentListener = listenerProbe(port);
  if (currentListener.status === 'unknown') {
    throw new SessionAuthorityError(
      'OBSERVE_AUTHORITY_MISMATCH',
      'source Observe listener lookup is inconclusive',
    );
  }
  if (currentListener.status === 'absent' || currentListener.pid !== pid) return;
  const currentBirth = processProbe(pid);
  if (currentBirth.status === 'unknown') {
    throw new SessionAuthorityError(
      'OBSERVE_AUTHORITY_MISMATCH',
      'source Observe process identity is unavailable',
    );
  }
  if (currentBirth.status === 'absent') {
    throw new SessionAuthorityError(
      'OBSERVE_AUTHORITY_MISMATCH',
      'source Observe listener identity is internally inconsistent',
    );
  }
  if (currentBirth.birth.token !== expectedBirth) {
    throw new SessionAuthorityError(
      'OBSERVE_AUTHORITY_MISMATCH',
      'source Observe listener PID was reused before cleanup completed',
    );
  }
  const response = await fetch(`http://127.0.0.1:${port}/api/stop`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${capability}`,
      'x-rn-observe-instance': instanceId,
    },
  });
  if (!response.ok) {
    throw new SessionAuthorityError(
      'OBSERVE_AUTHORITY_MISMATCH',
      'source Observe server refused fenced handoff cleanup',
    );
  }
  await waitForExactStopped(
    () => {
      const observed = listenerProbe(port);
      if (observed.status === 'unknown') return 'unknown';
      return observed.status === 'listening' && observed.pid === pid ? 'running' : 'stopped';
    },
    timeoutMs,
    'source Observe listener did not stop before the cleanup deadline',
  );
}

async function stopHandoffRunner(
  binding: Record<string, unknown>,
  processProbe: (pid: number) => ProcessBirthProbe = probeProcessBirth,
  signalProcess: (pid: number, signal: NodeJS.Signals) => void = process.kill,
  timeoutMs = 2_000,
): Promise<void> {
  const pid = Number(binding.pid);
  const expectedBirth = String(binding.processBirth ?? '');
  const instanceId = String(binding.instanceId ?? '');
  const capability = String(binding.capability ?? '');
  const claimKey = String(binding.claimKey ?? '');
  const stopRequestedAt = Number(binding.stopRequestedAt);
  if (
    !Number.isSafeInteger(pid) ||
    !expectedBirth ||
    !instanceId ||
    !capability ||
    !claimKey ||
    !Number.isFinite(stopRequestedAt)
  ) {
    throw new SessionAuthorityError(
      'RUNNER_ADOPTION_REQUIRED',
      'source runner cleanup identity is incomplete',
    );
  }
  const current = processProbe(pid);
  if (current.status === 'unknown') {
    throw new SessionAuthorityError(
      'RUNNER_ADOPTION_REQUIRED',
      'source runner process identity is unavailable',
    );
  }
  if (current.status === 'absent' || current.birth.token !== expectedBirth) return;
  signalProcess(pid, 'SIGTERM');
  await waitForExactStopped(
    () => {
      const observed = processProbe(pid);
      if (observed.status === 'unknown') return 'unknown';
      return observed.status === 'present' && observed.birth.token === expectedBirth
        ? 'running'
        : 'stopped';
    },
    timeoutMs,
    'source runner process did not stop before the cleanup deadline',
  );
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

export function createSessionHandler(
  runtime: WorkerAuthorityRuntime,
  dependencies: SessionHandlerDependencies = {},
): (input: SessionToolInput) => Promise<ToolResult> {
  return async (input) => {
    if (input.action === 'status') {
      const authority = runtime.status();
      return okResult({
        authoritative: false,
        authority: projectPublicAuthorityStatus(authority),
      });
    }

    try {
      const isRecovery = input.action === 'accept_handoff' || input.action === 'adopt_stale';
      const { registry, session } = isRecovery
        ? runtime.requireRecovery()
        : runtime.requireOperational();
      if (input.action === 'bind_device') {
        const platform = required(input.platform, 'platform') as 'ios' | 'android';
        const deviceId = required(input.deviceId, 'deviceId') as string;
        const appId = required(input.appId, 'appId') as string;
        const status = registry.getSessionStatus(session.sessionId);
        const signer = dependencies.getSignerCapability?.();
        if (!status) {
          throw new SessionAuthorityError(
            'SESSION_AUTHORITY_REQUIRED',
            'session disappeared before device binding',
          );
        }
        if (!input.buildReceipt) {
          registry.replaceDeviceAuthority(session, {
            resource: { type: 'device', key: `${platform}:${deviceId}` },
            device: {
              platform,
              deviceId,
              appId,
              ...(input.devClientUrl ? { devClientUrl: input.devClientUrl } : {}),
            },
          });
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
        registry.replaceDeviceAuthority(session, {
          resource: { type: 'device', key: `${platform}:${deviceId}` },
          device: { platform, deviceId, appId },
          install: { ...receipt },
        });
        return okResult({ session: projectPublicAuthorityStatus(runtime.status()) });
      }

      if (input.action === 'bind_metro') {
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
        const priorBundle = status.bindings.bundle as Record<string, unknown> | undefined;
        const priorTargetId = priorBundle?.targetId;
        registry.claimResources(session, [{ type: 'metro-port', key: String(port) }]);
        registry.updateBindings(session, {
          state: status.bindings.install ? 'device_bound' : 'metro_bound',
          bindings: { metro: { ...metro, mode: input.mode ?? 'external' }, bundle: null },
          releaseResources:
            typeof priorTargetId === 'string'
              ? [{ type: 'target', key: `${String(status.bindings.metroPort)}:${priorTargetId}` }]
              : [],
        });
        return okResult({ session: projectPublicAuthorityStatus(runtime.status()) });
      }

      if (input.action === 'pin_dev_client') {
        const status = registry.getSessionStatus(session.sessionId);
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
        const bundle = await dependencies.pinDevClient(status);
        registry.claimResources(session, [
          { type: 'target', key: `${bundle.metroPort}:${bundle.targetId}` },
        ]);
        registry.updateBindings(session, {
          state: 'ready',
          bindings: { bundle },
        });
        return okResult({ session: projectPublicAuthorityStatus(runtime.status()) });
      }

      if (input.action === 'prepare_handoff') {
        const targetHandle = required(input.targetHandle, 'targetHandle') as string;
        return okResult(registry.prepareHandoffForHandle(session, { targetHandle }));
      }

      if (input.action === 'cancel_handoff') {
        const handoffId = required(input.handoffId, 'handoffId') as string;
        registry.cancelHandoff(session, handoffId);
        return okResult({
          cancelled: true,
          session: projectPublicAuthorityStatus(runtime.status()),
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
        const metroConfigPath = ['metro.config.js', 'metro.config.cjs']
          .map((name) => join(appRoot, name))
          .find((path) => {
            try {
              readFileSync(path, 'utf8');
              return true;
            } catch {
              return false;
            }
          });
        if (!metroConfigPath) {
          throw new SessionAuthorityError(
            'BUNDLE_HANDSHAKE_UNAVAILABLE',
            'metro.config.js or metro.config.cjs is required for integration',
          );
        }
        const manifestPath = join(
          appRoot,
          '.rn-agent',
          'integration',
          'rn-session-integration.json',
        );
        const packageJson = JSON.parse(readFileSync(packagePath, 'utf8')) as Record<
          string,
          unknown
        >;
        let existing: PackageIntegrationManifest | undefined;
        try {
          existing = JSON.parse(readFileSync(manifestPath, 'utf8')) as PackageIntegrationManifest;
        } catch {
          existing = undefined;
        }
        const sessionCli =
          process.env.RN_DEV_AGENT_SESSION_CLI ??
          join(dirname(fileURLToPath(import.meta.url)), '..', 'rn-session.js');
        if (input.action === 'restore_integration') {
          if (input.confirmed !== true) {
            throw new SessionAuthorityError(
              'SESSION_AUTHORITY_REQUIRED',
              'restore_integration requires confirmed=true',
            );
          }
          if (!existing) {
            throw new SessionAuthorityError(
              'SESSION_AUTHORITY_REQUIRED',
              'integration manifest is unavailable for restoration',
            );
          }
          restorePackageIntegrationFiles({ appRoot });
          registry.updateBindings(session, {
            bindings: { packageIntegration: null },
          });
          return okResult({ restored: true, packagePath, manifestPath });
        }
        const preview = previewPackageIntegration(packageJson, existing, sessionCli);
        const metroBefore = readFileSync(metroConfigPath, 'utf8');
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
        applyPackageIntegration({ appRoot, sessionCli });
        registry.updateBindings(session, {
          bindings: { packageIntegration: { applied: true } },
        });
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
        let cleanup = status.bindings.handoffCleanup as
          | { observe?: Record<string, unknown>; runner?: Record<string, unknown> }
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
          registry.validateHandoffInto(session, {
            handoffId,
            token,
            targetInstance: status.worker.instanceId,
          });
          cleanup = registry.acceptHandoffInto(session, {
            handoffId,
            token,
            targetInstance: status.worker.instanceId,
          });
        }
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
        registry.finishHandoffCleanup(session, status.worker.instanceId);
        return okResult({
          accepted: true,
          session: projectPublicAuthorityStatus(runtime.status()),
          runnerCapabilityRotated: Boolean(priorRunner),
          nextAction:
            'Reopen the exact device runner and pin the dev client before authoritative tools.',
        });
      }

      if (input.action === 'adopt_stale') {
        const adoptionHandle = required(input.adoptionHandle, 'adoptionHandle') as string;
        const current = registry.getSessionStatus(session.sessionId);
        if (!current?.worker.instanceId) {
          throw new SessionAuthorityError(
            'HANDOFF_NOT_AUTHORIZED',
            'recovery worker identity is unavailable',
          );
        }
        registry.adoptStaleWithHandle(session, adoptionHandle, current.worker.instanceId);
        return okResult({
          adopted: true,
          session: projectPublicAuthorityStatus(runtime.status()),
          runner: {
            adopted: false,
            reason:
              'runner capability is never crash-adopted; reopen the exact device to bind a fresh runner',
          },
        });
      }

      registry.releaseSession(session);
      return okResult({ released: true, sessionId: session.sessionId });
    } catch (error) {
      return authorityFailure(error);
    }
  };
}
