// Audit batch B6 — (1) unfiltered getTree() must walk ALL renderers (not just
// the first, typically the LogBox shell); (2) nav-graph strike state must be
// per-project and rehydrate when the project changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { INJECTED_HELPERS } from '../../dist/injected-helpers.js';
import {
  hydrateStrikesFromGraph,
  isMethodCooledDown,
  _resetStrikesForTest,
} from '../../dist/nav-graph/storage.js';

// ── unfiltered getTree multi-renderer ──────────────────────────────────

function makeSandbox(hook) {
  const sandbox = {
    Array,
    Object,
    JSON,
    Map,
    WeakSet,
    Set,
    Error,
    Date,
    RegExp,
    Symbol,
    parseInt,
    parseFloat,
    String,
    Number,
    Boolean,
    Promise,
    setTimeout,
    clearTimeout,
    console: { log() {}, error() {}, warn() {}, info() {}, debug() {} },
  };
  sandbox.globalThis = sandbox;
  sandbox.__REACT_DEVTOOLS_GLOBAL_HOOK__ = hook;
  vm.createContext(sandbox);
  vm.runInContext(INJECTED_HELPERS, sandbox);
  return sandbox;
}

function hostRoot(child) {
  const root = { type: null, memoizedProps: {}, child: null, sibling: null, return: null };
  if (child) {
    root.child = child;
    child.return = root;
  }
  return root;
}
function userComp(displayName, props) {
  return {
    type: { displayName },
    memoizedProps: props || {},
    child: null,
    sibling: null,
    return: null,
  };
}
function hostView() {
  return { type: { name: 'RCTView' }, memoizedProps: {}, child: null, sibling: null, return: null };
}

test('unfiltered getTree walks ALL renderers — finds the app tree even when renderer 1 is a shell', () => {
  const shellRoot = hostRoot(hostView()); // renderer 1: LogBox-ish shell
  const appRoot = hostRoot(userComp('HomeScreen', { testID: 'home' })); // renderer 2: the real app
  const hook = {
    renderers: new Map([
      [1, {}],
      [2, {}],
    ]),
    getFiberRoots: (id) =>
      id === 1
        ? new Set([{ current: shellRoot }])
        : id === 2
          ? new Set([{ current: appRoot }])
          : new Set(),
  };
  const sandbox = makeSandbox(hook);
  const out = JSON.parse(vm.runInContext('__RN_AGENT.getTree({})', sandbox));
  assert.ok(out.tree, 'tree present');
  const serialized = JSON.stringify(out.tree);
  assert.ok(serialized.includes('HomeScreen'), 'app component from renderer 2 must be present');
  assert.ok(serialized.includes('home'), 'app testID from renderer 2 must be present');
  assert.ok(out.rootsSeeded >= 2, 'seeded all renderers');
});

// ── per-project strike state ───────────────────────────────────────────

function graphWithStrike(slug) {
  const now = Date.now();
  return {
    meta: { project_slug: slug },
    navigators: [
      {
        id: 'root',
        screens: [
          {
            name: 'Home',
            action_records: [
              { method: 'deep_link', success: false, recorded_at: new Date(now).toISOString() },
              {
                method: 'deep_link',
                success: false,
                recorded_at: new Date(now - 1000).toISOString(),
              },
            ],
          },
        ],
      },
    ],
    all_screens: ['Home'],
  };
}

function emptyGraph(slug) {
  return {
    meta: { project_slug: slug },
    navigators: [{ id: 'root', screens: [{ name: 'Home', action_records: [] }] }],
    all_screens: ['Home'],
  };
}

test('strike cooldown hydrates per project and does not poison a different project', () => {
  _resetStrikesForTest();
  hydrateStrikesFromGraph(graphWithStrike('app-a'), 'rootA');
  assert.equal(isMethodCooledDown('Home', 'deep_link'), true, 'project A Home/deep_link is cooled');

  // Switching to a different project must clear A's strikes and rehydrate B's.
  hydrateStrikesFromGraph(emptyGraph('app-b'), 'rootB');
  assert.equal(
    isMethodCooledDown('Home', 'deep_link'),
    false,
    'project B must not inherit A cooldown',
  );
});

test('re-hydrating the same project is idempotent (keeps in-memory strikes)', () => {
  _resetStrikesForTest();
  hydrateStrikesFromGraph(graphWithStrike('app-a'), 'rootA');
  hydrateStrikesFromGraph(emptyGraph('app-a'), 'rootA'); // same key → no clear/rehydrate
  assert.equal(
    isMethodCooledDown('Home', 'deep_link'),
    true,
    'same-project rehydrate must not wipe strikes',
  );
  _resetStrikesForTest();
});
