// D1206 Tier 2 Sprint B / Phase 126: Macro-Asserts pure-logic tests.
// Tests the evaluators and helpers in isolation — handler integration
// tests need a live CDP client and are skipped here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deepEqual,
  evaluateReduxAssertions,
  evaluateRouteAssertions,
  findRefsByText,
  unwrapStoreEnvelope,
  extractStack,
} from '../../dist/tools/macro-asserts.js';

// ─────────────────────────────────────────────────────────────────────────────
// deepEqual
// ─────────────────────────────────────────────────────────────────────────────

test('Phase126 deepEqual: primitives', () => {
  assert.equal(deepEqual(1, 1), true);
  assert.equal(deepEqual('a', 'a'), true);
  assert.equal(deepEqual(true, true), true);
  assert.equal(deepEqual(null, null), true);
  assert.equal(deepEqual(undefined, undefined), true);
  assert.equal(deepEqual(1, '1'), false);
  assert.equal(deepEqual(null, undefined), false);
});

test('Phase126 deepEqual: arrays', () => {
  assert.equal(deepEqual([1, 2, 3], [1, 2, 3]), true);
  assert.equal(deepEqual([1, 2, 3], [1, 2]), false);
  assert.equal(deepEqual([1, 2, 3], [3, 2, 1]), false);
  assert.equal(deepEqual([], []), true);
  assert.equal(deepEqual([{ a: 1 }], [{ a: 1 }]), true);
  assert.equal(deepEqual([{ a: 1 }], [{ a: 2 }]), false);
});

test('Phase126 deepEqual: objects', () => {
  assert.equal(deepEqual({ a: 1, b: 2 }, { a: 1, b: 2 }), true);
  // Order-independent
  assert.equal(deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 }), true);
  assert.equal(deepEqual({ a: 1 }, { a: 1, b: 2 }), false);
  assert.equal(deepEqual({ a: { b: { c: 1 } } }, { a: { b: { c: 1 } } }), true);
  assert.equal(deepEqual({ a: { b: { c: 1 } } }, { a: { b: { c: 2 } } }), false);
});

test('Phase126 deepEqual: array vs object distinguished', () => {
  assert.equal(deepEqual([1, 2], { 0: 1, 1: 2, length: 2 }), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// evaluateReduxAssertions
// ─────────────────────────────────────────────────────────────────────────────

test('Phase126 redux: empty assertions defaults to exists=true', () => {
  assert.deepEqual(evaluateReduxAssertions(42, {}), { matched: true });
  assert.deepEqual(evaluateReduxAssertions('hello', {}), { matched: true });
  assert.deepEqual(evaluateReduxAssertions([], {}), { matched: true });
  // null/undefined → fails the implicit exists
  const r1 = evaluateReduxAssertions(null, {});
  assert.equal(r1.matched, false);
  const r2 = evaluateReduxAssertions(undefined, {});
  assert.equal(r2.matched, false);
});

test('Phase126 redux: equals operator', () => {
  assert.deepEqual(evaluateReduxAssertions(3, { equals: 3 }), { matched: true });
  assert.deepEqual(evaluateReduxAssertions([1, 2], { equals: [1, 2] }), { matched: true });
  const failed = evaluateReduxAssertions(3, { equals: 4 });
  assert.equal(failed.matched, false);
  if (!failed.matched) {
    assert.equal(failed.failure.op, 'equals');
    assert.equal(failed.failure.expected, 4);
    assert.equal(failed.failure.actual, 3);
  }
});

test('Phase126 redux: length operator on arrays + strings', () => {
  assert.deepEqual(evaluateReduxAssertions([1, 2, 3], { length: 3 }), { matched: true });
  assert.deepEqual(evaluateReduxAssertions('hello', { length: 5 }), { matched: true });
  const failed = evaluateReduxAssertions([1], { length: 3 });
  assert.equal(failed.matched, false);
});

test('Phase126 redux: contains operator (deep)', () => {
  assert.deepEqual(evaluateReduxAssertions([{ id: 1 }, { id: 2 }], { contains: { id: 2 } }), { matched: true });
  const failed = evaluateReduxAssertions([{ id: 1 }], { contains: { id: 99 } });
  assert.equal(failed.matched, false);
});

test('Phase126 redux: numeric comparators', () => {
  assert.deepEqual(evaluateReduxAssertions(5, { gt: 3 }), { matched: true });
  assert.deepEqual(evaluateReduxAssertions(5, { lt: 10 }), { matched: true });
  assert.deepEqual(evaluateReduxAssertions(5, { gte: 5 }), { matched: true });
  assert.deepEqual(evaluateReduxAssertions(5, { lte: 5 }), { matched: true });
  const failed = evaluateReduxAssertions(5, { gt: 10 });
  assert.equal(failed.matched, false);
});

test('Phase126 redux: multiple operators evaluated as AND, first failure surfaces', () => {
  // both pass → matched
  assert.deepEqual(evaluateReduxAssertions([1, 2, 3], { length: 3, contains: 2 }), { matched: true });
  // length passes, contains fails
  const f = evaluateReduxAssertions([1, 2, 3], { length: 3, contains: 99 });
  assert.equal(f.matched, false);
  if (!f.matched) assert.equal(f.failure.op, 'contains');
});

test('Phase126 redux: exists=false matches null/undefined', () => {
  assert.deepEqual(evaluateReduxAssertions(null, { exists: false }), { matched: true });
  assert.deepEqual(evaluateReduxAssertions(undefined, { exists: false }), { matched: true });
  const f = evaluateReduxAssertions('hello', { exists: false });
  assert.equal(f.matched, false);
});

test('Phase126 redux: notExists is inverse of exists', () => {
  assert.deepEqual(evaluateReduxAssertions(null, { notExists: true }), { matched: true });
  const f = evaluateReduxAssertions('hello', { notExists: true });
  assert.equal(f.matched, false);
});

// ─────────────────────────────────────────────────────────────────────────────
// evaluateRouteAssertions
// ─────────────────────────────────────────────────────────────────────────────

const SAMPLE_NAV_STATE = {
  routeName: 'TaskDetailScreen',
  params: { taskId: '42', mode: 'edit' },
  routes: [{ name: 'Home' }, { name: 'TaskList' }, { name: 'TaskDetailScreen' }],
};

test('Phase126 route: name matches current top-of-stack', () => {
  assert.deepEqual(
    evaluateRouteAssertions(SAMPLE_NAV_STATE, { name: 'TaskDetailScreen' }),
    { matched: true },
  );
  const f = evaluateRouteAssertions(SAMPLE_NAV_STATE, { name: 'WrongScreen' });
  assert.equal(f.matched, false);
  if (!f.matched) {
    assert.equal(f.failure.field, 'name');
    assert.equal(f.failure.actual, 'TaskDetailScreen');
    assert.equal(f.failure.expected, 'WrongScreen');
  }
});

test('Phase126 route: paramsEquals does deep-equal on params', () => {
  assert.deepEqual(
    evaluateRouteAssertions(SAMPLE_NAV_STATE, { paramsEquals: { taskId: '42', mode: 'edit' } }),
    { matched: true },
  );
  const f = evaluateRouteAssertions(SAMPLE_NAV_STATE, { paramsEquals: { taskId: '99' } });
  assert.equal(f.matched, false);
});

test('Phase126 route: inStack matches a route anywhere in stack', () => {
  assert.deepEqual(evaluateRouteAssertions(SAMPLE_NAV_STATE, { inStack: 'Home' }), { matched: true });
  assert.deepEqual(evaluateRouteAssertions(SAMPLE_NAV_STATE, { inStack: 'TaskList' }), { matched: true });
  const f = evaluateRouteAssertions(SAMPLE_NAV_STATE, { inStack: 'NotInStack' });
  assert.equal(f.matched, false);
});

test('Phase126 route: missing routes array degrades gracefully', () => {
  const noRoutes = { routeName: 'X' };
  const f = evaluateRouteAssertions(noRoutes, { inStack: 'X' });
  assert.equal(f.matched, false);
});

test('Phase126 route: combines name + inStack as AND', () => {
  assert.deepEqual(
    evaluateRouteAssertions(SAMPLE_NAV_STATE, { name: 'TaskDetailScreen', inStack: 'Home' }),
    { matched: true },
  );
  const f = evaluateRouteAssertions(SAMPLE_NAV_STATE, { name: 'TaskDetailScreen', inStack: 'Missing' });
  assert.equal(f.matched, false);
  if (!f.matched) assert.equal(f.failure.field, 'inStack');
});

// ─────────────────────────────────────────────────────────────────────────────
// findRefsByText
// ─────────────────────────────────────────────────────────────────────────────

const SAMPLE_SNAP = JSON.stringify({
  ok: true,
  data: {
    nodes: [
      { ref: 'e1', label: 'rn-dev-agent-test' },
      { ref: 'e7', label: 'Tasks' },
      { ref: 'e22', label: 'Tasks (0 active)' },
      { ref: 'e60', label: 'Next' },
      { ref: 'e150', label: 'Create new task' },
    ],
  },
});

test('Phase126 findRefsByText: exact match', () => {
  assert.deepEqual(findRefsByText(SAMPLE_SNAP, 'Tasks', true), ['e7']);
});

test('Phase126 findRefsByText: substring match returns all', () => {
  // "Tasks" appears in both "Tasks" (e7) and "Tasks (0 active)" (e22)
  const refs = findRefsByText(SAMPLE_SNAP, 'Tasks', false);
  assert.ok(refs.includes('e7'));
  assert.ok(refs.includes('e22'));
});

test('Phase126 findRefsByText: no match returns empty', () => {
  assert.deepEqual(findRefsByText(SAMPLE_SNAP, 'NeverPresent', false), []);
});

test('Phase126 findRefsByText: malformed envelope returns empty', () => {
  assert.deepEqual(findRefsByText('not-json', 'foo', false), []);
});

test('Phase126 findRefsByText: ok=false envelope returns empty', () => {
  const err = JSON.stringify({ ok: false, error: 'no session' });
  assert.deepEqual(findRefsByText(err, 'Tasks', false), []);
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 128 — post-review fixes
// ─────────────────────────────────────────────────────────────────────────────

// Bug #1: unwrap {type, state} envelope from getStoreState

test('Phase128: unwrapStoreEnvelope returns state from {type, state} wrapper', () => {
  assert.deepEqual(
    unwrapStoreEnvelope({ type: 'redux', state: [1, 2, 3] }),
    [1, 2, 3],
  );
  assert.equal(
    unwrapStoreEnvelope({ type: 'zustand', state: 'active' }),
    'active',
  );
});

test('Phase128: unwrapStoreEnvelope leaves bare values untouched', () => {
  assert.deepEqual(unwrapStoreEnvelope([1, 2, 3]), [1, 2, 3]);
  assert.equal(unwrapStoreEnvelope(42), 42);
  assert.equal(unwrapStoreEnvelope(null), null);
  assert.equal(unwrapStoreEnvelope(undefined), undefined);
});

test('Phase128: unwrapStoreEnvelope leaves objects without {type, state} keys', () => {
  assert.deepEqual(unwrapStoreEnvelope({ items: [1, 2] }), { items: [1, 2] });
  assert.deepEqual(unwrapStoreEnvelope({ type: 'foo' }), { type: 'foo' });
  assert.deepEqual(unwrapStoreEnvelope({ state: 'foo' }), { state: 'foo' });
});

test('Phase128: end-to-end — wrapper unwrap fixes length operator', () => {
  // The bug: pre-fix, evaluateReduxAssertions saw {type, state} and matched
  // length=2 against the wrapper, which has no .length → assertion failed.
  // Post-fix: caller unwraps first, so length sees the array.
  const wrapped = { type: 'redux', state: [{ id: 1 }, { id: 2 }] };
  const actual = unwrapStoreEnvelope(wrapped);
  const ev = evaluateReduxAssertions(actual, { length: 2 });
  assert.deepEqual(ev, { matched: true });
});

test('Phase128: end-to-end — wrapper unwrap fixes contains operator', () => {
  const wrapped = { type: 'zustand', state: ['login', 'home'] };
  const actual = unwrapStoreEnvelope(wrapped);
  const ev = evaluateReduxAssertions(actual, { contains: 'home' });
  assert.deepEqual(ev, { matched: true });
});

// Bug #2: extractStack supports both shapes (stack: [string], routes: [{name}])

test('Phase128: extractStack reads simplified shape (stack: [string])', () => {
  const navState = {
    routeName: 'TaskDetail',
    stack: ['Home', 'TaskList', 'TaskDetail'],
  };
  assert.deepEqual(extractStack(navState), ['Home', 'TaskList', 'TaskDetail']);
});

test('Phase128: extractStack reads raw shape (routes: [{name}])', () => {
  const navState = {
    routeName: 'X',
    routes: [{ name: 'Home' }, { name: 'X' }],
  };
  assert.deepEqual(extractStack(navState), ['Home', 'X']);
});

test('Phase128: extractStack walks nested simplified shapes (Expo Router)', () => {
  const navState = {
    routeName: 'TaskDetail',
    stack: ['Tabs'],
    nested: {
      routeName: 'TaskDetail',
      stack: ['TaskList', 'TaskDetail'],
    },
  };
  const out = extractStack(navState);
  assert.ok(out.includes('Tabs'));
  assert.ok(out.includes('TaskList'));
  assert.ok(out.includes('TaskDetail'));
});

test('Phase128: extractStack returns empty when no stack/routes present', () => {
  assert.deepEqual(extractStack({}), []);
  assert.deepEqual(extractStack({ routeName: 'X' }), []);
});

test('Phase128: extractStack dedupes when both shapes present', () => {
  const navState = {
    stack: ['Home', 'X'],
    routes: [{ name: 'X' }, { name: 'Home' }],
  };
  const out = extractStack(navState);
  // Set-based dedupe.
  assert.equal(out.length, 2);
  assert.ok(out.includes('Home'));
  assert.ok(out.includes('X'));
});

test('Phase128: end-to-end — evaluateRouteAssertions inStack now works on simplified shape', () => {
  // The bug: pre-fix, evaluateRouteAssertions read navState.routes which
  // doesn't exist on the simplified path → empty stack → false negative.
  // Post-fix: extractStack reads stack OR routes.
  const simplifiedNav = { routeName: 'TaskDetail', stack: ['Home', 'TaskList', 'TaskDetail'] };
  const ev = evaluateRouteAssertions(simplifiedNav, { inStack: 'TaskList' });
  assert.deepEqual(ev, { matched: true });
});

test('Phase128: end-to-end — inStack failure on simplified shape carries the actual stack', () => {
  const simplifiedNav = { routeName: 'X', stack: ['A', 'B'] };
  const ev = evaluateRouteAssertions(simplifiedNav, { inStack: 'Missing' });
  assert.equal(ev.matched, false);
  if (!ev.matched) {
    assert.deepEqual(ev.failure.actual, ['A', 'B']);
    assert.equal(ev.failure.expected, 'Missing');
  }
});
