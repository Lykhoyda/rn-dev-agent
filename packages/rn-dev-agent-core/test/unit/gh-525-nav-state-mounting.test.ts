// GH#525 finding 1: right after cdp_reload, getNavState() answered "Navigation
// state not found. Is React Navigation or Expo Router installed?" while the app
// was still mounting — in a project where the router was introspected minutes
// earlier. The helper must distinguish, in evidence order: (a) no fiber roots
// yet (bundle still loading), (b) the framework provably in the bundle via
// require(), (c) every committed root is nothing but the dev LogBox shell, so
// no app UI has rendered yet — from (d) a genuinely absent navigation
// framework; only (d) leads with the framework question. All evidence is
// read from CURRENT render state: no injection timestamps, no age inference,
// and any detection miss degrades to (d) rather than claiming mounting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { INJECTED_HELPERS } from '../../dist/injected-helpers.js';
import { createMockClient } from '../helpers/mock-cdp-client.js';
import { parseEnvelope } from '../helpers/result-helpers.js';
import { createNavigationStateHandler } from '../../dist/tools/navigation-state.js';

const LEGACY_MESSAGE = 'Navigation state not found. Is React Navigation or Expo Router installed?';

interface FiberSpec {
  name?: string;
  // host:true builds a host primitive, whose `type` is a plain string.
  host?: boolean;
  props?: Record<string, unknown>;
  memoizedState?: unknown;
  children?: FiberSpec[];
}

interface SandboxFiber {
  type: { displayName: string } | string | null;
  memoizedProps: Record<string, unknown>;
  memoizedState: unknown;
  return: SandboxFiber | null;
  child: SandboxFiber | null;
  sibling: SandboxFiber | null;
  stateNode: null;
}

function createSandbox(opts: { hook?: unknown; require?: (name: string) => unknown } = {}) {
  const sandbox: Record<string, unknown> = {
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
  if (opts.hook !== undefined) sandbox.__REACT_DEVTOOLS_GLOBAL_HOOK__ = opts.hook;
  if (opts.require) sandbox.require = opts.require;
  vm.createContext(sandbox);
  vm.runInContext(INJECTED_HELPERS, sandbox);
  return sandbox as Record<string, any>;
}

function buildFiber(spec: FiberSpec, parent: SandboxFiber | null = null): SandboxFiber {
  const fiber: SandboxFiber = {
    type: spec.name ? (spec.host ? spec.name : { displayName: spec.name }) : null,
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

// Shapes below follow react-native's own surface construction (verified in
// react-native's renderApplication.js / AppContainer-dev.js): every AppRegistry
// surface is '<debugName>(RootComponent)' > AppContainer, dev AppContainer
// renders two COMPOSITE Views (View.displayName === 'View', a forwardRef — not a
// host string type) plus DebuggingOverlay / ReactDevToolsOverlayDeferred /
// InspectorDeferred, and non-LogBox surfaces also get LogBoxNotificationContainer.
const LOG_BOX_SHELL: FiberSpec = {
  name: 'LogBoxStateSubscription',
  children: [
    {
      name: '_LogBoxNotificationContainer',
      children: [
        { name: 'View', children: [{ name: 'RCTView', host: true }] },
      ],
    },
  ],
};

// The dev overlays AppContainer renders beside the surface's own children.
const DEV_OVERLAYS: FiberSpec[] = [
  { name: 'DebuggingOverlay', children: [{ name: 'View', children: [{ name: 'RCTView', host: true }] }] },
  { name: 'ReactDevToolsOverlayDeferred' },
  { name: 'InspectorDeferred' },
];

// The LogBox surface: it commits well before any app root after a reload, and
// this is the tree cdp_navigation_state actually sees mid-mount. With no logs
// pending, LogBoxInspector renders null under _LogBoxInspectorContainer's View.
const LOG_BOX_SURFACE: FiberSpec = {
  name: 'LogBox(RootComponent)',
  children: [
    {
      name: 'AppContainer',
      children: [
        {
          name: 'View',
          children: [
            {
              name: 'View',
              children: [
                {
                  name: 'LogBoxStateSubscription',
                  children: [
                    { name: '_LogBoxInspectorContainer', children: [{ name: 'View' }] },
                  ],
                },
              ],
            },
            ...DEV_OVERLAYS,
          ],
        },
      ],
    },
  ],
};

function logBoxShellRoot(): SandboxFiber {
  return buildFiber(LOG_BOX_SURFACE);
}

// The idle dev shell surface: a committed root that has rendered nothing named
// yet. Reanimated/Bridgeless setups register a secondary renderer whose root
// looks like this while the app bundle is still booting.
function idleRoot(): SandboxFiber {
  return buildFiber({});
}

function hostOnlyRoot(): SandboxFiber {
  return buildFiber({ name: 'RCTView', host: true, children: [{ name: 'RCTView', host: true }] });
}

// An ordinarily mounted app surface that simply has no navigation container: the
// app's own '<appName>(RootComponent)' wrapper and components sit beside the same
// dev-shell overlays, so the probe must reject this root.
function plainAppRoot(): SandboxFiber {
  return buildFiber(appSurface({ name: 'HomeScreen', children: [{ name: 'RCTText', host: true }] }));
}

// The main app surface, same dev-shell scaffolding with the app's own tree inside.
function appSurface(appTree: FiberSpec): FiberSpec {
  return {
    name: 'main(RootComponent)',
    children: [
      {
        name: 'AppContainer',
        children: [
          {
            name: 'View',
            children: [
              { name: 'View', children: [appTree] },
              ...DEV_OVERLAYS,
              LOG_BOX_SHELL,
            ],
          },
        ],
      },
    ],
  };
}

test('#525 no fiber roots yet: reports app still mounting with retry, not a framework question', () => {
  const sandbox = createSandbox({ hook: hookWithRoots([]) });
  const result = JSON.parse(sandbox.__RN_AGENT.getNavState());
  assert.ok(result.error, 'expected an error payload');
  assert.match(result.error, /App is still mounting[\s\S]*[Rr]etry in ~2s/);
  assert.doesNotMatch(result.error, /Is React Navigation or Expo Router installed/);
  assert.equal(result.mounting, true);
});

test('#525 framework provably in the bundle but no nav state: evidence-based hedged message', () => {
  const sandbox = createSandbox({
    hook: hookWithRoots([plainAppRoot()]),
    require: (name: string) => {
      if (name === '@react-navigation/native') return {};
      throw new Error(`module not bundled: ${name}`);
    },
  });
  const result = JSON.parse(sandbox.__RN_AGENT.getNavState());
  assert.ok(result.error, 'expected an error payload');
  assert.equal(result.frameworkDetected, 'react-navigation');
  assert.match(result.error, /may still be mounting[\s\S]*retry in ~2s/i);
  assert.doesNotMatch(result.error, /Is React Navigation or Expo Router installed\?/);
});

test('#525 post-reload shell-only tree: hedged mounting retry, never the bare framework question', () => {
  const sandbox = createSandbox({ hook: hookWithRoots([logBoxShellRoot()]) });
  const result = JSON.parse(sandbox.__RN_AGENT.getNavState());
  assert.ok(result.error, 'expected an error payload');
  assert.match(result.error, /still mounting[\s\S]*[Rr]etry in ~2s/);
  // The framework-missing hypothesis stays visible, hedged rather than asserted.
  assert.match(result.error, /React Navigation or Expo Router/);
  assert.doesNotMatch(result.error, /Is React Navigation or Expo Router installed\?/);
  assert.equal(result.mounting, true);
  assert.equal(result.shellOnly, true);
  assert.equal(result.retryInMs, 2000);
});

test('#525 idle dev-shell root with nothing named rendered yet: hedged mounting retry', () => {
  // The strongest mid-mount evidence there is — a committed root that has not
  // rendered a single named composite — must not read as a mounted app.
  for (const roots of [[idleRoot()], [hostOnlyRoot()], [logBoxShellRoot(), idleRoot()]]) {
    const sandbox = createSandbox({ hook: hookWithRoots(roots) });
    const result = JSON.parse(sandbox.__RN_AGENT.getNavState());
    assert.match(result.error, /still mounting[\s\S]*[Rr]etry in ~2s/);
    assert.equal(result.mounting, true);
    assert.equal(result.shellOnly, true);
  }
});

test('#525 an idle secondary renderer root can NOT mask app content on another root', () => {
  const sandbox = createSandbox({ hook: hookWithRoots([idleRoot(), plainAppRoot()]) });
  const result = JSON.parse(sandbox.__RN_AGENT.getNavState());
  assert.equal(result.error, LEGACY_MESSAGE);
  assert.notEqual(result.mounting, true);
});

test('#525 mounted app root that embeds the LogBox container: the genuine framework message is preserved', () => {
  // The production dev-build shape: app components AND LogBox internals under
  // one root. Presence of a LogBox name must not make this read as mid-mount.
  const sandbox = createSandbox({ hook: hookWithRoots([plainAppRoot()]) });
  const result = JSON.parse(sandbox.__RN_AGENT.getNavState());
  assert.equal(result.error, LEGACY_MESSAGE);
  assert.notEqual(result.mounting, true);
  assert.equal(result.shellOnly, undefined);
});

test('#525 the app surface RootComponent wrapper alone keeps the legacy message', () => {
  // Allowlisting AppContainer, View and the dev overlays must not open a hole: a
  // splash-style surface rendering only Views is still an app surface, because
  // renderApplication always gives it a '<appName>(RootComponent)' wrapper.
  const sandbox = createSandbox({
    hook: hookWithRoots([
      buildFiber(appSurface({ name: 'View', children: [{ name: 'RCTView', host: true }] })),
    ]),
  });
  const result = JSON.parse(sandbox.__RN_AGENT.getNavState());
  assert.equal(result.error, LEGACY_MESSAGE);
  assert.notEqual(result.mounting, true);
});

test('#525 an unrecognized composite inside an otherwise pure shell degrades to the legacy message', () => {
  // Fail-closed on renamed/unknown internals: only LogBox* composites qualify.
  const sandbox = createSandbox({
    hook: hookWithRoots([
      buildFiber({
        name: 'LogBoxStateSubscription',
        children: [{ name: 'NotificationHost', children: [{ name: 'RCTView', host: true }] }],
      }),
    ]),
  });
  const result = JSON.parse(sandbox.__RN_AGENT.getNavState());
  assert.equal(result.error, LEGACY_MESSAGE);
  assert.notEqual(result.mounting, true);
});

test('#525 an app root alongside the LogBox shell can NOT be read as shell-only', () => {
  // Disconfirming case: once app content has committed, the shell root is no
  // longer evidence of mounting — the framework message must show immediately.
  const sandbox = createSandbox({ hook: hookWithRoots([logBoxShellRoot(), plainAppRoot()]) });
  const result = JSON.parse(sandbox.__RN_AGENT.getNavState());
  assert.equal(result.error, LEGACY_MESSAGE);
  assert.notEqual(result.mounting, true);
});

test('#525 a LogBox-named tree larger than the scan bound degrades to the legacy message', () => {
  // Fail-closed: a tree the bounded probe cannot fully walk is treated as app
  // content, never as a shell — a detection miss must not fake mounting.
  let deep: FiberSpec = { name: 'RCTView', host: true };
  for (let i = 0; i < 250; i++) deep = { name: `LogBoxWrapper${i}`, children: [deep] };
  const sandbox = createSandbox({
    hook: hookWithRoots([buildFiber({ name: 'LogBoxStateSubscription', children: [deep] })]),
  });
  const result = JSON.parse(sandbox.__RN_AGENT.getNavState());
  assert.equal(result.error, LEGACY_MESSAGE);
  assert.notEqual(result.mounting, true);
});

test('#525 a root with no LogBox name anywhere is app content, not a shell', () => {
  const sandbox = createSandbox({
    hook: hookWithRoots([buildFiber({ name: 'Splash', children: [{ name: 'View' }] })]),
  });
  const result = JSON.parse(sandbox.__RN_AGENT.getNavState());
  assert.equal(result.error, LEGACY_MESSAGE);
  assert.notEqual(result.mounting, true);
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
  const sandbox = createSandbox({ hook: hookWithRoots([root]) });
  const result = JSON.parse(sandbox.__RN_AGENT.getNavState());
  assert.equal(result.error, undefined);
  assert.equal(result.routeName, 'Home');
});

test('#525 no DevTools hook: never claims mounting, keeps the legacy message', () => {
  const sandbox = createSandbox({});
  const result = JSON.parse(sandbox.__RN_AGENT.getNavState());
  assert.ok(result.error, 'expected an error payload');
  assert.notEqual(result.mounting, true);
  assert.equal(result.error, LEGACY_MESSAGE);
});

// The mid-mount fields are machine-readable API, so they must survive the
// cdp_navigation_state boundary as envelope meta — an agent reading only the
// MCP result has to be able to act on `mounting` / `shellOnly` / `retryInMs`.
function navStateHandlerFor(payload: Record<string, unknown>) {
  const client = createMockClient({
    evaluate: async () => ({ value: JSON.stringify(payload) }),
  });
  return createNavigationStateHandler(() => client, { annotate: false });
}

test('#525 tool layer forwards the mounting guidance fields as envelope meta', async () => {
  const handler = navStateHandlerFor({
    error: 'App is still mounting — no React fiber roots exist yet. Retry in ~2s.',
    mounting: true,
    retryInMs: 2000,
  });
  const envelope = parseEnvelope(await handler({}));
  assert.equal(envelope.ok, false);
  assert.match(String(envelope.error), /still mounting/);
  assert.equal(envelope.meta?.mounting, true);
  assert.equal(envelope.meta?.retryInMs, 2000);
});

test('#525 tool layer forwards frameworkDetected and the shell-only marker', async () => {
  const bundled = parseEnvelope(
    await navStateHandlerFor({
      error: 'React Navigation is bundled but no navigation state was found.',
      frameworkDetected: 'react-navigation',
      retryInMs: 2000,
    })({}),
  );
  assert.equal(bundled.meta?.frameworkDetected, 'react-navigation');

  const shellOnly = parseEnvelope(
    await navStateHandlerFor({
      error: 'App UI is still mounting — only the development LogBox shell is rendered so far…',
      mounting: true,
      shellOnly: true,
      retryInMs: 2000,
    })({}),
  );
  assert.equal(shellOnly.meta?.shellOnly, true);
  assert.equal(shellOnly.meta?.mounting, true);
});

test('#525 tool layer attaches no meta to the legacy framework-missing refusal', async () => {
  const envelope = parseEnvelope(await navStateHandlerFor({ error: LEGACY_MESSAGE })({}));
  assert.equal(envelope.ok, false);
  assert.equal(envelope.meta, undefined);
});
