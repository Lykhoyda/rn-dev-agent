import { captureInstalledArtifact } from './install-authority.js';

export interface ManagedMetroRestartDependencies {
  captureInstalled?: typeof captureInstalledArtifact;
}

export interface ManagedMetroRestartInput {
  session: {
    sessionId: string;
    sourceKey: string;
    worktreeKey: string;
    appRootKey: string;
    metroPort: number;
  };
  device: { platform: 'ios' | 'android'; deviceId: string; appId: string };
  install: Record<string, unknown> | null | undefined;
  fallbackGeneration: number;
}

export type ManagedMetroRestartReason =
  | 'preserved'
  | 'no-install-receipt'
  | 'receipt-axis-mismatch'
  | 'install-capture-failed'
  | 'installed-artifact-changed';

export interface ManagedMetroRestartGeneration {
  buildGeneration: number;
  receiptPreserved: boolean;
  reason: ManagedMetroRestartReason;
}

// A managed Metro restart is not a native rebuild: when the bound signed
// install receipt still matches every session axis AND the installed bytes
// re-prove on-device, the new instance keeps the receipt's generation so
// pin_dev_client provenance stays coherent. The fresh signed metroInstanceId
// still refuses stale or foreign origins; any mismatch falls back to the
// bumped generation, which keeps the pin gate refusing fail-closed.
export function resolveManagedMetroRestartGeneration(
  input: ManagedMetroRestartInput,
  dependencies: ManagedMetroRestartDependencies = {},
): ManagedMetroRestartGeneration {
  const fallback = (reason: ManagedMetroRestartReason): ManagedMetroRestartGeneration => ({
    buildGeneration: input.fallbackGeneration,
    receiptPreserved: false,
    reason,
  });
  const install = input.install;
  if (!install) return fallback('no-install-receipt');
  const generation = install.buildGeneration;
  if (
    install.sessionId !== input.session.sessionId ||
    install.sourceKey !== input.session.sourceKey ||
    install.worktreeKey !== input.session.worktreeKey ||
    install.appRootKey !== input.session.appRootKey ||
    install.platform !== input.device.platform ||
    install.deviceId !== input.device.deviceId ||
    install.appId !== input.device.appId ||
    install.metroPort !== input.session.metroPort ||
    (install.buildKind !== 'expo' && install.buildKind !== 'bare-react-native') ||
    typeof install.artifactDigest !== 'string' ||
    install.artifactDigest === '' ||
    typeof install.installGeneration !== 'string' ||
    install.installGeneration === '' ||
    !Number.isSafeInteger(generation) ||
    Number(generation) < 1
  ) {
    return fallback('receipt-axis-mismatch');
  }
  let observed;
  try {
    observed = (dependencies.captureInstalled ?? captureInstalledArtifact)({
      platform: input.device.platform,
      deviceId: input.device.deviceId,
      appId: input.device.appId,
    });
  } catch {
    return fallback('install-capture-failed');
  }
  if (
    observed.artifactDigest !== install.artifactDigest ||
    observed.installGeneration !== install.installGeneration
  ) {
    return fallback('installed-artifact-changed');
  }
  return { buildGeneration: Number(generation), receiptPreserved: true, reason: 'preserved' };
}
