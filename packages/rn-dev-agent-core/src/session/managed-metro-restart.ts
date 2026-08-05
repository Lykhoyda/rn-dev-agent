interface InstalledArtifactIdentity {
  artifactDigest: string;
  installGeneration: string;
}

interface ManagedMetroRestartInput {
  session: {
    sessionId: string;
    sourceKey: string;
    worktreeKey: string;
    appRootKey: string;
    metroPort: number;
  };
  device: {
    platform: 'ios' | 'android';
    deviceId: string;
    appId: string;
  };
  install?: Record<string, unknown> | null;
  pendingBuild?: Record<string, unknown> | null;
  priorGenerations: readonly unknown[];
  captureInstalled(): InstalledArtifactIdentity;
}

function receiptError(message: string): Error {
  const error = new Error(`BUILD_RECEIPT_INVALID: ${message}`) as Error & { code: string };
  error.code = 'BUILD_RECEIPT_INVALID';
  return error;
}

/**
 * A Metro restart is not a native rebuild. When an exact install receipt is
 * present, preserve its build generation after re-proving the installed bytes;
 * the new signed Metro instance ID still prevents stale origin admission.
 */
export function resolveManagedMetroRestartGeneration(input: ManagedMetroRestartInput): number {
  if (!input.install) {
    if (input.pendingBuild) {
      const generation = input.pendingBuild.buildGeneration;
      if (
        input.pendingBuild.platform !== input.device.platform ||
        (input.pendingBuild.buildKind !== 'expo' &&
          input.pendingBuild.buildKind !== 'bare-react-native') ||
        !Number.isSafeInteger(generation) ||
        Number(generation) < 1
      ) {
        throw receiptError('pending build provenance is unavailable for managed Metro restart');
      }
      return Number(generation);
    }
    return (
      Math.max(
        0,
        ...input.priorGenerations.map((generation) =>
          Number.isSafeInteger(generation) ? Number(generation) : 0,
        ),
      ) + 1
    );
  }

  const install = input.install;
  const buildGeneration = install.buildGeneration;
  if (
    install.sessionId !== input.session.sessionId ||
    install.sourceKey !== input.session.sourceKey ||
    install.worktreeKey !== input.session.worktreeKey ||
    install.appRootKey !== input.session.appRootKey ||
    install.platform !== input.device.platform ||
    install.deviceId !== input.device.deviceId ||
    install.appId !== input.device.appId ||
    install.metroPort !== input.session.metroPort ||
    !Number.isSafeInteger(buildGeneration) ||
    Number(buildGeneration) < 1 ||
    (install.buildKind !== 'expo' && install.buildKind !== 'bare-react-native') ||
    typeof install.artifactDigest !== 'string' ||
    typeof install.installGeneration !== 'string'
  ) {
    throw receiptError('exact install provenance is unavailable for managed Metro restart');
  }

  const observed = input.captureInstalled();
  if (
    observed.artifactDigest !== install.artifactDigest ||
    observed.installGeneration !== install.installGeneration
  ) {
    throw receiptError('installed artifact changed before managed Metro restart');
  }
  return Number(buildGeneration);
}
