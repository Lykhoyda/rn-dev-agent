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

function createAgent(root: Fiber, beforeEvaluate?: (expression: string) => void) {
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
        beforeEvaluate?.(expression);
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

test('#869 replay designates the Pressable-wrapped input by its exact testID, then types on that same input', async () => {
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
  assert.equal(result.steps[0].focusOnly, true);
  assert.equal(fixture.calls.focus, 0, 'the wrapper onPress must never fire for an input target');
  assert.deepEqual(fixture.calls.typed, ['0451']);
  assert.equal(
    fixture.inputHost.memoizedProps.value,
    '0451',
    'the type step must land on the exact matched input fiber',
  );
  assert.equal(result.finalFocusId, null);
});

test('#869 replay walks up to the nearest pressable for a non-input exact-ID target', async () => {
  let wrapperPresses = 0;
  const root = makeFiber('Root');
  const app = appendChild(root, makeFiber({ displayName: 'App' }));
  const pressable = appendChild(
    app,
    makeFiber(
      { displayName: 'Pressable' },
      {
        onPress: () => {
          wrapperPresses += 1;
        },
      },
    ),
  );
  const pressableHost = appendChild(pressable, makeFiber('RCTView'));
  appendChild(pressableHost, makeFiber({ displayName: 'Text' }, { testID: 'submit_label' }));
  const deps = buildDeps(createAgent(root));

  const result = await runCdpReplayCommands([{ tapOn: { id: 'submit_label' } }], {}, deps);

  assert.equal(result.passed, true, JSON.stringify(result));
  assert.equal(wrapperPresses, 1);
  assert.notEqual(result.steps[0].focusOnly, true);
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

test('#869 control: a non-input target with no actionable ancestor still refuses the tap', async () => {
  const root = makeFiber('Root');
  const view = appendChild(root, makeFiber({ displayName: 'View' }));
  appendChild(view, makeFiber({ displayName: 'Text' }, { testID: 'orphan_label' }));
  const deps = buildDeps(createAgent(root));

  const result = await runCdpReplayCommands([{ tapOn: { id: 'orphan_label' } }], {}, deps);

  assert.equal(result.passed, false);
  assert.equal(result.failedStepIndex, 0);
  assert.match(result.reason ?? '', /no onPress handler/);
});

test('#869 control: a bare TextInput with no actionable ancestor is still designated, not pressed', async () => {
  const fixture = otpFixture();
  delete fixture.pressable.memoizedProps.onPress;
  const deps = buildDeps(createAgent(fixture.root));

  const result = await runCdpReplayCommands(
    [{ tapOn: { id: 'otp_email' } }, { inputText: '0451' }],
    {},
    deps,
  );

  assert.equal(result.passed, true, JSON.stringify(result));
  assert.equal(result.steps[0].focusOnly, true);
  assert.equal(result.steps[1].target, 'otp_email');
  assert.equal(result.finalFocusId, null);
  assert.equal(fixture.calls.focus, 0);
  assert.deepEqual(fixture.calls.typed, ['0451']);
  assert.equal(fixture.inputHost.memoizedProps.value, '0451');
});

test('#869 control: a non-editable input refuses from the projected tree', async () => {
  const fixture = otpFixture();
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

  const typeResult = await runCdpReplayCommands([{ inputText: '0451' }], {}, deps, {
    initialFocusId: 'otp_email',
  });

  assert.equal(typeResult.passed, false);
  assert.equal(typeResult.failureCode, 'INTERACTION_NOT_ACTUATED');
  assert.match(typeResult.reason ?? '', /disabled/);
  assert.deepEqual(fixture.calls.typed, []);
});

test('#869 control: an accessibility-disabled input refuses tap and type', async () => {
  const fixture = otpFixture();
  fixture.inputHost.memoizedProps.accessibilityState = { disabled: true };
  const deps = buildDeps(createAgent(fixture.root));

  const tapResult = await runCdpReplayCommands(
    [{ tapOn: { id: 'otp_email' } }, { inputText: '0451' }],
    {},
    deps,
  );

  assert.equal(tapResult.passed, false);
  assert.equal(tapResult.failureCode, 'INTERACTION_NOT_ACTUATED');
  assert.match(tapResult.reason ?? '', /disabled/);
  assert.equal(fixture.calls.focus, 0);
  assert.deepEqual(fixture.calls.typed, []);

  const typeResult = await runCdpReplayCommands([{ inputText: '0451' }], {}, deps, {
    initialFocusId: 'otp_email',
  });

  assert.equal(typeResult.passed, false);
  assert.equal(typeResult.failureCode, 'INTERACTION_NOT_ACTUATED');
  assert.match(typeResult.reason ?? '', /disabled/);
  assert.equal(fixture.calls.focus, 0);
  assert.deepEqual(fixture.calls.typed, []);
});

test('#869 control: the live gate rechecks a host input disabled after tree proof', async () => {
  const fixture = otpFixture();
  let disabledBeforeInteract = false;
  const agent = createAgent(fixture.root, (expression) => {
    if (!disabledBeforeInteract && expression.startsWith('__RN_AGENT.interact(')) {
      fixture.inputHost.memoizedProps.editable = false;
      disabledBeforeInteract = true;
    }
  });
  const deps = buildDeps(agent);

  const result = await runCdpReplayCommands(
    [{ tapOn: { id: 'otp_email' } }, { inputText: '0451' }],
    {},
    deps,
  );

  assert.equal(disabledBeforeInteract, true);
  assert.equal(result.passed, false);
  assert.equal(result.failureCode, 'INTERACTION_NOT_ACTUATED');
  assert.match(result.reason ?? '', /disabled/);
  assert.equal(fixture.calls.focus, 0);
  assert.deepEqual(fixture.calls.typed, []);
});

test('#869 control: type rechecks a newly disabled selected host candidate', async () => {
  const fixture = otpFixture();
  delete fixture.inputHost.memoizedProps.testID;
  let interactCalls = 0;
  const agent = createAgent(fixture.root, (expression) => {
    if (expression.startsWith('__RN_AGENT.interact(')) {
      interactCalls += 1;
      if (interactCalls === 2) fixture.inputHost.memoizedProps.editable = false;
    }
  });
  const deps = buildDeps(agent);

  const result = await runCdpReplayCommands(
    [{ tapOn: { id: 'otp_email' } }, { inputText: '0451' }],
    {},
    deps,
  );

  assert.equal(interactCalls, 2);
  assert.equal(result.passed, false);
  assert.equal(result.failedStepIndex, 1);
  assert.equal(result.failureCode, 'INTERACTION_NOT_ACTUATED');
  assert.match(result.reason ?? '', /disabled/);
  assert.equal(fixture.calls.focus, 1);
  assert.deepEqual(fixture.calls.typed, []);
});

test('#869 control: exact-ID lineage pointer and hidden state refuse tap and type', async (t) => {
  const cases: Array<{
    label: string;
    apply: (fixture: ReturnType<typeof otpFixture>) => void;
    reason: RegExp;
  }> = [
    {
      label: 'host target box-none',
      apply: (fixture) => {
        fixture.inputHost.memoizedProps.pointerEvents = 'box-none';
      },
      reason: /pointerEvents/,
    },
    {
      label: 'host beneath box-only composite',
      apply: (fixture) => {
        fixture.inputComposite.memoizedProps.pointerEvents = 'box-only';
      },
      reason: /pointerEvents/,
    },
    {
      label: 'hidden host',
      apply: (fixture) => {
        fixture.inputHost.memoizedProps.style = { display: 'none' };
      },
      reason: /hidden/,
    },
  ];

  for (const testCase of cases) {
    await t.test(testCase.label, async () => {
      const fixture = otpFixture();
      testCase.apply(fixture);
      const deps = buildDeps(createAgent(fixture.root));

      const tapResult = await runCdpReplayCommands(
        [{ tapOn: { id: 'otp_email' } }, { inputText: '0451' }],
        {},
        deps,
      );
      const typeResult = await runCdpReplayCommands([{ inputText: '0451' }], {}, deps, {
        initialFocusId: 'otp_email',
      });

      assert.equal(tapResult.passed, false);
      assert.equal(tapResult.failureCode, 'INTERACTION_NOT_ACTUATED');
      assert.match(tapResult.reason ?? '', testCase.reason);
      assert.equal(typeResult.passed, false);
      assert.equal(typeResult.failureCode, 'INTERACTION_NOT_ACTUATED');
      assert.match(typeResult.reason ?? '', testCase.reason);
      assert.equal(fixture.calls.focus, 0);
      assert.deepEqual(fixture.calls.typed, []);
    });
  }
});

test('#869 projection: interactive fallback marks a non-editable host input disabled', async () => {
  const fixture = otpFixture();
  fixture.inputHost.memoizedProps.editable = false;
  const result = await createAgent(fixture.root).evaluate(
    '__RN_AGENT.getTree({"interactiveOnly":true})',
  );
  assert.equal(result.error, undefined);
  const data = JSON.parse(result.value as string) as {
    interactive: Array<{ testID?: string; disabled?: boolean }>;
  };
  const inputs = data.interactive.filter((entry) => entry.testID === 'otp_email');
  assert.equal(
    inputs.some((entry) => entry.disabled === true),
    true,
  );
});

test('#869 control: a disabled nearest pressable refuses without walking farther', async (t) => {
  for (const [label, disabledProps] of [
    ['disabled prop', { disabled: true }],
    ['accessibility state', { accessibilityState: { disabled: true } }],
  ] as const) {
    await t.test(label, async () => {
      let outerPresses = 0;
      const root = makeFiber('Root');
      const app = appendChild(root, makeFiber({ displayName: 'App' }));
      const outerPressable = appendChild(
        app,
        makeFiber(
          { displayName: 'Pressable' },
          {
            onPress: () => {
              outerPresses += 1;
            },
          },
        ),
      );
      let innerPresses = 0;
      const innerPressable = appendChild(
        outerPressable,
        makeFiber(
          { displayName: 'Pressable' },
          {
            ...disabledProps,
            onPress: () => {
              innerPresses += 1;
            },
          },
        ),
      );
      const innerHost = appendChild(innerPressable, makeFiber('RCTView'));
      appendChild(innerHost, makeFiber({ displayName: 'Text' }, { testID: 'submit_label' }));
      const deps = buildDeps(createAgent(root));

      const result = await runCdpReplayCommands([{ tapOn: { id: 'submit_label' } }], {}, deps);

      assert.equal(result.passed, false);
      assert.equal(result.failureCode, 'INTERACTION_NOT_ACTUATED');
      assert.match(result.reason ?? '', /disabled/);
      assert.equal(innerPresses, 0);
      assert.equal(outerPresses, 0, 'the walk must not skip past a disabled nearest pressable');
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
