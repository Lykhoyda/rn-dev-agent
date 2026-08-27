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
      runtimeKind: 'expo-dev-client',
      signerCapability: 'signer',
    },
    {
      openUrl: async (platform, deviceId, url) => calls.push(['open', platform, deviceId, url]),
      acceptIosOpenDialog: async (deviceId) => calls.push(['dialog', deviceId]),
      connectExact: async (input) => {
        calls.push(['connect', input]);
        return {
          targetId: 'target-a',
          connectionGeneration: 7,
          deviceId: 'IOS-UUID',
          metroPort: 8341,
        };
      },
      readMarker: async () => ({ status: 'signed', marker }),
    },
  );

  assert.equal(calls[0][2], 'IOS-UUID');
  assert.equal(calls[0][3], binding.devClientUrl);
  assert.equal(binding.targetId, 'target-a');
  assert.equal(binding.sourceFidelity, 'not-proven');
});

test('Android staged client publishes only after marker proof and atomic precommit assertion', async () => {
  const androidExpected = { ...expected, platform: 'android' };
  const marker = buildSignedMetroMarker(androidExpected, 'signer');
  const events: string[] = [];
  const connection = {
    targetId: 'android-target',
    connectionGeneration: 4,
    deviceId: 'emulator-5554',
    metroPort: 8341,
    client: {} as never,
    assertActive: () => events.push('assert'),
    run: async (operation) => {
      events.push('marker-boundary');
      return operation();
    },
    publish: () => events.push('publish'),
    cancel: () => events.push('cancel'),
  };

  await pinExactDevClient(
    {
      ...androidExpected,
      deviceId: 'emulator-5554',
      metroPort: 8341,
      runtimeKind: 'bare-react-native',
      signerCapability: 'signer',
    },
    {
      openUrl: async () => assert.fail('bare runtime must not open a URL'),
      launchExactApp: async () => {},
      acceptIosOpenDialog: async () => {},
      connectExact: async () => connection,
      readMarker: async () => {
        events.push('marker');
        return { status: 'signed', marker };
      },
      commitBundle: (_bundle, promotion) => {
        events.push('transaction');
        assert.equal(events.includes('publish'), false);
        promotion.assertActive();
        events.push('commit');
        promotion.assertActive();
        promotion.publish();
      },
    },
  );

  assert.deepEqual(events, [
    'marker-boundary',
    'marker',
    'assert',
    'transaction',
    'assert',
    'commit',
    'assert',
    'publish',
  ]);
});

test('Android staged client cancellation leaves publication untouched when atomic commit fails', async () => {
  const androidExpected = { ...expected, platform: 'android' };
  const marker = buildSignedMetroMarker(androidExpected, 'signer');
  const events: string[] = [];
  await assert.rejects(
    pinExactDevClient(
      {
        ...androidExpected,
        deviceId: 'emulator-5554',
        metroPort: 8341,
        runtimeKind: 'bare-react-native',
        signerCapability: 'signer',
      },
      {
        openUrl: async () => {},
        launchExactApp: async () => {},
        acceptIosOpenDialog: async () => {},
        connectExact: async () => ({
          targetId: 'android-target',
          connectionGeneration: 4,
          deviceId: 'emulator-5554',
          metroPort: 8341,
          client: {} as never,
          assertActive: () => {},
          run: (operation) => operation(),
          publish: () => events.push('publish'),
          cancel: () => events.push('cancel'),
        }),
        readMarker: async () => ({ status: 'signed', marker }),
        commitBundle: () => {
          throw new Error('deadline expired at COMMIT');
        },
      },
    ),
    /deadline expired at COMMIT/,
  );
  assert.deepEqual(events, ['cancel']);
});

test('dev-client endpoint is launch data and cannot bind without the signed bundle handshake', async () => {
  const calls = [];
  await assert.rejects(
    pinExactDevClient(
      {
        ...expected,
        deviceId: 'IOS-UUID',
        metroPort: 8341,
        devClientUrl: 'example://foreign',
        runtimeKind: 'expo-dev-client',
        signerCapability: 'signer',
      },
      {
        openUrl: async (_platform, _deviceId, url) => calls.push(['open', url]),
        acceptIosOpenDialog: async () => {},
        connectExact: async () => ({
          targetId: 'target-a',
          connectionGeneration: 7,
          deviceId: 'IOS-UUID',
          metroPort: 8341,
        }),
        readMarker: async () => null,
      },
    ),
    /BUNDLE_HANDSHAKE_UNAVAILABLE/,
  );
  assert.deepEqual(calls, [['open', 'example://foreign']]);
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
        return {
          targetId: 'target-bare',
          connectionGeneration: 8,
          deviceId: 'IOS-UUID',
          metroPort: 8341,
        };
      },
      readMarker: async () => ({ status: 'signed', marker }),
    },
  );

  assert.deepEqual(calls[0], ['launch', 'ios', 'IOS-UUID', 'com.example.app']);
  assert.equal(binding.launchMethod, 'app');
  assert.equal(binding.devClientUrl, undefined);
});

test('receipted iOS Expo pin launches through the authority-bound Metro without a dev-client URL', async () => {
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
        throw new Error('missing URL must not use openurl');
      },
      launchExactApp: async () => {
        throw new Error('Expo Dev Client must not be stranded by a bare app launch');
      },
      launchExactAppWithInitialUrl: async (deviceId, appId, initialUrl) =>
        calls.push(['launch-with-initial-url', deviceId, appId, initialUrl]),
      acceptIosOpenDialog: async () => {},
      connectExact: async () => ({
        targetId: 'target-expo',
        connectionGeneration: 9,
        deviceId: 'IOS-UUID',
        metroPort: 8341,
      }),
      readMarker: async () => ({ status: 'signed', marker }),
    },
  );

  assert.deepEqual(calls, [
    ['launch-with-initial-url', 'IOS-UUID', 'com.example.app', 'http://127.0.0.1:8341'],
  ]);
  assert.equal(binding.targetId, 'target-expo');
  assert.equal(binding.devClientUrl, undefined, 'a bare Metro URL is not a dev-client deep link');
  assert.equal(binding.launchMethod, 'app');
});

test('iOS Expo pin refuses when no authority-bound Metro port exists', async () => {
  await assert.rejects(
    pinExactDevClient(
      {
        ...expected,
        deviceId: 'IOS-UUID',
        metroPort: undefined as unknown as number,
        runtimeKind: 'expo-dev-client',
        signerCapability: 'signer',
      },
      {
        openUrl: async () => assert.fail('must not open a URL'),
        launchExactApp: async () => assert.fail('must not bare-launch the app'),
        launchExactAppWithInitialUrl: async () => assert.fail('must not derive without authority'),
        acceptIosOpenDialog: async () => {},
        connectExact: async () => assert.fail('must not connect without Metro authority'),
        readMarker: async () => null,
      },
    ),
    /DEV_CLIENT_ENDPOINT_NOT_FOUND: authority-bound Metro port is unavailable/,
  );
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
      metroPort: 8341,
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
          metroPort: 8341,
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

// GH #750: with B unbound there is no proven target to conflict with, so a
// cdp_targets-derived targetId must reach the pin flow (which proves the sole
// exact-device target itself) instead of dead-ending the recovery.
test('bound connect accepts an advisory targetId while the bundle is unbound', () => {
  const unbound = {
    bindings: {
      metroPort: 8341,
      device: { platform: 'ios', appId: 'com.example.app' },
      bundle: null,
    },
  };

  assert.equal(boundConnectConflict(unbound, { targetId: 'target-from-cdp-targets' }), null);
  assert.equal(
    boundConnectConflict(unbound, {
      metroPort: 8341,
      platform: 'ios',
      bundleId: 'com.example.app',
      targetId: 'target-from-cdp-targets',
    }),
    null,
  );
  const corrupt = {
    bindings: {
      metroPort: 8341,
      device: { platform: 'ios', appId: 'com.example.app' },
      bundle: { targetId: 42 },
    },
  };
  assert.equal(
    boundConnectConflict(corrupt, { targetId: 'target-a' })?.code,
    'CDP_TARGET_AUTHORITY_MISMATCH',
  );
});

test('physical-device LAN launch binds only from the exact connected Metro and signed marker', async () => {
  const marker = buildSignedMetroMarker(expected, 'signer');
  const launched = [];
  const input = {
    ...expected,
    deviceId: 'IOS-UUID',
    metroPort: 8341,
    devClientUrl: 'example://expo-development-client/?url=http%3A%2F%2F192.168.1.20%3A8341',
    runtimeKind: 'expo-dev-client' as const,
    signerCapability: 'signer',
  };
  const dependencies = (metroPort = 8341) => ({
    openUrl: async () => launched.push('url'),
    launchExactApp: async () => launched.push('app'),
    acceptIosOpenDialog: async () => {},
    connectExact: async () => ({
      targetId: 'target-a',
      connectionGeneration: 1,
      deviceId: 'IOS-UUID',
      metroPort,
    }),
    readMarker: async () => ({ status: 'signed', marker }),
  });

  await assert.rejects(pinExactDevClient(input, dependencies(8099)), /METRO_ORIGIN_MISMATCH/);
  assert.deepEqual(launched, ['url']);

  const exact = await pinExactDevClient(input, dependencies());
  assert.equal(exact.targetId, 'target-a');
  assert.deepEqual(launched, ['url', 'url']);
});
