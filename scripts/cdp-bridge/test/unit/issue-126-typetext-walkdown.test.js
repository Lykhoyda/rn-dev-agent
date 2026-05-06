// Issue #126 Fix A — typeText descendant walk source-guard tests.
// Validates the IIFE structure for the new typeText handler resolution
// path: when matched fiber has no onChangeText/onChange, walk descendants
// for a typeable child. The IIFE runs in Hermes; behavioral tests run
// against the live device. These guards prevent silent regressions to
// the old immediate-fiber-only behavior.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INJECTED_HELPERS } from '../../dist/injected-helpers.js';

// Slice typeText branch from the IIFE — everything between
// `action === 'typeText'` and the next `action === 'scroll'` block.
function typeTextSlice() {
  const open = INJECTED_HELPERS.indexOf("action === 'typeText'");
  const close = INJECTED_HELPERS.indexOf("action === 'scroll'", open);
  assert.ok(open >= 0, 'typeText branch not found in IIFE');
  assert.ok(close > open, 'scroll branch not found after typeText (slice would be unbounded)');
  return INJECTED_HELPERS.slice(open, close);
}

test('Issue #126: typeText Path 1 (matched-fiber) is single-fire — picks onChangeText if present, else onChange', () => {
  const slice = typeTextSlice();
  // Path 1 single-fires after multi-LLM review caught the double-fire
  // bug on RHF Controllers (Gemini H1 from implementation review).
  assert.match(slice, /typeof props\.onChangeText === 'function' \|\| typeof props\.onChange === 'function'/);
  assert.match(slice, /resolvedFrom: 'matched-fiber'/);
  // Single-fire structure: if-onChangeText-else-onChange (NOT if-then-if).
  assert.match(slice, /if \(typeof props\.onChangeText === 'function'\) \{[^}]*p1Handler = 'onChangeText';[^}]*props\.onChangeText\(text\);[^}]*\} else \{[^}]*p1Handler = 'onChange';[^}]*props\.onChange\(/);
});

test('Issue #126: typeText descendant walk has TextInput-family type fingerprint (anchored, no bare Input/Field)', () => {
  const slice = typeTextSlice();
  // TYPEABLE_TYPE_RE was tightened after multi-LLM review: bare `Input`
  // and `Field` substrings produced false positives on RadioGroupField,
  // InputAccessoryView, BottomSheetTextInput's wrapper, etc.
  assert.match(slice, /TYPEABLE_TYPE_RE\s*=\s*\/\(TextInput\|TextField\|EditText\)\//);
  // Negative guard — make sure the loose form doesn't sneak back in.
  assert.doesNotMatch(slice, /\(TextInput\|Input\|Field\|TextField\|EditText\)/);
});

test('Issue #126: dedupe candidates by handler-function identity (Codex M4 from impl review)', () => {
  const slice = typeTextSlice();
  // react-native-paper's TextInputOutlined → TextInput → InternalTextInput
  // chain forwards the same onChangeText down. Without dedupe, the impl
  // returns Ambiguous error on a perfectly normal Paper TextField. Fix:
  // group candidates by handler function reference, keep the deepest leaf.
  assert.match(slice, /function dedupeByHandlerIdentity/);
  assert.match(slice, /byFn\[j\]\.props\[handlerName\] === fn/);
  // Prefer-deepest tiebreak.
  assert.match(slice, /m\.depth > byFn\[existingIdx\]\.depth/);
});

test('Issue #126: typeText descendant walk is depth- and visit-bounded', () => {
  const slice = typeTextSlice();
  assert.match(slice, /DESCENDANT_DEPTH_CAP\s*=\s*16/);
  assert.match(slice, /DESCENDANT_VISIT_CAP\s*=\s*200/);
});

test('Issue #126: typeText is two-pass — onChangeText first, then onChange', () => {
  const slice = typeTextSlice();
  const pass1 = slice.indexOf("findHandlerDescendants('onChangeText')");
  const pass2 = slice.indexOf("findHandlerDescendants('onChange')");
  assert.ok(pass1 >= 0, 'pass 1 (onChangeText) findHandlerDescendants call missing');
  assert.ok(pass2 >= 0, 'pass 2 (onChange) findHandlerDescendants call missing');
  assert.ok(pass1 < pass2, 'onChangeText pass must come before onChange pass (avoids double-fire on RHF Controller-wrapped fields)');
});

test('Issue #126: typeText descendant walk single-fires (no double-fire bug from descendants)', () => {
  const slice = typeTextSlice();
  // The picked-handler dispatch is an if/else, not an if/if. This prevents
  // the double-fire bug Codex H1 caught: RHF Controller's field.onChange
  // wired to onChangeText + RN HostComponent onChange would each run with
  // different argument shapes, double-applying or triggering RHF's
  // validator twice.
  assert.match(
    slice,
    /if \(picked\.handler === 'onChangeText'\) \{[^}]*picked\.match\.props\.onChangeText\(text\);[^}]*\} else \{[^}]*picked\.match\.props\.onChange\(/,
  );
});

test('Issue #126: typeText returns Ambiguous error when multiple type-fingerprint matches', () => {
  const slice = typeTextSlice();
  assert.match(slice, /Ambiguous typeText resolution/);
  // Two distinct ambiguity reports — pass 1 (onChangeText) and pass 2 (onChange).
  const ambiguousCount = (slice.match(/Ambiguous typeText resolution/g) || []).length;
  assert.equal(ambiguousCount, 2, 'expected 2 Ambiguous error returns (pass 1 + pass 2)');
});

test('Issue #126: typeText success payload includes resolvedFrom + handlerCalled + visitedFibers', () => {
  const slice = typeTextSlice();
  assert.match(slice, /resolvedFrom: picked\.match\.name/);
  assert.match(slice, /handlerCalled: picked\.handler/);
  assert.match(slice, /visitedFibers: visited/);
});

test('Issue #126: typeText error message hints at depth + visited count for debugging', () => {
  const slice = typeTextSlice();
  // The "no descendant has typeable handler" error includes diagnostic
  // hints — depth cap + visit count + cdp_component_tree pointer.
  assert.match(slice, /Walked up to ' \+ DESCENDANT_DEPTH_CAP \+ ' levels \(' \+ visited \+ ' fibers\)/);
  assert.match(slice, /cdp_component_tree to inspect/);
});

test('Issue #126: source guard — typeText branch length sanity', () => {
  // Loose bounds — only catches "code path completely removed" (lower)
  // or "accidental duplication of the entire branch" (upper). Codex M5
  // from impl review flagged tight bounds as fragile; widened.
  const slice = typeTextSlice();
  assert.ok(slice.length > 3500, `typeText branch unexpectedly short (${slice.length} bytes); descendant walk may have been removed`);
  assert.ok(slice.length < 15000, `typeText branch unexpectedly long (${slice.length} bytes); accidental copy or runaway code?`);
});
