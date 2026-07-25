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
  readPackageIntegrationInputs,
  restorePackageIntegrationFiles,
  type PackageIntegrationManifest,
} from '../session/package-integration.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectSessionOwner } from '../session/process-owner.js';
import { projectPublicAuthorityStatus } from '../session/public-status.js';
import { probeProcessBirth, type ProcessBirthProbe } from '../session/process-birth.js';
import {
  stopManagedMetro,
  type ManagedMetroBinding,
  type ManagedMetroListenerProbe,
} from '../session/managed-metro.js';
import { arbiter } from '../lifecycle/device-arbiter.js';
import { stopBoundObserve, stopBoundRunner } from '../session/process-cleanup.js';

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
    | 'recover_arbiter'
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
  force?: boolean;
}

interface SessionHandlerDependencies {
  getSignerCapability?: (sessionId?: string) => string | null;
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
  ) => Promise<BundleAuthorityBinding>;
  stopHandoffObserve?: (binding: Record<string, unknown>) => Promise<void>;
  stopHandoffRunner?: (binding: Record<string, unknown>) => Promise<void>;
  probeProcessBirth?: (pid: number) => ProcessBirthProbe;
  probeListener?: (port: number) => ManagedMetroListenerProbe;
  signalProcess?: (pid: number, signal: NodeJS.Signals) => void;
  stopManagedMetro?: typeof stopManagedMetro;
  resetArbiter?: (reason: string) => {
    clearedOps: number;
    hadFlow: boolean;
    reason: string;
  };
  cleanupTimeoutMs?: number;
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
        const nextMetro = { ...metro, mode: input.mode ?? ('external' as const) };
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
        const priorTargetId = (status.bindings.bundle as { targetId?: unknown } | null | undefined)
          ?.targetId;
        if (input.force === true && typeof priorTargetId === 'string') {
          registry.releaseResources(session, [
            { type: 'target', key: `${String(status.bindings.metroPort)}:${priorTargetId}` },
          ]);
          registry.updateBindings(session, {
            state: 'device_bound',
            bindings: { bundle: null },
          });
        }
        const bundle = await dependencies.pinDevClient(status, {
          force: input.force === true,
        });
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
        const integrationInputs = readPackageIntegrationInputs(appRoot);
        const manifestPath = join(
          appRoot,
          '.rn-agent',
          'integration',
          'rn-session-integration.json',
        );
        const packageJson = JSON.parse(integrationInputs.packageJson) as Record<string, unknown>;
        let existing: PackageIntegrationManifest | undefined;
        try {
          const manifest = integrationInputs.manifest;
          existing =
            manifest === undefined
              ? undefined
              : (JSON.parse(manifest) as PackageIntegrationManifest);
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
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
          | {
              metro?: Record<string, unknown>;
              observe?: Record<string, unknown>;
              runner?: Record<string, unknown>;
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
        if (current.state !== 'handoff_cleanup') {
          registry.adoptStaleWithHandle(session, adoptionHandle, current.worker.instanceId);
        }
        const adopted = registry.getSessionStatus(session.sessionId);
        const cleanup = adopted?.bindings.handoffCleanup as
          | {
              metro?: Record<string, unknown>;
              runner?: Record<string, unknown>;
              observe?: Record<string, unknown>;
            }
          | undefined;
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

      const status = registry.getSessionStatus(session.sessionId);
      if (!status) {
        throw new SessionAuthorityError(
          'SESSION_AUTHORITY_REQUIRED',
          'session disappeared before release cleanup',
        );
      }
      const metro = status.bindings.metro as Partial<ManagedMetroBinding> | null | undefined;
      const runner = status.bindings.runner as Record<string, unknown> | null | undefined;
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
      return okResult({ released: true, sessionId: session.sessionId });
    } catch (error) {
      return authorityFailure(error);
    }
  };
}
