export interface DevClientPickerIdentity {
  platform: 'ios' | 'android';
  deviceId: string;
  appId: string;
}

interface InstalledArtifactIdentity {
  artifactDigest: string;
  installGeneration: string;
}

interface DevClientPickerLifecycleDependencies {
  captureInstalled(input: DevClientPickerIdentity): InstalledArtifactIdentity;
  terminate(input: DevClientPickerIdentity): Promise<void>;
  stopManagedMetro(): Promise<boolean>;
  publishMetroStopped(): void;
  launchWithoutUrl(input: DevClientPickerIdentity): Promise<void>;
  checkpoint(): void;
}

/**
 * Move an exact installed Expo Dev Client to its launcher without product URL
 * or ambient target selection. Metro is proven stopped before the URL-free
 * launch, and the installed bytes must remain identical across the operation.
 */
export async function parkExactDevClientAtPicker(
  identity: DevClientPickerIdentity,
  dependencies: DevClientPickerLifecycleDependencies,
): Promise<void> {
  const before = dependencies.captureInstalled(identity);
  await dependencies.terminate(identity);
  dependencies.checkpoint();
  if (!(await dependencies.stopManagedMetro())) {
    throw new Error(
      'METRO_AUTHORITY_MISMATCH: managed Metro could not be stopped before Dev Client picker reset',
    );
  }
  dependencies.checkpoint();
  dependencies.publishMetroStopped();
  await dependencies.launchWithoutUrl(identity);
  dependencies.checkpoint();
  const after = dependencies.captureInstalled(identity);
  if (
    after.artifactDigest !== before.artifactDigest ||
    after.installGeneration !== before.installGeneration
  ) {
    throw new Error('APP_INSTALL_IDENTITY_CHANGED: installed app changed during picker reset');
  }
}
