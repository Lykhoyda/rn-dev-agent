// GH #869: replay could not tap AND type a testID-bearing TextInput nested
// under a Pressable — the press producer in src/index.ts never enabled the
// bounded GH #525 walkUp, while `inputText` re-resolves the last-tapped id.
// These tests execute the ACTUAL press-args literal extracted from
// src/index.ts through the real injected helper and replay engine, so the
// regression flips with the production call shape; the controls prove the
// dispatch gates (disabled, occlusion, duplicates, no-focus type) hold.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

import { INJECTED_HELPERS } from '../../dist/injected-helpers.js';
import { ReplayDispatchError } from '../../dist/domain/cdp-flow-replay.js';
import { runCdpReplayCommands, type CdpReplayDeps } from '../../dist/tools/cdp-replay-dispatch.js';
import { createInteractHandler } from '../../dist/tools/interact.js';
import { performReactTreeInput } from '../../dist/tools/device-interact.js';
import { createMockClient } from '../helpers/mock-cdp-client.js';

const indexSource = readFileSync(new URL('../../src/index.ts', import.meta.url), 'utf8');
assert.equal(
  indexSource.match(/pressByTestId:/g)?.length,
  1,
  'expected exactly one pressByTestId producer in src/index.ts',
);
const producerBody = indexSource.match(/pressByTestId:([^]*?)typeByTestId:/)?.[1];
assert.ok(producerBody, 'pressByTestId producer body not found in src/index.ts');
const pressCalls = [...producerBody.matchAll(/interact\((\{[^)]*\})\)/g)];
assert.equal(pressCalls.length, 1, 'expected exactly one interact() call in pressByTestId');
const productionPressArgs = new Function('id', `return (${pressCalls[0]![1]});`) as (
  id: string,
) => Record<string, unknown>;
const extractedShape = productionPressArgs('probe');
assert.equal(extractedShape.action, 'press', 'extracted args are not the replay press call');
assert.equal(extractedShape.testID, 'probe', 'extracted args must pass the tap id through');

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

function mustOk(res: { content: Array<{ text: string }> }, what: string): void {
  const env = JSON.parse(res.content[0]!.text) as {
    ok?: boolean;
    code?: string;
    error?: string;
    meta?: Record<string, unknown>;
  };
  if (env.ok === false)
    throw new ReplayDispatchError(
      env.code ?? 'INTERACTION_NOT_ACTUATED',
      `${what} failed: ${env.error ?? 'ok:false'}`,
      env.meta,
    );
}

function buildDeps(
  agent: ReturnType<typeof createAgent>,
  overrides: Partial<CdpReplayDeps> = {},
): CdpReplayDeps {
  const client = createMockClient({
    evaluate: (expr: string) => agent.evaluate(expr),
    // The VM runs the real helpers, whose version differs from the mock's
    // pinned probe value — report fresh so withConnection skips re-injection.
    probeHelperFreshness: async () => ({ fresh: true, version: 0, probed: true }),
  }) as never;
  const interact = createInteractHandler(() => client);
  return {
    pressByTestId: async (id) =>
      mustOk(await interact(productionPressArgs(id) as never), `press "${id}"`),
    typeByTestId: async (id, text) =>
      mustOk(await performReactTreeInput(id, text, client), `type "${id}"`),
    treeFor: async (id) => ({ testID: id, children: [] }),
    frontmostFor: async (id) => {
      const result = await agent.evaluate(`__RN_AGENT.isTestIdFrontmost(${JSON.stringify(id)})`);
      return JSON.parse(result.value as string) as {
        visible: boolean;
        reason?: string;
        matchCount?: number;
        code?: string;
      };
    },
    launchApp: async () => {},
    settle: async () => {},
    ...overrides,
  };
}

// Pressable[otp_email-pressable, onPress:focus] > RCTView >
// TextInput[otp_email] > RCTSinglelineTextInputView[otp_email] — the exact
// issue #869 fixture shape (repo OTP fixture / react-hook-form TextField).
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
  // Wrapper composite carries the testID; only the host input is typeable —
  // the fiber shape issue #840 established from real wrapped TextFields.
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
  return { root, app, calls, inputHost };
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

test('#869 control: a disabled input refuses before the press helper runs', async () => {
  const fixture = otpFixture();
  const deps = buildDeps(createAgent(fixture.root), {
    treeFor: async (id) => ({ testID: id, disabled: true }),
  });

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

test('#869 control: an input behind an active modal subtree refuses the tap', async () => {
  const fixture = otpFixture();
  // The modal marker sits one level below the sibling branch so the target is
  // refused by modal containment, not by the sibling aria-modal hidden rule.
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
