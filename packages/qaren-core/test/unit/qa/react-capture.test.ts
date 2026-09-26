import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspect } from 'node:util';
import vm from 'node:vm';
import { CDPClient } from '../../../dist/cdp-client.js';
import { createComponentTreeHandler } from '../../../dist/handlers/component-tree.js';
import { buildFiber, createSandbox } from '../helpers/inject-harness.js';
import { captureQaReact } from '../../../dist/qa/react-capture.js';
import { captureScreen } from '../../../dist/qa/capture.js';
import { PrivateInputCaptureError, validatePrivateInputs } from '../../../dist/qa/private-input.js';
import { inputValues } from '../../../dist/qa/privacy.js';
import { decideScreen } from '../../../dist/qa/resolve.js';
import { parsePlan } from '../../../dist/qa/plan.js';
import { runPlan } from '../../../dist/qa/walker.js';
import type { NativeNode } from '../../../dist/qa/screen.js';
import { nativeCapture } from './platform-presence-fixtures.ts';
import { scriptedJudge, walker } from './judgment-fixtures.ts';

const sentinel = 'PRIVATE_TEST_INPUT_7abf';
const id = '1abcd';
const inputs = () => ({
  version: 1,
  complete: true,
  facts: [{ hostIndex: 0, values: [sentinel], secure: true }],
});
const publicTree = () => ({
  interactive: [
    {
      role: 'textinput',
      testID: 'field',
      placeholder: 'Enter',
      capabilities: { press: false, fill: true },
    },
  ],
  verdict: {
    state: 'ok',
    path: 'interactive',
    complete: true,
    reasons: [],
    rendererErrors: 0,
    unscannedRendererIds: [],
    droppedSubtrees: 0,
    collapsedChildLists: 0,
  },
  hostEvidence: {
    complete: true,
    hosts: [{ testID: 'field', role: null, roleSource: 'none', capabilities: { fill: true } }],
  },
});
const ready = () => ({ v: 1, id, state: 'ready', tree: JSON.stringify(publicTree()) });
const start = () => ({ v: 1, id, inputs: inputs(), state: 'pending' });

function realProducer(props: Record<string, unknown>, allowLegacyTree = false) {
  const fiber = Object.assign(
    buildFiber({
      hostType: 'RCTTextInput',
      props,
      stateNode: {
        measureInWindow: (done: (...rect: number[]) => void) =>
          setTimeout(() => done(0, 0, 100, 40), 35),
      },
    }),
    { tag: 5 },
  );
  const root: { current: object } = { current: fiber };
  if (allowLegacyTree) {
    const wrapper = Object.assign(buildFiber({ name: 'TextInput', props }), { tag: 0 });
    Reflect.set(wrapper, 'child', fiber);
    Reflect.set(fiber, 'return', wrapper);
    root.current = wrapper;
  }
  const sandbox = createSandbox({ fiberRoot: root.current });
  sandbox.__REACT_DEVTOOLS_GLOBAL_HOOK__.getFiberRoots = (renderer: number) =>
    renderer === 1 ? new Set([root]) : new Set();
  const globalKeys = Object.keys(sandbox);
  const client = new CDPClient();
  client.setLifecycleAuthority(() => false);
  const expressions: string[] = [];
  Reflect.set(client, 'ws', {
    readyState: 1,
    send(frame: string) {
      const request = JSON.parse(frame);
      assert.equal(request.method, 'Runtime.evaluate');
      assert.equal(
        request.params.contextId,
        allowLegacyTree && request.params.expression.startsWith('__QAREN.getTree(') ? undefined : 7,
      );
      assert.equal(request.params.awaitPromise, undefined);
      expressions.push(request.params.expression);
      const value: unknown = vm.runInContext(request.params.expression, sandbox);
      Reflect.get(client, 'handleMessage').call(
        client,
        Buffer.from(JSON.stringify({ id: request.id, result: { result: { value } } })),
      );
    },
  });
  Reflect.set(client, '_state', 'connected');
  Reflect.get(client, 'handleExecutionContextCreated').call(client, { context: { id: 7 } });
  Reflect.set(client, '_helpersInjected', true);
  return {
    client,
    sandbox,
    expressions,
    globalKeys,
    removeInput() {
      root.current = Object.assign(buildFiber({ hostType: 'RCTView', props: {} }), { tag: 5 });
    },
  };
}

function nativeEcho(withField: boolean) {
  const native = nativeCapture();
  const observed = native.nodes[1];
  const nodes: NativeNode[] = [
    ...native.nodes,
    {
      ...observed,
      ref: '@echo',
      index: 2,
      identifier: undefined,
      type: 'StaticText',
      label: sentinel,
      secure: false,
      value: undefined,
      presence: { ...observed.presence, nodeIndex: 2 },
    },
    ...(withField
      ? [
          {
            ...observed,
            ref: '@field',
            index: 3,
            identifier: 'field',
            type: 'TextField',
            label: 'Account',
            secure: false,
            value: undefined,
            presence: { ...observed.presence, nodeIndex: 3 },
          },
        ]
      : []),
  ];
  return {
    ...native,
    nodes,
    snapshotVerdict: { ...native.snapshotVerdict, nodeCount: nodes.length },
  };
}

test('real producer and adapter interoperate through an in-memory CDP socket', async () => {
  for (const typography of [false, true]) {
    const { client, sandbox, expressions, globalKeys } = realProducer({
      testID: 'field',
      value: sentinel,
      secureTextEntry: true,
    });
    const observation = await captureQaReact(client, typography);
    validatePrivateInputs(observation, true);
    const screen = await captureScreen({
      native: async () => ({ nodes: [] }),
      react: async () => observation,
    });
    assert.ok(inputValues(screen).includes(sentinel));
    assert.equal(JSON.stringify(screen).includes(sentinel), false);
    assert.equal(JSON.stringify(expressions).includes(sentinel), false);
    assert.equal(
      expressions.some((expression) => expression.includes('__rn_agent_async_')),
      false,
    );
    assert.equal(expressions.length >= 3, typography);
    assert.deepEqual(Object.keys(sandbox), globalKeys);
    assert.equal(inspect(client, { depth: 8 }).includes(sentinel), false);
  }
});

test('legacy whole-tree handler neither enters nor exposes the private capture channel', async (t) => {
  const producer = realProducer({ value: sentinel, readOnly: true, secureTextEntry: true }, true);
  t.mock.method(producer.client, 'withPrivateHelperWorld', async () =>
    assert.fail('public handler must remain outside private capture'),
  );
  t.mock.method(producer.client, 'autoConnect', async () =>
    assert.fail('fake CDP is already connected'),
  );
  t.mock.method(producer.client, 'reinjectHelpers', async () =>
    assert.fail('helper is already fresh'),
  );
  const handler = createComponentTreeHandler(() => producer.client);
  const result = await handler({ depth: 4 });
  assert.equal(result.isError, undefined);
  const envelope = JSON.parse(result.content[0].text);
  assert.equal(envelope.ok, true);
  assert.ok(envelope.data.tree);
  assert.equal(envelope.data.interactive, undefined);
  assert.equal(envelope.data.inputs, undefined);
  assert.doesNotMatch(JSON.stringify(envelope), /"inputs"|"secureTextEntry"/);
  assert.equal(JSON.stringify(envelope).includes(sentinel), false);
  assert.ok(producer.expressions.some((expression) => expression.startsWith('__QAREN.getTree(')));
  assert.ok(
    producer.expressions.every((expression) => !/beginQaCapture|readQaCapture/.test(expression)),
  );
  const capture = { native: async () => nativeEcho(false), react: async () => envelope.data };
  await captureScreen(capture);
  await assert.rejects(captureScreen({ ...capture, requirePrivateInputs: true }), sanitized);
});

for (const typography of [false, true]) {
  for (const secure of [false, true]) {
    test(`real ${secure ? 'RN-secure/native-unflagged' : 'anonymous readonly RN-only'} capture protects judgments and durable history (typography=${typography})`, async () => {
      const producer = realProducer(
        secure
          ? { testID: 'field', value: sentinel, secureTextEntry: true }
          : { value: sentinel, readOnly: true, editable: false },
      );
      const native = nativeEcho(secure);
      const capture = () =>
        captureScreen({
          appId: 'com.test',
          requirePrivateInputs: true,
          native: async () => native,
          react: () => captureQaReact(producer.client, typography),
        });
      const screen = await capture();
      assert.deepEqual(screen.coverage, { native: 'complete', react: 'complete' });
      assert.ok(
        screen.visibleText.includes(sentinel),
        'the native echo is genuinely observed public text',
      );
      assert.ok(
        inputValues(screen).includes(sentinel),
        'the real producer carries the otherwise RN-only value',
      );
      assert.equal(
        screen.elements.find((element) => element.ref === '@echo')?.semantic?.visibility,
        'visible',
      );
      assert.ok(
        screen.elements.every((element) => element.value === undefined && element.secure === false),
      );
      assert.equal(JSON.stringify(screen.reactHostEvidence).includes(sentinel), false);
      if (!secure) {
        assert.equal(screen.reactHostEvidence?.hosts[0].testID, undefined);
        assert.equal(screen.reactHostEvidence?.hosts[0].readOnly, true);
      }

      const judge = scriptedJudge((questions, index, state) => {
        const outbound = JSON.stringify({ state, questions });
        assert.equal(outbound.includes(sentinel), false);
        assert.match(outbound, /QAREN_VALUE/);
        return Object.fromEntries(
          Object.keys(questions).map((key) => [
            key,
            { type: 'noul', noul: index < 2 ? 0.99 : 0.01 },
          ]),
        );
      });
      assert.equal(
        (
          await decideScreen(screen, judge, {
            kind: 'check',
            literal: false,
            text: `The page mentions ${sentinel}`,
            line: 1,
          })
        ).check,
        'pass',
      );
      assert.equal(judge.requests.length, 1);

      const protectedJudge = scriptedJudge(() =>
        assert.fail('private field contents must not be judged'),
      );
      assert.equal(
        (
          await decideScreen(screen, protectedJudge, {
            kind: 'check',
            literal: false,
            text: `Account field contains ${sentinel}`,
            line: 1,
          })
        ).check,
        'unsure',
      );
      const protectedWalk = walker([], protectedJudge);
      protectedWalk.deps.captureScreen = capture;
      protectedWalk.deps.screenshot = async () =>
        assert.fail('private input pixels must be withheld');
      const protectedPlan = parsePlan(`✓ Account field contains ${sentinel}`);
      assert.ok(protectedPlan.blocks);
      const protectedResult = await runPlan(protectedPlan.blocks, protectedWalk.deps);
      assert.equal(protectedResult.verdict, 'FAIL');
      assert.match(protectedResult.failure?.seen ?? '', /CHECK_UNSURE/);
      assert.equal(
        JSON.stringify({ protectedResult, rows: protectedWalk.rows }).includes(sentinel),
        false,
      );
      assert.equal(protectedJudge.requests.length, 0);

      const history = walker([], judge);
      let captures = 0;
      history.deps.captureScreen = async () => {
        if (++captures === 2) producer.removeInput();
        const observed = await capture();
        if (captures === 2)
          assert.deepEqual(inputValues(observed), [], 'later capture has no current private facts');
        return observed;
      };
      history.deps.screenshot = async () =>
        assert.fail('pixel restriction must persist after the RN input disappears');
      const plan = parsePlan(
        `### Before\n✓ The page mentions ${sentinel}\n### After\n✓ The page still mentions ${sentinel}`,
      );
      assert.ok(plan.blocks);
      assert.equal(plan.blocks.length, 2);
      const result = await runPlan(plan.blocks, history.deps);
      assert.equal(result.verdict, 'FAIL');
      assert.deepEqual(
        result.steps.map((row) => row.outcome),
        ['pass', 'fail'],
      );
      assert.equal(captures, 2);
      assert.equal(judge.requests.length, 3);
      assert.equal(
        JSON.stringify({ result, rows: history.rows, requests: judge.requests }).includes(sentinel),
        false,
      );
      assert.match(result.failure?.seen ?? '', /•••/);
      assert.ok(result.steps.every((row) => row.screenshot === undefined));
      assert.equal(result.failure?.screenshot, undefined);
      assert.deepEqual(history.actions, []);
      assert.equal(JSON.stringify(producer.expressions).includes(sentinel), false);
    });
  }

  for (const fault of ['getter', 'coverage'] as const) {
    test(`real producer ${fault} refusal reaches required capture and walker without private diagnostics (typography=${typography})`, async (t) => {
      const logs = t.mock.method(console, 'error', () => {});
      let getterCalls = 0;
      const props =
        fault === 'getter'
          ? Object.defineProperty({}, 'value', {
              get() {
                getterCalls++;
                throw new Error(sentinel);
              },
            })
          : { value: sentinel };
      const producer = realProducer(props);
      if (fault === 'coverage') {
        const hook = producer.sandbox.__REACT_DEVTOOLS_GLOBAL_HOOK__;
        hook.renderers.set(2, {});
        const roots = hook.getFiberRoots;
        hook.getFiberRoots = (renderer: number) => {
          if (renderer === 2) throw new Error(sentinel);
          return roots(renderer);
        };
      }
      await assert.rejects(captureQaReact(producer.client, typography), sanitized);
      const capture = () =>
        captureScreen({
          requirePrivateInputs: true,
          appId: 'com.test',
          native: async () => nativeEcho(false),
          react: () => captureQaReact(producer.client, typography),
          warn: () => assert.fail('private acquisition refusal must not become a legacy warning'),
        });
      await assert.rejects(capture(), sanitized);
      const judge = scriptedJudge(() => assert.fail('unknown capture must not reach the judge'));
      const f = walker([], judge);
      f.deps.captureScreen = capture;
      f.deps.screenshot = async () => assert.fail('unknown capture must not expose pixels');
      const plan = parsePlan(`### ${sentinel}\n✓ The page mentions ${sentinel}`);
      assert.ok(plan.blocks);
      const result = await runPlan(plan.blocks, f.deps);
      const safe = new PrivateInputCaptureError();
      assert.equal(result.verdict, 'REFUSED');
      assert.equal('code' in result && result.code, safe.code);
      assert.equal('message' in result && result.message, safe.message);
      assert.deepEqual(f.rows, [
        {
          block: 'private-input-capture',
          line: 2,
          text: safe.message,
          attempt: 1,
          kind: 'check',
          resolvedBy: 'exact',
          t: 0,
          outcome: 'fail',
          reason: safe.code,
        },
      ]);
      assert.deepEqual(result.failure, { step: 2, seen: safe.message });
      assert.equal(JSON.stringify({ result, rows: f.rows }).includes(sentinel), false);
      assert.equal(judge.requests.length, 0);
      assert.deepEqual(f.actions, []);
      assert.equal(getterCalls, 0);
      assert.equal(logs.mock.callCount(), 0);
      assert.equal(JSON.stringify(producer.expressions).includes(sentinel), false);
    });
  }
}

function mockClient(responses: unknown[]) {
  const calls: Array<{ expression: string; timeoutMs: number }> = [];
  let operations = 0;
  const client: Pick<CDPClient, 'withPrivateHelperWorld'> = {
    async withPrivateHelperWorld(operation) {
      operations++;
      return operation(async (expression, timeoutMs) => {
        calls.push({ expression, timeoutMs });
        assert.ok(responses.length > 0, 'unexpected extra call');
        return responses.shift();
      });
    },
  };
  return { client, calls, operations: () => operations };
}

function sanitized(error: unknown): boolean {
  assert.ok(error instanceof PrivateInputCaptureError);
  assert.equal(error.code, 'PRIVATE_INPUT_CAPTURE_UNKNOWN');
  assert.equal(error.message, new PrivateInputCaptureError().message);
  assert.equal(error.cause, undefined);
  assert.equal(inspect(error).includes(sentinel), false);
  return true;
}

test('sync begin and public-only polls bind facts privately without copying into observation or Screen', async () => {
  const mock = mockClient([start(), { v: 1, id, state: 'pending' }, ready()]);
  const observation = await captureQaReact(mock.client);
  validatePrivateInputs(observation, true);
  assert.equal(mock.operations(), 1);
  assert.deepEqual(
    mock.calls.map((call) => call.expression),
    [
      'globalThis.__QAREN.beginQaCapture(false)',
      `globalThis.__QAREN.readQaCapture("${id}")`,
      `globalThis.__QAREN.readQaCapture("${id}")`,
    ],
  );
  assert.ok(mock.calls.every((call) => call.timeoutMs > 0 && call.timeoutMs <= 1500));
  assert.ok(mock.calls[2].timeoutMs < mock.calls[0].timeoutMs);
  assert.equal(JSON.stringify(mock.calls).includes(sentinel), false);
  assert.equal(JSON.stringify(observation).includes(sentinel), false);
  assert.deepEqual(Reflect.ownKeys(observation).sort(), [
    'hostEvidence',
    'interactive',
    'truncated',
    'verdict',
  ]);
  const screen = await captureScreen({
    native: async () => ({ nodes: [] }),
    react: async () => observation,
  });
  assert.equal(JSON.stringify(screen).includes(sentinel), false);
  assert.ok(inputValues(screen).includes(sentinel));
});

test('immediate ready is consumed once and typography is a hardcoded boolean', async () => {
  for (const typography of [false, true]) {
    const mock = mockClient([{ ...ready(), inputs: inputs() }]);
    await captureQaReact(mock.client, typography);
    assert.equal(mock.calls.length, 1);
    assert.equal(mock.calls[0].expression, `globalThis.__QAREN.beginQaCapture(${typography})`);
  }
});

test('complete empty private facts remain a valid binding', async () => {
  const mock = mockClient([{ ...ready(), inputs: { version: 1, complete: true, facts: [] } }]);
  validatePrivateInputs(await captureQaReact(mock.client), true);
});

test('digest string values refuse without exposing private input bytes in errors or metadata', async (t) => {
  const logs = t.mock.method(console, 'error', () => {});
  for (const role of ['textinput', 'switch']) {
    const tree = { ...publicTree(), interactive: [{ role, value: sentinel }] };
    const mock = mockClient([
      {
        ...ready(),
        tree: JSON.stringify(tree),
        inputs: { version: 1, complete: true, facts: [] },
      },
    ]);
    await assert.rejects(captureQaReact(mock.client), (error) => {
      sanitized(error);
      assert.ok(error instanceof PrivateInputCaptureError);
      assert.equal(JSON.stringify(error).includes(sentinel), false);
      assert.equal(Reflect.has(error, 'meta'), false);
      return true;
    });
    assert.equal(JSON.stringify(mock.calls).includes(sentinel), false);
  }
  assert.equal(logs.mock.callCount(), 0);
});

test('digest boolean values on non-switch roles refuse with constant diagnostics', async (t) => {
  const logs = t.mock.method(console, 'error', () => {});
  for (const role of ['textinput', 'checkbox', 'button']) {
    for (const value of [false, true]) {
      const tree = { ...publicTree(), interactive: [{ role, value, label: sentinel }] };
      const mock = mockClient([
        {
          ...ready(),
          tree: JSON.stringify(tree),
          inputs: { version: 1, complete: true, facts: [] },
        },
      ]);
      await assert.rejects(captureQaReact(mock.client), sanitized);
      assert.equal(JSON.stringify(mock.calls).includes(sentinel), false);
    }
  }
  assert.equal(logs.mock.callCount(), 0);
});

test('legitimate switch booleans retain an empty private binding', async () => {
  for (const value of [false, true]) {
    const tree = {
      ...publicTree(),
      interactive: [{ role: 'switch', testID: 'toggle', value }],
      hostEvidence: {
        complete: true,
        hosts: [
          { role: 'switch', roleSource: 'accessibilityRole', testID: 'toggle', capabilities: {} },
        ],
      },
    };
    const mock = mockClient([
      {
        ...ready(),
        tree: JSON.stringify(tree),
        inputs: { version: 1, complete: true, facts: [] },
      },
    ]);
    const observation = await captureQaReact(mock.client);
    validatePrivateInputs(observation, true);
    assert.deepEqual(observation.interactive, tree.interactive);
    const screen = await captureScreen({
      requirePrivateInputs: true,
      native: async () => ({ nodes: [] }),
      react: async () => observation,
    });
    assert.deepEqual(inputValues(screen), []);
  }
});

test('ordinary public tree content is not claimed to be private-channel redacted', async () => {
  const tree = publicTree();
  tree.interactive[0].placeholder = sentinel;
  const mock = mockClient([{ ...ready(), inputs: inputs(), tree: JSON.stringify(tree) }]);
  const observation = await captureQaReact(mock.client);
  assert.equal(observation.interactive?.[0].placeholder, sentinel);
});

test('missing API or transport exceptions become constant refusals with no fallback', async () => {
  const client: Pick<CDPClient, 'withPrivateHelperWorld'> = {
    async withPrivateHelperWorld() {
      throw new Error(`beginQaCapture is not a function: ${sentinel}`);
    },
  };
  await assert.rejects(captureQaReact(client), sanitized);
});

test('start wire refuses unsafe IDs, unexpected fields, missing and incomplete private payloads', async () => {
  for (const value of [
    undefined,
    null,
    [],
    { ...start(), v: 2 },
    { ...start(), id: '' },
    { ...start(), id: 'a'.repeat(65) },
    { ...start(), id: `");${sentinel}//` },
    { ...start(), state: 'refused' },
    { ...start(), state: 'unknown' },
    { ...start(), error: sentinel },
    { ...start(), inputs: undefined },
    { ...start(), inputs: { ...inputs(), complete: false } },
    { ...start(), inputs: { ...inputs(), extra: sentinel } },
    { ...start(), inputs: { ...inputs(), facts: [{ ...inputs().facts[0], extra: sentinel }] } },
    {
      ...start(),
      inputs: { ...inputs(), facts: [{ ...inputs().facts[0], hostIndex: { private: sentinel } }] },
    },
    { ...start(), tree: JSON.stringify(publicTree()) },
    { ...start(), inputs: { ...inputs(), facts: Array(201).fill(inputs().facts[0]) } },
    {
      ...start(),
      inputs: { ...inputs(), facts: [{ hostIndex: 0, secure: true, values: ['x'.repeat(4097)] }] },
    },
    {
      ...start(),
      inputs: {
        ...inputs(),
        facts: [{ hostIndex: 0, secure: true, values: [sentinel, sentinel, sentinel, sentinel] }],
      },
    },
  ]) {
    const mock = mockClient([value]);
    await assert.rejects(captureQaReact(mock.client), sanitized);
    assert.equal(mock.calls.length, 1);
    assert.equal(JSON.stringify(mock.calls).includes(sentinel), false);
  }
});

test('polls must be public-only, same-ID, versioned completions', async () => {
  for (const value of [
    null,
    { ...ready(), v: 0 },
    { ...ready(), id: 'abc' },
    { ...ready(), id: `abc${sentinel}` },
    { ...ready(), state: 'refused' },
    { ...ready(), inputs: inputs() },
    { ...ready(), error: sentinel },
    { v: 1, id, state: 'ready' },
  ]) {
    const mock = mockClient([start(), value]);
    await assert.rejects(captureQaReact(mock.client), sanitized);
    assert.equal(mock.calls.length, 2);
    assert.equal(JSON.stringify(mock.calls).includes(sentinel), false);
  }
});

test('tree parsing and incomplete or malformed public evidence fail without raw parser diagnostics', async (t) => {
  const log = t.mock.method(console, 'error', () => {});
  for (const tree of [
    { ...publicTree(), interactive: [null] },
    { ...publicTree(), interactive: [{ role: 'button', label: {} }] },
    {
      ...publicTree(),
      interactive: [{ role: 'button', capabilities: { fill: 'true', press: false } }],
    },
    { ...publicTree(), truncated: true },
    { ...publicTree(), truncated: 'false' },
    { ...publicTree(), verdict: {} },
    { ...publicTree(), verdict: { ...publicTree().verdict, complete: false } },
    { ...publicTree(), verdict: { ...publicTree().verdict, path: 'full' } },
    { ...publicTree(), verdict: { ...publicTree().verdict, reasons: [sentinel] } },
    { ...publicTree(), verdict: { ...publicTree().verdict, rendererErrors: 1 } },
    { ...publicTree(), hostEvidence: { hosts: [], complete: false } },
    { ...publicTree(), hostEvidence: { hosts: [{}], complete: true } },
    [],
    null,
  ]) {
    const mock = mockClient([{ ...ready(), inputs: inputs(), tree: JSON.stringify(tree) }]);
    await assert.rejects(captureQaReact(mock.client), sanitized);
  }
  for (const tree of [`{"private":"${sentinel}" BROKEN`, 'x'.repeat(1000000), {}, undefined]) {
    const mock = mockClient([{ ...ready(), inputs: inputs(), tree }]);
    await assert.rejects(captureQaReact(mock.client), sanitized);
  }
  assert.equal(log.mock.callCount(), 0);
});

test('domain binding refuses facts outside the completed capture host list', async () => {
  for (const facts of [
    [{ hostIndex: 1, values: [sentinel], secure: true }],
    [inputs().facts[0], inputs().facts[0]],
    [{ hostIndex: 0, values: [sentinel], secure: 'true' }],
  ]) {
    const mock = mockClient([{ ...ready(), inputs: { ...inputs(), facts } }]);
    await assert.rejects(captureQaReact(mock.client), sanitized);
  }
});

test('monotonic overall deadline includes freshness and prevents begin after timeout', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  let release!: () => void;
  let calls = 0;
  const client: Pick<CDPClient, 'withPrivateHelperWorld'> = {
    async withPrivateHelperWorld(operation) {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return operation(async () => {
        calls++;
        return start();
      });
    },
  };
  const result = assert.rejects(captureQaReact(client), sanitized);
  now = 1500;
  t.mock.timers.tick(1500);
  await result;
  release();
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(calls, 0);
});

test('each call receives only remaining budget and polling sleeps are bounded', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const timeouts: number[] = [];
  const client: Pick<CDPClient, 'withPrivateHelperWorld'> = {
    async withPrivateHelperWorld(operation) {
      now = 400;
      return operation(async (_, timeout) => {
        timeouts.push(timeout);
        now += 300;
        return timeouts.length === 1 ? start() : ready();
      });
    },
  };
  const result = captureQaReact(client);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.deepEqual(timeouts, [1100]);
  now += 24;
  t.mock.timers.tick(24);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.deepEqual(timeouts, [1100]);
  now += 1;
  t.mock.timers.tick(1);
  await result;
  assert.deepEqual(timeouts, [1100, 775]);
});

test('hung begin and late completion cannot bypass the overall deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  let release!: (value: unknown) => void;
  let calls = 0;
  const client: Pick<CDPClient, 'withPrivateHelperWorld'> = {
    async withPrivateHelperWorld(operation) {
      return operation(async () => {
        calls++;
        return new Promise<unknown>((resolve) => {
          release = resolve;
        });
      });
    },
  };
  const result = assert.rejects(captureQaReact(client), sanitized);
  now = 1500;
  t.mock.timers.tick(1500);
  await result;
  release(start());
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(calls, 1);
});

test('port completion after the monotonic deadline cannot return an observation', async (t) => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const client: Pick<CDPClient, 'withPrivateHelperWorld'> = {
    async withPrivateHelperWorld(operation) {
      const observation = await operation(async () => ({ ...ready(), inputs: inputs() }));
      now = 1501;
      return observation;
    },
  };
  await assert.rejects(captureQaReact(client), sanitized);
});
