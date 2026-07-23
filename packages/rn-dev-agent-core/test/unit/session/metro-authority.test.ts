import assert from 'node:assert/strict';
import vm from 'node:vm';
import { test } from 'node:test';
import {
  createMetroAuthorityMarker,
  createMetroAuthorityModule,
  verifyMetroAuthorityMarker,
  withMetroAuthorityModule,
} from '../../../dist/session/metro-authority.js';

const binding = {
  sessionId: 'session-a',
  metroInstanceId: 'metro-a',
  worktreeKey: 'worktree-a',
  appId: 'dev.example.app',
  platform: 'ios',
  buildGeneration: 4,
};

test('signed marker proves coarse initial-bundle binding without source fidelity', () => {
  const marker = createMetroAuthorityMarker(binding, 'signer-secret');
  const verified = verifyMetroAuthorityMarker(marker, 'signer-secret');

  assert.deepEqual(verified, {
    ...binding,
    authorityScope: 'initial-bundle',
    sourceFidelity: 'not-proven',
  });
  assert.equal('sourceDigest' in marker.payload, false);
  assert.equal('hmrRevision' in marker.payload, false);
  assert.equal(JSON.stringify(marker).includes('signer-secret'), false);
});

test('Fast Refresh leaves coarse binding valid without inventing source fidelity', () => {
  const marker = createMetroAuthorityMarker(binding, 'signer-secret');
  const runtime = {
    authority: marker,
    hmrRevision: 'revision-1',
    sourceText: 'export const label = "before"',
  };
  runtime.hmrRevision = 'revision-2';
  runtime.sourceText = 'export const label = "after"';

  const verified = verifyMetroAuthorityMarker(runtime.authority, 'signer-secret', binding);

  assert.equal(verified.metroInstanceId, binding.metroInstanceId);
  assert.equal(verified.sourceFidelity, 'not-proven');
  assert.equal('hmrRevision' in verified, false);
  assert.equal('sourceText' in verified, false);
});

test('marker rejects a foreign signer and foreign expected binding', () => {
  const marker = createMetroAuthorityMarker(binding, 'signer-secret');

  assert.throws(
    () => verifyMetroAuthorityMarker(marker, 'foreign-secret'),
    /BUNDLE_IDENTITY_MISMATCH/,
  );
  assert.throws(
    () =>
      verifyMetroAuthorityMarker(marker, 'signer-secret', {
        sessionId: 'session-b',
      }),
    /BUNDLE_IDENTITY_MISMATCH/,
  );
});

test('Metro config composition preserves Expo and bare custom serializer behavior', () => {
  for (const [kind, config] of [
    [
      'expo',
      {
        resolver: { sourceExts: ['js', 'tsx'] },
        serializer: {
          customSerializer: () => 'expo-custom-output',
          getModulesRunBeforeMainModule: (entry) => [`expo:${entry}`],
        },
      },
    ],
    [
      'bare',
      {
        transformer: { unstable_allowRequireContext: true },
        serializer: {
          customSerializer: () => 'bare-custom-output',
          getModulesRunBeforeMainModule: (entry) => [`bare:${entry}`],
        },
      },
    ],
  ]) {
    const composed = withMetroAuthorityModule(config, '/authority/marker.js');

    assert.equal(composed.serializer.customSerializer(), `${kind}-custom-output`);
    assert.deepEqual(composed.serializer.getModulesRunBeforeMainModule('index.js'), [
      '/authority/marker.js',
      `${kind}:index.js`,
    ]);
    assert.deepEqual(
      composed.resolver ?? composed.transformer,
      config.resolver ?? config.transformer,
    );
  }
});

test('unsigned marker keeps Metro buildable but cannot manufacture authority', () => {
  const source = createMetroAuthorityModule(null);
  const context = { globalThis: {} };

  vm.runInNewContext(source, context);

  assert.deepEqual(JSON.parse(JSON.stringify(context.globalThis.__RN_DEV_AGENT_AUTHORITY__)), {
    status: 'unavailable',
    authorityScope: 'initial-bundle',
    sourceFidelity: 'not-proven',
  });
});

test('signed module is runtime-neutral for Hermes and bridgeless globals', () => {
  const marker = createMetroAuthorityMarker(binding, 'signer-secret');
  const source = createMetroAuthorityModule(marker);
  const context = { globalThis: {} };

  vm.runInNewContext(source, context);

  assert.equal(context.globalThis.__RN_DEV_AGENT_AUTHORITY__.status, 'signed');
  assert.equal(
    context.globalThis.__RN_DEV_AGENT_AUTHORITY__.marker.payload.metroInstanceId,
    'metro-a',
  );
});
