import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import {
  _resetRestartHandlerStateForTest,
  createRestartHandler,
} from '../../dist/tools/restart.js';

beforeEach(() => _resetRestartHandlerStateForTest());

function client({ port = 8193, connected = true, autoConnect, target } = {}) {
  return {
    metroPort: port,
    isConnected: connected,
    connectedTarget: target ?? {
      id: 'target',
      platform: 'ios',
      description: 'com.example.app',
    },
    async disconnect() {},
    async autoConnect(...args) {
      if (autoConnect) return autoConnect(...args);
      this.isConnected = true;
    },
  };
}

function harness(oldClient = client(), nextClient = client()) {
  let current = oldClient;
  return {
    getClient: () => current,
    setClient: (value) => {
      current = value;
    },
    createClient: () => nextClient,
  };
}

function envelope(result) {
  return JSON.parse(result.content[0].text);
}

test('soft restart reconnects with the exact platform, app, and Metro binding', async () => {
  let received;
  const next = client({
    autoConnect: async (...args) => {
      received = args;
      next.isConnected = true;
    },
  });
  const h = harness(client({ port: 8193 }), next);
  const result = await createRestartHandler(
    h.getClient,
    h.setClient,
    h.createClient,
  )({
    metroPort: 8193,
    platform: 'ios',
    deviceId: 'A7D2C7C9-A7DE-474D-95F2-7D2DF0EE44D3',
    appId: 'com.example.app',
  });

  assert.equal(envelope(result).ok, true);
  assert.deepEqual(received, [8193, { platform: 'ios', bundleId: 'com.example.app' }]);
});

test('a reconnect failure is an error, never a successful connected:false receipt', async () => {
  const next = client({
    connected: false,
    autoConnect: async () => {
      throw new Error('no exact target');
    },
  });
  const h = harness(client(), next);
  const result = await createRestartHandler(
    h.getClient,
    h.setClient,
    h.createClient,
  )({
    metroPort: 8193,
    platform: 'ios',
    deviceId: 'A7D2C7C9-A7DE-474D-95F2-7D2DF0EE44D3',
    appId: 'com.example.app',
  });

  assert.equal(envelope(result).ok, false);
  assert.equal(envelope(result).code, 'RECONNECT_TIMEOUT');
  assert.equal(result.isError, true);
});

test('iOS hard reset addresses only the exact simulator and app', async () => {
  const calls = [];
  const h = harness();
  const result = await createRestartHandler(h.getClient, h.setClient, h.createClient, {
    execFile: async (command, args) => {
      calls.push([command, ...args]);
      return { stdout: '', stderr: '' };
    },
    stopFastRunner: (deviceId) => calls.push(['stopFastRunner', deviceId]),
    sleep: async () => {},
  })({
    hardReset: true,
    metroPort: 8193,
    platform: 'ios',
    deviceId: 'A7D2C7C9-A7DE-474D-95F2-7D2DF0EE44D3',
    appId: 'com.example.app',
  });

  assert.equal(envelope(result).ok, true);
  assert.deepEqual(calls.slice(0, 3), [
    ['stopFastRunner', 'A7D2C7C9-A7DE-474D-95F2-7D2DF0EE44D3'],
    ['xcrun', 'simctl', 'terminate', 'A7D2C7C9-A7DE-474D-95F2-7D2DF0EE44D3', 'com.example.app'],
    ['xcrun', 'simctl', 'launch', 'A7D2C7C9-A7DE-474D-95F2-7D2DF0EE44D3', 'com.example.app'],
  ]);
});

test('Android hard reset uses adb -s for force-stop and launch', async () => {
  const calls = [];
  const old = client({
    target: {
      id: 'android-target',
      platform: 'android',
      description: 'com.example.app',
    },
  });
  const next = client({
    target: {
      id: 'android-target-2',
      platform: 'android',
      description: 'com.example.app',
    },
  });
  const h = harness(old, next);
  const result = await createRestartHandler(h.getClient, h.setClient, h.createClient, {
    execFile: async (command, args) => {
      calls.push([command, ...args]);
      return { stdout: '', stderr: '' };
    },
    stopFastRunner: () => {},
    sleep: async () => {},
  })({
    hardReset: true,
    metroPort: 8193,
    platform: 'android',
    deviceId: 'emulator-5556',
    appId: 'com.example.app',
  });

  assert.equal(envelope(result).ok, true);
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
  assert.equal(calls[1][1], '-s');
  assert.equal(calls[1][2], 'emulator-5556');
  assert.ok(calls[1].includes('com.example.app'));
});

test('hard reset refuses missing authority and literal booted without side effects', async () => {
  const calls = [];
  const h = harness();
  const handler = createRestartHandler(h.getClient, h.setClient, h.createClient, {
    execFile: async (command, args) => {
      calls.push([command, ...args]);
      return { stdout: '', stderr: '' };
    },
    stopFastRunner: () => {},
  });

  const missing = envelope(await handler({ hardReset: true, platform: 'ios', deviceId: 'booted' }));
  assert.equal(missing.code, 'APP_INSTALL_IDENTITY_CHANGED');

  const ambiguous = envelope(
    await handler({
      hardReset: true,
      platform: 'ios',
      deviceId: 'booted',
      appId: 'com.example.app',
    }),
  );
  assert.equal(ambiguous.code, 'DEVICE_AUTHORITY_MISMATCH');
  assert.equal(calls.length, 0);
});

test('concurrent restart returns a typed failure instead of restarted:false success', async () => {
  let release;
  const blocker = new Promise((resolve) => {
    release = resolve;
  });
  const h = harness();
  const handler = createRestartHandler(h.getClient, h.setClient, h.createClient, {
    sleep: async () => blocker,
    execFile: async () => ({ stdout: '', stderr: '' }),
    stopFastRunner: () => {},
  });
  const args = {
    hardReset: true,
    platform: 'ios',
    deviceId: 'A7D2C7C9-A7DE-474D-95F2-7D2DF0EE44D3',
    appId: 'com.example.app',
  };
  const first = handler(args);
  await new Promise((resolve) => setImmediate(resolve));
  const second = envelope(await handler(args));
  release();
  await first;

  assert.equal(second.ok, false);
  assert.equal(second.code, 'OPERATION_ALREADY_IN_PROGRESS');
});
