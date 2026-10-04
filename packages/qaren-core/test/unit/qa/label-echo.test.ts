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
