import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CDPClient } from '../../dist/cdp-client.js';
import { makeMockHermes } from '../helpers/mock-hermes.js';

// M1b (Phase 100+): CDPClient proxy lifecycle tests.
//
// The guard-path tests (throws, idempotency, disconnect cleanup) use planted
// state and do not spin up real sockets. The softReconnect rollback and
// concurrency tests use a real mock Hermes so the multiplexer actually starts
// against a live WS endpoint, and stub only `softReconnect` to control the
// success/failure of the post-allocation step.

test('CDPClient.isProxyActive defaults to false before startProxy is called', () => {
  const client = new CDPClient();
  assert.equal(client.isProxyActive, false);
  assert.equal(client.proxyUrl, null);
  assert.equal(client.proxyMultiplexer, null);
});

test('CDPClient.startProxy throws when no target is connected', async () => {
  const client = new CDPClient();
  await assert.rejects(
    () => client.startProxy(),
    /startProxy requires an active CDP connection/,
  );
  // No state drift after failed guard
  assert.equal(client.isProxyActive, false);
  assert.equal(client.proxyUrl, null);
});

test('CDPClient.stopProxy is a no-op when no proxy is active', async () => {
  const client = new CDPClient();
  // Should resolve cleanly without reaching softReconnect (guarded by _proxyUrl null)
  await client.stopProxy();
  assert.equal(client.isProxyActive, false);
});

test('CDPClient.startProxy is idempotent — second call returns existing URL without double-starting', async () => {
  const client = new CDPClient();

  // Plant a fake already-active state. Skips the multiplexer-start path entirely,
  // exercising the idempotent early-return.
  // Private-field access is intentional in tests — JS sees all fields as public.
  client._proxyUrl = 'ws://127.0.0.1:45678';
  client._multiplexer = { port: 45678, stop: async () => {}, isRunning: true, consumerCount: 0 };

  const returned = await client.startProxy();
  assert.equal(returned, 'ws://127.0.0.1:45678', 'returns existing URL, does not allocate new port');
  assert.equal(client.proxyUrl, 'ws://127.0.0.1:45678', 'state unchanged');
});

test('CDPClient.disconnect tears down the multiplexer and clears proxy state (graceful shutdown)', async () => {
  const client = new CDPClient();

  let stopCalled = false;
  // Plant a fake active multiplexer. disconnect() must invoke stop() on it AND
  // clear _proxyUrl/_multiplexer — this is the SIGTERM → disconnect path.
  client._proxyUrl = 'ws://127.0.0.1:45999';
  client._multiplexer = {
    port: 45999,
    isRunning: true,
    consumerCount: 0,
    stop: async () => { stopCalled = true; },
  };

  await client.disconnect();

  assert.equal(stopCalled, true, 'multiplexer.stop was called during disconnect');
  assert.equal(client.isProxyActive, false, 'proxy state cleared');
  assert.equal(client.proxyUrl, null);
  assert.equal(client.proxyMultiplexer, null);
});

test('CDPClient.disconnect is idempotent — safe to call twice (graceful shutdown race)', async () => {
  const client = new CDPClient();

  let stopCalls = 0;
  client._proxyUrl = 'ws://127.0.0.1:45000';
  client._multiplexer = {
    port: 45000,
    isRunning: true,
    consumerCount: 0,
    stop: async () => { stopCalls++; },
  };

  await client.disconnect();
  await client.disconnect(); // Second call — must not re-stop

  assert.equal(stopCalls, 1, 'multiplexer.stop called exactly once across two disconnects');
});

test('CDPClient.disconnect tolerates multiplexer.stop() rejecting (best-effort cleanup)', async () => {
  const client = new CDPClient();

  client._proxyUrl = 'ws://127.0.0.1:45111';
  client._multiplexer = {
    port: 45111,
    isRunning: true,
    consumerCount: 0,
    stop: async () => { throw new Error('multiplexer cleanup failed'); },
  };

  // disconnect() must still complete — proxy cleanup is best-effort, not a hard requirement.
  await client.disconnect();

  assert.equal(client.isProxyActive, false, 'proxy state cleared despite stop() rejecting');
});

// ── D661 review-driven regression tests (concurrency guard + rollback path) ──

function plantConnectedTarget(client, hermesUrl) {
  client._connectedTarget = {
    id: 'page1',
    title: 'Mock',
    vm: 'Hermes',
    webSocketDebuggerUrl: hermesUrl,
    platform: 'ios',
  };
}

test('CDPClient.startProxy rolls back multiplexer when softReconnect throws (D661 rollback path)', async () => {
  const hermes = await makeMockHermes();
  const client = new CDPClient();
  plantConnectedTarget(client, hermes.url);

  // Stub softReconnect to simulate the "connection landed, but the full session
  // re-setup failed" path. This is the only branch that triggers rollback.
  client.softReconnect = async () => { throw new Error('simulated reconnect failure'); };

  await assert.rejects(() => client.startProxy(), /simulated reconnect failure/);

  // Rollback assertions: both fields null, multiplexer stopped (its port freed).
  assert.equal(client.isProxyActive, false, 'proxy state rolled back after softReconnect failure');
  assert.equal(client.proxyUrl, null, '_proxyUrl cleared');
  assert.equal(client.proxyMultiplexer, null, '_multiplexer cleared');

  // A fresh startProxy must succeed (state genuinely reset, not just nulled out).
  let reconnects = 0;
  client.softReconnect = async () => { reconnects++; };
  const url = await client.startProxy();
  assert.match(url, /^ws:\/\/127\.0\.0\.1:\d+$/, 'fresh startProxy succeeds after rollback');
  assert.equal(reconnects, 1);

  await client.disconnect();
  await hermes.stop();
});

test('CDPClient.startProxy is concurrency-safe — parallel callers share one multiplexer (D661 in-flight guard)', async () => {
  const hermes = await makeMockHermes();
  const client = new CDPClient();
  plantConnectedTarget(client, hermes.url);

  // Stub softReconnect with a small delay so both callers definitely race through
  // the guard during the multiplexer.start() await window.
  client.softReconnect = async () => {
    await new Promise((r) => setTimeout(r, 30));
  };

  const [u1, u2, u3] = await Promise.all([
    client.startProxy(),
    client.startProxy(),
    client.startProxy(),
  ]);

  assert.equal(u1, u2, 'first and second callers get identical URL');
  assert.equal(u2, u3, 'third caller also joins the same in-flight');
  assert.match(u1, /^ws:\/\/127\.0\.0\.1:\d+$/);
  assert.ok(client.proxyMultiplexer, 'exactly one multiplexer stored');
  assert.equal(client.proxyUrl, u1);

  // Second (post-resolved) call takes the already-active early return.
  const u4 = await client.startProxy();
  assert.equal(u4, u1, 'post-resolved calls return existing URL without re-allocating');

  await client.disconnect();
  await hermes.stop();
});

test('CDPClient.startProxy: after failed start, in-flight guard clears so next call retries cleanly (D661)', async () => {
  const hermes = await makeMockHermes();
  const client = new CDPClient();
  plantConnectedTarget(client, hermes.url);

  let attempts = 0;
  client.softReconnect = async () => {
    attempts++;
    if (attempts === 1) throw new Error('first attempt fails');
  };

  // First call rejects → rollback path → _startProxyInFlight cleared.
  await assert.rejects(() => client.startProxy(), /first attempt fails/);

  // Second call must create a NEW multiplexer (previous one was torn down).
  const url = await client.startProxy();
  assert.match(url, /^ws:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(attempts, 2, 'second attempt ran (in-flight cache did not poison retry)');

  await client.disconnect();
  await hermes.stop();
});
