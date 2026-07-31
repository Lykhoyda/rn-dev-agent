import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { inspectAuthorityMigration } from '../../../dist/session/migration-diagnostic.js';

const status = {
  sessionId: 'session-a',
  sourceKey: 'source-a',
  worktreeKey: 'worktree-a',
  appRootKey: 'app-a',
  state: 'ready',
  claimEpoch: 1,
  authorityVersion: 8,
  leaseUntilMs: Date.now() + 30_000,
  source: { appRoot: '/fixture/app' },
  bindings: { bundle: { sourceFidelity: 'not-proven' } },
  claims: [],
  worker: { instanceId: 'worker-a', pid: 42, birthAvailable: true },
};

test('migration diagnostic reports strict-default support without overstating bundle fidelity', () => {
  const diagnostic = inspectAuthorityMigration(status, {
    exists: (path) => path.endsWith('rn-session-integration.json'),
    readText: () => JSON.stringify({ version: 1 }),
  });

  assert.equal(diagnostic.rollout, 'strict-default');
  assert.equal(diagnostic.registrySchema, 4);
  assert.equal(diagnostic.bundleHandshake.scope, 'coarse-initial-bundle');
  assert.equal(diagnostic.bundleHandshake.sourceFidelity, 'not-proven');
  assert.equal(diagnostic.packageIntegration.installed, true);
  assert.equal(diagnostic.strictEnforcement, true);
});

test('legacy files are diagnostic only and never disable strict enforcement', () => {
  const diagnostic = inspectAuthorityMigration(status, {
    exists: (path) => path === '/tmp/rn-fast-runner-state.json',
  });

  assert.equal(diagnostic.legacyStateDetected, true);
  assert.equal(diagnostic.packageIntegration.installed, false);
  assert.equal(diagnostic.strictEnforcement, true);
});

test('pre-adoption binding reports the installer as the effective owner', () => {
  const diagnostic = inspectAuthorityMigration({
    ...status,
    bindings: {
      packageIntegration: {
        version: 1,
        installedBySessionId: 'session-a',
        manifestSha256: 'unavailable',
      },
    },
  });

  assert.equal(diagnostic.packageIntegration.binding?.installedBySessionId, 'session-a');
  assert.equal(diagnostic.packageIntegration.binding?.effectiveOwnerSessionId, 'session-a');
  assert.equal(diagnostic.packageIntegration.binding?.ownedByThisSession, true);
});

test('post-adoption binding separates the historical installer from the effective owner', () => {
  const diagnostic = inspectAuthorityMigration({
    ...status,
    sessionId: 'session-adopter',
    bindings: {
      packageIntegration: {
        version: 1,
        installedBySessionId: 'session-installer',
        manifestSha256: 'unavailable',
      },
    },
  });

  const binding = diagnostic.packageIntegration.binding;
  assert.equal(binding?.installedBySessionId, 'session-installer');
  assert.equal(binding?.effectiveOwnerSessionId, 'session-adopter');
  assert.equal(
    binding?.ownedByThisSession,
    true,
    'the adopter holds restoration authority after transfer',
  );
});

test('an existing .rn-agent directory without integration is a normal never-integrated app', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-migration-diagnostic-'));
  const appRoot = join(root, 'app');
  try {
    mkdirSync(join(appRoot, '.rn-agent', 'actions'), { recursive: true });

    const diagnostic = inspectAuthorityMigration({
      ...status,
      source: { appRoot },
    });

    assert.equal(diagnostic.packageIntegration.installed, false);
    assert.equal(diagnostic.strictEnforcement, true);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('migration diagnostic rejects redirected integration ancestors', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-migration-diagnostic-'));
  const appRoot = join(root, 'app');
  const external = join(root, 'external');
  try {
    mkdirSync(join(appRoot, '.rn-agent', 'integration'), { recursive: true });
    writeFileSync(
      join(appRoot, '.rn-agent', 'integration', 'rn-session-integration.json'),
      JSON.stringify({ version: 1 }),
    );

    const installed = inspectAuthorityMigration({
      ...status,
      source: { appRoot },
    });
    assert.equal(installed.packageIntegration.installed, true);

    rmSync(join(appRoot, '.rn-agent'), { recursive: true });
    mkdirSync(join(external, 'integration'), { recursive: true });
    writeFileSync(
      join(external, 'integration', 'rn-session-integration.json'),
      JSON.stringify({ version: 1 }),
    );
    symlinkSync(external, join(appRoot, '.rn-agent'));

    assert.throws(
      () =>
        inspectAuthorityMigration({
          ...status,
          source: { appRoot },
        }),
      /SESSION_INTEGRATION_PATH_UNSAFE/,
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
