import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeSince,
  buildMatchPredicate,
  isComplete,
  createWaitForNetworkHandler,
} from '../../dist/tools/wait-for-network.js';
import { createMockClient } from '../helpers/mock-cdp-client.js';
import { expectOk } from '../helpers/result-helpers.js';

// GH #65 P3: cdp_wait_for_network — composite primitive that collapses the
// "fire mutation -> confirm it landed" pattern into a single tool call.
// Two-phase: retroactive buffer scan + bounded polling. Solves the
// buffer-churn trap described in IX-2950 (where 4-5 follow-up GETs pushed
// a POST out of a small filter window).
//
// Test coverage:
//   1. Pure helpers (normalizeSince, buildMatchPredicate, isComplete) — exercise
//      branch logic without spinning up withConnection.
//   2. Handler integration — verify two-phase logic against a seeded mock buffer.

// ── 1. normalizeSince ──

test('normalizeSince: ISO with offset is normalised to UTC Z-form', () => {
  const result = normalizeSince('2026-04-27T10:00:00+02:00');
  assert.equal(result, '2026-04-27T08:00:00.000Z');
});

test('normalizeSince: already-Z string is unchanged', () => {
  const iso = '2026-04-27T08:00:00.000Z';
  assert.equal(normalizeSince(iso), iso);
});

test('normalizeSince: unparseable string returned as-is (matches network-log leniency)', () => {
  assert.equal(normalizeSince('not-a-date'), 'not-a-date');
});

test('normalizeSince: numeric ms-string is unparseable (callers must pass ISO) — documents the gotcha', () => {
  // new Date('1777284000000') returns Invalid Date because Date string parser
  // does not accept bare numeric strings. Callers wanting ms-since-epoch must
  // use `new Date(ms).toISOString()` instead. Same behaviour as network-log.ts.
  const numericMs = String(Date.UTC(2026, 3, 27, 10, 0, 0));
  assert.equal(normalizeSince(numericMs), numericMs, 'returned unchanged');
  assert.equal(
    normalizeSince(new Date(Number(numericMs)).toISOString()),
    '2026-04-27T10:00:00.000Z',
    'ISO form works correctly',
  );
});

// ── 2. buildMatchPredicate ──

function makeEntry(overrides = {}) {
  return {
    id: 'req-default',
    method: 'GET',
    url: '/api/users',
    timestamp: '2026-04-27T08:00:00.000Z',
    status: 200,
    ...overrides,
  };
}

test('buildMatchPredicate: matches on url_pattern substring', () => {
  const pred = buildMatchPredicate('/api', undefined, undefined);
  assert.ok(pred(makeEntry({ url: '/api/users' })));
  assert.ok(!pred(makeEntry({ url: '/auth/login' })));
});

test('buildMatchPredicate: method filter is case-insensitive', () => {
  const pred = buildMatchPredicate('/api', 'post', undefined);
  assert.ok(pred(makeEntry({ url: '/api/cart', method: 'POST' })));
  assert.ok(!pred(makeEntry({ url: '/api/cart', method: 'GET' })));
});

test('buildMatchPredicate: method as array allows multiple verbs', () => {
  const pred = buildMatchPredicate('/api', ['POST', 'put'], undefined);
  assert.ok(pred(makeEntry({ method: 'POST' })));
  assert.ok(pred(makeEntry({ method: 'PUT' })));
  assert.ok(!pred(makeEntry({ method: 'GET' })));
});

test('buildMatchPredicate: since cutoff drops earlier entries', () => {
  const pred = buildMatchPredicate('/api', undefined, '2026-04-27T09:00:00.000Z');
  assert.ok(pred(makeEntry({ timestamp: '2026-04-27T10:00:00.000Z' })));
  assert.ok(!pred(makeEntry({ timestamp: '2026-04-27T08:00:00.000Z' })));
});

test('buildMatchPredicate: AND-combines all filters', () => {
  const pred = buildMatchPredicate('/cart', 'POST', '2026-04-27T09:00:00.000Z');
  const match = makeEntry({ url: '/api/cart', method: 'POST', timestamp: '2026-04-27T10:00:00.000Z' });
  assert.ok(pred(match));
  assert.ok(!pred({ ...match, method: 'GET' }), 'wrong method fails');
  assert.ok(!pred({ ...match, url: '/api/users' }), 'wrong url fails');
  assert.ok(!pred({ ...match, timestamp: '2026-04-27T08:00:00.000Z' }), 'pre-since fails');
});

test('buildMatchPredicate: undefined method matches any HTTP verb', () => {
  const pred = buildMatchPredicate('/api', undefined, undefined);
  assert.ok(pred(makeEntry({ method: 'DELETE' })));
  assert.ok(pred(makeEntry({ method: 'PATCH' })));
});

test('buildMatchPredicate: undefined since allows any age', () => {
  const pred = buildMatchPredicate('/api', undefined, undefined);
  assert.ok(pred(makeEntry({ timestamp: '1970-01-01T00:00:00.000Z' })));
});

test('buildMatchPredicate: in-flight entry (status undefined) still matches — gate is separate', () => {
  // Predicate intentionally does NOT include the completion gate. Pair with
  // isComplete to find completed responses; use predicate alone to also
  // surface in-flight candidates on timeout.
  const pred = buildMatchPredicate('/api', undefined, undefined);
  const inflight = { ...makeEntry({ url: '/api/slow' }), status: undefined };
  delete inflight.status;
  assert.ok(pred(inflight));
});

// ── 3. isComplete ──

test('isComplete: status defined (success) → true', () => {
  assert.ok(isComplete(makeEntry({ status: 200 })));
  assert.ok(isComplete(makeEntry({ status: 404 })));
});

test('isComplete: status=0 (Network.loadingFailed) → true (terminal failure is complete)', () => {
  assert.ok(isComplete(makeEntry({ status: 0 })));
});

test('isComplete: status undefined (request still in-flight) → false', () => {
  const inflight = { ...makeEntry() };
  delete inflight.status;
  assert.ok(!isComplete(inflight));
});

// ── 4. Handler integration tests ──

function pushEntry(client, overrides = {}) {
  const entry = makeEntry({
    id: `req-${Math.random().toString(36).slice(2, 9)}`,
    timestamp: new Date().toISOString(),
    ...overrides,
  });
  client.networkBufferManager.push(client.activeDeviceKey, entry);
  return entry;
}

test('handler: retroactive match — completed entry already in buffer returns immediately', async () => {
  const client = createMockClient();
  const past = new Date(Date.now() - 60_000).toISOString();
  pushEntry(client, { url: '/api/cart/add', method: 'POST', status: 201 });

  const handler = createWaitForNetworkHandler(() => client);
  const data = expectOk(await handler({
    url_pattern: '/api/cart',
    method: 'POST',
    since: past,
    timeout_ms: 500,
    poll_interval_ms: 50,
  }));

  assert.equal(data.matched, true);
  assert.equal(data.mutation.url, '/api/cart/add');
  assert.equal(data.mutation.status, 201);
  assert.ok(Array.isArray(data.network_log_since));
});

test('handler: timeout with no matching entries — matched:false, empty candidates_seen', async () => {
  const client = createMockClient();
  const handler = createWaitForNetworkHandler(() => client);
  const data = expectOk(await handler({
    url_pattern: '/api/never',
    timeout_ms: 150,
    poll_interval_ms: 50,
  }));

  assert.equal(data.matched, false);
  assert.equal(data.timeout_ms, 150);
  assert.deepEqual(data.candidates_seen, []);
});

test('handler: timeout with in-flight match — surfaces in-flight in candidates_seen', async () => {
  const client = createMockClient();
  const past = new Date(Date.now() - 60_000).toISOString();
  // Push an entry that matches url+method+since but lacks status (in-flight)
  const inflight = makeEntry({ id: 'req-pending', url: '/api/checkout', method: 'POST', timestamp: new Date().toISOString() });
  delete inflight.status;
  client.networkBufferManager.push(client.activeDeviceKey, inflight);

  const handler = createWaitForNetworkHandler(() => client);
  const data = expectOk(await handler({
    url_pattern: '/api/checkout',
    method: 'POST',
    since: past,
    timeout_ms: 150,
    poll_interval_ms: 50,
  }));

  assert.equal(data.matched, false);
  assert.ok(data.candidates_seen.some((e) => e.id === 'req-pending'),
    'in-flight match should appear in candidates_seen for agent self-correction');
});

test('handler: method filter excludes non-matching verbs', async () => {
  const client = createMockClient();
  const past = new Date(Date.now() - 60_000).toISOString();
  pushEntry(client, { url: '/api/cart', method: 'GET', status: 200 });

  const handler = createWaitForNetworkHandler(() => client);
  const data = expectOk(await handler({
    url_pattern: '/api/cart',
    method: 'POST',
    since: past,
    timeout_ms: 150,
    poll_interval_ms: 50,
  }));

  assert.equal(data.matched, false, 'GET should not satisfy POST filter');
});

test('handler: explicit since cutoff excludes entries older than the timestamp', async () => {
  const client = createMockClient();
  pushEntry(client, {
    url: '/api/cart',
    method: 'POST',
    status: 201,
    timestamp: '2020-01-01T00:00:00.000Z',
  });

  const handler = createWaitForNetworkHandler(() => client);
  const data = expectOk(await handler({
    url_pattern: '/api/cart',
    since: '2025-01-01T00:00:00.000Z',
    timeout_ms: 150,
    poll_interval_ms: 50,
  }));

  assert.equal(data.matched, false);
});

test('handler: omitting since means no cutoff — retroactive scan finds completed entries', async () => {
  // The Phase 1 scan needs to work without forcing the agent to capture
  // a timestamp before every trigger action. With `since` undefined, the
  // predicate has no cutoff and any matching completed entry in the
  // buffer is found immediately.
  const client = createMockClient();
  pushEntry(client, {
    url: '/api/profile/save',
    method: 'PUT',
    status: 200,
    timestamp: new Date(Date.now() - 5000).toISOString(),
  });

  const handler = createWaitForNetworkHandler(() => client);
  const data = expectOk(await handler({
    url_pattern: '/api/profile',
    method: 'PUT',
    timeout_ms: 150,
    poll_interval_ms: 50,
  }));

  assert.equal(data.matched, true);
  assert.equal(data.mutation.status, 200);
});

test('handler: candidates_seen capped at 10 even with many in-flight matches', async () => {
  const client = createMockClient();
  const past = new Date(Date.now() - 60_000).toISOString();
  for (let i = 0; i < 15; i++) {
    const inflight = makeEntry({
      id: `req-pending-${i}`,
      url: '/api/data',
      method: 'GET',
      timestamp: new Date().toISOString(),
    });
    delete inflight.status;
    client.networkBufferManager.push(client.activeDeviceKey, inflight);
  }

  const handler = createWaitForNetworkHandler(() => client);
  const data = expectOk(await handler({
    url_pattern: '/api/data',
    since: past,
    timeout_ms: 150,
    poll_interval_ms: 50,
  }));

  assert.equal(data.matched, false);
  assert.equal(data.candidates_seen.length, 10);
});

test('handler: poll match — entry completes during polling window', async () => {
  const client = createMockClient();
  const past = new Date(Date.now() - 60_000).toISOString();

  // Seed an in-flight entry that we'll mutate to "complete" mid-poll.
  const entry = makeEntry({
    id: 'req-async',
    url: '/api/profile',
    method: 'PUT',
    timestamp: new Date().toISOString(),
  });
  delete entry.status;
  client.networkBufferManager.push(client.activeDeviceKey, entry);

  // After the first poll tick, simulate Network.responseReceived by
  // mutating the entry in place — same pattern as event-handlers.ts:40.
  setTimeout(() => {
    entry.status = 200;
    entry.duration_ms = 35;
  }, 75);

  const handler = createWaitForNetworkHandler(() => client);
  const data = expectOk(await handler({
    url_pattern: '/api/profile',
    method: 'PUT',
    since: past,
    timeout_ms: 1000,
    poll_interval_ms: 50,
  }));

  assert.equal(data.matched, true);
  assert.equal(data.mutation.id, 'req-async');
  assert.equal(data.mutation.status, 200);
});

test('handler: status=0 (loadingFailed) is treated as completed and matches', async () => {
  const client = createMockClient();
  const past = new Date(Date.now() - 60_000).toISOString();
  pushEntry(client, {
    url: '/api/network-error',
    method: 'POST',
    status: 0, // Network.loadingFailed sets status=0
    duration_ms: 100,
  });

  const handler = createWaitForNetworkHandler(() => client);
  const data = expectOk(await handler({
    url_pattern: '/api/network-error',
    since: past,
    timeout_ms: 150,
    poll_interval_ms: 50,
  }));

  assert.equal(data.matched, true);
  assert.equal(data.mutation.status, 0);
});

test('handler: response payload includes device scope for multi-device disambiguation', async () => {
  // Sibling cdp_network_log returns `device: scope` in its envelope so
  // multi-device sessions can attribute results. Match that contract.
  const client = createMockClient();
  pushEntry(client, { url: '/api/cart', method: 'POST', status: 201 });

  const handler = createWaitForNetworkHandler(() => client);
  const data = expectOk(await handler({
    url_pattern: '/api/cart',
    timeout_ms: 150,
    poll_interval_ms: 50,
  }));

  assert.equal(data.matched, true);
  assert.equal(data.device, '8081-page1', 'matches mock client activeDeviceKey');
});

test('handler: explicit device override is reflected in payload', async () => {
  const client = createMockClient();
  // Push to a non-default device bucket
  client.networkBufferManager.push('9000-other-target', {
    id: 'req-other',
    method: 'POST',
    url: '/api/cart',
    timestamp: new Date().toISOString(),
    status: 201,
  });

  const handler = createWaitForNetworkHandler(() => client);
  const data = expectOk(await handler({
    url_pattern: '/api/cart',
    device: '9000-other-target',
    timeout_ms: 150,
    poll_interval_ms: 50,
  }));

  assert.equal(data.matched, true);
  assert.equal(data.device, '9000-other-target');
});

test('handler: connection lost mid-poll returns matched:false with disconnected:true', async () => {
  const client = createMockClient();

  // Drop the connection after the first poll tick. Without the in-loop
  // isConnected guard, the handler would wait the full timeout against a
  // frozen buffer.
  setTimeout(() => { client._isConnected = false; }, 75);

  const handler = createWaitForNetworkHandler(() => client);
  const t0 = Date.now();
  const data = expectOk(await handler({
    url_pattern: '/api/never',
    timeout_ms: 2000,
    poll_interval_ms: 50,
  }));
  const elapsed = Date.now() - t0;

  assert.equal(data.matched, false);
  assert.equal(data.disconnected, true);
  assert.ok(elapsed < 500, `disconnect should short-circuit, got ${elapsed}ms`);
});
