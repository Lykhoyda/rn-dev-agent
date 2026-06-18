// GH #119: cascading-selector hardening. When auto-repair patches
// selector A→A' and the retry then fails on a DIFFERENT selector B,
// AutoRepairOutcome.nextFailedSelector captures B so MTTR can
// distinguish "patch didn't work" from "patch worked, next selector
// broke."
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const RUN_ACTION_PATH = '../../dist/tools/run-action.js';

function makeProject() {
  const root = mkdtempSync(join(tmpdir(), 'gh119-'));
  mkdirSync(join(root, '.rn-agent', 'actions'), { recursive: true });
  writeFileSync(
    join(root, '.rn-agent', 'actions', 'sample.yaml'),
    [
      'appId: com.test.app',
      '---',
      '# id: sample',
      '# intent: a sample',
      '# status: experimental',
      '# mutates: false',
      '- launchApp',
      '- tapOn:',
      '    id: "btn-A"',
    ].join('\n'),
  );
  return root;
}

test('AutoRepairOutcome.nextFailedSelector populated when retry fails on a different selector', async () => {
  const { createRunActionHandler } = await import(RUN_ACTION_PATH);
  const root = makeProject();

  // First call: maestro fails with SELECTOR_NOT_FOUND on selector "btn-A".
  // Second call (post-repair retry): maestro fails on a DIFFERENT selector
  // "btn-B" → cascading failure.
  let mCount = 0;
  const fakeMaestroRun = mock.fn(async () => {
    mCount++;
    if (mCount === 1) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ok: true,
              data: { passed: false, output: '== Element with id "btn-A" not found ==' },
            }),
          },
        ],
      };
    }
    // Retry: also fails, but on a different selector
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            ok: true,
            data: { passed: false, output: '== Element with id "btn-B" not found ==' },
          }),
        },
      ],
    };
  });

  const fakeRepairAction = mock.fn(async () => ({
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          ok: true,
          data: { patched: true, oldSelector: 'btn-A', newSelector: 'btn-A-new', score: 0.9 },
          meta: { repairTimestamp: new Date().toISOString() },
        }),
      },
    ],
  }));

  const handler = createRunActionHandler({
    maestroRun: fakeMaestroRun,
    repairAction: fakeRepairAction,
  });
  const result = await handler({
    actionId: 'sample',
    projectRoot: root,
    platform: 'ios',
    autoRepair: true,
  });

  // Result should be a failResult with the autoRepair meta
  assert.equal(result.isError, true);
  const env = JSON.parse(result.content[0].text);
  // The autoRepair payload is in meta (failResult shape)
  const autoRepair = env.meta?.autoRepair ?? env.data?.autoRepair;
  assert.ok(
    autoRepair,
    `expected autoRepair in envelope; got ${result.content[0].text.slice(0, 300)}`,
  );
  assert.equal(autoRepair.outcome, 'failed');
  // The fix's contract: when retry fails on a different selector, capture it
  assert.equal(
    autoRepair.nextFailedSelector,
    'btn-B',
    `nextFailedSelector should be the retry's failed selector; got ${autoRepair.nextFailedSelector}`,
  );
  // The original diff stays unchanged
  assert.equal(autoRepair.diff?.selector?.from, 'btn-A');
  assert.equal(autoRepair.diff?.selector?.to, 'btn-A-new');

  rmSync(root, { recursive: true, force: true });
});

test('AutoRepairOutcome.nextFailedSelector NOT populated when retry fails on the SAME selector (patch did not work)', async () => {
  const { createRunActionHandler } = await import(RUN_ACTION_PATH);
  const root = makeProject();

  let mCount = 0;
  const fakeMaestroRun = mock.fn(async () => {
    mCount++;
    if (mCount === 1) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ok: true,
              data: { passed: false, output: '== Element with id "btn-A" not found ==' },
            }),
          },
        ],
      };
    }
    // Retry fails on the SAME (newly patched) selector — patch didn't work
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            ok: true,
            data: { passed: false, output: '== Element with id "btn-A-new" not found ==' },
          }),
        },
      ],
    };
  });

  const fakeRepairAction = mock.fn(async () => ({
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          ok: true,
          data: { patched: true, oldSelector: 'btn-A', newSelector: 'btn-A-new' },
          meta: { repairTimestamp: new Date().toISOString() },
        }),
      },
    ],
  }));

  const handler = createRunActionHandler({
    maestroRun: fakeMaestroRun,
    repairAction: fakeRepairAction,
  });
  const result = await handler({
    actionId: 'sample',
    projectRoot: root,
    platform: 'ios',
    autoRepair: true,
  });

  const env = JSON.parse(result.content[0].text);
  const autoRepair = env.meta?.autoRepair ?? env.data?.autoRepair;
  assert.ok(autoRepair);
  assert.equal(autoRepair.outcome, 'failed');
  // No cascading selector — should be absent
  assert.equal(
    autoRepair.nextFailedSelector,
    undefined,
    `nextFailedSelector should NOT be present when same selector failed; got ${autoRepair.nextFailedSelector}`,
  );

  rmSync(root, { recursive: true, force: true });
});

test('AutoRepairOutcome.nextFailedSelector NOT populated when retry passed (happy repair path)', async () => {
  const { createRunActionHandler } = await import(RUN_ACTION_PATH);
  const root = makeProject();

  let mCount = 0;
  const fakeMaestroRun = mock.fn(async () => {
    mCount++;
    if (mCount === 1) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ok: true,
              data: { passed: false, output: '== Element with id "btn-A" not found ==' },
            }),
          },
        ],
      };
    }
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ ok: true, data: { passed: true, output: 'pass' } }),
        },
      ],
    };
  });

  const fakeRepairAction = mock.fn(async () => ({
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          ok: true,
          data: { patched: true, oldSelector: 'btn-A', newSelector: 'btn-A-new' },
          meta: { repairTimestamp: new Date().toISOString() },
        }),
      },
    ],
  }));

  const handler = createRunActionHandler({
    maestroRun: fakeMaestroRun,
    repairAction: fakeRepairAction,
  });
  const result = await handler({
    actionId: 'sample',
    projectRoot: root,
    platform: 'ios',
    autoRepair: true,
  });

  assert.equal(result.isError, undefined);
  const env = JSON.parse(result.content[0].text);
  const autoRepair = env.data.autoRepair;
  assert.equal(autoRepair.outcome, 'passed');
  assert.equal(autoRepair.nextFailedSelector, undefined);

  rmSync(root, { recursive: true, force: true });
});
