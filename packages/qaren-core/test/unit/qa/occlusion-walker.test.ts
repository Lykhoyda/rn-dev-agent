// A runner occlusion refusal at dispatch scrolls once and retries the same identity.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePlan } from '../../../dist/qa/plan.js';
import { join } from '../../../dist/qa/screen.js';
import type { NativeNode, Screen } from '../../../dist/qa/screen.js';
import { walkBlock } from '../../../dist/qa/walker.js';
import type { ActResult, WalkerDeps } from '../../../dist/qa/walker.js';

const OCCLUDED: ActResult = {
  ok: false,
  proven: false,
  mutation: 'none',
  error: 'FOCUS_TARGET_OCCLUDED: the focus or tap point is covered by another element',
};

const root = (): NativeNode[] => [
  { ref: '@app', index: 0, type: 'Application', rect: { x: 0, y: 0, width: 400, height: 800 } },
  {
    ref: '@win',
    index: 1,
    parentIndex: 0,
    type: 'Window',
    rect: { x: 0, y: 0, width: 400, height: 800 },
  },
];

const covered = (screen: Screen): Screen => ({
  ...screen,
  coverage: { native: 'complete', react: 'complete' },
});

function at(y: number, type = 'Button', extra: NativeNode[] = []): Screen {
  const id = type === 'Button' ? 'go' : 'field';
  return covered(
    join(
      [
        ...root(),
        {
          ref: '@target',
          index: 2,
          parentIndex: 1,
          type,
          identifier: id,
          label: type === 'Button' ? 'Go' : undefined,
          hittable: true,
          rect: { x: 20, y, width: 300, height: 44 },
        },
        ...extra,
      ],
      [],
    ),
  );
}

const done = (): Screen =>
  covered(
    join(
      [
        ...root(),
        {
          ref: '@done',
          index: 2,
          parentIndex: 1,
          type: 'StaticText',
          label: 'Done',
          hittable: true,
          rect: { x: 20, y: 100, width: 300, height: 44 },
        },
      ],
      [],
    ),
  );

function fake(screens: Screen[], results: { press?: ActResult[]; fill?: ActResult[] }) {
  const calls: string[] = [];
  const queue = [...screens];
  const press = [...(results.press ?? [])];
  const fill = [...(results.fill ?? [])];
  let clock = 0;
  const deps: WalkerDeps = {
    async captureScreen() {
      calls.push('capture');
      return queue.length > 1 ? queue.shift()! : queue[0];
    },
    async press(ref) {
      calls.push(`press ${ref}`);
      return press.shift() ?? { ok: true, proven: false };
    },
    async fill(ref) {
      calls.push(`fill ${ref}`);
      return fill.shift() ?? { ok: true, proven: true };
    },
    async scroll(direction) {
      calls.push(`scroll ${direction}`);
      return { ok: true, proven: false };
    },
    async back() {
      return { ok: true, proven: false };
    },
    async dialog() {
      return { ok: true, proven: true };
    },
    async screenshot(name) {
      return name;
    },
    now: () => (clock += 100),
    async sleep(ms) {
      clock += ms;
    },
    row: () => undefined,
  };
  return { deps, calls };
}

function block(markdown: string) {
  const parsed = parsePlan(markdown);
  assert.ok(parsed.blocks, JSON.stringify(parsed.refused));
  return parsed.blocks[0];
}

const targetOf = (screen: Screen, ref: string) => screen.elements.find((e) => e.ref === ref);

test('O1: an occluded press scrolls once toward clearance and presses the same identity', async () => {
  const screens = [at(700), at(400), done()];
  const f = fake(screens, { press: [OCCLUDED] });
  const outcome = await walkBlock(block('1. Tap "go"\n'), f.deps);
  assert.equal(outcome.block.outcome, 'pass');
  assert.deepEqual(f.calls, [
    'capture',
    'press @target',
    'scroll down',
    'capture',
    'press @target',
    'capture',
  ]);
  assert.equal(targetOf(screens[0], '@target')?.testID, 'go');
  assert.equal(targetOf(screens[1], '@target')?.testID, 'go');
});

test('O1: a target in the upper half scrolls up', async () => {
  const f = fake([at(80), at(300), done()], { press: [OCCLUDED] });
  const outcome = await walkBlock(block('1. Tap "go"\n'), f.deps);
  assert.equal(outcome.block.outcome, 'pass');
  assert.ok(f.calls.includes('scroll up'));
});

test('O2: occluded twice fails after one scroll, never as an uncertain outcome', async () => {
  const f = fake([at(700), at(650)], { press: [OCCLUDED, OCCLUDED] });
  const outcome = await walkBlock(block('1. Tap "go"\n'), f.deps);
  assert.equal(outcome.block.outcome, 'fail');
  assert.equal(f.calls.filter((c) => c.startsWith('press')).length, 2);
  assert.equal(f.calls.filter((c) => c.startsWith('scroll')).length, 1);
  assert.match(
    outcome.failure?.seen ?? '',
    /^FOCUS_TARGET_OCCLUDED: .*"go" stayed off screen after one scroll/,
  );
  assert.doesNotMatch(JSON.stringify(outcome), /ACTION_OUTCOME_UNCERTAIN/);
});

test('O3: an occluded exact fill scrolls once, then fills verified', async () => {
  const f = fake([at(700, 'TextField'), at(300, 'TextField'), at(300, 'TextField')], {
    fill: [OCCLUDED],
  });
  const outcome = await walkBlock(block('1. Fill "field" with "x"\n'), f.deps);
  assert.equal(outcome.block.outcome, 'pass');
  assert.deepEqual(f.calls.slice(0, 5), [
    'capture',
    'fill @target',
    'scroll down',
    'capture',
    'fill @target',
  ]);
});

test('O4: a later transparent full-screen container never makes a hittable target scroll', async () => {
  const overlay: NativeNode = {
    ref: '@overlay',
    index: 3,
    parentIndex: 1,
    type: 'Other',
    hittable: true,
    rect: { x: 0, y: 0, width: 400, height: 800 },
  };
  const f = fake([at(700, 'Button', [overlay]), done()], {});
  const outcome = await walkBlock(block('1. Tap "go"\n'), f.deps);
  assert.equal(outcome.block.outcome, 'pass');
  assert.deepEqual(f.calls, ['capture', 'press @target', 'capture']);
});

test('O5: a refusal other than occlusion keeps its existing path', async () => {
  const other: ActResult = { ...OCCLUDED, error: 'STALE_REF: gone' };
  const f = fake([at(700)], { press: [other, other] });
  await walkBlock(block('1. Tap "go"\n'), f.deps);
  assert.equal(f.calls.filter((c) => c.startsWith('scroll')).length, 0);
});
