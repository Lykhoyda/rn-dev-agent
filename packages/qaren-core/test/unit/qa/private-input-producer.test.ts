import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { buildFiber, createSandbox, INJECTED_HELPERS } from '../helpers/inject-harness.js';
import { captureQaReact } from '../../../dist/qa/react-capture.js';
import { captureScreen } from '../../../dist/qa/capture.js';
import { PrivateInputCaptureError } from '../../../dist/qa/private-input.js';
import { decideScreen } from '../../../dist/qa/resolve.js';
import type { Screen } from '../../../dist/qa/screen.js';
import { inputValues, ObservedPrivacy } from '../../../dist/qa/privacy.js';
import { parsePlan } from '../../../dist/qa/plan.js';
import { runPlan } from '../../../dist/qa/walker.js';
import { scriptedJudge, walker } from './judgment-fixtures.ts';
import { nativeCapture } from './platform-presence-fixtures.ts';

function setup(props: Record<string, unknown> = {}, hostType = 'RCTTextInput') {
  const fiber = buildFiber({ hostType, props });
  fiber.tag = 5;
  const root = { current: fiber };
  const sandbox = createSandbox({ fiberRoot: fiber });
  sandbox.__REACT_DEVTOOLS_GLOBAL_HOOK__.getFiberRoots = (id: number) =>
    id === 1 ? new Set([root]) : new Set();
  const api = sandbox.__QAREN;
  return { fiber, root, sandbox, api };
}

function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

const inputCanary = 'uncontrolled-input-echo-canary';

function inputPipeline(
  props: Record<string, unknown>,
  nativeValue: string | undefined,
  typography: boolean,
  echoText = inputCanary,
  hostType = 'RCTSinglelineTextInputView',
) {
  const fixture = setup({}, 'RCTView');
  const input = buildFiber({ hostType, props: { testID: 'field', ...props } }, fixture.fiber);
  input.tag = 5;
  const echo = buildFiber({ hostType: 'RCTText' }, fixture.fiber);
  echo.tag = 5;
  echo.child = buildFiber({ text: echoText }, echo);
  echo.child.tag = 6;
  fixture.fiber.child = input;
  input.sibling = echo;
  const native = async () => ({
    nodes: [
      {
        ref: '@field',
        type: props.secureTextEntry ? 'SecureTextField' : 'TextField',
        identifier: 'field',
        label: 'Field',
        value: nativeValue,
        secure: props.secureTextEntry === true,
        hittable: true,
        enabled: true,
      },
      { ref: '@echo', type: 'StaticText', label: echoText, hittable: true },
    ],
  });
  const capture = () =>
    captureScreen({
      requirePrivateInputs: true,
      native,
      react: () =>
        captureQaReact(
          {
            async withPrivateHelperWorld(run) {
              return run(async (expression) => vm.runInContext(expression, fixture.sandbox));
            },
          },
          typography,
        ),
    });
  return { ...fixture, capture };
}

for (const secureTextEntry of [false, true]) {
  for (const hasDefault of [false, true]) {
    for (const nativeValue of [undefined, '••••', inputCanary]) {
      for (const typography of [false, true]) {
        test(`uncontrolled input refuses before disclosure: secure=${secureTextEntry}, default=${hasDefault}, native=${nativeValue === undefined ? 'absent' : nativeValue === inputCanary ? 'plaintext' : 'masked'}, typography=${typography}`, async () => {
          // RN 0.85 forwards value unchanged; host text uses value, then defaultValue, never lastNativeText.
          const fixture = inputPipeline(
            {
              secureTextEntry,
              text: hasDefault ? 'initial' : undefined,
              ...(hasDefault ? { defaultValue: 'initial' } : {}),
              onChange() {},
              onChangeText() {},
            },
            nativeValue,
            typography,
          );
          const judge = scriptedJudge(() => ({ check_1: { type: 'noul', noul: 0.01 } }));
          for (const source of [
            '✓ Welcome is visible',
            '✓ "Absent confirmation"',
            '1. Tap "Continue"',
          ]) {
            const walk = walker([], judge);
            let latest: Screen | undefined;
            let screenshots = 0;
            walk.deps.captureScreen = async () => {
              latest = await fixture.capture();
              return latest;
            };
            walk.deps.screenshot = async () => {
              screenshots++;
              return 'unexpected';
            };
            const plan = parsePlan(source);
            assert.ok(plan.blocks);
            const result = await runPlan(plan.blocks, walk.deps);
            assert.equal(
              JSON.stringify({
                result,
                rows: walk.rows,
                outbound: judge.requests,
                latest,
              }).includes(inputCanary),
              false,
            );
            assert.equal(result.verdict, 'REFUSED');
            assert.equal('code' in result && result.code, 'PRIVATE_INPUT_CAPTURE_UNKNOWN');
            assert.equal(result.failure?.seen, new PrivateInputCaptureError().message);
            assert.equal(latest, undefined);
            assert.equal(judge.requests.length, 0);
            assert.deepEqual(walk.actions, []);
            assert.equal(screenshots, 0);
          }
          await assert.rejects(
            async () =>
              decideScreen(await fixture.capture(), judge, {
                kind: 'check',
                literal: false,
                text: 'Welcome is visible',
                line: 1,
              }),
            PrivateInputCaptureError,
          );
          const begin = fixture.api.beginQaCapture(typography);
          assert.equal(begin.state, 'refused');
          assert.deepEqual(plain(begin.inputs), { version: 1, complete: false, facts: [] });
          assert.equal(begin.tree, undefined);
          assert.equal(JSON.stringify(begin).includes(inputCanary), false);
          assert.equal(judge.requests.length, 0);
        });
      }
    }
  }
}

for (const value of [inputCanary, '']) {
  test(`controlled ${value ? 'current' : 'explicit empty'} value remains admitted through decisions and walking`, async () => {
    for (const hostType of ['RCTSinglelineTextInputView', 'AndroidTextInput']) {
      for (const secureTextEntry of [false, true]) {
        for (const typography of [false, true]) {
          for (const nativeValue of [undefined, value ? '••••' : '']) {
            const fixture = inputPipeline(
              { value, text: value, secureTextEntry, onChange() {} },
              nativeValue,
              typography,
              value || 'Welcome',
              hostType,
            );
            const screen = await fixture.capture();
            assert.equal(inputValues(screen).includes(inputCanary), value !== '');
            const judge = scriptedJudge((questions, _, state) => {
              assert.equal(JSON.stringify({ questions, state }).includes(inputCanary), false);
              return { check_1: { type: 'noul', noul: 0.99 } };
            });
            const decision = await decideScreen(screen, judge, {
              kind: 'check',
              literal: false,
              text: 'Welcome is visible',
              line: 1,
            });
            assert.equal(decision.check, 'pass');
            assert.equal(judge.requests.length, 1);
            const walk = walker([], judge);
            walk.deps.captureScreen = fixture.capture;
            walk.deps.screenshot = async () => {
              assert.equal(
                secureTextEntry || value !== '',
                false,
                'private input pixels must be withheld',
              );
              return 'safe-empty';
            };
            for (const [source, verdict] of [
              ['✓ Welcome is visible', 'PASS'],
              ['✓ "Absent confirmation"', 'FAIL'],
            ]) {
              const plan = parsePlan(source);
              assert.ok(plan.blocks);
              const result = await runPlan(plan.blocks, walk.deps);
              assert.equal(result.verdict, verdict);
              assert.equal(
                JSON.stringify({ result, rows: walk.rows, outbound: judge.requests }).includes(
                  inputCanary,
                ),
                false,
              );
            }
          }
        }
      }
    }
  });
}

test('native aliases and positive input hints require a current string value, not text or defaults', () => {
  for (const hostType of [
    'TextInput',
    'RCTTextInput',
    'RCTSinglelineTextInputView',
    'RCTMultilineTextInputView',
    'AndroidTextInput',
  ]) {
    for (const secureTextEntry of [undefined, false, true]) {
      for (const value of [undefined, null, '']) {
        const fixture = setup(
          { value, text: value === '' ? '' : 'initial', defaultValue: 'initial', secureTextEntry },
          hostType,
        );
        const begin = fixture.api.beginQaCapture();
        assert.equal(begin.state, value === '' ? 'ready' : 'refused');
        assert.equal(begin.inputs.complete, value === '');
        if (value !== '') {
          assert.deepEqual(plain(begin.inputs.facts), []);
          assert.equal(begin.tree, undefined);
        }
      }
    }
  }
  for (const hint of [
    { secureTextEntry: true },
    { secureTextEntry: false },
    { onChangeText() {} },
    { text: 'initial' },
    { defaultValue: 'initial' },
  ]) {
    const begin = setup(hint, 'CustomNativeHost').api.beginQaCapture();
    assert.equal(begin.state, 'refused');
    assert.deepEqual(plain(begin.inputs), { version: 1, complete: false, facts: [] });
    assert.equal(begin.tree, undefined);
  }
  const generic = setup(
    { value: inputCanary, text: 'initial' },
    'CustomNativeHost',
  ).api.beginQaCapture();
  assert.equal(generic.state, 'ready');
  assert.equal(generic.inputs.facts[0].values.includes(inputCanary), true);
  assert.notEqual(JSON.parse(generic.tree).hostEvidence.hosts[0].capabilities.fill, true);
});

function wrappedInput(readOnly = false) {
  let namesRead = 0;
  function TextInput() {
    assert.fail('render must not execute');
  }
  const forward = { $$typeof: Symbol.for('react.forward_ref'), render: TextInput };
  const memo = { $$typeof: Symbol.for('react.memo'), type: forward, compare: null };
  for (const type of [memo, forward]) {
    Object.defineProperty(type, 'displayName', {
      configurable: true,
      get() {
        namesRead++;
        return 'TextInput';
      },
      set() {},
    });
  }
  const props = { testID: 'notes', value: 'wrapped-input-private', readOnly, editable: !readOnly };
  const fixture = setup({ ...props, onChange() {} });
  for (const [type, tag] of [
    [forward, 11],
    [memo, 14],
  ] as const) {
    const wrapper = buildFiber({ props: { ...props } });
    wrapper.type = type;
    wrapper.tag = tag;
    wrapper.child = fixture.root.current;
    fixture.root.current.return = wrapper;
    fixture.root.current = wrapper;
  }
  const native = async () => ({
    nodes: [
      {
        ref: '@notes',
        type: 'Other',
        identifier: 'notes',
        label: 'Notes',
        hittable: true,
        enabled: true,
      },
      { ref: '@echo', type: 'StaticText', label: 'wrapped-input-private', hittable: true },
    ],
  });
  const react = () =>
    captureQaReact({
      async withPrivateHelperWorld(run) {
        return run(async (expression) => vm.runInContext(expression, fixture.sandbox));
      },
    });
  return { ...fixture, memo, forward, TextInput, native, react, namesRead: () => namesRead };
}

test('wrapped TextInput preserves quoted typing through producer, adapter, capture and walker', async () => {
  const fixture = wrappedInput();
  const legacy = await captureScreen({
    native: fixture.native,
    react: async () =>
      JSON.parse(fixture.api.getTree({ interactiveOnly: true, semanticEvidence: true })),
  });
  assert.equal(legacy.elements.find((element) => element.ref === '@notes')?.kind, 'input');
  const nameReads = fixture.namesRead();
  assert.ok(nameReads > 0, 'legacy producer reads the configured dev displayName');
  const capture = () =>
    captureScreen({ requirePrivateInputs: true, native: fixture.native, react: fixture.react });
  const observed = await capture();
  const judge = scriptedJudge(() => assert.fail('unique quoted fill must stay model-free'));
  const walk = walker([], judge);
  walk.deps.captureScreen = capture;
  walk.deps.screenshot = async () => assert.fail('private input pixels must be withheld');
  const plan = parsePlan('1. Type "x" into "notes"');
  assert.ok(plan.blocks);
  const result = await runPlan(plan.blocks, walk.deps);
  assert.equal(
    result.verdict,
    'PASS',
    `private kind=${observed.elements.find((element) => element.ref === '@notes')?.kind}; actions=${walk.actions.join(',')}`,
  );
  assert.deepEqual(walk.actions, ['fill @notes x']);
  assert.equal(observed.elements.find((element) => element.ref === '@notes')?.kind, 'input');
  assert.equal(fixture.namesRead(), nameReads, 'private capture never reads the type accessors');
  assert.ok(inputValues(observed).includes('wrapped-input-private'));
  assert.doesNotMatch(
    JSON.stringify({ result, rows: walk.rows, outbound: judge.requests }),
    /wrapped-input-private/,
  );
});

test('readonly wrapped TextInput keeps input identity but quoted typing cannot act', async () => {
  const fixture = wrappedInput(true);
  const capture = () =>
    captureScreen({ requirePrivateInputs: true, native: fixture.native, react: fixture.react });
  const observed = await capture();
  const notes = observed.elements.find((element) => element.ref === '@notes');
  assert.equal(notes?.kind, 'input');
  assert.equal(notes?.disabled, true);
  const walk = walker(
    [],
    scriptedJudge(() => assert.fail('disabled quoted input must not be judged')),
  );
  walk.deps.captureScreen = capture;
  walk.deps.screenshot = async () =>
    assert.fail('private input pixels must be withheld on failure');
  const plan = parsePlan('1. Type "x" into "notes"');
  assert.ok(plan.blocks);
  const result = await runPlan(plan.blocks, walk.deps);
  assert.equal(result.verdict, 'FAIL');
  assert.deepEqual(walk.actions, []);
  assert.doesNotMatch(JSON.stringify({ result, rows: walk.rows }), /wrapped-input-private/);
  assert.equal(fixture.namesRead(), 0);
});

test('resolved wrapper names do not invent native roles in presence mode or bypass missing private capture', async () => {
  const fixture = wrappedInput();
  const native = nativeCapture();
  Object.assign(native.nodes[1], {
    ref: '@notes',
    type: 'Other',
    identifier: 'notes',
    label: 'Notes',
  });
  const observation = await fixture.react();
  assert.equal(
    observation.interactive?.find((entry) => entry.testID === 'notes')?.role,
    'textinput',
  );
  assert.equal(observation.hostEvidence.hosts[0].role, null);
  assert.equal(observation.hostEvidence.hosts[0].roleSource, 'none');
  const observed = await captureScreen({
    requirePrivateInputs: true,
    appId: 'com.test',
    native: async () => native,
    react: async () => observation,
  });
  const notes = observed.elements.find((element) => element.ref === '@notes');
  assert.equal(notes?.kind, 'other');
  assert.equal(notes?.semantic?.nativePresence?.kind, 'other');
  const walk = walker(
    [],
    scriptedJudge(() => assert.fail('missing private capture must not be judged')),
  );
  walk.deps.captureScreen = () =>
    captureScreen({
      requirePrivateInputs: true,
      native: fixture.native,
      react: async () =>
        JSON.parse(fixture.api.getTree({ interactiveOnly: true, semanticEvidence: true })),
    });
  walk.deps.screenshot = async () =>
    assert.fail('missing private capture cannot authorize a screenshot');
  const plan = parsePlan('1. Type "x" into "notes"');
  assert.ok(plan.blocks);
  const result = await runPlan(plan.blocks, walk.deps);
  assert.equal(result.verdict, 'REFUSED');
  assert.deepEqual(walk.actions, []);
  assert.doesNotMatch(JSON.stringify(result), /wrapped-input-private/);
});

function privateNamedType(type: unknown) {
  const fixture = wrappedInput();
  fixture.root.current.type = type;
  fixture.root.current.memoizedProps.onChange = () => {};
  fixture.root.current.child = fixture.fiber;
  fixture.fiber.return = fixture.root.current;
  const result = fixture.api.beginQaCapture();
  assert.equal(result.state, 'ready');
  assert.deepEqual(plain(result.inputs.facts), [
    { hostIndex: 0, values: ['wrapped-input-private'], secure: false },
  ]);
  return JSON.parse(result.tree).interactive.find(
    (entry: { testID?: string }) => entry.testID === 'notes',
  );
}

test('private names follow at most two own-data React wrapper links with own-name precedence', () => {
  function TextInput() {
    assert.fail('render or worklet must not execute');
  }
  const forward = { $$typeof: Symbol.for('react.forward_ref'), render: TextInput };
  const memo = { $$typeof: Symbol.for('react.memo'), type: forward };
  for (const type of [TextInput, forward, memo])
    assert.equal(privateNamedType(type).role, 'textinput');
  assert.equal(privateNamedType({ ...memo, displayName: 'Button' }).role, 'button');
  assert.equal(privateNamedType({ ...memo, name: 'Switch' }).role, 'switch');
  assert.equal(privateNamedType({ $$typeof: Symbol.for('react.memo'), type: memo }).role, 'button');
  const cycle = { $$typeof: Symbol.for('react.memo'), type: null as unknown };
  cycle.type = cycle;
  assert.equal(privateNamedType(cycle).role, 'button');
  assert.equal(privateNamedType(Symbol.for('react.fragment')).role, 'button');
});

test('private wrapper traversal never executes accessors or follows inherited or unrecognized links', () => {
  function TextInput() {
    assert.fail('render must not execute');
  }
  let calls = 0;
  const getter = () => {
    calls++;
    throw new Error('wrapper-canary');
  };
  const forward = { $$typeof: Symbol.for('react.forward_ref') };
  Object.defineProperty(forward, 'render', { get: getter });
  const memo = { $$typeof: Symbol.for('react.memo') };
  Object.defineProperty(memo, 'type', { get: getter });
  const accessorMarker = { type: TextInput };
  Object.defineProperty(accessorMarker, '$$typeof', { get: getter });
  const inheritedMarker = Object.assign(Object.create({ $$typeof: Symbol.for('react.memo') }), {
    type: TextInput,
  });
  const inheritedLink = Object.assign(Object.create({ type: TextInput }), {
    $$typeof: Symbol.for('react.memo'),
  });
  const failedProxy = new Proxy(
    {},
    {
      getOwnPropertyDescriptor() {
        throw new Error('proxy-canary');
      },
    },
  );
  for (const type of [
    forward,
    memo,
    accessorMarker,
    inheritedMarker,
    inheritedLink,
    failedProxy,
    { type: TextInput, render: TextInput },
    { $$typeof: Symbol.for('not.react.memo'), type: TextInput },
  ])
    assert.equal(privateNamedType(type).role, 'button');
  assert.equal(calls, 0);
});

test('recognized wrapper descriptor work is bounded without ordinary property reads', () => {
  let descriptors = 0;
  function TextInput() {
    assert.fail('render must not execute');
  }
  function counted(type: object) {
    return new Proxy(type, {
      getOwnPropertyDescriptor(target, key) {
        descriptors++;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
      get() {
        assert.fail('ordinary type property read');
      },
    });
  }
  const forward = counted({
    $$typeof: Symbol.for('react.forward_ref'),
    render: counted(TextInput),
  });
  const memo = counted({ $$typeof: Symbol.for('react.memo'), type: forward });
  assert.equal(privateNamedType(memo).role, 'textinput');
  assert.ok(descriptors > 0 && descriptors <= 60, `descriptor reads: ${descriptors}`);
});

function devTypes(readName: () => string) {
  function InternalTextInput() {}
  const forward = { $$typeof: Symbol.for('react.forward_ref'), render: InternalTextInput };
  const memo = { $$typeof: Symbol.for('react.memo'), type: forward, compare: null };
  const context = { $$typeof: Symbol.for('react.context') };
  const consumer = { $$typeof: Symbol.for('react.consumer'), _context: context };
  function ClassOwner() {}
  const host = {};
  for (const type of [forward, memo, consumer, host]) {
    Object.defineProperty(type, 'displayName', {
      configurable: true,
      get: readName,
      set() {},
    });
  }
  Object.defineProperty(ClassOwner, 'name', { get: readName });
  return { forward, memo, consumer, ClassOwner, host };
}

function devTree(readName: () => string) {
  const fixture = setup({ value: 'dev-private', readOnly: true, onChange() {} });
  const types = devTypes(readName);
  fixture.fiber.type = types.host;
  fixture.fiber.stateNode = {
    canonical: {
      viewConfig: { uiViewClassName: 'RCTTextInput' },
      publicInstance: {
        measureInWindow(done: (...rect: number[]) => void) {
          queueMicrotask(() => done(0, 0, 100, 30));
        },
      },
    },
  };
  for (const [type, tag] of [
    [types.forward, 11],
    [types.memo, 14],
    [types.consumer, 9],
    [types.ClassOwner, 1],
    [Symbol.for('react.fragment'), 7],
    [Symbol.for('react.strict_mode'), 8],
  ] as const) {
    const wrapper = buildFiber({});
    wrapper.type = type;
    wrapper.tag = tag;
    wrapper.child = fixture.root.current;
    fixture.root.current.return = wrapper;
    fixture.root.current = wrapper;
  }
  return fixture;
}

test('private capture traverses React dev wrappers and symbols without reading type-name accessors', async () => {
  for (const throwing of [false, true]) {
    for (const typography of [false, true]) {
      let calls = 0;
      const { api } = devTree(() => {
        calls++;
        if (throwing) throw new Error('type-name-canary');
        return 'TextInput';
      });
      const begin = api.beginQaCapture(typography);
      assert.equal(calls, 0);
      assert.equal(begin.inputs.complete, true);
      assert.deepEqual(plain(begin.inputs.facts), [
        { hostIndex: 0, values: ['dev-private'], secure: false },
      ]);
      await tick();
      const result = begin.state === 'ready' ? begin : api.readQaCapture(begin.id);
      assert.equal(result.state, 'ready');
      assert.doesNotMatch(result.tree, /dev-private|type-name-canary/);
      assert.equal(calls, 0);
    }
  }
});

test('React dev wrapper producer reaches private adapter and masks a native echo', async () => {
  for (const typography of [false, true]) {
    const { sandbox } = devTree(() => assert.fail('type accessor executed'));
    const observation = await captureQaReact(
      {
        async withPrivateHelperWorld(run) {
          return run(async (expression) => vm.runInContext(expression, sandbox));
        },
      },
      typography,
    );
    const screen = await captureScreen({
      requirePrivateInputs: true,
      react: async () => observation,
      native: async () => ({ nodes: [{ ref: '@echo', type: 'StaticText', label: 'dev-private' }] }),
    });
    assert.ok(inputValues(screen).includes('dev-private'));
    const privacy = new ObservedPrivacy();
    privacy.observe(screen);
    assert.equal(privacy.redact('dev-private'), '•••');
    assert.doesNotMatch(JSON.stringify(observation), /dev-private/);
  }
});

test('private name resolution has a fixed descriptor budget and never executes accessors or unrecognized wrapper metadata', async () => {
  for (const typography of [false, true]) {
    let descriptors = 0;
    let reads = 0;
    const source = Object.create({
      get displayName() {
        reads++;
        throw new Error('inherited-name');
      },
    });
    Object.defineProperties(source, {
      name: {
        get() {
          reads++;
          throw new Error('name');
        },
      },
      render: {
        get() {
          reads++;
          throw new Error('render');
        },
      },
      type: {
        get() {
          reads++;
          throw new Error('type');
        },
      },
    });
    const type = new Proxy(source, {
      getOwnPropertyDescriptor(target, key) {
        descriptors++;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
      get() {
        reads++;
        throw new Error('type property read');
      },
    });
    const fixture = setup({ value: 'bounded-private' });
    const wrapper = buildFiber({ props: { onPress() {} } });
    wrapper.type = type;
    wrapper.tag = 0;
    wrapper.child = fixture.fiber;
    fixture.fiber.return = wrapper;
    fixture.root.current = wrapper;
    const begin = fixture.api.beginQaCapture(typography);
    await tick();
    assert.equal(
      (begin.state === 'ready' ? begin : fixture.api.readQaCapture(begin.id)).state,
      'ready',
    );
    assert.equal(reads, 0);
    assert.ok(descriptors > 0 && descriptors <= 16, `descriptor reads: ${descriptors}`);
  }
});

test('private captures retain fixed refusals for data-named error overlays', () => {
  for (const name of ['LogBox', 'ErrorWindow', 'RedBox']) {
    const fixture = setup({ value: 'overlay-private' });
    const overlay = buildFiber({ name });
    overlay.child = fixture.fiber;
    fixture.fiber.return = overlay;
    fixture.root.current = overlay;
    const capture = fixture.api.beginQaCapture();
    assert.equal(capture.state, 'refused');
    assert.deepEqual(plain(capture.inputs), { version: 1, complete: false, facts: [] });
    assert.equal(capture.tree, undefined);
  }
});

test('version 85 replaces a warm 84 helper and reinjection preserves the private API', () => {
  const { sandbox } = setup({ value: '' });
  sandbox.__QAREN = { __v: 84 };
  vm.runInContext(INJECTED_HELPERS, sandbox);
  const upgraded = sandbox.__QAREN;
  assert.equal(upgraded.__v, 85);
  assert.equal(typeof upgraded.beginQaCapture, 'function');
  assert.equal(typeof upgraded.readQaCapture, 'function');
  vm.runInContext(INJECTED_HELPERS, sandbox);
  assert.equal(sandbox.__QAREN, upgraded);
});

test('private begin captures anonymous disabled input bytes once without exposing the channel', () => {
  const { api, sandbox } = setup({
    value: ' x ',
    text: '密',
    defaultValue: '\t',
    secureTextEntry: true,
    readOnly: true,
    disabled: true,
  });
  const result = api.beginQaCapture();
  assert.equal(result.v, 1);
  assert.match(result.id, /^[a-f0-9]{1,32}$/);
  assert.equal(result.state, 'ready');
  assert.deepEqual(plain(result.inputs), {
    version: 1,
    complete: true,
    facts: [{ hostIndex: 0, values: [' x ', '密', '\t'], secure: true }],
  });
  assert.equal(typeof result.tree, 'string');
  assert.equal(result.tree.includes('密'), false);
  assert.deepEqual(plain(api.readQaCapture(result.id)), {
    v: 1,
    id: result.id,
    state: 'refused',
  });
  assert.equal(Object.keys(api).includes('beginQaCapture'), false);
  assert.equal(Object.keys(api).includes('readQaCapture'), false);
  assert.equal(vm.runInContext('JSON.stringify(__QAREN)', sandbox).includes('密'), false);
});

test('native aliases and Fabric canonical types use actual host props, never composite names', () => {
  for (const hostType of [
    'TextInput',
    'RCTTextInput',
    'RCTSinglelineTextInputView',
    'RCTMultilineTextInputView',
    'AndroidTextInput',
  ]) {
    const { api, fiber } = setup({ value: ' a\n密 ', secureTextEntry: null }, hostType);
    if (hostType === 'RCTTextInput') {
      fiber.type = { displayName: 'Anonymous' };
      fiber.stateNode = {
        canonical: { viewConfig: { uiViewClassName: hostType } },
      };
    }
    assert.deepEqual(plain(api.beginQaCapture().inputs), {
      version: 1,
      complete: true,
      facts: [{ hostIndex: 0, values: [' a\n密 '], secure: false }],
    });
  }
  const { api, fiber } = setup({ value: 'composite-only' });
  fiber.type = { displayName: 'TextInput' };
  fiber.tag = 0;
  assert.deepEqual(plain(api.beginQaCapture().inputs), {
    version: 1,
    complete: true,
    facts: [],
  });
});

test('public default, semantic and typography trees cannot opt into private input props', async () => {
  const { api, fiber } = setup({
    value: 'value-secret',
    text: 'text-secret',
    defaultValue: 'default-secret',
    secureTextEntry: true,
  });
  const wrapper = buildFiber({ name: 'TextInput', props: fiber.memoizedProps });
  wrapper.child = fiber;
  fiber.return = wrapper;
  const sandbox = createSandbox({ fiberRoot: wrapper });
  for (const opts of [
    {},
    { interactiveOnly: true, semanticEvidence: true },
    { interactiveOnly: true, semanticEvidence: true, typographyEvidence: true },
  ]) {
    const tree = await sandbox.__QAREN.getTree(
      { ...opts, privateInputs: true, privateCapture: true },
      { private: true },
    );
    assert.doesNotMatch(tree, /(?:value|text|default)-secret|"secureTextEntry"|"inputs"/);
  }
  assert.equal(api.__v, 85);
});

test('getter, inherited, opaque and invalid inputs refuse without executing getters or coercions', () => {
  let calls = 0;
  const evil = {
    toString() {
      calls++;
      throw new Error('secret');
    },
  };
  const fixtures = [
    { value: evil },
    { value: false },
    { value: '', text: 12 },
    { value: '', defaultValue: [] },
    { secureTextEntry: 'true' },
    Object.create({ value: 'secret' }),
    Object.defineProperty({}, 'value', {
      get() {
        calls++;
        throw new Error('secret');
      },
    }),
    Object.defineProperty({}, 'secureTextEntry', {
      get() {
        calls++;
        throw new Error('secret');
      },
    }),
  ];
  for (const props of fixtures) {
    const result = setup(props).api.beginQaCapture();
    assert.equal(result.state, 'refused');
    assert.deepEqual(plain(result.inputs), {
      version: 1,
      complete: false,
      facts: [],
    });
    assert.equal(result.tree, undefined);
    assert.doesNotMatch(JSON.stringify(result), /secret/);
  }
  assert.equal(calls, 0);
});

test('complete empty differs from unknown coverage, and switches stay non-inputs', () => {
  const { api, sandbox } = setup({ value: true, onChange() {} }, 'RCTSwitch');
  assert.deepEqual(plain(api.beginQaCapture().inputs), {
    version: 1,
    complete: true,
    facts: [],
  });
  sandbox.__REACT_DEVTOOLS_GLOBAL_HOOK__.renderers.set(2, {});
  const original = sandbox.__REACT_DEVTOOLS_GLOBAL_HOOK__.getFiberRoots;
  sandbox.__REACT_DEVTOOLS_GLOBAL_HOOK__.getFiberRoots = (id: number) => {
    if (id === 2) throw new Error('secret');
    return original(id);
  };
  assert.equal(api.beginQaCapture().inputs.complete, false);
  assert.equal(createSandbox().__QAREN.beginQaCapture().state, 'refused');
  const unknown = setup(
    { value: 'private', onChange() {} },
    'UnrecognizedNativeInput',
  ).api.beginQaCapture();
  assert.deepEqual(plain(unknown.inputs.facts), [
    { hostIndex: 0, values: ['private'], secure: false },
  ]);
});

function withChildren(count: number, props: Record<string, unknown>) {
  const fixture = setup({}, 'RCTView');
  let previous = null;
  for (let i = 0; i < count; i++) {
    const child = buildFiber({ hostType: 'RCTTextInput', props: { ...props } }, fixture.fiber);
    child.tag = 5;
    if (previous) previous.sibling = child;
    else fixture.fiber.child = child;
    previous = child;
  }
  return fixture;
}

test('non-input numeric and opaque object values coexist with a private input without coercion', async () => {
  let coercions = 0;
  const opaque = {
    toString() {
      coercions++;
      throw new Error('object-canary');
    },
  };
  for (const [hostType, value] of [
    ['RNCSlider', 0.5],
    ['RCTSlider', 42],
    ['NativeSelection', opaque],
    ['RCTSwitch', true],
  ] as const) {
    for (const typography of [false, true]) {
      const fixture = withChildren(2, {});
      const control = fixture.fiber.child;
      control.type = hostType;
      control.memoizedProps = { value, onChange() {} };
      control.sibling.memoizedProps = { value: 'input-next-to-slider', secureTextEntry: true };
      const begin = fixture.api.beginQaCapture(typography);
      assert.equal(begin.inputs.complete, true, hostType);
      assert.deepEqual(plain(begin.inputs.facts), [
        { hostIndex: 2, values: ['input-next-to-slider'], secure: true },
      ]);
      await tick();
      const result = begin.state === 'ready' ? begin : fixture.api.readQaCapture(begin.id);
      assert.equal(result.state, 'ready');
      const observation = await captureQaReact(
        {
          async withPrivateHelperWorld(run) {
            return run(async (expression) => vm.runInContext(expression, fixture.sandbox));
          },
        },
        typography,
      );
      const screen = await captureScreen({
        requirePrivateInputs: true,
        react: async () => observation,
        native: async () => ({
          nodes: [{ ref: '@echo', type: 'StaticText', label: 'input-next-to-slider' }],
        }),
      });
      assert.deepEqual(inputValues(screen), ['input-next-to-slider']);
      const privacy = new ObservedPrivacy();
      privacy.observe(screen);
      assert.equal(privacy.redact('input-next-to-slider'), '•••');
    }
  }
  assert.equal(coercions, 0);
});

test('known inputs and positive private hints still refuse non-string input values', () => {
  for (const value of [17, false, {}]) {
    assert.equal(setup({ value }).api.beginQaCapture().state, 'refused');
    for (const hint of [
      { secureTextEntry: false },
      { text: 'text' },
      { defaultValue: 'initial' },
      { onChangeText() {} },
    ]) {
      const result = setup({ ...hint, value }, 'UnrecognizedNativeControl').api.beginQaCapture();
      assert.equal(result.state, 'refused');
      assert.deepEqual(plain(result.inputs), { version: 1, complete: false, facts: [] });
    }
  }
  const unknown = setup(
    { value: 'unknown-private' },
    'UnrecognizedNativeControl',
  ).api.beginQaCapture();
  assert.deepEqual(plain(unknown.inputs.facts), [
    { hostIndex: 0, values: ['unknown-private'], secure: false },
  ]);
});

test('value, aggregate, host and fiber bounds refuse instead of truncating complete facts', () => {
  assert.equal(setup({ value: 'x'.repeat(4096) }).api.beginQaCapture().state, 'ready');
  assert.equal(setup({ value: 'x'.repeat(4097) }).api.beginQaCapture().state, 'refused');
  assert.equal(withChildren(4, { value: 'x'.repeat(4096) }).api.beginQaCapture().state, 'ready');
  assert.equal(withChildren(5, { value: 'x'.repeat(4096) }).api.beginQaCapture().state, 'refused');
  assert.equal(withChildren(198, { value: 'x' }).api.beginQaCapture().state, 'ready');
  assert.equal(withChildren(199, { value: 'x' }).api.beginQaCapture().state, 'refused');
  const { api, fiber } = setup({ value: '' });
  assert.equal(api.beginQaCapture().state, 'ready');
  fiber.child = fiber;
  assert.equal(api.beginQaCapture().state, 'refused');
});

async function tick() {
  await Promise.resolve();
  await Promise.resolve();
}

function pendingCapture() {
  const fixture = setup({ value: 'private-secret', secureTextEntry: true });
  let complete: (...args: number[]) => void = () => {};
  fixture.fiber.stateNode = {
    measureInWindow(cb: typeof complete) {
      complete = cb;
    },
  };
  return { ...fixture, complete: () => complete(0, 0, 100, 30) };
}

test('pending capture carries facts only in begin and ready polling consumes once', async () => {
  const { api, sandbox, complete } = pendingCapture();
  const begin = api.beginQaCapture(true);
  assert.equal(begin.state, 'pending');
  assert.equal(begin.inputs.complete, true);
  assert.deepEqual(plain(api.readQaCapture(begin.id)), {
    v: 1,
    id: begin.id,
    state: 'pending',
  });
  for (const key of Object.keys(sandbox).filter((key) => key.startsWith('__QAREN'))) {
    assert.doesNotMatch(JSON.stringify(sandbox[key]), /private-secret/);
  }
  complete();
  await tick();
  const ready = api.readQaCapture(begin.id);
  assert.equal(ready.state, 'ready');
  assert.equal('inputs' in ready, false);
  assert.doesNotMatch(ready.tree, /private-secret/);
  assert.equal(api.readQaCapture(begin.id).state, 'refused');
});

test('in-place input mutation and root replacement refuse after typography', async () => {
  for (const mutate of [
    (f: ReturnType<typeof pendingCapture>) => {
      f.fiber.memoizedProps.value = 'changed';
    },
    (f: ReturnType<typeof pendingCapture>) => {
      f.fiber.memoizedProps.secureTextEntry = false;
    },
    (f: ReturnType<typeof pendingCapture>) => {
      f.root.current = buildFiber({ hostType: 'RCTView' });
    },
  ]) {
    const fixture = pendingCapture();
    const begin = fixture.api.beginQaCapture(true);
    mutate(fixture);
    fixture.complete();
    await tick();
    assert.deepEqual(plain(fixture.api.readQaCapture(begin.id)), {
      v: 1,
      id: begin.id,
      state: 'refused',
    });
  }
});

test('supersession cancels old captures and ignores late callbacks', async () => {
  const { api, complete } = pendingCapture();
  const first = api.beginQaCapture(true);
  const second = api.beginQaCapture();
  assert.equal(second.state, 'ready');
  complete();
  await tick();
  assert.equal(api.readQaCapture(first.id).state, 'refused');
  assert.equal(api.readQaCapture(second.id).state, 'refused');
});

function clock(fixture: ReturnType<typeof pendingCapture>) {
  let now = 100;
  let sequence = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  fixture.sandbox.Date = { now: () => now };
  fixture.sandbox.setTimeout = (run: () => void, delay: number) => {
    const id = ++sequence;
    timers.set(id, { at: now + delay, run });
    return id;
  };
  fixture.sandbox.clearTimeout = (id: number) => timers.delete(id);
  return {
    timers,
    advance(ms: number) {
      now += ms;
      for (const [id, timer] of timers) {
        if (timer.at <= now && timers.delete(id)) timer.run();
      }
    },
  };
}

test('producer deadline and abandonment expiry clear slots and reject late completion', async () => {
  const fixture = pendingCapture();
  const time = clock(fixture);
  const first = fixture.api.beginQaCapture(true);
  time.advance(1000);
  fixture.complete();
  await tick();
  assert.deepEqual(plain(fixture.api.readQaCapture(first.id)), {
    v: 1,
    id: first.id,
    state: 'refused',
  });
  assert.equal(time.timers.size, 0);
  const next = fixture.api.beginQaCapture(true);
  time.advance(1500);
  fixture.complete();
  await tick();
  assert.equal(fixture.api.readQaCapture(next.id).state, 'refused');
  assert.equal(time.timers.size, 0);
});

test('ready-but-unread capture expires, while typography false never measures', async () => {
  const fixture = pendingCapture();
  const time = clock(fixture);
  const begin = fixture.api.beginQaCapture(true);
  fixture.complete();
  await tick();
  time.advance(1500);
  assert.equal(fixture.api.readQaCapture(begin.id).state, 'refused');
  let measurements = 0;
  fixture.fiber.stateNode.measureInWindow = () => {
    measurements++;
  };
  assert.equal(fixture.api.beginQaCapture(false).state, 'ready');
  assert.equal(measurements, 0);
  assert.equal(time.timers.size, 0);
});

test('unsupported typography style alone does not make private input coverage incomplete', async () => {
  const fixture = withChildren(1, { value: 'private' });
  fixture.fiber.type = 'RCTText';
  fixture.fiber.memoizedProps.style = 123;
  const begin = fixture.api.beginQaCapture(true);
  assert.equal(begin.inputs.complete, true);
  await tick();
  const result = fixture.api.readQaCapture(begin.id);
  assert.equal(result.state, 'ready');
  assert.equal(JSON.parse(result.tree).hostEvidence.typography.nodes[0].text.kind, 'unsupported');
});

test('capture refuses malformed roots, root overflow and unknown root registries', () => {
  for (const count of [1, 101]) {
    const { api, sandbox, fiber } = setup({ value: '' });
    assert.equal(api.beginQaCapture().state, 'ready');
    sandbox.__REACT_DEVTOOLS_GLOBAL_HOOK__.getFiberRoots = (id: number) =>
      id === 1
        ? new Set(Array.from({ length: count }, () => (count === 1 ? {} : { current: fiber })))
        : new Set();
    assert.equal(api.beginQaCapture().state, 'refused');
  }
  const { api, sandbox } = setup({ value: '' });
  assert.equal(api.beginQaCapture().state, 'ready');
  sandbox.__REACT_DEVTOOLS_GLOBAL_HOOK__.renderers = {};
  assert.equal(api.beginQaCapture().state, 'refused');
});

test('malformed root and fiber accessors refuse without executing them', () => {
  for (const field of ['memoizedProps', 'type', 'child', 'stateNode']) {
    let calls = 0;
    const { api, fiber } = setup({ value: '' });
    assert.equal(api.beginQaCapture().state, 'ready');
    Object.defineProperty(fiber, field, {
      get() {
        calls++;
        throw new Error('secret');
      },
    });
    assert.equal(api.beginQaCapture().state, 'refused');
    assert.equal(calls, 0);
  }
  let calls = 0;
  const { api, root } = setup({ value: '' });
  assert.equal(api.beginQaCapture().state, 'ready');
  Object.defineProperty(root, 'current', {
    get() {
      calls++;
      throw new Error('secret');
    },
  });
  assert.equal(api.beginQaCapture().state, 'refused');
  assert.equal(calls, 0);
});

test('root object replacement, renderer coverage drift and public host identity mutation refuse', async () => {
  for (const mutate of [
    (f: ReturnType<typeof pendingCapture>) => {
      f.sandbox.__REACT_DEVTOOLS_GLOBAL_HOOK__.getFiberRoots = (id: number) =>
        id === 1 ? new Set([{ current: f.fiber }]) : new Set();
    },
    (f: ReturnType<typeof pendingCapture>) => {
      f.sandbox.__REACT_DEVTOOLS_GLOBAL_HOOK__.renderers.set(2, {});
    },
    (f: ReturnType<typeof pendingCapture>) => {
      f.fiber.memoizedProps.testID = 'changed';
    },
  ]) {
    const fixture = pendingCapture();
    const begin = fixture.api.beginQaCapture(true);
    mutate(fixture);
    fixture.complete();
    await tick();
    assert.equal(fixture.api.readQaCapture(begin.id).state, 'refused');
  }
});

test('empty and absent strings preserve exact facts and unsupported anonymous inputs stay private', () => {
  const { api, fiber } = setup({
    value: '',
    text: undefined,
    defaultValue: null,
    secureTextEntry: false,
  });
  assert.deepEqual(plain(api.beginQaCapture().inputs.facts), [
    { hostIndex: 0, values: [''], secure: false },
  ]);
  fiber.type = null;
  fiber.memoizedProps = { value: '密', secureTextEntry: true, readOnly: true };
  assert.deepEqual(plain(api.beginQaCapture().inputs.facts), [
    { hostIndex: 0, values: ['密'], secure: true },
  ]);
});

test('public full tree omits Fabric input props even with an unrelated host display name', () => {
  const { api, fiber } = setup({ value: 'fabric-private' });
  fiber.type = { displayName: 'AnonymousNativeHost' };
  fiber.stateNode = { canonical: { viewConfig: { uiViewClassName: 'RCTTextInput' } } };
  assert.doesNotMatch(api.getTree({ privateInputs: true }), /fabric-private/);
});

function readonlyField(props: Record<string, unknown>) {
  const fixture = setup({ value: 'host-private', readOnly: true, onChange() {} });
  const forward = devTypes(() => 'TextInput').forward;
  const internal = buildFiber({
    props: { value: 'internal-private', readOnly: true, onChange() {} },
  });
  internal.type = forward.render;
  internal.tag = 0;
  internal.child = fixture.fiber;
  fixture.fiber.return = internal;
  const devWrapper = buildFiber({
    props: { value: 'wrapper-private', readOnly: true, onChange() {} },
  });
  devWrapper.type = forward;
  devWrapper.tag = 11;
  devWrapper.child = internal;
  internal.return = devWrapper;
  const field = buildFiber({
    name: 'Field',
    props: { testID: 'field', readOnly: true, onChange() {}, ...props },
  });
  field.child = devWrapper;
  devWrapper.return = field;
  const text = buildFiber({ text: 'Visible ordinary text' }, field);
  text.tag = 6;
  devWrapper.sibling = text;
  fixture.root.current = field;
  return { ...fixture, field };
}

test('public full and filtered trees suppress readonly InternalTextInput and Field value props', () => {
  const { api } = readonlyField({ value: 'field-private' });
  for (const opts of [{}, { filter: 'field' }]) {
    const tree = api.getTree(opts);
    assert.doesNotMatch(tree, /(?:host|internal|wrapper|field)-private/);
    assert.match(tree, /Visible ordinary text/);
    assert.doesNotMatch(tree, /"inputs"|"facts"/);
  }
});

test('public full and filtered trees skip suppressed prop accessors before reading them', () => {
  for (const key of ['value', 'text', 'defaultValue', 'secureTextEntry']) {
    for (const opts of [{}, { filter: 'field' }]) {
      let calls = 0;
      const { api, field } = readonlyField({});
      Object.defineProperty(field.memoizedProps, key, {
        enumerable: true,
        get() {
          calls++;
          throw new Error('suppressed-prop-canary');
        },
      });
      const tree = api.getTree(opts);
      assert.equal(calls, 0);
      assert.doesNotMatch(tree, /suppressed-prop-canary|(?:host|internal|wrapper)-private/);
    }
  }
});

test('public full trees retain boolean switch values and ordinary visible text children', () => {
  const root = buildFiber({
    name: 'Switch',
    props: { value: false },
    children: [{ text: 'Visible text' }],
  });
  root.child.tag = 6;
  const sandbox = createSandbox({ fiberRoot: root });
  const tree = JSON.parse(sandbox.__QAREN.getTree({}));
  assert.equal(tree.tree.props.value, false);
  assert.deepEqual(tree.tree.children, [{ text: 'Visible text' }]);
});

test('wide fiber enqueue and cyclic siblings terminate with fixed refusal', () => {
  const fixture = setup({}, 'RCTView');
  let previous = null;
  for (let i = 0; i < 5001; i++) {
    const child = buildFiber({ name: 'Wrapper' }, fixture.fiber);
    child.tag = 0;
    if (previous) previous.sibling = child;
    else fixture.fiber.child = child;
    previous = child;
  }
  assert.equal(fixture.api.beginQaCapture().state, 'refused');
  fixture.fiber.child.sibling = fixture.fiber.child;
  assert.equal(fixture.api.beginQaCapture().state, 'refused');
});

test('begin facts cannot be mutated to change later readiness or private stability', async () => {
  const fixture = pendingCapture();
  const begin = fixture.api.beginQaCapture(true);
  begin.inputs.complete = false;
  begin.inputs.facts[0].values[0] = 'edited';
  fixture.complete();
  await tick();
  assert.equal(fixture.api.readQaCapture(begin.id).state, 'ready');
});

test('revalidation never invokes a newly installed private getter or exposes its error', async () => {
  const fixture = pendingCapture();
  let calls = 0;
  const begin = fixture.api.beginQaCapture(true);
  Object.defineProperty(fixture.fiber.memoizedProps, 'value', {
    get() {
      calls++;
      throw new Error('private-secret');
    },
  });
  fixture.complete();
  await tick();
  assert.deepEqual(plain(fixture.api.readQaCapture(begin.id)), {
    v: 1,
    id: begin.id,
    state: 'refused',
  });
  assert.equal(calls, 0);
});
