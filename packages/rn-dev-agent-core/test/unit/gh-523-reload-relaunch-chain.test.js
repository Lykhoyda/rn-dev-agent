// GH #523 sub-1: cdp_reload after a non-component module edit reliably wedged —
// Metro full-rebuilds, the old Hermes target dies, no new target registers in
// the window, and reload returned RECONNECT_TIMEOUT leaving the agent to run
// the terminate+launch sequence by hand (~8 tool calls). The fix chains
// force_reconnect → simctl terminate+launch → force_reconnect automatically.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReloadHandler, recoverAfterFailedReconnect } from '../../dist/tools/reload.js';

function makeClient({
  port = 8081,
  target = null,
  connected = false,
  autoConnectImpl,
  evaluateImpl,
  softReconnectImpl,
  helpersInjected = true,
} = {}) {
  const calls = { autoConnect: 0, disconnect: 0, softReconnect: 0 };
  const state = { connected, target };
  const client = {
    calls,
    state,
    get metroPort() {
      return port;
    },
    get isConnected() {
      return state.connected;
    },
    get connectedTarget() {
      return state.target;
    },
    get proxyDesired() {
      return false;
    },
    get helpersInjected() {
      return helpersInjected;
    },
    disconnect: async () => {
      calls.disconnect += 1;
      state.connected = false;
    },
    autoConnect: async (...args) => {
      calls.autoConnect += 1;
      if (autoConnectImpl) return autoConnectImpl(state, ...args);
      state.connected = true;
    },
    softReconnect: async () => {
      calls.softReconnect += 1;
      if (softReconnectImpl) return softReconnectImpl(state);
      throw new Error('no targets');
    },
    evaluate: async (...args) => {
      if (evaluateImpl) return evaluateImpl(state, ...args);
      throw new Error('WebSocket closed');
    },
    reinjectHelpers: async () => true,
  };
  return client;
}

function makeMockExecFile() {
  const calls = [];
  const execFile = async (cmd, args) => {
    calls.push([cmd, ...args]);
    return { stdout: '', stderr: '' };
  };
  return { execFile, calls };
}

function harness(clientFactories) {
  let current = clientFactories.shift()();
  const created = [];
  return {
    getClient: () => current,
    setClient: (c) => {
      current = c;
    },
    createClient: () => {
      const next = clientFactories.length > 0 ? clientFactories.shift()() : makeClient();
      created.push(next);
      return next;
    },
    created,
  };
}

const capturedIos = (bundleId) => ({
  port: 8081,
  platform: 'ios',
  bundleId,
  proxyWasActive: false,
});

// ── recoverAfterFailedReconnect unit behavior ──────────────────────────

test('recover: force_reconnect success short-circuits — no simctl', async () => {
  const h = harness([
    () => makeClient(),
    () => makeClient({ target: { platform: 'ios', description: 'com.example.app' } }),
  ]);
  const { execFile, calls } = makeMockExecFile();

  const out = await recoverAfterFailedReconnect(
    h.getClient,
    h.setClient,
    h.createClient,
    capturedIos('com.example.app'),
    { execFile, sleep: async () => {}, loadPersistedBundleId: () => null },
  );

  assert.equal(out.ok, true);
  assert.equal(out.via, 'force_reconnect');
  assert.equal(calls.length, 0, 'no simctl when force_reconnect works');
});

test('recover: chains terminate+launch with the captured bundleId, then reconnects', async () => {
  const failing = () =>
    makeClient({ autoConnectImpl: () => Promise.reject(new Error('no targets')) });
  const h = harness([
    () => makeClient(),
    failing, // first forceReconnect attempt
    failing, // replacement client created after the failed attempt
    () => makeClient({ target: { platform: 'ios', description: 'com.example.app' } }), // post-relaunch
  ]);
  const { execFile, calls } = makeMockExecFile();

  const out = await recoverAfterFailedReconnect(
    h.getClient,
    h.setClient,
    h.createClient,
    capturedIos('com.example.app'),
    { execFile, sleep: async () => {}, loadPersistedBundleId: () => null },
  );

  assert.equal(out.ok, true);
  assert.equal(out.via, 'terminate_launch');
  const flat = calls.map((c) => c.join(' ')).join('|');
  assert.match(flat, /simctl terminate booted com\.example\.app/);
  assert.match(flat, /simctl launch booted com\.example\.app/);
  assert.match(out.relaunchSteps.join('|'), /simctl launch com\.example\.app:ok/);
});

test('recover: falls back to the persisted store when nothing was captured', async () => {
  const failing = () =>
    makeClient({ autoConnectImpl: () => Promise.reject(new Error('no targets')) });
  const h = harness([
    () => makeClient(),
    failing,
    failing,
    () => makeClient({ target: { platform: 'ios', description: 'com.persisted.app' } }),
  ]);
  const { execFile, calls } = makeMockExecFile();

  const out = await recoverAfterFailedReconnect(
    h.getClient,
    h.setClient,
    h.createClient,
    capturedIos(undefined),
    { execFile, sleep: async () => {}, loadPersistedBundleId: () => 'com.persisted.app' },
  );

  assert.equal(out.ok, true);
  const flat = calls.map((c) => c.join(' ')).join('|');
  assert.match(flat, /simctl launch booted com\.persisted\.app/);
});

test('recover: no bundleId anywhere — relaunch skipped, failure reported', async () => {
  const failing = () =>
    makeClient({ autoConnectImpl: () => Promise.reject(new Error('no targets')) });
  const h = harness([() => makeClient(), failing, failing]);
  const { execFile, calls } = makeMockExecFile();

  const out = await recoverAfterFailedReconnect(
    h.getClient,
    h.setClient,
    h.createClient,
    capturedIos(undefined),
    { execFile, sleep: async () => {}, loadPersistedBundleId: () => null },
  );

  assert.equal(out.ok, false);
  assert.equal(calls.length, 0, 'no simctl without a bundleId');
  assert.match(out.relaunchSteps.join('|'), /skip-relaunch:no-bundleId/);
});

test('recover: android platform — relaunch skipped (simctl is iOS-only)', async () => {
  const failing = () =>
    makeClient({ autoConnectImpl: () => Promise.reject(new Error('no targets')) });
  const h = harness([() => makeClient(), failing, failing]);
  const { execFile, calls } = makeMockExecFile();

  const out = await recoverAfterFailedReconnect(
    h.getClient,
    h.setClient,
    h.createClient,
    { port: 8081, platform: 'android', bundleId: 'com.example.app', proxyWasActive: false },
    { execFile, sleep: async () => {}, loadPersistedBundleId: () => null },
  );

  assert.equal(out.ok, false);
  assert.equal(calls.length, 0);
  assert.match(out.relaunchSteps.join('|'), /skip-relaunch:platform=android/);
});

test('recover: an invalid captured bundleId never reaches simctl', async () => {
  const failing = () =>
    makeClient({ autoConnectImpl: () => Promise.reject(new Error('no targets')) });
  const h = harness([() => makeClient(), failing, failing]);
  const { execFile, calls } = makeMockExecFile();

  const out = await recoverAfterFailedReconnect(
    h.getClient,
    h.setClient,
    h.createClient,
    capturedIos('rm -rf / ; com.evil'),
    { execFile, sleep: async () => {}, loadPersistedBundleId: () => null },
  );

  assert.equal(out.ok, false);
  assert.equal(calls.length, 0, 'invalid id must not reach simctl argv');
  assert.match(out.relaunchSteps.join('|'), /skip-relaunch:no-bundleId/);
});

test('recover: simctl launch failure aborts the chain without a second reconnect', async () => {
  let autoConnects = 0;
  const failing = () =>
    makeClient({
      autoConnectImpl: () => {
        autoConnects += 1;
        return Promise.reject(new Error('no targets'));
      },
    });
  const h = harness([() => makeClient(), failing, failing, failing]);
  const calls = [];
  const execFile = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args[1] === 'launch') throw new Error('Unable to launch');
    return { stdout: '', stderr: '' };
  };

  const out = await recoverAfterFailedReconnect(
    h.getClient,
    h.setClient,
    h.createClient,
    capturedIos('com.example.app'),
    { execFile, sleep: async () => {}, loadPersistedBundleId: () => null },
  );

  assert.equal(out.ok, false);
  assert.match(out.relaunchSteps.join('|'), /simctl launch:err/);
  assert.equal(autoConnects, 1, 'no reconnect retry after a failed launch');
});

// ── handler wiring ─────────────────────────────────────────────────────

test('cdp_reload: wedged reload auto-relaunches and reports recovered_via terminate_launch', async () => {
  const failing = () =>
    makeClient({ autoConnectImpl: () => Promise.reject(new Error('no targets')) });
  const old = makeClient({
    connected: true,
    target: { platform: 'ios', description: 'com.example.app' },
    evaluateImpl: (state) => {
      state.connected = false; // reload killed the ws
      throw new Error('WebSocket closed');
    },
  });
  const post = makeClient({
    target: { platform: 'ios', description: 'com.example.app' },
    evaluateImpl: () => Promise.reject(new Error('dev menu probe unavailable')),
  });
  const h = harness([() => old, failing, failing, () => post]);
  const { execFile, calls } = makeMockExecFile();

  const handler = createReloadHandler(h.getClient, h.setClient, h.createClient, {
    execFile,
    sleep: async () => {},
    loadPersistedBundleId: () => null,
  });
  const result = await handler({ full: true });
  const envelope = JSON.parse(result.content[0].text);

  assert.equal(envelope.ok, true);
  assert.equal(envelope.data.reconnected, true);
  assert.equal(envelope.meta.recovered_via, 'terminate_launch');
  const flat = calls.map((c) => c.join(' ')).join('|');
  assert.match(flat, /simctl launch booted com\.example\.app/);
});

test('cdp_reload: failed chain surfaces the relaunch steps in the warning meta', async () => {
  const failing = () =>
    makeClient({ autoConnectImpl: () => Promise.reject(new Error('no targets')) });
  const old = makeClient({
    connected: true,
    target: { platform: 'ios', description: undefined },
    evaluateImpl: (state) => {
      state.connected = false;
      throw new Error('WebSocket closed');
    },
  });
  const h = harness([() => old, failing, failing, failing]);
  const { execFile } = makeMockExecFile();

  const handler = createReloadHandler(h.getClient, h.setClient, h.createClient, {
    execFile,
    sleep: async () => {},
    loadPersistedBundleId: () => null,
  });
  const result = await handler({ full: true });
  const envelope = JSON.parse(result.content[0].text);

  assert.equal(envelope.data.reconnected, false);
  assert.match(envelope.meta.warning, /auto-relaunch/i);
  assert.match(envelope.meta.relaunch_steps.join('|'), /skip-relaunch:no-bundleId/);
});
