import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { INJECTED_HELPERS } from '../../dist/injected-helpers.js';

interface Fiber {
  type: unknown;
  memoizedProps: Record<string, unknown>;
  stateNode?: unknown;
  child: Fiber | null;
  sibling: Fiber | null;
  return: Fiber | null;
  alternate?: Fiber | null;
}

function fiber(type: unknown, memoizedProps: Record<string, unknown> = {}): Fiber {
  return { type, memoizedProps, child: null, sibling: null, return: null };
}

function append(parent: Fiber, ...children: Fiber[]) {
  parent.child = children[0] ?? null;
  children.forEach((child, index) => {
    child.return = parent;
    child.sibling = children[index + 1] ?? null;
  });
}

function install(root: Fiber) {
  const sandbox: Record<string, unknown> = {
    Array,
    Object,
    JSON,
    Map,
    WeakMap,
    WeakSet,
    Set,
    Error,
    Date,
    RegExp,
    Symbol,
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
    renderers: new Map([[1, {}]]),
    getFiberRoots: (rendererId: number) =>
      rendererId === 1 ? new Set([{ current: root }]) : new Set(),
  };
  vm.createContext(sandbox);
  vm.runInContext(INJECTED_HELPERS, sandbox);
  return sandbox;
}

async function fill(sandbox: Record<string, unknown>, testID: string, text: string) {
  const units = Array.from(text, (_, index) => text.charCodeAt(index));
  return (await vm.runInContext(
    `__RN_AGENT.fillControlledInput(${JSON.stringify(testID)},${JSON.stringify(units)})`,
    sandbox,
  )) as Record<string, unknown>;
}

function controlledInput(
  testID: string,
  focused: { value: boolean },
  onChange: (text: string) => void,
  initialValue = '',
) {
  const input = fiber({ displayName: 'TextInput' });
  let focusCalls = 0;
  input.memoizedProps = { testID, value: initialValue, onChangeText: onChange };
  input.stateNode = {
    isFocused: () => focused.value,
    focus: () => {
      focusCalls += 1;
      focused.value = true;
    },
  };
  return { input, focusCalls: () => focusCalls };
}

function uncontrolledInput(testID: string) {
  const input = fiber({ displayName: 'TextInput' }, { testID });
  input.stateNode = { isFocused: () => false, focus() {} };
  return input;
}

test('real controlled owner clears to empty with one dispatch', async () => {
  const root = fiber({ displayName: 'Root' });
  const focused = { value: true };
  let dispatches = 0;
  const target = controlledInput(
    'field',
    focused,
    (text) => {
      dispatches += 1;
      target.input.memoizedProps = { ...target.input.memoizedProps, value: text };
    },
    'existing',
  );
  append(root, target.input);

  const result = await fill(install(root), 'field', '');
  assert.deepEqual({ ...result }, { kind: 'success', focusedBefore: true });
  assert.equal(dispatches, 1);
  assert.equal(target.input.memoizedProps.value, '');
});

test('real controlled wrapper focuses the unique inner input and dispatches once', async () => {
  const root = fiber({ displayName: 'Root' });
  const wrapper = fiber({ displayName: 'Pressable' }, { testID: 'field-pressable' });
  const wrongFocus = { value: true };
  const targetFocus = { value: false };
  let dispatches = 0;
  const target = controlledInput('field', targetFocus, (text) => {
    dispatches += 1;
    wrongFocus.value = false;
    target.input.memoizedProps = { ...target.input.memoizedProps, value: text };
  });
  append(wrapper, target.input);
  append(root, wrapper);

  const result = await fill(install(root), 'field-pressable', 'canary');
  assert.deepEqual({ ...result }, { kind: 'success', focusedBefore: false });
  assert.equal(dispatches, 1);
  assert.equal(target.focusCalls(), 1);
  assert.equal(wrongFocus.value, false);
});

test('real already-focused owner skips focus and still dispatches once', async () => {
  const root = fiber({ displayName: 'Root' });
  const focused = { value: true };
  let dispatches = 0;
  const target = controlledInput('field', focused, (text) => {
    dispatches += 1;
    target.input.memoizedProps = { ...target.input.memoizedProps, value: text };
  });
  append(root, target.input);

  const result = await fill(install(root), 'field', 'canary');
  assert.deepEqual({ ...result }, { kind: 'success', focusedBefore: true });
  assert.equal(target.focusCalls(), 0);
  assert.equal(dispatches, 1);
});

test('real focus-time replacement refuses before onChangeText dispatch', async () => {
  const root = fiber({ displayName: 'Root' });
  const focused = { value: false };
  let dispatches = 0;
  const target = controlledInput('lost-on-focus', focused, () => {
    dispatches += 1;
  });
  target.input.stateNode = {
    isFocused: () => focused.value,
    focus: () => {
      focused.value = true;
      const replacement = fiber(
        { displayName: 'TextInput' },
        { testID: 'replacement-after-focus', value: '', onChangeText() {} },
      );
      replacement.stateNode = { isFocused: () => true, focus() {} };
      append(root, replacement);
    },
  };
  append(root, target.input);

  const result = await fill(install(root), 'lost-on-focus', 'canary');
  assert.equal(result.kind, 'failure');
  assert.equal(result.reason, 'target-lost');
  assert.equal(result.mutation, 'none');
  assert.equal(dispatches, 0);
});

test('real transformed controlled value fails observed after one dispatch', async () => {
  const root = fiber({ displayName: 'Root' });
  const focused = { value: true };
  let dispatches = 0;
  const target = controlledInput('field', focused, (text) => {
    dispatches += 1;
    target.input.memoizedProps = { ...target.input.memoizedProps, value: text.toUpperCase() };
  });
  append(root, target.input);

  const result = await fill(install(root), 'field', 'canary');
  assert.equal(result.kind, 'failure');
  assert.equal(result.reason, 'mismatch');
  assert.equal(result.mutation, 'observed');
  assert.equal(dispatches, 1);
  assert.doesNotMatch(JSON.stringify(result), /canary|CANARY/);
});

test('real duplicate controlled inputs refuse before either handler runs', async () => {
  const root = fiber({ displayName: 'Root' });
  const focused = { value: true };
  let dispatches = 0;
  const first = controlledInput('field', focused, () => {
    dispatches += 1;
  });
  const second = controlledInput('field', focused, () => {
    dispatches += 1;
  });
  append(root, first.input, second.input);

  const result = await fill(install(root), 'field', 'canary');
  assert.equal(result.kind, 'failure');
  assert.equal(result.reason, 'ambiguous');
  assert.equal(result.mutation, 'none');
  assert.equal(dispatches, 0);
});

test('wrapper ownership stays inside its subtree without a naming convention', async () => {
  const root = fiber({ displayName: 'Root' });
  const wrapper = fiber({ displayName: 'Pressable' }, { testID: 'profile-field-shell' });
  const unrelatedFocus = { value: true };
  const targetFocus = { value: false };
  let unrelatedDispatches = 0;
  let targetDispatches = 0;
  const unrelated = controlledInput('profile-field-shell-input', unrelatedFocus, () => {
    unrelatedDispatches += 1;
  });
  const target = controlledInput('inner-with-independent-id', targetFocus, (text) => {
    targetDispatches += 1;
    target.input.memoizedProps = { ...target.input.memoizedProps, value: text };
  });
  append(wrapper, target.input);
  append(root, wrapper, unrelated.input);

  const result = await fill(install(root), 'profile-field-shell', 'canary');
  assert.deepEqual({ ...result }, { kind: 'success', focusedBefore: false });
  assert.equal(targetDispatches, 1);
  assert.equal(unrelatedDispatches, 0);
});

test('wrapper with controlled and uncontrolled descendants refuses as ambiguous', async () => {
  const root = fiber({ displayName: 'Root' });
  const wrapper = fiber({ displayName: 'Pressable' }, { testID: 'field-shell' });
  const focused = { value: true };
  let dispatches = 0;
  const controlled = controlledInput('controlled-field', focused, () => {
    dispatches += 1;
  });
  append(wrapper, controlled.input, uncontrolledInput('uncontrolled-field'));
  append(root, wrapper);

  const result = await fill(install(root), 'field-shell', 'canary');
  assert.equal(result.kind, 'failure');
  assert.equal(result.reason, 'ambiguous');
  assert.equal(result.mutation, 'none');
  assert.equal(dispatches, 0);
});

test('siblings sharing one callback remain ambiguous owners', async () => {
  const root = fiber({ displayName: 'Root' });
  const focused = { value: true };
  let dispatches = 0;
  const shared = () => {
    dispatches += 1;
  };
  const first = controlledInput('field', focused, shared);
  const second = controlledInput('field', focused, shared);
  append(root, first.input, second.input);

  const result = await fill(install(root), 'field', 'canary');
  assert.equal(result.kind, 'failure');
  assert.equal(result.reason, 'ambiguous');
  assert.equal(result.mutation, 'none');
  assert.equal(dispatches, 0);
});

test('lineal composite and host representations remain one owner', async () => {
  const root = fiber({ displayName: 'Root' });
  const focused = { value: true };
  let dispatches = 0;
  const composite = fiber({ displayName: 'TextInput' });
  const host = fiber('RCTSinglelineTextInputView');
  const onChangeText = (text: string) => {
    dispatches += 1;
    composite.memoizedProps = { ...composite.memoizedProps, value: text };
    host.memoizedProps = { ...host.memoizedProps, value: text };
  };
  composite.memoizedProps = { testID: 'field', value: '', onChangeText };
  host.memoizedProps = { testID: 'field', value: '', onChangeText };
  host.stateNode = { isFocused: () => focused.value, focus() {} };
  append(composite, host);
  append(root, composite);

  const result = await fill(install(root), 'field', 'canary');
  assert.deepEqual({ ...result }, { kind: 'success', focusedBefore: true });
  assert.equal(dispatches, 1);
});
