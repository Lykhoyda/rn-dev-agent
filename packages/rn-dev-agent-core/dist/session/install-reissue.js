import { captureInstalledArtifact } from './install-authority.js';
import { SessionAuthorityError } from './registry.js';
// GH #705: axis I pins the cheap installGeneration (inode/size/mtime), so a
// Maestro `clearState` reinstall of the SAME bytes still reads as a foreign
// install. Re-stamping the generation is only safe behind the expensive
// artifactDigest proof — a digest mismatch must stay a refusal.
export function reissueInstallBinding(install, dependencies = {}) {
    const platform = install?.platform;
    const deviceId = install?.deviceId;
    const appId = install?.appId;
    const artifactDigest = install?.artifactDigest;
    const installGeneration = install?.installGeneration;
    if ((platform !== 'ios' && platform !== 'android') ||
        typeof deviceId !== 'string' ||
        typeof appId !== 'string' ||
        typeof artifactDigest !== 'string' ||
        typeof installGeneration !== 'string') {
        throw new SessionAuthorityError('APP_INSTALL_IDENTITY_CHANGED', 'no attested install receipt is bound to re-issue after the reinstall');
    }
    let observed;
    try {
        observed = (dependencies.captureInstalled ?? captureInstalledArtifact)({
            platform,
            deviceId,
            appId,
        });
    }
    catch {
        throw new SessionAuthorityError('APP_INSTALL_IDENTITY_CHANGED', 'the reinstalled artifact could not be attested');
    }
    if (observed.artifactDigest !== artifactDigest) {
        throw new SessionAuthorityError('APP_INSTALL_IDENTITY_CHANGED', 'the reinstalled artifact is not the attested session build');
    }
    if (observed.installGeneration === installGeneration)
        return null;
    return { ...install, installGeneration: observed.installGeneration };
}
