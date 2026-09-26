import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePlan } from '../../../dist/qa/plan.js';
import { runPlan, WAIT_POLL_MS } from '../../../dist/qa/walker.js';
import { choice, element, screen, scriptedJudge, walker } from './judgment-fixtures.ts';

function traceCaptures(f: ReturnType<typeof walker>) {
  const modes: boolean[] = [];
  const capture = f.deps.captureScreen;
  f.deps.captureScreen = async (options?: { platformPresence?: boolean }) => {
    modes.push(options?.platformPresence === true);
    return capture();
  };
  return modes;
}

function passingJudge() {
  return scriptedJudge((questions) =>
    Object.fromEntries(
      Object.entries(questions).map(([id, question]) => [
        id,
        question.type === 'choice' ? choice(question) : { type: 'noul', noul: 0.9 },
      ]),
    ),
  );
}

test('mixed plans select presence capture per operation without changing quoted captures', async () => {
  const f = walker([screen([element('@save', 'Save')])], passingJudge());
  const modes = traceCaptures(f);
  const result = await runPlan(
    parsePlan('1. Tap "Save"\n2. Tap the save button\n3. Wait for "Save"\n4. Back').blocks!,
    f.deps,
  );
  assert.equal(result.verdict, 'PASS');
  assert.deepEqual(modes, [false, false, true, true, false, false, false]);
  assert.deepEqual(f.actions, ['press @save', 'press @save', 'back']);
});

test('literal-only plans keep legacy captures for checks, targets, and targetless actions', async () => {
  const judge = scriptedJudge(() => assert.fail('literal-only plans must not ask Jev'));
  const f = walker(
    [screen([element('@save', 'Save'), element('@name', 'Name', { kind: 'input' })])],
    judge,
  );
  const modes = traceCaptures(f);
  const result = await runPlan(
    parsePlan(
      '✓ "Save"\n1. Tap "Save"\n2. Type "private-value" into "Name"\n3. Wait for "Save"\n4. Scroll until "Save"\n5. Scroll down\n6. Back\n7. Accept the dialog',
    ).blocks!,
    f.deps,
  );
  assert.equal(result.verdict, 'PASS');
  assert.deepEqual(modes, Array(13).fill(false));
  assert.equal(result.jev.calls, 0);
  assert.equal(JSON.stringify(result).includes('private-value'), false);
});

test('standalone semantic checks and checks batched with targetless steps stay legacy on re-ask', async () => {
  for (const next of ['', '\n1. Back', '\n1. Scroll down', '\n1. Accept the dialog']) {
    const judge = scriptedJudge((questions, index) => {
      assert.deepEqual(Object.keys(questions), ['check_1']);
      return { check_1: { type: 'noul', noul: index === 0 ? 0.5 : 0.9 } };
    });
    const f = walker([screen([element('@save', 'Save')])], judge);
    const modes = traceCaptures(f);
    const result = await runPlan(parsePlan(`✓ The screen is ready${next}`).blocks!, f.deps);
    assert.equal(result.verdict, 'PASS');
    assert.deepEqual(modes, next ? [false, false, false] : [false, false]);
    assert.equal(f.deps.now(), WAIT_POLL_MS);
  }
});

test('check batching and re-asks choose the next target mode and reuse only the fresh decision', async () => {
  for (const quoted of [false, true]) {
    for (const kind of ['press', 'fill', 'wait', 'scroll']) {
      const target = quoted ? '"Save"' : 'the save control';
      const line =
        kind === 'press'
          ? `Tap ${target}`
          : kind === 'fill'
            ? `Type "private-value" into ${target}`
            : kind === 'wait'
              ? `Wait for ${target}`
              : `Scroll until ${target}`;
      const judge = scriptedJudge((questions, index) =>
        Object.fromEntries(
          Object.entries(questions).map(([id, question]) => [
            id,
            question.type === 'choice'
              ? choice(question)
              : { type: 'noul', noul: id === 'check_1' && index === 0 ? 0.5 : 0.9 },
          ]),
        ),
      );
      const extra = kind === 'fill' ? { kind: 'input' as const } : {};
      const f = walker(
        [screen([element('@old', 'Save', extra)]), screen([element('@fresh', 'Save', extra)])],
        judge,
      );
      const modes = traceCaptures(f);
      const result = await runPlan(parsePlan(`✓ The screen is ready\n1. ${line}`).blocks!, f.deps);
      assert.equal(result.verdict, 'PASS', `${quoted ? 'quoted' : 'phrase'} ${kind}`);
      const mutates = kind === 'press' || kind === 'fill';
      assert.deepEqual(modes, Array(mutates ? 3 : 2).fill(!quoted));
      assert.deepEqual(
        f.actions,
        kind === 'press' ? ['press @fresh'] : kind === 'fill' ? ['fill @fresh private-value'] : [],
      );
      assert.equal(result.jev.calls, 2);
      assert.equal(f.deps.now(), WAIT_POLL_MS);
      assert.equal(JSON.stringify(result).includes('private-value'), false);
      assert.equal(JSON.stringify(judge.requests).includes('private-value'), false);
    }
  }
});

test('a literal check does not opt in or batch the following phrase step', async () => {
  const f = walker([screen([element('@save', 'Save')])], passingJudge());
  const modes = traceCaptures(f);
  const result = await runPlan(parsePlan('✓ "Save"\n1. Tap the save button').blocks!, f.deps);
  assert.equal(result.verdict, 'PASS');
  assert.deepEqual(modes, [false, true, true]);
  assert.equal(result.jev.calls, 1);
});

test('phrase press and fill keep presence mode through read-back and bounded retries', async () => {
  for (const kind of ['press', 'fill']) {
    const f = walker(
      [screen([element('@save', 'Save', kind === 'fill' ? { kind: 'input' } : {})])],
      passingJudge(),
      { ok: false, proven: false, error: 'action timed out' },
    );
    const modes = traceCaptures(f);
    const result = await runPlan(
      parsePlan(
        kind === 'press' ? '1. Tap the save button' : '1. Type "private-value" into the save field',
      ).blocks!,
      f.deps,
    );
    assert.equal(result.verdict, 'FAIL');
    assert.deepEqual(modes, [true, true, true, true]);
    assert.equal(f.actions.length, 2);
    assert.deepEqual(
      result.steps.map((row) => [row.attempt, row.outcome]),
      [
        [1, 'retry'],
        [2, 'fail'],
      ],
    );
    assert.equal(JSON.stringify(result).includes('private-value'), false);
  }
});

test('phrase targeting retains presence mode after an offscreen scroll and read-back', async () => {
  const f = walker(
    [
      screen([element('react:save', 'Save', { offscreen: true, hittable: false })]),
      screen([element('@fresh', 'Save')]),
    ],
    passingJudge(),
  );
  const modes = traceCaptures(f);
  const result = await runPlan(parsePlan('1. Tap the save button').blocks!, f.deps);
  assert.equal(result.verdict, 'PASS');
  assert.deepEqual(modes, [true, true, true]);
  assert.deepEqual(f.actions, ['scroll down', 'press @fresh']);
});

test('phrase waits and scroll-until retain presence mode for re-asks and subsequent captures', async () => {
  for (const kind of ['wait', 'scroll']) {
    const judge = scriptedJudge((_questions, index) => {
      const probability = [0.5, 0.1, 0.9][index];
      return { visibility_1: { type: 'noul', noul: probability } };
    });
    const f = walker([screen([element('@save', 'Save')])], judge);
    const modes = traceCaptures(f);
    const result = await runPlan(
      parsePlan(
        kind === 'wait' ? '1. Wait for the save control' : '1. Scroll until the save control',
      ).blocks!,
      f.deps,
    );
    assert.equal(result.verdict, 'PASS');
    assert.deepEqual(modes, [true, true, true]);
    assert.deepEqual(f.actions, kind === 'scroll' ? ['scroll down'] : []);
    assert.equal(f.deps.now(), WAIT_POLL_MS * (kind === 'wait' ? 2 : 1));
  }
});

test('uncertain visibility cached by a passed check re-asks in phrase mode then resets for a quoted step', async () => {
  for (const line of ['Wait for the save control', 'Scroll until the save control']) {
    const judge = scriptedJudge((questions, index) => {
      assert.deepEqual(
        Object.keys(questions),
        index === 0 ? ['check_1', 'visibility_2'] : ['visibility_2'],
      );
      return {
        ...(index === 0 ? { check_1: { type: 'noul' as const, noul: 0.9 } } : {}),
        visibility_2: { type: 'noul', noul: index === 0 ? 0.5 : 0.9 },
      };
    });
    const f = walker([screen([element('@save', 'Save')])], judge);
    const modes = traceCaptures(f);
    const result = await runPlan(
      parsePlan(`✓ The screen is ready\n1. ${line}\n2. Tap "Save"`).blocks!,
      f.deps,
    );
    assert.equal(result.verdict, 'PASS');
    assert.deepEqual(modes, [true, true, false, false]);
    assert.deepEqual(f.actions, ['press @save']);
    assert.equal(result.jev.calls, 2);
    assert.equal(f.deps.now(), WAIT_POLL_MS);
  }
});
