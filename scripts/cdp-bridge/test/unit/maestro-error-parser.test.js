// Issue #104 — unit tests for the Maestro failure parser.
//
// Covers each canonical failure shape, the unknown fallback, and the
// `isAutoRepairable` predicate. All tests are pure-function — no I/O.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMaestroFailure,
  isAutoRepairable,
} from '../../dist/domain/maestro-error-parser.js';

// ─────────────────────────────────────────────────────────────────────────────
// SELECTOR_NOT_FOUND variants
// ─────────────────────────────────────────────────────────────────────────────

test('parser: id-keyed selector, single-quoted', () => {
  const out = parseMaestroFailure(
    "INFO: starting flow\nElement with id 'fab-create-task' not found\nfailed.",
  );
  assert.equal(out.kind, 'SELECTOR_NOT_FOUND');
  assert.equal(out.selectorKind, 'id');
  assert.equal(out.selector, 'fab-create-task');
});

test('parser: id-keyed selector, double-quoted', () => {
  const out = parseMaestroFailure('Element with id "btn-submit" not found');
  assert.equal(out.kind, 'SELECTOR_NOT_FOUND');
  assert.equal(out.selectorKind, 'id');
  assert.equal(out.selector, 'btn-submit');
});

test('parser: id-keyed selector with "was not found" tense', () => {
  const out = parseMaestroFailure("Element with id 'foo' was not found");
  assert.equal(out.kind, 'SELECTOR_NOT_FOUND');
  assert.equal(out.selector, 'foo');
});

test('parser: text-keyed selector', () => {
  const out = parseMaestroFailure("Element with text 'Save' not found");
  assert.equal(out.kind, 'SELECTOR_NOT_FOUND');
  assert.equal(out.selectorKind, 'text');
  assert.equal(out.selector, 'Save');
});

test('parser: generic Element \'X\' not found falls back to selectorKind=unknown', () => {
  const out = parseMaestroFailure("Element 'mystery-tag' not found in current view");
  assert.equal(out.kind, 'SELECTOR_NOT_FOUND');
  assert.equal(out.selectorKind, 'unknown');
  assert.equal(out.selector, 'mystery-tag');
});

test('parser: id pattern wins over generic when both could match', () => {
  // "Element with id 'X'" must be preferred over the generic "Element 'X'"
  // pattern that comes later in PATTERNS.
  const out = parseMaestroFailure("Element with id 'specific-id' not found");
  assert.equal(out.selectorKind, 'id', 'specific id pattern should match before fallback');
  assert.equal(out.selector, 'specific-id');
});

// ─────────────────────────────────────────────────────────────────────────────
// TIMEOUT variants
// ─────────────────────────────────────────────────────────────────────────────

test('parser: timeout with id', () => {
  const out = parseMaestroFailure("Timed out waiting for element with id 'spinner-done'");
  assert.equal(out.kind, 'TIMEOUT');
  assert.equal(out.selector, 'spinner-done');
});

test('parser: timeout without id keyword', () => {
  const out = parseMaestroFailure("Timed out waiting for element 'check-mark'");
  assert.equal(out.kind, 'TIMEOUT');
  assert.equal(out.selector, 'check-mark');
});

// ─────────────────────────────────────────────────────────────────────────────
// ASSERTION_FAILED variants
// ─────────────────────────────────────────────────────────────────────────────

test('parser: assertion-failed prefix', () => {
  const out = parseMaestroFailure(`Assertion failed: 'header-title' not visible`);
  assert.equal(out.kind, 'ASSERTION_FAILED');
  assert.equal(out.selector, 'header-title');
});

test('parser: "X is not visible" variant', () => {
  const out = parseMaestroFailure(`Element 'modal-dialog' is not visible`);
  assert.equal(out.kind, 'ASSERTION_FAILED');
  assert.equal(out.selector, 'modal-dialog');
});

// ─────────────────────────────────────────────────────────────────────────────
// UNKNOWN fallback
// ─────────────────────────────────────────────────────────────────────────────

test('parser: empty string returns UNKNOWN', () => {
  const out = parseMaestroFailure('');
  assert.equal(out.kind, 'UNKNOWN');
  assert.equal(out.raw, '');
});

test('parser: null/undefined input returns UNKNOWN', () => {
  assert.equal(parseMaestroFailure(null).kind, 'UNKNOWN');
  assert.equal(parseMaestroFailure(undefined).kind, 'UNKNOWN');
});

test('parser: non-matching error text returns UNKNOWN with raw preserved', () => {
  const raw = 'Some completely unrecognised Maestro error message';
  const out = parseMaestroFailure(raw);
  assert.equal(out.kind, 'UNKNOWN');
  assert.equal(out.raw, raw);
});

test('parser: case-insensitive — works on upper-case ELEMENT', () => {
  const out = parseMaestroFailure(`ELEMENT WITH ID 'foo' NOT FOUND`);
  assert.equal(out.kind, 'SELECTOR_NOT_FOUND');
  assert.equal(out.selector, 'foo');
});

// ─────────────────────────────────────────────────────────────────────────────
// First-match semantics: when output contains MULTIPLE failure-shaped lines,
// the first one wins.
// ─────────────────────────────────────────────────────────────────────────────

test('parser: returns first match when output contains multiple errors', () => {
  const out = parseMaestroFailure([
    "Element with id 'first-failure' not found",
    "Element with id 'second-failure' not found",
  ].join('\n'));
  assert.equal(out.selector, 'first-failure');
});

// ─────────────────────────────────────────────────────────────────────────────
// isAutoRepairable predicate
// ─────────────────────────────────────────────────────────────────────────────

test('isAutoRepairable: SELECTOR_NOT_FOUND is repairable', () => {
  assert.equal(
    isAutoRepairable({ kind: 'SELECTOR_NOT_FOUND', selectorKind: 'id', selector: 'x', raw: '' }),
    true,
  );
});

test('isAutoRepairable: TIMEOUT is NOT auto-repairable in phase 1', () => {
  assert.equal(
    isAutoRepairable({ kind: 'TIMEOUT', selector: 'x', raw: '' }),
    false,
  );
});

test('isAutoRepairable: ASSERTION_FAILED is NOT auto-repairable in phase 1', () => {
  assert.equal(
    isAutoRepairable({ kind: 'ASSERTION_FAILED', selector: 'x', raw: '' }),
    false,
  );
});

test('isAutoRepairable: UNKNOWN is NOT auto-repairable', () => {
  assert.equal(isAutoRepairable({ kind: 'UNKNOWN', raw: '' }), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// Realistic maestro-runner outputs (smoke tests against actual stderr
// captures — keeps the regex grounded in real wire format).
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Asymmetric-quote handling — multi-LLM review of PR #115 (Gemini conf 95):
// the previous `[^'"]+` capture rejected BOTH quote types, so a testID
// containing the OPPOSITE quote silently failed to parse. The
// `(['"])((?:(?!\1).)+)\1` pattern matches the same quote at both ends
// and allows the opposite inside.
// ─────────────────────────────────────────────────────────────────────────────

test('parser: id-keyed selector containing a single-quote (RN convention "user\'s-tasks") inside double-quotes', () => {
  const out = parseMaestroFailure(`Element with id "user's-tasks" not found`);
  assert.equal(out.kind, 'SELECTOR_NOT_FOUND');
  assert.equal(out.selectorKind, 'id');
  assert.equal(out.selector, "user's-tasks");
});

test('parser: id-keyed selector containing a double-quote inside single-quotes', () => {
  const out = parseMaestroFailure(`Element with id 'say-"hi"' not found`);
  assert.equal(out.kind, 'SELECTOR_NOT_FOUND');
  assert.equal(out.selectorKind, 'id');
  assert.equal(out.selector, 'say-"hi"');
});

test('parser: timeout selector containing the opposite quote', () => {
  const out = parseMaestroFailure(`Timed out waiting for element with id "don't-tap-me"`);
  assert.equal(out.kind, 'TIMEOUT');
  assert.equal(out.selector, "don't-tap-me");
});

test('parser: realistic maestro-runner failure output', () => {
  const realistic = `
=== Running ./.rn-agent/actions/wizard-create-task.yaml ===
[INFO] Launching app com.test.app
[INFO] Tapping on element with id "tab-tasks"
[INFO] Tapping on element with id "fab-create-task"
[ERROR] Element with id 'fab-create-task' not found
[INFO] Flow failed
exit code 1
  `.trim();
  const out = parseMaestroFailure(realistic);
  assert.equal(out.kind, 'SELECTOR_NOT_FOUND');
  assert.equal(out.selectorKind, 'id');
  assert.equal(out.selector, 'fab-create-task');
});
