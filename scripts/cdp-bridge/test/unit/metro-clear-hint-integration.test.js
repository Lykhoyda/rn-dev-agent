import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CDPClient } from '../../dist/cdp-client.js';
import { createMockClient } from '../helpers/mock-cdp-client.js';
import { parseEnvelope } from '../helpers/result-helpers.js';
import { createConsoleLogHandler } from '../../dist/tools/console-log.js';
import { createNetworkLogHandler } from '../../dist/tools/network-log.js';
import { METRO_CLEAR_HINT_TEXT } from '../../dist/tools/metro-clear-hint.js';

// M11 / D665 — integration tests. Cover (a) CDPClient's connectedAt/now surface
// and (b) console-log + network-log handlers emitting meta.hint when the idle
// threshold is crossed.

// ── CDPClient lifecycle surface ──

test('M11: CDPClient.connectedAt is null on a fresh instance', () => {
  const client = new CDPClient();
  assert.equal(client.connectedAt, null);
});

test('M11: CDPClient.now returns the injected timeNowFn', () => {
  const stubNow = () => 42;
  const client = new CDPClient(8081, stubNow);
  assert.equal(client.now, stubNow);
  assert.equal(client.now(), 42);
});

test('M11: CDPClient.now defaults to Date.now when no fn injected', () => {
  const client = new CDPClient();
  // Sanity: close to Date.now() at call time (within 100ms window)
  const delta = Math.abs(client.now() - Date.now());
  assert.ok(delta < 100, `expected now() near Date.now(), delta=${delta}`);
});

// ── console_log handler: hint wiring ──

function buildEntriesResponse(entries) {
  return { value: JSON.stringify({ entries }) };
}

test('M11 console_log: no hint when entries present', async () => {
  const client = createMockClient({
    evaluate: async () => buildEntriesResponse([{ level: 'log', message: 'hello' }]),
    _connectedAt: 1_000_000,
    _timeNowFn: () => 1_000_000 + 120_000, // 120s elapsed
  });
  const handler = createConsoleLogHandler(() => client);
  const result = await handler({ level: 'all', limit: 50, clear: false });
  const envelope = parseEnvelope(result);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.meta, undefined, 'no meta when entries non-empty');
});

test('M11 console_log: no hint when entries empty but < 60s since connect', async () => {
  const client = createMockClient({
    evaluate: async () => buildEntriesResponse([]),
    _connectedAt: 1_000_000,
    _timeNowFn: () => 1_000_000 + 30_000, // 30s elapsed, below threshold
  });
  const handler = createConsoleLogHandler(() => client);
  const result = await handler({ level: 'all', limit: 50, clear: false });
  const envelope = parseEnvelope(result);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.meta, undefined, 'no meta when below threshold');
});

test('M11 console_log: emits meta.hint when empty AND >60s since connect', async () => {
  const client = createMockClient({
    evaluate: async () => buildEntriesResponse([]),
    _connectedAt: 1_000_000,
    _timeNowFn: () => 1_000_000 + 90_000, // 90s elapsed, above threshold
  });
  const handler = createConsoleLogHandler(() => client);
  const result = await handler({ level: 'all', limit: 50, clear: false });
  const envelope = parseEnvelope(result);
  assert.equal(envelope.ok, true);
  assert.ok(envelope.meta, 'meta should be present');
  assert.equal(envelope.meta.hint, METRO_CLEAR_HINT_TEXT);
});

// ── network_log handler: hint wiring ──

test('M11 network_log: no hint when requests present', async () => {
  const client = createMockClient({
    _connectedAt: 1_000_000,
    _timeNowFn: () => 1_000_000 + 120_000,
  });
  // Push a fake request so buffer is non-empty
  client.networkBufferManager.push(client.activeDeviceKey, {
    id: 'req1', url: 'https://example.com', method: 'GET', timestamp: new Date().toISOString(),
  });
  const handler = createNetworkLogHandler(() => client);
  const result = await handler({ limit: 20, clear: false });
  const envelope = parseEnvelope(result);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.meta, undefined, 'no meta when requests non-empty');
});

test('M11 network_log: no hint when empty but recent push (lastEventAt within window)', async () => {
  const client = createMockClient({
    _connectedAt: 1_000_000,
    _timeNowFn: () => 1_000_000 + 120_000, // connectedAt is old
  });
  // Push then clear — so buffer is empty but lastPush is recent (Date.now() at push)
  // Mock the manager's internal lastPush by pushing then directly overwriting.
  client.networkBufferManager.push(client.activeDeviceKey, {
    id: 'req1', url: 'https://ex.com', method: 'GET', timestamp: new Date().toISOString(),
  });
  client.networkBufferManager.clear(client.activeDeviceKey);
  // After clear, the buffer is empty BUT the manager's lastPush map may still hold an entry.
  // The test's real purpose: if getLastPush returns undefined after clear, hint-fire depends
  // on connectedAt alone; if it returns a ts, hint-fire depends on max(connectedAt, lastPush).
  // Explicitly simulate "recent event observed" by spying on getLastPush.
  const originalGetLastPush = client.networkBufferManager.getLastPush.bind(client.networkBufferManager);
  client.networkBufferManager.getLastPush = (key) => {
    // Override: pretend we saw an event recently (now - 5s)
    return 1_000_000 + 115_000;
  };

  const handler = createNetworkLogHandler(() => client);
  const result = await handler({ limit: 20, clear: false });
  const envelope = parseEnvelope(result);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.meta, undefined, 'recent event should suppress hint');
  client.networkBufferManager.getLastPush = originalGetLastPush;
});

test('M11 network_log: emits meta.hint when empty AND both connectedAt + lastPush are stale', async () => {
  const client = createMockClient({
    _connectedAt: 1_000_000,
    _timeNowFn: () => 1_000_000 + 120_000, // 120s elapsed
  });
  // getLastPush returns undefined (no events ever) — fallback to connectedAt, which is old
  const handler = createNetworkLogHandler(() => client);
  const result = await handler({ limit: 20, clear: false });
  const envelope = parseEnvelope(result);
  assert.equal(envelope.ok, true);
  assert.ok(envelope.meta, 'meta should be present');
  assert.equal(envelope.meta.hint, METRO_CLEAR_HINT_TEXT);
});

test('M11 network_log: scope="all" uses connectedAt alone (no per-scope lastPush)', async () => {
  const client = createMockClient({
    _connectedAt: 1_000_000,
    _timeNowFn: () => 1_000_000 + 90_000, // 90s elapsed
  });
  const handler = createNetworkLogHandler(() => client);
  const result = await handler({ limit: 20, clear: false, device: 'all' });
  const envelope = parseEnvelope(result);
  assert.equal(envelope.ok, true);
  assert.ok(envelope.meta, 'meta should be present on empty all-scope after threshold');
  assert.equal(envelope.meta.hint, METRO_CLEAR_HINT_TEXT);
});
