#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createBuildReceipt } from './session/build-receipt.js';
import { captureInstalledArtifact } from './session/install-authority.js';
import {
  createMetroAuthorityMarker,
  createMetroAuthorityModule,
} from './session/metro-authority.js';
import { captureMetroBinding } from './session/metro-binding.js';
import {
  startManagedMetro,
  stopManagedMetro,
  type ManagedMetroBinding,
} from './session/managed-metro.js';
import { inspectSessionOwner } from './session/process-owner.js';
import { openSessionRegistry, SessionAuthorityError } from './session/registry.js';
import { resolveSourceIdentity } from './session/source-identity.js';
import { createAuthorityStateLayout, sessionRuntimeDirectory } from './session/state-root.js';
import { inspectAuthorityMigration } from './session/migration-diagnostic.js';

function redact(status: ReturnType<typeof resolveStatus>) {
  return {
    sessionId: status.sessionId.slice(0, 12),
    claimEpoch: status.claimEpoch,
    state: status.state,
    authorityVersion: status.authorityVersion,
    sourceKind: status.source.kind,
    metroPort: status.bindings.metroPort,
    observePort: status.bindings.observePort,
    platform: (status.bindings.device as Record<string, unknown> | undefined)?.platform,
    deviceBound: Boolean(status.bindings.device),
    installBound: Boolean(status.bindings.install),
    metroBound: Boolean(status.bindings.metro),
    bundleBound: Boolean(status.bindings.bundle),
    runnerBound: Boolean(status.bindings.runner),
    migration: inspectAuthorityMigration(status),
  };
}

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
  const marker = createMetroAuthorityMarker(
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
  const markerPath = join(
    String(status.source.appRoot),
    '.rn-agent',
    'integration',
    'authority-marker.js',
  );
  const temporary = `${markerPath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, createMetroAuthorityModule(marker), {
    encoding: 'utf8',
    mode: 0o600,
  });
  chmodSync(temporary, 0o600);
  renameSync(temporary, markerPath);
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
      if (!stopManagedMetro(existing, { sessionId: status.sessionId, signerCapability: signer })) {
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
      process.stdout.write(`${JSON.stringify(redact(status), null, 2)}\n`);
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
      const signerCapability = readSigner(status);
      const buildGeneration =
        Math.max(
          Number(metro.buildGeneration ?? 0),
          Number(
            (status.bindings.install as Record<string, unknown> | undefined)?.buildGeneration ?? 0,
          ),
        ) + 1;
      const buildToken = randomUUID();
      writeMarker(status, {
        platform,
        appId: device.appId,
        metroInstanceId: metro.instanceId,
        buildGeneration,
        signerCapability,
      });
      status.registry.updateBindings(
        { sessionId: status.sessionId, claimEpoch: status.claimEpoch },
        {
          bindings: {
            metro: { ...metro, buildGeneration },
            pendingBuild: { buildToken, platform, buildGeneration },
            bundle: null,
            runner: null,
          },
        },
      );
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
      stopManagedMetro(status.bindings.metro as Partial<ManagedMetroBinding> | undefined, {
        sessionId: status.sessionId,
        signerCapability,
      });
      status.registry.releaseSession({ sessionId: status.sessionId, claimEpoch: epoch });
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
