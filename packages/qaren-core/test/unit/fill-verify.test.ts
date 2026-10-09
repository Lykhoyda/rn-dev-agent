import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyNativeVerification } from '../../dist/handlers/fill-verify.js';

test('stable exact native verification is the only success', () => {
  assert.deepEqual(classifyNativeVerification('exact', true), {
    verified: true,
    evidence: 'exact',
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

test('evidence classes: only a stable exact read verifies; obscured or unstable reads are unavailable', () => {
  const evidence = (verdict: Parameters<typeof classifyNativeVerification>[0], stable: boolean) =>
    classifyNativeVerification(verdict, stable).evidence;
  assert.equal(evidence('exact', true), 'exact');
  assert.equal(evidence('secure-masked', true), 'masked');
  assert.equal(evidence('mismatch', true), 'mismatch');
  for (const verdict of ['unreadable', 'target-lost', 'ambiguous', 'unavailable'] as const)
    assert.equal(evidence(verdict, true), 'unavailable', verdict);
  for (const verdict of ['exact', 'secure-masked', 'mismatch'] as const)
    assert.equal(evidence(verdict, false), 'unavailable', verdict);
});
