import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { INJECTED_HELPERS } from '../../dist/injected-helpers.js';
import { createInteractHandler } from '../../dist/tools/interact.js';
import { attemptJsFill, releaseJsFillBinding } from '../../dist/tools/fill-verify.js';
import { createMockClient } from '../helpers/mock-cdp-client.js';
import { expectOk } from '../helpers/result-helpers.js';

type Fiber = {
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
  return { type, memoizedProps, memoizedState, child: null, sibling: null, return: null };
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

function wrap(parent: Fiber, count: number): Fiber {
  let current = parent;
  for (let index = 0; index < count; index += 1) {
    current = appendChild(current, makeFiber({ displayName: `CssInterop.View${index}` }));
  }
  return current;
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
    evaluate: async (expression: string): Promise<{ value?: unknown; error?: unknown }> => {
      try {
        return { value: vm.runInContext(expression, sandbox) };
      } catch (error) {
        return { error };
      }
    },
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
    readInputValueByBinding(bindingId: string): Record<string, unknown> {
      return JSON.parse(
        vm.runInContext(
          `__RN_AGENT.readInputValueByBinding(${JSON.stringify(bindingId)})`,
          sandbox,
        ) as string,
      ) as Record<string, unknown>;
    },
  };
}

function runInteract(
  rootOrRoots: Fiber | Fiber[],
  opts: Record<string, unknown>,
): Record<string, unknown> {
  return createAgent(rootOrRoots).interact(opts);
}

test('typeText keeps the proven shallow wrapped-field path typeable', () => {
  const calls: string[] = [];
  const root = makeFiber('Root');
  const wrapper = appendChild(root, makeFiber({ displayName: 'TextField' }, { testID: 'email' }));
  const leaf = appendChild(
    wrap(wrapper, 6),
    makeFiber('AndroidTextInput', {
      testID: 'email',
      value: '',
      onChangeText(value: string) {
        calls.push(value);
      },
    }),
  );

  const result = runInteract(root, { action: 'typeText', testID: 'email', text: 'hello' });

  assert.equal(result.success, true);
  assert.deepEqual(calls, ['hello']);
  assert.equal(leaf.memoizedProps.value, '');
});

test('typeText searches every same-testID match and selects the sole typeable target', () => {
  const calls: string[] = [];
  const root = makeFiber('Root');
  appendChild(root, makeFiber({ displayName: 'View' }, { testID: 'shared' }));
  appendChild(
    root,
    makeFiber('AndroidTextInput', {
      testID: 'shared',
      onChangeText(value: string) {
        calls.push(value);
      },
    }),
  );

  const result = runInteract(root, { action: 'typeText', testID: 'shared', text: 'chosen' });

  assert.equal(result.success, true);
  assert.deepEqual(calls, ['chosen']);
});

test('typeText readback resolves the same deep controlled target as mutation', () => {
  const root = makeFiber('Root');
  appendChild(root, makeFiber('View', { testID: 'shared-readback' }));
  const wrapper = appendChild(root, makeFiber('View', { testID: 'shared-readback' }));
  const input = appendChild(
    wrap(wrapper, 28),
    makeFiber('AndroidTextInput', {
      testID: 'shared-readback',
      value: '',
      onChangeText(value: string) {
        input.memoizedProps.value = value;
      },
    }),
  );
  const agent = createAgent(root);

  const mutation = agent.interact({
    action: 'typeText',
    testID: 'shared-readback',
    text: 'verified',
    verify: true,
  });
  const readback = agent.readInputValue('shared-readback');

  assert.equal(mutation.success, true, JSON.stringify(mutation));
  assert.deepEqual(readback, { value: 'verified', controlled: true });
});

test('typeText searches matching fibers across every registered renderer', () => {
  const calls: string[] = [];
  const inertRoot = makeFiber('Root');
  appendChild(inertRoot, makeFiber('View', { testID: 'cross-renderer' }));
  const typeableRoot = makeFiber('Root');
  appendChild(
    typeableRoot,
    makeFiber('AndroidTextInput', {
      testID: 'cross-renderer',
      onChangeText(value: string) {
        calls.push(value);
      },
    }),
  );

  const result = runInteract([inertRoot, typeableRoot], {
    action: 'typeText',
    testID: 'cross-renderer',
    text: 'second-renderer',
  });

  assert.equal(result.success, true);
  assert.deepEqual(calls, ['second-renderer']);
});

test('typeText reaches a NativeWind-style input beyond sixteen wrapper layers', () => {
  const calls: string[] = [];
  const root = makeFiber('Root');
  const wrapper = appendChild(root, makeFiber({ displayName: 'TextField' }, { testID: 'deep' }));
  appendChild(
    wrap(wrapper, 28),
    makeFiber(
      { displayName: 'CssInterop.TextInput' },
      {
        testID: 'deep',
        onChangeText(value: string) {
          calls.push(value);
        },
      },
    ),
  );

  const result = runInteract(root, { action: 'typeText', testID: 'deep', text: 'landed' });

  assert.equal(result.success, true);
  assert.deepEqual(calls, ['landed']);
  assert.ok((result.visitedFibers as number) > 16);
});

test('typeText reaches the number input inside a phone-style compound field', () => {
  const typed: string[] = [];
  const root = makeFiber('Root');
  const phone = appendChild(root, makeFiber({ displayName: 'PhoneField' }, { testID: 'phone' }));
  appendChild(phone, makeFiber({ displayName: 'CountrySelect' }, { onPress() {} }));
  appendChild(
    wrap(phone, 20),
    makeFiber('AndroidTextInput', {
      testID: 'phone',
      onChangeText(value: string) {
        typed.push(value);
      },
    }),
  );

  const result = runInteract(root, { action: 'typeText', testID: 'phone', text: '15112345678' });

  assert.equal(result.success, true);
  assert.deepEqual(typed, ['15112345678']);
});

test('typeText supports placeholder and role+name selectors', () => {
  const calls: string[] = [];
  const root = makeFiber('Root');
  appendChild(
    root,
    makeFiber('AndroidTextInput', {
      placeholder: 'Search policies',
      onChangeText(value: string) {
        calls.push(`placeholder:${value}`);
      },
    }),
  );
  appendChild(
    root,
    makeFiber('AndroidTextInput', {
      accessibilityRole: 'textbox',
      accessibilityLabel: 'Phone number',
      onChangeText(value: string) {
        calls.push(`role:${value}`);
      },
    }),
  );

  const byPlaceholder = runInteract(root, {
    action: 'typeText',
    placeholder: 'Search policies',
    text: 'home',
    exact: true,
  });
  const byRole = runInteract(root, {
    action: 'typeText',
    role: 'textbox',
    name: 'Phone number',
    text: '1234',
    exact: true,
  });

  assert.equal(byPlaceholder.success, true, JSON.stringify(byPlaceholder));
  assert.equal(byRole.success, true, JSON.stringify(byRole));
  assert.deepEqual(calls, ['placeholder:home', 'role:1234']);
});

test('typeText binds selector evidence to the source that owns the selected handler', () => {
  const calls: string[] = [];
  const root = makeFiber('Root');
  appendChild(
    root,
    makeFiber('AndroidTextInput', {
      testID: 'inert-search',
      placeholder: 'Search policies',
    }),
  );
  appendChild(
    root,
    makeFiber('AndroidTextInput', {
      testID: 'active-search',
      placeholder: 'Search policies',
      onChangeText(value: string) {
        calls.push(value);
      },
    }),
  );

  const result = runInteract(root, {
    action: 'typeText',
    placeholder: 'Search policies',
    text: 'home',
    exact: true,
  });

  assert.equal(result.success, true, JSON.stringify(result));
  assert.deepEqual(calls, ['home']);
  assert.deepEqual(result.selectorBundle, {
    testID: 'active-search',
    role: 'none',
    placeholder: 'Search policies',
  });
});

test('typeText refuses mixed onChangeText and onChange logical targets', () => {
  const calls: string[] = [];
  const root = makeFiber('Root');
  appendChild(
    root,
    makeFiber('AndroidTextInput', {
      testID: 'mixed-handlers',
      onChangeText(value: string) {
        calls.push(`text:${value}`);
      },
    }),
  );
  appendChild(
    root,
    makeFiber('AndroidTextInput', {
      testID: 'mixed-handlers',
      onChange(event: { nativeEvent: { text: string } }) {
        calls.push(`event:${event.nativeEvent.text}`);
      },
    }),
  );

  const result = runInteract(root, {
    action: 'typeText',
    testID: 'mixed-handlers',
    text: 'unsafe',
  });

  assert.match(String(result.error), /Ambiguous typeText resolution/);
  assert.deepEqual(calls, []);
});

test('typeText refuses mixed component-name candidates without preferring a host input', () => {
  const calls: string[] = [];
  const root = makeFiber('Root');
  appendChild(
    root,
    makeFiber(
      { displayName: 'FormControl' },
      {
        testID: 'mixed-components',
        onChangeText(value: string) {
          calls.push(`custom:${value}`);
        },
      },
    ),
  );
  appendChild(
    root,
    makeFiber('AndroidTextInput', {
      testID: 'mixed-components',
      onChangeText(value: string) {
        calls.push(`native:${value}`);
      },
    }),
  );

  const result = runInteract(root, {
    action: 'typeText',
    testID: 'mixed-components',
    text: 'unsafe',
  });

  assert.equal(result.error, 'Ambiguous typeText resolution');
  assert.equal(result.count, 2);
  assert.deepEqual(calls, []);
});

test('typeText keeps shared functions with different handler contracts ambiguous', () => {
  const calls: unknown[] = [];
  const shared = (value: unknown) => calls.push(value);
  const root = makeFiber('Root');
  const wrapper = appendChild(
    root,
    makeFiber(
      { displayName: 'TextField' },
      {
        testID: 'cross-contract',
        onChangeText: shared,
      },
    ),
  );
  appendChild(wrapper, makeFiber('AndroidTextInput', { onChange: shared }));

  const result = runInteract(root, {
    action: 'typeText',
    testID: 'cross-contract',
    text: 'unsafe',
  });

  assert.equal(result.error, 'Ambiguous typeText resolution');
  assert.equal(result.handler, 'mixed');
  assert.deepEqual(
    (result.candidates as Array<{ contract: string }>).map((candidate) => candidate.contract),
    ['onChangeText:string', 'onChange:event'],
  );
  assert.deepEqual(calls, []);
});

test('typeText binds nested selector evidence to the nearest matching source', () => {
  const calls: string[] = [];
  const root = makeFiber('Root');
  const outer = appendChild(
    root,
    makeFiber('AndroidTextInput', {
      testID: 'outer-evidence',
      placeholder: 'Shared placeholder',
    }),
  );
  appendChild(
    outer,
    makeFiber('AndroidTextInput', {
      testID: 'inner-exact',
      placeholder: 'Shared placeholder',
      value: '',
      onChangeText(value: string) {
        calls.push(value);
      },
    }),
  );

  const result = runInteract(root, {
    action: 'typeText',
    placeholder: 'Shared placeholder',
    text: 'bound',
    exact: true,
  });

  assert.equal(result.success, true, JSON.stringify(result));
  assert.deepEqual(result.selectorBundle, {
    testID: 'inner-exact',
    role: 'none',
    placeholder: 'Shared placeholder',
  });
  assert.deepEqual(calls, ['bound']);
});

test('typeText refuses nested matching sources when both exact fibers own handlers', () => {
  const calls: string[] = [];
  const root = makeFiber('Root');
  const outer = appendChild(
    root,
    makeFiber('AndroidTextInput', {
      placeholder: 'Shared placeholder',
      onChangeText(value: string) {
        calls.push(`outer:${value}`);
      },
    }),
  );
  appendChild(
    outer,
    makeFiber('AndroidTextInput', {
      placeholder: 'Shared placeholder',
      onChangeText(value: string) {
        calls.push(`inner:${value}`);
      },
    }),
  );

  const result = runInteract(root, {
    action: 'typeText',
    placeholder: 'Shared placeholder',
    text: 'unsafe',
    exact: true,
  });

  assert.equal(result.error, 'Ambiguous typeText resolution');
  assert.equal(result.count, 2);
  assert.deepEqual(calls, []);
});

test('JS fill readback stays bound when the selector becomes ambiguous after mutation', async () => {
  const root = makeFiber('Root');
  const input = appendChild(
    root,
    makeFiber('AndroidTextInput', {
      testID: 'changing-targets',
      value: '',
      onChangeText(value: string) {
        input.memoizedProps.value = value;
        appendChild(
          root,
          makeFiber('AndroidTextInput', {
            testID: 'changing-targets',
            value: 'replacement',
            onChangeText() {},
          }),
        );
      },
    }),
  );
  const agent = createAgent(root);
  const expressions: string[] = [];
  const deps = {
    evaluate: async (expression: string) => {
      expressions.push(expression);
      return agent.evaluate(expression);
    },
    sleep: async () => {},
  };

  const result = await attemptJsFill(deps, 'changing-targets', 'exact-target');

  assert.equal(result.handled, true);
  assert.equal(result.outcome, 'exact');
  assert.equal(typeof result.bindingId, 'string');
  assert.ok(expressions.some((expression) => expression.includes('readInputValueByBinding')));
  assert.ok(!expressions.some((expression) => expression.startsWith('__RN_AGENT.readInputValue(')));
  await releaseJsFillBinding(deps, result.bindingId);
  assert.match(
    String(agent.readInputValueByBinding(result.bindingId as string).__agent_error),
    /binding target lost/,
  );
});

test('typeText refuses cyclic hidden-state sibling traversal', () => {
  const calls: string[] = [];
  const root = makeFiber('Root');
  const input = appendChild(
    root,
    makeFiber('AndroidTextInput', {
      placeholder: 'Cyclic search',
      onChangeText(value: string) {
        calls.push(value);
      },
    }),
  );
  const sibling = appendChild(root, makeFiber('View'));
  sibling.sibling = sibling;

  const result = runInteract(root, {
    action: 'typeText',
    placeholder: 'Cyclic search',
    text: 'unsafe',
    exact: true,
  });

  assert.equal(result.truncated, true);
  assert.equal(result.reason, 'cycle');
  assert.deepEqual(calls, []);
  assert.equal(input.memoizedProps.placeholder, 'Cyclic search');
});

test('typeText charges hidden-state ancestor traversal to the shared work limit', () => {
  const calls: string[] = [];
  const root = makeFiber('Root');
  let current = root;
  for (let index = 0; index < 1100; index += 1) {
    current = appendChild(current, makeFiber('View'));
  }
  appendChild(
    current,
    makeFiber('AndroidTextInput', {
      placeholder: 'Bounded search',
      onChangeText(value: string) {
        calls.push(value);
      },
    }),
  );

  const result = runInteract(root, {
    action: 'typeText',
    placeholder: 'Bounded search',
    text: 'unsafe',
    exact: true,
  });

  assert.equal(result.truncated, true);
  assert.equal(result.reason, 'work-limit');
  assert.equal(result.workLimit, 2000);
  assert.deepEqual(calls, []);
});

test('typeText refuses a cyclic accessible-name subtree within the shared budget', () => {
  const calls: string[] = [];
  const root = makeFiber('Root');
  const input = appendChild(
    root,
    makeFiber('AndroidTextInput', {
      accessibilityRole: 'textbox',
      onChangeText(value: string) {
        calls.push(value);
      },
    }),
  );
  const cyclicName = appendChild(input, makeFiber('View'));
  cyclicName.child = cyclicName;

  const result = runInteract(root, {
    action: 'typeText',
    role: 'textbox',
    name: 'Never resolved',
    text: 'unsafe',
  });

  assert.equal(result.truncated, true);
  assert.equal(result.reason, 'cycle');
  assert.deepEqual(calls, []);
});

test('typeText charges labelled-by accessible-name scans to the shared work limit', () => {
  const calls: string[] = [];
  const root = makeFiber('Root');
  appendChild(
    root,
    makeFiber('AndroidTextInput', {
      accessibilityRole: 'textbox',
      accessibilityLabelledBy: 'bounded-label',
      onChangeText(value: string) {
        calls.push(value);
      },
    }),
  );
  let current = appendChild(root, makeFiber('View'));
  for (let index = 0; index < 1100; index += 1) {
    current = appendChild(current, makeFiber('View'));
  }
  const label = appendChild(current, makeFiber('View', { nativeID: 'bounded-label' }));
  const labelText = appendChild(label, makeFiber('Text'));
  labelText.memoizedProps = 'Bounded field' as unknown as Record<string, unknown>;

  const result = runInteract(root, {
    action: 'typeText',
    role: 'textbox',
    name: 'Bounded field',
    text: 'unsafe',
    exact: true,
  });

  assert.equal(result.truncated, true);
  assert.equal(result.reason, 'work-limit');
  assert.equal(result.workLimit, 2000);
  assert.deepEqual(calls, []);
});

test('typeText refuses a role selector without an accessible name', () => {
  const calls: string[] = [];
  const root = makeFiber('Root');
  appendChild(
    root,
    makeFiber('AndroidTextInput', {
      accessibilityRole: 'textbox',
      onChangeText(value: string) {
        calls.push(value);
      },
    }),
  );

  const result = runInteract(root, { action: 'typeText', role: 'textbox', text: 'unsafe' });

  assert.match(String(result.error), /role\+name/);
  assert.deepEqual(calls, []);
});

test('the public interact handler forwards placeholder and role+name typing selectors', async () => {
  const expressions: string[] = [];
  const client = createMockClient({
    evaluate: async (expression: string) => {
      expressions.push(expression);
      return { value: JSON.stringify({ success: true, action: 'typeText' }) };
    },
  });
  const handler = createInteractHandler(() => client);

  expectOk(
    await handler({
      action: 'typeText',
      placeholder: 'Search policies',
      text: 'home',
      animated: false,
    }),
  );
  expectOk(
    await handler({
      action: 'typeText',
      role: 'textbox',
      name: 'Phone number',
      text: '1234',
      animated: false,
    }),
  );

  const interactExpressions = expressions.filter((expression) =>
    expression.startsWith('__RN_AGENT.interact('),
  );
  assert.equal(interactExpressions.length, 2);
  assert.match(interactExpressions[0], /"placeholder":"Search policies"/);
  assert.match(interactExpressions[1], /"role":"textbox"/);
  assert.match(interactExpressions[1], /"name":"Phone number"/);
});

test('typeText refuses when distinct typeable same-testID fields remain ambiguous', () => {
  const calls: string[] = [];
  const root = makeFiber('Root');
  for (const suffix of ['first', 'second']) {
    appendChild(
      root,
      makeFiber('AndroidTextInput', {
        testID: 'duplicate',
        onChangeText(value: string) {
          calls.push(`${suffix}:${value}`);
        },
      }),
    );
  }

  const result = runInteract(root, { action: 'typeText', testID: 'duplicate', text: 'unsafe' });

  assert.match(String(result.error), /Ambiguous typeText resolution/);
  assert.deepEqual(calls, []);
});

test('typeText does not collapse distinct sibling fields that share one handler', () => {
  const calls: string[] = [];
  const sharedHandler = (value: string) => calls.push(value);
  const root = makeFiber('Root');
  appendChild(
    root,
    makeFiber('AndroidTextInput', { testID: 'duplicate', onChangeText: sharedHandler }),
  );
  appendChild(
    root,
    makeFiber('AndroidTextInput', { testID: 'duplicate', onChangeText: sharedHandler }),
  );

  const result = runInteract(root, { action: 'typeText', testID: 'duplicate', text: 'unsafe' });

  assert.match(String(result.error), /Ambiguous typeText resolution/);
  assert.deepEqual(calls, []);
});

test('typeText preserves distinct wrapper and host handlers as ambiguous', () => {
  const calls: string[] = [];
  const root = makeFiber('Root');
  const wrapper = appendChild(
    root,
    makeFiber(
      { displayName: 'TextField' },
      { testID: 'compound', onChangeText: (value: string) => calls.push(`outer:${value}`) },
    ),
  );
  appendChild(
    wrapper,
    makeFiber('AndroidTextInput', {
      onChangeText: (value: string) => calls.push(`inner:${value}`),
    }),
  );

  const result = runInteract(root, { action: 'typeText', testID: 'compound', text: 'unsafe' });

  assert.match(String(result.error), /Ambiguous typeText resolution/);
  assert.deepEqual(calls, []);
});

test('typeText refuses on a cyclic subtree without firing a partial candidate', () => {
  const calls: string[] = [];
  const root = makeFiber('Root');
  const wrapper = appendChild(root, makeFiber('View', { testID: 'cyclic' }));
  const first = appendChild(wrapper, makeFiber('View'));
  const input = appendChild(
    first,
    makeFiber('AndroidTextInput', {
      onChangeText(value: string) {
        calls.push(value);
      },
    }),
  );
  input.sibling = first;

  const result = runInteract(root, { action: 'typeText', testID: 'cyclic', text: 'unsafe' });

  assert.equal(result.truncated, true);
  assert.equal(result.reason, 'cycle');
  assert.deepEqual(calls, []);
});

test('typeText charges ownership return cycles to the shared resolution context', () => {
  const calls: string[] = [];
  const root = makeFiber('Root');
  const wrapper = appendChild(root, makeFiber('View', { testID: 'return-cycle' }));
  const input = appendChild(
    wrapper,
    makeFiber('AndroidTextInput', {
      onChangeText(value: string) {
        calls.push(value);
      },
    }),
  );
  input.return = input;

  const result = runInteract(root, {
    action: 'typeText',
    testID: 'return-cycle',
    text: 'unsafe',
  });

  assert.equal(result.truncated, true);
  assert.equal(result.reason, 'cycle');
  assert.deepEqual(calls, []);
});

test('typeText reports cycle truncation before accessibility-label ambiguity', () => {
  const calls: string[] = [];
  const root = makeFiber('Root');
  const wrapper = appendChild(root, makeFiber('View', { accessibilityLabel: 'Cyclic field' }));
  const first = appendChild(
    wrapper,
    makeFiber('AndroidTextInput', {
      onChangeText: (value: string) => calls.push(`first:${value}`),
    }),
  );
  const second = appendChild(
    wrapper,
    makeFiber('AndroidTextInput', {
      onChangeText: (value: string) => calls.push(`second:${value}`),
    }),
  );
  second.sibling = first;

  const result = runInteract(root, {
    action: 'typeText',
    accessibilityLabel: 'Cyclic field',
    text: 'unsafe',
  });

  assert.equal(result.truncated, true);
  assert.equal(result.reason, 'cycle');
  assert.deepEqual(calls, []);
});

test('typeText refuses when its documented total-work limit is exhausted', () => {
  const calls: string[] = [];
  const root = makeFiber('Root');
  const wrapper = appendChild(root, makeFiber('View', { testID: 'huge' }));
  appendChild(
    wrap(wrapper, 2200),
    makeFiber('AndroidTextInput', {
      onChangeText(value: string) {
        calls.push(value);
      },
    }),
  );

  const result = runInteract(root, { action: 'typeText', testID: 'huge', text: 'unsafe' });

  assert.equal(result.truncated, true);
  assert.equal(result.reason, 'work-limit', JSON.stringify(result));
  assert.equal(result.workLimit, 2000);
  assert.deepEqual(calls, []);
});

test('typeText shares one work limit across selector and candidate discovery', () => {
  const calls: string[] = [];
  const root = makeFiber('Root');
  let current = root;
  for (let index = 0; index < 1500; index += 1) {
    current = appendChild(current, makeFiber('View'));
  }
  const wrapper = appendChild(current, makeFiber('View', { testID: 'combined-budget' }));
  appendChild(
    wrap(wrapper, 700),
    makeFiber('AndroidTextInput', {
      onChangeText(value: string) {
        calls.push(value);
      },
    }),
  );

  const result = runInteract(root, {
    action: 'typeText',
    testID: 'combined-budget',
    text: 'unsafe',
  });

  assert.equal(result.truncated, true);
  assert.equal(result.reason, 'work-limit');
  assert.equal(result.workLimit, 2000);
  assert.deepEqual(calls, []);
});

test('typeText refuses truthfully when no matching self or descendant owns a handler', () => {
  const root = makeFiber('Root');
  const wrapper = appendChild(root, makeFiber('View', { testID: 'inert' }));
  wrap(wrapper, 25);

  const result = runInteract(root, { action: 'typeText', testID: 'inert', text: 'unused' });

  assert.match(String(result.error), /no onChangeText or onChange handler/);
  assert.equal(result.handlerCalled, false);
});

test('setFieldValue uses the useForm return whose control matches an explicit control prop', () => {
  const calls: Array<{ name: string; value: unknown; options: unknown }> = [];
  const control = {};
  const formReturn = {
    control,
    getValues(name: string) {
      return name === 'phone' ? '' : undefined;
    },
    setValue(name: string, value: unknown, options: unknown) {
      calls.push({ name, value, options });
    },
  };
  const root = makeFiber('Root');
  const formOwner = appendChild(
    root,
    makeFiber(
      { displayName: 'RegistrationForm' },
      {},
      { memoizedState: { current: formReturn }, next: null },
    ),
  );
  const controller = appendChild(
    formOwner,
    makeFiber({ displayName: 'Controller' }, { control, name: 'phone' }),
  );
  appendChild(controller, makeFiber('View', { testID: 'phone-field' }));

  const result = runInteract(root, {
    action: 'setFieldValue',
    testID: 'phone-field',
    name: 'phone',
    value: 15112345678,
  });

  assert.equal(result.success, true);
  assert.equal(result.resolvedFrom, 'control-prop-hook');
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    {
      name: 'phone',
      value: '15112345678',
      options: { shouldValidate: true, shouldDirty: true },
    },
  ]);
});

test('setFieldValue refuses an unrelated useForm hook without calling setValue', () => {
  const calls: string[] = [];
  const explicitControl = {};
  const unrelatedFormReturn = {
    control: {},
    getValues() {
      return '';
    },
    setValue() {
      calls.push('called');
    },
  };
  const root = makeFiber('Root');
  const formOwner = appendChild(
    root,
    makeFiber(
      { displayName: 'RegistrationForm' },
      {},
      { memoizedState: { current: unrelatedFormReturn }, next: null },
    ),
  );
  const controller = appendChild(
    formOwner,
    makeFiber({ displayName: 'Controller' }, { control: explicitControl, name: 'phone' }),
  );
  appendChild(controller, makeFiber('View', { testID: 'phone-field' }));

  const result = runInteract(root, {
    action: 'setFieldValue',
    testID: 'phone-field',
    name: 'phone',
    value: '1234',
  });

  assert.match(String(result.error), /no FormProvider ancestor or matching useForm control/);
  assert.deepEqual(calls, []);
});

test('setFieldValue does not skip the nearest explicit control for an outer form', () => {
  const calls: string[] = [];
  const outerControl = {};
  const nearestControl = {};
  const outerFormReturn = {
    control: outerControl,
    getValues() {
      return '';
    },
    setValue() {
      calls.push('outer');
    },
  };
  const root = makeFiber('Root');
  const owner = appendChild(
    root,
    makeFiber(
      { displayName: 'OuterForm' },
      {},
      { memoizedState: { current: outerFormReturn }, next: null },
    ),
  );
  const outerController = appendChild(
    owner,
    makeFiber({ displayName: 'Controller' }, { control: outerControl, name: 'outer' }),
  );
  const nearestController = appendChild(
    outerController,
    makeFiber({ displayName: 'Controller' }, { control: nearestControl, name: 'phone' }),
  );
  appendChild(nearestController, makeFiber('View', { testID: 'nested-phone' }));

  const result = runInteract(root, {
    action: 'setFieldValue',
    testID: 'nested-phone',
    name: 'phone',
    value: '1234',
  });

  assert.match(String(result.error), /no FormProvider ancestor or matching useForm control/);
  assert.deepEqual(calls, []);
});

test('setFieldValue ignores a mismatched outer provider for the nearest controlled form', () => {
  const calls: string[] = [];
  const outerControl = {};
  const nearestControl = {};
  const outerFormReturn = {
    control: outerControl,
    getValues() {
      return '';
    },
    setValue() {
      calls.push('outer');
    },
  };
  const nearestFormReturn = {
    control: nearestControl,
    getValues() {
      return '';
    },
    setValue() {
      calls.push('nearest');
    },
  };
  const root = makeFiber('Root');
  const provider = appendChild(
    root,
    makeFiber({ displayName: 'FormProvider' }, { value: outerFormReturn }),
  );
  const owner = appendChild(
    provider,
    makeFiber(
      { displayName: 'InnerForm' },
      {},
      { memoizedState: { current: nearestFormReturn }, next: null },
    ),
  );
  const controller = appendChild(
    owner,
    makeFiber({ displayName: 'Controller' }, { control: nearestControl, name: 'phone' }),
  );
  appendChild(controller, makeFiber('View', { testID: 'provider-nested-phone' }));

  const result = runInteract(root, {
    action: 'setFieldValue',
    testID: 'provider-nested-phone',
    name: 'phone',
    value: '1234',
  });

  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.resolvedFrom, 'control-prop-hook');
  assert.deepEqual(calls, ['nearest']);
});

test('press keeps its existing first strict-testID match semantics', () => {
  const calls: string[] = [];
  const root = makeFiber('Root');
  appendChild(root, makeFiber('Button', { testID: 'same', onPress: () => calls.push('first') }));
  appendChild(root, makeFiber('Button', { testID: 'same', onPress: () => calls.push('second') }));

  const result = runInteract(root, { action: 'press', testID: 'same' });

  assert.equal(result.success, true);
  assert.deepEqual(calls, ['first']);
});
