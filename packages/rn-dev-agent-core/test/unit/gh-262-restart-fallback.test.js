import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRestartHandler } from '../../dist/tools/restart.js';

function envelope(result) {
  return JSON.parse(result.content[0].text);
}

function harness(dependencies = {}) {
  const calls = [];
  const oldClient = {
    metroPort: 8193,
    isConnected: true,
    connectedTarget: null,
    async disconnect() {},
  };
  const nextClient = {
    metroPort: 8193,
    isConnected: true,
    connectedTarget: {
      id: 'new-target',
      platform: 'ios',
      description: 'com.bound.app',
    },
    async autoConnect() {},
  };
  let current = oldClient;
  return {
    calls,
    handler: createRestartHandler(
      () => current,
      (value) => {
        current = value;
      },
      () => nextClient,
      {
        execFile: async (command, args) => {
          calls.push([command, ...args]);
          return { stdout: '', stderr: '' };
        },
        stopFastRunner: () => {},
        sleep: async () => {},
        ...dependencies,
      },
    ),
  };
}

test('app.json, active-session, cache, and persisted fallbacks cannot authorize hard reset', async () => {
  let resolverCalls = 0;
  let sessionCalls = 0;
  let persistedCalls = 0;
  const { handler, calls } = harness({
    resolveBundleIdStrict: () => {
      resolverCalls += 1;
      return 'com.fallback.app';
    },
    getSession: () => {
      sessionCalls += 1;
      return {
        platform: 'ios',
        deviceId: 'booted',
        appId: 'com.fallback.app',
      };
    },
    loadPersistedBundleId: () => {
      persistedCalls += 1;
      return 'com.persisted.app';
    },
  });

  const result = envelope(
    await handler({
      hardReset: true,
      platform: 'ios',
      deviceId: 'A7D2C7C9-A7DE-474D-95F2-7D2DF0EE44D3',
    }),
  );

  assert.equal(result.code, 'APP_INSTALL_IDENTITY_CHANGED');
  assert.equal(resolverCalls, 0);
  assert.equal(sessionCalls, 0);
  assert.equal(persistedCalls, 0);
  assert.equal(calls.length, 0);
});

test('an explicit compatibility bundleId still needs an exact device', async () => {
  const { handler, calls } = harness();
  const result = envelope(
    await handler({
      hardReset: true,
      platform: 'ios',
      deviceId: 'booted',
      bundleId: 'com.bound.app',
    }),
  );

  assert.equal(result.code, 'DEVICE_AUTHORITY_MISMATCH');
  assert.equal(calls.length, 0);
});

test('invalid app identity never reaches a native process argv', async () => {
  const { handler, calls } = harness();
  const result = envelope(
    await handler({
      hardReset: true,
      platform: 'ios',
      deviceId: 'A7D2C7C9-A7DE-474D-95F2-7D2DF0EE44D3',
      appId: 'rm -rf /',
    }),
  );

  assert.equal(result.code, 'APP_INSTALL_IDENTITY_CHANGED');
  assert.equal(calls.length, 0);
});
