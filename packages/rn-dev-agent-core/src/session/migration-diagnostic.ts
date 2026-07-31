import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  closeBoundDirectories,
  type BoundDirectory,
  openBoundDirectory,
  openBoundSubdirectory,
  readBoundDirectoryFiles,
} from './bound-directory.js';
import { AUTHORITY_REGISTRY_SCHEMA_VERSION, type SessionStatus } from './registry.js';

interface MigrationDiagnosticDependencies {
  exists?: (path: string) => boolean;
  readText?: (path: string) => string;
}

export interface AuthorityMigrationDiagnostic {
  rollout: 'strict-default';
  storeAvailable: true;
  registrySchema: typeof AUTHORITY_REGISTRY_SCHEMA_VERSION;
  legacyStateDetected: boolean;
  bundleHandshake: {
    supported: true;
    scope: 'coarse-initial-bundle';
    bound: boolean;
    sourceFidelity: 'not-proven';
  };
  packageIntegration: {
    supported: true;
    installed: boolean;
    binding: null | {
      installedBySessionId: string | null;
      ownedByThisSession: boolean;
      manifestAvailable: boolean;
      nextAction: string;
    };
  };
  strictEnforcement: true;
}

function readPackageIntegrationManifest(
  appRoot: string,
  dependencies: MigrationDiagnosticDependencies,
): string | undefined {
  const manifestPath = join(appRoot, '.rn-agent', 'integration', 'rn-session-integration.json');
  if (dependencies.exists || dependencies.readText) {
    const exists = dependencies.exists ?? existsSync;
    if (!exists(manifestPath)) return undefined;
    const readText = dependencies.readText ?? ((path: string) => readFileSync(path, 'utf8'));
    return readText(manifestPath);
  }
  const agent = openBoundDirectory(join(appRoot, '.rn-agent'));
  let integration: BoundDirectory | undefined;
  let primaryError: unknown;
  try {
    integration = openBoundSubdirectory(agent, 'integration');
    const [manifest] = readBoundDirectoryFiles(integration, ['rn-session-integration.json']);
    return manifest?.contents?.toString('utf8');
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes('SESSION_INTEGRATION_PATH_UNSAFE') &&
      error.message.includes('ENOENT') &&
      error.message.includes("lstat 'integration'")
    ) {
      return undefined;
    }
    primaryError = error;
    throw error;
  } finally {
    closeBoundDirectories([integration, agent], primaryError);
  }
}

export function inspectAuthorityMigration(
  status: SessionStatus,
  dependencies: MigrationDiagnosticDependencies = {},
): AuthorityMigrationDiagnostic {
  const exists = dependencies.exists ?? existsSync;
  const appRoot = typeof status.source.appRoot === 'string' ? status.source.appRoot : '';
  let packageIntegrationInstalled = false;
  let onDiskManifestText: string | undefined;
  if (appRoot) {
    try {
      onDiskManifestText = readPackageIntegrationManifest(appRoot, dependencies);
      const manifest = onDiskManifestText
        ? (JSON.parse(onDiskManifestText) as { version?: unknown })
        : undefined;
      packageIntegrationInstalled = manifest?.version === 1;
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes('SESSION_INTEGRATION_PATH_UNSAFE') &&
        !error.message.includes('ancestor is unavailable')
      ) {
        throw error;
      }
      packageIntegrationInstalled = false;
    }
  }
  const integrationBinding = status.bindings.packageIntegration as
    | {
        installedBySessionId?: unknown;
        manifestSha256?: unknown;
        manifestSource?: unknown;
        installation?: { phase?: unknown; manifestSource?: unknown };
        restoration?: { phase?: unknown; manifestSource?: unknown };
      }
    | null
    | undefined;
  let bindingDiagnostic: AuthorityMigrationDiagnostic['packageIntegration']['binding'] = null;
  if (integrationBinding) {
    const manifestVerified = (candidate: unknown): boolean =>
      typeof candidate === 'string' &&
      typeof integrationBinding.manifestSha256 === 'string' &&
      createHash('sha256').update(candidate).digest('hex') === integrationBinding.manifestSha256;
    const manifestAvailable =
      manifestVerified(onDiskManifestText) ||
      manifestVerified(
        integrationBinding.restoration?.phase === 'started'
          ? integrationBinding.restoration.manifestSource
          : undefined,
      ) ||
      manifestVerified(
        integrationBinding.installation?.phase === 'started'
          ? integrationBinding.installation.manifestSource
          : undefined,
      ) ||
      manifestVerified(integrationBinding.manifestSource);
    bindingDiagnostic = {
      installedBySessionId:
        typeof integrationBinding.installedBySessionId === 'string'
          ? integrationBinding.installedBySessionId
          : null,
      ownedByThisSession: integrationBinding.installedBySessionId === status.sessionId,
      manifestAvailable,
      nextAction: manifestAvailable
        ? 'Run restore_integration with confirmed=true to restore canonical files before release.'
        : 'Run restore_integration with confirmed=true; it reconciles the binding only when canonical files are provably unintegrated.',
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
