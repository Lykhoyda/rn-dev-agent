import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePlan } from '../../../dist/qa/plan.js';
import type { Element, Screen } from '../../../dist/qa/screen.js';
import { EVIDENCE_USE_MS, type TimingEvent } from '../../../dist/qa/timing.js';
import { runPlan, WAIT_POLL_MS } from '../../../dist/qa/walker.js';
import { scriptedJudge, walker } from './judgment-fixtures.ts';

const text = (label: string): Element => ({
  ref: '@text',
  label,
  kind: 'text',
  hittable: true,
  disabled: false,
  secure: false,
  offscreen: false,
  semantic: { press: 'unsupported', fill: 'unsupported', visibility: 'visible' },
});
const shown = (label: string): Screen => ({
  front: 'app',
  elements: [text(label)],
  visibleText: [label],
  coverage: { native: 'complete', react: 'complete' },
});

// Visibility answers by screen text: 'Welcome' is present, anything else is not yet.
function judge() {
  return scriptedJudge((questions, _index, state) => {
    const welcome = JSON.stringify(state).includes('Welcome');
    return Object.fromEntries(
      Object.keys(questions).map((id) => [id, { type: 'noul', noul: welcome ? 0.9 : 0.1 }]),
    );
  });
}

function timedWalker(screens: Screen[]) {
  const j = judge();
  const f = walker(screens, j);
  const presence: boolean[] = [];
  const events: TimingEvent[] = [];
  const capture = f.deps.captureScreen;
  f.deps.captureScreen = async (options) => {
    if (!options?.probe) presence.push(options?.platformPresence === true);
    return capture(options);
  };
  f.deps.timing = (event) => events.push(event);
  return { f, judge: j, presence, events };
}

test('an unchanged screen gets one presence capture and then only probes until it changes', async () => {
  const loading = shown('Loading');
  const { f, judge: j, presence, events } = timedWalker([loading]);
  let polls = 0;
  const sleep = f.deps.sleep;
  f.deps.sleep = async (ms) => {
    polls++;
    await sleep(ms);
  };
  const capture = f.deps.captureScreen;
  f.deps.captureScreen = async (options) => {
    const screen = await capture(options);
    return polls >= 6 ? shown('Welcome') : screen;
  };
  const result = await runPlan(parsePlan('1. Wait for the welcome text').blocks!, f.deps);
  assert.equal(result.verdict, 'PASS');
  assert.deepEqual(presence, [true, true]);
  assert.equal(j.calls.length, 2);
  assert.equal(f.deps.now(), 6 * WAIT_POLL_MS);
  const skipped = events.filter((e) => e.stage === 'cache-reuse');
  assert.equal(skipped.length, 5);
  assert.ok(skipped.every((e) => e.observation === skipped[0].observation));
});

test('a changed screen signature takes a fresh presence capture before any positive judgment', async () => {
  const { f, judge: j, presence, events } = timedWalker([shown('Loading'), shown('Welcome')]);
  const result = await runPlan(parsePlan('1. Wait for the welcome text').blocks!, f.deps);
  assert.equal(result.verdict, 'PASS');
  assert.deepEqual(presence, [true, true]);
  assert.equal(j.calls.length, 2);
  assert.equal(f.probes(), 2);
  assert.equal(events.filter((e) => e.stage === 'cache-reuse').length, 0);
  const positive = events.filter((e) => e.stage === 'decision' && e.edge === 'end').at(-1)!;
  const judged = events.filter((e) => e.stage === 'capture' && e.edge === 'end' && !e.probe).at(-1)!;
  assert.equal(positive.observation, judged.observation);
  assert.equal(judged.presence, 1);
});

test('presence evidence that stops being usable is recaptured on an unchanged screen', async () => {
  const { f, judge: j, presence } = timedWalker([shown('Loading')]);
  let elapsed = 0;
  f.deps.now = () => elapsed;
  f.deps.sleep = async (ms) => {
    elapsed += ms;
  };
  const capture = f.deps.captureScreen;
  f.deps.captureScreen = async (options) => {
    const screen = await capture(options);
    return !options?.probe && presence.length === 3 ? shown('Welcome') : screen;
  };
  const result = await runPlan(parsePlan('1. Wait for the welcome text').blocks!, f.deps);
  assert.equal(result.verdict, 'PASS');
  assert.deepEqual(presence, [true, true, true]);
  assert.equal(j.calls.length, 3);
  assert.equal(elapsed, 2 * EVIDENCE_USE_MS);
});

test('quoted waits never probe; their polls already use plain captures', async () => {
  const { f, presence } = timedWalker([shown('Loading'), shown('Welcome')]);
  const result = await runPlan(parsePlan('1. Wait for "Welcome"').blocks!, f.deps);
  assert.equal(result.verdict, 'PASS');
  assert.deepEqual(presence, [false, false]);
  assert.equal(f.probes(), 0);
});
