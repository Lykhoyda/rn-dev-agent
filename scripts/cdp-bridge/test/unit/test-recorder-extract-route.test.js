// B135: extractActiveRoute must handle BOTH the plugin's __RN_AGENT.getNavState()
// shape and React Navigation's native state shape. These tests exercise the
// exported TS mirror (extractActiveRouteForTest); the in-IIFE copy inside
// START_RECORDING_JS must stay in sync with this logic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractActiveRouteForTest } from '../../dist/cdp/test-recorder-helpers.js';

// --- Shape #1 (the actual format returned by __RN_AGENT.getNavState()) ---

test('B135: extracts leaf routeName from plugin getNavState() shape (single level)', () => {
  const state = {
    routeName: 'Home',
    params: {},
    stack: ['Home'],
    index: 0,
    nested: null,
  };
  assert.equal(extractActiveRouteForTest(state), 'Home');
});

test('B135: extracts leaf routeName from plugin getNavState() shape (2 levels nested — Tabs → HomeTab)', () => {
  const state = {
    routeName: 'Tabs',
    params: {},
    stack: ['Tabs'],
    index: 0,
    nested: {
      routeName: 'HomeTab',
      params: {},
      stack: ['HomeTab', 'NotificationsTab', 'TasksTab', 'ProfileTab'],
      index: 0,
      nested: null,
    },
  };
  assert.equal(extractActiveRouteForTest(state), 'HomeTab');
});

test('B135: extracts leaf routeName from 3-level nesting (Tabs → TasksTab → TasksMain)', () => {
  // This is exactly the shape cdp_navigation_state returned during Story D.
  const state = {
    routeName: 'Tabs',
    params: {},
    stack: ['Tabs'],
    index: 0,
    nested: {
      routeName: 'TasksTab',
      params: {},
      stack: ['HomeTab', 'NotificationsTab', 'TasksTab', 'ProfileTab'],
      index: 2,
      nested: {
        routeName: 'TasksMain',
        params: {},
        stack: ['TasksMain'],
        index: 0,
        nested: null,
      },
    },
  };
  assert.equal(extractActiveRouteForTest(state), 'TasksMain');
});

test('B135: returns top-level routeName when nested is undefined (not just null)', () => {
  const state = {
    routeName: 'ProfileEditModal',
    params: {},
    stack: ['ProfileEditModal'],
    index: 0,
    // nested: undefined (property absent)
  };
  assert.equal(extractActiveRouteForTest(state), 'ProfileEditModal');
});

// --- Shape #2 (React Navigation's raw state format — preserved for legacy) ---

test('legacy: extracts r.name from React Navigation routes[index] shape', () => {
  const state = {
    index: 1,
    routes: [
      { name: 'Home' },
      { name: 'Settings' },
    ],
  };
  assert.equal(extractActiveRouteForTest(state), 'Settings');
});

test('legacy: walks through routes[index].state nested React Navigation state', () => {
  const state = {
    index: 0,
    routes: [
      {
        name: 'Tabs',
        state: {
          index: 2,
          routes: [
            { name: 'Home' },
            { name: 'Notifications' },
            { name: 'Tasks' },
          ],
        },
      },
    ],
  };
  assert.equal(extractActiveRouteForTest(state), 'Tasks');
});

// --- Edge cases ---

test('returns null for null input', () => {
  assert.equal(extractActiveRouteForTest(null), null);
});

test('returns null for undefined input', () => {
  assert.equal(extractActiveRouteForTest(undefined), null);
});

test('returns null for empty object', () => {
  assert.equal(extractActiveRouteForTest({}), null);
});

test('returns null for malformed shape (routeName not a string)', () => {
  assert.equal(extractActiveRouteForTest({ routeName: 42 }), null);
});

test('returns null for malformed shape (routes not an array)', () => {
  assert.equal(extractActiveRouteForTest({ index: 0, routes: 'not-an-array' }), null);
});

test('returns null when index exceeds routes length (defensive)', () => {
  assert.equal(extractActiveRouteForTest({ index: 5, routes: [{ name: 'A' }, { name: 'B' }] }), null);
});

test('defensive: bails after 20 levels of nesting (no infinite loop on self-reference)', () => {
  // Build a self-referential state. extractActiveRoute should bail at depth 20
  // without infinite-looping or throwing.
  const state = { routeName: 'A', nested: null };
  state.nested = state;  // circular
  // Should return 'A' if the depth guard works, or null if the guard kicks in.
  // Either way: does not throw, does not infinite-loop.
  let result;
  assert.doesNotThrow(() => { result = extractActiveRouteForTest(state); });
  // With the current logic, after depth 20 it returns null (loop exits).
  assert.ok(result === null || result === 'A');
});

// --- Regression check: the in-IIFE source in START_RECORDING_JS uses the same logic ---

test('B135 regression guard: in-IIFE source matches TS mirror (function shape + semantics)', () => {
  // Drift detector: scans the in-IIFE source for token patterns that must stay
  // synced with the TS mirror. Reviewers (Gemini + Codex) caught a real drift
  // on the Shape #2 leaf return in the initial fix — this guard now includes
  // tokens for every behavioral contract, not just shape detection.
  return import('../../dist/cdp/test-recorder-helpers.js').then(mod => {
    const src = mod.START_RECORDING_JS;
    assert.ok(typeof src === 'string', 'START_RECORDING_JS should be a string constant');

    // Shape detection tokens (must be present)
    assert.ok(src.includes("typeof s.routeName === 'string'"),
      'B135 drift: in-IIFE extractActiveRoute must handle plugin routeName shape');
    assert.ok(src.includes('Array.isArray(s.routes)'),
      'B135 drift: in-IIFE extractActiveRoute must handle legacy React Navigation routes[] shape');

    // Shape #1 walks via `.nested` as an object (not just truthy)
    assert.ok(src.includes("typeof s.nested === 'object'"),
      'B135 drift: in-IIFE extractActiveRoute must check s.nested is an object before recursing');

    // Shape #2 leaf return uses strict string check (NOT `r.name || null`,
    // which would swallow `r.name = 42` as 42). Catches the exact drift the
    // reviewers flagged.
    assert.ok(src.includes("typeof r.name === 'string'"),
      'B135 drift: in-IIFE extractActiveRoute must use strict typeof string for routes[index].name (no `|| null` fallback)');
    assert.ok(!/return r\.name \|\| null\s*;/.test(src),
      'B135 drift: in-IIFE extractActiveRoute must NOT use loose `r.name || null` (TS mirror uses strict typeof)');

    // Depth guard must remain at 20 to prevent circular-reference infinite loops
    assert.ok(/depth\s*<\s*20/.test(src),
      'B135 drift: depth guard must remain at 20 levels');
  });
});

test('B135: Shape #1 takes precedence over Shape #2 on hybrid objects', () => {
  // Defensive: if a nav state object somehow has BOTH routeName (Shape #1)
  // AND routes[] + index (Shape #2), Shape #1 must win. __RN_AGENT.getNavState
  // is always Shape #1; nothing else produces hybrids today, but locking the
  // precedence prevents future refactors from silently flipping behavior.
  const hybrid = {
    routeName: 'Shape1Wins',
    index: 0,
    routes: [{ name: 'Shape2Loses' }],
    nested: null,
  };
  assert.equal(extractActiveRouteForTest(hybrid), 'Shape1Wins');
});

test('B135: malformed Shape #2 — r.name of wrong type returns null (not the bad value)', () => {
  // Guards against the drift the reviewers caught: `r.name || null` would
  // return 42 for `{name: 42}`. Strict typeof returns null.
  assert.equal(extractActiveRouteForTest({
    index: 0,
    routes: [{ name: 42 }],  // number, not string
  }), null);
  assert.equal(extractActiveRouteForTest({
    index: 0,
    routes: [{ name: { toString: () => 'BadObj' } }],  // object with toString
  }), null);
  // Empty string IS a string — strict typeof returns it as-is. This is a
  // subtle but correct behavior. Downstream consumers should treat empty
  // route names as malformed state (recorder's prevRoute check will still
  // catch it: '' !== null so one navigate event fires with to: '').
  assert.equal(extractActiveRouteForTest({
    index: 0,
    routes: [{ name: '' }],
  }), '');
});
