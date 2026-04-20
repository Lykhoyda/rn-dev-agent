import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { MetroEventsClient } from '../../dist/metro/events-client.js';
import { createMetroEventsHandler } from '../../dist/tools/metro-events.js';
import { createMockClient } from '../helpers/mock-cdp-client.js';
import { expectOk } from '../helpers/result-helpers.js';

function makeMockMetroEventsServer() {
  const server = createServer();
  const wss = new WebSocketServer({ server, path: '/events' });
  const connections = [];
  let totalConnectionsEver = 0;

  wss.on('connection', (ws) => {
    connections.push(ws);
    totalConnectionsEver++;
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        port,
        url: `ws://127.0.0.1:${port}`,
        emit: (event) => {
          const msg = JSON.stringify(event);
          for (const ws of connections) if (ws.readyState === 1) ws.send(msg);
        },
        /** Send raw bytes without JSON.stringify wrapping — for exercising the parse-fail branch. */
        sendRaw: (text) => {
          for (const ws of connections) if (ws.readyState === 1) ws.send(text);
        },
        /** Currently-open server-side connections. */
        connectionCount: () => connections.length,
        /** Total connections the server has EVER accepted (including ones already closed). Use for regression tests. */
        totalConnectionsEver: () => totalConnectionsEver,
        closeAllConnections: () => {
          for (const ws of connections) {
            try { ws.close(1000); } catch { /* ignore */ }
          }
          connections.length = 0;
        },
        stop: () => new Promise((r) => {
          wss.close(() => server.close(() => r()));
        }),
      });
    });
  });
}

function waitForCondition(check, timeoutMs = 2000, intervalMs = 25) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (check()) return resolve();
      if (Date.now() - start >= timeoutMs) return reject(new Error(`condition not met within ${timeoutMs}ms`));
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

// ── MetroEventsClient: lifecycle ──

test('MetroEventsClient: connects to /events and reports isConnected', async () => {
  const server = await makeMockMetroEventsServer();
  const client = new MetroEventsClient({ port: server.port });
  try {
    await client.start();
    await waitForCondition(() => client.isConnected);
    assert.equal(client.isConnected, true);
  } finally {
    client.stop();
    await server.stop();
  }
});

test('MetroEventsClient: stop is idempotent (safe to call twice)', async () => {
  const server = await makeMockMetroEventsServer();
  const client = new MetroEventsClient({ port: server.port });
  await client.start();
  await waitForCondition(() => client.isConnected);

  client.stop();
  client.stop(); // must not throw
  assert.equal(client.isConnected, false);
  await server.stop();
});

test('MetroEventsClient: start is idempotent — second call while open is a no-op', async () => {
  const server = await makeMockMetroEventsServer();
  const client = new MetroEventsClient({ port: server.port });
  try {
    await client.start();
    await waitForCondition(() => client.isConnected);
    await client.start(); // should not open a second connection
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(server.connectionCount(), 1, 'only one connection to the server');
  } finally {
    client.stop();
    await server.stop();
  }
});

test('MetroEventsClient: start against unreachable port does not throw; schedules reconnect', async () => {
  const client = new MetroEventsClient({ port: 1, maxReconnectAttempts: 1 });
  await client.start(); // must resolve without throwing
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(client.isConnected, false);
  client.stop();
});

// ── MetroEventsClient: event routing + build state tracking ──

test('MetroEventsClient: captures bundle_build_started / done / failed into ring buffer', async () => {
  const server = await makeMockMetroEventsServer();
  const client = new MetroEventsClient({ port: server.port });
  try {
    await client.start();
    await waitForCondition(() => client.isConnected);

    server.emit({ type: 'bundle_build_started', bundleOptions: {} });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(client.lastBuild?.status, 'started');
    assert.equal(client.buildErrors, 0);

    server.emit({ type: 'bundle_build_done', bundleOptions: {} });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(client.lastBuild?.status, 'done');
    assert.equal(client.buildErrors, 0);

    server.emit({ type: 'bundle_build_failed', error: { message: 'syntax error' } });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(client.lastBuild?.status, 'failed');
    assert.equal(client.buildErrors, 1);

    server.emit({ type: 'bundle_build_failed', error: { message: 'missing dep' } });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(client.buildErrors, 2, 'errors accumulate');

    const entries = client.events.getLast(10);
    assert.equal(entries.length, 4);
    assert.equal(entries[0].type, 'bundle_build_started');
    assert.equal(entries[3].type, 'bundle_build_failed');
  } finally {
    client.stop();
    await server.stop();
  }
});

test('MetroEventsClient: clearBuildErrors resets counter but preserves lastBuild', async () => {
  const server = await makeMockMetroEventsServer();
  const client = new MetroEventsClient({ port: server.port });
  try {
    await client.start();
    await waitForCondition(() => client.isConnected);

    server.emit({ type: 'bundle_build_failed', error: {} });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(client.buildErrors, 1);

    client.clearBuildErrors();
    assert.equal(client.buildErrors, 0);
    assert.equal(client.lastBuild?.status, 'failed', 'lastBuild unchanged by clearBuildErrors');
  } finally {
    client.stop();
    await server.stop();
  }
});

test('MetroEventsClient: invokes onEvent callback for every event', async () => {
  const server = await makeMockMetroEventsServer();
  const received = [];
  const client = new MetroEventsClient({
    port: server.port,
    onEvent: (e) => received.push(e),
  });
  try {
    await client.start();
    await waitForCondition(() => client.isConnected);

    server.emit({ type: 'A' });
    server.emit({ type: 'B' });
    await new Promise((r) => setTimeout(r, 30));

    assert.equal(received.length, 2);
    assert.equal(received[0].type, 'A');
    assert.equal(received[1].type, 'B');
  } finally {
    client.stop();
    await server.stop();
  }
});

test('MetroEventsClient: drops non-object JSON roots (primitives, arrays)', async () => {
  const server = await makeMockMetroEventsServer();
  const client = new MetroEventsClient({ port: server.port });
  try {
    await client.start();
    await waitForCondition(() => client.isConnected);

    // Primitive root → valid JSON but fails `typeof !== 'object'` guard
    server.sendRaw(JSON.stringify('primitive'));
    // Array root → fails Array.isArray guard
    server.sendRaw(JSON.stringify(['array']));
    // Null root → fails null guard
    server.sendRaw(JSON.stringify(null));
    await new Promise((r) => setTimeout(r, 30));

    assert.equal(client.isConnected, true);
    assert.equal(client.events.size, 0, 'none of the three non-object roots accepted');
  } finally {
    client.stop();
    await server.stop();
  }
});

test('MetroEventsClient: drops unparseable bytes silently (actual JSON.parse failure)', async () => {
  const server = await makeMockMetroEventsServer();
  const client = new MetroEventsClient({ port: server.port });
  try {
    await client.start();
    await waitForCondition(() => client.isConnected);

    // Raw garbage that cannot parse as JSON at all — exercises the catch branch
    server.sendRaw('{not json at all');
    server.sendRaw('garbage text');
    await new Promise((r) => setTimeout(r, 30));

    assert.equal(client.isConnected, true);
    assert.equal(client.events.size, 0);
  } finally {
    client.stop();
    await server.stop();
  }
});

// ── Multi-review regression guards (D656 fixes) ──

test('MetroEventsClient: D656 regression — initial connect failure does NOT double-schedule reconnect', async () => {
  // Point at an unreachable port. `ws` library fires both `error` and `close` on
  // ECONNREFUSED. Without the outcome-guard fix in connectOnce, both would call
  // scheduleReconnect, leaking one timer per cycle and doubling the attempt counter.
  // With the fix, exactly one schedule should happen per failure.
  const client = new MetroEventsClient({
    port: 1, // unreachable (ephemeral root-only on most systems; ECONNREFUSED)
    maxReconnectAttempts: 1,
  });
  await client.start();
  // Give it long enough to let both `error` and `close` fire
  await new Promise((r) => setTimeout(r, 300));
  // With the bug: attempt would be 2 (both handlers schedule). With the fix: attempt = 1.
  // After maxReconnectAttempts=1, state → 'stopped' exactly once.
  // We verify indirectly: only ONE reconnect was scheduled → the max-attempts guard
  // fires at the boundary, not 1 attempt early.
  // Also verify no double-timer leak: process.getActiveResourcesInfo().
  const activeTimers = (process.getActiveResourcesInfo?.() ?? []).filter((n) => n === 'Timeout').length;
  assert.ok(activeTimers <= 1, `expected ≤1 pending Timeout (single-schedule), got ${activeTimers}`);
  client.stop();
});

test('MetroEventsClient: D656 regression — start() during reconnecting pre-empts pending timer', async () => {
  // Scenario: client is mid-backoff (reconnectTimer pending), caller calls start()
  // again. Without the fix, start() would connectOnce while the timer still fires
  // later → two parallel connects. With the fix, start() clears the timer first.
  const server = await makeMockMetroEventsServer();
  const client = new MetroEventsClient({ port: server.port });
  try {
    // Force client into reconnecting by connecting then closing server-side
    await client.start();
    await waitForCondition(() => client.isConnected);
    server.closeAllConnections();
    await waitForCondition(() => !client.isConnected, 1000);
    // Now a reconnect timer should be pending (500ms+ exponential delay)

    // Call start() again — must pre-empt the pending timer
    await client.start();
    await waitForCondition(() => client.isConnected, 2000);

    // Wait past the delay that the pre-empted timer would have fired at (attempt 1 = ~500-1000ms)
    // to prove it actually got cleared — if NOT cleared, we'd see a 3rd connection here.
    await new Promise((r) => setTimeout(r, 1200));
    assert.equal(
      server.totalConnectionsEver(),
      2,
      'expected exactly 2 total server-side connections (initial + start-preempted reconnect); more would indicate the pending timer was not cleared',
    );
  } finally {
    client.stop();
    await server.stop();
  }
});

test('MetroEventsClient: exposes port getter for integration with CDPClient port-change detection', () => {
  const client = new MetroEventsClient({ port: 19000 });
  assert.equal(client.port, 19000);
  client.stop();
});

test('MetroEventsClient: D656 regression — stop() during CONNECTING state does not crash the process', async () => {
  // Multi-review pass 2 (Gemini 90%): ws.close() on a CONNECTING socket emits
  // 'error' asynchronously via abortHandshake. If stop() strips all listeners
  // before closing, the unhandled error crashes the process.
  //
  // This test creates a scenario where we call stop() while the ws is in
  // CONNECTING state (point at a port that accepts TCP but hangs the WS handshake),
  // then waits past the abortHandshake tick. If the fix is missing, Node throws
  // 'uncaughtException' and this test will fail with an ERR_UNHANDLED_ERROR
  // propagation into the test runner.
  //
  // We can't easily hang a real WS handshake, so we directly exercise the
  // problem shape: start() against an unreachable port, which puts ws into
  // CONNECTING briefly, then immediately call stop() and assert the process
  // is still alive and no 'uncaughtException' was observed.
  let uncaught = null;
  const handler = (err) => { uncaught = err; };
  process.once('uncaughtException', handler);

  try {
    const client = new MetroEventsClient({ port: 1, maxReconnectAttempts: 0 });
    // Don't await start() — we want to call stop() while the initial connectOnce
    // is still in CONNECTING state (start() resolves either on open or fail)
    const p = client.start();
    // Tiny delay — just enough to let the ws emit the CONNECTING state
    await new Promise((r) => setImmediate(r));
    client.stop();
    await p; // let the start promise settle

    // Give the event loop a few ticks for any async error to propagate
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    process.off('uncaughtException', handler);
  }

  assert.equal(uncaught, null, `expected no uncaughtException, got: ${uncaught?.message ?? 'none'}`);
});

// ── cdp_metro_events tool ──

test('cdp_metro_events: reports not-connected when client is null', async () => {
  const mock = createMockClient({ _metroEventsClient: null });
  const handler = createMetroEventsHandler(() => mock);
  const data = expectOk(await handler({ limit: 20, clearErrors: false }));
  assert.equal(data.eventsConnected, false);
  assert.equal(data.count, 0);
  assert.match(data.hint, /Metro events client/i);
});

test('cdp_metro_events: returns events from a live client', async () => {
  const server = await makeMockMetroEventsServer();
  const events = new MetroEventsClient({ port: server.port });
  try {
    await events.start();
    await waitForCondition(() => events.isConnected);
    server.emit({ type: 'bundle_build_started' });
    server.emit({ type: 'bundle_build_done' });
    await new Promise((r) => setTimeout(r, 40));

    const mock = createMockClient({ _metroEventsClient: events });
    const handler = createMetroEventsHandler(() => mock);
    const data = expectOk(await handler({ limit: 10, clearErrors: false }));
    assert.equal(data.eventsConnected, true);
    assert.equal(data.count, 2);
    assert.equal(data.lastBuild?.status, 'done');
    assert.equal(data.buildErrors, 0);
  } finally {
    events.stop();
    await server.stop();
  }
});

test('cdp_metro_events: type filter narrows results', async () => {
  const server = await makeMockMetroEventsServer();
  const events = new MetroEventsClient({ port: server.port });
  try {
    await events.start();
    await waitForCondition(() => events.isConnected);
    server.emit({ type: 'bundle_build_started' });
    server.emit({ type: 'bundle_build_failed' });
    server.emit({ type: 'bundle_build_failed' });
    await new Promise((r) => setTimeout(r, 40));

    const mock = createMockClient({ _metroEventsClient: events });
    const handler = createMetroEventsHandler(() => mock);
    const data = expectOk(await handler({ limit: 10, type: 'bundle_build_failed', clearErrors: false }));
    assert.equal(data.count, 2);
    assert.ok(data.events.every((e) => e.type === 'bundle_build_failed'));
    assert.equal(data.buildErrors, 2);
  } finally {
    events.stop();
    await server.stop();
  }
});

test('cdp_metro_events: clearErrors resets counter via the tool', async () => {
  const server = await makeMockMetroEventsServer();
  const events = new MetroEventsClient({ port: server.port });
  try {
    await events.start();
    await waitForCondition(() => events.isConnected);
    server.emit({ type: 'bundle_build_failed' });
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(events.buildErrors, 1);

    const mock = createMockClient({ _metroEventsClient: events });
    const handler = createMetroEventsHandler(() => mock);
    const data = expectOk(await handler({ clearErrors: true }));
    assert.equal(data.cleared, true);
    assert.equal(events.buildErrors, 0);
  } finally {
    events.stop();
    await server.stop();
  }
});

// ── MetroEventsClient: reconnect on server close ──

test('MetroEventsClient: auto-reconnects after server drops the connection', async () => {
  const server = await makeMockMetroEventsServer();
  const client = new MetroEventsClient({ port: server.port });
  try {
    await client.start();
    await waitForCondition(() => client.isConnected);

    // Simulate Metro dropping the connection (not the whole server — just this WS)
    server.closeAllConnections();
    await waitForCondition(() => !client.isConnected, 1000);
    assert.equal(client.isConnected, false);

    // MetroEventsClient should auto-reconnect within a few hundred ms (attempt 1 = ~500ms + jitter)
    await waitForCondition(() => client.isConnected, 3000);
    assert.equal(client.isConnected, true);
  } finally {
    client.stop();
    await server.stop();
  }
});
