import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  decideScreen,
  judgeCheck,
  resolveTarget,
  targetVisible,
} from '../../../dist/qa/resolve.js';
import { join, type Element, type Screen } from '../../../dist/qa/screen.js';
import { choice, element, screen, scriptedJudge } from './judgment-fixtures.ts';

const wait = (phrase = 'a Save control') => ({
  kind: 'wait' as const,
  target: { phrase },
  line: 1,
});
const yes = () =>
  scriptedJudge((questions) =>
    Object.fromEntries(Object.keys(questions).map((id) => [id, { type: 'noul', noul: 0.99 }])),
  );

test('presence uses inclusive CHECK boundaries, not ACT or a unique matching ref', async () => {
  const duplicate = screen([element('@a', 'Save'), element('@b', 'Save')]);
  for (const [noul, verdict] of [
    [0.7, 'present'],
    [0.3, 'absent'],
    [0.55, 'unsure'],
  ] as const) {
    const judge = scriptedJudge((q, _index, state) => {
      assert.deepEqual(Object.keys(q), ['visibility_1']);
      assert.equal(q.visibility_1.type, 'noul');
      assert.deepEqual(state, {
        front: 'app',
        visibilityEvidence: ['Button "Save"', 'Button "Save"'],
      });
      return { visibility_1: { type: 'noul', noul } };
    });
    const result = await decideScreen(duplicate, judge, undefined, wait());
    assert.deepEqual(result.visibility, { verdict });
    assert.equal(result.target, undefined);
    assert.equal(result.resolvedBy, 'jev');
  }
});

test('the visibility guard counts all independent contributions before equal text coalescing', async () => {
  for (const count of [30, 31]) {
    const observed = screen(Array.from({ length: count }, (_, i) => element(`@${i}`, 'Save')));
    const judge = yes();
    const result = await decideScreen(observed, judge, undefined, wait());
    if (count === 30) {
      assert.deepEqual(result.visibility, { verdict: 'present' });
      assert.equal(judge.requests.length, 1);
    } else {
      assert.ok(result.visibility && 'refuse' in result.visibility);
      assert.equal(result.visibility.refuse, 'CANDIDATE_LIMIT');
      assert.equal(judge.requests.length, 0);
    }
  }
});

test('only witnessed structural observations can be omitted from the semantic budgets', async () => {
  const structural: Element[] = Array.from({ length: 60 }, (_, i) => ({
    ...element(`@layout${i}`, ''),
    kind: 'other',
    semantic: { press: 'unsupported', fill: 'unsupported', visibility: 'unknown' },
  }));
  const observed = screen([...structural, element('@save', 'Save')]);
  const judge = yes();
  assert.deepEqual((await decideScreen(observed, judge, undefined, wait())).visibility, {
    verdict: 'present',
  });
  assert.deepEqual(judge.requests[0].state, {
    front: 'app',
    visibilityEvidence: ['Button "Save"'],
  });
  const unknown: Screen = {
    ...observed,
    elements: [element('@save', 'Save'), { ...structural[0], semantic: undefined }],
  };
  const refused = await decideScreen(unknown, judge, undefined, wait());
  assert.ok(refused.visibility && 'refuse' in refused.visibility);
  assert.equal(refused.visibility.refuse, 'SCREEN_EVIDENCE_INCOMPLETE');
  assert.equal(judge.requests.length, 1);
});

test('partial captures and native geometry cannot authorize phrase presence', async () => {
  const observed = join(
    [{ ref: '@welcome', type: 'StaticText', label: 'Welcome', hittable: true }],
    [],
    'app',
    { native: 'complete', react: 'complete' },
  );
  for (const value of [
    observed,
    { ...screen([element('@save', 'Save')]), coverage: undefined },
    {
      ...screen([element('@save', 'Save')]),
      coverage: { native: 'incomplete', react: 'complete' },
    },
  ] as Screen[]) {
    const judge = yes();
    const decision = await decideScreen(value, judge, undefined, wait());
    assert.ok(decision.visibility && 'refuse' in decision.visibility);
    assert.equal(decision.visibility.refuse, 'SCREEN_EVIDENCE_INCOMPLETE');
    assert.equal(judge.requests.length, 0);
  }
});

test('unmatched React observations are not presence evidence or permission to scroll', async () => {
  const observed = join(
    [],
    [{ role: 'button', testID: 'save', capabilities: { press: true, fill: false } }],
    'app',
    {
      native: 'complete',
      react: 'complete',
    },
  );
  const judge = yes();
  const decision = await decideScreen(observed, judge, undefined, wait());
  assert.ok(decision.visibility && 'refuse' in decision.visibility);
  assert.equal(decision.visibility.refuse, 'SCREEN_EVIDENCE_INCOMPLETE');
  assert.equal(judge.requests.length, 0);
});

test('recognizable unsupported visibility traits refuse before an optimistic model can pass them', async (t) => {
  for (const phrase of [
    'welcome heading',
    'the welcome header',
    'the Welcome TITLE',
    'welcome text above the Save control',
    'welcome text below the Save control',
    'welcome text next to Save',
    'welcome text in the top right corner',
    'centered welcome text',
    'red welcome text',
    'bold welcome text',
    'a round Save control',
    'an image showing Welcome',
  ]) {
    await t.test(phrase, async () => {
      const observed = screen([
        element('@welcome', 'Welcome', { kind: 'text', where: 'top', side: 'right' }),
        element('@save', 'Save'),
      ]);
      for (const step of [
        wait(phrase),
        { kind: 'scroll' as const, direction: 'down' as const, until: { phrase }, line: 1 },
      ]) {
        const judge = yes();
        const result = await decideScreen(observed, judge, undefined, step);
        assert.ok(result.visibility && 'refuse' in result.visibility);
        assert.equal(result.visibility.refuse, 'VISIBILITY_UNSUPPORTED');
        assert.equal(judge.requests.length, 0);
      }
    });
  }
});

test('supported text presence keeps all contributions and is not proved by equal words locally', async () => {
  const observed = screen([
    element('@welcome', 'Welcome', { kind: 'text' }),
    element('@other', 'Header', { kind: 'text' }),
  ]);
  for (const [noul, verdict] of [
    [0.99, 'present'],
    [0.01, 'absent'],
  ] as const) {
    const judge = scriptedJudge(() => ({ visibility_1: { type: 'noul', noul } }));
    const decision = await decideScreen(observed, judge, undefined, wait('welcome text'));
    assert.deepEqual(decision.visibility, { verdict });
    assert.deepEqual(judge.requests[0].state, {
      front: 'app',
      visibilityEvidence: ['Text "Welcome"', 'Text "Header"'],
    });
  }
});

test('unsupported visibility is not absence on an empty screen and does not suppress adjacent checks', async () => {
  const judge = yes();
  const decision = await decideScreen(
    screen([]),
    judge,
    { kind: 'check', text: 'the welcome heading is absent', literal: false, line: 0 },
    wait('welcome heading'),
  );
  assert.ok(decision.visibility && 'refuse' in decision.visibility);
  assert.equal(decision.visibility.refuse, 'VISIBILITY_UNSUPPORTED');
  assert.equal(decision.check, 'pass');
  assert.deepEqual(Object.keys(judge.requests[0].questions), ['check_0']);
  assert.ok(!('visibilityEvidence' in Object(judge.requests[0].state)));
});

test('unsupported phrase traits do not change quoted targets or literal checks', async () => {
  const observed = screen([element('@heading', 'Welcome heading', { kind: 'text' })]);
  const target = { phrase: 'Welcome heading', quoted: 'Welcome heading' };
  const judge = yes();
  const decision = await decideScreen(
    observed,
    judge,
    { kind: 'check', text: 'Welcome heading', literal: true, line: 0 },
    { kind: 'wait', target, line: 1 },
  );
  assert.equal(decision.check, 'pass');
  assert.equal(decision.visibility, undefined);
  assert.equal(targetVisible(target, observed), true);
  assert.equal(judge.requests.length, 0);
});

test('privacy includes excluded inputs and masks presence expectations without rewriting local evidence', async () => {
  const secret = 'private-input-value';
  const input = element('@input', 'Name', {
    kind: 'input',
    value: secret,
    semantic: { press: 'unsupported', fill: 'supported', visibility: 'hidden' },
  });
  const observed = screen([input, element('@echo', secret)]);
  const before = JSON.stringify(observed);
  const judge = yes();
  const result = await decideScreen(observed, judge, undefined, wait(secret));
  assert.deepEqual(result.visibility, { verdict: 'present' });
  assert.ok(!JSON.stringify(judge.requests).includes(secret));
  assert.match(JSON.stringify(judge.requests), /QAREN_VALUE_/);
  assert.equal(JSON.stringify(observed), before);
  assert.equal(
    judgeCheck({ kind: 'check', text: '[QAREN_VALUE_1]', literal: true }, observed),
    'fail',
  );
});

test('masked value properties remain unsure and unequal protected values cannot pass presence', async () => {
  for (const [phrase, value, verdict, calls] of [
    ['The name field contains Anton', 'Anton', 'present', 1],
    ['The name field contains Anton', 'Bob', 'absent', 0],
    ['The name field starts with A', 'Anton', 'unsure', 0],
  ] as const) {
    const observed = screen([element('@name', 'Name', { kind: 'input', value })]);
    const judge = yes();
    const result = await decideScreen(observed, judge, undefined, wait(phrase), ['Anton']);
    assert.deepEqual(result.visibility, { verdict });
    assert.equal(judge.requests.length, calls);
    assert.ok(!JSON.stringify(judge.requests).includes('Anton'));
    assert.ok(!JSON.stringify(judge.requests).includes('Bob'));
  }
});

test('semantic presence bounds protected inputs even when the legacy flag says offscreen', async () => {
  for (const [phrase, value, verdict] of [
    ['name starts with A', 'Anton', 'unsure'],
    ['name equals Anton', 'Bob', 'absent'],
  ] as const) {
    const input = element('@name', 'Name', {
      kind: 'input',
      value,
      offscreen: true,
      semantic: { press: 'unsupported', fill: 'supported', visibility: 'visible' },
    });
    const observed = screen([input]);
    const judge = yes();
    const result = await decideScreen(observed, judge, undefined, wait(phrase), ['Anton']);
    assert.deepEqual(result.visibility, { verdict });
    assert.equal(judge.requests.length, 0);
    assert.equal(observed.elements[0], input);
    assert.equal(input.offscreen, true);
  }
});

test('semantic presence keeps native input privacy facts attached to the original element', async () => {
  const observed = join(
    [{ ref: '@name', identifier: 'name', type: 'android.widget.EditText', label: 'Anton' }],
    [],
    'app',
    { native: 'complete', react: 'complete' },
  );
  const input = observed.elements[0];
  input.offscreen = true;
  input.semantic!.visibility = 'visible';
  const judge = yes();
  const decision = await decideScreen(observed, judge, undefined, wait('name starts with A'));
  assert.deepEqual(decision.visibility, { verdict: 'unsure' });
  assert.equal(judge.requests.length, 0);
  assert.equal(observed.elements[0], input);
  assert.equal(input.offscreen, true);
  assert.equal(input.label, 'Anton');
});

test('semantic presence privacy does not change the legacy check or literal assertion paths', async () => {
  const observed = screen(
    [
      element('@name', 'Name', {
        kind: 'input',
        value: 'Anton',
        offscreen: true,
        semantic: { press: 'unsupported', fill: 'supported', visibility: 'visible' },
      }),
    ],
    ['Name: Anton'],
  );
  const judge = yes();
  const decision = await decideScreen(
    observed,
    judge,
    { kind: 'check', literal: false, text: 'name starts with A', line: 0 },
    wait('name starts with A'),
  );
  assert.equal(decision.check, 'pass');
  assert.deepEqual(decision.visibility, { verdict: 'unsure' });
  assert.deepEqual(Object.keys(judge.requests[0].questions), ['check_0']);
  assert.equal(judgeCheck({ kind: 'check', literal: true, text: 'Anton' }, observed), 'pass');
});

test('a local visibility refusal does not suppress an independent batched check', async () => {
  const judge = yes();
  const decision = await decideScreen(
    screen(Array.from({ length: 31 }, (_, i) => element(`@${i}`, 'Save'))),
    judge,
    { kind: 'check', literal: false, text: 'There are Save controls', line: 0 },
    wait(),
  );
  assert.equal(decision.check, 'pass');
  assert.ok(decision.visibility && 'refuse' in decision.visibility);
  assert.equal(decision.visibility.refuse, 'CANDIDATE_LIMIT');
  assert.deepEqual(Object.keys(judge.requests[0].questions), ['check_0']);
  assert.ok(!('visibilityEvidence' in Object(judge.requests[0].state)));
});

test('semantic action selection still uses Choice and only attested offscreen evidence requests scrolling', async () => {
  const legacyOffscreen = element('@native', 'Save', {
    offscreen: true,
    semantic: { press: 'supported', fill: 'unsupported', visibility: 'visible' },
  });
  const judge = scriptedJudge((q) => ({ target_0: choice(q.target_0) }));
  const result = await resolveTarget(
    { kind: 'press', target: { phrase: 'Save' } },
    screen([legacyOffscreen]),
    judge,
  );
  assert.ok('ref' in result && result.ref === '@native');
  assert.ok(!JSON.stringify(judge.requests).includes('off screen'));
});

test('legacy React disabled flags cannot bias semantic action criteria or model state', async () => {
  const observed = screen([
    element('@save', 'Save', {
      disabled: true,
      semantic: {
        press: 'supported',
        fill: 'unsupported',
        visibility: 'visible',
        disabled: false,
      },
    }),
  ]);
  const judge = scriptedJudge((questions, _index, state) => {
    assert.equal(questions.target_0.criteria?.e0, 'Button "Save"');
    assert.deepEqual(state, { front: 'app', elements: ['Button "Save"'] });
    return { target_0: choice(questions.target_0) };
  });
  const result = await resolveTarget(
    { kind: 'press', target: { phrase: 'the Save control' } },
    observed,
    judge,
  );
  assert.ok('ref' in result && result.ref === '@save');
  const visibilityJudge = yes();
  assert.deepEqual((await decideScreen(observed, visibilityJudge, undefined, wait())).visibility, {
    verdict: 'present',
  });
  assert.deepEqual(visibilityJudge.requests[0].state, {
    front: 'app',
    visibilityEvidence: ['Button "Save"'],
  });
  assert.equal(observed.elements[0].disabled, true);
});

test('malformed presence answers fail closed rather than becoming absence', async () => {
  for (const noul of [NaN, Infinity, -0.1, 1.1]) {
    const judge = scriptedJudge(() => ({ visibility_1: { type: 'noul', noul } }));
    await assert.rejects(
      decideScreen(screen([element('@save', 'Save')]), judge, undefined, wait()),
      /JEV_RESPONSE_INVALID/,
    );
  }
});
