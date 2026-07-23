import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDeviceResetStateHandler } from '../../dist/tools/device-reset-state.js';

const DEVICE_ID = 'A7D2C7C9-A7DE-474D-95F2-7D2DF0EE44D3';

function client(options = {}) {
  return {
    isConnected: options.isConnected ?? true,
    helpersInjected: true,
    metroPort: 8193,
    connectedTarget: options.connectedTarget ?? { platform: 'ios', description: 'com.example.app' },
    async evaluate() {
      return { value: JSON.stringify({ deleted: true }) };
    },
    async softReconnect() {},
  };
}

function parsed(result) {
  return JSON.parse(result.content[0].text);
}

function handler(current = client()) {
  return createDeviceResetStateHandler(() => current, {
    getSession: () => ({
      platform: 'ios',
      deviceId: DEVICE_ID,
      appId: 'com.example.app',
    }),
    terminateApp: async () => {},
    launchApp: async () => {},
  });
}

test('missing appId remains an argument error', async () => {
  const result = parsed(await handler()({}));
  assert.equal(result.code, 'DEVICE_RESET_INVALID_ARGS');
});

test('missing exact device authority fails instead of using booted', async () => {
  const noSession = createDeviceResetStateHandler(() => client(), {
    getSession: () => null,
    terminateApp: async () => {
      throw new Error('must not run');
    },
  });
  const result = parsed(
    await noSession({
      appId: 'com.example.app',
      platform: 'ios',
      relaunch: false,
    }),
  );
  assert.equal(result.code, 'DEVICE_AUTHORITY_MISMATCH');
});

test('empty preflight terminates only the exact session app/device', async () => {
  const calls = [];
  const run = createDeviceResetStateHandler(() => client(), {
    getSession: () => ({
      platform: 'ios',
      deviceId: DEVICE_ID,
      appId: 'com.example.app',
    }),
    terminateApp: async (...args) => calls.push(['terminate', ...args]),
    launchApp: async (...args) => calls.push(['launch', ...args]),
  });
  const result = parsed(
    await run({
      appId: 'com.example.app',
      platform: 'ios',
      deviceId: DEVICE_ID,
      relaunch: false,
    }),
  );

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [['terminate', 'com.example.app', 'ios', DEVICE_ID]]);
  assert.deepEqual(
    result.data.steps.map((step) => step.step),
    ['terminate'],
  );
});

test('storage deletion is session-scoped and reports disconnected skips', async () => {
  const result = parsed(
    await handler(client({ isConnected: false }))({
      appId: 'com.example.app',
      platform: 'ios',
      deviceId: DEVICE_ID,
      storageKeys: ['token', 'onboarding'],
      relaunch: false,
    }),
  );

  const storage = result.data.steps.filter((step) => step.step === 'storage');
  assert.equal(storage.length, 2);
  assert.ok(storage.every((step) => step.code === 'CDP_NOT_CONNECTED'));
  assert.equal(result.data.summary.skipped, 2);
});

test('a sibling CDP app cannot have its storage mutated', async () => {
  const result = parsed(
    await handler(
      client({
        connectedTarget: {
          platform: 'ios',
          description: 'com.sibling.app',
        },
      }),
    )({
      appId: 'com.example.app',
      platform: 'ios',
      deviceId: DEVICE_ID,
      storageKeys: ['token'],
      relaunch: false,
    }),
  );

  const storage = result.data.steps.find((step) => step.step === 'storage');
  assert.equal(storage.code, 'CDP_TARGET_APP_MISMATCH');
});

test('a session bound to another app is refused before lifecycle mutation', async () => {
  const run = createDeviceResetStateHandler(() => client(), {
    getSession: () => ({
      platform: 'ios',
      deviceId: DEVICE_ID,
      appId: 'com.sibling.app',
    }),
    terminateApp: async () => {
      throw new Error('must not run');
    },
  });
  const result = parsed(
    await run({
      appId: 'com.example.app',
      platform: 'ios',
      deviceId: DEVICE_ID,
    }),
  );

  assert.equal(result.code, 'TARGET_SESSION_MISMATCH');
});
