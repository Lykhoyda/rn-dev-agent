import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSignedMetroMarker } from '../../../dist/session/metro-authority.js';
import {
  boundConnectConflict,
  buildBundleAuthorityBinding,
  pinExactDevClient,
  reconcileAuthoritativeBundle,
} from '../../../dist/session/dev-client-authority.js';

const expected = {
  sessionId: 'session-a',
  metroInstanceId: 'metro-a',
  worktreeKey: 'worktree-a',
  appId: 'com.example.app',
  platform: 'ios',
  buildGeneration: 2,
};

const exactManifestResponse = {
  body: JSON.stringify({ launchAsset: { url: 'http://127.0.0.1:8341/index.bundle' } }),
  contentType: 'application/expo+json',
  status: 200,
};

test('bundle authority reconstruction is complete without a prior binding', () => {
  const binding = buildBundleAuthorityBinding({
    ...expected,
    deviceId: 'IOS-UUID',
    metroPort: 8341,
    targetId: 'target-restored',
    connectionGeneration: 9,
  });

  assert.deepEqual(binding, {
    ...expected,
    deviceId: 'IOS-UUID',
    metroPort: 8341,
    launchMethod: 'app',
    targetId: 'target-restored',
    connectionGeneration: 9,
    authorityScope: 'initial-bundle',
    sourceFidelity: 'not-proven',
  });
});

test('dev-client pin opens only the declared URL on the exact device and binds its target', async () => {
  const calls = [];
  const marker = buildSignedMetroMarker(expected, 'signer');
  const binding = await pinExactDevClient(
    {
      ...expected,
      deviceId: 'IOS-UUID',
      metroPort: 8341,
      devClientUrl: 'example://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8341',
      expectedDevClientUrl: 'example://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8341',
      runtimeKind: 'expo-dev-client',
      signerCapability: 'signer',
    },
    {
      openUrl: async (platform, deviceId, url) => calls.push(['open', platform, deviceId, url]),
      acceptIosOpenDialog: async (deviceId) => calls.push(['dialog', deviceId]),
      connectExact: async (input) => {
        calls.push(['connect', input]);
        return { targetId: 'target-a', connectionGeneration: 7, deviceId: 'IOS-UUID' };
      },
      readMarker: async () => ({ status: 'signed', marker }),
      readManagedManifest: async () => exactManifestResponse,
    },
  );

  assert.equal(calls[0][2], 'IOS-UUID');
  assert.equal(calls[0][3], binding.devClientUrl);
  assert.equal(binding.targetId, 'target-a');
  assert.equal(binding.sourceFidelity, 'not-proven');
});

test('dev-client pin refuses any URL drift and never falls back to a picker row', async () => {
  await assert.rejects(
    pinExactDevClient(
      {
        ...expected,
        deviceId: 'IOS-UUID',
        metroPort: 8341,
        devClientUrl: 'example://foreign',
        expectedDevClientUrl: 'example://expected',
        runtimeKind: 'expo-dev-client',
        signerCapability: 'signer',
      },
      {
        openUrl: async () => {
          throw new Error('must not open');
        },
        acceptIosOpenDialog: async () => {},
        connectExact: async () => ({
          targetId: 'target-a',
          connectionGeneration: 7,
          deviceId: 'IOS-UUID',
        }),
        readMarker: async () => null,
      },
    ),
    /DEV_CLIENT_ENDPOINT_NOT_FOUND/,
  );
});

test('bare RN pin launches the exact claimed app without inventing a dev-client URL', async () => {
  const calls = [];
  const marker = buildSignedMetroMarker(expected, 'signer');
  const binding = await pinExactDevClient(
    {
      ...expected,
      deviceId: 'IOS-UUID',
      metroPort: 8341,
      runtimeKind: 'bare-react-native',
      signerCapability: 'signer',
    },
    {
      openUrl: async () => {
        throw new Error('bare RN must not open a URL');
      },
      launchExactApp: async (platform, deviceId, appId) =>
        calls.push(['launch', platform, deviceId, appId]),
      acceptIosOpenDialog: async () => {
        throw new Error('bare RN has no URL confirmation dialog');
      },
      connectExact: async (input) => {
        calls.push(['connect', input]);
        return { targetId: 'target-bare', connectionGeneration: 8, deviceId: 'IOS-UUID' };
      },
      readMarker: async () => ({ status: 'signed', marker }),
    },
  );

  assert.deepEqual(calls[0], ['launch', 'ios', 'IOS-UUID', 'com.example.app']);
  assert.equal(binding.launchMethod, 'app');
  assert.equal(binding.devClientUrl, undefined);
});

test('receipted Expo pin verifies the managed manifest without a dev-client URL', async () => {
  const calls = [];
  const marker = buildSignedMetroMarker(expected, 'signer');
  const binding = await pinExactDevClient(
    {
      ...expected,
      deviceId: 'IOS-UUID',
      metroPort: 8341,
      runtimeKind: 'expo-dev-client',
      signerCapability: 'signer',
    },
    {
      openUrl: async () => {
        throw new Error('missing URL must launch the exact app');
      },
      launchExactApp: async (platform, deviceId, appId) =>
        calls.push(['launch', platform, deviceId, appId]),
      acceptIosOpenDialog: async () => {},
      connectExact: async () => ({
        targetId: 'target-expo',
        connectionGeneration: 9,
        deviceId: 'IOS-UUID',
      }),
      readMarker: async () => ({ status: 'signed', marker }),
      readManagedManifest: async (input) => {
        calls.push(['manifest', input.host, input.metroPort]);
        return exactManifestResponse;
      },
    },
  );

  assert.deepEqual(calls, [
    ['manifest', '127.0.0.1', 8341],
    ['launch', 'ios', 'IOS-UUID', 'com.example.app'],
  ]);
  assert.equal(binding.targetId, 'target-expo');
});

test('loader or error targets remain rejected until the exact runtime exposes its signed marker', async () => {
  const marker = buildSignedMetroMarker(expected, 'private-signer-capability');
  let markerAvailable = false;
  let launches = 0;
  const dependencies = {
    openUrl: async () => {},
    launchExactApp: async () => {
      launches += 1;
    },
    acceptIosOpenDialog: async () => {},
    connectExact: async () => ({
      targetId: 'bridgeless-target-without-vm',
      connectionGeneration: launches,
      deviceId: 'IOS-UUID',
    }),
    readMarker: async () =>
      markerAvailable ? ({ status: 'signed' as const, marker } as const) : null,
  };
  const input = {
    ...expected,
    deviceId: 'IOS-UUID',
    metroPort: 8341,
    runtimeKind: 'bare-react-native' as const,
    signerCapability: 'private-signer-capability',
  };

  await assert.rejects(pinExactDevClient(input, dependencies), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /^BUNDLE_HANDSHAKE_UNAVAILABLE:/);
    assert.doesNotMatch(error.message, /private-signer-capability|IOS-UUID|com\.example\.app/);
    return true;
  });

  markerAvailable = true;
  const recovered = await pinExactDevClient(input, dependencies);
  assert.equal(recovered.targetId, 'bridgeless-target-without-vm');
  assert.equal(recovered.connectionGeneration, 2);
  assert.equal(launches, 2);
});

test('verified reconnect atomically replaces rotated target and generation authority', async () => {
  const commits: Record<string, unknown>[] = [];
  await reconcileAuthoritativeBundle(
    {
      authorityVersion: 12,
      bindings: {
        metroPort: 8341,
        bundle: { targetId: 'target-old', connectionGeneration: 3 },
      },
    },
    {
      verifyRuntime: async () => ({ targetId: 'target-new', connectionGeneration: 4 }),
      hasActiveOperation: () => false,
      commit: (input) => commits.push(input),
    },
  );

  assert.deepEqual(commits, [
    {
      expectedAuthorityVersion: 12,
      state: 'ready',
      bindings: { bundle: { targetId: 'target-new', connectionGeneration: 4 } },
      releaseResources: [{ type: 'target', key: '8341:target-old' }],
      claimResources: [{ type: 'target', key: '8341:target-new' }],
    },
  ]);
});

test('signed-marker rejection prevents durable reconnect reconciliation', async () => {
  let committed = false;
  await assert.rejects(
    reconcileAuthoritativeBundle(
      {
        authorityVersion: 12,
        bindings: { metroPort: 8341, bundle: { targetId: 'target-old' } },
      },
      {
        verifyRuntime: async () => {
          throw new Error('BUNDLE_HANDSHAKE_UNAVAILABLE: signed marker rejected');
        },
        hasActiveOperation: () => false,
        commit: () => {
          committed = true;
        },
      },
    ),
    /BUNDLE_HANDSHAKE_UNAVAILABLE/,
  );
  assert.equal(committed, false);
});

test('dev-client pinning rejects a target not proven on the claimed device', async () => {
  const marker = buildSignedMetroMarker(expected, 'signer');
  await assert.rejects(
    pinExactDevClient(
      {
        ...expected,
        deviceId: 'IOS-UUID',
        metroPort: 8341,
        runtimeKind: 'bare-react-native',
        signerCapability: 'signer',
      },
      {
        openUrl: async () => {},
        acceptIosOpenDialog: async () => {},
        launchExactApp: async () => {},
        connectExact: async () => ({
          targetId: 'foreign-target',
          connectionGeneration: 9,
          deviceId: 'OTHER-IOS-UUID',
        }),
        readMarker: async () => ({ status: 'signed', marker }),
      },
    ),
    /CDP_TARGET_AUTHORITY_MISMATCH/,
  );
});

test('bound connect rejects every explicit target dimension that contradicts the session', () => {
  const status = {
    bindings: {
      metroPort: 8341,
      device: { platform: 'ios', appId: 'com.example.app' },
      bundle: { targetId: 'target-a' },
    },
  };

  assert.equal(boundConnectConflict(status, {}), null);
  assert.equal(boundConnectConflict(status, { metroPort: 8082 })?.code, 'METRO_AUTHORITY_MISMATCH');
  assert.equal(
    boundConnectConflict(status, { platform: 'android' })?.code,
    'DEVICE_AUTHORITY_MISMATCH',
  );
  assert.equal(
    boundConnectConflict(status, { bundleId: 'com.foreign.app' })?.code,
    'DEVICE_AUTHORITY_MISMATCH',
  );
  assert.equal(
    boundConnectConflict(status, { targetId: 'target-b' })?.code,
    'CDP_TARGET_AUTHORITY_MISMATCH',
  );
  assert.equal(
    boundConnectConflict(status, {
      metroPort: 8341,
      platform: 'IOS',
      bundleId: 'COM.EXAMPLE.APP',
      targetId: 'target-a',
    }),
    null,
  );
});

test('dev-client pin refuses a manifest whose launch asset leaves the managed endpoint', async () => {
  const marker = buildSignedMetroMarker(expected, 'signer');
  const launched = [];
  const input = {
    ...expected,
    deviceId: 'IOS-UUID',
    metroPort: 8341,
    devClientUrl: 'example://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8341',
    expectedDevClientUrl: 'example://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8341',
    runtimeKind: 'expo-dev-client' as const,
    signerCapability: 'signer',
  };
  const dependencies = (manifest) => ({
    openUrl: async () => launched.push('url'),
    launchExactApp: async () => launched.push('app'),
    acceptIosOpenDialog: async () => {},
    connectExact: async () => ({
      targetId: 'target-a',
      connectionGeneration: 1,
      deviceId: 'IOS-UUID',
    }),
    readMarker: async () => ({ status: 'signed', marker }),
    readManagedManifest: async ({ host, metroPort, platform }) => {
      assert.equal(host, '127.0.0.1');
      assert.equal(metroPort, 8341);
      assert.equal(platform, 'ios');
      return {
        body: manifest,
        contentType: 'application/expo+json',
        status: 200,
      };
    },
  });

  await assert.rejects(
    pinExactDevClient(
      input,
      dependencies(
        JSON.stringify({
          launchAsset: { url: 'http://127.0.0.1:8099/index.bundle' },
        }),
      ),
    ),
    /METRO_MANIFEST_ENDPOINT_MISMATCH/,
  );
  assert.deepEqual(launched, [], 'no device may be launched from an off-endpoint manifest');

  const exact = await pinExactDevClient(
    input,
    dependencies(
      JSON.stringify({
        launchAsset: { url: 'http://127.0.0.1:8341/index.bundle?platform=ios' },
      }),
    ),
  );
  assert.equal(exact.targetId, 'target-a');
  assert.deepEqual(launched, ['url']);

  const bareReactNative = await pinExactDevClient(
    {
      ...expected,
      deviceId: 'IOS-UUID',
      metroPort: 8341,
      runtimeKind: 'bare-react-native',
      signerCapability: 'signer',
    },
    {
      ...dependencies('packager-status:running'),
      readManagedManifest: async () => {
        throw new Error('bare React Native must not be classified from an HTTP response');
      },
    },
  );
  assert.equal(bareReactNative.targetId, 'target-a');
  assert.deepEqual(launched, ['url', 'app']);
});
