// GH #944 / #1057 — renderer-coverage refusals keep their sentence and code,
// and now carry the coverage object that rootScanCoverage already computed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

import { INJECTED_HELPERS } from '../../dist/injected-helpers.js';

function createSandbox(opts: { hook?: object; fiberRoot?: object } = {}) {
  const sandbox: Record<string, unknown> = {
    globalThis: {},
    Array,
    Object,
    JSON,
    Map,
    WeakSet,
    Error,
    Date,
    parseInt,
    parseFloat,
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
  sandbox.globalThis = sandbox;
  if (opts.hook) {
    sandbox.__REACT_DEVTOOLS_GLOBAL_HOOK__ = opts.hook;
  } else if (opts.fiberRoot) {
    sandbox.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      renderers: new Map([[1, {}]]),
      getFiberRoots: (id: number) =>
        id === 1 ? new Set([{ current: opts.fiberRoot }]) : new Set(),
    };
  }
  vm.createContext(sandbox);
  vm.runInContext(INJECTED_HELPERS, sandbox);
  return sandbox as typeof sandbox & {
    __RN_AGENT: { isTestIdFrontmost: (id: string) => string };
    __RN_AGENT_EXTRA_ROOTS__?: () => unknown;
    __expo_router_state__?: object;
  };
}

function userComp(name: string, child: object | null, props: Record<string, unknown> = {}) {
  return {
    tag: 1,
    type: { displayName: name },
    memoizedProps: props,
    child,
    sibling: null,
    return: null,
  };
}

const COVERAGE_REASON = 'frontmost proof cannot cover every mounted renderer';

function frontmost(sandbox: { __RN_AGENT: { isTestIdFrontmost: (id: string) => string } }) {
  return JSON.parse(sandbox.__RN_AGENT.isTestIdFrontmost('target'));
}

test('isTestIdFrontmost discloses a throwing renderer id without changing the sentence', () => {
  const fiber = userComp('App', userComp('Btn', null, { testID: 'target' }));
  const sandbox = createSandbox({
    hook: {
      renderers: new Map([[1, {}]]),
      getFiberRoots: (id: number) => {
        if (id === 3) throw new Error('renderer teardown');
        if (id === 1) return new Set([{ current: fiber }]);
        return new Set();
      },
    },
  });
  const verdict = frontmost(sandbox);
  assert.equal(verdict.visible, false);
  assert.equal(verdict.code, 'ASSERTION_FAILED');
  assert.equal(verdict.reason, COVERAGE_REASON);
  assert.deepEqual(verdict.coverage.reasons, ['renderer-error']);
  assert.ok(verdict.coverage.erroredRendererIds.includes(3));
  assert.ok(verdict.coverage.rendererErrors >= 1);
});

test('isTestIdFrontmost discloses an unreadable registry as registeredRendererIds null', () => {
  const fiber = userComp('App', userComp('Btn', null, { testID: 'target' }));
  const sandbox = createSandbox({
    hook: {
      renderers: new Map<number | string, object>([
        [1, {}],
        ['qa', {}],
      ]),
      getFiberRoots: (id: number) => (id === 1 ? new Set([{ current: fiber }]) : new Set()),
    },
  });
  const verdict = frontmost(sandbox);
  assert.equal(verdict.visible, false);
  assert.equal(verdict.code, 'ASSERTION_FAILED');
  assert.equal(verdict.reason, COVERAGE_REASON);
  assert.equal(verdict.coverage.registeredRendererIds, null);
  assert.ok(verdict.coverage.reasons.includes('renderer-error'));
});

test('isTestIdFrontmost discloses a throwing extra-roots resolver', () => {
  const fiber = userComp('App', userComp('Btn', null, { testID: 'target' }));
  const sandbox = createSandbox({ fiberRoot: fiber });
  sandbox.__RN_AGENT_EXTRA_ROOTS__ = () => {
    throw new Error('qa');
  };
  const verdict = frontmost(sandbox);
  assert.equal(verdict.visible, false);
  assert.equal(verdict.code, 'ASSERTION_FAILED');
  assert.equal(verdict.reason, COVERAGE_REASON);
  assert.equal(verdict.coverage.extraRootsError, true);
});

test('a clean hook stays visible and omits coverage', () => {
  const state = { index: 0, routes: [{ key: 'home-key', name: 'home' }] };
  const neverInvoke = () => assert.fail('scene callbacks must not be invoked');
  const root: Record<string, unknown> = {
    type: { displayName: 'Root' },
    memoizedProps: {},
    return: null,
    child: null,
    sibling: null,
  };
  const screen: Record<string, unknown> = {
    type: { displayName: 'Screen' },
    memoizedProps: {
      screen: { name: 'home', component: neverInvoke },
      route: { key: 'home-key', name: 'home' },
      getState: neverInvoke,
      setState: neverInvoke,
      clearOptions: neverInvoke,
      navigation: { getState: () => state, isFocused: () => true },
    },
    return: root,
    child: null,
    sibling: null,
  };
  const target: Record<string, unknown> = {
    type: { displayName: 'View' },
    memoizedProps: { testID: 'target' },
    stateNode: {
      canonical: {
        publicInstance: {
          ownerDocument: {
            documentElement: {
              getBoundingClientRect: () => ({ x: 0, y: 0, width: 390, height: 844 }),
            },
          },
          parentElement: null,
          getBoundingClientRect: () => ({ x: 20, y: 80, width: 120, height: 44 }),
        },
      },
    },
    return: screen,
    child: null,
    sibling: null,
  };
  root.child = screen;
  screen.child = target;
  const sandbox = createSandbox({ fiberRoot: root });
  sandbox.__expo_router_state__ = state;
  const verdict = frontmost(sandbox);
  assert.equal(verdict.visible, true);
  assert.equal('coverage' in verdict, false);
});
