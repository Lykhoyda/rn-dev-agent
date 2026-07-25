#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createBuildReceipt } from './session/build-receipt.js';
import { captureInstalledArtifact } from './session/install-authority.js';
import { buildSignedMetroMarker, createMetroAuthorityModule } from './session/metro-authority.js';
import { captureMetroBinding } from './session/metro-binding.js';
import {
  startManagedMetro,
  stopManagedMetro,
  type ManagedMetroBinding,
} from './session/managed-metro.js';
import { inspectSessionOwner } from './session/process-owner.js';
import {
  openSessionRegistry,
  SessionAuthorityError,
  type OperationRef,
} from './session/registry.js';
import { resolveSourceIdentity } from './session/source-identity.js';
import { createAuthorityStateLayout, sessionRuntimeDirectory } from './session/state-root.js';
import { inspectAuthorityMigration } from './session/migration-diagnostic.js';
import { projectPublicAuthorityStatus } from './session/public-status.js';
import { stopBoundObserve, stopBoundRunner } from './session/process-cleanup.js';
import {
  closeBoundDirectories,
  type BoundDirectory,
  openBoundDirectory,
  openBoundSubdirectory,
  writeBoundDirectoryFile,
} from './session/bound-directory.js';

function resolveStatus() {
  const layout = createAuthorityStateLayout(process.env.RN_DEV_AGENT_STATE_DIR);
  const registry = openSessionRegistry(layout.registry, { ownerStatus: inspectSessionOwner });
  const explicit = process.env.RN_DEV_AGENT_SESSION_ID;
  const source = resolveSourceIdentity(process.cwd(), {
    declaredRoot: process.env.RN_DEV_AGENT_DECLARED_ROOT,
    declaredManifests: process.env.RN_DEV_AGENT_DECLARED_MANIFESTS?.split(',').filter(Boolean),
  });
  const candidates = explicit
    ? [registry.getSessionStatus(explicit)].filter(
        (status): status is NonNullable<typeof status> => status !== null,
      )
    : registry.findSessionsByWorktree(source.worktreeKey);
  if (candidates.length !== 1) {
    registry.close();
    throw new SessionAuthorityError(
      'SESSION_AUTHORITY_REQUIRED',
      candidates.length === 0
        ? 'no live session matches this canonical worktree'
        : 'multiple live sessions match this worktree; set RN_DEV_AGENT_SESSION_ID',
    );
  }
  const status = candidates[0]!;
  if (
    explicit &&
    (status.worktreeKey !== source.worktreeKey || status.appRootKey !== source.appRootKey)
  ) {
    registry.close();
    throw new SessionAuthorityError(
      'SESSION_AUTHORITY_REQUIRED',
      'explicit session belongs to a different canonical worktree or app root',
    );
  }
  return Object.assign(status, {
    closeRegistry: () => registry.close(),
    registry,
    layout,
  });
}

function readSigner(status: ReturnType<typeof resolveStatus>): string {
  const secret = JSON.parse(
    readFileSync(join(status.layout.sessions, status.sessionId, 'secret.json'), 'utf8'),
  ) as { signerCapability?: unknown };
  if (typeof secret.signerCapability !== 'string') {
    throw new SessionAuthorityError(
      'SESSION_AUTHORITY_REQUIRED',
      'session build signer is unavailable',
    );
  }
  return secret.signerCapability;
}

function beginCliOperation(
  status: ReturnType<typeof resolveStatus>,
  tool: string,
  profile: string,
): OperationRef {
  const operation = status.registry.beginOperation(
    { sessionId: status.sessionId, claimEpoch: status.claimEpoch },
    { operationId: randomUUID(), tool, profile },
  );
  if (operation.authorityVersion !== status.authorityVersion) {
    status.registry.cancelOperation(operation);
    throw new SessionAuthorityError(
      'AUTHORITY_LOST_DURING_OPERATION',
      'session authority changed before CLI operation reservation',
    );
  }
  return operation;
}

function writeMarker(
  status: ReturnType<typeof resolveStatus>,
  input: {
    platform: 'ios' | 'android';
    appId: string;
    metroInstanceId: string;
    buildGeneration: number;
    signerCapability: string;
  },
): void {
  const appRoot = String(status.source.appRoot);
  const marker = buildSignedMetroMarker(
    {
      sessionId: status.sessionId,
      metroInstanceId: input.metroInstanceId,
      worktreeKey: status.worktreeKey,
      appId: input.appId,
      platform: input.platform,
      buildGeneration: input.buildGeneration,
    },
    input.signerCapability,
  );
  const agent = openBoundDirectory(join(appRoot, '.rn-agent'));
  let integration: BoundDirectory | undefined;
  let primaryError: unknown;
  try {
    integration = openBoundSubdirectory(agent, 'integration');
    writeBoundDirectoryFile(
      integration,
      'authority-marker.js',
      Buffer.from(createMetroAuthorityModule(marker)),
      0o600,
    );
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    closeBoundDirectories([integration, agent], primaryError);
  }
}

async function ensureManagedMetro(status: ReturnType<typeof resolveStatus>): Promise<void> {
  const device = status.bindings.device as
    | { platform?: unknown; deviceId?: unknown; appId?: unknown }
    | undefined;
  if (
    (device?.platform !== 'ios' && device?.platform !== 'android') ||
    typeof device.appId !== 'string'
  ) {
    throw new SessionAuthorityError(
      'SESSION_AUTHORITY_REQUIRED',
      'an exact device/app binding is required before managed Metro starts',
    );
  }
  if (!inspectAuthorityMigration(status).packageIntegration.installed) {
    throw new SessionAuthorityError(
      'BUNDLE_HANDSHAKE_UNAVAILABLE',
      'session package and Metro integration must be applied before managed Metro starts',
    );
  }
  const existing = status.bindings.metro as Partial<ManagedMetroBinding> | undefined;
  if (
    typeof existing?.pid === 'number' &&
    typeof existing.port === 'number' &&
    typeof existing.instanceId === 'string' &&
    typeof existing.buildGeneration === 'number'
  ) {
    try {
      await captureMetroBinding({
        port: existing.port,
        pid: existing.pid,
        instanceId: existing.instanceId,
        sourceRoot: String(status.source.contentRoot),
        buildGeneration: existing.buildGeneration,
      });
      return;
    } catch {
      const signer = readSigner(status);
      if (
        !(await stopManagedMetro(existing, {
          sessionId: status.sessionId,
          signerCapability: signer,
        }))
      ) {
        throw new SessionAuthorityError(
          'METRO_AUTHORITY_MISMATCH',
          'existing external Metro binding is stale and cannot be replaced automatically',
        );
      }
      status.registry.updateBindings(
        { sessionId: status.sessionId, claimEpoch: status.claimEpoch },
        { bindings: { metro: null, bundle: null } },
      );
    }
  }

  const signerCapability = readSigner(status);
  const instanceId = randomUUID();
  const buildGeneration =
    Math.max(
      Number(existing?.buildGeneration ?? 0),
      Number(
        (status.bindings.install as Record<string, unknown> | undefined)?.buildGeneration ?? 0,
      ),
    ) + 1;
  writeMarker(status, {
    platform: device.platform,
    appId: device.appId,
    metroInstanceId: instanceId,
    buildGeneration,
    signerCapability,
  });
  const binding = await startManagedMetro({
    appRoot: String(status.source.appRoot),
    runtimeRoot: sessionRuntimeDirectory(status.layout, status.sessionId),
    sourceRoot: String(status.source.contentRoot),
    sessionId: status.sessionId,
    port: Number(status.bindings.metroPort),
    instanceId,
    buildGeneration,
    signerCapability,
  });
  status.registry.updateBindings(
    { sessionId: status.sessionId, claimEpoch: status.claimEpoch },
    {
      state: 'device_claimed',
      bindings: { metro: binding, bundle: null },
    },
  );
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'status';
  const status = resolveStatus();
  try {
    if (command === 'status') {
      process.stdout.write(
        `${JSON.stringify(projectPublicAuthorityStatus({ available: true, ...status }), null, 2)}\n`,
      );
      return;
    }
    if (command === 'feedback-json') {
      process.stdout.write(
        `${JSON.stringify({
          sessionAvailable: true,
          authorityState: status.state,
          ownMetroAllocated: Number.isSafeInteger(Number(status.bindings.metroPort)),
          ownMetroBound: Boolean(status.bindings.metro),
          foreignSessionCount: status.registry.countOtherOperationalSessions(status.sessionId),
        })}\n`,
      );
      return;
    }
    if (command === 'build-json') {
      const device = status.bindings.device as
        | {
            platform?: unknown;
            deviceId?: unknown;
            appId?: unknown;
            devClientUrl?: unknown;
          }
        | undefined;
      const metroPort = Number(status.bindings.metroPort);
      if (
        (device?.platform !== 'ios' && device?.platform !== 'android') ||
        typeof device.deviceId !== 'string' ||
        typeof device.appId !== 'string' ||
        !Number.isSafeInteger(metroPort)
      ) {
        throw new SessionAuthorityError(
          'SESSION_AUTHORITY_REQUIRED',
          'device and allocated Metro port must be bound before a session build',
        );
      }
      process.stdout.write(
        `${JSON.stringify({
          platform: device.platform,
          deviceId: device.deviceId,
          appId: device.appId,
          metroPort,
          sessionId: status.sessionId,
        })}\n`,
      );
      return;
    }
    if (command === 'ensure-metro') {
      await ensureManagedMetro(status);
      const current = status.registry.getSessionStatus(status.sessionId);
      process.stdout.write(
        `${JSON.stringify({
          metroBound: true,
          metroPort: current?.bindings.metroPort,
        })}\n`,
      );
      return;
    }
    if (command === 'prepare-build') {
      const platform = process.argv[3];
      const device = status.bindings.device as
        | {
            platform?: unknown;
            deviceId?: unknown;
            appId?: unknown;
            devClientUrl?: unknown;
          }
        | undefined;
      const metro = status.bindings.metro as
        | { instanceId?: unknown; buildGeneration?: unknown }
        | undefined;
      if (
        (platform !== 'ios' && platform !== 'android') ||
        device?.platform !== platform ||
        typeof device.deviceId !== 'string' ||
        typeof device.appId !== 'string' ||
        typeof metro?.instanceId !== 'string'
      ) {
        throw new SessionAuthorityError(
          'SESSION_AUTHORITY_REQUIRED',
          'an exact device/app and live Metro binding are required before build',
        );
      }
      const appId = device.appId;
      const metroInstanceId = metro.instanceId;
      const signerCapability = readSigner(status);
      const buildGeneration =
        Math.max(
          Number(metro.buildGeneration ?? 0),
          Number(
            (status.bindings.install as Record<string, unknown> | undefined)?.buildGeneration ?? 0,
          ),
        ) + 1;
      const buildToken = randomUUID();
      const runner = status.bindings.runner as Record<string, unknown> | null | undefined;
      const releaseResources: Array<{ type: string; key: string }> = [];
      if (runner) {
        const claimKey = `${String(runner.platform)}:${String(runner.deviceId)}:${String(
          runner.port,
        )}`;
        if (
          !status.claims.some(
            (claim) =>
              claim.type === 'runner' &&
              claim.key === claimKey &&
              claim.sessionId === status.sessionId &&
              claim.claimEpoch === status.claimEpoch,
          )
        ) {
          throw new SessionAuthorityError(
            'RUNNER_OWNERSHIP_MISMATCH',
            'runner cleanup claim no longer matches the authenticated binding',
          );
        }
        releaseResources.push({ type: 'runner', key: claimKey });
      }
      const operation = beginCliOperation(
        status,
        'rn-session prepare-build',
        'transition:prepare-build',
      );
      let currentOperation = operation;
      try {
        await status.registry.runWithOperation(operation, async () => {
          if (runner) {
            await stopBoundRunner(runner);
            status.registry.verifyOperation(operation);
          }
          writeMarker(status, {
            platform,
            appId,
            metroInstanceId,
            buildGeneration,
            signerCapability,
          });
          status.registry.verifyOperation(operation);
          currentOperation = status.registry.replaceBindingsDuringOperation(operation, {
            releaseResources,
            bindings: {
              metro: { ...metro, buildGeneration },
              pendingBuild: { buildToken, platform, buildGeneration },
              bundle: null,
              runner: null,
            },
          });
        });
        status.registry.endOperation(currentOperation);
      } catch (error) {
        status.registry.cancelOperation(currentOperation);
        throw error;
      }
      process.stdout.write(
        `${JSON.stringify({
          platform,
          deviceId: device.deviceId,
          appId: device.appId,
          metroPort: Number(status.bindings.metroPort),
          sessionId: status.sessionId,
          buildToken,
        })}\n`,
      );
      return;
    }
    if (command === 'complete-build') {
      const platform = process.argv[3];
      const buildToken = process.argv[4];
      const device = status.bindings.device as
        | {
            platform?: unknown;
            deviceId?: unknown;
            appId?: unknown;
            devClientUrl?: unknown;
          }
        | undefined;
      if (
        (platform !== 'ios' && platform !== 'android') ||
        device?.platform !== platform ||
        typeof device.deviceId !== 'string' ||
        typeof device.appId !== 'string' ||
        typeof buildToken !== 'string'
      ) {
        throw new SessionAuthorityError(
          'SESSION_BUILD_IDENTITY_CONFLICT',
          'completed build does not match the exact claimed device and app',
        );
      }
      const pending = status.bindings.pendingBuild as
        | { buildToken?: unknown; platform?: unknown; buildGeneration?: unknown }
        | undefined;
      if (
        pending?.buildToken !== buildToken ||
        pending.platform !== platform ||
        !Number.isSafeInteger(pending.buildGeneration)
      ) {
        throw new SessionAuthorityError(
          'SESSION_BUILD_IDENTITY_CONFLICT',
          'build completion capability is stale or foreign',
        );
      }
      const signerCapability = readSigner(status);
      const installed = captureInstalledArtifact({
        platform,
        deviceId: device.deviceId,
        appId: device.appId,
      });
      const receipt = createBuildReceipt(
        {
          sessionId: status.sessionId,
          sourceKey: status.sourceKey,
          worktreeKey: status.worktreeKey,
          appRootKey: status.appRootKey,
          platform,
          deviceId: device.deviceId,
          appId: device.appId,
          metroPort: Number(status.bindings.metroPort),
          artifactDigest: installed.artifactDigest,
          installGeneration: installed.installGeneration,
          buildGeneration: Number(pending.buildGeneration),
          ...(typeof device.devClientUrl === 'string' ? { devClientUrl: device.devClientUrl } : {}),
        },
        signerCapability,
      );
      status.registry.claimResources(
        { sessionId: status.sessionId, claimEpoch: status.claimEpoch },
        [{ type: 'device', key: `${platform}:${device.deviceId}` }],
      );
      status.registry.updateBindings(
        { sessionId: status.sessionId, claimEpoch: status.claimEpoch },
        {
          expectedAuthorityVersion: status.authorityVersion + 1,
          state: 'device_bound',
          bindings: { install: receipt.payload, pendingBuild: null },
        },
      );
      process.stdout.write(`${JSON.stringify(receipt)}\n`);
      return;
    }
    if (command === 'release') {
      const epoch = Number(process.env.RN_DEV_AGENT_CLAIM_EPOCH);
      if (process.env.RN_DEV_AGENT_SESSION_ID !== status.sessionId || epoch !== status.claimEpoch) {
        throw new SessionAuthorityError(
          'SESSION_AUTHORITY_REQUIRED',
          'release requires the exact session ID and claim epoch in the environment',
        );
      }
      const signerCapability = readSigner(status);
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
              claim.sessionId === status.sessionId &&
              claim.claimEpoch === status.claimEpoch,
          )
        ) {
          throw new SessionAuthorityError(
            'RUNNER_OWNERSHIP_MISMATCH',
            'runner cleanup claim no longer matches the authenticated binding',
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
              claim.sessionId === status.sessionId &&
              claim.claimEpoch === status.claimEpoch,
          )
        ) {
          throw new SessionAuthorityError(
            'OBSERVE_AUTHORITY_MISMATCH',
            'Observe cleanup claim no longer matches the authenticated binding',
          );
        }
      }
      const metro = status.bindings.metro as Partial<ManagedMetroBinding> | undefined;
      const operation = beginCliOperation(status, 'rn-session release', 'transition:release');
      let released = false;
      try {
        await status.registry.runWithOperation(operation, async () => {
          if (runner) {
            await stopBoundRunner(runner);
            status.registry.verifyOperation(operation);
          }
          if (observe) {
            await stopBoundObserve(observe);
            status.registry.verifyOperation(operation);
          }
          if (
            metro?.mode === 'managed' &&
            !(await stopManagedMetro(metro, {
              sessionId: status.sessionId,
              signerCapability,
            }))
          ) {
            throw new SessionAuthorityError(
              'METRO_AUTHORITY_MISMATCH',
              'managed Metro could not be stopped with exact process authority',
            );
          }
          status.registry.verifyOperation(operation);
          status.registry.releaseSession({ sessionId: status.sessionId, claimEpoch: epoch });
          released = true;
        });
      } finally {
        if (!released) status.registry.cancelOperation(operation);
      }
      process.stdout.write(`${JSON.stringify({ released: true })}\n`);
      return;
    }
    throw new SessionAuthorityError(
      'SESSION_BUILD_COMMAND_UNSUPPORTED',
      `unknown rn-session command: ${command}`,
    );
  } finally {
    status.closeRegistry();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
});
