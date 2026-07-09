// GH #61 Option B.1 / D689: deep-link depth heuristic. Verification-fidelity
// detector that warns on `device_deeplink` URLs with 3+ path segments OR
// ending with a success-state word (success/done/added/complete/completed/
// confirmation). Stateless — pure URL pattern check, no rolling window.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const MOD_PATH = '../../dist/verification/deep-link-depth.js';

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

// ── analyzeDeepLinkUrl: pure URL parsing ───────────────────────────────

test('analyzeDeepLinkUrl: handles RN custom-scheme deep links', async () => {
  const { analyzeDeepLinkUrl } = await import(MOD_PATH);
  // The IX-2950 trigger URL: gtsf://main/wallet/policy-details/<id>/true.
  // For app-scheme deep links, every post-`://` part is a meaningful navigation
  // segment — "main" is a logical root, not a DNS host.
  const a = analyzeDeepLinkUrl('gtsf://main/wallet/policy-details/abc-123/true');
  assert.equal(a.segments, 5);
  assert.equal(a.exceedsThreshold, true);
});

test('analyzeDeepLinkUrl: detects success-state suffix', async () => {
  const { analyzeDeepLinkUrl } = await import(MOD_PATH);
  for (const suffix of ['success', 'done', 'added', 'complete', 'completed', 'confirmation']) {
    const a = analyzeDeepLinkUrl(`myapp://orders/${suffix}`);
    assert.equal(a.endsWithSuccessWord, true, `suffix "${suffix}" should match`);
  }
});

test('analyzeDeepLinkUrl: case-insensitive success match', async () => {
  const { analyzeDeepLinkUrl } = await import(MOD_PATH);
  assert.equal(analyzeDeepLinkUrl('myapp://orders/SUCCESS').endsWithSuccessWord, true);
  assert.equal(analyzeDeepLinkUrl('myapp://orders/Confirmation').endsWithSuccessWord, true);
});

test('analyzeDeepLinkUrl: non-success suffixes do not match', async () => {
  const { analyzeDeepLinkUrl } = await import(MOD_PATH);
  for (const tail of ['list', 'detail', 'home', 'cart', 'profile']) {
    assert.equal(
      analyzeDeepLinkUrl(`myapp://app/${tail}`).endsWithSuccessWord,
      false,
      `tail "${tail}" must not flag as success`,
    );
  }
});

test('analyzeDeepLinkUrl: 1-2 segments do NOT exceed threshold', async () => {
  const { analyzeDeepLinkUrl } = await import(MOD_PATH);
  assert.equal(analyzeDeepLinkUrl('myapp://home').exceedsThreshold, false);
  assert.equal(analyzeDeepLinkUrl('myapp://orders').exceedsThreshold, false);
});

test('analyzeDeepLinkUrl: 3+ segments exceed threshold', async () => {
  const { analyzeDeepLinkUrl } = await import(MOD_PATH);
  // myapp://orders/list = 2 segments (below threshold) — shallow nav.
  assert.equal(analyzeDeepLinkUrl('myapp://orders/list').exceedsThreshold, false);
  // myapp://orders/123/edit = 3 segments — meets threshold.
  assert.equal(analyzeDeepLinkUrl('myapp://orders/123/edit').exceedsThreshold, true);
  // myapp://wallet/policies/abc/details/edit = 5 segments — clearly deep.
  assert.equal(
    analyzeDeepLinkUrl('myapp://wallet/policies/abc/details/edit').exceedsThreshold,
    true,
  );
});

test('analyzeDeepLinkUrl: strips query and fragment', async () => {
  const { analyzeDeepLinkUrl } = await import(MOD_PATH);
  // Query and fragment must NOT count as segments and must NOT contribute to suffix.
  const a = analyzeDeepLinkUrl('myapp://orders?confirmation=true&id=123');
  assert.equal(a.segments, 1, 'orders is 1 segment, query stripped');
  assert.equal(a.endsWithSuccessWord, false);
  const b = analyzeDeepLinkUrl('myapp://orders/list#success');
  assert.equal(b.segments, 2);
  assert.equal(b.endsWithSuccessWord, false, 'fragment must not contribute to suffix');
});

test('analyzeDeepLinkUrl: handles path-only inputs', async () => {
  const { analyzeDeepLinkUrl } = await import(MOD_PATH);
  // Some callers may pass paths without a scheme.
  const a = analyzeDeepLinkUrl('/wallet/policy-details/abc/true');
  assert.equal(a.segments, 4);
  assert.equal(a.exceedsThreshold, true);
});

test('analyzeDeepLinkUrl: handles https universal links', async () => {
  const { analyzeDeepLinkUrl } = await import(MOD_PATH);
  // example.com counts as a segment too — same uniform treatment as app schemes.
  const a = analyzeDeepLinkUrl('https://example.com/orders/123/confirmation');
  assert.equal(a.segments, 4);
  assert.equal(a.endsWithSuccessWord, true);
  assert.equal(a.exceedsThreshold, true);
});

test('analyzeDeepLinkUrl: handles malformed and empty inputs safely', async () => {
  const { analyzeDeepLinkUrl } = await import(MOD_PATH);
  assert.deepEqual(analyzeDeepLinkUrl(''), {
    segments: 0,
    endsWithSuccessWord: false,
    exceedsThreshold: false,
  });
  assert.deepEqual(analyzeDeepLinkUrl(null), {
    segments: 0,
    endsWithSuccessWord: false,
    exceedsThreshold: false,
  });
  assert.deepEqual(analyzeDeepLinkUrl(undefined), {
    segments: 0,
    endsWithSuccessWord: false,
    exceedsThreshold: false,
  });
  // Bare scheme with no path
  assert.deepEqual(analyzeDeepLinkUrl('myapp://'), {
    segments: 0,
    endsWithSuccessWord: false,
    exceedsThreshold: false,
  });
});

// ── annotateDeepLinkDepth: integration with envelope ─────────────────────

test('annotateDeepLinkDepth: shallow URL with no success suffix passes through unchanged', async () => {
  const { annotateDeepLinkDepth } = await import(MOD_PATH);
  const r = envelope({ opened: true, url: 'myapp://home' });
  const result = annotateDeepLinkDepth(r, { url: 'myapp://home' });
  assert.equal(parse(result).meta?.verification_warning, undefined);
});

test('annotateDeepLinkDepth: depth-only trigger emits DEEP_LINK_DEPTH warning', async () => {
  const { annotateDeepLinkDepth } = await import(MOD_PATH);
  const url = 'myapp://wallet/policies/abc/details';
  const result = annotateDeepLinkDepth(envelope({ opened: true, url }), { url });
  const env = parse(result);
  assert.ok(env.meta?.verification_warning);
  assert.equal(env.meta.verification_warning.code, 'DEEP_LINK_DEPTH');
  assert.equal(env.meta.verification_warning.source, 'device_deeplink');
  assert.equal(env.meta.verification_warning.trigger, 'depth');
  assert.equal(env.meta.verification_warning.segments, 4);
  assert.equal(env.meta.verification_warning.ends_with_success_word, false);
});

test('annotateDeepLinkDepth: borderline 2-segment URL with non-success suffix passes through', async () => {
  // Make sure the threshold semantics are right — 2-segment shallow nav
  // (orders/list, profile/edit) is below threshold and shouldn't warn.
  const { annotateDeepLinkDepth } = await import(MOD_PATH);
  const r1 = annotateDeepLinkDepth(envelope({}), { url: 'myapp://orders/list' });
  assert.equal(parse(r1).meta?.verification_warning, undefined);
  const r2 = annotateDeepLinkDepth(envelope({}), { url: 'myapp://profile/edit' });
  assert.equal(parse(r2).meta?.verification_warning, undefined);
});

test('annotateDeepLinkDepth: success-suffix-only trigger fires below depth threshold', async () => {
  const { annotateDeepLinkDepth } = await import(MOD_PATH);
  const url = 'myapp://orders/done';
  const result = annotateDeepLinkDepth(envelope({}), { url });
  const w = parse(result).meta.verification_warning;
  assert.equal(w.trigger, 'success_suffix');
  assert.equal(w.segments, 2);
  assert.equal(w.ends_with_success_word, true);
});

test('annotateDeepLinkDepth: combined trigger (depth + success suffix) reports both', async () => {
  const { annotateDeepLinkDepth } = await import(MOD_PATH);
  // The IX-2950 case: 4 segments AND ends with success-shape word
  const url = 'gtsf://main/wallet/policy-details/abc-123/confirmation';
  const result = annotateDeepLinkDepth(envelope({}), { url });
  const w = parse(result).meta.verification_warning;
  assert.equal(w.trigger, 'depth_and_success_suffix');
  assert.match(w.hint, /5 path segments/);
  assert.match(w.hint, /ends with a success-state word/);
});

test('annotateDeepLinkDepth: does NOT mutate result on isError envelope', async () => {
  const { annotateDeepLinkDepth } = await import(MOD_PATH);
  const errored = {
    content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'fail' }) }],
    isError: true,
  };
  const result = annotateDeepLinkDepth(errored, { url: 'myapp://orders/123/success' });
  assert.equal(result, errored);
});

test('annotateDeepLinkDepth: preserves existing meta fields', async () => {
  const { annotateDeepLinkDepth } = await import(MOD_PATH);
  const r = envelope({}, { recovered_via: 'force_reconnect' });
  const result = annotateDeepLinkDepth(r, { url: 'myapp://orders/123/success' });
  const env = parse(result);
  assert.equal(env.meta.recovered_via, 'force_reconnect');
  assert.equal(env.meta.verification_warning.code, 'DEEP_LINK_DEPTH');
});

test('annotateDeepLinkDepth: malformed envelope passes through unchanged', async () => {
  const { annotateDeepLinkDepth } = await import(MOD_PATH);
  const malformed = { content: [{ type: 'text', text: 'not json' }] };
  const result = annotateDeepLinkDepth(malformed, { url: 'myapp://orders/123/success' });
  assert.equal(result, malformed);
});

// ── Source guards ───────────────────────────────────────────────────────

test('source guard: device_deeplink handler invokes annotateDeepLinkDepth', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(__dirname, '../../dist/tools/device-deeplink.js'), 'utf-8');
  assert.match(src, /annotateDeepLinkDepth/);
});

test('source guard: shared envelope helper attachVerificationWarning is exported', async () => {
  const { attachVerificationWarning } = await import('../../dist/verification/envelope.js');
  assert.equal(typeof attachVerificationWarning, 'function');
});

test('source guard: mutation-absence refactored to use shared envelope helper', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(__dirname, '../../dist/verification/mutation-absence.js'), 'utf-8');
  assert.match(src, /attachVerificationWarning/);
  // Private augmentMeta should be gone now.
  assert.equal(
    /^function augmentMeta\b/m.test(src),
    false,
    'private augmentMeta should have been removed',
  );
});
