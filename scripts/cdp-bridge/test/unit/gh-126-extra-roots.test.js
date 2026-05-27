// GH #126 Gap B — extra fiber roots for portal modal support.
//
// Tests cover (1) the extractFiberFromInstance helper in isolation,
// (2) the iterateAllRoots primitive's extra-roots step exercised via
// the findAllRootFibers wrapper, (3) the forEachRootFiber wrapper's
// delegation preserves short-circuit semantics through to extra-roots,
// and (4) end-to-end: cdp_interact press testID inside an extra-root
// subtree fires the component's onPress.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { INJECTED_HELPERS } from '../../dist/injected-helpers.js';

/**
 * Build a fresh VM sandbox with the INJECTED_HELPERS IIFE evaluated.
 * `opts.hook` overrides the React DevTools hook (default: provides
 * one renderer at ID 1 with the given `rootFiber`). `opts.extraRoots`
 * sets `globalThis.__RN_AGENT_EXTRA_ROOTS__` to the given function.
 * Returns the populated sandbox so tests can call __RN_AGENT methods.
 */
function makeSandbox(opts = {}) {
  const sandbox = {
    Array, Object, JSON, Map, WeakSet, Set, Error, Date, RegExp, Symbol,
    parseInt, parseFloat, String, Number, Boolean, Promise,
    setTimeout, clearTimeout,
    console: { log() {}, error() {}, warn() {}, info() {}, debug() {} },
  };
  sandbox.globalThis = sandbox;
  if (opts.hook) {
    sandbox.__REACT_DEVTOOLS_GLOBAL_HOOK__ = opts.hook;
  } else if (opts.rootFiber) {
    sandbox.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      renderers: new Map([[1, {}]]),
      getFiberRoots: (id) => id === 1 ? new Set([{ current: opts.rootFiber }]) : new Set(),
    };
  } else {
    // No native renderer roots — tests that ONLY care about extra-roots.
    sandbox.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      renderers: new Map(),
      getFiberRoots: () => new Set(),
    };
  }
  if (typeof opts.extraRoots === 'function') {
    sandbox.__RN_AGENT_EXTRA_ROOTS__ = opts.extraRoots;
  }
  vm.createContext(sandbox);
  vm.runInContext(INJECTED_HELPERS, sandbox);
  return sandbox;
}

/**
 * Link parent→child and back-pointer so the synthetic tree behaves
 * like a real React fiber tree (walk-up via .return, walk-down via .child).
 */
function linkFiber(parent, child) {
  parent.child = child;
  child.return = parent;
  return child;
}

/**
 * Minimal fiber stub. Tests extend `memoizedProps` as needed; the stub
 * does NOT include stateNode/tag/flags/lanes — add per-test if a downstream
 * consumer (e.g. interact()) probes them.
 */
function fiber(props) {
  return {
    type: { displayName: props && props.displayName || 'View' },
    memoizedProps: (props && props.memoizedProps) || {},
    child: null,
    sibling: null,
    return: null,
  };
}
