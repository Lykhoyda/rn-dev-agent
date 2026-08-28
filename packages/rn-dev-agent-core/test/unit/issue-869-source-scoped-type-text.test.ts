// Issue #869: on a real login screen (824 fibers) the flat 2000-unit typeText
// budget was spent before the selector was even matched, because the selector
// pass charged ~5 units per visited fiber and additionally scanned the whole
// forest for candidate handlers.
//
// Per the competitor analysis (Detox F-04/F-05: match the wrapper, then resolve
// the input inside the matched subtree), the selector pass now charges one unit
// per visited fiber and candidate discovery starts at the matched source. The
// budget, the truncation payload and the ambiguity contract are unchanged.
//
// setFieldValue's 200-unit ancestor budget is a SEPARATE defect and is
// deliberately not fixed here; the repro below pins it as a follow-up.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { INJECTED_HELPERS } from '../../dist/injected-helpers.js';
import { bindExactFillTarget } from '../../dist/tools/device-interact.js';

type Fiber = {
  tag: number;
  type: string | { displayName?: string; name?: string };
  memoizedProps: Record<string, unknown>;
  memoizedState?: unknown;
  child: Fiber | null;
  sibling: Fiber | null;
  return: Fiber | null;
  alternate?: Fiber | null;
};

function makeFiber(
  type: Fiber['type'],
  memoizedProps: Record<string, unknown> = {},
  memoizedState?: unknown,
): Fiber {
  return {
    tag: typeof type === 'string' ? 5 : 0,
    type,
    memoizedProps,
    memoizedState,
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

function countFibers(root: Fiber): number {
  let total = 0;
  const stack: (Fiber | null)[] = [root];
  while (stack.length > 0) {
    const fiber = stack.pop();
    if (!fiber) continue;
    total += 1;
    if (fiber.sibling) stack.push(fiber.sibling);
    if (fiber.child) stack.push(fiber.child);
  }
  return total;
}

function hookChain(count: number): unknown {
  let head: unknown = null;
  for (let index = count - 1; index >= 0; index -= 1) {
    head = { memoizedState: { hookIndex: index }, next: head };
  }
  return head;
}

function createAgent(rootOrRoots: Fiber | Fiber[]) {
  const roots = Array.isArray(rootOrRoots) ? rootOrRoots : [rootOrRoots];
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
  sandbox.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    renderers: new Map(roots.map((_, index) => [index + 1, {}])),
    getFiberRoots: (rendererId: number) => {
      const root = roots[rendererId - 1];
      return root ? new Set([{ current: root }]) : new Set();
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(INJECTED_HELPERS, sandbox);
  return {
    interact(opts: Record<string, unknown>): Record<string, unknown> {
      return JSON.parse(
        vm.runInContext(`__RN_AGENT.interact(${JSON.stringify(opts)})`, sandbox) as string,
      ) as Record<string, unknown>;
    },
    readInputValue(testID: string): Record<string, unknown> {
      return JSON.parse(
        vm.runInContext(`__RN_AGENT.readInputValue(${JSON.stringify(testID)})`, sandbox) as string,
      ) as Record<string, unknown>;
    },
  };
}

const REPORTED_FIBER_COUNT = 824;
const CONTROLLER_FIELD_FIBERS = 9;

function appendControllerField(parent: Fiber, testID: string, calls: string[]): Fiber {
  const outer = appendChild(
    parent,
    makeFiber({ displayName: 'TextField' }, { testID, control: {} }),
  );
  const box = appendChild(outer, makeFiber({ displayName: 'Box' }));
  const styled = appendChild(box, makeFiber({ displayName: 'CssInterop.View' }));
  const view = appendChild(styled, makeFiber('RCTView', {}));
  const inner = appendChild(
    view,
    makeFiber({ displayName: 'TextField' }, { name: 'email', value: '', onValueChange() {} }),
  );
  const innerStyled = appendChild(inner, makeFiber({ displayName: 'CssInterop.View' }));
  const innerView = appendChild(innerStyled, makeFiber('RCTView', {}));
  const pressable = appendChild(
    innerView,
    makeFiber({ displayName: 'Pressable' }, { testID: `${testID}-pressable`, accessible: true }),
  );
  appendChild(
    pressable,
    makeFiber('RCTSinglelineTextInputView', {
      testID,
      value: '',
      onChangeText(value: string) {
        calls.push(value);
      },
    }),
  );
  return outer;
}

function buildLoginSheet(totalFibers = REPORTED_FIBER_COUNT): { root: Fiber; calls: string[] } {
  const calls: string[] = [];
  const root = makeFiber('Root');
  const sheet = appendChild(root, makeFiber({ displayName: 'LoginSheet' }));
  let filler = sheet;
  let created = 2;
  while (created < totalFibers - CONTROLLER_FIELD_FIBERS) {
    filler = appendChild(filler, makeFiber({ displayName: 'CssInterop.View' }));
    created += 1;
  }
  appendControllerField(sheet, 'login_form_email', calls);
  return { root, calls };
}

test('issue-869: typeText reaches a Controller-wrapped field on an 824-fiber screen', () => {
  const { root, calls } = buildLoginSheet();
  assert.equal(countFibers(root), REPORTED_FIBER_COUNT);

  const result = createAgent(root).interact({
    action: 'typeText',
    testID: 'login_form_email',
    text: 'user@example.com',
  });

  assert.equal(result.truncated, undefined, JSON.stringify(result));
  assert.equal(result.success, true, JSON.stringify(result));
  assert.deepEqual(calls, ['user@example.com']);
});

// Detox's proven shape (F-05): the accessible wrapper itself is a valid target,
// because the input is resolved inside the matched subtree.
test('issue-869: typeText resolves the inner input from the -pressable wrapper testID', () => {
  const { root, calls } = buildLoginSheet();

  const result = createAgent(root).interact({
    action: 'typeText',
    testID: 'login_form_email-pressable',
    text: 'user@example.com',
  });

  assert.equal(result.truncated, undefined, JSON.stringify(result));
  assert.equal(result.success, true, JSON.stringify(result));
  assert.deepEqual(calls, ['user@example.com']);
});

// The selector pass now costs one unit per visited fiber, so reach scales with
// the budget instead of stopping at a fixed ~390-fiber ceiling.
test('issue-869: selector reach is one work unit per visited fiber', () => {
  for (const size of [411, 824, 1011]) {
    const { root, calls } = buildLoginSheet(size);
    const result = createAgent(root).interact({
      action: 'typeText',
      testID: 'login_form_email',
      text: 'x',
    });
    assert.equal(result.success, true, `size=${size} ${JSON.stringify(result)}`);
    assert.deepEqual(calls, ['x']);
  }
});

test('issue-869: the typeText read-back resolves on the same screen', () => {
  const { root } = buildLoginSheet();
  const agent = createAgent(root);

  agent.interact({ action: 'typeText', testID: 'login_form_email', text: 'user@example.com' });
  const read = agent.readInputValue('login_form_email');

  assert.equal(read.__agent_error, undefined, JSON.stringify(read));
  assert.equal(read.controlled, true, JSON.stringify(read));
});

test('issue-869: a large tree still binds typeText to the selector that owns the handler', () => {
  const emailCalls: string[] = [];
  const passwordCalls: string[] = [];
  const root = makeFiber('Root');
  const sheet = appendChild(root, makeFiber({ displayName: 'LoginSheet' }));
  let filler = sheet;
  for (let index = 0; index < 700; index += 1) {
    filler = appendChild(filler, makeFiber({ displayName: 'CssInterop.View' }));
  }
  appendControllerField(sheet, 'login_form_email', emailCalls);
  appendControllerField(sheet, 'login_form_password', passwordCalls);

  const result = createAgent(root).interact({
    action: 'typeText',
    testID: 'login_form_password',
    text: 'hunter2',
  });

  assert.equal(result.success, true, JSON.stringify(result));
  assert.deepEqual(emailCalls, []);
  assert.deepEqual(passwordCalls, ['hunter2']);
});

// The reach increase must not let an ambiguous selector through.
test('issue-869: a large tree never masks typeText ambiguity into a silent pick', () => {
  const calls: string[] = [];
  const root = makeFiber('Root');
  const sheet = appendChild(root, makeFiber({ displayName: 'LoginSheet' }));
  let filler = sheet;
  for (let index = 0; index < 700; index += 1) {
    filler = appendChild(filler, makeFiber({ displayName: 'CssInterop.View' }));
  }
  const shared = appendChild(sheet, makeFiber({ displayName: 'TextField' }, { testID: 'shared' }));
  appendChild(
    shared,
    makeFiber('RCTSinglelineTextInputView', {
      value: '',
      onChangeText(value: string) {
        calls.push(`first:${value}`);
      },
    }),
  );
  appendChild(
    shared,
    makeFiber('RCTSinglelineTextInputView', {
      value: '',
      onChangeText(value: string) {
        calls.push(`second:${value}`);
      },
    }),
  );

  const result = createAgent(root).interact({
    action: 'typeText',
    testID: 'shared',
    text: 'unsafe',
  });

  assert.equal(result.error, 'Ambiguous typeText resolution', JSON.stringify(result));
  assert.equal(result.count, 2);
  assert.deepEqual(calls, []);
});

// The truncation contract is unchanged: a subtree larger than the fixed budget
// still refuses truthfully without calling a handler.
test('issue-869: an oversized matched subtree still refuses truthfully', () => {
  const calls: string[] = [];
  const root = makeFiber('Root');
  const wrapper = appendChild(root, makeFiber({ displayName: 'View' }, { testID: 'huge' }));
  let cursor = wrapper;
  for (let index = 0; index < 4000; index += 1) {
    cursor = appendChild(cursor, makeFiber({ displayName: 'CssInterop.View' }));
  }
  appendChild(
    cursor,
    makeFiber('RCTSinglelineTextInputView', {
      onChangeText(value: string) {
        calls.push(value);
      },
    }),
  );

  const result = createAgent(root).interact({ action: 'typeText', testID: 'huge', text: 'unsafe' });

  assert.equal(result.truncated, true, JSON.stringify(result));
  assert.equal(result.reason, 'work-limit');
  assert.equal(result.workLimit, 2000, 'the fixed budget is unchanged');
  assert.equal(result.handlerCalled, false);
  assert.deepEqual(calls, []);
});

// DEFERRED (issue #869 follow-up): setFieldValue's ancestor budget is a
// separate defect with a separate direction of travel and is NOT fixed here.
// This pins the current behavior so the follow-up has a red starting point.
test('issue-869: setFieldValue still exhausts its 200-unit owner scan (deferred follow-up)', () => {
  const setValueCalls: unknown[] = [];
  const formReturn = {
    setValue: (...args: unknown[]) => setValueCalls.push(args),
    getValues: () => ({}),
    control: {},
  };
  const root = makeFiber('Root');
  const provider = appendChild(
    root,
    makeFiber({ displayName: 'FormProvider' }, { value: formReturn }),
  );
  let cursor = provider;
  // 12 ancestors carrying 20 hooks each — unremarkable for a real screen.
  for (let depth = 0; depth < 12; depth += 1) {
    cursor = appendChild(cursor, makeFiber({ displayName: `Layer${depth}` }, {}, hookChain(20)));
  }
  appendChild(
    cursor,
    makeFiber({ displayName: 'Button' }, { testID: 'login_submit', onPress() {} }),
  );

  const result = createAgent(root).interact({
    action: 'setFieldValue',
    testID: 'login_submit',
    name: 'email',
    value: 'user@example.com',
  });

  assert.equal(result.error, 'setFieldValue resolution truncated');
  assert.equal(result.truncated, true);
  assert.equal(result.reason, 'work-limit');
  assert.equal(result.workLimit, 200);
  assert.equal(result.work, 201);
  // It died 11 ancestors up, far short of the FormProvider: ancestor depth and
  // hook-list length are charged against one shared 200-unit budget.
  assert.ok((result.ancestorVisits as number) < 13, JSON.stringify(result));
  assert.deepEqual(setValueCalls, []);
});

// Leg 3 — device_fill. iOS merges an `accessible` wrapper's inner input into
// the wrapper, so the inner testID is absent from the accessibility snapshot.
const MERGED_WRAPPER_NODES = [
  {
    ref: '@e1',
    type: 'Other',
    identifier: 'login_form',
    rect: { x: 0, y: 0, width: 390, height: 400 },
  },
  {
    ref: '@e2',
    type: 'Other',
    identifier: 'login_form_email-pressable',
    label: 'Email',
    rect: { x: 16, y: 120, width: 358, height: 48 },
  },
  {
    ref: '@e3',
    type: 'Button',
    identifier: 'login_submit',
    label: 'Sign in',
    rect: { x: 16, y: 200, width: 358, height: 48 },
  },
];

test('issue-869: a merged iOS wrapper refuses with the supported typing route', () => {
  const out = bindExactFillTarget(MERGED_WRAPPER_NODES as never, 'login_form_email-pressable');

  assert.equal(out.ok, false);
  const detail = (out as { detail: string }).detail;
  assert.match(detail, /login_form_email/);
  assert.match(detail, /accessible/i);
  assert.match(detail, /typeText/);
  // It must not imply a rebind that no snapshot generation can satisfy.
  assert.doesNotMatch(detail, /in the current snapshot/);
});

test('issue-869: a wrapper whose inner input is exposed still binds natively', () => {
  const nodes = [
    ...MERGED_WRAPPER_NODES,
    {
      ref: '@e4',
      type: 'TextField',
      identifier: 'login_form_email',
      rect: { x: 20, y: 124, width: 350, height: 40 },
    },
  ];

  const out = bindExactFillTarget(nodes as never, 'login_form_email-pressable');

  assert.ok(out.ok, (out as { detail?: string }).detail);
  const binding = (out as { binding: { inputRef: string; focusRef: string; wrapper: boolean } })
    .binding;
  assert.equal(binding.inputRef, '@e4');
  assert.equal(binding.focusRef, '@e2');
  assert.equal(binding.wrapper, true);
});

test('issue-869: a wrapper whose base id is a non-input element keeps its own refusal', () => {
  const nodes = [
    ...MERGED_WRAPPER_NODES,
    {
      ref: '@e4',
      type: 'StaticText',
      identifier: 'login_form_email',
      rect: { x: 20, y: 124, width: 350, height: 40 },
    },
  ];

  const out = bindExactFillTarget(nodes as never, 'login_form_email-pressable');

  assert.equal(out.ok, false);
  const detail = (out as { detail: string }).detail;
  assert.match(detail, /StaticText/);
  assert.doesNotMatch(detail, /typeText/);
});

// --- #869 follow-up: nested-fiber semantic identity -------------------------
// RN 0.85 renders ONE <TextInput> as CssInterop.TextInput > TextInput >
// InternalTextInput > host, every level forwarding onChangeText: four dispatch
// points, one semantic input. Collapse only by the owned host text-input fiber;
// two real inputs own two hosts, so true ambiguity must survive untouched.

const RN_CHAIN = ['CssInterop.TextInput', 'TextInput', 'InternalTextInput'];

function appendRnTextInputChain(
  parent: Fiber,
  testID: string | undefined,
  calls: string[],
  label = 'host',
): Fiber {
  let cursor = parent;
  for (const displayName of RN_CHAIN) {
    cursor = appendChild(
      cursor,
      makeFiber(
        { displayName },
        {
          ...(testID ? { testID } : {}),
          value: '',
          onChangeText(value: string) {
            calls.push(`${displayName}:${value}`);
          },
        },
      ),
    );
  }
  return appendChild(
    cursor,
    makeFiber('RCTSinglelineTextInputView', {
      ...(testID ? { testID } : {}),
      value: '',
      onChangeText(value: string) {
        calls.push(`${label}:${value}`);
      },
    }),
  );
}

test('issue-869: one RN chain collapses to its host and dispatches once', () => {
  const calls: string[] = [];
  const root = makeFiber('Root');
  appendRnTextInputChain(appendChild(root, makeFiber({ displayName: 'Screen' })), 'fld', calls);

  const result = createAgent(root).interact({ action: 'typeText', testID: 'fld', text: 'x' });

  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.semanticInput, 1, JSON.stringify(result));
  assert.equal((result.collapsed as unknown[]).length, 3, JSON.stringify(result.collapsed));
  assert.deepEqual(calls, ['host:x'], 'exactly one dispatch, on the host');
});

test('issue-869: the collapsed chain still reads its value back', () => {
  const calls: string[] = [];
  const root = makeFiber('Root');
  appendRnTextInputChain(appendChild(root, makeFiber({ displayName: 'Screen' })), 'fld', calls);
  const agent = createAgent(root);

  agent.interact({ action: 'typeText', testID: 'fld', text: 'x' });
  const read = agent.readInputValue('fld');

  assert.equal(read.__agent_error, undefined, JSON.stringify(read));
  assert.equal(read.controlled, true, JSON.stringify(read));
});

test('issue-869: an accessible wrapper over one RN chain collapses too', () => {
  const calls: string[] = [];
  const root = makeFiber('Root');
  const pressable = appendChild(
    appendChild(root, makeFiber({ displayName: 'Screen' })),
    makeFiber({ displayName: 'Pressable' }, { testID: 'fld-pressable', accessible: true }),
  );
  appendRnTextInputChain(pressable, 'fld', calls);

  const result = createAgent(root).interact({
    action: 'typeText',
    testID: 'fld-pressable',
    text: 'x',
  });

  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.semanticInput, 1);
  assert.deepEqual(calls, ['host:x']);
});

test('issue-869: two real inputs sharing a testID stay ambiguous', () => {
  const calls: string[] = [];
  const root = makeFiber('Root');
  const screen = appendChild(root, makeFiber({ displayName: 'Screen' }));
  appendRnTextInputChain(screen, 'dup', calls, 'hostA');
  appendRnTextInputChain(screen, 'dup', calls, 'hostB');

  const result = createAgent(root).interact({ action: 'typeText', testID: 'dup', text: 'x' });

  assert.equal(result.error, 'Ambiguous typeText resolution', JSON.stringify(result));
  assert.equal(result.count, 2, 'one entry per semantic input, not per dispatch point');
  assert.deepEqual(calls, []);
});

test('issue-869: a wrapper holding two inner inputs stays ambiguous', () => {
  const calls: string[] = [];
  const root = makeFiber('Root');
  const pressable = appendChild(
    appendChild(root, makeFiber({ displayName: 'Screen' })),
    makeFiber({ displayName: 'Pressable' }, { testID: 'two-pressable', accessible: true }),
  );
  appendRnTextInputChain(pressable, undefined, calls, 'hostA');
  appendRnTextInputChain(pressable, undefined, calls, 'hostB');

  const result = createAgent(root).interact({
    action: 'typeText',
    testID: 'two-pressable',
    text: 'x',
  });

  assert.equal(result.error, 'Ambiguous typeText resolution', JSON.stringify(result));
  assert.equal(result.count, 2, JSON.stringify(result));
  assert.deepEqual(calls, []);
});

test('issue-869: a foreign host nested inside the chain blocks the collapse', () => {
  const calls: string[] = [];
  const root = makeFiber('Root');
  const outer = appendChild(
    appendChild(root, makeFiber({ displayName: 'Screen' })),
    makeFiber(
      { displayName: 'Composite' },
      {
        testID: 'fld',
        value: '',
        onChangeText(value: string) {
          calls.push(`composite:${value}`);
        },
      },
    ),
  );
  const own = appendChild(
    outer,
    makeFiber('RCTSinglelineTextInputView', {
      testID: 'fld',
      value: '',
      onChangeText(value: string) {
        calls.push(`own:${value}`);
      },
    }),
  );
  // an unrelated input nested below the first host — the composite's subtree
  // now holds two hosts, so it owns neither.
  appendChild(
    own,
    makeFiber('RCTSinglelineTextInputView', {
      value: '',
      onChangeText(value: string) {
        calls.push(`foreign:${value}`);
      },
    }),
  );

  const result = createAgent(root).interact({ action: 'typeText', testID: 'fld', text: 'x' });

  assert.equal(result.error, 'Ambiguous typeText resolution', JSON.stringify(result));
  assert.deepEqual(calls, []);
});

test('issue-869: truncation during the host descent keeps the unchanged payload', () => {
  const calls: string[] = [];
  const root = makeFiber('Root');
  const composite = appendChild(
    appendChild(root, makeFiber({ displayName: 'Screen' })),
    makeFiber(
      { displayName: 'Composite' },
      {
        testID: 'deep',
        value: '',
        onChangeText(value: string) {
          calls.push(value);
        },
      },
    ),
  );
  let cursor = composite;
  for (let index = 0; index < 4000; index += 1) {
    cursor = appendChild(cursor, makeFiber({ displayName: 'CssInterop.View' }));
  }
  appendRnTextInputChain(cursor, undefined, calls);

  const result = createAgent(root).interact({ action: 'typeText', testID: 'deep', text: 'x' });

  assert.equal(result.truncated, true, JSON.stringify(result));
  assert.equal(result.reason, 'work-limit');
  assert.equal(result.workLimit, 2000, 'the fixed budget is unchanged');
  assert.equal(result.handlerCalled, false);
  assert.deepEqual(calls, []);
});
