import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePlan, parseStep } from '../../../dist/qa/plan.js';
import { ACT, CHECK, judgeCheck, prepareTarget, resolveTarget } from '../../../dist/qa/resolve.js';
import { JevError, confidentChoice } from '../../../dist/qa/questions.js';
import { runPlan } from '../../../dist/qa/walker.js';
import { choice, element, screen, scriptedJudge, walker } from './judgment-fixtures.ts';

function step(line: string) {
  const parsed = parseStep(line);
  assert.ok(parsed && !('refuse' in parsed));
  return parsed;
}
const save = screen([element('@save', 'Save'), element('@draft', 'Save draft')]);
const target = step('Tap the Save button');
const check = { kind: 'check' as const, text: 'The profile was saved', literal: false };

test('act uses the full map, inclusive minimum and margin, never the confidence summary', async () => {
  assert.deepEqual(ACT, { min: 0.55, margin: 0.2 });
  for (const [probabilities, expected] of [
    [{ e0: 0.55, e1: 0.35, none: 0.1 }, '@save'],
    [{ e0: 0.549, e1: 0.3, none: 0.151 }, 'TARGET_UNSURE'],
    [{ e0: 0.55, e1: 0.36, none: 0.09 }, 'TARGET_UNSURE'],
    [{ e0: 0.1, e1: 0.1, none: 0.8 }, 'TARGET_NOT_FOUND'],
  ] as const) {
    const top = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0][0];
    const judge = scriptedJudge((q) => ({ target_0: choice(q.target_0, top, probabilities) }));
    const result = await resolveTarget(target, save, judge);
    assert.equal(
      'ref' in result ? result.ref : 'refuse' in result ? result.refuse : result.scroll,
      expected,
    );
  }
});

test('malformed, partial, nonfinite, out-of-range and inconsistent probability maps never act', () => {
  const prepared = prepareTarget(target, save);
  assert.ok('question' in prepared);
  const good = choice(prepared.question);
  for (const answer of [
    undefined,
    null,
    {},
    { type: 'noul', noul: 1 },
    { ...good, probabilities: { e0: 1 } },
    { ...good, probabilities: { e0: 1, e1: 0, none: 0, injected: 0 } },
    { ...good, probabilities: { e0: NaN, e1: 0, none: 0 } },
    { ...good, probabilities: { e0: Infinity, e1: 0, none: 0 } },
    { ...good, probabilities: { e0: 1.1, e1: -0.1, none: 0 } },
    { ...good, probabilities: { e0: 0.6, e1: 0, none: 0 } },
    { ...good, probabilities: { e0: '1', e1: 0, none: 0 } },
    { ...good, choice: 'outside' },
    { ...good, choice: 'e1' },
    { ...good, confidence: 2 },
  ])
    assert.throws(() => confidentChoice(prepared.question, answer), /JEV_RESPONSE_INVALID/);
});

test('exact unique quoted targets and literal assertions are model-free; duplicate quotes use a tie-break', async () => {
  const judge = scriptedJudge((q) => ({ target_0: choice(q.target_0, 'e1') }));
  assert.equal((await resolveTarget(step('Tap "Save"'), save, judge)).ref, '@save');
  assert.equal(judgeCheck({ ...check, text: 'Save', literal: true }, save), 'pass');
  assert.equal(judge.requests.length, 0);
  const duplicate = screen([
    element('@top', 'Save', { where: 'top' }),
    element('@bottom', 'Save', { where: 'bottom' }),
    element('@other', 'Not Save'),
  ]);
  const result = await resolveTarget(step('Tap "Save" at the bottom'), duplicate, judge);
  assert.equal(result.ref, '@bottom');
  assert.deepEqual(Object.keys(judge.requests[0].questions.target_0.criteria!), [
    'e0',
    'e1',
    'none',
  ]);
  assert.match(judge.requests[0].questions.target_0.instructions, /bottom/);
});

test('offscreen selections and none with offscreen evidence request a scroll, never a React ref press', async () => {
  const before = screen([
    element('@a', 'Header'),
    element('react:more', 'Load more', { offscreen: true, hittable: false }),
  ]);
  for (const chosen of ['e1', 'none']) {
    const judge = scriptedJudge((q) => ({ target_0: choice(q.target_0, chosen) }));
    assert.deepEqual(await resolveTarget(step('Tap Load more'), before, judge), { scroll: 'down' });
  }
});

test('candidate coverage is bounded, disabled/hidden candidates excluded, fill only selects inputs', async () => {
  const limit = screen(Array.from({ length: 30 }, (_, i) => element(`@${i}`, `button ${i}`)));
  const judge = scriptedJudge((q) => ({ target_0: choice(q.target_0) }));
  assert.equal((await resolveTarget(target, limit, judge)).ref, '@0');
  assert.equal(Object.keys(judge.requests[0].questions.target_0.criteria!).length, 31);
  const overflow = prepareTarget(target, screen([...limit.elements, element('@31', 'another')]));
  assert.ok('refuse' in overflow && overflow.refuse === 'CANDIDATE_LIMIT');
  const fill = step('Type "sensitive" into the email field');
  const mixed = screen([
    element('@text', 'Email'),
    element('@disabled', 'Email', { kind: 'input', disabled: true, offscreen: true }),
    element('@covered', 'Email', {
      kind: 'input',
      hittable: false,
      semantic: { press: 'unsupported', fill: 'supported', visibility: 'hidden' },
    }),
    element('@input', 'Email', { kind: 'input' }),
  ]);
  assert.equal((await resolveTarget(fill, mixed, judge)).ref, '@input');
  assert.equal(Object.keys(judge.requests[1].questions.target_0.criteria!).length, 2);
  assert.equal(judge.requests.length, 2, 'overflow does not silently omit candidates');
});

test('a supported non-hittable control without hidden or offscreen evidence is not silently excluded', async () => {
  const observed = screen([
    element('@blocked', 'Email', { kind: 'input', hittable: false }),
    element('@input', 'Email', { kind: 'input' }),
  ]);
  const judge = scriptedJudge(() => assert.fail('incomplete evidence must not reach Jev'));
  const result = await resolveTarget(
    step('Type "sensitive" into the email field'),
    observed,
    judge,
  );
  assert.ok('refuse' in result && result.refuse === 'SCREEN_EVIDENCE_INCOMPLETE');
  assert.equal(judge.requests.length, 0);
});

test('noul bars are inclusive and invalid answers fail closed', () => {
  assert.deepEqual(CHECK, { pass: 0.7, fail: 0.3, reasks: 1 });
  for (const [noul, expected] of [
    [0.7, 'pass'],
    [0.3, 'fail'],
    [0.5, 'unsure'],
  ] as const)
    assert.equal(judgeCheck(check, save, { type: 'noul', noul }), expected);
  for (const noul of [NaN, Infinity, -0.1, 1.1])
    assert.throws(() => judgeCheck(check, save, { type: 'noul', noul }), /JEV_RESPONSE_INVALID/);
});

test('check k and target k+1 share one fresh screen request and the target is consumed without a resnapshot', async () => {
  const judge = scriptedJudge((q) => ({
    check_1: { type: 'noul', noul: 0.9 },
    target_2: choice(q.target_2),
  }));
  const f = walker([save], judge);
  const ledger = await runPlan(parsePlan('✓ The profile is visible\n1. Tap Save').blocks!, f.deps, [
    { scope: 'preflight', questionIds: ['preflight'], inputTokens: 5, ms: 10, outcome: 'ok' },
  ]);
  assert.equal(ledger.verdict, 'PASS');
  assert.deepEqual(Object.keys(judge.requests[0].questions), ['check_1', 'target_2']);
  assert.equal(judge.requests.length, 1);
  assert.equal(f.captures(), 2, 'one decision capture, one mutation read-back');
  assert.deepEqual(f.actions, ['press @save']);
  assert.deepEqual(
    ledger.steps.map((r) => r.resolvedBy),
    ['jev', 'jev'],
  );
  assert.equal(ledger.jev.calls, 2);
  assert.equal(ledger.jev.medianMs, 15);
  assert.equal(ledger.jev.inputTokens, 15);
});

test('uncertain checks re-snapshot once and discard old target refs; a second unsure never acts', async () => {
  for (const second of [0.9, 0.5, 0.2]) {
    const judge = scriptedJudge((q, i) => ({
      check_1: { type: 'noul', noul: i ? second : 0.5 },
      target_2: choice(q.target_2),
    }));
    const fresh = screen([element('@fresh', 'Save')]);
    const f = walker([save, fresh, fresh], judge);
    const ledger = await runPlan(parsePlan('✓ Profile ready\n1. Tap Save').blocks!, f.deps);
    assert.equal(judge.requests.length, 2);
    assert.equal(ledger.verdict, second === 0.9 ? 'PASS' : 'FAIL');
    assert.deepEqual(f.actions, second === 0.9 ? ['press @fresh'] : []);
    assert.ok(!JSON.stringify(f.actions).includes('@save'));
    if (second === 0.5) assert.match(ledger.failure?.seen ?? '', /CHECK_UNSURE/);
  }
});

test('a failed check does not act on the batched next target', async () => {
  const judge = scriptedJudge((q) => ({
    check_1: { type: 'noul', noul: 0.2 },
    target_2: choice(q.target_2),
  }));
  const f = walker([save], judge);
  assert.equal((await runPlan(parsePlan('✓ Ready\n1. Tap Save').blocks!, f.deps)).verdict, 'FAIL');
  assert.deepEqual(f.actions, []);
  assert.equal(judge.requests.length, 1);
});

test('preliminary scrolling requires a fresh target question before any press', async () => {
  const before = screen([element('react:save', 'Save', { offscreen: true, hittable: false })]);
  const after = screen([element('@native-save', 'Save')]);
  const judge = scriptedJudge((q) =>
    Object.fromEntries(
      Object.entries(q).map(([id, question]) => [
        id,
        question.type === 'noul' ? { type: 'noul', noul: 0.9 } : choice(question),
      ]),
    ),
  );
  const f = walker([before, after, after], judge);
  const ledger = await runPlan(parsePlan('✓ Ready\n1. Tap Save').blocks!, f.deps);
  assert.equal(ledger.verdict, 'PASS');
  assert.deepEqual(f.actions, ['scroll down', 'press @native-save']);
  assert.deepEqual(
    judge.calls.map((c) => c.questionIds),
    [['check_1', 'target_2'], ['target_2']],
  );
});

test('phrase mutation retries obey the unchanged-screen rule, never a timeout alone', async () => {
  for (const changed of [true, false]) {
    const judge = scriptedJudge((q) =>
      Object.fromEntries(Object.entries(q).map(([id, question]) => [id, choice(question)])),
    );
    const f = walker(changed ? [save, screen([element('@next', 'Profile')])] : [save], judge, {
      ok: false,
      proven: false,
      error: 'timed out',
    });
    const ledger = await runPlan(parsePlan('1. Tap Save').blocks!, f.deps);
    assert.equal(ledger.verdict, changed ? 'PASS' : 'FAIL');
    assert.equal(f.actions.length, changed ? 1 : 2);
    assert.equal(judge.requests.length, changed ? 1 : 2);
    assert.equal(ledger.recoveries, 0);
    assert.equal(ledger.escapes, 0);
  }
});

test('typed and secure values are masked in all projected questions and screens, not mutation arguments', async () => {
  const secret = 'private-fill-text';
  const input = screen(
    [
      element('@input', 'Name', { kind: 'input', value: secret }),
      element('@secure', 'Password', { kind: 'input', secure: true, value: 'existing-secret' }),
    ],
    [`Name: ${secret}`, 'Password: existing-secret'],
  );
  const judge = scriptedJudge((q) =>
    Object.fromEntries(
      Object.entries(q).map(([id, question]) => [
        id,
        question.type === 'noul' ? { type: 'noul', noul: 0.9 } : choice(question),
      ]),
    ),
  );
  const f = walker([input], judge);
  const ledger = await runPlan(
    parsePlan(`1. Type "${secret}" into the name field\n✓ The name field is filled`).blocks!,
    f.deps,
  );
  assert.equal(ledger.verdict, 'PASS');
  assert.deepEqual(f.actions, [`fill @input ${secret}`]);
  const dump = JSON.stringify({ requests: judge.requests, ledger });
  assert.ok(!dump.includes(secret), dump);
  assert.ok(!dump.includes('existing-secret'), dump);
});

test('Jev unavailable is a line-attributed failure, with no mutation or recovery', async () => {
  const judge = scriptedJudge(() => {
    throw new JevError('JEV_UNAVAILABLE');
  });
  const f = walker([save], judge);
  const ledger = await runPlan(parsePlan('1. Tap Save').blocks!, f.deps);
  assert.match(ledger.failure?.seen ?? '', /JEV_UNAVAILABLE/);
  assert.equal(ledger.failure?.step, 1);
  assert.equal(ledger.jev.calls, 1);
  assert.deepEqual(f.actions, []);
  assert.equal(ledger.llmTurns, 0);
});

test('phrase waits and explicit scroll-until ask a presence predicate without selecting or pressing a ref', async () => {
  const before = screen([element('@loading', 'Loading')]);
  const after = screen([element('@footer', 'Footer', { kind: 'text', hittable: false })]);
  for (const line of ['1. Wait for the footer', '1. Scroll down until the footer']) {
    const judge = scriptedJudge((q, i) => {
      assert.deepEqual(Object.keys(q), ['visibility_1']);
      assert.equal(q.visibility_1.type, 'noul');
      return { visibility_1: { type: 'noul', noul: i ? 0.9 : 0.1 } };
    });
    const f = walker([before, after], judge);
    const ledger = await runPlan(parsePlan(line).blocks!, f.deps);
    assert.equal(ledger.verdict, 'PASS');
    assert.deepEqual(f.actions, line.includes('Scroll') ? ['scroll down'] : []);
    assert.equal(judge.requests.length, 2);
  }
});

test('literal walk makes no model calls beyond the accounted preflight', async () => {
  const judge = scriptedJudge(() => {
    throw new Error('unexpected model call');
  });
  const f = walker([save], judge);
  const ledger = await runPlan(parsePlan('1. Tap "Save"\n✓ "Save"').blocks!, f.deps);
  assert.equal(ledger.verdict, 'PASS');
  assert.equal(ledger.jev.calls, 0);
  assert.deepEqual(
    ledger.steps.map((r) => r.resolvedBy),
    ['exact', 'exact'],
  );
});

test('quoted visibility remains model-free even with duplicate labels in a batched check', async () => {
  const judge = scriptedJudge(() => ({ check_1: { type: 'noul', noul: 0.9 } }));
  const f = walker([screen([element('@a', 'Save'), element('@b', 'Save')])], judge);
  const ledger = await runPlan(parsePlan('✓ Ready\n1. Wait for "Save"').blocks!, f.deps);
  assert.equal(ledger.verdict, 'PASS');
  assert.deepEqual(judge.calls[0].questionIds, ['check_1']);
  assert.equal(judge.calls.length, 1);
  assert.equal(ledger.steps[1].resolvedBy, 'exact');
});

test('uncertain visibility and candidate overflow name the resolution refusal, not an HTTP error', async () => {
  for (const line of ['1. Wait for Save', '1. Scroll until Save']) {
    for (const overflow of [false, true]) {
      const judge = scriptedJudge((q) => {
        assert.deepEqual(Object.keys(q), ['visibility_1']);
        assert.equal(q.visibility_1.type, 'noul');
        return { visibility_1: { type: 'noul', noul: 0.5 } };
      });
      const f = walker(
        [
          overflow
            ? screen(Array.from({ length: 31 }, (_, i) => element(`@${i}`, `entry${i}`)))
            : save,
        ],
        judge,
      );
      const ledger = await runPlan(parsePlan(line).blocks!, f.deps);
      assert.equal(ledger.verdict, 'FAIL');
      assert.match(ledger.failure?.seen ?? '', overflow ? /CANDIDATE_LIMIT/ : /VISIBILITY_UNSURE/);
      assert.deepEqual(f.actions, []);
      assert.equal(judge.requests.length, overflow ? 0 : 2);
      assert.equal(f.captures(), overflow ? 1 : 2);
    }
  }
});
