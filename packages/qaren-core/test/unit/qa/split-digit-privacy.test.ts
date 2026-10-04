import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MASK,
  ObservedPrivacy,
  capturePrivateScreen,
  redactEvidence,
} from '../../../dist/qa/privacy.js';
import { describe } from '../../../dist/qa/screen.js';
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

test('a lone single character is not masked by itself; adjacent boxes still are', () => {
  const privacy = new ObservedPrivacy();
  privacy.concealFallback('1234');
  assert.equal(privacy.redact('3. Tap "qa-otp-verify"'), '3. Tap "qa-otp-verify"');
  assert.equal(privacy.redact('step 4 of 5'), 'step 4 of 5');
  assert.equal(
    privacy.redact('on screen: Enter the code | 1 | 2 | 3 | 4 | Verify'),
    `on screen: Enter the code | ${MASK} | ${MASK} | ${MASK} | ${MASK} | Verify`,
  );
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
    privacy.redact('last boxes 3 4. near qa-hidden-email'),
    'last boxes ••• ••• near qa-hidden-email',
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
      .apply('3 4. | qa-hidden-email | qa-hidden_email | qa.hidden | qa@example.test-extra'),
    `${MASK} ${MASK} | qa-hidden-email | qa-hidden_email | qa.hidden | ${MASK}`,
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
  const boxes = ['e', 'x', 'i', 's'].map((char) => element(`@${char}`, char, { kind: 'text' }));
  const observed = screen([
    element('@code', 'Code', { kind: 'text' }),
    ...boxes,
    element('@q', 'q', { kind: 'text' }),
  ]);
  privacy.observe(observed);
  const mask = privacy.maskForModel([], observed.visibleText);
  for (const box of boxes) {
    assert.equal(mask.describeElement(box, describe), describe({ ...box, label: MASK }));
    assert.equal(mask.apply(box.label!), MASK);
  }
  // A box character elsewhere is free text, not the box.
  assert.equal(mask.apply('Text "e"'), 'Text "e"');
  assert.equal(privacy.redact('step 1 of 2: s'), 'step 1 of 2: s');
  assert.equal(mask.apply('Text "is"'), 'Text "is"');
  assert.equal(
    mask.describeElement(observed.elements[5], describe),
    describe(observed.elements[5]),
  );
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
  const sent = [
    mask.describeElement(element('@input', 'Echo: 1', { testID: 'address1' }), describe),
    mask.describeElement(element('@secret', 'A1B', { testID: 'existing-secret-field' }), describe),
    mask.apply('existing-secret-value'),
  ].join(' | ');
  assert.ok(sent.includes('[testID address1]'), sent);
  assert.equal(sent.includes('existing-secret-field'), false, sent);
  assert.equal(sent.includes('Echo: 1'), false, sent);
  assert.equal(sent.includes('A1B'), false, sent);
  assert.equal(sent.includes('existing-secret-value'), false, sent);
});

for (const [secret, text] of [
  ['1234', '[testID 1234]'],
  ['1234', '[testID 1 2] | [testID 3 4]'],
  ['42', 'Echo: [testID 42]'],
  ['existing-secret', '[testID secr]'],
]) {
  test(`marker-looking free text is masked for ${secret}`, async () => {
    const privacy = new ObservedPrivacy();
    privacy.concealFallback(secret);
    const mask = privacy.maskForModel([], [text]);
    const expected = text.replace(/1234|42|[1-4]|secr/g, MASK);
    assert.equal(mask.apply(text), expected);
    assert.equal(
      mask.describeElement(element('@copy', text, { testID: 'copy' }), describe),
      describe(element('@copy', expected, { testID: 'copy' })),
    );
    const judge = scriptedJudge(() => ({ check_0: { type: 'noul', noul: 0.99 } }));
    await decideScreen(
      screen([element('@copy', text, { kind: 'text' })], [text]),
      judge,
      { kind: 'check', text: 'The confirmation is visible', literal: false, line: 0 },
      undefined,
      [],
      privacy,
    );
    assert.equal(judge.requests.length, 1);
    const request = JSON.stringify(judge.requests[0]);
    assert.equal(request.includes(text), false, request);
    assert.ok(request.includes(MASK), request);
  });
}

test('structured identifier masking fails closed on placeholder collisions or omission', () => {
  const privacy = new ObservedPrivacy();
  privacy.concealFallback('1');
  const mask = privacy.maskForModel([], []);
  for (const label of ['Echo: 1 \uE000', 'Echo: 1']) {
    const input = element('@input', label, { testID: 'address1' });
    const render = label.includes('\uE000')
      ? describe
      : (e: Parameters<typeof describe>[0]) => e.label!;
    assert.equal(mask.describeElement(input, render), mask.apply(render(input)));
  }
});

test('box context is retained across observations and only ever masks the box line', () => {
  const boxes = screen([
    element('@title', 'Enter the code', { kind: 'text' }),
    ...['4', '8', '1', '5'].map((digit) => element(`@d${digit}`, digit, { kind: 'text' })),
  ]);
  capturePrivateScreen(boxes, [
    { values: ['4815'], secure: true, elements: [], associationUnique: false },
  ]);
  const privacy = new ObservedPrivacy();
  privacy.observe(boxes);
  privacy.observe(screen([element('@done', 'Step 1 of 2', { kind: 'text' })]));
  assert.equal(
    privacy.redact('previously on screen: 4 | 8 | 1 | 5'),
    `previously on screen: ${MASK} | ${MASK} | ${MASK} | ${MASK}`,
  );
  assert.equal(privacy.redact('8'), MASK);
  assert.equal(privacy.redact('Step 1 of 2'), 'Step 1 of 2');
  assert.equal(privacy.redact('line 4: tap 1'), 'line 4: tap 1');
  const set = privacy.privateSet();
  assert.equal(
    set.contexts?.some((context) => context.boxes.join('') === '4815'),
    true,
  );
  assert.ok(
    set.contexts?.some((context) => context.key === '@d4,@d8,@d1,@d5'),
    "context keys are the boxes' structural refs",
  );
});

test('derived forms of a protected value are masked: grouped digits and Unicode normalization', () => {
  const privacy = new ObservedPrivacy();
  privacy.concealFallback('1234567890');
  privacy.concealFallback('Café');
  assert.equal(privacy.redact('card 1234 5678 90 ok'), `card ${MASK} ok`);
  assert.equal(privacy.redact('card 12-34-56-78-90'), `card ${MASK}`);
  assert.equal(privacy.redact(`name ${'Café'.normalize('NFD')}`), `name ${MASK}`);
  assert.equal(privacy.redact('order 98765 of 77'), 'order 98765 of 77');
});

test('a concealed input value echoed inside a word is masked with its whole token in every sink', () => {
  const observed = screen([
    element('@pin', 'PIN', { kind: 'input', secure: true, value: '7' }),
    element('@echo', 'code x7x', { kind: 'text' }),
  ]);
  const privacy = new ObservedPrivacy(['hunter2']);
  privacy.observe(observed);
  assert.equal(privacy.redact('seen: code x7x'), `seen: code ${MASK}`);
  assert.equal(privacy.redactIdentifier('login-hunter2x'), MASK);
  assert.equal(privacy.maskForModel([], []).apply('code x7x'), `code ${MASK}`);
});

test('opaque model tokens survive a short protected digit value equal to their position', () => {
  const privacy = new ObservedPrivacy();
  privacy.concealFallback('1');
  const values = Array.from({ length: 12 }, (_, i) => `value-${String.fromCharCode(97 + i)}`);
  const mask = privacy.maskForModel(values, []);
  const text = mask.tokens.join(' ');
  assert.equal(mask.apply(text), text);
});
