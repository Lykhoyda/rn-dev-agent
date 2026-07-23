import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
export function inspectAuthorityMigration(status, dependencies = {}) {
    const exists = dependencies.exists ?? existsSync;
    const readText = dependencies.readText ?? ((path) => readFileSync(path, 'utf8'));
    const appRoot = typeof status.source.appRoot === 'string' ? status.source.appRoot : '';
    const manifestPath = appRoot
        ? join(appRoot, '.rn-agent', 'integration', 'rn-session-integration.json')
        : '';
    let packageIntegrationInstalled = false;
    if (manifestPath && exists(manifestPath)) {
        try {
            const manifest = JSON.parse(readText(manifestPath));
            packageIntegrationInstalled = manifest.version === 1;
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
        registrySchema: 2,
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
