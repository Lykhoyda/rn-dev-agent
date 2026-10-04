// A pressable whose label only echoes its single text child is one control; distinct same-label controls stay ambiguous.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from '../../../dist/qa/screen.js';
import type { NativeNode } from '../../../dist/qa/screen.js';
import { prepareTarget } from '../../../dist/qa/resolve.js';

const app = (): NativeNode[] => [
  { ref: '@app', index: 0, type: 'Application', rect: { x: 0, y: 0, width: 402, height: 874 } },
  {
    ref: '@win',
    index: 1,
    parentIndex: 0,
    type: 'Window',
    rect: { x: 0, y: 0, width: 402, height: 874 },
  },
];

function pressable(
  nodes: NativeNode[],
  options: { id?: string; y: number; texts: string[] },
): NativeNode[] {
  const parent = nodes.length;
  const out = [
    ...nodes,
    {
      ref: `@p${parent}`,
      index: parent,
      parentIndex: 1,
      type: 'Other',
      label: 'Skip',
      hittable: true,
      rect: { x: 20.4, y: options.y, width: 350.2, height: 48 },
      ...(options.id ? { identifier: options.id } : {}),
    },
  ];
  options.texts.forEach((label, i) =>
    out.push({
      ref: `@t${parent}-${i}`,
      index: out.length,
      parentIndex: parent,
      type: 'StaticText',
      label,
      hittable: true,
      rect: { x: 150, y: options.y + 12, width: 60, height: 24 },
    }),
  );
  return out;
}

const press = { kind: 'press' as const, target: { phrase: 'Skip', quoted: 'Skip' } };

test('a pressable echoing its single text child resolves to the pressable', () => {
  const nodes = pressable(app(), { id: 'consent-skip', y: 700, texts: ['Skip'] });
  const resolved = prepareTarget(press, join(nodes, []));
  assert.ok('ref' in resolved, JSON.stringify(resolved));
  assert.equal(resolved.ref, '@p2');
});

test('the echo collapses without a testID too, and its text stays visible', () => {
  const screen = join(pressable(app(), { y: 700, texts: ['Skip'] }), []);
  const resolved = prepareTarget(press, screen);
  assert.ok('ref' in resolved && resolved.ref === '@p2', JSON.stringify(resolved));
  assert.ok(screen.visibleText.includes('Skip'));
});

for (const hittable of [true, false]) {
  test(`nested controls remain distinct with outer hittable=${hittable}`, () => {
    const nodes = pressable(app(), { y: 700, texts: [] });
    nodes[2].hittable = hittable;
    nodes.push(
      {
        ref: '@button',
        index: 3,
        parentIndex: 2,
        type: 'Button',
        label: 'Skip',
        hittable: true,
        rect: { x: 30, y: 705, width: 320, height: 40 },
      },
      {
        ref: '@text',
        index: 4,
        parentIndex: 3,
        type: 'StaticText',
        label: 'Skip',
        hittable: true,
        rect: { x: 150, y: 712, width: 60, height: 24 },
      },
    );
    const resolved = prepareTarget(press, join(nodes, []));
    assert.ok(
      'refuse' in resolved && resolved.refuse === 'TARGET_AMBIGUOUS',
      JSON.stringify(resolved),
    );

    const wrapped = nodes.map((node, i) => ({
      ...node,
      index: i >= 2 ? i + 1 : i,
      parentIndex:
        node.parentIndex !== undefined && node.parentIndex >= 2
          ? node.parentIndex + 1
          : node.parentIndex,
    }));
    wrapped.splice(2, 0, {
      ref: '@outer',
      index: 2,
      parentIndex: 1,
      type: 'Other',
      label: 'Skip',
      hittable: true,
      rect: { x: 10, y: 695, width: 380, height: 60 },
    });
    wrapped[3].parentIndex = 2;
    const multiplyWrapped = prepareTarget(press, join(wrapped, []));
    assert.ok(
      'refuse' in multiplyWrapped && multiplyWrapped.refuse === 'TARGET_AMBIGUOUS',
      JSON.stringify(multiplyWrapped),
    );
  });
}

test('a Skip pressable and a separate inline Skip link stay ambiguous', () => {
  const nodes = pressable(app(), { id: 'consent-skip', y: 700, texts: ['Skip'] });
  nodes.push({
    ref: '@link',
    index: nodes.length,
    parentIndex: 1,
    type: 'Link',
    label: 'Skip',
    hittable: true,
    rect: { x: 150, y: 780, width: 60, height: 24 },
  });
  const resolved = prepareTarget(press, join(nodes, []));
  assert.ok(
    'refuse' in resolved && resolved.refuse === 'TARGET_AMBIGUOUS',
    JSON.stringify(resolved),
  );
  const listed = resolved.reason.slice(resolved.reason.indexOf('candidates: '));
  assert.equal(
    listed,
    'candidates: other id=consent-skip frame=20,700,350,48; link no-id frame=150,780,60,24',
  );
});

test('two distinct Skip controls stay ambiguous and list value-free candidates', () => {
  const nodes = pressable(pressable(app(), { id: 'consent-skip', y: 700, texts: ['Skip'] }), {
    y: 780,
    texts: ['Skip'],
  });
  const resolved = prepareTarget(press, join(nodes, []));
  assert.ok(
    'refuse' in resolved && resolved.refuse === 'TARGET_AMBIGUOUS',
    JSON.stringify(resolved),
  );
  const listed = resolved.reason.slice(resolved.reason.indexOf('candidates'));
  assert.match(listed, /other id=consent-skip frame=20,700,350,48/);
  assert.match(listed, /other no-id frame=20,780,350,48/);
  assert.equal(listed.includes('Skip'), false, listed);
});

test('a pressable with more than one text descendant is not an echo', () => {
  const nodes = pressable(app(), { id: 'consent-skip', y: 700, texts: ['Skip', 'for now'] });
  const resolved = prepareTarget(press, join(nodes, []));
  assert.ok(
    'refuse' in resolved && resolved.refuse === 'TARGET_AMBIGUOUS',
    JSON.stringify(resolved),
  );
  assert.match(resolved.reason, /text no-id frame=150,712,60,24/);
});
