import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMetroAuthorityMarker } from '../../../dist/session/metro-authority.js';
import { pinExactDevClient } from '../../../dist/session/dev-client-authority.js';

const expected = {
  sessionId: 'session-a',
  metroInstanceId: 'metro-a',
  worktreeKey: 'worktree-a',
  appId: 'com.example.app',
  platform: 'ios',
  buildGeneration: 2,
};

test('dev-client pin opens only the declared URL on the exact device and binds its target', async () => {
  const calls = [];
  const marker = createMetroAuthorityMarker(expected, 'signer');
  const binding = await pinExactDevClient(
    {
      ...expected,
      deviceId: 'IOS-UUID',
      metroPort: 8341,
      devClientUrl: 'example://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8341',
      expectedDevClientUrl: 'example://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8341',
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
  const marker = createMetroAuthorityMarker(expected, 'signer');
  const binding = await pinExactDevClient(
    {
      ...expected,
      deviceId: 'IOS-UUID',
      metroPort: 8341,
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

test('dev-client pinning rejects a target not proven on the claimed device', async () => {
  const marker = createMetroAuthorityMarker(expected, 'signer');
  await assert.rejects(
    pinExactDevClient(
      {
        ...expected,
        deviceId: 'IOS-UUID',
        metroPort: 8341,
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
