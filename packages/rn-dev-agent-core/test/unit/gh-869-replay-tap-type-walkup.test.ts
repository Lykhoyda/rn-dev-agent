import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

import { INJECTED_HELPERS } from '../../dist/injected-helpers.js';
import { runCdpReplayCommands, type CdpReplayDeps } from '../../dist/tools/cdp-replay-dispatch.js';
import { makeReplayDeps } from '../../dist/tools/cdp-replay-deps.js';
import { createMockClient } from '../helpers/mock-cdp-client.js';

interface Fiber {
  tag: number;
  type: string | { displayName?: string };
  memoizedProps: Record<string, unknown>;
  child: Fiber | null;
  sibling: Fiber | null;
  return: Fiber | null;
}

function makeFiber(type: Fiber['type'], memoizedProps: Record<string, unknown> = {}): Fiber {
  return {
    tag: typeof type === 'string' ? 5 : 0,
    type,
    memoizedProps,
    child: null,
    sibling: null,
    return: null,
  };
}

function appendChild(parent: Fiber, child: Fiber): Fiber {
  child.return = parent;
  if (!parent.child) {
    parent.child = child;
    return child;
  }
  let tail = parent.child;
  while (tail.sibling) tail = tail.sibling;
  tail.sibling = child;
  return child;
}

function createAgent(root: Fiber) {
  const sandbox: Record<string, unknown> = {
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
  sandbox.__expo_router_state__ = { index: 0, routes: [{ name: 'Home' }] };
  sandbox.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    renderers: new Map([[1, {}]]),
    getFiberRoots: (id: number) => (id === 1 ? new Set([{ current: root }]) : new Set()),
  };
  vm.createContext(sandbox);
  vm.runInContext(INJECTED_HELPERS, sandbox);
  return {
    evaluate: async (expression: string): Promise<{ value?: unknown; error?: unknown }> => {
      try {
        return { value: vm.runInContext(expression, sandbox) };
      } catch (error) {
        return { error };
      }
    },
  };
}

function buildDeps(agent: ReturnType<typeof createAgent>): CdpReplayDeps {
  const client = createMockClient({
    evaluate: (expr: string) => agent.evaluate(expr),
    probeHelperFreshness: async () => ({ fresh: true, version: 0, probed: true }),
  }) as never;
  const deps = makeReplayDeps({
    getActiveSession: () => ({
      name: 'gh-869-test',
      platform: 'ios',
      deviceId: 'test-device',
      appId: 'dev.rn.agent.fixture',
      openedAt: '2026-08-30T00:00:00.000Z',
    }),
    getClient: () => client,
    resolveIosUdid: async () => 'test-device',
    execute: async () => undefined,
  });
  assert.ok(deps);
  return deps;
}

function otpFixture() {
  const calls = { focus: 0, typed: [] as string[] };
  const root = makeFiber('Root');
  const app = appendChild(root, makeFiber({ displayName: 'App' }));
  const pressable = appendChild(
    app,
    makeFiber(
      { displayName: 'Pressable' },
      {
        testID: 'otp_email-pressable',
        onPress: () => {
          calls.focus += 1;
        },
      },
    ),
  );
  const pressableHost = appendChild(pressable, makeFiber('RCTView'));
  const inputComposite = appendChild(
    pressableHost,
    makeFiber({ displayName: 'TextInput' }, { testID: 'otp_email' }),
  );
  const inputHost = appendChild(
    inputComposite,
    makeFiber('RCTSinglelineTextInputView', { testID: 'otp_email', value: '' }),
  );
  inputHost.memoizedProps.onChangeText = (value: string): void => {
    calls.typed.push(value);
    inputHost.memoizedProps.value = value;
  };
  return { root, app, pressable, inputComposite, calls, inputHost };
}

test('#869 replay taps the Pressable-wrapped input by its exact testID, then types on that same input', async () => {
  const fixture = otpFixture();
  const deps = buildDeps(createAgent(fixture.root));

  const result = await runCdpReplayCommands(
    [{ tapOn: { id: 'otp_email' } }, { inputText: '0451' }],
    {},
    deps,
  );

  assert.equal(result.passed, true, JSON.stringify(result));
  assert.deepEqual(
    result.steps.map((s) => ({ t: s.t, target: s.target, ok: s.ok })),
    [
      { t: 'tap', target: 'otp_email', ok: true },
      { t: 'type', target: 'otp_email', ok: true },
    ],
  );
  assert.equal(fixture.calls.focus, 1, 'the wrapper onPress must fire exactly once');
  assert.deepEqual(fixture.calls.typed, ['0451']);
  assert.equal(
    fixture.inputHost.memoizedProps.value,
    '0451',
    'the type step must land on the exact matched input fiber',
  );
});

test('#869 control: a directly pressable testID still presses without walking', async () => {
  let fired = 0;
  const root = makeFiber('Root');
  appendChild(
    root,
    makeFiber(
      { displayName: 'Pressable' },
      {
        testID: 'login_submit',
        onPress: () => {
          fired += 1;
        },
      },
    ),
  );
  const deps = buildDeps(createAgent(root));

  const result = await runCdpReplayCommands([{ tapOn: { id: 'login_submit' } }], {}, deps);

  assert.equal(result.passed, true, JSON.stringify(result));
  assert.equal(fired, 1);
});

test('#869 control: an input with no actionable ancestor still refuses the tap', async () => {
  const root = makeFiber('Root');
  const view = appendChild(root, makeFiber({ displayName: 'View' }));
  const input = appendChild(
    view,
    makeFiber({ displayName: 'TextInput' }, { testID: 'orphan_input', value: '' }),
  );
  const typed: string[] = [];
  input.memoizedProps.onChangeText = (value: string) => typed.push(value);
  const deps = buildDeps(createAgent(root));

  const result = await runCdpReplayCommands(
    [{ tapOn: { id: 'orphan_input' } }, { inputText: 'x' }],
    {},
    deps,
  );

  assert.equal(result.passed, false);
  assert.equal(result.failedStepIndex, 0);
  assert.match(result.reason ?? '', /no onPress handler/);
  assert.deepEqual(typed, [], 'the type step must never run after a refused tap');
});

test('#869 control: a non-editable input refuses from the projected tree', async () => {
  const fixture = otpFixture();
  fixture.inputComposite.memoizedProps.editable = false;
  fixture.inputHost.memoizedProps.editable = false;
  const deps = buildDeps(createAgent(fixture.root));

  const result = await runCdpReplayCommands(
    [{ tapOn: { id: 'otp_email' } }, { inputText: '0451' }],
    {},
    deps,
  );

  assert.equal(result.passed, false);
  assert.equal(result.failureCode, 'INTERACTION_NOT_ACTUATED');
  assert.match(result.reason ?? '', /disabled/);
  assert.equal(fixture.calls.focus, 0, 'the walk-up press must never fire on a disabled target');
  assert.deepEqual(fixture.calls.typed, []);
});

test('#869 control: a disabled nearest pressable refuses without walking farther', async (t) => {
  for (const [label, disabledProps] of [
    ['disabled prop', { disabled: true }],
    ['accessibility state', { accessibilityState: { disabled: true } }],
  ] as const) {
    await t.test(label, async () => {
      const fixture = otpFixture();
      let outerPresses = 0;
      const outerPressable = makeFiber(
        { displayName: 'Pressable' },
        {
          onPress: () => {
            outerPresses += 1;
          },
        },
      );
      fixture.app.child = outerPressable;
      outerPressable.return = fixture.app;
      outerPressable.child = fixture.pressable;
      fixture.pressable.return = outerPressable;
      Object.assign(fixture.pressable.memoizedProps, disabledProps);
      const deps = buildDeps(createAgent(fixture.root));

      const result = await runCdpReplayCommands(
        [{ tapOn: { id: 'otp_email' } }, { inputText: '0451' }],
        {},
        deps,
      );

      assert.equal(result.passed, false);
      assert.equal(result.failureCode, 'INTERACTION_NOT_ACTUATED');
      assert.match(result.reason ?? '', /disabled/);
      assert.equal(fixture.calls.focus, 0);
      assert.equal(outerPresses, 0);
      assert.deepEqual(fixture.calls.typed, []);
    });
  }
});

test('#869 control: an input behind an active modal subtree refuses the tap', async () => {
  const fixture = otpFixture();
  const sheetBranch = appendChild(fixture.app, makeFiber({ displayName: 'View' }));
  const modal = appendChild(
    sheetBranch,
    makeFiber({ displayName: 'View' }, { accessibilityViewIsModal: true }),
  );
  appendChild(modal, makeFiber({ displayName: 'Text' }, { children: 'blocking sheet' }));
  const deps = buildDeps(createAgent(fixture.root));

  const result = await runCdpReplayCommands(
    [{ tapOn: { id: 'otp_email' } }, { inputText: '0451' }],
    {},
    deps,
  );

  assert.equal(result.passed, false);
  assert.match(result.reason ?? '', /behind the active modal/);
  assert.equal(fixture.calls.focus, 0);
  assert.deepEqual(fixture.calls.typed, []);
});

test('#869 control: duplicate testIDs across distinct inputs refuse before any press', async () => {
  const calls = { first: 0, second: 0 };
  const root = makeFiber('Root');
  const app = appendChild(root, makeFiber({ displayName: 'App' }));
  for (const key of ['first', 'second'] as const) {
    const pressable = appendChild(
      app,
      makeFiber(
        { displayName: 'Pressable' },
        {
          onPress: () => {
            calls[key] += 1;
          },
        },
      ),
    );
    appendChild(
      pressable,
      makeFiber({ displayName: 'TextInput' }, { testID: 'dup_input', value: '' }),
    );
  }
  const deps = buildDeps(createAgent(root));

  const result = await runCdpReplayCommands([{ tapOn: { id: 'dup_input' } }], {}, deps);

  assert.equal(result.passed, false);
  assert.equal(result.failureCode, 'AMBIGUOUS_TESTID');
  assert.equal(calls.first, 0);
  assert.equal(calls.second, 0);
});

test('#869 control: a type step without a preceding exact tap target refuses', async () => {
  const deps = buildDeps(createAgent(makeFiber('Root')));

  const result = await runCdpReplayCommands([{ inputText: '0451' }], {}, deps);

  assert.equal(result.passed, false);
  assert.match(result.reason ?? '', /inputText before any tapOn/);
});
