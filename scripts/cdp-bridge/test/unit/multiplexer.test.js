import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import {
  CDPMultiplexer,
  parseRNVersion,
  supportsNativeMultiDebugger,
} from '../../dist/cdp/multiplexer.js';
import { createOpenDevToolsHandler } from '../../dist/tools/open-devtools.js';
import { createMockClient } from '../helpers/mock-cdp-client.js';
import { makeMockHermes } from '../helpers/mock-hermes.js';
import { expectOk, expectFail } from '../helpers/result-helpers.js';

// ── Pure helpers: parseRNVersion / supportsNativeMultiDebugger ──

test('parseRNVersion: accepts RN PlatformConstants object shape', () => {
  const v = parseRNVersion({ major: 0, minor: 76, patch: 7, prerelease: null });
  assert.deepEqual(v, { major: 0, minor: 76, patch: 7 });
});

test('parseRNVersion: accepts semver string shape (future-proof)', () => {
  assert.deepEqual(parseRNVersion('0.85.0'), { major: 0, minor: 85, patch: 0 });
  assert.deepEqual(parseRNVersion('1.0.0-rc.1'), { major: 1, minor: 0, patch: 0 });
});

test('parseRNVersion: returns null for unparseable shapes', () => {
  assert.equal(parseRNVersion(null), null);
  assert.equal(parseRNVersion(undefined), null);
  assert.equal(parseRNVersion(42), null);
  assert.equal(parseRNVersion({}), null);
  assert.equal(parseRNVersion({ major: '0', minor: 76, patch: 7 }), null, 'string major rejected');
  assert.equal(parseRNVersion('not-a-version'), null);
});

test('supportsNativeMultiDebugger: RN < 0.85 returns false', () => {
  assert.equal(supportsNativeMultiDebugger({ major: 0, minor: 76, patch: 7 }), false);
  assert.equal(supportsNativeMultiDebugger({ major: 0, minor: 84, patch: 99 }), false);
  assert.equal(supportsNativeMultiDebugger('0.79.0'), false);
});

test('supportsNativeMultiDebugger: RN >= 0.85 returns true', () => {
  assert.equal(supportsNativeMultiDebugger({ major: 0, minor: 85, patch: 0 }), true);
  assert.equal(supportsNativeMultiDebugger({ major: 0, minor: 90, patch: 3 }), true);
  assert.equal(supportsNativeMultiDebugger('0.85.1'), true);
});

test('supportsNativeMultiDebugger: RN 1.x+ always returns true', () => {
  assert.equal(supportsNativeMultiDebugger({ major: 1, minor: 0, patch: 0 }), true);
  assert.equal(supportsNativeMultiDebugger({ major: 2, minor: 5, patch: 3 }), true);
});

test('supportsNativeMultiDebugger: unknown shapes fall back to false (conservative — use proxy)', () => {
  assert.equal(supportsNativeMultiDebugger(null), false);
  assert.equal(supportsNativeMultiDebugger(undefined), false);
  assert.equal(supportsNativeMultiDebugger({}), false);
});

// ── CDPMultiplexer: full integration tests with real WS ──
// (makeMockHermes lives in ../helpers/mock-hermes.js — shared across proxy tests.)

function connectConsumer(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function waitForMessage(ws, predicate = () => true) {
  return new Promise((resolve) => {
    const handler = (data) => {
      const msg = JSON.parse(data.toString());
      if (predicate(msg)) {
        ws.off('message', handler);
        resolve(msg);
      }
    };
    ws.on('message', handler);
  });
}

test('CDPMultiplexer: start returns bound port, isRunning becomes true', async () => {
  const hermes = await makeMockHermes();
  const proxy = new CDPMultiplexer({ hermesUrl: hermes.url });
  try {
    const port = await proxy.start();
    assert.ok(port > 0, `bound port should be > 0, got ${port}`);
    assert.equal(proxy.port, port);
    assert.equal(proxy.isRunning, true);
    assert.equal(proxy.consumerCount, 0);
  } finally {
    await proxy.stop();
    await hermes.stop();
  }
});

test('CDPMultiplexer: forwards a request and routes the response back with original id', async () => {
  const hermes = await makeMockHermes();
  const proxy = new CDPMultiplexer({ hermesUrl: hermes.url });
  try {
    const port = await proxy.start();
    const consumer = await connectConsumer(port);

    const waitForResponse = waitForMessage(consumer, (m) => m.id === 42);
    consumer.send(JSON.stringify({ id: 42, method: 'Runtime.evaluate', params: { expression: '1+1' } }));

    const response = await waitForResponse;
    assert.equal(response.id, 42, 'response id matches consumer original id');
    assert.equal(response.result.echo, 'Runtime.evaluate');

    // Hermes should have received a DIFFERENT (rewritten) id
    assert.equal(hermes.received.length, 1);
    const upstream = JSON.parse(hermes.received[0]);
    assert.notEqual(upstream.id, 42, 'upstream id should be rewritten, not 42');
    assert.equal(typeof upstream.id, 'number');

    consumer.close();
  } finally {
    await proxy.stop();
    await hermes.stop();
  }
});

test('CDPMultiplexer: two consumers with same id do not collide — responses route correctly', async () => {
  const hermes = await makeMockHermes();
  const proxy = new CDPMultiplexer({ hermesUrl: hermes.url });
  try {
    const port = await proxy.start();
    const c1 = await connectConsumer(port);
    const c2 = await connectConsumer(port);

    const w1 = waitForMessage(c1, (m) => m.id === 7);
    const w2 = waitForMessage(c2, (m) => m.id === 7);

    // Both consumers send id=7 — the proxy must allocate distinct upstream ids.
    c1.send(JSON.stringify({ id: 7, method: 'Domain.a', params: { from: 'c1' } }));
    c2.send(JSON.stringify({ id: 7, method: 'Domain.b', params: { from: 'c2' } }));

    const [r1, r2] = await Promise.all([w1, w2]);
    assert.equal(r1.id, 7);
    assert.equal(r2.id, 7);
    assert.equal(r1.result.echo, 'Domain.a', 'c1 received its own response, not c2\'s');
    assert.equal(r2.result.echo, 'Domain.b', 'c2 received its own response, not c1\'s');

    c1.close();
    c2.close();
  } finally {
    await proxy.stop();
    await hermes.stop();
  }
});

test('CDPMultiplexer: events (no id) broadcast to all consumers', async () => {
  const hermes = await makeMockHermes();
  const proxy = new CDPMultiplexer({ hermesUrl: hermes.url });
  try {
    const port = await proxy.start();
    const c1 = await connectConsumer(port);
    const c2 = await connectConsumer(port);

    // Give the proxy a beat to register both consumers
    await new Promise((r) => setTimeout(r, 50));

    const w1 = waitForMessage(c1, (m) => m.method === 'Runtime.consoleAPICalled');
    const w2 = waitForMessage(c2, (m) => m.method === 'Runtime.consoleAPICalled');

    hermes.emit({ method: 'Runtime.consoleAPICalled', params: { type: 'log' } });

    const [m1, m2] = await Promise.all([w1, w2]);
    assert.equal(m1.method, 'Runtime.consoleAPICalled');
    assert.equal(m2.method, 'Runtime.consoleAPICalled');
    assert.deepEqual(m1.params, { type: 'log' });

    c1.close();
    c2.close();
  } finally {
    await proxy.stop();
    await hermes.stop();
  }
});

test('CDPMultiplexer: consumer count increments on connect, decrements on disconnect', async () => {
  const hermes = await makeMockHermes();
  const proxy = new CDPMultiplexer({ hermesUrl: hermes.url });
  try {
    const port = await proxy.start();
    assert.equal(proxy.consumerCount, 0);

    const c1 = await connectConsumer(port);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(proxy.consumerCount, 1);

    const c2 = await connectConsumer(port);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(proxy.consumerCount, 2);

    c1.close();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(proxy.consumerCount, 1);

    c2.close();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(proxy.consumerCount, 0);
  } finally {
    await proxy.stop();
    await hermes.stop();
  }
});

test('CDPMultiplexer: stop is idempotent — safe to call twice', async () => {
  const hermes = await makeMockHermes();
  const proxy = new CDPMultiplexer({ hermesUrl: hermes.url });
  await proxy.start();
  await proxy.stop();
  await proxy.stop(); // should not throw
  assert.equal(proxy.isRunning, false);
  assert.equal(proxy.port, null);
  await hermes.stop();
});

test('CDPMultiplexer: start throws if already running', async () => {
  const hermes = await makeMockHermes();
  const proxy = new CDPMultiplexer({ hermesUrl: hermes.url });
  try {
    await proxy.start();
    await assert.rejects(() => proxy.start(), /cannot start from state 'running'/);
  } finally {
    await proxy.stop();
    await hermes.stop();
  }
});

test('CDPMultiplexer: start rejects if Hermes is unreachable', async () => {
  // Point at a port where nothing is listening
  const proxy = new CDPMultiplexer({ hermesUrl: 'ws://127.0.0.1:59999/nonexistent' });
  await assert.rejects(() => proxy.start(), /ECONNREFUSED|connect/);
  assert.equal(proxy.isRunning, false);
});

test('CDPMultiplexer: drops messages with non-numeric ids without crashing', async () => {
  const hermes = await makeMockHermes();
  const proxy = new CDPMultiplexer({ hermesUrl: hermes.url });
  try {
    const port = await proxy.start();
    const consumer = await connectConsumer(port);

    consumer.send('this is not json');
    consumer.send(JSON.stringify({ method: 'Runtime.somePing' })); // no id — forwarded as-is
    consumer.send(JSON.stringify({ id: 'not-a-number', method: 'X' })); // id non-numeric — forwarded as-is with id unchanged

    await new Promise((r) => setTimeout(r, 100));
    // Hermes should have received the two JSON messages (second and third) but not the non-JSON.
    assert.ok(hermes.received.length >= 2, `expected >= 2 hermes messages, got ${hermes.received.length}`);

    consumer.close();
  } finally {
    await proxy.stop();
    await hermes.stop();
  }
});

// ── cdp_open_devtools tool handler ──

test('cdp_open_devtools: fails when not connected', async () => {
  const client = createMockClient({ _isConnected: false });
  const handler = createOpenDevToolsHandler(() => client);
  const err = expectFail(await handler({}));
  assert.match(err, /not connected/i);
});

test('cdp_open_devtools: mode=native when RN >= 0.85 (no proxy started)', async () => {
  const client = createMockClient({
    async evaluate() {
      return { value: JSON.stringify({ major: 0, minor: 85, patch: 0 }) };
    },
  });
  const handler = createOpenDevToolsHandler(() => client);
  const data = expectOk(await handler({}));
  assert.equal(data.mode, 'native');
  assert.equal(data.supportsMultipleDebuggers, true);
  assert.ok(data.devtoolsUrl !== null, 'devtoolsUrl populated in native mode');
  assert.match(data.inspectorWsUrl, /^ws:\/\/127\.0\.0\.1:8081/);
  assert.equal(data.inspectorWsUrl, data.hermesWsUrl, 'native mode: inspector and hermes URLs identical');
  assert.equal(data.proxyPort, null, 'native mode: no proxy port');
  assert.equal(client.proxyUrl, null, 'native mode does not call startProxy');
  assert.deepEqual(data.rnVersion, { major: 0, minor: 85, patch: 0 });
});

test('cdp_open_devtools: mode=proxy-active when RN < 0.85 (M1b — proxy auto-starts)', async () => {
  const client = createMockClient({
    async evaluate() {
      return { value: JSON.stringify({ major: 0, minor: 76, patch: 7 }) };
    },
  });
  const handler = createOpenDevToolsHandler(() => client);
  const data = expectOk(await handler({}));
  assert.equal(data.mode, 'proxy-active', 'proxy started automatically on RN < 0.85');
  assert.equal(data.supportsMultipleDebuggers, false);
  assert.ok(data.devtoolsUrl, 'devtoolsUrl populated (points at proxy port)');
  assert.match(data.devtoolsUrl, /ws=127\.0\.0\.1:\d+$/, 'devtoolsUrl ws= targets the proxy (no /inspector path)');
  assert.match(data.inspectorWsUrl, /^ws:\/\/127\.0\.0\.1:\d+$/, 'inspectorWsUrl is the proxy URL');
  assert.match(data.hermesWsUrl, /\/inspector\/debug\?device=/, 'hermesWsUrl is still the direct Hermes URL');
  assert.equal(typeof data.proxyPort, 'number', 'proxyPort is a bound port');
  assert.match(data.guidance, /proxy has been started|coexist/i, 'guidance reflects active-proxy state');
});

test('cdp_open_devtools: mode=proxy-active when rnVersion probe fails (conservative default)', async () => {
  const client = createMockClient({
    async evaluate() {
      return { value: 'null' }; // probe returned null — version unknown
    },
  });
  const handler = createOpenDevToolsHandler(() => client);
  const data = expectOk(await handler({}));
  assert.equal(data.mode, 'proxy-active', 'unknown version → conservative: use proxy');
  assert.equal(data.supportsMultipleDebuggers, false);
  assert.equal(data.rnVersion, null);
  assert.ok(data.devtoolsUrl, 'devtoolsUrl populated in conservative-proxy fallback');
});

test('cdp_open_devtools: failResult when startProxy throws (M1b error path)', async () => {
  const client = createMockClient({
    async evaluate() {
      return { value: JSON.stringify({ major: 0, minor: 76, patch: 7 }) };
    },
    async startProxy() {
      throw new Error('multiplexer start failed: port already in use');
    },
  });
  const handler = createOpenDevToolsHandler(() => client);
  const err = expectFail(await handler({}));
  assert.match(err, /failed to start multiplexer proxy/i);
  assert.match(err, /port already in use/i, 'underlying error is surfaced');
});

test('cdp_open_devtools: fails gracefully when no target selected', async () => {
  const client = createMockClient({ _connectedTarget: null });
  const handler = createOpenDevToolsHandler(() => client);
  const err = expectFail(await handler({}));
  assert.match(err, /no target/i);
});

// ── M1b prerequisites: buffer cap, routing sweeper, failed-start cleanup ──

function makeSilentHermes() {
  // Accepts WS, receives messages, NEVER responds. Lets us accumulate routing entries
  // that the sweeper should later evict.
  const server = createServer();
  const wss = new WebSocketServer({ server });
  const received = [];
  wss.on('connection', (ws) => {
    ws.on('message', (data) => received.push(data.toString()));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        url: `ws://127.0.0.1:${server.address().port}`,
        received,
        stop: () => new Promise((r) => { wss.close(() => server.close(() => r())); }),
      });
    });
  });
}

function makeDelayedHermes(openDelayMs) {
  // Accepts the TCP connection but delays the WS upgrade by openDelayMs.
  // This keeps the proxy's upstream hermesWs in the CONNECTING state, forcing
  // any consumer messages in that window into hermesBuffer.
  const server = createServer();
  const wss = new WebSocketServer({ noServer: true });
  const received = [];

  server.on('upgrade', (req, socket, head) => {
    setTimeout(() => {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    }, openDelayMs);
  });

  wss.on('connection', (ws) => {
    ws.on('message', (data) => received.push(data.toString()));
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        url: `ws://127.0.0.1:${server.address().port}`,
        received,
        stop: () => new Promise((r) => { wss.close(() => server.close(() => r())); }),
      });
    });
  });
}

test('CDPMultiplexer: M1b prereq — hermesBuffer drops oldest when cap exceeded during CONNECTING window', async () => {
  const hermes = await makeDelayedHermes(250);
  const proxy = new CDPMultiplexer({ hermesUrl: hermes.url, hermesBufferMaxSize: 3 });
  try {
    // Kick off start WITHOUT awaiting; the consumer server binds synchronously once
    // startConsumerServer's listen fires, but connectHermes stays pending on upgrade.
    const startPromise = proxy.start();

    // Poll for the bound port — available as soon as httpServer.listen completes.
    let port = null;
    for (let i = 0; i < 30; i++) {
      if (proxy.port !== null) { port = proxy.port; break; }
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.ok(port, 'consumer server should bind before Hermes upgrade delay expires');

    const consumer = await connectConsumer(port);

    // Flood 5 messages while hermesWs is still CONNECTING.
    for (let i = 1; i <= 5; i++) {
      consumer.send(JSON.stringify({ id: i, method: `Flood.m${i}` }));
    }

    // Buffer should be capped at 3 (oldest two dropped).
    // Small wait to let the consumer's on('message') handlers fire.
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(proxy.hermesBufferSize, 3, 'buffer size capped at hermesBufferMaxSize');

    // Wait for Hermes to open and drain the buffer.
    await startPromise;
    await new Promise((r) => setTimeout(r, 150));

    assert.equal(hermes.received.length, 3, 'exactly hermesBufferMaxSize messages reach Hermes');
    const methods = hermes.received.map((raw) => JSON.parse(raw).method);
    assert.deepEqual(methods, ['Flood.m3', 'Flood.m4', 'Flood.m5'], 'drop-oldest preserves newest');

    consumer.close();
  } finally {
    await proxy.stop();
    await hermes.stop();
  }
});

test('CDPMultiplexer: M1b prereq — routing sweeper evicts entries past routingTimeoutMs', async () => {
  const hermes = await makeSilentHermes();
  // 150ms timeout → sweeper interval = max(500, 75) = 500ms. Use slightly longer waits.
  const proxy = new CDPMultiplexer({ hermesUrl: hermes.url, routingTimeoutMs: 150 });
  try {
    const port = await proxy.start();
    const consumer = await connectConsumer(port);
    await new Promise((r) => setTimeout(r, 30));

    // Send 3 requests; Hermes swallows, so all 3 routes persist.
    for (let i = 1; i <= 3; i++) {
      consumer.send(JSON.stringify({ id: i, method: `Silent.m${i}` }));
    }
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(proxy.routingTableSize, 3, 'routes accumulate while upstream is silent');

    // Wait past timeout + one sweeper cycle. Sweeper interval is 500ms for a 150ms timeout,
    // so wait ~700ms to guarantee eviction.
    await new Promise((r) => setTimeout(r, 700));

    assert.equal(proxy.routingTableSize, 0, 'sweeper cleared all expired routes');

    consumer.close();
  } finally {
    await proxy.stop();
    await hermes.stop();
  }
});

test('CDPMultiplexer: M1b prereq — failed start cleans up fully (port released, state=stopped)', async () => {
  const proxy = new CDPMultiplexer({ hermesUrl: 'ws://127.0.0.1:59994/nope' });
  await assert.rejects(() => proxy.start(), /ECONNREFUSED|connect/);

  assert.equal(proxy.isRunning, false, 'not running after failure');
  assert.equal(proxy.port, null, 'boundPort cleared — httpServer was closed in cleanup');

  // Follow-up stop() must be a safe no-op (state === 'stopped').
  await proxy.stop();
  assert.equal(proxy.port, null);
});

test('CDPMultiplexer: consumer disconnect clears its pending routes (no response leak)', async () => {
  const hermes = await makeMockHermes();
  const proxy = new CDPMultiplexer({ hermesUrl: hermes.url });
  try {
    const port = await proxy.start();
    const c1 = await connectConsumer(port);
    const c2 = await connectConsumer(port);
    await new Promise((r) => setTimeout(r, 30));

    // c1 sends a request, then immediately disconnects.
    c1.send(JSON.stringify({ id: 99, method: 'Slow.operation' }));
    c1.close();
    await new Promise((r) => setTimeout(r, 50));

    // c2 should NOT receive c1's orphan response — it should be silently dropped.
    let leaked = false;
    c2.on('message', (data) => {
      const m = JSON.parse(data.toString());
      if (m.id === 99) leaked = true;
    });

    // Send a normal request from c2, wait for its response, then verify no leak
    const wait = waitForMessage(c2, (m) => m.id === 1);
    c2.send(JSON.stringify({ id: 1, method: 'Normal.call' }));
    await wait;

    assert.equal(leaked, false, 'c2 must not receive c1\'s orphan response');

    c2.close();
  } finally {
    await proxy.stop();
    await hermes.stop();
  }
});
