import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertCheck } from '../assert-qaren-check.ts';
import { readFileSync } from 'node:fs';

const receipt = { result: 'pass', ledger: { verdict: 'PASS' } };
const base = {
  verdict: 'PASS',
  llmTurns: 0,
  escapes: 0,
  recoveries: 0,
  steps: [{ resolvedBy: 'exact' }],
  jev: { calls: 1, callDetails: [{ scope: 'preflight', outcome: 'ok' }] },
};

test('the phrase gate cannot pass merely because the fixed preflight probe ran', () => {
  assert.doesNotThrow(() => assertCheck(receipt, base, false));
  assert.throws(() => assertCheck(receipt, base, true), /preflight alone is insufficient/);
  const phrase = {
    ...base,
    steps: [{ resolvedBy: 'jev' }],
    jev: { calls: 2, callDetails: [...base.jev.callDetails, { scope: 'walk', outcome: 'ok' }] },
  };
  assert.doesNotThrow(() => assertCheck(receipt, phrase, true));
  assert.throws(() => assertCheck(receipt, { ...phrase, llmTurns: 1 }, true), /escape/);
  assert.throws(() => assertCheck(receipt, { ...phrase, verdict: 'FAIL' }, true), /both say PASS/);
  assert.throws(() => assertCheck({}, phrase, true), /both say PASS/);
});

test('the phrase gate plan has no quotes and covers the same onboarding journey', () => {
  const plan = readFileSync(
    new URL('../../packages/qaren-core/test/fixtures/plans/phrases.md', import.meta.url),
    'utf8',
  );
  assert.ok(!/["“”]/.test(plan));
  assert.match(plan, /skip onboarding/);
  assert.match(plan, /tasks tab/);
  assert.equal(plan.split('\n').filter((l) => l.startsWith('✓')).length, 2);
});
