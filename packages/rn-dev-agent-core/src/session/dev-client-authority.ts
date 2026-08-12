import { managedMetroProxyUrl } from './build-adapter.js';
import type { ManagedManifestResponse } from './expo-manifest.js';
import { verifyManagedManifestLaunchAsset } from './expo-manifest.js';
import type { MetroAuthorityBinding, MetroAuthorityMarker } from './metro-authority.js';
import { verifyMetroAuthorityMarker } from './metro-authority.js';
import type { SessionStatus } from './registry.js';
import type { ToolErrorCode } from '../types.js';
import type { ExactSessionTargetConnection } from './connect-exact-session-target.js';

interface PinDevClientInput extends MetroAuthorityBinding {
  deviceId: string;
  metroPort: number;
  devClientUrl?: string;
  expectedDevClientUrl?: string;
  runtimeKind: 'bare-react-native' | 'expo-dev-client';
  signerCapability: string;
}

type ExactConnectionSummary = Pick<
  ExactSessionTargetConnection,
  'targetId' | 'connectionGeneration' | 'deviceId'
>;

interface PinDevClientDependencies {
  openUrl(platform: 'ios' | 'android', deviceId: string, url: string, appId: string): Promise<void>;
  launchExactApp(platform: 'ios' | 'android', deviceId: string, appId: string): Promise<void>;
  launchExactAppWithInitialUrl(deviceId: string, appId: string, initialUrl: string): Promise<void>;
  acceptIosOpenDialog(deviceId: string): Promise<void>;
  connectExact(input: {
    metroPort: number;
    platform: 'ios' | 'android';
    appId: string;
    deviceId: string;
  }): Promise<ExactSessionTargetConnection | ExactConnectionSummary>;
  readMarker(
    connection: ExactSessionTargetConnection | ExactConnectionSummary,
  ): Promise<{ status: 'signed'; marker: MetroAuthorityMarker } | null>;
  commitBundle?(bundle: BundleAuthorityBinding, promotion: BundleAuthorityPromotion): void;
  readManagedManifest?(input: {
    host: string;
    metroPort: number;
    platform: 'ios' | 'android';
  }): Promise<ManagedManifestResponse>;
}

export interface BundleAuthorityBinding extends MetroAuthorityBinding, Record<string, unknown> {
  deviceId: string;
  metroPort: number;
  devClientUrl?: string;
  launchMethod: 'url' | 'app';
  targetId: string;
  connectionGeneration: number;
  authorityScope: 'initial-bundle';
  sourceFidelity: 'not-proven';
}

export interface BundleAuthorityPromotion {
  assertActive(): void;
  publish(): void;
}

interface AuthoritativeBundleStatus {
  authorityVersion: number;
  bindings: Record<string, unknown> & { bundle?: unknown; metroPort?: unknown };
}

interface AuthoritativeBundleCommit {
  expectedAuthorityVersion: number;
  state: 'ready';
  bindings: { bundle: Record<string, unknown> };
  releaseResources: Array<{ type: 'target'; key: string }>;
  claimResources: Array<{ type: 'target'; key: string }>;
}

export async function reconcileAuthoritativeBundle(
  status: AuthoritativeBundleStatus,
  dependencies: {
    verifyRuntime(): Promise<Record<string, unknown>>;
    hasActiveOperation(): boolean;
    commit(input: AuthoritativeBundleCommit): void;
  },
): Promise<void> {
  const prior = status.bindings.bundle as Record<string, unknown> | null | undefined;
  if (!prior) {
    throw new Error('BUNDLE_HANDSHAKE_UNAVAILABLE: durable bundle authority is unavailable');
  }
  const bundle = await dependencies.verifyRuntime();
  if (dependencies.hasActiveOperation()) return;
  const priorTargetId = String(prior.targetId);
  const nextTargetId = String(bundle.targetId);
  const metroPort = String(status.bindings.metroPort);
  dependencies.commit({
    expectedAuthorityVersion: status.authorityVersion,
    state: 'ready',
    bindings: { bundle },
    releaseResources:
      priorTargetId !== nextTargetId
        ? [{ type: 'target', key: `${metroPort}:${priorTargetId}` }]
        : [],
    claimResources:
      priorTargetId !== nextTargetId
        ? [{ type: 'target', key: `${metroPort}:${nextTargetId}` }]
        : [],
  });
}

export function buildBundleAuthorityBinding(
  input: MetroAuthorityBinding & {
    deviceId: string;
    metroPort: number;
    devClientUrl?: string;
    targetId: string;
    connectionGeneration: number;
  },
): BundleAuthorityBinding {
  return {
    sessionId: input.sessionId,
    metroInstanceId: input.metroInstanceId,
    worktreeKey: input.worktreeKey,
    appId: input.appId,
    platform: input.platform,
    buildGeneration: input.buildGeneration,
    deviceId: input.deviceId,
    metroPort: input.metroPort,
    ...(input.devClientUrl ? { devClientUrl: input.devClientUrl } : {}),
    launchMethod: input.devClientUrl ? 'url' : 'app',
    targetId: input.targetId,
    connectionGeneration: input.connectionGeneration,
    authorityScope: 'initial-bundle',
    sourceFidelity: 'not-proven',
  };
}

export function boundConnectConflict(
  status: Pick<SessionStatus, 'bindings'>,
  request: {
    metroPort?: unknown;
    platform?: unknown;
    targetId?: unknown;
    bundleId?: unknown;
  },
): { code: ToolErrorCode; message: string } | null {
  const device = status.bindings.device as
    | { platform?: unknown; appId?: unknown }
    | null
    | undefined;
  const bundle = status.bindings.bundle as { targetId?: unknown } | null | undefined;
  if (typeof request.metroPort === 'number' && request.metroPort !== status.bindings.metroPort) {
    return {
      code: 'METRO_AUTHORITY_MISMATCH',
      message: 'metroPort does not match the authority-bound Metro port',
    };
  }
  if (typeof request.platform === 'string' && request.platform.toLowerCase() !== device?.platform) {
    return {
      code: 'DEVICE_AUTHORITY_MISMATCH',
      message: 'platform does not match the authority-bound device',
    };
  }
  if (
    typeof request.bundleId === 'string' &&
    (typeof device?.appId !== 'string' ||
      request.bundleId.toLowerCase() !== device.appId.toLowerCase())
  ) {
    return {
      code: 'DEVICE_AUTHORITY_MISMATCH',
      message: 'bundleId does not match the authority-bound app',
    };
  }
  // GH #750: while B is unbound the pin flow proves the sole exact-device
  // target itself, so an advisory targetId must not dead-end the recovery.
  if (
    typeof request.targetId === 'string' &&
    bundle &&
    (typeof bundle.targetId !== 'string' || request.targetId !== bundle.targetId)
  ) {
    return {
      code: 'CDP_TARGET_AUTHORITY_MISMATCH',
      message: 'targetId is not the target already proven by this session',
    };
  }
  return null;
}

export async function pinExactDevClient(
  input: PinDevClientInput,
  dependencies: PinDevClientDependencies,
): Promise<BundleAuthorityBinding> {
  if (!Number.isSafeInteger(input.metroPort) || input.metroPort < 1 || input.metroPort > 65_535) {
    throw new Error('DEV_CLIENT_ENDPOINT_NOT_FOUND: authority-bound Metro port is unavailable');
  }
  const derivedIosExpoLaunchTarget =
    input.platform === 'ios' && input.runtimeKind === 'expo-dev-client'
      ? managedMetroProxyUrl(input)
      : undefined;
  if (input.devClientUrl !== input.expectedDevClientUrl) {
    throw new Error(
      'DEV_CLIENT_ENDPOINT_NOT_FOUND: declared dev-client URL does not match the session endpoint',
    );
  }
  if (input.runtimeKind === 'bare-react-native' && input.devClientUrl) {
    throw new Error(
      'DEV_CLIENT_ENDPOINT_NOT_FOUND: launch kind contradicts the signed build provenance',
    );
  }
  const managedManifestHost = '127.0.0.1';
  if (input.runtimeKind === 'expo-dev-client') {
    if (!dependencies.readManagedManifest) {
      throw new Error(
        'METRO_MANIFEST_ENDPOINT_MISMATCH: managed manifest verification is unavailable',
      );
    }
    const response = await dependencies.readManagedManifest({
      host: managedManifestHost,
      metroPort: input.metroPort,
      platform: input.platform,
    });
    verifyManagedManifestLaunchAsset(response, {
      host: managedManifestHost,
      port: input.metroPort,
    });
  }
  if (input.devClientUrl) {
    await dependencies.openUrl(input.platform, input.deviceId, input.devClientUrl, input.appId);
    if (input.platform === 'ios') await dependencies.acceptIosOpenDialog(input.deviceId);
  } else if (derivedIosExpoLaunchTarget) {
    await dependencies.launchExactAppWithInitialUrl(
      input.deviceId,
      input.appId,
      derivedIosExpoLaunchTarget,
    );
  } else {
    await dependencies.launchExactApp(input.platform, input.deviceId, input.appId);
  }
  const connected = await dependencies.connectExact({
    metroPort: input.metroPort,
    platform: input.platform,
    appId: input.appId,
    deviceId: input.deviceId,
  });
  try {
    if (connected.deviceId !== input.deviceId) {
      throw new Error(
        'CDP_TARGET_AUTHORITY_MISMATCH: selected target is not proven on the claimed device',
      );
    }
    const hasStagedLifecycle = 'run' in connected;
    const authority = await (hasStagedLifecycle
      ? connected.run(() => dependencies.readMarker(connected))
      : dependencies.readMarker(connected));
    if (!authority?.marker || authority.status !== 'signed') {
      throw new Error(
        'BUNDLE_HANDSHAKE_UNAVAILABLE: runtime did not expose a signed authority marker',
      );
    }
    verifyMetroAuthorityMarker(authority.marker, input.signerCapability, {
      sessionId: input.sessionId,
      metroInstanceId: input.metroInstanceId,
      worktreeKey: input.worktreeKey,
      appId: input.appId,
      platform: input.platform,
      buildGeneration: input.buildGeneration,
    });
    const bundle = buildBundleAuthorityBinding({
      ...input,
      deviceId: input.deviceId,
      metroPort: input.metroPort,
      ...(input.devClientUrl ? { devClientUrl: input.devClientUrl } : {}),
      targetId: connected.targetId,
      connectionGeneration: connected.connectionGeneration,
    });
    if (hasStagedLifecycle) {
      connected.assertActive();
      if (!dependencies.commitBundle) {
        throw new Error('BUNDLE_HANDSHAKE_UNAVAILABLE: atomic bundle commit is unavailable');
      }
      dependencies.commitBundle(bundle, {
        assertActive: connected.assertActive,
        publish: connected.publish,
      });
    }
    return bundle;
  } catch (error) {
    if ('cancel' in connected) connected.cancel();
    throw error;
  }
}
