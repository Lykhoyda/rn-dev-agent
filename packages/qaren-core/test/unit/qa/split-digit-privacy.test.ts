import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MASK, ObservedPrivacy } from '../../../dist/qa/privacy.js';

test('a protected value never leaks through single-character or split substrings', () => {
  const privacy = new ObservedPrivacy();
  privacy.concealFallback('1234');
  const masked = privacy.redact(
    'on screen: Enter the code | 1 | 2 | 3 | 4 | 12 | 34 | Verify | 56 | 9',
  );
  assert.equal(/[1-4]/.test(masked), false, masked);
  assert.match(masked, /Enter the code/);
  assert.match(masked, /Verify/);
  assert.match(masked, /\| 56 \|/);
  assert.match(masked, /\| 9$/);
  assert.ok(masked.includes(MASK));
});

test('substring masking applies only to protected values, not ordinary typed text', () => {
  const privacy = new ObservedPrivacy(['Ada']);
  assert.equal(
    privacy.redact('on screen: a | d | Ada Lovelace'),
    'on screen: a | d | ••• Lovelace',
  );
});

test('a protected fragment with trailing punctuation is still masked; identifiers stay whole', () => {
  const privacy = new ObservedPrivacy();
  privacy.concealFallback('1234');
  privacy.concealFallback('qa@example.test');
  assert.equal(
    privacy.redact('last box 4. near qa-hidden-email'),
    'last box ••• near qa-hidden-email',
  );
});
