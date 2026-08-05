/**
 * Move an exact installed Expo Dev Client to its launcher without product URL
 * or ambient target selection. Metro is proven stopped before the URL-free
 * launch, and the installed bytes must remain identical across the operation.
 */
export async function parkExactDevClientAtPicker(identity, dependencies) {
    const before = dependencies.captureInstalled(identity);
    await dependencies.terminate(identity);
    dependencies.checkpoint();
    if (!(await dependencies.stopManagedMetro())) {
        throw new Error('METRO_AUTHORITY_MISMATCH: managed Metro could not be stopped before Dev Client picker reset');
    }
    dependencies.checkpoint();
    dependencies.publishMetroStopped();
    await dependencies.launchWithoutUrl(identity);
    dependencies.checkpoint();
    const after = dependencies.captureInstalled(identity);
    if (after.artifactDigest !== before.artifactDigest ||
        after.installGeneration !== before.installGeneration) {
        throw new Error('APP_INSTALL_IDENTITY_CHANGED: installed app changed during picker reset');
    }
}
