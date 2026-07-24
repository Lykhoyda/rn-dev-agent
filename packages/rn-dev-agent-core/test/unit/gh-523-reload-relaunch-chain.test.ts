import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createReloadHandler, recoverAfterFailedReconnect } from '../../dist/tools/reload.js';

function mockClient({
  platform = 'ios',
  appId = 'com.example.app',
  connected = true,
  autoConnectFails = false,
  softReconnectFails = false,
} = {}) {
  return {
    metroPort: 8193,
    isConnected: connected,
    connectedTarget: { id: 'target', platform, description: appId },
    proxyDesired: false,
    helpersInjected: true,
    async disconnect() {
      this.isConnected = false;
    },
    async autoConnect() {
      if (autoConnectFails) throw new Error('no exact target');
      this.isConnected = true;
    },
    async softReconnect() {
      if (softReconnectFails) throw new Error('no exact target');
      this.isConnected = true;
    },
    async evaluate() {
      throw new Error('WebSocket closed');
    },
    async reinjectHelpers() {
      return true;
    },
  };
}

function harness(factories) {
  let current = mockClient();
  return {
    getClient: () => current,
    setClient: (value) => {
      current = value;
    },
    createClient: () => factories.shift()(),
  };
}

const captured = (platform = 'ios') => ({
  port: 8193,
  platform,
  bundleId: 'com.example.app',
  proxyWasActive: false,
});

test('force reconnect success does not invoke native recovery', async () => {
  const h = harness([() => mockClient()]);
  const calls = [];
  const result = await recoverAfterFailedReconnect(
    h.getClient,
    h.setClient,
    h.createClient,
    captured(),
    {
      execFile: async (command, args) => {
        calls.push([command, ...args]);
        return { stdout: '', stderr: '' };
      },
    },
    {
      deviceId: 'A7D2C7C9-A7DE-474D-95F2-7D2DF0EE44D3',
      appId: 'com.example.app',
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.via, 'force_reconnect');
  assert.equal(calls.length, 0);
});

test('iOS recovery uses only the exact authority target before reconnecting', async () => {
  const h = harness([
    () => mockClient({ autoConnectFails: true }),
    () => mockClient({ autoConnectFails: true }),
    () => mockClient(),
  ]);
  const calls = [];
  const result = await recoverAfterFailedReconnect(
    h.getClient,
    h.setClient,
    h.createClient,
    captured(),
    {
      execFile: async (command, args) => {
        calls.push([command, ...args]);
        return { stdout: '', stderr: '' };
      },
      sleep: async () => {},
    },
    {
      deviceId: 'A7D2C7C9-A7DE-474D-95F2-7D2DF0EE44D3',
      appId: 'com.example.app',
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.via, 'terminate_launch');
  assert.deepEqual(calls, [
    ['xcrun', 'simctl', 'terminate', 'A7D2C7C9-A7DE-474D-95F2-7D2DF0EE44D3', 'com.example.app'],
    ['xcrun', 'simctl', 'launch', 'A7D2C7C9-A7DE-474D-95F2-7D2DF0EE44D3', 'com.example.app'],
  ]);
});

test('Android recovery uses adb -s with the exact authority target', async () => {
  const h = harness([
    () => mockClient({ platform: 'android', autoConnectFails: true }),
    () => mockClient({ platform: 'android', autoConnectFails: true }),
    () => mockClient({ platform: 'android' }),
  ]);
  const calls = [];
  const result = await recoverAfterFailedReconnect(
    h.getClient,
    h.setClient,
    h.createClient,
    captured('android'),
    {
      execFile: async (command, args) => {
        calls.push([command, ...args]);
        return { stdout: '', stderr: '' };
      },
      sleep: async () => {},
    },
    { deviceId: 'emulator-5556', appId: 'com.example.app' },
  );

  assert.equal(result.ok, true);
  assert.deepEqual(calls[0], [
    'adb',
    '-s',
    'emulator-5556',
    'shell',
    'am',
    'force-stop',
    'com.example.app',
  ]);
  assert.equal(calls[1][0], 'adb');
  assert.equal(calls[1][2], 'emulator-5556');
});

test('missing exact authority never falls back to captured, persisted, or booted state', async () => {
  const h = harness([
    () => mockClient({ autoConnectFails: true }),
    () => mockClient({ autoConnectFails: true }),
  ]);
  const calls = [];
  const result = await recoverAfterFailedReconnect(
    h.getClient,
    h.setClient,
    h.createClient,
    captured(),
    {
      execFile: async (command, args) => {
        calls.push([command, ...args]);
        return { stdout: '', stderr: '' };
      },
      sleep: async () => {},
    },
  );

  assert.equal(result.ok, false);
  assert.match(result.relaunchSteps.join('|'), /no-exact-authority-target/);
  assert.equal(calls.length, 0);
});

test('reload recovery failure is a typed error rather than reconnected:false success', async () => {
  const initial = mockClient({ softReconnectFails: true });
  const h = harness([
    () => mockClient({ autoConnectFails: true }),
    () => mockClient({ autoConnectFails: true }),
  ]);
  h.setClient(initial);
  const handler = createReloadHandler(h.getClient, h.setClient, h.createClient, {
    execFile: async (_command, args) => {
      if (args.includes('launch')) throw new Error('launch denied');
      return { stdout: '', stderr: '' };
    },
    sleep: async () => {},
  });

  const result = await handler({
    full: true,
    deviceId: 'A7D2C7C9-A7DE-474D-95F2-7D2DF0EE44D3',
    appId: 'com.example.app',
  });
  const parsed = JSON.parse(result.content[0].text);

  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, 'RECONNECT_TIMEOUT');
  assert.equal(parsed.meta.reconnected, false);
  assert.equal(result.isError, true);
});
