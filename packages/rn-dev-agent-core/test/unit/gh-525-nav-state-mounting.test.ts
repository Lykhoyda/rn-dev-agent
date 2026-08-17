// GH#525 finding 1: right after cdp_reload, getNavState() answered "Navigation
// state not found. Is React Navigation or Expo Router installed?" while the app
// was still mounting — in a project where the router was introspected minutes
// earlier. The helper must distinguish, in evidence order: (a) no fiber roots
// yet (bundle still loading), (b) the framework provably in the bundle via
// require(), (c) helpers freshly (re)injected — the reload signal named by the
// issue, reported as a hedged both-hypotheses message — from (d) a genuinely
// absent navigation framework; only (d) leads with the framework question.
// Tests age the helpers by advancing the sandbox clock, not via any writable
// production seam.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { INJECTED_HELPERS } from '../../dist/injected-helpers.js';

const LEGACY_MESSAGE = 'Navigation state not found. Is React Navigation or Expo Router installed?';

interface FiberSpec {
  name?: string;
  props?: Record<string, unknown>;
  memoizedState?: unknown;
  children?: FiberSpec[];
}

interface SandboxFiber {
  type: { displayName: string } | null;
  memoizedProps: Record<string, unknown>;
  memoizedState: unknown;
  return: SandboxFiber | null;
  child: SandboxFiber | null;
  sibling: SandboxFiber | null;
  stateNode: null;
}

interface TestClock {
  offsetMs: number;
}

function createSandbox(opts: { hook?: unknown; require?: (name: string) => unknown } = {}) {
  const clock: TestClock = { offsetMs: 0 };
  class ClockedDate extends Date {
    static now(): number {
      return Date.now() + clock.offsetMs;
    }
  }
  const sandbox: Record<string, unknown> = {
    Array,
    Object,
    JSON,
    Map,
    WeakSet,
    Error,
    Date: ClockedDate,
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
  if (opts.hook !== undefined) sandbox.__REACT_DEVTOOLS_GLOBAL_HOOK__ = opts.hook;
  if (opts.require) sandbox.require = opts.require;
  vm.createContext(sandbox);
  vm.runInContext(INJECTED_HELPERS, sandbox);
  return { sandbox: sandbox as Record<string, any>, clock };
}

function buildFiber(spec: FiberSpec, parent: SandboxFiber | null = null): SandboxFiber {
  const fiber: SandboxFiber = {
    type: spec.name ? { displayName: spec.name } : null,
    memoizedProps: spec.props || {},
    memoizedState: spec.memoizedState || null,
    return: parent,
    child: null,
    sibling: null,
    stateNode: null,
  };
  if (spec.children && spec.children.length > 0) {
    let prev: SandboxFiber | null = null;
    for (const c of spec.children) {
      const child = buildFiber(c, fiber);
      if (!fiber.child) fiber.child = child;
      else if (prev) prev.sibling = child;
      prev = child;
    }
  }
  return fiber;
}

function hookWithRoots(rootFibers: SandboxFiber[]) {
  return {
    renderers: new Map([[1, {}]]),
    getFiberRoots: (id: number) =>
      id === 1 ? new Set(rootFibers.map((f) => ({ current: f }))) : new Set(),
  };
}

test('#525 no fiber roots yet: reports app still mounting with retry, not a framework question', () => {
  const { sandbox } = createSandbox({ hook: hookWithRoots([]) });
  const result = JSON.parse(sandbox.__RN_AGENT.getNavState());
  assert.ok(result.error, 'expected an error payload');
  assert.match(result.error, /App is still mounting[\s\S]*[Rr]etry in ~2s/);
  assert.doesNotMatch(result.error, /Is React Navigation or Expo Router installed/);
  assert.equal(result.mounting, true);
});

test('#525 framework provably in the bundle but no nav state: evidence-based hedged message even when helpers are old', () => {
  const shell = buildFiber({ name: 'PlainApp', children: [{ name: 'View' }] });
  const { sandbox, clock } = createSandbox({
    hook: hookWithRoots([shell]),
    require: (name: string) => {
      if (name === '@react-navigation/native') return {};
      throw new Error(`module not bundled: ${name}`);
    },
  });
  clock.offsetMs = 60_000;
  const result = JSON.parse(sandbox.__RN_AGENT.getNavState());
  assert.ok(result.error, 'expected an error payload');
  assert.equal(result.frameworkDetected, 'react-navigation');
  assert.match(result.error, /may still be mounting[\s\S]*retry in ~2s/i);
  assert.doesNotMatch(result.error, /Is React Navigation or Expo Router installed\?/);
});

test('#525 roots present but helpers freshly (re)injected: hedged both-hypotheses retry message', () => {
  const shell = buildFiber({ name: 'LogBoxShell', children: [{ name: 'View' }] });
  const { sandbox } = createSandbox({ hook: hookWithRoots([shell]) });
  // Freshly evaluated IIFE == freshly (re)injected helpers (age ~0ms).
  const result = JSON.parse(sandbox.__RN_AGENT.getNavState());
  assert.ok(result.error, 'expected an error payload');
  assert.match(result.error, /may still be mounting[\s\S]*retry in ~2s/i);
  // The framework-missing hypothesis stays visible, hedged rather than asserted.
  assert.match(result.error, /React Navigation or Expo Router/);
  assert.doesNotMatch(result.error, /Is React Navigation or Expo Router installed\?/);
  assert.equal(result.helpersRecentlyInjected, true);
});

test('#525 roots present, helpers long-injected, no nav container: the genuine framework message is preserved', () => {
  const shell = buildFiber({ name: 'PlainApp', children: [{ name: 'View' }] });
  const { sandbox, clock } = createSandbox({ hook: hookWithRoots([shell]) });
  clock.offsetMs = 60_000;
  const result = JSON.parse(sandbox.__RN_AGENT.getNavState());
  assert.equal(result.error, LEGACY_MESSAGE);
});

test('#525 a mounted NavigationContainer still resolves normally after the change', () => {
  const navState = { index: 0, routes: [{ name: 'Home', params: {} }] };
  const root = buildFiber({
    name: 'App',
    children: [
      {
        name: 'NavigationContainer',
        memoizedState: { memoizedState: navState, next: null },
        children: [{ name: 'Screen' }],
      },
    ],
  });
  const { sandbox } = createSandbox({ hook: hookWithRoots([root]) });
  const result = JSON.parse(sandbox.__RN_AGENT.getNavState());
  assert.equal(result.error, undefined);
  assert.equal(result.routeName, 'Home');
});

test('#525 no DevTools hook: never claims mounting, whether helpers are fresh or aged', () => {
  for (const ageMs of [0, 60_000]) {
    const { sandbox, clock } = createSandbox({});
    clock.offsetMs = ageMs;
    const result = JSON.parse(sandbox.__RN_AGENT.getNavState());
    assert.ok(result.error, 'expected an error payload');
    assert.notEqual(result.mounting, true, `age=${ageMs}: must not claim mounting without a hook`);
    assert.equal(result.error, LEGACY_MESSAGE, `age=${ageMs}: legacy message preserved`);
  }
});
