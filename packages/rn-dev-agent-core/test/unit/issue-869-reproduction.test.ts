// Issue #869 — REPRODUCTION ONLY. These tests pin the CURRENT (defective)
// behavior so the failure is measurable and repeatable while the fix approach
// is still open. Each assertion below documents a reported refusal, not a
// desired outcome; the fix will invert them.
//
// Reported shape: an Expo dev-client login sheet of ~824 fibers whose email
// field is a react-hook-form Controller rendering a custom TextField, with the
// native input behind an `accessible` Pressable wrapper (`<name>-pressable`).
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

// Leg 1 — cdp_interact typeText. Reported: work 2000/2000, scanned 391,
// handlerCalled false, on a tree of 824 fibers.
test('issue-869 repro: typeText exhausts its flat 2000-unit budget on an 824-fiber screen', () => {
  const { root, calls } = buildLoginSheet();
  assert.equal(countFibers(root), REPORTED_FIBER_COUNT);

  const result = createAgent(root).interact({
    action: 'typeText',
    testID: 'login_form_email',
    text: 'user@example.com',
  });

  assert.equal(result.error, 'typeText resolution truncated');
  assert.equal(result.truncated, true);
  assert.equal(result.reason, 'work-limit');
  assert.equal(result.workLimit, 2000);
  assert.equal(result.work, 2000);
  assert.equal(result.handlerCalled, false);
  // The refusal is structural, not proportional: the budget is spent after a
  // fixed fraction of the tree regardless of how large the tree actually is.
  assert.ok((result.scanned as number) < REPORTED_FIBER_COUNT / 2, JSON.stringify(result));
  assert.deepEqual(calls, []);
});

// The ceiling is a property of the resolver, not of the app: the same ~390
// fibers are scanned whether the screen is 411 or 1011 fibers.
test('issue-869 repro: the typeText ceiling is fixed at ~390 fibers for any tree size', () => {
  const scans = [411, 824, 1011].map((size) => {
    const { root } = buildLoginSheet(size);
    const result = createAgent(root).interact({
      action: 'typeText',
      testID: 'login_form_email',
      text: 'user@example.com',
    });
    return { size, scanned: result.scanned as number, work: result.work as number };
  });

  for (const scan of scans) {
    assert.equal(scan.work, 2000, JSON.stringify(scan));
    assert.ok(scan.scanned > 380 && scan.scanned < 400, JSON.stringify(scan));
  }
  // Roughly 5 work units are charged per visited fiber, so 2000 units can
  // never reach past ~400 fibers.
  assert.equal(scans[0].scanned, scans[2].scanned);
});

// The same bounded resolver backs the post-type read-back, so verification is
// blocked on the same screen even when typing is attempted another way.
test('issue-869 repro: the typeText read-back is blocked by the same budget', () => {
  const { root } = buildLoginSheet();

  const read = createAgent(root).readInputValue('login_form_email');

  assert.equal(read.__agent_error, 'typeText resolution truncated');
});

// Leg 2 — cdp_interact setFieldValue. Reported: work 201/200.
test('issue-869 repro: setFieldValue exhausts its 200-unit owner scan on an ordinary chain', () => {
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

test('issue-869 repro: device_fill cannot bind a merged iOS pressable wrapper', () => {
  const byWrapperTestId = bindExactFillTarget(
    MERGED_WRAPPER_NODES as never,
    'login_form_email-pressable',
  );
  const byInnerTestId = bindExactFillTarget(MERGED_WRAPPER_NODES as never, 'login_form_email');

  assert.equal(byWrapperTestId.ok, false);
  assert.equal(
    (byWrapperTestId as { detail: string }).detail,
    'wrapper "login_form_email-pressable" has no recognized input with testID "login_form_email" in the current snapshot',
  );
  assert.equal(byInnerTestId.ok, false);
  assert.equal(
    (byInnerTestId as { detail: string }).detail,
    'no element with testID "login_form_email" in the current snapshot',
  );
});

// The refusal points at "the current snapshot", implying a refresh-and-rebind
// recovery. That recovery cannot apply: the merge is a property of the view
// hierarchy, so every future snapshot is identical.
test('issue-869 repro: refusal implies a rebind that no snapshot generation can satisfy', () => {
  const first = bindExactFillTarget(MERGED_WRAPPER_NODES as never, 'login_form_email-pressable');
  const afterRefresh = bindExactFillTarget(
    MERGED_WRAPPER_NODES.map((node) => ({ ...node })) as never,
    'login_form_email-pressable',
  );

  assert.equal(first.ok, false);
  assert.equal(afterRefresh.ok, false);
  assert.equal((afterRefresh as { detail: string }).detail, (first as { detail: string }).detail);
  assert.match((afterRefresh as { detail: string }).detail, /in the current snapshot/);
});
