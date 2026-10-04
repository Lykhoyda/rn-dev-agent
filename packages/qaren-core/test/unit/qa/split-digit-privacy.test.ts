import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MASK, ObservedPrivacy, capturePrivateScreen } from '../../../dist/qa/privacy.js';
import { decideScreen } from '../../../dist/qa/resolve.js';
import { element, screen, scriptedJudge } from './judgment-fixtures.ts';

test('a protected value never leaks through single-character or split substrings', () => {
  const privacy = new ObservedPrivacy();
  privacy.concealFallback('1234');
  const masked = privacy.redact(
    'on screen: Enter the code | 1 | 2 | 3 | 4 | 12 | 34 | Verify | 56 | 9',
  );
  assert.equal(/[1-4]/.test(masked), false, masked);
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
    `${MASK} | qa-hidden-email | qa-hidden_email | qa.hidden | qa@example.test-extra`,
  );
});
