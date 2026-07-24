import type { MetroAuthorityBinding, MetroAuthorityMarker } from './metro-authority.js';
import { verifyMetroAuthorityMarker } from './metro-authority.js';

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

export interface BundleAuthorityBinding extends MetroAuthorityBinding {
  deviceId: string;
  metroPort: number;
  devClientUrl?: string;
  launchMethod: 'url' | 'app';
  targetId: string;
  connectionGeneration: number;
  authorityScope: 'initial-bundle';
  sourceFidelity: 'not-proven';
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
    targetId: connected.targetId,
    connectionGeneration: connected.connectionGeneration,
    authorityScope: 'initial-bundle',
    sourceFidelity: 'not-proven',
  };
}
