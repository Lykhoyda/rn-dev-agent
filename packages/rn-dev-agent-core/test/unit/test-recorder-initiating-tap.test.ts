// B145: the recorder dropped the tap that INITIATED a navigation whenever the
// tapped control was already mounted when recording started.
//
// React (dev) freezes element props inside createElement, which is the seam the
// recorder hooks. That seam only sees FUTURE renders, so a control already on
// the declared start route kept its original unwrapped onPress forever. A
// command-palette open/close walk therefore recorded {navigate, tap(close),
// navigate} — the opening tap missing — and save_as_action emitted a flow whose
// first executable step was an unreachable `assertVisible: command-palette-close`
// from HomeMain, which timed out on replay.
//
// These tests execute the real injected JS against a synthetic React-like host,
// so they are hermetic: no device, no Hermes, no CDP. The artifact under test IS
// a JS source string, so running it is the only way to assert capture behaviour
// rather than string shape (the js-guard suite covers string shape).
// runInThisContext evaluates against the real global — which is exactly what the
// injected IIFE reads — without eval's scope capture.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInThisContext } from 'node:vm';
import { START_RECORDING_JS, STOP_RECORDING_JS } from '../../dist/cdp/test-recorder-helpers.js';
import { generateMaestro } from '../../dist/tools/test-recorder-generators.js';
import { deduplicateEvents } from '../../dist/tools/test-recorder.js';

type Props = Record<string, unknown>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Fiber = any;

interface RecordedEventLike {
  type: string;
  testID?: string | null;
  from?: string | null;
  to?: string;
  t: number;
}

// React dev-mode calls Object.freeze on element props inside createElement.
function createElement(type: unknown, props: Props): { type: unknown; props: Props } {
  Object.freeze(props);
  return { type, props };
}

interface ChildSpec {
  testID: string;
  make: () => Props;
}

// A composite screen fiber whose render re-creates its children's elements —
// the behaviour the recorder depends on when it forces a re-render.
function makeScreen(name: string, specs: ChildSpec[]) {
  const live: Record<string, Props> = {};
  let renders = 0;
  const fiber: Fiber = {
    type: { name },
    memoizedProps: {},
    stateNode: null,
    child: null,
    sibling: null,
    return: null,
  };
  fiber.stateNode = {
    forceUpdate() {
      renders++;
      let prev: Fiber = null;
      fiber.child = null;
      for (const spec of specs) {
        const el = createElement('Pressable', spec.make());
        live[spec.testID] = el.props;
        const childFiber: Fiber = {
          type: 'Pressable',
          memoizedProps: el.props,
          stateNode: null,
          child: null,
          sibling: null,
          return: fiber,
        };
        if (prev) prev.sibling = childFiber;
        else fiber.child = childFiber;
        prev = childFiber;
      }
    },
  };
  fiber.stateNode.forceUpdate();
  renders = 0; // initial mount is not a recorder-forced re-render
  return { fiber, live, forcedRenders: () => renders };
}

interface Host {
  start(): { ok: boolean; activeRoute: string | null };
  stop(): RecordedEventLike[];
  commit(route: string): void;
  press(props: Props): void;
  mountLater(testID: string): Props;
  dispose(): void;
}

interface HostOptions {
  hook: Fiber;
  rootContainer: Fiber;
}

function makeHost(screen: { fiber: Fiber }, initialRoute: string, options?: HostOptions): Host {
  let navState: unknown = { routeName: initialRoute, nested: null };
  const rootContainer = options?.rootContainer ?? {
    current: { type: null, child: screen.fiber, sibling: null },
  };
  if (!options) screen.fiber.return = rootContainer.current;
  const roots = new Set([rootContainer]);
  const hook: Fiber =
    options?.hook ??
    ({
      renderers: new Map([[1, { overrideProps: null }]]),
      onCommitFiberRoot: null,
      getFiberRoots: (id: number) => (id === 1 ? roots : new Set()),
    } as Fiber);
  const g = globalThis as Fiber;
  const prevHook = g.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  const prevAgent = g.__RN_AGENT;
  const prevFreeze = Object.freeze;
  g.__REACT_DEVTOOLS_GLOBAL_HOOK__ = hook;
  g.__RN_AGENT = { getNavState: () => JSON.stringify(navState) };

  return {
    start() {
      return JSON.parse(runInThisContext(START_RECORDING_JS) as string);
    },
    stop() {
      return JSON.parse(runInThisContext(STOP_RECORDING_JS) as string)
        .events as RecordedEventLike[];
    },
    commit(route: string) {
      navState = { routeName: route, nested: null };
      hook.onCommitFiberRoot(1, rootContainer);
    },
    press(props: Props) {
      (props.onPress as (e: unknown) => void)({});
    },
    mountLater(testID: string) {
      // Mounted after start — flows through the patched Object.freeze.
      return createElement('Pressable', { testID, onPress: () => {} }).props;
    },
    dispose() {
      g.__REACT_DEVTOOLS_GLOBAL_HOOK__ = prevHook;
      g.__RN_AGENT = prevAgent;
      Object.freeze = prevFreeze;
    },
  };
}

function names(events: RecordedEventLike[]): string[] {
  return events.map((e) =>
    e.type === 'navigate' ? `navigate:${e.from}->${e.to}` : `${e.type}:${e.testID}`,
  );
}

function stepLines(yaml: string): string[] {
  return yaml
    .split('\n')
    .filter((l) => l.startsWith('- ') || l.trim().startsWith('id:'))
    .map((l) => l.trim());
}

test('B145: the tap that initiates a navigation is captured from the declared start route', () => {
  let appPresses = 0;
  const screen = makeScreen('HomeMain', [
    {
      testID: 'command-palette-btn',
      make: () => ({ testID: 'command-palette-btn', onPress: () => appPresses++ }),
    },
  ]);
  const host = makeHost(screen, 'HomeMain');
  try {
    const started = host.start();
    assert.equal(started.activeRoute, 'HomeMain');

    host.press(screen.live['command-palette-btn']);
    host.commit('CommandPalette');
    const close = host.mountLater('command-palette-close');
    host.press(close);
    host.commit('HomeMain');

    const events = host.stop();
    assert.deepEqual(names(events), [
      'tap:command-palette-btn',
      'navigate:HomeMain->CommandPalette',
      'tap:command-palette-close',
      'navigate:CommandPalette->HomeMain',
    ]);
    // The app's own handler must still run exactly once — wrapping must not
    // swallow or double-invoke it.
    assert.equal(appPresses, 1);
  } finally {
    host.dispose();
  }
});

test('B145: the saved flow replays open -> visible assertion -> close, with no duplicated tap', () => {
  const screen = makeScreen('HomeMain', [
    {
      testID: 'command-palette-btn',
      make: () => ({ testID: 'command-palette-btn', onPress: () => {} }),
    },
  ]);
  const host = makeHost(screen, 'HomeMain');
  let yaml: string;
  try {
    const started = host.start();
    host.press(screen.live['command-palette-btn']);
    host.commit('CommandPalette');
    host.press(host.mountLater('command-palette-close'));
    host.commit('HomeMain');
    yaml = generateMaestro(deduplicateEvents(host.stop() as never), {
      bundleId: 'com.rndevagent.testapp',
      startRoute: started.activeRoute,
      id: 'command-palette-open-close',
      intent: 'open and close the command palette',
    });
  } finally {
    host.dispose();
  }

  assert.deepEqual(stepLines(yaml), [
    '- launchApp',
    '- tapOn:',
    'id: command-palette-btn',
    '- assertVisible:',
    'id: command-palette-close',
    '- tapOn:',
    'id: command-palette-close',
  ]);
  // Order is stable and each control is tapped exactly once.
  assert.equal((yaml.match(/- tapOn:/g) ?? []).length, 2);
  assert.equal((yaml.match(/command-palette-btn/g) ?? []).length, 1);
  assert.ok(
    yaml.indexOf('command-palette-btn') < yaml.indexOf('- assertVisible:'),
    'the opening tap must precede the visibility assertion',
  );
});

test('B145 disconfirming: a navigation with no initiating tap synthesizes no tap', () => {
  const screen = makeScreen('Splash', []);
  const host = makeHost(screen, 'Splash');
  let events: RecordedEventLike[];
  try {
    host.start();
    // The app navigates on its own — nothing was tapped.
    host.commit('Login');
    const field = host.mountLater('username');
    host.press(field);
    events = host.stop();
  } finally {
    host.dispose();
  }

  assert.deepEqual(names(events), ['navigate:Splash->Login', 'tap:username']);
  const yaml = generateMaestro(deduplicateEvents(events as never), { startRoute: 'Splash' });
  assert.match(yaml, /# navigated: Splash -> Login/);
  assert.match(yaml, /- assertVisible:\n\s+id: username/);
  // No tap may be invented for the uncaused navigation.
  assert.equal((yaml.match(/- tapOn:/g) ?? []).length, 1);
});

test('B145 disconfirming: a delayed, unrelated navigation is not correlated to the tap', () => {
  const events = [
    { type: 'tap', testID: 'refresh-btn', t: 1000 },
    { type: 'navigate', from: 'Home', to: 'SessionExpired', t: 9000 },
    { type: 'tap', testID: 'sign-in-again', t: 9100 },
  ];
  const yaml = generateMaestro(events as never, { startRoute: 'Home' });
  // The tap stands alone: its own step, and the navigate is emitted by the
  // navigate branch rather than folded into the tap.
  assert.match(yaml, /- tapOn:\n\s+id: refresh-btn\n# navigated: Home -> SessionExpired/);
  assert.equal((yaml.match(/# navigated: Home -> SessionExpired/g) ?? []).length, 1);
  assert.equal((yaml.match(/- tapOn:/g) ?? []).length, 2);
});

test('B145 disconfirming: an ordinary non-navigation tap is unchanged', () => {
  let toggles = 0;
  const screen = makeScreen('SettingsScreen', [
    { testID: 'theme-toggle', make: () => ({ testID: 'theme-toggle', onPress: () => toggles++ }) },
  ]);
  const host = makeHost(screen, 'SettingsScreen');
  let events: RecordedEventLike[];
  try {
    host.start();
    host.press(screen.live['theme-toggle']);
    events = host.stop();
  } finally {
    host.dispose();
  }

  assert.deepEqual(names(events), ['tap:theme-toggle']);
  assert.equal(toggles, 1);
  const yaml = generateMaestro(deduplicateEvents(events as never), {
    startRoute: 'SettingsScreen',
  });
  assert.match(yaml, /- tapOn:\n\s+id: theme-toggle/);
  assert.doesNotMatch(yaml, /assertVisible/);
  assert.doesNotMatch(yaml, /# navigated:/);
});

test('B145: a screen full of controls is re-rendered once, not once per control', () => {
  const specs = Array.from({ length: 12 }, (_, i) => ({
    testID: `row-${i}`,
    make: () => ({ testID: `row-${i}`, onPress: () => {} }),
  }));
  const screen = makeScreen('TaskBoard', specs);
  const host = makeHost(screen, 'TaskBoard');
  try {
    host.start();
    assert.equal(screen.forcedRenders(), 1, 'the shared ancestor must be forced exactly once');
    host.press(screen.live['row-7']);
    assert.deepEqual(names(host.stop()), ['tap:row-7']);
  } finally {
    host.dispose();
  }
});

test('B145: every registered renderer uses its own adapter', () => {
  let appPresses = 0;
  const screen = makeScreen('HomeMain', [
    {
      testID: 'command-palette-btn',
      make: () => ({ testID: 'command-palette-btn', onPress: () => appPresses++ }),
    },
  ]);
  const rerender = screen.fiber.stateNode.forceUpdate as () => void;
  screen.fiber.stateNode = null;
  const logBox: Fiber = {
    type: { name: 'LogBox' },
    memoizedProps: {},
    stateNode: null,
    child: null,
    sibling: null,
    return: null,
  };
  const logBoxRoot = { current: { type: null, child: logBox, sibling: null } };
  const appRoot = { current: { type: null, child: screen.fiber, sibling: null } };
  logBox.return = logBoxRoot.current;
  screen.fiber.return = appRoot.current;
  let logBoxOverrides = 0;
  let appOverrides = 0;
  const hook: Fiber = {
    renderers: new Map([
      [1, { overrideProps: () => logBoxOverrides++ }],
      [
        7,
        {
          overrideProps: (fiber: Fiber) => {
            assert.equal(fiber, screen.fiber);
            appOverrides++;
            rerender();
          },
        },
      ],
    ]),
    onCommitFiberRoot: null,
    getFiberRoots: (id: number) => {
      if (id === 1) return new Set([logBoxRoot]);
      if (id === 7) return new Set([appRoot]);
      return new Set();
    },
  };
  const host = makeHost(screen, 'HomeMain', { hook, rootContainer: appRoot });
  try {
    host.start();
    assert.equal(logBoxOverrides, 0);
    assert.equal(appOverrides, 1);
    host.press(screen.live['command-palette-btn']);
    assert.deepEqual(names(host.stop()), ['tap:command-palette-btn']);
    assert.equal(appPresses, 1);
  } finally {
    host.dispose();
  }
});

test('B145: stale wrappers are refreshed for every recording session', () => {
  let appPresses = 0;
  const screen = makeScreen('HomeMain', [
    { testID: 'already', make: () => ({ testID: 'already', onPress: () => appPresses++ }) },
  ]);
  const host = makeHost(screen, 'HomeMain');
  try {
    host.start();
    assert.equal(screen.forcedRenders(), 1);
    host.press(screen.live['already']);
    assert.deepEqual(names(host.stop()), ['tap:already']);

    host.start();
    assert.equal(screen.forcedRenders(), 2);
    host.press(screen.live['already']);
    assert.deepEqual(names(host.stop()), ['tap:already']);
    assert.equal(appPresses, 2);
  } finally {
    host.dispose();
  }
});
