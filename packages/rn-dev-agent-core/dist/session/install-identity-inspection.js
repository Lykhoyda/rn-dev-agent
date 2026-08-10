import { captureInstalledArtifact, captureInstallGeneration } from './install-authority.js';
function isInstallPlatform(value) {
    return value === 'ios' || value === 'android';
}
// Hashing the installed bundle reads every installed byte, and status surfaces
// are polled. The verdict is a pure function of the observed generation and the
// expected digest, so it is remembered until one of them rotates.
const DIGEST_VERDICT_CACHE_LIMIT = 32;
const digestVerdicts = new Map();
function digestVerdictKey(target, artifactDigest, observedGeneration) {
    return [target.platform, target.deviceId, target.appId, artifactDigest, observedGeneration].join(' ');
}
function rememberDigestVerdict(key, verdict) {
    if (digestVerdicts.size >= DIGEST_VERDICT_CACHE_LIMIT) {
        const oldest = digestVerdicts.keys().next();
        if (!oldest.done)
            digestVerdicts.delete(oldest.value);
    }
    digestVerdicts.set(key, verdict);
    return verdict;
}
export function resetInstallIdentityInspectionCache() {
    digestVerdicts.clear();
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
    let observedGeneration;
    try {
        observedGeneration = (dependencies.captureGeneration ?? captureInstallGeneration)(target);
    }
    catch {
        return { verdict: 'changed', reason: 'the installed artifact could not be attested' };
    }
    if (observedGeneration === installGeneration)
        return { verdict: 'verified' };
    const key = digestVerdictKey(target, artifactDigest, observedGeneration);
    const remembered = digestVerdicts.get(key);
    if (remembered)
        return remembered;
    try {
        const observed = (dependencies.captureInstalled ?? captureInstalledArtifact)(target);
        return rememberDigestVerdict(key, observed.artifactDigest === artifactDigest
            ? { verdict: 'reissue-pending' }
            : {
                verdict: 'changed',
                reason: 'the installed artifact is not the attested session build',
            });
    }
    catch {
        return rememberDigestVerdict(key, {
            verdict: 'changed',
            reason: 'the installed artifact could not be attested',
        });
    }
}
