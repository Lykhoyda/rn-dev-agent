import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePlan } from '../../../dist/qa/plan.js';
import type { Block } from '../../../dist/qa/plan.js';
import type { StoredBlock } from '../../../dist/qa/blocks.js';
import { join, type NativeNode, type Screen } from '../../../dist/qa/screen.js';
import { judgeCheck } from '../../../dist/qa/resolve.js';
import { literalEvidence } from '../../../dist/qa/evidence.js';
import { replayBlock, runPlan, walkBlock } from '../../../dist/qa/walker.js';
import { scriptedJudge, walker } from './judgment-fixtures.ts';

const app = { x: 0, y: 0, width: 402, height: 874 };
const complete = { native: 'complete', react: 'complete' } as const;

type Spec = {
  type: string;
  parent?: number;
  rect?: NativeNode['rect'];
  label?: string;
  hittable?: boolean;
  identifier?: string;
};

function tree(specs: Spec[]): NativeNode[] {
  return specs.map((spec, index) => ({
    ref: `@e${index}`,
    index,
    type: spec.type,
    enabled: true,
    hittable: spec.hittable ?? false,
    ...(spec.parent === undefined ? {} : { parentIndex: spec.parent }),
    ...(spec.rect ? { rect: spec.rect } : {}),
    ...(spec.label === undefined ? {} : { label: spec.label }),
    ...(spec.identifier === undefined ? {} : { identifier: spec.identifier }),
  }));
}

const observed = (specs: Spec[], coverage: Screen['coverage'] = complete): Screen =>
  join(tree(specs), [], 'app', coverage);
const check = (screen: Screen, text: string) =>
  judgeCheck({ kind: 'check', text, literal: true }, screen);
const at = (x: number, y: number, width = 300, height = 30) => ({ x, y, width, height });

// Application, app Window, a pager strip, page titles at x = 16 / 418 / 820 (fixtures A-F).
function pager(options: { window?: boolean; pagesUnder?: 'strip' | 'application' } = {}): Screen {
  const specs: Spec[] = [{ type: 'Application', rect: app, label: 'Test App', hittable: true }];
  const windowIndex = options.window === false ? 0 : 1;
  if (options.window !== false) specs.push({ type: 'Window', parent: 0, rect: app });
  const strip = specs.length;
  specs.push({ type: 'Other', parent: windowIndex, rect: at(0, 100, 1206, 70) });
  ['Page one', 'Page two', 'Page three'].forEach((label, page) =>
    specs.push({
      type: 'StaticText',
      parent: options.pagesUnder === 'application' ? 0 : strip,
      rect: at(16 + page * 402, 120),
      label,
    }),
  );
  return observed(specs);
}

// The wizard after the keyboard moved to page 2: page 1 keeps a stale multiline input frame.
function k2(): Screen {
  return observed([
    { type: 'Application', rect: app },
    { type: 'Window', parent: 0, rect: app },
    { type: 'Other', parent: 1, rect: at(-402, 180, 402, 600) },
    { type: 'TextView', parent: 2, rect: at(24, 20, 354, 100), label: 'Describe the issue' },
    { type: 'StaticText', parent: 2, rect: at(-378, 190, 120, 20), label: 'STEP 1 OF 3' },
    { type: 'StaticText', parent: 1, rect: at(16, 120), label: 'STEP 2 OF 3' },
  ]);
}

// K2 with the same placeholder text also painted on the current page.
function k2WithVisibleTwin(): Screen {
  return observed([
    { type: 'Application', rect: app },
    { type: 'Window', parent: 0, rect: app },
    { type: 'Other', parent: 1, rect: at(-402, 180, 402, 600) },
    { type: 'TextView', parent: 2, rect: at(24, 20, 354, 100), label: 'Describe the issue' },
    { type: 'StaticText', parent: 1, rect: at(16, 400), label: 'Describe the issue' },
  ]);
}

// Home #1: a container left with a stale off-screen rect after a sheet closed; its rows are on screen.
function home1(): Screen {
  return observed([
    { type: 'Application', rect: app },
    { type: 'Window', parent: 0, rect: app },
    { type: 'Other', parent: 1, rect: at(0, 900, 402, 600) },
    { type: 'StaticText', parent: 2, rect: at(16, 300, 370, 44), label: 'Order history' },
    { type: 'StaticText', parent: 2, rect: at(16, 350, 370, 44), label: 'Saved addresses' },
  ]);
}

// Company home: accessible rows whose labels merge their painted children, with no text descendants.
function companyHome(coverage: Screen['coverage'] = complete): Screen {
  return observed(
    [
      { type: 'Application', rect: app, label: 'Test App', hittable: true },
      { type: 'Window', parent: 0, rect: app },
      { type: 'ScrollView', parent: 1, rect: at(0, 100, 402, 700) },
      {
        type: 'Other',
        parent: 2,
        rect: at(0, 100, 402, 72),
        label: 'Item 2, Status 2',
        hittable: true,
      },
      {
        type: 'Other',
        parent: 2,
        rect: at(0, 180, 402, 72),
        label: 'Item 3, Status 3',
        hittable: true,
      },
      { type: 'Other', parent: 2, rect: at(16, 260, 120, 44), label: 'Reschedule', hittable: true },
      { type: 'Other', parent: 2, rect: at(350, 260, 44, 44), label: 'Close', hittable: true },
      { type: 'Image', parent: 6, rect: at(360, 270, 24, 24) },
      {
        type: 'Other',
        parent: 2,
        rect: at(0, 1200, 402, 72),
        label: 'Item 12, Status 12',
        hittable: true,
      },
      { type: 'Other', parent: 2, rect: at(0, 320, 402, 72), label: 'Decorative banner' },
      { type: 'Other', parent: 2, rect: at(0, 400, 402, 72), label: 'Card, Renew', hittable: true },
      { type: 'StaticText', parent: 10, rect: at(16, 410, 200, 20), label: 'Card' },
      {
        type: 'Other',
        parent: 2,
        rect: at(396, 100, 4, 700),
        label: 'Vertical scroll bar, 2 pages',
        hittable: true,
      },
    ],
    coverage,
  );
}

// A long list: rows past the fold are ordinary offscreen content, never contradictions.
function longList(): Screen {
  const specs: Spec[] = [
    { type: 'Application', rect: app },
    { type: 'Window', parent: 0, rect: app },
    { type: 'ScrollView', parent: 1, rect: at(0, 100, 402, 774) },
  ];
  for (let row = 1; row <= 30; row++)
    specs.push({ type: 'StaticText', parent: 2, rect: at(16, 60 + row * 50), label: `Row ${row}` });
  return observed(specs);
}

test('V1: consistent pager shapes keep their verdicts; the K2 stale input is unsure, never PASS', () => {
  for (const screen of [pager(), pager({ window: false }), pager({ pagesUnder: 'application' })]) {
    assert.equal(check(screen, 'Page one'), 'pass');
    assert.equal(check(screen, 'Page two'), 'fail');
    assert.equal(check(screen, 'Page three'), 'fail');
  }
  const wizard = k2();
  assert.equal(check(wizard, 'Describe the issue'), 'unsure');
  assert.equal(check(wizard, 'STEP 1 OF 3'), 'fail');
  assert.equal(check(wizard, 'STEP 2 OF 3'), 'pass');
  const input = wizard.elements.find((e) => e.label === 'Describe the issue')!;
  assert.equal(input.visibilityEvidence, 'unresolved');
  assert.equal(input.offscreen, true, 'press and fill targeting keep treating it as not shown');
});

test('K1: later pages chained to no Window stay FAIL through the Application clip', () => {
  const screen = observed([
    { type: 'Application', rect: app },
    { type: 'Window', parent: 0, rect: app },
    { type: 'Window', parent: 0, rect: app },
    { type: 'Other', parent: 0, rect: at(0, 100, 1206, 700) },
    { type: 'StaticText', parent: 1, rect: at(16, 120), label: 'First page' },
    { type: 'StaticText', parent: 3, rect: at(402, 120), label: 'Second page' },
    { type: 'StaticText', parent: 3, rect: at(804, 120), label: 'Third page' },
    { type: 'Keyboard', parent: 2, rect: at(0, 538, 402, 336) },
  ]);
  assert.equal(check(screen, 'First page'), 'pass');
  assert.equal(check(screen, 'Second page'), 'fail');
  assert.equal(check(screen, 'Third page'), 'fail');
});

test('V2: home #1 rows under a stale off-screen container PASS; only the container is unresolved', () => {
  const screen = home1();
  assert.equal(check(screen, 'Order history'), 'pass');
  assert.equal(check(screen, 'Saved addresses'), 'pass');
  assert.equal(check(screen, 'Payment methods'), 'fail');
  assert.deepEqual(
    screen.elements.map((e) => e.visibilityEvidence),
    ['visible', 'visible', 'unresolved', 'visible', 'visible'],
  );
});

test('V3: merged-label rows PASS from their accessibility label, with a sentinel FAIL', () => {
  const screen = companyHome();
  for (const text of ['Item 2', 'Status 3', 'Reschedule'])
    assert.deepEqual(
      literalEvidence(screen, text, 'contains'),
      { verdict: 'pass', label: true },
      text,
    );
  assert.equal(check(screen, 'Item 2'), 'pass');
  assert.equal(
    check(screen, 'Close'),
    'pass',
    'the accepted residual: an icon-only labelled control',
  );
  assert.equal(check(screen, 'Item 12'), 'fail', 'a merged row below the fold');
  assert.equal(check(screen, 'Nowhere to be found'), 'fail');
  assert.equal(check(screen, 'Decorative banner'), 'fail', 'not hittable');
  assert.equal(
    check(screen, 'Renew'),
    'fail',
    'a container with a text descendant contributes only that text',
  );
  assert.equal(check(screen, 'Card'), 'pass');
  assert.equal(check(screen, 'Test App'), 'fail', 'the Application is structural');
  assert.equal(check(screen, 'scroll bar'), 'fail', 'system scroll bars are not app text');
  assert.deepEqual(literalEvidence(screen, 'Card', 'contains'), { verdict: 'pass' });
  assert.ok(!screen.visibleText.includes('Reschedule'), 'painted text stays painted text only');
});

test('absence needs a complete native snapshot; otherwise a miss is unsure', () => {
  const partial = companyHome({ native: 'incomplete', react: 'complete' });
  assert.equal(check(partial, 'Item 2'), 'pass');
  assert.equal(check(partial, 'Nowhere to be found'), 'unsure');
  const fromCapture = {
    ...companyHome(),
    captureCoverage: complete,
    coverage: { native: 'unknown', react: 'unknown' },
  } as Screen;
  assert.equal(
    check(fromCapture, 'Nowhere to be found'),
    'fail',
    'literal checks read the snapshot coverage',
  );
});

test('V4: below-the-fold rows are offscreen, never unresolved', () => {
  const screen = longList();
  assert.equal(check(screen, 'Row 3'), 'pass');
  for (const row of [20, 25, 30]) assert.equal(check(screen, `Row ${row}`), 'fail');
  assert.equal(screen.elements.filter((e) => e.visibilityEvidence === 'unresolved').length, 0);
  assert.ok(screen.elements.some((e) => e.visibilityEvidence === 'offscreen'));
});

function blockOf(markdown: string): Block[] {
  const parsed = parsePlan(markdown);
  assert.ok(parsed.blocks, JSON.stringify(parsed.refused));
  return parsed.blocks;
}

const noJev = () => scriptedJudge(() => assert.fail('a literal target must never ask Jev'));

async function consumers(screen: Screen, text: string) {
  const plan = (line: string) => `## QA\n\n### Literal\n1. ${line}\n`;
  const outcome = async (line: string) => {
    const f = walker([screen], noJev());
    const result = await runPlan(blockOf(plan(line)), f.deps);
    assert.notEqual(result.verdict, 'REFUSED', JSON.stringify(result));
    return {
      verdict: result.verdict,
      seen: 'failure' in result ? (result.failure?.seen ?? '') : '',
      reason: 'steps' in result ? result.steps.at(-1)?.reason : undefined,
      actions: f.actions,
    };
  };
  const [block] = blockOf(plan(`Wait for "${text}"`));
  const stored: StoredBlock = {
    header: { appId: 'com.example.app', plan: 'plan.md', planHash: 'x', platform: 'ios' },
    steps: [{ raw: block.items[0].raw, kind: 'wait', selector: { text } }],
  };
  const f = walker([screen], noJev());
  const replay = await walkBlock(replayBlock(block, stored), f.deps, 0, [], undefined, undefined, {
    mode: 'replay',
  });
  return {
    wait: await outcome(`Wait for "${text}"`),
    scroll: await outcome(`Scroll down until "${text}"`),
    replay: {
      failed: replay.failure !== undefined,
      seen: replay.failure?.seen ?? '',
      miss: replay.miss,
      line: block.items[0].line,
    },
  };
}

async function checkRow(screen: Screen, text: string) {
  const f = walker([screen], noJev());
  const result = await runPlan(blockOf(`## QA\n\n### Literal\n✓ "${text}"\n`), f.deps);
  assert.notEqual(result.verdict, 'REFUSED', JSON.stringify(result));
  return result as Extract<typeof result, { steps: unknown }>;
}

test('V5: check, wait, scroll-until and replay share one rule on the same screen', async (t) => {
  await t.test('pass', async () => {
    for (const [screen, text] of [
      [home1(), 'Order history'],
      [companyHome(), 'Reschedule'],
      [longList(), 'Row 3'],
    ] as const) {
      const row = await checkRow(screen, text);
      assert.equal(row.verdict, 'PASS', text);
      const c = await consumers(screen, text);
      assert.equal(c.wait.verdict, 'PASS', text);
      assert.equal(c.scroll.verdict, 'PASS', text);
      assert.deepEqual(c.scroll.actions, [], text);
      assert.equal(c.replay.failed, false, `${text}: ${c.replay.seen}`);
    }
  });
  await t.test('a label-source pass is annotated on the check row', async () => {
    const labelled = await checkRow(companyHome(), 'Item 2');
    assert.equal(labelled.verdict, 'PASS');
    assert.match(labelled.steps[0].reason ?? '', /matched an accessibility label/);
    const painted = await checkRow(home1(), 'Order history');
    assert.equal(painted.steps[0].reason, undefined);
  });
  await t.test('unsure is never a plain FAIL and never a PASS', async () => {
    const screen = k2();
    const row = await checkRow(screen, 'Describe the issue');
    assert.equal(row.verdict, 'FAIL');
    assert.match(row.failure?.seen ?? '', /CHECK_UNSURE/);
    const c = await consumers(screen, 'Describe the issue');
    for (const consumer of [c.wait, c.scroll]) {
      assert.equal(consumer.verdict, 'FAIL');
      assert.match(consumer.seen, /VISIBILITY_UNSURE: "Describe the issue" stayed unresolved/);
    }
    assert.equal(c.replay.failed, true);
    assert.equal(c.replay.miss, undefined, 'an unresolved occurrence is not a missing selector');
    assert.match(c.replay.seen, /VISIBILITY_UNSURE: "Describe the issue" stayed unresolved/);
  });
  await t.test('fail', async () => {
    const screen = longList();
    const row = await checkRow(screen, 'Row 25');
    assert.match(row.failure?.seen ?? '', /"Row 25" is not satisfied on screen/);
    const c = await consumers(screen, 'Row 25');
    assert.match(c.wait.seen, /VISIBILITY_UNSURE: ITEM_DEADLINE_EXCEEDED/);
    assert.match(c.scroll.seen, /did not come into view/);
    assert.equal(c.replay.miss, c.replay.line);
  });
});

test('a visible occurrence wins over the same text on an unresolved frame, for every consumer', async () => {
  const screen = k2WithVisibleTwin();
  assert.deepEqual(screen.unresolvedText, ['Describe the issue']);
  assert.equal(check(screen, 'Describe the issue'), 'pass');
  assert.equal((await checkRow(screen, 'Describe the issue')).verdict, 'PASS');
  const c = await consumers(screen, 'Describe the issue');
  assert.equal(c.wait.verdict, 'PASS');
  assert.equal(c.scroll.verdict, 'PASS');
  assert.equal(c.replay.failed, false, c.replay.seen);
});

test('an incomplete snapshot never turns a miss into a definite absence in any consumer', async () => {
  const partial = companyHome({ native: 'incomplete', react: 'complete' });
  const row = await checkRow(partial, 'Nowhere to be found');
  assert.match(row.failure?.seen ?? '', /CHECK_UNSURE/);
  const c = await consumers(partial, 'Nowhere to be found');
  for (const consumer of [c.wait, c.scroll]) {
    assert.equal(consumer.verdict, 'FAIL');
    assert.match(consumer.seen, /SCREEN_EVIDENCE_INCOMPLETE: NATIVE_ACQUISITION_UNUSABLE/);
  }
  assert.equal(c.replay.miss, undefined);
  assert.match(c.replay.seen, /SCREEN_EVIDENCE_INCOMPLETE: NATIVE_ACQUISITION_UNUSABLE/);
});
