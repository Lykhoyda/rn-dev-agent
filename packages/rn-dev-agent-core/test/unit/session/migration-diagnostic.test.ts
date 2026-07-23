import assert from 'node:assert/strict';
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
  assert.equal(diagnostic.registrySchema, 2);
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
