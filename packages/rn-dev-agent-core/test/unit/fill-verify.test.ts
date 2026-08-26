import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  classifyNativeVerification,
  decideNativeRetype,
  type NativeVerification,
} from '../../dist/tools/fill-verify.js';

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

test('only a stable native mismatch permits a bounded clear-first retype', () => {
  const mismatch: NativeVerification = classifyNativeVerification('mismatch', true);
  assert.deepEqual(decideNativeRetype(mismatch, 0, 2), { action: 'retype', delayMs: 40 });
  assert.deepEqual(decideNativeRetype(mismatch, 2, 2), { action: 'escalate' });
  assert.deepEqual(decideNativeRetype(classifyNativeVerification('unreadable', false), 0, 2), {
    action: 'escalate',
  });
});
