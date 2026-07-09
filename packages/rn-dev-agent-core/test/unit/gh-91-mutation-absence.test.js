// GH #91 / D688: mutation-absence detector. Catches the IX-2950 verification-
// fidelity failure where an agent reaches a "success-shape" screen via
// deep-link without the underlying server mutation actually firing.
//
// Tests cover: pure helpers (normalizeRouteName, isSuccessShape,
// countWindowedMutations), the annotateMutationAbsence integration logic
// (edge-trigger, success-shape gating, mutation status filter, last-mutation
// age diagnostic), and source-grep guards on the 3 wire-in tools.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const MOD_PATH = '../../dist/verification/mutation-absence.js';

function makeMockClient(opts = {}) {
  const entries = opts.entries ?? [];
  return {
    activeDeviceKey: opts.deviceKey ?? '8081-target-1',
    networkBufferManager: {
      filter: (_key, predicate) => entries.filter(predicate),
    },
  };
}

function envelope(data, meta) {
  return {
    content: [
      { type: 'text', text: JSON.stringify({ ok: true, data, ...(meta ? { meta } : {}) }) },
    ],
  };
}

function parse(result) {
  return JSON.parse(result.content[0].text);
}

// ── normalizeRouteName ──────────────────────────────────────────────────

test('normalizeRouteName: returns null for empty/null/undefined', async () => {
  const { normalizeRouteName } = await import(MOD_PATH);
  assert.equal(normalizeRouteName(null), null);
  assert.equal(normalizeRouteName(undefined), null);
  assert.equal(normalizeRouteName(''), null);
  assert.equal(normalizeRouteName('   '), null);
});

test('normalizeRouteName: lowercases and returns React Navigation name as-is', async () => {
  const { normalizeRouteName } = await import(MOD_PATH);
  assert.equal(normalizeRouteName('OrderConfirmation'), 'orderconfirmation');
});

test('normalizeRouteName: strips path segments for Expo Router routes', async () => {
  const { normalizeRouteName } = await import(MOD_PATH);
  assert.equal(normalizeRouteName('/orders/[id]/confirmation'), 'confirmation');
  assert.equal(normalizeRouteName('orders/123/success'), 'success');
});

// ── isSuccessShape ──────────────────────────────────────────────────────

test('isSuccessShape: matches React Navigation success-style names', async () => {
  const { isSuccessShape } = await import(MOD_PATH);
  for (const name of [
    'OrderSuccess',
    'AddPolicySuccess',
    'PaymentDone',
    'TaskAdded',
    'JobComplete',
    'PaymentCompleted',
    'OrderConfirmation',
  ]) {
    assert.equal(isSuccessShape(name), true, `${name} should match success shape`);
  }
});

test('isSuccessShape: matches Expo Router path-style routes', async () => {
  const { isSuccessShape } = await import(MOD_PATH);
  assert.equal(isSuccessShape('/orders/[id]/confirmation'), true);
  assert.equal(isSuccessShape('/checkout/done'), true);
});

test('isSuccessShape: rejects non-success names', async () => {
  const { isSuccessShape } = await import(MOD_PATH);
  for (const name of ['Home', 'OrderList', 'CheckoutFlow', 'CartScreen', null, undefined, '']) {
    assert.equal(isSuccessShape(name), false, `${name} should NOT match success shape`);
  }
});

test('isSuccessShape: case-insensitive suffix match', async () => {
  const { isSuccessShape } = await import(MOD_PATH);
  // The regex anchors to end-of-string with case-insensitive flag, so any
  // form of "success" suffix matches. Trailing punctuation/separators are
  // not stripped — the match is purely on the path's last segment ending in
  // a success-shape word.
  assert.equal(isSuccessShape('ORDER_SUCCESS'), true);
  assert.equal(isSuccessShape('OrderSUCCESS'), true);
  assert.equal(isSuccessShape('ordersuccess'), true);
});

// ── countWindowedMutations ──────────────────────────────────────────────

test('countWindowedMutations: counts only POST/PUT/PATCH/DELETE', async () => {
  const { countWindowedMutations } = await import(MOD_PATH);
  const now = Date.parse('2026-04-28T12:00:00.000Z');
  const ago = (sec) => new Date(now - sec * 1000).toISOString();
  const client = makeMockClient({
    entries: [
      { method: 'GET', url: '/api/users', timestamp: ago(1), status: 200 },
      { method: 'POST', url: '/api/orders', timestamp: ago(2), status: 200 },
      { method: 'PUT', url: '/api/profile', timestamp: ago(3), status: 200 },
      { method: 'PATCH', url: '/api/settings', timestamp: ago(4), status: 204 },
      { method: 'DELETE', url: '/api/items/1', timestamp: ago(4.5), status: 204 },
      { method: 'OPTIONS', url: '/api/cors', timestamp: ago(0.5), status: 200 },
    ],
  });
  const { inWindow } = countWindowedMutations(client, 5_000, now);
  assert.equal(inWindow, 4, 'POST + PUT + PATCH + DELETE = 4');
});

test('countWindowedMutations: filters by 5s window', async () => {
  const { countWindowedMutations } = await import(MOD_PATH);
  const now = Date.parse('2026-04-28T12:00:00.000Z');
  const ago = (sec) => new Date(now - sec * 1000).toISOString();
  const client = makeMockClient({
    entries: [
      { method: 'POST', url: '/api/a', timestamp: ago(2), status: 201 },
      { method: 'POST', url: '/api/b', timestamp: ago(8), status: 201 }, // outside 5s
      { method: 'POST', url: '/api/c', timestamp: ago(12), status: 201 }, // outside
    ],
  });
  const { inWindow, lastMutationAgeMs } = countWindowedMutations(client, 5_000, now);
  assert.equal(inWindow, 1, 'only the 2s-ago entry is in-window');
  // lastMutationAgeMs is 0 when in-window count > 0 — diagnostic only matters when zero.
  assert.equal(lastMutationAgeMs, 0);
});

test('countWindowedMutations: skips failed mutations (>= 400)', async () => {
  // Gemini's catch: a POST that 500s should NOT silence the detector.
  const { countWindowedMutations } = await import(MOD_PATH);
  const now = Date.parse('2026-04-28T12:00:00.000Z');
  const ago = (sec) => new Date(now - sec * 1000).toISOString();
  const client = makeMockClient({
    entries: [
      { method: 'POST', url: '/api/orders', timestamp: ago(2), status: 500 },
      { method: 'POST', url: '/api/items', timestamp: ago(3), status: 404 },
    ],
  });
  const { inWindow } = countWindowedMutations(client, 5_000, now);
  assert.equal(inWindow, 0, 'failed mutations must not count as success');
});

test('countWindowedMutations: FRESH pending entries (status undefined, < 2s old) count as in-progress success', async () => {
  // Optimistic UI: screen renders before response lands; the request is
  // captured at requestWillBeSent and gets `status` set later.
  const { countWindowedMutations } = await import(MOD_PATH);
  const now = Date.parse('2026-04-28T12:00:00.000Z');
  const ago = (sec) => new Date(now - sec * 1000).toISOString();
  const client = makeMockClient({
    entries: [{ method: 'POST', url: '/api/orders', timestamp: ago(0.3), status: undefined }],
  });
  const { inWindow } = countWindowedMutations(client, 5_000, now);
  assert.equal(inWindow, 1, 'fresh pending mutation should count');
});

test('countWindowedMutations: STALE pending entries (>2s old) do NOT count (Gemini review fix)', async () => {
  // Gemini's race-condition catch: a pending entry that's been "in flight"
  // for 3+ seconds is suspect — likely hung, silently failed, or a long-running
  // background fetch. Treating it as success-so-far would silence warnings for
  // mutations that are about to 5xx. The freshness gate (MAX_PENDING_AGE_MS=2000ms)
  // limits the optimistic-UI window so only recently-fired pendings count.
  const { countWindowedMutations } = await import(MOD_PATH);
  const now = Date.parse('2026-04-28T12:00:00.000Z');
  const ago = (sec) => new Date(now - sec * 1000).toISOString();
  const client = makeMockClient({
    entries: [{ method: 'POST', url: '/api/orders', timestamp: ago(3.5), status: undefined }],
  });
  const { inWindow } = countWindowedMutations(client, 5_000, now);
  assert.equal(inWindow, 0, 'stale pending must not silence the detector');
});

test('countWindowedMutations: freshness boundary (exactly 2s) counts as success', async () => {
  // The boundary itself is inclusive (<= MAX_PENDING_AGE_MS).
  const { countWindowedMutations } = await import(MOD_PATH);
  const now = Date.parse('2026-04-28T12:00:00.000Z');
  const at = (sec) => new Date(now - sec * 1000).toISOString();
  const client = makeMockClient({
    entries: [{ method: 'POST', url: '/api/orders', timestamp: at(2), status: undefined }],
  });
  const { inWindow } = countWindowedMutations(client, 5_000, now);
  assert.equal(inWindow, 1, 'exactly 2s old pending mutation should still count');
});

test('countWindowedMutations: reports last_mutation_age_ms when window is empty', async () => {
  const { countWindowedMutations } = await import(MOD_PATH);
  const now = Date.parse('2026-04-28T12:00:00.000Z');
  const ago = (sec) => new Date(now - sec * 1000).toISOString();
  const client = makeMockClient({
    entries: [{ method: 'POST', url: '/api/old', timestamp: ago(7.3), status: 201 }],
  });
  const { inWindow, lastMutationAgeMs } = countWindowedMutations(client, 5_000, now);
  assert.equal(inWindow, 0);
  assert.equal(lastMutationAgeMs, 7300);
});

test('countWindowedMutations: lastMutationAgeMs is null when no mutations ever', async () => {
  const { countWindowedMutations } = await import(MOD_PATH);
  const now = Date.parse('2026-04-28T12:00:00.000Z');
  const client = makeMockClient({ entries: [] });
  const { inWindow, lastMutationAgeMs } = countWindowedMutations(client, 5_000, now);
  assert.equal(inWindow, 0);
  assert.equal(lastMutationAgeMs, null);
});

// ── annotateMutationAbsence — edge-trigger semantics ────────────────────

test('annotateMutationAbsence: first observation primes, never warns', async () => {
  const { annotateMutationAbsence, _resetForTests } = await import(MOD_PATH);
  _resetForTests();
  const client = makeMockClient(); // no mutations
  const result = annotateMutationAbsence(envelope({ ok: true }), {
    client,
    screenName: 'OrderSuccess',
    source: 'cdp_navigate',
  });
  const env = parse(result);
  assert.equal(env.meta?.verification_warning, undefined, 'first observation must not warn');
});

test('annotateMutationAbsence: same-screen second observation does not warn', async () => {
  const { annotateMutationAbsence, _resetForTests } = await import(MOD_PATH);
  _resetForTests();
  const client = makeMockClient();
  // Prime
  annotateMutationAbsence(envelope({}), {
    client,
    screenName: 'OrderSuccess',
    source: 'cdp_navigate',
  });
  // Second observation, same screen, no transition.
  const r2 = annotateMutationAbsence(envelope({}), {
    client,
    screenName: 'OrderSuccess',
    source: 'cdp_navigation_state',
  });
  assert.equal(parse(r2).meta?.verification_warning, undefined);
});

test('annotateMutationAbsence: transition to success shape with no mutation -> warns', async () => {
  const { annotateMutationAbsence, _resetForTests } = await import(MOD_PATH);
  _resetForTests();
  const client = makeMockClient(); // no mutations
  // Prime on a non-success screen
  annotateMutationAbsence(envelope({}), {
    client,
    screenName: 'CheckoutFlow',
    source: 'cdp_navigation_state',
  });
  // Transition to OrderSuccess
  const result = annotateMutationAbsence(envelope({ navigated: true }), {
    client,
    screenName: 'OrderSuccess',
    source: 'cdp_navigate',
  });
  const env = parse(result);
  assert.ok(env.meta?.verification_warning, 'should warn on transition to success shape');
  assert.equal(env.meta.verification_warning.code, 'MUTATION_ABSENCE');
  assert.equal(env.meta.verification_warning.screen, 'OrderSuccess');
  assert.equal(env.meta.verification_warning.source, 'cdp_navigate');
  assert.equal(env.meta.verification_warning.window_ms, 5000);
  assert.equal(env.meta.verification_warning.mutations_observed, 0);
  assert.equal(env.meta.verification_warning.last_mutation_age_ms, null);
  assert.match(env.meta.verification_warning.hint, /5000ms|deep-link|user-flow/);
});

test('annotateMutationAbsence: transition to non-success screen does NOT warn', async () => {
  const { annotateMutationAbsence, _resetForTests } = await import(MOD_PATH);
  _resetForTests();
  const client = makeMockClient();
  annotateMutationAbsence(envelope({}), { client, screenName: 'Home', source: 'cdp_navigate' });
  const result = annotateMutationAbsence(envelope({}), {
    client,
    screenName: 'CartScreen',
    source: 'cdp_navigate',
  });
  assert.equal(parse(result).meta?.verification_warning, undefined);
});

test('annotateMutationAbsence: success transition WITH in-window mutation does NOT warn', async () => {
  const { annotateMutationAbsence, _resetForTests } = await import(MOD_PATH);
  _resetForTests();
  const now = Date.parse('2026-04-28T12:00:00.000Z');
  const client = makeMockClient({
    entries: [
      {
        method: 'POST',
        url: '/api/orders',
        timestamp: new Date(now - 1500).toISOString(),
        status: 201,
      },
    ],
  });
  // Prime
  annotateMutationAbsence(envelope({}), {
    client,
    screenName: 'CheckoutFlow',
    source: 'cdp_navigate',
    now: () => now,
  });
  // Transition with mutation in window
  const result = annotateMutationAbsence(envelope({}), {
    client,
    screenName: 'OrderSuccess',
    source: 'cdp_navigate',
    now: () => now,
  });
  assert.equal(
    parse(result).meta?.verification_warning,
    undefined,
    'real flow should not be flagged',
  );
});

test('annotateMutationAbsence: emits last_mutation_age_ms diagnostic when out-of-window mutation exists', async () => {
  const { annotateMutationAbsence, _resetForTests } = await import(MOD_PATH);
  _resetForTests();
  const now = Date.parse('2026-04-28T12:00:00.000Z');
  const client = makeMockClient({
    entries: [
      {
        method: 'POST',
        url: '/api/orders',
        timestamp: new Date(now - 7500).toISOString(),
        status: 201,
      },
    ],
  });
  annotateMutationAbsence(envelope({}), {
    client,
    screenName: 'CheckoutFlow',
    source: 'cdp_navigate',
    now: () => now,
  });
  const result = annotateMutationAbsence(envelope({}), {
    client,
    screenName: 'OrderSuccess',
    source: 'cdp_navigate',
    now: () => now,
  });
  const w = parse(result).meta.verification_warning;
  assert.equal(w.last_mutation_age_ms, 7500);
  assert.match(w.hint, /Most recent mutation was 7500ms ago/);
});

test('annotateMutationAbsence: skips on isError result', async () => {
  const { annotateMutationAbsence, _resetForTests } = await import(MOD_PATH);
  _resetForTests();
  const client = makeMockClient();
  const errorResult = {
    content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'fail' }) }],
    isError: true,
  };
  const result = annotateMutationAbsence(errorResult, {
    client,
    screenName: 'OrderSuccess',
    source: 'cdp_navigate',
  });
  assert.equal(result, errorResult, 'isError results pass through unchanged');
});

test('annotateMutationAbsence: per-device state isolation', async () => {
  const { annotateMutationAbsence, _resetForTests } = await import(MOD_PATH);
  _resetForTests();
  const ios = makeMockClient({ deviceKey: '8081-ios-1' });
  const android = makeMockClient({ deviceKey: '8081-android-1' });
  // Prime both on different screens
  annotateMutationAbsence(envelope({}), {
    client: ios,
    screenName: 'Home',
    source: 'cdp_navigate',
  });
  annotateMutationAbsence(envelope({}), {
    client: android,
    screenName: 'Home',
    source: 'cdp_navigate',
  });
  // iOS transitions to success → warns
  const iosResult = annotateMutationAbsence(envelope({}), {
    client: ios,
    screenName: 'OrderSuccess',
    source: 'cdp_navigate',
  });
  // Android stays on Home — same observation, no transition, no warning
  const androidResult = annotateMutationAbsence(envelope({}), {
    client: android,
    screenName: 'Home',
    source: 'cdp_navigate',
  });
  assert.ok(parse(iosResult).meta?.verification_warning);
  assert.equal(parse(androidResult).meta?.verification_warning, undefined);
});

test('annotateMutationAbsence: preserves existing meta fields', async () => {
  const { annotateMutationAbsence, _resetForTests } = await import(MOD_PATH);
  _resetForTests();
  const client = makeMockClient();
  // Prime
  annotateMutationAbsence(envelope({}), { client, screenName: 'Home', source: 'cdp_navigate' });
  // Observation with pre-existing meta
  const r = envelope({}, { recovered_via: 'force_reconnect' });
  const result = annotateMutationAbsence(r, {
    client,
    screenName: 'OrderSuccess',
    source: 'cdp_navigate',
  });
  const env = parse(result);
  assert.equal(env.meta.recovered_via, 'force_reconnect', 'pre-existing meta preserved');
  assert.equal(env.meta.verification_warning.code, 'MUTATION_ABSENCE');
});

test('annotateMutationAbsence: malformed envelope passes through unchanged', async () => {
  const { annotateMutationAbsence, _resetForTests } = await import(MOD_PATH);
  _resetForTests();
  const client = makeMockClient();
  const malformed = { content: [{ type: 'text', text: 'not json' }] };
  // Prime + transition
  annotateMutationAbsence(envelope({}), { client, screenName: 'Home', source: 'cdp_navigate' });
  const result = annotateMutationAbsence(malformed, {
    client,
    screenName: 'OrderSuccess',
    source: 'cdp_navigate',
  });
  assert.equal(result, malformed);
});

// ── Source guards ───────────────────────────────────────────────────────

test('source guard: cdp_navigate handler invokes annotateMutationAbsence', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(__dirname, '../../dist/index.js'), 'utf-8');
  // The cdp_navigate inline handler must annotate.
  assert.match(
    src,
    /annotateMutationAbsence\(okResult\(parsed\),\s*\{[\s\S]*?source:\s*['"]cdp_navigate['"]/,
  );
});

test('source guard: cdp_navigation_state handler invokes annotateMutationAbsence', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(__dirname, '../../dist/tools/navigation-state.js'), 'utf-8');
  assert.match(src, /annotateMutationAbsence/);
  assert.match(src, /source:\s*['"]cdp_navigation_state['"]/);
});

test('source guard: proof_step handler invokes annotateMutationAbsence', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(__dirname, '../../dist/tools/proof-step.js'), 'utf-8');
  assert.match(src, /annotateMutationAbsence/);
  assert.match(src, /source:\s*['"]proof_step['"]/);
});

// ── per-project config override (GH #91 acceptance #3) ──────────────────────

test('override: successShapes regex enables warning on a custom shape name', async () => {
  const { annotateMutationAbsence, _resetForTests } = await import(MOD_PATH);
  _resetForTests();
  const client = makeMockClient({ entries: [] });
  // Prime so the next observation is a transition.
  annotateMutationAbsence(envelope({}), { client, screenName: 'Home', source: 'cdp_navigate' });
  // 'OrderReceipt' is NOT in the built-in regex; the override should match it.
  const customRegex = /(receipt|thanks)$/i;
  const result = annotateMutationAbsence(envelope({}), {
    client,
    screenName: 'OrderReceipt',
    source: 'cdp_navigate',
    successShapes: customRegex,
  });
  const env = parse(result);
  assert.equal(env.meta?.verification_warning?.code, 'MUTATION_ABSENCE');
  assert.equal(env.meta?.verification_warning?.screen, 'OrderReceipt');
});

test('override: successShapes regex disables warning when built-in suffix is removed', async () => {
  const { annotateMutationAbsence, _resetForTests } = await import(MOD_PATH);
  _resetForTests();
  const client = makeMockClient({ entries: [] });
  annotateMutationAbsence(envelope({}), { client, screenName: 'Home', source: 'cdp_navigate' });
  // Custom regex only matches "receipt" — "OrderConfirmation" should now be ignored.
  const customRegex = /receipt$/i;
  const result = annotateMutationAbsence(envelope({}), {
    client,
    screenName: 'OrderConfirmation',
    source: 'cdp_navigate',
    successShapes: customRegex,
  });
  const env = parse(result);
  assert.equal(env.meta?.verification_warning, undefined);
});

test('override: mutationMethods extends recognized methods (QUERY silences warning)', async () => {
  const { annotateMutationAbsence, _resetForTests } = await import(MOD_PATH);
  _resetForTests();
  const now = 1_700_000_000_000;
  const client = makeMockClient({
    entries: [{ method: 'QUERY', status: 200, timestamp: new Date(now - 1_000).toISOString() }],
  });
  annotateMutationAbsence(envelope({}), {
    client,
    screenName: 'Home',
    source: 'cdp_navigate',
    now: () => now,
  });
  const result = annotateMutationAbsence(envelope({}), {
    client,
    screenName: 'OrderConfirmation',
    source: 'cdp_navigate',
    mutationMethods: new Set(['POST', 'PUT', 'PATCH', 'DELETE', 'QUERY']),
    now: () => now,
  });
  // QUERY is now a recognized mutation method AND in-window → no warning
  const env = parse(result);
  assert.equal(env.meta?.verification_warning, undefined);
});

test('override: mutationMethods narrowed set still fires warning when nothing matches', async () => {
  const { annotateMutationAbsence, _resetForTests } = await import(MOD_PATH);
  _resetForTests();
  const now = 1_700_000_000_000;
  const client = makeMockClient({
    entries: [{ method: 'POST', status: 200, timestamp: new Date(now - 1_000).toISOString() }],
  });
  annotateMutationAbsence(envelope({}), {
    client,
    screenName: 'Home',
    source: 'cdp_navigate',
    now: () => now,
  });
  // Override drops POST from the mutation set → POST is no longer a "real" mutation
  const result = annotateMutationAbsence(envelope({}), {
    client,
    screenName: 'OrderConfirmation',
    source: 'cdp_navigate',
    mutationMethods: new Set(['DELETE']),
    now: () => now,
  });
  const env = parse(result);
  assert.equal(env.meta?.verification_warning?.code, 'MUTATION_ABSENCE');
});

test('override: defaults preserved when both overrides are null/undefined', async () => {
  const { annotateMutationAbsence, _resetForTests } = await import(MOD_PATH);
  _resetForTests();
  const client = makeMockClient({ entries: [] });
  annotateMutationAbsence(envelope({}), { client, screenName: 'Home', source: 'cdp_navigate' });
  const result = annotateMutationAbsence(envelope({}), {
    client,
    screenName: 'OrderConfirmation',
    source: 'cdp_navigate',
    successShapes: null,
    mutationMethods: null,
  });
  const env = parse(result);
  assert.equal(env.meta?.verification_warning?.code, 'MUTATION_ABSENCE');
});

test('input cap: isSuccessShape bounds input length (ReDoS hot-path guard)', async () => {
  // Codex review conf 90: cap matched-input length at 256 chars so a
  // pathological pattern can't combine with a long route name to stall
  // the event loop. Slice happens before regex .test().
  const { isSuccessShape } = await import(MOD_PATH);
  // 512-char route name ending in "Confirmation" should still match the
  // default regex via the suffix — slice keeps the END of the string.
  const padded = 'X'.repeat(512) + 'Confirmation';
  assert.equal(isSuccessShape(padded), true);
  // 512-char route name with no success suffix should NOT match.
  const paddedNonSuccess = 'X'.repeat(512) + 'Home';
  assert.equal(isSuccessShape(paddedNonSuccess), false);
});
