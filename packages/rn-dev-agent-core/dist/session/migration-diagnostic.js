import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { closeBoundDirectories, openBoundDirectory, openBoundSubdirectory, readBoundDirectoryFiles, } from './bound-directory.js';
import { AUTHORITY_REGISTRY_SCHEMA_VERSION } from './registry.js';
function readPackageIntegrationManifest(appRoot, dependencies) {
    const manifestPath = join(appRoot, '.rn-agent', 'integration', 'rn-session-integration.json');
    if (dependencies.exists || dependencies.readText) {
        const exists = dependencies.exists ?? existsSync;
        if (!exists(manifestPath))
            return undefined;
        const readText = dependencies.readText ?? ((path) => readFileSync(path, 'utf8'));
        return readText(manifestPath);
    }
    const agent = openBoundDirectory(join(appRoot, '.rn-agent'));
    let integration;
    let primaryError;
    try {
        integration = openBoundSubdirectory(agent, 'integration');
        const [manifest] = readBoundDirectoryFiles(integration, ['rn-session-integration.json']);
        return manifest?.contents?.toString('utf8');
    }
    catch (error) {
        if (error instanceof Error &&
            error.message.includes('SESSION_INTEGRATION_PATH_UNSAFE') &&
            error.message.includes('ENOENT') &&
            error.message.includes("lstat 'integration'")) {
            return undefined;
        }
        primaryError = error;
        throw error;
    }
    finally {
        closeBoundDirectories([integration, agent], primaryError);
    }
}
export function inspectAuthorityMigration(status, dependencies = {}) {
    const exists = dependencies.exists ?? existsSync;
    const appRoot = typeof status.source.appRoot === 'string' ? status.source.appRoot : '';
    let packageIntegrationInstalled = false;
    let onDiskManifestText;
    if (appRoot) {
        try {
            onDiskManifestText = readPackageIntegrationManifest(appRoot, dependencies);
            const manifest = onDiskManifestText
                ? JSON.parse(onDiskManifestText)
                : undefined;
            packageIntegrationInstalled = manifest?.version === 1;
        }
        catch (error) {
            if (error instanceof Error &&
                error.message.includes('SESSION_INTEGRATION_PATH_UNSAFE') &&
                !error.message.includes('ancestor is unavailable')) {
                throw error;
            }
            packageIntegrationInstalled = false;
        }
    }
    const integrationBinding = status.bindings.packageIntegration;
    let bindingDiagnostic = null;
    if (integrationBinding) {
        const manifestVerified = (candidate) => typeof candidate === 'string' &&
            typeof integrationBinding.manifestSha256 === 'string' &&
            createHash('sha256').update(candidate).digest('hex') === integrationBinding.manifestSha256;
        const manifestAvailable = manifestVerified(onDiskManifestText) ||
            manifestVerified(integrationBinding.restoration?.phase === 'started'
                ? integrationBinding.restoration.manifestSource
                : undefined) ||
            manifestVerified(integrationBinding.installation?.phase === 'started'
                ? integrationBinding.installation.manifestSource
                : undefined) ||
            manifestVerified(integrationBinding.manifestSource);
        const effectiveOwnerSessionId = status.sessionId;
        const trustedDigestRecorded = typeof integrationBinding.manifestSha256 === 'string' &&
            /^[0-9a-f]{64}$/.test(integrationBinding.manifestSha256);
        bindingDiagnostic = {
            installedBySessionId: typeof integrationBinding.installedBySessionId === 'string'
                ? integrationBinding.installedBySessionId
                : null,
            effectiveOwnerSessionId,
            ownedByThisSession: effectiveOwnerSessionId === status.sessionId,
            manifestAvailable,
            nextAction: manifestAvailable
                ? 'Run restore_integration with confirmed=true to restore canonical files before release.'
                : trustedDigestRecorded
                    ? 'Recover the SHA-256-authorized integration manifest from trusted version control history or backups, then retry restore_integration with confirmed=true.'
                    : 'No trusted manifest digest is recorded for this binding; operator recovery from a trusted session-state-plus-manifest backup is required while the restoration fence remains.',
        };
    }
    const legacyStateDetected = [
        '/tmp/rn-dev-agent-session.json',
        '/tmp/rn-fast-runner-state.json',
        '/tmp/rn-android-runner-state.json',
    ].some(exists);
    return {
        rollout: 'strict-default',
        storeAvailable: true,
        registrySchema: AUTHORITY_REGISTRY_SCHEMA_VERSION,
        legacyStateDetected,
        bundleHandshake: {
            supported: true,
            scope: 'coarse-initial-bundle',
            bound: Boolean(status.bindings.bundle),
            sourceFidelity: 'not-proven',
        },
        packageIntegration: {
            supported: true,
            installed: packageIntegrationInstalled,
            binding: bindingDiagnostic,
        },
        strictEnforcement: true,
    };
}
