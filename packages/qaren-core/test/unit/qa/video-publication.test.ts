import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePlan } from '../../../dist/qa/plan.js';
import { capturePrivateScreen } from '../../../dist/qa/privacy.js';
import { runPlan } from '../../../dist/qa/walker.js';
import { postAdmissionSnapshots } from '../../../dist/qa/capture.js';
import { okResult, failResult } from '../../../dist/utils.js';
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

test('post-admission startup observations remain in the ledger after normal walker captures', async () => {
  const app = okResult(
    { appProcessIdentifier: 41, nodes: [] },
    {
      meta: { foregroundSurface: 'app' },
    },
  );
  for (const [event, startup, expected] of [
    ['picker', okResult({ nodes: [{ type: 'StaticText', label: 'Development servers' }] }), true],
    ['picker metadata', okResult({}, { meta: { foregroundSurface: 'dev_client_picker' } }), true],
    [
      'launcher tutorial',
      okResult({}, { meta: { foregroundSurface: 'first_run_tutorial' } }),
      true,
    ],
    [
      'recovery',
      okResult({}, { meta: { recovered: 'agent-device-runner-leak', recoveryTier: 'relaunch' } }),
      true,
    ],
    [
      'failed recovery',
      failResult('recovery failed', { code: 'RUNNER_LEAK', recoveryReason: 'relaunch-failed' }),
      true,
    ],
    ['process change', okResult({ appProcessIdentifier: 77, nodes: [] }), true],
    ['process lost', failResult('app stopped', { reason: 'app-not-running' }), true],
    ['normal app', app, false],
  ] as const) {
    let probes = 0;
    const forwarded: { action: 'snapshot'; qaReadOnly?: boolean }[] = [];
    const snapshots = postAdmissionSnapshots(
      async (args: { action: 'snapshot'; qaReadOnly?: boolean }) => {
        probes += 1;
        forwarded.push(args);
        return probes === 2 ? startup : app;
      },
      'com.test',
    );
    await snapshots.snapshot({ action: 'snapshot' });
    const observed = await snapshots.snapshot({ action: 'snapshot' });
    assert.equal(observed, startup);
    const f = walker(
      [screen([element('@save', 'Save')])],
      scriptedJudge(() => assert.fail('literal plan')),
    );
    const capture = f.deps.captureScreen;
    f.deps.captureScreen = async (options) => {
      await snapshots.snapshot({ action: 'snapshot', qaReadOnly: true });
      return { ...(await capture(options)), appProcessIdentifier: 41 };
    };
    f.deps.appProcess = {};
    f.deps.publicationInterrupted = snapshots.interrupted;
    const result = await runPlan(parsePlan('1. Tap "Save"').blocks!, f.deps);
    assert.equal(result.verdict, 'PASS', event);
    assert.equal(result.publicationInterrupted, expected, event);
    assert.equal(f.deps.appProcess.expected, 41, event);
    assert.deepEqual(f.actions, ['press @save'], event);
    assert.ok(probes > 2);
    assert.deepEqual(forwarded.slice(0, 2), [{ action: 'snapshot' }, { action: 'snapshot' }]);
    assert.equal(forwarded.at(-1)?.qaReadOnly, true);
  }
});
