// GH #523 sub-2: cdp_restart hardReset reads the persisted bundleId store as
// a fallback tier (after the module cache, before strict app.json) and writes
// every observed bundleId back to the store, so a fresh bridge worker can
// still relaunch the app.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  createRestartHandler,
  _resetRestartHandlerStateForTest,
} from '../../dist/tools/restart.js';
import { expectOk } from '../helpers/result-helpers.js';

beforeEach(() => {
  _resetRestartHandlerStateForTest();
});

function makeMockClient({ port = 8081, connected = false, target = null } = {}) {
  const calls = { disconnect: 0, autoConnect: 0 };
  const client = {
    get metroPort() {
      return port;
    },
    get isConnected() {
      return connected;
    },
    get connectedTarget() {
      return target;
    },
    disconnect: async () => {
      calls.disconnect += 1;
    },
    autoConnect: async () => {
      calls.autoConnect += 1;
      connected = true;
    },
  };
  return { client, calls };
}

function makeMockExecFile() {
  const calls = [];
  const execFile = async (cmd, args) => {
    calls.push([cmd, ...args]);
    return { stdout: '', stderr: '' };
  };
  return { execFile, calls };
}

const noRealWorld = {
  stopFastRunner: () => {},
  sleep: async () => {},
  resolveBundleIdStrict: () => null,
  getSession: () => null,
};

test('hardReset on a fresh bridge falls back to the persisted store bundleId', async () => {
  // Fresh bridge shape: no connectedTarget, no session, empty module cache.
  const { client: oldClient } = makeMockClient({ target: null });
  const { client: newClient } = makeMockClient();
  const { execFile, calls: execCalls } = makeMockExecFile();

  let currentClient = oldClient;
  const handler = createRestartHandler(
    () => currentClient,
    (c) => {
      currentClient = c;
    },
    () => newClient,
    {
      ...noRealWorld,
      execFile,
      loadPersistedBundleId: (platform) => (platform === 'ios' ? 'com.persisted.app' : null),
    },
  );

  const data = expectOk(await handler({ hardReset: true }));

  const flat = execCalls.map((c) => c.join(' ')).join('|');
  assert.match(flat, /simctl terminate booted com\.persisted\.app/);
  assert.match(flat, /simctl launch booted com\.persisted\.app/);
  assert.ok(
    !data.hardResetSteps.join('|').includes('skip-simctl:no-bundleId'),
    'must not degrade to the no-bundleId skip when the store has an id',
  );
  assert.equal(data.bundleId, 'com.persisted.app');
});

test('module cache outranks the persisted store', async () => {
  // First restart observes a connectedTarget → seeds the module cache.
  const withTarget = makeMockClient({
    target: { description: 'com.cached.app', platform: 'ios' },
  }).client;
  const fresh1 = makeMockClient().client;
  const fresh2 = makeMockClient().client;
  const { execFile, calls: execCalls } = makeMockExecFile();

  let currentClient = withTarget;
  const clients = [fresh1, fresh2];
  const handler = createRestartHandler(
    () => currentClient,
    (c) => {
      currentClient = c;
    },
    () => clients.shift(),
    {
      ...noRealWorld,
      execFile,
      loadPersistedBundleId: () => 'com.persisted.app',
    },
  );

  await handler({}); // soft restart seeds cache from connectedTarget
  execCalls.length = 0;
  const data = expectOk(await handler({ hardReset: true }));

  const flat = execCalls.map((c) => c.join(' ')).join('|');
  assert.match(flat, /simctl launch booted com\.cached\.app/, 'cache wins over store');
  assert.equal(data.bundleId, 'com.cached.app');
});

test('an invalid bundleId from the store is dropped, not fed to simctl', async () => {
  const { client: oldClient } = makeMockClient({ target: null });
  const { client: newClient } = makeMockClient();
  const { execFile, calls: execCalls } = makeMockExecFile();

  let currentClient = oldClient;
  const handler = createRestartHandler(
    () => currentClient,
    (c) => {
      currentClient = c;
    },
    () => newClient,
    {
      ...noRealWorld,
      execFile,
      loadPersistedBundleId: () => 'rm -rf / ; com.evil',
    },
  );

  const data = expectOk(await handler({ hardReset: true }));
  assert.equal(execCalls.length, 0, 'no simctl with an invalid id');
  assert.match(data.hardResetSteps.join('|'), /skip-simctl:invalid-bundleId/);
});

test('restart persists every observed bundleId (soft restart included)', async () => {
  const withTarget = makeMockClient({
    target: { description: 'com.observed.app', platform: 'ios' },
  }).client;
  const { client: newClient } = makeMockClient();
  const persisted = [];

  let currentClient = withTarget;
  const handler = createRestartHandler(
    () => currentClient,
    (c) => {
      currentClient = c;
    },
    () => newClient,
    {
      ...noRealWorld,
      execFile: makeMockExecFile().execFile,
      persistBundleId: (platform, bundleId) => persisted.push([platform, bundleId]),
    },
  );

  await handler({});
  assert.deepEqual(persisted, [['ios', 'com.observed.app']]);
});

test('restart persists the post-connect bundleId refresh', async () => {
  const { client: oldClient } = makeMockClient({ target: null });
  const { client: newClient } = makeMockClient();
  Object.defineProperty(newClient, 'connectedTarget', {
    get: () => ({ description: 'com.postconnect.app', platform: 'ios' }),
  });
  const persisted = [];

  let currentClient = oldClient;
  const handler = createRestartHandler(
    () => currentClient,
    (c) => {
      currentClient = c;
    },
    () => newClient,
    {
      ...noRealWorld,
      execFile: makeMockExecFile().execFile,
      persistBundleId: (platform, bundleId) => persisted.push([platform, bundleId]),
    },
  );

  await handler({});
  assert.deepEqual(persisted, [['ios', 'com.postconnect.app']]);
});
