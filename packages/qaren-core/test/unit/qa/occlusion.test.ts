import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join, type NativeNode } from '../../../dist/qa/screen.js';
import { nativeDispatchPoints } from '../../../dist/qa/native-presence.js';
import { prepareTarget, targetVisible } from '../../../dist/qa/resolve.js';
import { parsePlan } from '../../../dist/qa/plan.js';
import { runPlan } from '../../../dist/qa/walker.js';
import { walker, scriptedJudge } from './judgment-fixtures.ts';
import {
  updateRefMapFromFlat,
  clearRefMap,
  refDispatchPoint,
} from '../../../dist/fast-runner-ref-map.js';
import { buildRunIOSArgs, buildRunAndroidArgs } from '../../../dist/agent-device-wrapper.js';

const rect = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });

function scene(y = 790, type = 'Button', coverType = 'Button'): NativeNode[] {
  const nodes: NativeNode[] = [
    { ref: '@e0', type: 'Application', rect: rect(0, 0, 402, 874) },
    { ref: '@e1', type: 'Window', parentIndex: 0, rect: rect(0, 0, 402, 874) },
    { ref: '@e2', type: 'ScrollView', parentIndex: 1, rect: rect(0, 100, 402, 774) },
    {
      ref: '@e3',
      type,
      parentIndex: 2,
      identifier: 'target',
      label: 'Open Pager QA',
      hittable: true,
      rect: rect(20, y, 350, 38),
    },
    {
      ref: '@e4',
      type: coverType,
      parentIndex: coverType === 'Window' ? 0 : 1,
      identifier: 'tab-tasks',
      hittable: coverType === 'Button',
      rect: rect(0, 789, 402, 60),
    },
  ];
  if (coverType === 'Window')
    nodes.push({ ref: '@overlay', type: 'Alert', parentIndex: 4, rect: nodes[4].rect });
  return nodes;
}

for (const type of ['Other', 'Group', 'ScrollView']) {
  test(`an unidentified transparent ${type} never blocks a button`, () => {
    const nodes = scene(700);
    nodes[4] = {
      ref: '@transparent',
      type,
      parentIndex: 1,
      enabled: true,
      hittable: true,
      rect: rect(0, 0, 402, 874),
    };
    assert.equal(targetVisible(target, screen(nodes)), true);
    assert.deepEqual(nativeDispatchPoints(nodes).get(3), { x: 195, y: 719 });
    updateRefMapFromFlat(nodes as never);
    try {
      assert.deepEqual(refDispatchPoint('@e3'), { x: 195, y: 719 });
    } finally {
      clearRefMap();
    }
    nodes[4].identifier = 'blocking-control';
    assert.equal(nativeDispatchPoints(nodes).get(3), null);
  });
}

for (const overlay of ['Keyboard', 'Alert']) {
  test(`${overlay} windows select the same uncovered point in either emission order`, () => {
    const app: NativeNode = { ref: '@app', type: 'Application', rect: rect(0, 0, 402, 874) };
    const main: NativeNode = { ref: '@main', type: 'Window', parentIndex: 0, rect: app.rect };
    const input: NativeNode = {
      ref: '@input',
      type: 'TextField',
      parentIndex: 1,
      identifier: 'input',
      rect: rect(20, 700, 350, 40),
    };
    const front: NativeNode = {
      ref: '@front',
      type: 'Window',
      parentIndex: 0,
      rect: overlay === 'Keyboard' ? app.rect : rect(0, 720, 402, 154),
    };
    const content: NativeNode = {
      ref: '@overlay',
      type: overlay,
      parentIndex: 3,
      rect: rect(0, 720, 402, 154),
    };
    const raw = [app, main, input, front, content];
    const fast = [app, front, { ...content, parentIndex: 1 }, main, { ...input, parentIndex: 3 }];
    for (const nodes of [raw, fast]) {
      const index = nodes.findIndex((node) => node.ref === '@input');
      assert.deepEqual(nativeDispatchPoints(nodes).get(index), { x: 195, y: 710 });
      assert.equal(
        screen(nodes).elements.find((element) => element.ref === '@input')!.offscreen,
        false,
      );
      updateRefMapFromFlat(nodes as never);
      try {
        assert.deepEqual(refDispatchPoint('@input'), { x: 195, y: 710 });
      } finally {
        clearRefMap();
      }
    }
  });
}

const screen = (nodes: NativeNode[]) =>
  join(nodes, [], 'app', { native: 'complete', react: 'complete' });
const target = { phrase: 'target', quoted: 'target' };
const judge = () =>
  scriptedJudge((questions) =>
    Object.fromEntries(Object.keys(questions).map((id) => [id, { type: 'noul', noul: 0.99 }])),
  );

test('a fully covered button is absent for waits and scroll-until and never pressed', async () => {
  const blocked = screen(scene());
  const clear = screen(scene(700));
  for (const name of [
    target,
    { phrase: 'Open Pager QA', quoted: 'Open Pager QA' },
    { ...target, exact: 'id' as const },
    { phrase: 'Open Pager QA', quoted: 'Open Pager QA', exact: 'text' as const },
  ])
    assert.equal(targetVisible(name, blocked), false);
  assert.deepEqual(prepareTarget({ kind: 'press', target }, blocked), { scroll: 'down' });
  const scrolling = walker([blocked, clear], judge());
  assert.equal(
    (await runPlan(parsePlan('1. Scroll down until "Open Pager QA"').blocks!, scrolling.deps))
      .verdict,
    'PASS',
  );
  assert.deepEqual(scrolling.actions, ['scroll down']);
  const tapping = walker([blocked], judge());
  const refused = await runPlan(parsePlan('1. Tap "target"').blocks!, tapping.deps);
  assert.equal(refused.verdict, 'FAIL');
  assert.ok(tapping.actions.every((action) => action === 'scroll down'));
  assert.match(refused.failure?.seen ?? '', /TARGET_NOT_FOUND.*occluded/);
  const uncovered = walker([blocked, clear], judge());
  assert.equal(
    (await runPlan(parsePlan('1. Tap "target"').blocks!, uncovered.deps)).verdict,
    'PASS',
  );
  assert.deepEqual(uncovered.actions, ['scroll down', 'press @e3']);
});

for (const [cover, axis, minimum, maximum] of [
  [rect(0, 110, 402, 50), 'y', 100, 110],
  [rect(0, 90, 402, 30), 'y', 120, 138],
  [rect(180, 0, 222, 874), 'x', 20, 180],
  [rect(0, 0, 210, 874), 'x', 210, 370],
] as const) {
  test(`a partly covered button dispatches at an uncovered ${axis} point ${minimum}-${maximum}`, () => {
    const nodes = scene(100);
    nodes[4].rect = cover;
    const observed = screen(nodes);
    assert.equal(targetVisible(target, observed), true);
    const point = nativeDispatchPoints(nodes).get(3);
    assert.ok(point);
    assert.ok(point[axis] > minimum && point[axis] < maximum, JSON.stringify(point));
    updateRefMapFromFlat(nodes as never, { snapshotGeneration: 1, keyboardVisible: false });
    try {
      assert.deepEqual(refDispatchPoint('@e3'), point);
      for (const dispatch of [
        buildRunIOSArgs(['press', '@e3']),
        buildRunAndroidArgs(['press', '@e3']),
      ]) {
        assert.equal(dispatch.x, point.x);
        assert.equal(dispatch.y, point.y);
      }
    } finally {
      clearRefMap();
    }
  });
}

for (const front of ['Keyboard', 'Window']) {
  test(`a TextField covered by a front ${front} scrolls clear or refuses before fill`, async () => {
    const blocked = screen(scene(790, 'TextField', front));
    assert.deepEqual(prepareTarget({ kind: 'fill', target, text: 'value' }, blocked), {
      scroll: 'down',
    });
    const f = walker([blocked], judge());
    const result = await runPlan(parsePlan('1. Fill "target" with "value"').blocks!, f.deps);
    assert.equal(result.verdict, 'FAIL');
    assert.ok(f.actions.every((action) => action === 'scroll down'));
    assert.match(result.failure?.seen ?? '', /TARGET_NOT_FOUND.*occluded/);
    const clear = walker([blocked, screen(scene(700, 'TextField', front))], judge());
    assert.equal(
      (await runPlan(parsePlan('1. Fill "target" with "value"').blocks!, clear.deps)).verdict,
      'PASS',
    );
    assert.deepEqual(clear.actions, ['scroll down', 'fill @e3 value']);
  });
}

test('native ancestors, descendants, and earlier controls do not occlude a target', () => {
  const nodes = scene(700);
  nodes[4] = { ...nodes[4], type: 'StaticText', parentIndex: 3, rect: nodes[3].rect };
  assert.deepEqual(nativeDispatchPoints(nodes).get(3), { x: 195, y: 719 });
  const earlier = { ...nodes[4], parentIndex: 1, type: 'Button' };
  nodes.splice(3, 0, earlier);
  nodes[5].parentIndex = 4;
  assert.deepEqual(nativeDispatchPoints(nodes).get(4), { x: 195, y: 719 });
});

test('multiple front elements cannot leave a covered dispatch point between them', () => {
  const nodes = scene(100);
  nodes[4].rect = rect(20, 100, 175, 38);
  nodes.push({ ...nodes[4], ref: '@e5', rect: rect(195, 100, 175, 38) });
  assert.equal(nativeDispatchPoints(nodes).get(3), null);
  assert.equal(targetVisible(target, screen(nodes)), false);
});
