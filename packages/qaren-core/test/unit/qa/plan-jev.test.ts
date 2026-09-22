import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePlanWithJev, preparePlan, readPreparedPlan } from '../../../dist/qa/plan.js';
import { preflightPlan } from '../../../dist/qa/preflight.js';
import { JevError } from '../../../dist/qa/questions.js';
import { choice, scriptedJudge } from './judgment-fixtures.ts';

test('fallback lines are classified together once and retain line numbers and whole phrases', async () => {
  const judge = scriptedJudge((questions) =>
    Object.fromEntries(Object.entries(questions).map(([id, q]) => [id, choice(q, 'press')])),
  );
  const markdown =
    '## QA\n1. Visit the account tile\n2. Visit the overview\n3. Tap "Save"\n✓ "Saved"';
  const parsed = await parsePlanWithJev(markdown, judge);
  assert.ok(parsed.blocks, JSON.stringify(parsed));
  assert.equal(judge.requests.length, 1);
  assert.deepEqual(Object.keys(judge.requests[0].questions), ['verb_2', 'verb_3']);
  assert.equal(judge.calls[0].scope, 'parse');
  assert.deepEqual(
    parsed.blocks[0].items
      .slice(0, 2)
      .map((i) => [i.line, i.source, i.kind === 'press' && i.target.phrase]),
    [
      [2, 'jev', 'Visit the account tile'],
      [3, 'jev', 'Visit the overview'],
    ],
  );
  const prepared = preparePlan(markdown, parsed.blocks);
  assert.deepEqual(readPreparedPlan(markdown, JSON.parse(JSON.stringify(prepared))), parsed.blocks);
  const sortKeys = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(sortKeys)
      : value !== null && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, entry]) => [key, sortKeys(entry)]),
          )
        : value;
  assert.deepEqual(
    readPreparedPlan(markdown, sortKeys(JSON.parse(JSON.stringify(prepared)))),
    parsed.blocks,
    'Rust reserializes JSON object keys in a different order',
  );
  assert.equal(readPreparedPlan(markdown + '\n', prepared), undefined);
  const altered = structuredClone(prepared);
  altered.blocks[0].items[0].kind = 'back';
  assert.equal(readPreparedPlan(markdown, altered), undefined);
  assert.equal(judge.requests.length, 1, 'handing off the parsed plan never asks again');
});

test('grammar and literal checks never call the model during parsing', async () => {
  const judge = scriptedJudge(() => {
    throw new Error('must not ask');
  });
  assert.ok((await parsePlanWithJev('1. Tap "Save"\n✓ "Saved"', judge)).blocks);
  const unsafe = await parsePlanWithJev('1. Fill name with a value', judge);
  assert.ok(unsafe.refused?.some((r) => r.line === 1));
  assert.equal(judge.requests.length, 0);
});

test('unsupported, unsure, missing fill text and unsafe parameters refuse at their source line', async () => {
  for (const [line, kind, unsure] of [
    ['Perform a shell command', 'unsupported', false],
    ['Visit the profile', 'press', true],
    ['Populate the name field', 'fill', false],
    ['Populate the "Email" field', 'fill', false],
    ['Populate "Name" with "Anton"', 'fill', false],
    ['Move the list', 'scroll', false],
    ['Respond to the prompt', 'dialog', false],
  ] as const) {
    const judge = scriptedJudge((questions) =>
      Object.fromEntries(
        Object.entries(questions).map(([id, q]) => [
          id,
          choice(
            q,
            kind,
            unsure
              ? {
                  press: 0.4,
                  fill: 0.3,
                  scroll: 0.1,
                  wait: 0.1,
                  back: 0,
                  dialog: 0,
                  check: 0,
                  unsupported: 0.1,
                }
              : undefined,
          ),
        ]),
      ),
    );
    const parsed = await parsePlanWithJev(`## QA\n1. ${line}`, judge);
    assert.ok(
      parsed.refused?.some((r) => r.line === 2),
      JSON.stringify(parsed),
    );
    assert.equal(parsed.blocks, undefined);
  }
});

test('safe fallback arguments are copied deterministically and values never go to the verb model', async () => {
  for (const [line, kind, fields] of [
    ['Populate the name field with value "Anton-secret"', 'fill', { text: 'Anton-secret' }],
    ['Swipe up', 'scroll', { direction: 'down' }],
    ['Swipe down until the footer', 'scroll', { direction: 'up' }],
    ['Please allow the permission', 'dialog', { action: 'accept' }],
    ['Return to the prior screen', 'back', {}],
    ['Await the profile header', 'wait', {}],
    ['Confirm the profile header is shown', 'check', { literal: false }],
  ] as const) {
    const judge = scriptedJudge((questions) =>
      Object.fromEntries(Object.entries(questions).map(([id, q]) => [id, choice(q, kind)])),
    );
    const parsed = await parsePlanWithJev(`1. ${line}`, judge);
    assert.ok(parsed.blocks, JSON.stringify(parsed));
    const item = parsed.blocks[0].items[0];
    assert.equal(item.kind, kind);
    for (const [key, value] of Object.entries(fields)) assert.equal(Reflect.get(item, key), value);
    assert.ok(!JSON.stringify(judge.requests).includes('Anton-secret'));
  }
});

test('fixed preflight probe is mandatory even for a literal plan and is included in accounting', async () => {
  const judge = scriptedJudge(() => ({ preflight: { type: 'noul', noul: 0.99 } }));
  const result = await preflightPlan('1. Tap "A"', judge);
  assert.equal(result.ok, true);
  assert.equal(result.jev.calls, 1);
  assert.equal(result.jev.inputTokens, 10);
  assert.deepEqual(judge.requests[0].state, { readiness: 'ready' });
  assert.deepEqual(result.jev.callDetails[0].questionIds, ['preflight']);
  assert.equal(result.jev.callDetails[0].scope, 'preflight');
});

test('preflight does one probe and one fallback batch, not a parse per line', async () => {
  const judge = scriptedJudge((questions, i) =>
    i === 0
      ? { preflight: { type: 'noul', noul: 0.99 } }
      : Object.fromEntries(Object.entries(questions).map(([id, q]) => [id, choice(q, 'press')])),
  );
  const result = await preflightPlan('1. Visit profile\n2. Visit edit', judge);
  assert.ok(result.ok);
  assert.equal(result.jev.calls, 2);
  assert.deepEqual(
    result.jev.callDetails.map((c) => c.scope),
    ['preflight', 'parse'],
  );
});

test('bad credentials and malformed probe answers refuse without parsing', async () => {
  for (const judge of [
    scriptedJudge(() => {
      throw new JevError('JEV_AUTH_FAILED');
    }),
    scriptedJudge(() => ({})),
    scriptedJudge(() => ({ preflight: { type: 'noul', noul: 0.2 } })),
  ]) {
    const result = await preflightPlan('1. Select profile', judge);
    assert.ok(!result.ok && result.code === 'JEV_UNREACHABLE');
    assert.equal(judge.requests.length, 1);
  }
});
