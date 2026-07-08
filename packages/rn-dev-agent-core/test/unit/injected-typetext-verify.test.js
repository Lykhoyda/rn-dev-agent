import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INJECTED_HELPERS, HELPERS_VERSION } from '../../dist/injected-helpers.js';

function typeTextSlice() {
  const open = INJECTED_HELPERS.indexOf("action === 'typeText'");
  const close = INJECTED_HELPERS.indexOf("action === 'setFieldValue'", open);
  assert.ok(open >= 0 && close > open, 'typeText branch not sliceable');
  return INJECTED_HELPERS.slice(open, close);
}
function verifyNoHandlerSlice() {
  const s = typeTextSlice();
  const open = s.indexOf('if (verify)');
  assert.ok(open >= 0, 'verify no-handler block missing');
  return s.slice(open, open + 400);
}

test('#321: HELPERS_VERSION >= 26 baseline (value-agnostic; feature branches bump freely)', () => {
  assert.ok(HELPERS_VERSION >= 26, 'HELPERS_VERSION must not regress below the #321 baseline (26)');
});
test('#191: verify mode reads opts.verify', () => {
  assert.match(typeTextSlice(), /opts\.verify/);
});
test('#191: verify no-handler return emits handlerCalled:false and fires NOTHING', () => {
  const v = verifyNoHandlerSlice();
  assert.match(v, /handlerCalled:\s*false/);
  assert.doesNotMatch(v, /props\.onChangeText\(text\)/);
  assert.doesNotMatch(v, /props\.onChange\(/);
});
test('#191: verify success payloads carry controlled + valueBefore', () => {
  const s = typeTextSlice();
  assert.match(s, /controlled:/);
  assert.match(s, /valueBefore:/);
});
test('#191: legacy non-verify path keeps the "no handler" error', () => {
  assert.match(typeTextSlice(), /Component has no onChangeText or onChange handler/);
});
test('#191: readInputValue exposed on the public API', () => {
  assert.match(INJECTED_HELPERS, /readInputValue:\s*readInputValue/);
});
