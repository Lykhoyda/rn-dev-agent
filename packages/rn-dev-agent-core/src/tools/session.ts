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
import { stopFastRunner } from '../runners/rn-fast-runner-client.js';
import { stopAndroidRunner } from '../runners/rn-android-runner-client.js';
import { inspectSessionOwner } from '../session/process-owner.js';
import { projectPublicAuthorityStatus } from '../session/public-status.js';
import { stopObserveServer } from './observe.js';

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
  targetInstance?: string;
  handoffId?: string;
  token?: string;
  priorSessionId?: string;
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
      const { registry, session } = runtime.requireAvailable();
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
        registry.claimResources(session, [{ type: 'metro-port', key: String(port) }]);
        registry.updateBindings(session, {
          state: status.bindings.install ? 'device_bound' : 'metro_bound',
          bindings: { metro: { ...metro, mode: input.mode ?? 'external' } },
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
        const targetInstance = required(input.targetInstance, 'targetInstance') as string;
        return okResult(registry.prepareHandoff(session, { targetInstance }));
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
        registry.validateHandoffInto(session, {
          handoffId,
          token,
          targetInstance: status.worker.instanceId,
        });
        const priorSessionId = registry.getHandoffOwner(handoffId);
        const priorStatus = priorSessionId ? registry.getSessionStatus(priorSessionId) : null;
        const priorRunner = priorStatus?.bindings.runner as
          | {
              platform?: unknown;
              deviceId?: unknown;
              pid?: unknown;
              processBirth?: unknown;
            }
          | undefined;
        if (
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
        if (priorStatus?.bindings.observe) await stopObserveServer();
        if (priorRunner?.platform === 'ios') {
          stopFastRunner(
            typeof priorRunner.deviceId === 'string' ? priorRunner.deviceId : undefined,
          );
        } else if (priorRunner?.platform === 'android') {
          await stopAndroidRunner(
            typeof priorRunner.deviceId === 'string' ? priorRunner.deviceId : undefined,
          );
        }
        registry.acceptHandoffInto(session, {
          handoffId,
          token,
          targetInstance: status.worker.instanceId,
        });
        return okResult({
          accepted: true,
          session: projectPublicAuthorityStatus(runtime.status()),
          runnerCapabilityRotated: Boolean(priorRunner),
          nextAction:
            'Reopen the exact device runner and pin the dev client before authoritative tools.',
        });
      }

      if (input.action === 'adopt_stale') {
        const priorSessionId = required(input.priorSessionId, 'priorSessionId') as string;
        const current = registry.getSessionStatus(session.sessionId);
        const prior = registry.getSessionStatus(priorSessionId);
        if (
          !current ||
          !prior ||
          current.sourceKey !== prior.sourceKey ||
          current.worktreeKey !== prior.worktreeKey ||
          current.appRootKey !== prior.appRootKey
        ) {
          throw new SessionAuthorityError(
            'SOURCE_WORKTREE_MISMATCH',
            'stale session does not belong to this exact source worktree',
          );
        }
        const transferable = prior.claims
          .filter((claim) =>
            new Set(['source', 'metro-port', 'observe-port', 'device']).has(claim.type),
          )
          .map(({ type, key }) => ({ type, key }));
        registry.claimResources(session, transferable);
        const metro = prior.bindings.metro as { port?: unknown } | undefined;
        const sameMetro = Number(metro?.port) === Number(current.bindings.metroPort);
        registry.updateBindings(session, {
          state: sameMetro && prior.bindings.device ? 'device_bound' : 'source_bound',
          bindings: {
            adoptionRequired: null,
            ...(sameMetro ? { metro: prior.bindings.metro } : { metro: null }),
            ...(prior.bindings.device ? { device: prior.bindings.device } : {}),
            ...(prior.bindings.install ? { install: prior.bindings.install } : {}),
            bundle: null,
            runner: null,
          },
        });
        return okResult({
          adopted: true,
          priorSessionId: priorSessionId.slice(0, 12),
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
