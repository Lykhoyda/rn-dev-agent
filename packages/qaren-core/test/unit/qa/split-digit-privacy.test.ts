import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MASK,
  ObservedPrivacy,
  capturePrivateScreen,
  redactEvidence,
} from '../../../dist/qa/privacy.js';
import { decideScreen } from '../../../dist/qa/resolve.js';
import { element, screen, scriptedJudge } from './judgment-fixtures.ts';

test('short codes mask single characters while isolated short substrings stay readable', () => {
  const privacy = new ObservedPrivacy();
  privacy.concealFallback('1234');
  const masked = privacy.redact(
    'on screen: Enter the code | 1 | 2 | 3 | 4 | 12 | 34 | Verify | 56 | 9',
  );
  assert.equal(
    masked,
    `on screen: Enter the code | ${MASK} | ${MASK} | ${MASK} | ${MASK} | 12 | 34 | Verify | 56 | 9`,
  );
  assert.match(masked, /Enter the code/);
  assert.match(masked, /Verify/);
  assert.match(masked, /\| 56 \|/);
  assert.match(masked, /\| 9$/);
  assert.ok(masked.includes(MASK));
});

test('substring masking applies only to protected values, not ordinary typed text', () => {
  const privacy = new ObservedPrivacy(['Ada']);
  assert.equal(
    privacy.redact('on screen: a | d | Ada Lovelace'),
    'on screen: a | d | ••• Lovelace',
  );
});

test('a protected fragment with trailing punctuation is still masked; identifiers stay whole', () => {
  const privacy = new ObservedPrivacy();
  privacy.concealFallback('1234');
  privacy.concealFallback('qa@example.test');
  assert.equal(
    privacy.redact('last box 4. near qa-hidden-email'),
    'last box ••• near qa-hidden-email',
  );
});

for (const origin of ['fallback', 'private observation'] as const) {
  test(`${origin} masks digit boxes in outbound phrase checks`, async () => {
    const observed = screen([
      element('@heading', 'Enter the code', { kind: 'text' }),
      ...['1', '2', '3', '4'].map((digit) => element(`@digit${digit}`, digit, { kind: 'text' })),
      element('@verify', 'Verify'),
    ]);
    const privacy = new ObservedPrivacy();
    if (origin === 'fallback') privacy.concealFallback('1234');
    else
      capturePrivateScreen(observed, [
        { values: ['1234'], secure: true, elements: [], associationUnique: false },
      ]);
    const judge = scriptedJudge(() => ({ check_0: { type: 'noul', noul: 0.99 } }));
    const result = await decideScreen(
      observed,
      judge,
      { kind: 'check', text: 'Enter the code is visible', literal: false, line: 0 },
      undefined,
      [],
      privacy,
    );
    assert.equal(result.check, 'pass');
    assert.equal(judge.requests.length, 1);
    const request = JSON.stringify(judge.requests[0]);
    assert.equal(/[1-4]/.test(request), false, request);
    assert.ok(request.includes('Enter the code'));
    assert.ok(request.includes('Verify'));
    assert.ok(request.includes(MASK));
    assert.equal(observed.elements[1].label, '1');
  });
}

test('fragment masks never establish protected value or fragment presence', async () => {
  const observed = screen(
    ['1', '2', '3', '4'].map((digit) => element(`@digit${digit}`, digit, { kind: 'text' })),
  );
  const privacy = new ObservedPrivacy(['1234']);
  privacy.concealFallback('1234');
  for (const phrase of ['1234 is visible', '1 is visible']) {
    const judge = scriptedJudge(() =>
      assert.fail('concealed fragments cannot be judged as evidence'),
    );
    const result = await decideScreen(
      observed,
      judge,
      { kind: 'check', text: phrase, literal: false, line: 0 },
      undefined,
      ['1234'],
      privacy,
    );
    assert.equal(result.check, 'unsure');
    for (const kind of ['wait', 'scroll'] as const) {
      const visibility = await decideScreen(
        observed,
        judge,
        undefined,
        kind === 'scroll'
          ? { kind, until: { phrase }, direction: 'down', line: 0 }
          : { kind, target: { phrase }, line: 0 },
        ['1234'],
        privacy,
      );
      assert.deepEqual(visibility.visibility, { verdict: 'unsure' });
    }
  }
});

test('outbound masking preserves whole-value equality and ordinary typed fragment policy', () => {
  const privacy = new ObservedPrivacy(['Ada']);
  privacy.concealFallback('1234');
  const mask = privacy.maskForModel(['Ada', '1234'], []);
  assert.equal(mask.apply('a | d'), 'a | d');
  assert.equal(mask.apply('1234'), mask.tokens[1]);
  privacy.concealFallback('qa@example.test');
  assert.equal(
    privacy
      .maskForModel(['Ada', '1234'], [])
      .apply('4. | qa-hidden-email | qa-hidden_email | qa.hidden | qa@example.test-extra'),
    `${MASK} | qa-hidden-email | qa-hidden_email | qa.hidden | ${MASK}`,
  );
});

test('long secrets preserve isolated short substrings and mask long fragments at every boundary', () => {
  const privacy = new ObservedPrivacy();
  privacy.concealFallback('existing-secret');
  const text =
    'The name field is filled | e | exi | existing | secr | prefix-existing-secret-suffix';
  const expected = `The name field is filled | e | exi | ${MASK} | ${MASK} | ${MASK}`;
  assert.equal(privacy.redact(text), expected);
  assert.equal(privacy.maskForModel([], [text]).apply(text), expected);
});

test('adjacent character boxes from long secrets are masked in reports and model projections', () => {
  const privacy = new ObservedPrivacy();
  privacy.concealFallback('existing-secret');
  assert.equal(
    privacy.redact('Boxes: e | x | i | s | q'),
    `Boxes: ${MASK} | ${MASK} | ${MASK} | ${MASK} | q`,
  );
  const mask = privacy.maskForModel([], ['Code', 'e', 'x', 'i', 's', 'Verify']);
  for (const char of ['e', 'x', 'i', 's'])
    assert.equal(mask.apply(`Text "${char}"`), `Text "${MASK}"`);
  assert.equal(mask.apply('Text "is"'), 'Text "is"');
  assert.equal(mask.apply('Text "q"'), 'Text "q"');
  assert.equal(new ObservedPrivacy().maskForModel([], []).apply('e | x'), 'e | x');
});

test('protected values inside identifiers are fully masked while exact values retain opaque identity', () => {
  const privacy = new ObservedPrivacy();
  for (const value of ['1', 'existing-secret']) privacy.concealFallback(value);
  const mask = privacy.maskForModel(['1', 'existing-secret'], []);
  assert.equal(mask.apply('1'), mask.tokens[0]);
  assert.equal(mask.apply('existing-secret'), mask.tokens[1]);
  assert.equal(mask.apply('field1 | prefix-existing-secret-suffix'), `${MASK} | ${MASK}`);
  assert.equal(privacy.redact('field1 | prefix-existing-secret-suffix'), `${MASK} | ${MASK}`);
});

test('individual output fields retain the adjacent-box context of the observed screen', () => {
  const observed = screen(
    ['e', 'x', 'i', 's'].map((label) => element(`@${label}`, label, { kind: 'text' })),
  );
  capturePrivateScreen(observed, [
    { values: ['existing-secret'], secure: true, elements: [], associationUnique: false },
  ]);
  const privacy = new ObservedPrivacy();
  privacy.observe(observed);
  for (const label of observed.visibleText) {
    assert.equal(privacy.redact(label), MASK);
    assert.equal(redactEvidence(observed, label), MASK);
    assert.equal(privacy.maskForModel([], []).apply(label), MASK);
  }
  assert.equal(privacy.redact('The name field is filled'), 'The name field is filled');
});

test('outbound masking keeps testIDs readable unless they contain a whole long protected value', () => {
  const privacy = new ObservedPrivacy();
  privacy.concealFallback('1');
  privacy.concealFallback('existing-secret');
  const mask = privacy.maskForModel(['1', 'existing-secret'], []);
  const sent = mask.apply(
    'textbox "Echo: 1" [testID address1] | "A1B" | [testID existing-secret-field] | existing-secret-value',
  );
  assert.ok(sent.includes('[testID address1]'), sent);
  assert.equal(sent.includes('existing-secret-field'), false, sent);
  assert.equal(sent.includes('Echo: 1'), false, sent);
  assert.equal(sent.includes('A1B'), false, sent);
  assert.equal(sent.includes('existing-secret-value'), false, sent);
});
