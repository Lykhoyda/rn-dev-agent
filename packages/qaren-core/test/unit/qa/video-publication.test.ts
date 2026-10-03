import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePlan } from '../../../dist/qa/plan.js';
import { capturePrivateScreen } from '../../../dist/qa/privacy.js';
import { runPlan } from '../../../dist/qa/walker.js';
import { element, screen, scriptedJudge, walker } from './judgment-fixtures.ts';

test('video eligibility follows the entire plan and sticky screenshot privacy', async () => {
  for (const [plan, sensitive, expected] of [
    ['1. Tap "Save"', false, 'eligible'],
    ['1. Fill "Email" with "hello"', false, 'withheld-fill'],
    ['1. Type "private-canary" into "Email"', false, 'withheld-fill'],
    ['1. Tap "Save"', true, 'withheld-privacy'],
    ['1. Wait for "Missing"\n2. Fill "Email" with "private-canary"', false, 'withheld-fill'],
  ] as const) {
    const observed = screen([
      element('@save', 'Save'),
      element('@email', 'Email', { kind: 'input' }),
    ]);
    if (sensitive)
      capturePrivateScreen(observed, [
        {
          values: ['prefilled-canary'],
          secure: false,
          elements: [],
          associationUnique: false,
        },
      ]);
    const cleared = screen(observed.elements);
    const f = walker(
      [observed, cleared],
      scriptedJudge(() => assert.fail('literal plan is model-free')),
    );
    const result = await runPlan(parsePlan(plan).blocks!, f.deps);
    assert.equal(result.videoPublication, expected);
    assert.equal(result.verdict, plan.includes('Missing') ? 'FAIL' : 'PASS');
    assert.doesNotMatch(JSON.stringify(result), /private-canary|prefilled-canary/);
  }
});
