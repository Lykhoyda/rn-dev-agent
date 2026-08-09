import { captureInstalledArtifact, captureInstallGeneration } from './install-authority.js';
function isInstallPlatform(value) {
    return value === 'ios' || value === 'android';
}
// Status-surface truth for axis I: 'verified' and 'reissue-pending' mean gated
// tools will succeed (the gate re-issues behind the GH #705 digest proof);
// 'changed' means they will refuse APP_INSTALL_IDENTITY_CHANGED.
export function inspectInstallIdentity(install, dependencies = {}) {
    if (!install)
        return null;
    const rawPlatform = install.platform;
    const platform = isInstallPlatform(rawPlatform) ? rawPlatform : null;
    const deviceId = install.deviceId;
    const appId = install.appId;
    const artifactDigest = install.artifactDigest;
    const installGeneration = install.installGeneration;
    if (!platform ||
        typeof deviceId !== 'string' ||
        typeof appId !== 'string' ||
        typeof artifactDigest !== 'string' ||
        typeof installGeneration !== 'string') {
        return { verdict: 'changed', reason: 'the bound install receipt is not attestable' };
    }
    const target = { platform, deviceId, appId };
    try {
        if ((dependencies.captureGeneration ?? captureInstallGeneration)(target) === installGeneration) {
            return { verdict: 'verified' };
        }
    }
    catch {
        return { verdict: 'changed', reason: 'the installed artifact could not be attested' };
    }
    try {
        const observed = (dependencies.captureInstalled ?? captureInstalledArtifact)(target);
        if (observed.artifactDigest === artifactDigest)
            return { verdict: 'reissue-pending' };
        return {
            verdict: 'changed',
            reason: 'the installed artifact is not the attested session build',
        };
    }
    catch {
        return { verdict: 'changed', reason: 'the installed artifact could not be attested' };
    }
}
