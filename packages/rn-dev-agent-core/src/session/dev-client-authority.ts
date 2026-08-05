import type { MetroAuthorityBinding, MetroAuthorityMarker } from './metro-authority.js';
import { verifyMetroAuthorityMarker } from './metro-authority.js';
import type { SessionStatus } from './registry.js';
import type { ToolErrorCode } from '../types.js';

interface PinDevClientInput extends MetroAuthorityBinding {
  deviceId: string;
  metroPort: number;
  devClientUrl?: string;
  expectedDevClientUrl?: string;
  signerCapability: string;
}

interface PinDevClientDependencies {
  openUrl(platform: 'ios' | 'android', deviceId: string, url: string, appId: string): Promise<void>;
  launchExactApp(platform: 'ios' | 'android', deviceId: string, appId: string): Promise<void>;
  acceptIosOpenDialog(deviceId: string): Promise<void>;
  connectExact(input: {
    metroPort: number;
    platform: 'ios' | 'android';
    appId: string;
    deviceId: string;
  }): Promise<{ targetId: string; connectionGeneration: number; deviceId: string }>;
  readMarker(): Promise<{ status: 'signed'; marker: MetroAuthorityMarker } | null>;
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
  if (
    typeof request.targetId === 'string' &&
    (typeof bundle?.targetId !== 'string' || request.targetId !== bundle.targetId)
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
  if (input.devClientUrl !== input.expectedDevClientUrl) {
    throw new Error(
      'DEV_CLIENT_ENDPOINT_NOT_FOUND: declared dev-client URL does not match the session endpoint',
    );
  }
  if (input.devClientUrl) {
    await dependencies.openUrl(input.platform, input.deviceId, input.devClientUrl, input.appId);
    if (input.platform === 'ios') await dependencies.acceptIosOpenDialog(input.deviceId);
  } else {
    await dependencies.launchExactApp(input.platform, input.deviceId, input.appId);
  }
  const connected = await dependencies.connectExact({
    metroPort: input.metroPort,
    platform: input.platform,
    appId: input.appId,
    deviceId: input.deviceId,
  });
  if (connected.deviceId !== input.deviceId) {
    throw new Error(
      'CDP_TARGET_AUTHORITY_MISMATCH: selected target is not proven on the claimed device',
    );
  }
  const authority = await dependencies.readMarker();
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
  return buildBundleAuthorityBinding({
    ...input,
    deviceId: input.deviceId,
    metroPort: input.metroPort,
    ...(input.devClientUrl ? { devClientUrl: input.devClientUrl } : {}),
    targetId: connected.targetId,
    connectionGeneration: connected.connectionGeneration,
  });
}
