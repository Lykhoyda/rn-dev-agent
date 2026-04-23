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

test('B135 regression guard: in-IIFE source matches TS mirror (function shape)', () => {
  // This test imports the module source and checks that the START_RECORDING_JS
  // constant contains the Shape #1 handling (routeName check). If someone edits
  // the in-IIFE copy and forgets to mirror, this catches the drift.
  // We import the TS source (from dist/) and scan for the expected token pattern.
  //
  // This is a brittle test by design — it's a drift detector, not a semantic one.
  // The real behavior is tested by the per-shape tests above.
  return import('../../dist/cdp/test-recorder-helpers.js').then(mod => {
    const src = mod.START_RECORDING_JS;
    assert.ok(typeof src === 'string', 'START_RECORDING_JS should be a string constant');
    assert.ok(src.includes("typeof s.routeName === 'string'"),
      'B135 drift: in-IIFE extractActiveRoute must handle routeName shape');
    assert.ok(src.includes('s.nested'),
      'B135 drift: in-IIFE extractActiveRoute must walk via .nested');
    assert.ok(src.includes('Array.isArray(s.routes)'),
      'B135 drift: in-IIFE extractActiveRoute must still support legacy React Navigation routes[] shape');
  });
});
