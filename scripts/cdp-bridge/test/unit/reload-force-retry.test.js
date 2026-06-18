import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureClientState, forceReconnect } from '../../dist/tools/reload.js';

// Mock CDPClient with the surface forceReconnect / captureClientState consume.
// `autoConnectImpl` runs on the NEW client created via createClient() — not the old one.
function makeMockClient(opts = {}) {
  const {
    port = 8081,
    target = null,
    proxyDesired = false,
    disconnectImpl,
    autoConnectImpl,
  } = opts;

  const calls = { disconnect: 0, autoConnect: 0, lastFilters: undefined };
  let connectedTarget = target;

  const client = {
    get metroPort() { return port; },
    get connectedTarget() { return connectedTarget; },
    get proxyDesired() { return proxyDesired; },
    disconnect: async () => {
      calls.disconnect += 1;
      if (disconnectImpl) return disconnectImpl();
    },
    autoConnect: async (portHint, filters) => {
      calls.autoConnect += 1;
      calls.lastFilters = filters;
      if (autoConnectImpl) {
        const result = await autoConnectImpl(portHint, filters);
        if (result && result.connectedTarget !== undefined) {
          connectedTarget = result.connectedTarget;
        }
        return result?.message ?? 'connected';
      }
      return 'connected';
    },
  };

  return { client, calls };
}

// ── captureClientState ─────────────────────────────────────────────────

test('captureClientState: captures port, platform, bundleId from connectedTarget', () => {
  const { client } = makeMockClient({
    port: 19000,
    target: { id: 'page-1', platform: 'android', description: 'com.example.app' },
    proxyDesired: true,
  });
  const captured = captureClientState(client);
  assert.equal(captured.port, 19000);
  assert.equal(captured.platform, 'android');
  assert.equal(captured.bundleId, 'com.example.app');
  assert.equal(captured.proxyWasActive, true);
});

test('captureClientState: handles null connectedTarget', () => {
  const { client } = makeMockClient({ port: 8081, target: null });
  const captured = captureClientState(client);
  assert.equal(captured.port, 8081);
  assert.equal(captured.platform, undefined);
  assert.equal(captured.bundleId, undefined);
  assert.equal(captured.proxyWasActive, false);
});

test('captureClientState: target without description yields undefined bundleId', () => {
  const { client } = makeMockClient({
    target: { id: 'page-1', platform: 'ios' },
  });
  const captured = captureClientState(client);
  assert.equal(captured.platform, 'ios');
  assert.equal(captured.bundleId, undefined);
});

// ── forceReconnect helper ──────────────────────────────────────────────

test('forceReconnect: happy path — disposes old, creates fresh, autoConnects, returns ok', async () => {
  const { client: oldClient, calls: oldCalls } = makeMockClient({
    port: 8081,
    target: { id: 'old-1', platform: 'ios', description: 'com.app' },
    proxyDesired: false,
  });
  const { client: newClient, calls: newCalls } = makeMockClient({
    port: 8081,
    autoConnectImpl: async () => ({
      connectedTarget: { id: 'new-1', platform: 'ios', description: 'com.app' },
    }),
  });

  let current = oldClient;
  const setClient = (c) => { current = c; };
  const createClient = () => newClient;

  const captured = captureClientState(oldClient);
  const result = await forceReconnect(oldClient, setClient, createClient, captured);

  assert.equal(result.ok, true);
  assert.equal(result.platformMatched, true);
  assert.equal(result.finalPlatform, 'ios');
  assert.equal(oldCalls.disconnect, 1, 'old client disconnected once');
  assert.equal(newCalls.autoConnect, 1, 'new client autoConnect called once');
  assert.equal(current, newClient, 'setClient swapped to new instance');
});

test('forceReconnect: passes { platform, bundleId } and NO targetId to autoConnect', async () => {
  const { client: oldClient } = makeMockClient({
    port: 8081,
    target: { id: 'stale-target-id', platform: 'android', description: 'com.example' },
  });
  const { client: newClient, calls: newCalls } = makeMockClient({
    autoConnectImpl: async () => ({
      connectedTarget: { id: 'fresh-id', platform: 'android', description: 'com.example' },
    }),
  });

  let _current = oldClient;
  const captured = captureClientState(oldClient);
  await forceReconnect(oldClient, (c) => { _current = c; }, () => newClient, captured);

  const filters = newCalls.lastFilters;
  assert.equal(filters.platform, 'android');
  assert.equal(filters.bundleId, 'com.example');
  assert.equal(filters.targetId, undefined, 'targetId must NOT be forwarded — changes after rebuild');
});

test('forceReconnect: autoConnect rejects → returns ok:false with reason and orphan-replaces', async () => {
  const { client: oldClient } = makeMockClient({
    port: 8081,
    target: { id: 'p', platform: 'ios' },
  });
  // First instance rejects on autoConnect; second is the orphan-replacement.
  const instances = [
    makeMockClient({ autoConnectImpl: async () => { throw new Error('discovery failed'); } }).client,
    makeMockClient({ port: 8081 }).client,
  ];
  let createIdx = 0;
  let current = oldClient;
  const captured = captureClientState(oldClient);

  const result = await forceReconnect(
    oldClient,
    (c) => { current = c; },
    () => instances[createIdx++],
    captured,
  );

  assert.equal(result.ok, false);
  assert.match(result.reason, /discovery failed/);
  assert.equal(createIdx, 2, 'createClient called twice — attempt + orphan-replace');
  assert.equal(current, instances[1], 'setClient installed the replacement instance');
});

// tick() is synchronous in node:test MockTimers (no tickAsync until 22.6+);
// we drain microtasks explicitly so awaited timer rejections settle.
async function drainMicrotasks(rounds = 5) {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

test('forceReconnect: autoConnect hangs → 10s timeout fires, orphan disposed, fresh client installed', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const { client: oldClient } = makeMockClient({
    port: 8081,
    target: { id: 'p', platform: 'ios' },
  });

  const hangingInstance = makeMockClient({
    autoConnectImpl: () => new Promise(() => {}),
  });
  const replacementInstance = makeMockClient({ port: 8081 });

  let current = oldClient;
  const instances = [hangingInstance.client, replacementInstance.client];
  let createIdx = 0;
  const captured = captureClientState(oldClient);

  const promise = forceReconnect(
    oldClient,
    (c) => { current = c; },
    () => instances[createIdx++],
    captured,
  );

  // Disconnect race (2s) — old client's disconnect returns immediately so it resolves on its own,
  // but the timer needs to be cleared. Tick past it to be safe.
  t.mock.timers.tick(2_001);
  await drainMicrotasks();
  // Force-reconnect timeout (10s) — fires the rejection that orphan-handles.
  t.mock.timers.tick(10_001);
  await drainMicrotasks();

  const result = await promise;
  assert.equal(result.ok, false);
  assert.match(result.reason, /force_reconnect timeout/);
  assert.equal(hangingInstance.calls.disconnect, 1, 'orphan (hung) instance was disposed');
  assert.equal(createIdx, 2, 'createClient called twice — attempt + orphan-replace');
  assert.equal(current, replacementInstance.client, 'final installed client is the replacement, not the orphan');

  t.mock.timers.reset();
});

test('forceReconnect: disconnect() hangs >2s → still proceeds to install fresh client', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const { client: oldClient } = makeMockClient({
    port: 8081,
    target: { id: 'p', platform: 'ios' },
    disconnectImpl: () => new Promise(() => {}),
  });
  const { client: newClient } = makeMockClient({
    autoConnectImpl: async () => ({
      connectedTarget: { id: 'new', platform: 'ios' },
    }),
  });

  let current = oldClient;
  const captured = captureClientState(oldClient);
  const promise = forceReconnect(
    oldClient,
    (c) => { current = c; },
    () => newClient,
    captured,
  );

  // Disconnect race fires its 2s timeout — the .catch(swallow) absorbs it,
  // and forceReconnect proceeds to createClient + autoConnect (which resolves immediately).
  t.mock.timers.tick(2_001);
  await drainMicrotasks();

  const result = await promise;
  assert.equal(result.ok, true, 'force-reconnect proceeded despite hanging disconnect');
  assert.equal(current, newClient, 'fresh client installed');

  t.mock.timers.reset();
});

test('forceReconnect: platform mismatch surfaces in result (recovered to wrong platform)', async () => {
  const { client: oldClient } = makeMockClient({
    port: 8081,
    target: { id: 'p', platform: 'ios', description: 'com.app' },
  });
  const { client: newClient } = makeMockClient({
    autoConnectImpl: async () => ({
      connectedTarget: { id: 'q', platform: 'android', description: 'com.app' },
    }),
  });

  let _current = oldClient;
  const captured = captureClientState(oldClient);
  const result = await forceReconnect(oldClient, (c) => { _current = c; }, () => newClient, captured);

  assert.equal(result.ok, true);
  assert.equal(result.platformMatched, false, 'iOS captured but recovered onto Android');
  assert.equal(result.finalPlatform, 'android');
});

test('forceReconnect: captured platform=undefined → platformMatched=true regardless', async () => {
  const { client: oldClient } = makeMockClient({
    port: 8081,
    target: null,
  });
  const { client: newClient } = makeMockClient({
    autoConnectImpl: async () => ({
      connectedTarget: { id: 'q', platform: 'android' },
    }),
  });

  const captured = captureClientState(oldClient);
  const result = await forceReconnect(oldClient, () => {}, () => newClient, captured);

  assert.equal(result.ok, true);
  assert.equal(result.platformMatched, true, 'no captured platform → no constraint to match');
  assert.equal(result.finalPlatform, 'android');
});
