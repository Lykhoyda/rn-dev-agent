import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

import { INJECTED_HELPERS } from '../../dist/injected-helpers.js';

type Fiber = {
  type?: { displayName?: string };
  ref?: { current: NavigationRef } | null;
  memoizedState?: unknown;
  child?: Fiber | null;
  sibling?: Fiber | null;
};

type NavigationState = {
  routes: Array<{ name: string }>;
  routeNames: string[];
  index: number;
};

type NavigationRef = {
  navigate: (screen: string) => void;
  dispatch: () => void;
  getRootState: () => NavigationState;
};

type RendererHook = {
  renderers: Map<number, object>;
  getFiberRoots: (rendererId: number) => Set<{ current: Fiber }> | null;
};

function createNavigationFixture() {
  const navigated: string[] = [];
  const state: NavigationState = {
    routes: [{ name: 'Home' }, { name: 'Profile' }],
    routeNames: ['Home', 'Profile'],
    index: 0,
  };
  const ref: NavigationRef = {
    navigate: (screen) => navigated.push(screen),
    dispatch: () => {},
    getRootState: () => state,
  };
  const fiber: Fiber = {
    type: { displayName: 'NavigationContainer' },
    ref: { current: ref },
    memoizedState: { memoizedState: state, next: null },
    child: null,
    sibling: null,
  };
  return { fiber, navigated };
}

function createSandbox(hook: RendererHook) {
  const sandbox = {
    Array,
    Object,
    JSON,
    Map,
    Set,
    WeakSet,
    Error,
    Date,
    parseInt,
    parseFloat,
    String,
    Number,
    Boolean,
    RegExp,
    Symbol,
    Promise,
    setTimeout,
    clearTimeout,
    console: { log() {}, error() {}, warn() {}, info() {}, debug() {} },
    __REACT_DEVTOOLS_GLOBAL_HOOK__: hook,
    __RN_AGENT: undefined as
      | {
          navigateTo: (screen: string) => string;
          getNavState: () => string;
        }
      | undefined,
  };
  const context = Object.assign(sandbox, { globalThis: sandbox });
  vm.createContext(context);
  vm.runInContext(INJECTED_HELPERS, context);
  return context.__RN_AGENT!;
}

function assertNavigationDiscovered(hook: RendererHook, navigated: string[]) {
  const agent = createSandbox(hook);
  const navigationResult = JSON.parse(agent.navigateTo('Profile'));
  const stateResult = JSON.parse(agent.getNavState());

  assert.equal(navigationResult.navigated, true);
  assert.deepEqual(navigated, ['Profile']);
  assert.equal(stateResult.routeName, 'Home');
  assert.deepEqual(stateResult.stack, ['Home', 'Profile']);
}

test('GH #597: empty renderer 1 does not mask the live navigation tree in renderer 2', () => {
  const { fiber, navigated } = createNavigationFixture();
  const hook: RendererHook = {
    renderers: new Map([
      [1, {}],
      [2, {}],
    ]),
    getFiberRoots: (rendererId) => (rendererId === 2 ? new Set([{ current: fiber }]) : new Set()),
  };

  assertNavigationDiscovered(hook, navigated);
});

test('GH #597: registered renderer IDs are used instead of a bounded numeric guess', () => {
  const { fiber, navigated } = createNavigationFixture();
  const hook: RendererHook = {
    renderers: new Map([
      [1, {}],
      [21, {}],
    ]),
    getFiberRoots: (rendererId) => (rendererId === 21 ? new Set([{ current: fiber }]) : new Set()),
  };

  assertNavigationDiscovered(hook, navigated);
});

test('GH #597: an unusable renderer does not abort a later live renderer', () => {
  const { fiber, navigated } = createNavigationFixture();
  const hook: RendererHook = {
    renderers: new Map([
      [1, {}],
      [2, {}],
    ]),
    getFiberRoots(rendererId) {
      if (rendererId === 1) throw new Error('renderer is tearing down');
      return rendererId === 2 ? new Set([{ current: fiber }]) : null;
    },
  };

  assertNavigationDiscovered(hook, navigated);
});

test('GH #597: a non-navigation tree in the first live renderer does not mask a later one', () => {
  const { fiber, navigated } = createNavigationFixture();
  const shell: Fiber = {
    type: { displayName: 'LogBox' },
    child: null,
    sibling: null,
  };
  const hook: RendererHook = {
    renderers: new Map([
      [1, {}],
      [2, {}],
    ]),
    getFiberRoots(rendererId) {
      if (rendererId === 1) return new Set([{ current: shell }]);
      return rendererId === 2 ? new Set([{ current: fiber }]) : null;
    },
  };

  assertNavigationDiscovered(hook, navigated);
});

test('GH #597: the proven single-renderer navigation path remains supported', () => {
  const { fiber, navigated } = createNavigationFixture();
  const hook: RendererHook = {
    renderers: new Map([[1, {}]]),
    getFiberRoots: (rendererId) => (rendererId === 1 ? new Set([{ current: fiber }]) : new Set()),
  };

  assertNavigationDiscovered(hook, navigated);
});
