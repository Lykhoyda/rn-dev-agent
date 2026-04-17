import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRestartHandler } from '../../dist/tools/restart.js';
import { parseEnvelope, expectOk, expectFail } from '../helpers/result-helpers.js';

// Build a mock CDPClient — only the methods cdp_restart calls.
function makeMockClient({ port = 8081, connected = false, autoConnectImpl, disconnectImpl } = {}) {
  const calls = { disconnect: 0, autoConnect: 0 };
  const client = {
    get metroPort() { return port; },
    get isConnected() { return connected; },
    disconnect: async () => {
      calls.disconnect += 1;
      if (disconnectImpl) return disconnectImpl();
    },
    autoConnect: async (portHint, platform) => {
      calls.autoConnect += 1;
      calls.lastAutoConnect = { portHint, platform };
      if (autoConnectImpl) return autoConnectImpl(portHint, platform);
      connected = true;
      return 'Connected to test';
    },
  };
  return { client, calls };
}

// ── B76 / D644: cdp_restart tool ───────────────────────────────────────

test('cdp_restart: happy path — disconnects old client, creates fresh, reconnects (B76/D644)', async () => {
  const { client: oldClient, calls: oldCalls } = makeMockClient({ port: 8081 });
  const { client: newClient, calls: newCalls } = makeMockClient({ port: 8081 });

  let currentClient = oldClient;
  const getClient = () => currentClient;
  const setClient = (c) => { currentClient = c; };
  const createClient = (port) => { newClient.__requestedPort = port; return newClient; };

  const handler = createRestartHandler(getClient, setClient, createClient);
  const data = expectOk(await handler({}));

  assert.equal(oldCalls.disconnect, 1, 'old client disconnected');
  assert.equal(newCalls.autoConnect, 1, 'new client autoConnect called');
  assert.equal(data.restarted, true);
  assert.equal(data.connected, true);
  assert.equal(data.port, 8081);
  assert.equal(currentClient, newClient, 'setClient swapped to new instance');
});

test('cdp_restart: preserves port when not overridden (B76/D644)', async () => {
  const { client: oldClient } = makeMockClient({ port: 19000 });
  const { client: newClient } = makeMockClient({ port: 19000 });

  let currentClient = oldClient;
  let requestedPort;
  const createClient = (port) => { requestedPort = port; return newClient; };

  const handler = createRestartHandler(() => currentClient, (c) => { currentClient = c; }, createClient);
  await handler({});

  assert.equal(requestedPort, 19000, 'new client uses preserved port');
});

test('cdp_restart: metroPort arg overrides preserved port (B76/D644)', async () => {
  const { client: oldClient } = makeMockClient({ port: 8081 });
  const { client: newClient } = makeMockClient({ port: 8082 });

  let currentClient = oldClient;
  let requestedPort;
  const createClient = (port) => { requestedPort = port; return newClient; };

  const handler = createRestartHandler(() => currentClient, (c) => { currentClient = c; }, createClient);
  await handler({ metroPort: 8082 });

  assert.equal(requestedPort, 8082, 'new client uses overridden port');
});

test('cdp_restart: autoConnect failure returns okResult with connectError + connected:false (B76/D644)', async () => {
  const { client: oldClient } = makeMockClient();
  const { client: newClient } = makeMockClient({
    autoConnectImpl: () => { throw new Error('Metro not found'); },
  });

  let currentClient = oldClient;
  const handler = createRestartHandler(
    () => currentClient,
    (c) => { currentClient = c; },
    () => newClient,
  );
  const data = expectOk(await handler({}));

  assert.equal(data.restarted, true);
  assert.equal(data.connected, false);
  assert.match(data.connectError, /Metro not found/);
});

test('cdp_restart: old disconnect failure is non-fatal — new client still created (B76/D644)', async () => {
  const { client: oldClient, calls: oldCalls } = makeMockClient({
    disconnectImpl: async () => { throw new Error('ws already closed'); },
  });
  const { client: newClient, calls: newCalls } = makeMockClient();

  let currentClient = oldClient;
  const handler = createRestartHandler(
    () => currentClient,
    (c) => { currentClient = c; },
    () => newClient,
  );
  const data = expectOk(await handler({}));

  assert.equal(oldCalls.disconnect, 1, 'disconnect was attempted');
  assert.equal(newCalls.autoConnect, 1, 'new client still created and connected');
  assert.equal(data.restarted, true);
});

test('cdp_restart: passes platform filter through to autoConnect (B76/D644)', async () => {
  const { client: oldClient } = makeMockClient();
  const { client: newClient, calls: newCalls } = makeMockClient();

  let currentClient = oldClient;
  const handler = createRestartHandler(
    () => currentClient,
    (c) => { currentClient = c; },
    () => newClient,
  );
  await handler({ platform: 'ios' });

  assert.equal(newCalls.lastAutoConnect.platform, 'ios');
});
