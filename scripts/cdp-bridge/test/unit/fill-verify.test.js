import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyFillVerification, resolveJsTestId, decideNativeRetype } from '../../dist/tools/fill-verify.js';

// ── classifyFillVerification ──────────────────────────────────────────
test('exact match → verified-exact', () => {
  assert.equal(classifyFillVerification({ text: 'a@b.com', valueAfter: 'a@b.com', controlled: true }), 'verified-exact');
});
test('empty-string clear → verified-exact', () => {
  assert.equal(classifyFillVerification({ text: '', valueAfter: '', controlled: true }), 'verified-exact');
});
test('mask/formatter (≥ half length) → verified-transformed', () => {
  assert.equal(classifyFillVerification({ text: '5551234', valueAfter: '(555) 1234', controlled: true }), 'verified-transformed');
  assert.equal(classifyFillVerification({ text: 'abcdefgh', valueAfter: 'abcdef', controlled: true }), 'verified-transformed');
});
test('empty value while text non-empty → corrupted', () => {
  assert.equal(classifyFillVerification({ text: 'a@b.com', valueAfter: '', controlled: true }), 'corrupted');
});
test('severe truncation (< half) → corrupted', () => {
  assert.equal(classifyFillVerification({ text: 'hello@example.com', valueAfter: 'hel', controlled: true }), 'corrupted');
});
test('null value → unverifiable', () => {
  assert.equal(classifyFillVerification({ text: 'x', valueAfter: null, controlled: false }), 'unverifiable');
});
test('stability rule: short BUT stable across retype → verified-transformed', () => {
  assert.equal(classifyFillVerification({ text: 'abcdefgh', valueAfter: 'ab', controlled: true, priorValueAfter: 'ab' }), 'verified-transformed');
});
test('stability rule does NOT rescue an empty value', () => {
  assert.equal(classifyFillVerification({ text: 'abcdefgh', valueAfter: '', controlled: true, priorValueAfter: '' }), 'corrupted');
});
test('non-empty value after a clear (text="") → corrupted', () => {
  assert.equal(classifyFillVerification({ text: '', valueAfter: 'leftover', controlled: true }), 'corrupted');
});
test('exactly at 0.5*len boundary (odd length) → corrupted just below, transformed at/above', () => {
  assert.equal(classifyFillVerification({ text: 'abcde', valueAfter: 'ab', controlled: true }), 'corrupted');
  assert.equal(classifyFillVerification({ text: 'abcde', valueAfter: 'abc', controlled: true }), 'verified-transformed');
});

// ── resolveJsTestId (cached-metadata aware) ───────────────────────────
test('explicit testID wins', () => {
  assert.equal(resolveJsTestId('@e5', { explicitTestId: 'email-input' }), 'email-input');
});
test('snapshot @eN ref resolves via cached identifier', () => {
  assert.equal(resolveJsTestId('@e5', { cachedIdentifier: 'email-input' }), 'email-input');
});
test('snapshot @eN ref with no cached identifier → null (skip JS)', () => {
  assert.equal(resolveJsTestId('@e5', {}), null);
});
test('bare numeric ref → null', () => {
  assert.equal(resolveJsTestId('@42', {}), null);
});
test('non-token semantic ref is treated as a testID', () => {
  assert.equal(resolveJsTestId('@email-input', {}), 'email-input');
});
test('empty ref → null', () => {
  assert.equal(resolveJsTestId('@', {}), null);
});

// ── decideNativeRetype ────────────────────────────────────────────────
test('corrupted + attempts left → retype with delay', () => {
  assert.deepEqual(decideNativeRetype('corrupted', 0, 2), { action: 'retype', delayMs: 40 });
});
test('corrupted + exhausted → escalate', () => {
  assert.deepEqual(decideNativeRetype('corrupted', 2, 2), { action: 'escalate' });
});
test('verified-exact → accept', () => {
  assert.deepEqual(decideNativeRetype('verified-exact', 1, 2), { action: 'accept' });
});
test('unverifiable → accept', () => {
  assert.deepEqual(decideNativeRetype('unverifiable', 0, 2), { action: 'accept' });
});
