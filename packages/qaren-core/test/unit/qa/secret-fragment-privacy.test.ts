import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MASK, ObservedPrivacy, matchPrivate } from '../../../dist/qa/privacy.js';
import { join, describe, type NativeNode } from '../../../dist/qa/screen.js';
import { element, screen, scriptedJudge, walker } from './judgment-fixtures.ts';
import { parsePlan } from '../../../dist/qa/plan.js';
import { runPlan } from '../../../dist/qa/walker.js';

for (const [kind, entered, caret] of [
  ['Button', '5', false],
  ['Other', '50', true],
  ['Other', '50', false],
  ['Button', '5038', false],
] as const) {
  test(`${kind} cells containing ${entered}, caret=${caret}, mask every outward projection`, async () => {
    const nodes: NativeNode[] = [
      { ref: '@row', index: 0, type: 'Other', rect: { x: 0, y: 300, width: 402, height: 60 } },
    ];
    for (let i = 0; i < 4; i++) {
      const cell = nodes.length;
      const x = i * (44 + (402 - 176) / 3);
      nodes.push({
        ref: `@cell${i}`,
        index: cell,
        parentIndex: 0,
        type: kind,
        label: entered[i],
        identifier: 'otp-input',
        hittable: true,
        rect: { x, y: 300, width: 44, height: 60 },
      });
      if (entered[i] && kind === 'Other')
        nodes.push({
          ref: `@glyph${i}`,
          index: nodes.length,
          parentIndex: cell,
          type: 'StaticText',
          label: entered[i],
          rect: { x: x + 13, y: 313, width: 17, height: 34 },
        });
      if (caret && i === 1)
        nodes.push({
          ref: '@caret',
          index: nodes.length,
          parentIndex: cell,
          type: 'Other',
          rect: { x: x + 31, y: 313, width: 2, height: 34 },
        });
    }
    const captured = join(nodes, []);
    const privacy = new ObservedPrivacy(['5038']);
    privacy.didFill('5038');
    privacy.observe(captured);
    for (const char of entered) {
      assert.equal(privacy.screenText(captured).join(' | ').includes(char), false);
      const mask = privacy.maskForModel([], []);
      for (const node of captured.elements)
        assert.equal(mask.describeElement(node, describe).includes(char), false);
      for (const policy of ['model', 'durable', 'identifier', 'persisted'] as const)
        assert.equal(
          matchPrivate(`observed ${char}`, privacy.privateSet(), policy).text.includes(char),
          false,
        );
    }
    assert.equal(privacy.canScreenshot(), false);
    const f = walker(
      [screen([element('@pin', 'Code', { kind: 'input', testID: 'pin' })]), captured],
      scriptedJudge(() => assert.fail('literal fill is model-free')),
      { ok: false, proven: false, mutation: 'observed', error: 'fill interrupted' },
    );
    const blocks = parsePlan('1. Type "5038" into "pin"\n✓ "Ready"').blocks!;
    const ledger = await runPlan(blocks, f.deps);
    assert.equal(ledger.verdict, 'FAIL');
    for (const char of entered) assert.equal(ledger.failure!.seen.includes(char), false);
    assert.equal(ledger.failure!.screenshot, undefined);
  });
}

test('fragment protection starts at fill dispatch and persists across navigation', () => {
  const privacy = new ObservedPrivacy(['5038']);
  assert.equal(privacy.redact('5 | 0'), '5 | 0');
  privacy.didFill('5038');
  const later = screen([element('@digit', '5', { kind: 'text' })]);
  privacy.observe(later);
  assert.deepEqual(privacy.screenText(later), [MASK]);
  assert.equal(privacy.redact('5 | 0'), `${MASK} | ${MASK}`);
  assert.equal(privacy.redactIdentifier('row-5'), `row-${MASK}`);
  assert.equal(privacy.maskForModel([], []).apply('5  0'), `${MASK}  ${MASK}`);
});

test('non-secret fills leave partial text and unrelated digits readable', () => {
  const privacy = new ObservedPrivacy(['Alice', '47']);
  privacy.didFill('Alice');
  privacy.didFill('47');
  const captured = screen([element('@digit', '5', { kind: 'text' })]);
  privacy.observe(captured);
  assert.deepEqual(privacy.screenText(captured), ['5']);
  assert.equal(privacy.redact('Al 4 7'), 'Al 4 7');
  assert.equal(privacy.canScreenshot(), true);
});

test('secure fills mask letter fragments without assigning complete-value identity', () => {
  const privacy = new ObservedPrivacy(['p@ss']);
  privacy.concealFallback('p@ss', true);
  assert.equal(privacy.redact('p'), 'p');
  privacy.didFill('p@ss');
  const captured = screen([element('@echo', 'p @ s', { kind: 'text' })]);
  privacy.observe(captured);
  assert.deepEqual(privacy.screenText(captured), [`${MASK} ${MASK} ${MASK}`]);
  const mask = privacy.maskForModel(['p@ss'], []);
  assert.equal(mask.apply('p'), MASK);
  assert.equal(mask.apply('p@ss'), mask.tokens[0]);
  assert.equal(mask.apply(mask.tokens[0]), mask.tokens[0]);
  assert.equal(mask.applyPlanLine('1. Tap "p"'), `1. Tap "${MASK}"`);
  assert.equal(mask.apply('ps'), MASK);
  assert.equal(privacy.canScreenshot(), false);
});

test('dispatching one code does not enable fragment matching for future codes', () => {
  const privacy = new ObservedPrivacy(['5038', '7291']);
  privacy.didFill('5038');
  assert.equal(privacy.redact('7 | 2'), '7 | 2');
  assert.equal(privacy.redact('5 | 0'), `${MASK} | ${MASK}`);
});
