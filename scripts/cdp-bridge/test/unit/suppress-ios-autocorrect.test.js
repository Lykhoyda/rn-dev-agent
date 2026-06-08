import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suppressIOSAutocorrect, IOS_KEYBOARD_PREF_KEYS } from '../../dist/runners/suppress-ios-autocorrect.js';

test('one defaults write per key, scoped to the udid', async () => {
  const calls = [];
  const res = await suppressIOSAutocorrect('UDID-123', { run: async (a) => { calls.push(a); } });
  assert.equal(calls.length, IOS_KEYBOARD_PREF_KEYS.length);
  for (const c of calls) assert.deepEqual(c.slice(0, 5), ['simctl', 'spawn', 'UDID-123', 'defaults', 'write']);
  assert.deepEqual(res.warnings, []);
});
test('does NOT include KeyboardCapitalization (behavior-changing)', () => {
  assert.ok(!IOS_KEYBOARD_PREF_KEYS.some((k) => k[0] === 'KeyboardCapitalization'));
});
test('fail-open: a failing write becomes a warning, others continue', async () => {
  let n = 0;
  const res = await suppressIOSAutocorrect('UDID-123', { run: async () => { n++; if (n === 1) throw new Error('boom'); } });
  assert.equal(res.warnings.length, 1);
  assert.match(res.warnings[0], /boom/);
});
test('no udid → no-op', async () => {
  const calls = [];
  const res = await suppressIOSAutocorrect('', { run: async (a) => { calls.push(a); } });
  assert.equal(calls.length, 0);
  assert.equal(res.skipped, true);
});
