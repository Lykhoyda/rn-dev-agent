import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { INJECTED_HELPERS } from '../../dist/injected-helpers.js';

/**
 * Create a VM sandbox with mock React DevTools globals.
 * The INJECTED_HELPERS IIFE reads from globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__
 * to find the fiber root, and from globalThis for store/nav globals.
 */
function createSandbox(opts = {}) {
  const sandbox = {
    globalThis: {},
    Array, Object, JSON, Map, WeakSet, Error, Date, parseInt, parseFloat,
    typeof: undefined,
    console: { log() {}, error() {}, warn() {}, info() {}, debug() {} },
    String,
    Number,
    Boolean,
    RegExp,
    Symbol,
    Set,
    Promise,
    setTimeout,
    clearTimeout,
  };
  // Share the globalThis reference
  sandbox.globalThis = sandbox;

  // Set up React DevTools hook with a mock fiber root
  if (opts.fiberRoot) {
    sandbox.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      renderers: new Map([[1, {}]]),
      getFiberRoots: () => new Set([{ current: opts.fiberRoot }]),
    };
  }

  // Copy any extra globals
  if (opts.globals) {
    Object.assign(sandbox, opts.globals);
  }

  vm.createContext(sandbox);
  vm.runInContext(INJECTED_HELPERS, sandbox);
  return sandbox;
}

// ── B3: Navigation state hook walker ─────────────────────────────────

test('getNavState: finds nav state in first hook position', () => {
  const navState = { routes: [{ name: 'Home' }], index: 0, routeNames: ['Home'] };
  const fiber = {
    type: { displayName: 'NavigationContainer' },
    memoizedState: {
      memoizedState: navState,
      next: null,
    },
    child: null, sibling: null,
  };
  const sandbox = createSandbox({ fiberRoot: fiber });
  const result = JSON.parse(sandbox.__RN_AGENT.getNavState());
  assert.equal(result.routeName, 'Home');
  assert.deepEqual(result.stack, ['Home']);
});

test('getNavState: finds nav state in third hook position (B3 regression)', () => {
  const navState = { routes: [{ name: 'Profile' }, { name: 'Settings' }], index: 1, routeNames: ['Profile', 'Settings'] };
  // Simulate: useState, useRef, then useReducer with nav state
  const fiber = {
    type: { displayName: 'NavigationContainer' },
    memoizedState: {
      memoizedState: 'not-nav-state',  // useState
      next: {
        memoizedState: { current: null },  // useRef
        next: {
          memoizedState: navState,  // nav state in 3rd position
          next: null,
        },
      },
    },
    child: null, sibling: null,
  };
  const sandbox = createSandbox({ fiberRoot: fiber });
  const result = JSON.parse(sandbox.__RN_AGENT.getNavState());
  assert.equal(result.routeName, 'Settings');
  assert.equal(result.index, 1);
});

test('getNavState: finds nav state in queue.lastRenderedState', () => {
  const navState = { routes: [{ name: 'Dashboard' }], index: 0, routeNames: ['Dashboard'] };
  const fiber = {
    type: { displayName: 'NavigationContainer' },
    memoizedState: {
      memoizedState: null,
      queue: { lastRenderedState: navState },
      next: null,
    },
    child: null, sibling: null,
  };
  const sandbox = createSandbox({ fiberRoot: fiber });
  const result = JSON.parse(sandbox.__RN_AGENT.getNavState());
  assert.equal(result.routeName, 'Dashboard');
});

test('getNavState: finds nav state via ExpoRoot fiber name', () => {
  const navState = { routes: [{ name: 'Index' }], index: 0, routeNames: ['Index'] };
  const fiber = {
    type: { name: 'ExpoRoot' },
    memoizedState: { memoizedState: navState, next: null },
    child: null, sibling: null,
  };
  const sandbox = createSandbox({ fiberRoot: fiber });
  const result = JSON.parse(sandbox.__RN_AGENT.getNavState());
  assert.equal(result.routeName, 'Index');
});

test('getNavState: returns error when no nav state in hooks', () => {
  const fiber = {
    type: { displayName: 'NavigationContainer' },
    memoizedState: {
      memoizedState: 'just a string',
      next: { memoizedState: 42, next: null },
    },
    child: null, sibling: null,
  };
  const sandbox = createSandbox({ fiberRoot: fiber });
  const result = JSON.parse(sandbox.__RN_AGENT.getNavState());
  assert.ok(result.error, 'Should return an error when no nav state found');
});

// ── B4: Jotai store detection ────────────────────────────────────────

test('getStoreState: reads Jotai atoms via __JOTAI_STORE__ + __JOTAI_ATOMS__', () => {
  const countAtom = { __brand: 'countAtom' };
  const userAtom = { __brand: 'userAtom' };
  const atomValues = new Map([[countAtom, 42], [userAtom, { name: 'Alice' }]]);

  const sandbox = createSandbox({
    globals: {
      __JOTAI_STORE__: { get: (atom) => atomValues.get(atom) },
      __JOTAI_ATOMS__: { count: countAtom, user: userAtom },
    },
  });
  const result = JSON.parse(sandbox.__RN_AGENT.getStoreState(undefined, 'jotai'));
  assert.equal(result.type, 'jotai');
  assert.equal(result.state.count, 42);
  assert.deepEqual(result.state.user, { name: 'Alice' });
});

test('getStoreState: handles Jotai atom that throws', () => {
  const goodAtom = { __brand: 'good' };
  const badAtom = { __brand: 'bad' };

  const sandbox = createSandbox({
    globals: {
      __JOTAI_STORE__: {
        get: (atom) => {
          if (atom === badAtom) throw new Error('derived atom not ready');
          return 'ok';
        },
      },
      __JOTAI_ATOMS__: { good: goodAtom, bad: badAtom },
    },
  });
  const result = JSON.parse(sandbox.__RN_AGENT.getStoreState(undefined, 'jotai'));
  assert.equal(result.type, 'jotai');
  assert.equal(result.state.good, 'ok');
  assert.match(result.state.bad, /error.*derived atom not ready/);
});

test('getStoreState: skips Jotai when store lacks get function', () => {
  const sandbox = createSandbox({
    globals: {
      __JOTAI_STORE__: { noGetMethod: true },
      __JOTAI_ATOMS__: { count: {} },
    },
  });
  const result = JSON.parse(sandbox.__RN_AGENT.getStoreState());
  assert.ok(result.__agent_error, 'Should return no-store error when Jotai store lacks get()');
});

test('getStoreState: no-store error includes Jotai hint', () => {
  const sandbox = createSandbox({});
  const result = JSON.parse(sandbox.__RN_AGENT.getStoreState());
  assert.ok(result.hint3, 'hint3 should exist for Jotai');
  assert.match(result.hint3, /JOTAI_STORE/);
});
