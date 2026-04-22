// M6 / Phase 112: deduplicateEvents tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deduplicateEvents } from '../../dist/tools/test-recorder.js';

test('M6: collapses consecutive type events on the same testID (keeps last)', () => {
  const events = [
    { type: 'type', testID: 'email', value: 'a',     t: 1000 },
    { type: 'type', testID: 'email', value: 'al',    t: 1010 },
    { type: 'type', testID: 'email', value: 'ali@',  t: 1020 },
    { type: 'type', testID: 'email', value: 'ali@x', t: 1030 },
  ];
  const out = deduplicateEvents(events);
  assert.equal(out.length, 1);
  assert.equal(out[0].value, 'ali@x');
});

test('M6: keeps distinct testID type events', () => {
  const events = [
    { type: 'type', testID: 'email', value: 'a@b.c', t: 1000 },
    { type: 'type', testID: 'pwd',   value: 'sek',   t: 1010 },
  ];
  const out = deduplicateEvents(events);
  assert.equal(out.length, 2);
});

test('M6: collapses identical taps within 100ms', () => {
  const events = [
    { type: 'tap', testID: 'submit', t: 1000 },
    { type: 'tap', testID: 'submit', t: 1050 },  // <100ms — collapsed
    { type: 'tap', testID: 'submit', t: 1200 },  // >100ms — kept
  ];
  const out = deduplicateEvents(events);
  assert.equal(out.length, 2);
  assert.deepEqual(
    out.map((e) => e.t),
    [1000, 1200],
  );
});

test('M6: keeps taps on different testIDs even within 100ms', () => {
  const events = [
    { type: 'tap', testID: 'home',   t: 1000 },
    { type: 'tap', testID: 'profile', t: 1050 },
  ];
  const out = deduplicateEvents(events);
  assert.equal(out.length, 2);
});

test('M6: preserves tap → type → swipe → navigate ordering', () => {
  const events = [
    { type: 'tap',      testID: 'login',     t: 1000 },
    { type: 'type',     testID: 'email',     value: 'a@b.c', t: 1100 },
    { type: 'swipe',    direction: 'up',     t: 1200 },
    { type: 'navigate', from: 'Login', to: 'Home', t: 1300 },
  ];
  const out = deduplicateEvents(events);
  assert.equal(out.length, 4);
  assert.deepEqual(
    out.map((e) => e.type),
    ['tap', 'type', 'swipe', 'navigate'],
  );
});

test('M6: handles empty input', () => {
  assert.deepEqual(deduplicateEvents([]), []);
});
