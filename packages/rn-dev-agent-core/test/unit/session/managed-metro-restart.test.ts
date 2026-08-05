import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveManagedMetroRestartGeneration } from '../../../dist/session/managed-metro-restart.js';

const session = {
  sessionId: 'session-a',
  sourceKey: 'source-a',
  worktreeKey: 'worktree-a',
  appRootKey: 'app-root-a',
  metroPort: 8341,
};
const device = { platform: 'ios' as const, deviceId: 'SIM-A', appId: 'dev.example' };
const install = {
  ...session,
  ...device,
  artifactDigest: 'artifact-a',
  installGeneration: 'install-a',
  buildGeneration: 7,
  buildKind: 'expo',
};

for (const sdk of [55, 56]) {
  test(`Expo SDK ${sdk} managed restart preserves the exact receipted build generation`, () => {
    assert.equal(
      resolveManagedMetroRestartGeneration({
        session,
        device,
        install,
        priorGenerations: [7],
        captureInstalled: () => ({
          artifactDigest: 'artifact-a',
          installGeneration: 'install-a',
        }),
      }),
      7,
    );
  });
}

test('picker parking can restart managed Metro at the exact pending build generation', () => {
  assert.equal(
    resolveManagedMetroRestartGeneration({
      session,
      device,
      pendingBuild: { platform: 'ios', buildKind: 'expo', buildGeneration: 9 },
      priorGenerations: [8],
      captureInstalled: () => assert.fail('pending build restart does not admit install bytes'),
    }),
    9,
  );
});

test('managed restart without an install allocates a fresh generation', () => {
  assert.equal(
    resolveManagedMetroRestartGeneration({
      session,
      device,
      priorGenerations: [2, 5],
      captureInstalled: () => assert.fail('no install must not probe device bytes'),
    }),
    6,
  );
});

test('managed restart refuses stale or foreign install authority before startup', () => {
  for (const changed of [
    { deviceId: 'SIM-B' },
    { appId: 'dev.foreign' },
    { metroPort: 9999 },
    { sessionId: 'session-foreign' },
    { buildKind: 'unknown' },
  ]) {
    assert.throws(
      () =>
        resolveManagedMetroRestartGeneration({
          session,
          device,
          install: { ...install, ...changed },
          priorGenerations: [7],
          captureInstalled: () => ({
            artifactDigest: 'artifact-a',
            installGeneration: 'install-a',
          }),
        }),
      /BUILD_RECEIPT_INVALID/,
    );
  }
});

test('managed restart refuses install-byte drift and never promotes old bundle authority', () => {
  assert.throws(
    () =>
      resolveManagedMetroRestartGeneration({
        session,
        device,
        install,
        priorGenerations: [7],
        captureInstalled: () => ({
          artifactDigest: 'artifact-foreign',
          installGeneration: 'install-foreign',
        }),
      }),
    /installed artifact changed/,
  );
  assert.equal(Object.hasOwn(install, 'bundle'), false);
});
