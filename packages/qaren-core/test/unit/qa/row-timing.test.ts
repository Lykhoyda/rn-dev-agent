import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildLedger, ledgerWithoutResult, type LedgerRow } from '../../../dist/qa/ledger.js';
import { parsePlan } from '../../../dist/qa/plan.js';
import { createRowTimer, summarizeSpeed } from '../../../dist/qa/row-timing.js';
import type { TimingEvent } from '../../../dist/qa/timing.js';
import { runPlan, walkBlock } from '../../../dist/qa/walker.js';
import { choice, element, screen, scriptedJudge, walker } from './judgment-fixtures.ts';

const end = (stage: TimingEvent['stage'], ms: number, at = 0): TimingEvent => ({
  stage,
  edge: 'end',
  outcome: 'ok',
  at,
  ms,
});

const row = (line: number, extra: Partial<LedgerRow> = {}): LedgerRow => ({
  block: 'qa',
  line,
  text: `line ${line}`,
  attempt: 1,
  kind: 'step',
  resolvedBy: 'exact',
  t: 0,
  outcome: 'pass',
  ...extra,
});

test('a row window splits captures around the act and the top-level fields sum to its total', () => {
  const timer = createRowTimer(100);
  timer.observe(end('capture', 40.4));
  timer.observe({ ...end('native-total', 30), edge: 'end' });
  timer.observe(end('react-private', 8));
  timer.observe({ stage: 'native-production', edge: 'point', outcome: 'ok', at: 0, ms: 25.6 });
  timer.observe(end('decision', 20));
  timer.observe(end('mutation', 15));
  timer.observe(end('capture', 30));
  timer.observe({ stage: 'decision', edge: 'start', outcome: 'ok', at: 0 });
  const timing = timer.take(220, 12);
  assert.deepEqual(timing, {
    captureMs: 40,
    nativeMs: 30,
    reactMs: 8,
    presenceMs: 26,
    resolveMs: 20,
    jevMs: 12,
    actMs: 15,
    postCaptureMs: 30,
    otherMs: 15,
    total: 120,
  });
  assert.equal(
    timing.captureMs + timing.resolveMs + timing.actMs + timing.postCaptureMs + timing.otherMs,
    timing.total,
  );
  const next = timer.take(230, 0);
  assert.equal(next.total, 10);
  assert.equal(next.captureMs, 0);
  assert.equal('presenceMs' in next, false);
});

test('overlap and fractional rounding still partition the row total exactly', () => {
  const sum = (t: ReturnType<ReturnType<typeof createRowTimer>['take']>): number =>
    t.captureMs + t.resolveMs + t.actMs + t.postCaptureMs + t.otherMs;
  const overlap = createRowTimer(0);
  overlap.observe(end('capture', 50));
  overlap.observe(end('decision', 50));
  const clamped = overlap.take(60, 0);
  assert.deepEqual([clamped.captureMs, clamped.resolveMs, clamped.otherMs], [50, 10, 0]);
  assert.equal(sum(clamped), clamped.total);
  const fractional = createRowTimer(0);
  fractional.observe(end('capture', 0.6));
  fractional.observe(end('decision', 0.6));
  const rounded = fractional.take(1.2, 0);
  assert.equal(rounded.total, 1);
  assert.equal(sum(rounded), rounded.total);
});

test('speed summarizes passing timed steps and checks only', () => {
  const timed = (line: number, total: number, extra: Partial<LedgerRow> = {}): LedgerRow =>
    row(line, {
      timing: {
        captureMs: 0,
        nativeMs: 0,
        reactMs: 0,
        resolveMs: 0,
        jevMs: 0,
        actMs: 0,
        postCaptureMs: 0,
        otherMs: total,
        total,
      },
      ...extra,
    });
  const rows = [
    timed(1, 100),
    timed(2, 300, { kind: 'check' }),
    timed(3, 200),
    timed(4, 900, { outcome: 'retry' }),
    timed(5, 400),
    row(6),
  ];
  assert.deepEqual(summarizeSpeed(rows), { stepMedianMs: 250, stepP95Ms: 400, walkMs: 1_900 });
  assert.equal(summarizeSpeed([row(1)]), undefined);
  assert.deepEqual(buildLedger([], rows).speed, summarizeSpeed(rows));
  assert.equal('speed' in buildLedger([], [row(1)]), false);
});

function timedWalk() {
  let now = 0;
  const f = walker(
    [screen([element('@save', 'Save')])],
    scriptedJudge((q) => Object.fromEntries(Object.keys(q).map((id) => [id, choice(q[id])]))),
  );
  const events: TimingEvent[] = [];
  f.deps.now = () => now;
  const capture = f.deps.captureScreen;
  f.deps.captureScreen = async (options) => {
    now += 40;
    return capture(options);
  };
  const press = f.deps.press;
  f.deps.press = async (ref, context) => {
    now += 15;
    return press(ref, context);
  };
  f.deps.timing = (event) => events.push(event);
  return { f, events };
}

test('a walked step carries its window timing and the ledger carries speed', async () => {
  const { f } = timedWalk();
  const ledger = await runPlan(parsePlan('1. Tap the save button').blocks!, f.deps);
  assert.equal(ledger.verdict, 'PASS');
  const [step] = ledger.steps;
  assert.ok(step.timing);
  const t = step.timing;
  assert.equal(t.captureMs + t.resolveMs + t.actMs + t.postCaptureMs + t.otherMs, t.total);
  assert.ok(t.captureMs >= 40);
  assert.equal(t.actMs >= 15, true);
  assert.equal(t.jevMs, 20);
  assert.deepEqual(f.rows[0].timing, step.timing);
  assert.deepEqual(ledger.speed, {
    stepMedianMs: t.total,
    stepP95Ms: t.total,
    walkMs: t.total,
  });
});

test('timing is passive: rows and verdict match a walk without an observer', async () => {
  const timed = timedWalk();
  const plain = timedWalk();
  delete plain.f.deps.timing;
  const plan = '✓ "Save"\n1. Tap the save button';
  const a = await runPlan(parsePlan(plan).blocks!, timed.f.deps);
  const b = await runPlan(parsePlan(plan).blocks!, plain.f.deps);
  assert.equal(a.verdict, b.verdict);
  assert.deepEqual(
    a.steps.map(({ timing: _timing, ...rest }) => rest),
    b.steps,
  );
  assert.equal('speed' in b, false);
  assert.ok(b.steps.every((s) => !('timing' in s)));
  assert.deepEqual(timed.f.actions, plain.f.actions);
});

test('a failing row-timing projection still records and emits the row', async () => {
  const { f } = timedWalk();
  f.deps.rowTiming = () => {
    throw new Error('projection');
  };
  const outcome = await walkBlock(parsePlan('1. Tap the save button').blocks![0], f.deps);
  assert.equal(outcome.failure, undefined);
  assert.equal(outcome.rows.length, 1);
  assert.equal(outcome.rows[0].outcome, 'pass');
  assert.equal('timing' in outcome.rows[0], false);
  assert.deepEqual(f.rows, outcome.rows);
});

test('a dispatch refused before authorization leaves later captures pre-action', () => {
  const timer = createRowTimer(0);
  timer.observe({ ...end('mutation', 5), count: 0 });
  timer.observe(end('capture', 30));
  const refused = timer.take(40, 0);
  assert.deepEqual([refused.actMs, refused.captureMs, refused.postCaptureMs], [5, 30, 0]);
  timer.observe({ ...end('mutation', 5), count: 1 });
  timer.observe(end('capture', 30));
  const sent = timer.take(80, 0);
  assert.deepEqual([sent.actMs, sent.captureMs, sent.postCaptureMs], [5, 0, 30]);
});

test('a ledger synthesized after the walk stopped carries no speed', () => {
  const timed = row(1, {
    timing: {
      captureMs: 0,
      nativeMs: 0,
      reactMs: 0,
      resolveMs: 0,
      jevMs: 0,
      actMs: 0,
      postCaptureMs: 0,
      otherMs: 10,
      total: 10,
    },
  });
  const ledger = ledgerWithoutResult([timed], 'core exited');
  assert.equal(ledger.verdict, 'FAIL');
  assert.equal('speed' in ledger, false);
  assert.deepEqual(ledger.steps, [timed]);
});
