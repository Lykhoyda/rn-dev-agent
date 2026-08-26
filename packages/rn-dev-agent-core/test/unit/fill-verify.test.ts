import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyNativeVerification } from '../../dist/tools/fill-verify.js';

test('stable exact native verification is the only success', () => {
  assert.deepEqual(classifyNativeVerification('exact', true), {
    verified: true,
    native: 'exact',
    nativeStable: true,
    observedMismatch: false,
  });
  for (const [verdict, stable] of [
    ['exact', false],
    ['mismatch', true],
    ['unreadable', false],
    ['secure-masked', true],
    ['target-lost', false],
    ['ambiguous', false],
    ['unavailable', false],
  ] as const) {
    assert.equal(classifyNativeVerification(verdict, stable).verified, false, verdict);
  }
});
