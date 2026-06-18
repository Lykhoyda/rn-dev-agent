import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyFlowResult,
  skippedResult,
  computeVerdict,
  diffNewlyFailing,
} from '../../dist/domain/e2e-run.js';

test('passed flow → pass', () => {
  const r = classifyFlowResult({ testId: 'a', intent: 'A', passed: true, durationMs: 10, output: 'Flow PASSED' });
  assert.equal(r.classification, 'pass');
});

test('real maestro selector-not-found output → regression', () => {
  const r = classifyFlowResult({
    testId: 'a', intent: 'A', passed: false, durationMs: 10,
    output: "Element not found: id='submitButton'",
  });
  assert.equal(r.classification, 'regression');
  assert.equal(r.failureKind, 'SELECTOR_NOT_FOUND');
});

test('real maestro timeout output → still red, annotated infra', () => {
  const r = classifyFlowResult({
    testId: 'a', intent: 'A', passed: false, durationMs: 99,
    output: "Timed out waiting for element with id 'spinner'",
  });
  assert.equal(r.passed, false);
  assert.equal(r.failureKind, 'TIMEOUT');
  assert.equal(r.infraAnnotation, 'likely-infrastructure (timeout)');
});

test('skippedResult is neither pass nor fail for the verdict', () => {
  const s = skippedResult('p', 'P', 'needs params');
  assert.equal(s.classification, 'skipped');
  assert.equal(computeVerdict([{ classification: 'pass', passed: true }, s]), 'green');
});

test('computeVerdict: any non-skipped failure → red', () => {
  assert.equal(computeVerdict([{ classification: 'pass', passed: true }]), 'green');
  assert.equal(computeVerdict([{ classification: 'infra', passed: false }]), 'red');
});

test('diffNewlyFailing ignores skipped + finds newly-broken', () => {
  const prev = { results: [{ testId: 'a', passed: true, classification: 'pass' }, { testId: 'b', passed: true, classification: 'pass' }] };
  const cur = { results: [
    { testId: 'a', passed: false, classification: 'regression' },
    { testId: 'b', passed: true, classification: 'pass' },
    { testId: 'c', passed: false, classification: 'skipped' },
  ] };
  assert.deepEqual(diffNewlyFailing(cur, prev), ['a']);
  assert.deepEqual(diffNewlyFailing(cur, null), ['a']);
});
