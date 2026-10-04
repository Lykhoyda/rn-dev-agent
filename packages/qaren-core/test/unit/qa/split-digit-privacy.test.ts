import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MASK,
  ObservedPrivacy,
  matchPrivate,
  projectPlanLine,
  codeBoxRows,
} from '../../../dist/qa/privacy.js';
import { join, describe } from '../../../dist/qa/screen.js';
import { element } from './judgment-fixtures.ts';

for (const code of ['4815', '1122', '9382']) {
  test(`structural code row ${code} ignores wrappers and repeated text`, () => {
    const screen = join(
      [...code].flatMap((label, i) => [
        { ref: `@group${i}`, type: 'Group' },
        {
          ref: `@box${i}`,
          type: 'StaticText',
          label,
          rect: { x: i * 48, y: 100, width: 32, height: 40 },
        },
      ]),
      [],
    );
    const privacy = new ObservedPrivacy();
    privacy.observe(screen);
    assert.deepEqual(privacy.screenText(screen), [...code]);
    privacy.didFill();
    privacy.observe(screen);
    assert.equal(codeBoxRows(screen).length, 1);
    assert.deepEqual(privacy.screenText(screen), ['[code]']);
    const mask = privacy.maskForModel([], []);
    for (const box of screen.elements.filter((element) => element.kind === 'text'))
      assert.equal(mask.describeElement(box, describe), 'box (hidden)');
    assert.equal(privacy.redact('1 | 2 | 3 | 4'), '1 | 2 | 3 | 4');
    assert.deepEqual(privacy.privateSet().values, []);
  });
}

test('keypads, counters and separated text stay readable after filling', () => {
  for (const type of ['Button', 'Cell', 'TextField']) {
    const screen = join(
      ['1', '2', '3', '4'].map((label, i) => ({
        ref: `@${i}`,
        type,
        label,
        rect: { x: i * 48, y: 100, width: 32, height: 40 },
      })),
      [],
    );
    assert.deepEqual(codeBoxRows(screen), []);
  }
});

test('shared policies combine trimming, normalization and digit separators', () => {
  const privacy = new ObservedPrivacy([' Café ', '1234567890', 'CanaryAlpha77']);
  for (const value of ['Cafe\u0301', ' Café ', '1234/5678/90', '1234-5678-90', 'CanaryAlpha77']) {
    assert.equal(privacy.redact(value), MASK);
    assert.equal(matchPrivate(value, privacy.privateSet(), 'persisted').hit, true);
    assert.equal(
      privacy.maskForModel(privacy.modelValues(), []).apply(value).includes(value),
      false,
    );
  }
  const target = element('@account', 'Account', { testID: 'account-1234-5678-90' });
  assert.equal(
    privacy.maskForModel([], []).describeElement(target, describe).includes('1234'),
    false,
  );
  assert.equal(target.testID, 'account-1234-5678-90');
});

test('short typed values only mask quoted slots and input values', () => {
  const privacy = new ObservedPrivacy(['1', '47']);
  assert.equal(
    projectPlanLine('1. Type "1" into "address1"', privacy.privateSet()).text,
    '1. Type "•••" into "address1"',
  );
  assert.equal(projectPlanLine('Type "47"', privacy.privateSet(), 'persisted').hit, true);
  assert.equal(privacy.redact('step 1 of 47'), 'step 1 of 47');
  const input = element('@input', 'Age', { kind: 'input', value: '47' });
  const screen = { front: 'app' as const, elements: [input], visibleText: ['Age: 47'] };
  privacy.observe(screen);
  assert.deepEqual(privacy.screenText(screen), ['Age: •••']);
  assert.equal(privacy.maskForModel([], []).describeElement(input, describe).includes('47'), false);
});

test('secure length one is a whole token and secure length two masks substrings', () => {
  const set = {
    values: [
      { text: '7', provenance: 'secret' as const },
      { text: 'pw', provenance: 'secret' as const },
    ],
  };
  assert.equal(matchPrivate('x7x 7 apwb', set, 'durable').text, `x7x ${MASK} a${MASK}b`);
});

test('a protected mask still reports a persisted hit', () => {
  assert.deepEqual(
    matchPrivate(MASK, { values: [{ text: MASK, provenance: 'typed' }] }, 'persisted'),
    { text: MASK, hit: true },
  );
});
