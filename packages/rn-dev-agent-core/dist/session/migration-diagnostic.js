import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { closeBoundDirectory, openBoundDirectory, openBoundSubdirectory, readBoundDirectoryFiles, } from './bound-directory.js';
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
    try {
        const integration = openBoundSubdirectory(agent, 'integration');
        try {
            const [manifest] = readBoundDirectoryFiles(integration, ['rn-session-integration.json']);
            return manifest?.contents?.toString('utf8');
        }
        finally {
            closeBoundDirectory(integration);
        }
    }
    finally {
        closeBoundDirectory(agent);
    }
}
export function inspectAuthorityMigration(status, dependencies = {}) {
    const exists = dependencies.exists ?? existsSync;
    const appRoot = typeof status.source.appRoot === 'string' ? status.source.appRoot : '';
    let packageIntegrationInstalled = false;
    if (appRoot) {
        try {
            const manifestText = readPackageIntegrationManifest(appRoot, dependencies);
            const manifest = manifestText
                ? JSON.parse(manifestText)
                : undefined;
            packageIntegrationInstalled = manifest?.version === 1;
        }
        catch {
            packageIntegrationInstalled = false;
        }
    }
    const legacyStateDetected = [
        '/tmp/rn-dev-agent-session.json',
        '/tmp/rn-fast-runner-state.json',
        '/tmp/rn-android-runner-state.json',
    ].some(exists);
    return {
        rollout: 'strict-default',
        storeAvailable: true,
        registrySchema: 3,
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
        },
        strictEnforcement: true,
    };
}
