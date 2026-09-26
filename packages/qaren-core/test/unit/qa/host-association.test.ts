import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { captureScreen } from '../../../dist/qa/capture.js';
import { parsePlan } from '../../../dist/qa/plan.js';
import { decideScreen } from '../../../dist/qa/resolve.js';
import { inputValues, isPossibleInput } from '../../../dist/qa/privacy.js';
import { runPlan } from '../../../dist/qa/walker.js';
import { join, semanticActionView, visibilityView } from '../../../dist/qa/screen.js';
import type { DigestEntry, ReactHostEvidence } from '../../../dist/qa/screen.js';
import { nativeCapture } from './platform-presence-fixtures.ts';
import { buildFiber, createSandbox } from '../helpers/inject-harness.js';
import { choice, scriptedJudge, walker } from './judgment-fixtures.ts';

function fixture() {
  const native = nativeCapture();
  native.nodes = [
    native.nodes[0],
    {
      ...native.nodes[1],
      type: 'Window',
      identifier: undefined,
      label: '',
      rect: { x: 20, y: 40, width: 400, height: 800 },
    },
    {
      ...native.nodes[1],
      ref: '@e2',
      index: 2,
      parentIndex: 1,
      depth: 2,
      type: 'Other',
      rect: { x: 30, y: 60, width: 100, height: 40 },
      presence: { ...native.nodes[1].presence, nodeIndex: 2 },
    },
  ];
  native.snapshotVerdict.nodeCount = 3;
  const hostEvidence: ReactHostEvidence = {
    complete: true,
    hosts: [{ testID: 'save', role: null, roleSource: 'none', capabilities: { press: true } }],
    typography: {
      version: 1,
      complete: true,
      durationMs: 10,
      coordinateSpace: 'window-points',
      nodes: [
        {
          hostIndex: 0,
          parentHostIndex: null,
          rootIndex: 0,
          hostType: 'RCTView',
          rect: { x: 10, y: 20, width: 100, height: 40 },
          text: { kind: 'none' },
        },
      ],
    },
  };
  const interactive: DigestEntry[] = [];
  const capture = () =>
    captureScreen({
      appId: 'com.test',
      native: async () => native,
      react: async () => ({
        interactive,
        hostEvidence,
        verdict: { state: 'ok', path: 'interactive', complete: true },
      }),
    });
  return { native, hostEvidence, interactive, capture };
}

test('measured exact host identity admits positive press without inventing a native role', async () => {
  const screen = await fixture().capture();
  assert.equal(screen.elements[2].semantic?.press, 'supported');
  assert.equal(screen.elements[2].semantic?.fill, 'unknown');
  assert.equal(screen.elements[2].kind, 'other');
  assert.equal(screen.reactHostEvidence!.hosts[0].role, null);
  assert.deepEqual(semanticActionView(screen, 'press'), { elements: [screen.elements[2]] });
  assert.deepEqual(visibilityView(screen), { elements: [screen.elements[2]] });
});

test('associated disabled and read-only facts block both operations without erasing positive capabilities', async () => {
  for (const state of ['disabled', 'readOnly'] as const) {
    const f = fixture();
    f.hostEvidence.hosts[0][state] = true;
    f.hostEvidence.hosts[0].capabilities.fill = true;
    const screen = await f.capture();
    assert.equal(screen.elements[2].semantic?.press, 'supported');
    assert.equal(screen.elements[2].semantic?.fill, 'supported');
    assert.deepEqual(semanticActionView(screen, 'press'), { elements: [] }, state);
    assert.deepEqual(semanticActionView(screen, 'fill'), { elements: [] }, state);
    assert.deepEqual(visibilityView(screen), { elements: [screen.elements[2]] });
  }
});

test('presence mode never borrows a legacy digest role or capability, including invalid presence', async () => {
  const f = fixture();
  f.interactive.push({ testID: 'save', role: 'button', capabilities: { press: true, fill: true } });
  f.hostEvidence.hosts[0].capabilities = {};
  const screen = await f.capture();
  assert.equal(screen.elements[2].kind, 'other');
  assert.equal(screen.elements[2].semantic?.press, 'unknown');
  assert.equal(screen.elements[2].semantic?.fill, 'unknown');
  assert.ok('refuse' in semanticActionView(screen, 'press'));
  for (const presence of [undefined, 'unknown'] as const) {
    const invalid = join(
      f.native.nodes,
      f.interactive,
      'app',
      { native: 'complete', react: 'complete' },
      f.hostEvidence,
      presence,
    );
    assert.equal(invalid.elements[2].kind, 'other');
    assert.equal(invalid.elements[2].semantic?.press, 'unknown');
    assert.ok('refuse' in semanticActionView(invalid, 'press'));
  }
  const legacyNodes = f.native.nodes.map(({ presence: _, ...node }) => node);
  const legacy = join(legacyNodes, f.interactive);
  assert.equal(legacy.elements[2].kind, 'button');
  assert.equal(legacy.elements[2].semantic?.press, 'supported');
});

test('host facts do not depend on which legacy label entry matched first', async () => {
  const f = fixture();
  f.interactive.push(
    { role: 'text', label: 'Save', disabled: true },
    { role: 'button', testID: 'save', capabilities: { press: false, fill: false } },
  );
  const screen = await f.capture();
  assert.equal(screen.elements[2].semantic?.press, 'supported');
  assert.equal(screen.elements[2].semantic?.disabled, false);
  assert.equal(screen.elements[2].kind, 'other');
  assert.equal(
    screen.semanticUnassociatedReact,
    1,
    'only the anonymous digest observation remains unassociated',
  );
  assert.equal(
    screen.elements.length,
    3,
    'a proven exact native identity is not duplicated as an offscreen digest ghost',
  );
  assert.ok('refuse' in semanticActionView(screen, 'press'), 'unknown competitors remain');
});

const unproven: Array<[string, (f: ReturnType<typeof fixture>) => void]> = [
  [
    'missing host capture',
    (f) => {
      f.hostEvidence.complete = false;
    },
  ],
  [
    'missing measurements',
    (f) => {
      delete f.hostEvidence.typography;
    },
  ],
  [
    'incomplete measurements',
    (f) => {
      f.hostEvidence.typography!.complete = false;
    },
  ],
  [
    'missing frame',
    (f) => {
      delete f.hostEvidence.typography!.nodes[0].rect;
    },
  ],
  [
    'different frame',
    (f) => {
      f.hostEvidence.typography!.nodes[0].rect!.x++;
    },
  ],
  [
    'nativeID only',
    (f) => {
      f.hostEvidence.hosts[0].nativeID = 'save';
      delete f.hostEvidence.hosts[0].testID;
    },
  ],
  [
    'no host ID',
    (f) => {
      delete f.hostEvidence.hosts[0].testID;
    },
  ],
  [
    'nonexact ID',
    (f) => {
      f.hostEvidence.hosts[0].testID = ' save ';
    },
  ],
  [
    'no native ID',
    (f) => {
      delete f.native.nodes[2].identifier;
    },
  ],
  [
    'incompatible host type',
    (f) => {
      f.hostEvidence.typography!.nodes[0].hostType = 'RCTText';
    },
  ],
  [
    'unmapped input host type',
    (f) => {
      f.hostEvidence.typography!.nodes[0].hostType = 'RCTSinglelineTextInputView';
    },
  ],
  [
    'unknown host type',
    (f) => {
      f.hostEvidence.typography!.nodes[0].hostType = null;
    },
  ],
  [
    'no window',
    (f) => {
      f.native.nodes[1].type = 'Other';
    },
  ],
  [
    'outside window',
    (f) => {
      f.native.nodes[2].parentIndex = 0;
      f.native.nodes[2].depth = 1;
    },
  ],
  [
    'unknown presence',
    (f) => {
      f.native.nodes[2].presence.status = 'unknown';
      delete f.native.nodes[2].presence.observedUptimeMs;
    },
  ],
  [
    'invalid presence generation',
    (f) => {
      f.native.nodes[2].presence.generation++;
    },
  ],
  [
    'different app',
    (f) => {
      f.native.presenceCapture.appId = 'com.other';
    },
  ],
  [
    'duplicate host ID',
    (f) => {
      f.hostEvidence.hosts.push(structuredClone(f.hostEvidence.hosts[0]));
      f.hostEvidence.typography!.nodes.push({
        ...structuredClone(f.hostEvidence.typography!.nodes[0]),
        hostIndex: 1,
      });
    },
  ],
  [
    'duplicate native ID',
    (f) => {
      f.native.nodes.push({
        ...structuredClone(f.native.nodes[2]),
        index: 3,
        ref: '@e3',
        presence: { ...f.native.nodes[2].presence, nodeIndex: 3 },
      });
      f.native.snapshotVerdict.nodeCount++;
    },
  ],
  [
    'second window',
    (f) => {
      f.native.nodes.push({
        ...structuredClone(f.native.nodes[1]),
        index: 3,
        ref: '@e3',
        presence: { ...f.native.nodes[1].presence, nodeIndex: 3 },
      });
      f.native.snapshotVerdict.nodeCount++;
    },
  ],
];

for (const [name, weaken] of unproven) {
  test(`unproven host capabilities and safety facts are not transferred: ${name}`, async () => {
    const f = fixture();
    f.hostEvidence.hosts[0].capabilities.fill = true;
    f.hostEvidence.hosts[0].disabled = true;
    f.hostEvidence.hosts[0].readOnly = true;
    f.interactive.push({
      testID: 'save',
      role: 'button',
      disabled: true,
      capabilities: { press: true, fill: true },
    });
    weaken(f);
    const screen = await f.capture();
    assert.equal(screen.elements[2].semantic?.press, 'unknown');
    assert.equal(screen.elements[2].semantic?.fill, 'unknown');
    assert.equal(screen.elements[2].semantic?.disabled, false);
    const judge = scriptedJudge(() =>
      assert.fail('unproven capabilities cannot authorize a choice'),
    );
    const w = walker([screen], judge);
    assert.equal(
      (await runPlan(parsePlan('1. Tap the save control').blocks!, w.deps)).verdict,
      'FAIL',
    );
    assert.deepEqual(w.actions, []);
  });
}

test('every named host ancestor must independently match native ancestry and measured presence', async () => {
  for (const variant of ['proven', 'frame', 'unknown-presence', 'missing-ID', 'disconnected']) {
    const f = fixture();
    const control = f.native.nodes[2];
    f.native.nodes[2] = {
      ...control,
      identifier: 'panel',
      label: '',
      rect: { x: 20, y: 40, width: 300, height: 300 },
    };
    f.native.nodes.push({
      ...control,
      ref: '@e3',
      index: 3,
      parentIndex: 2,
      depth: 3,
      presence: { ...control.presence, nodeIndex: 3 },
    });
    f.native.snapshotVerdict.nodeCount++;
    f.hostEvidence.hosts.push({
      testID: 'panel',
      role: null,
      roleSource: 'none',
      capabilities: {},
    });
    f.hostEvidence.typography!.nodes[0].parentHostIndex = 1;
    f.hostEvidence.typography!.nodes.push({
      hostIndex: 1,
      parentHostIndex: null,
      rootIndex: 0,
      hostType: 'RCTView',
      rect: { x: 0, y: 0, width: 300, height: 300 },
      text: { kind: 'none' },
    });
    if (variant === 'frame') f.hostEvidence.typography!.nodes[1].rect!.x++;
    if (variant === 'unknown-presence') {
      f.native.nodes[2].presence.status = 'unknown';
      delete f.native.nodes[2].presence.observedUptimeMs;
    }
    if (variant === 'missing-ID') f.hostEvidence.hosts[1].testID = 'missing-panel';
    if (variant === 'disconnected') {
      f.native.nodes[3].parentIndex = 1;
      f.native.nodes[3].depth = 2;
    }
    const screen = await f.capture();
    assert.equal(
      screen.elements[3].semantic?.press,
      variant === 'proven' ? 'supported' : 'unknown',
      variant,
    );
    assert.equal(screen.elements.length, 4);
    assert.ok(
      'refuse' in semanticActionView(screen, 'press'),
      'the generic ancestor remains an unknown competitor',
    );
  }
});

test('real measured producer press reaches the walker without a role; absent handlers stay unknown', async () => {
  for (const mode of ['press', 'none', 'disabled', 'readonly']) {
    const f = fixture();
    const fiber = buildFiber({
      hostType: 'RCTView',
      props: {
        testID: 'save',
        ...(mode === 'none' ? {} : { onPress() {} }),
        ...(mode === 'disabled' ? { disabled: true } : {}),
        ...(mode === 'readonly' ? { readOnly: true } : {}),
      },
      stateNode: {
        measureInWindow(cb) {
          cb(10, 20, 100, 40);
        },
      },
    });
    fiber.tag = 5;
    const sandbox = createSandbox({ fiberRoot: fiber });
    const produced = JSON.parse(
      await vm.runInContext(
        '__QAREN.getTree({ interactiveOnly: true, semanticEvidence: true, typographyEvidence: true })',
        sandbox,
      ),
    );
    const screen = await captureScreen({
      appId: 'com.test',
      native: async () => f.native,
      react: async () => produced,
    });
    assert.equal(screen.elements[2].kind, 'other');
    assert.equal(screen.elements[2].semantic?.fill, 'unknown');
    assert.equal(screen.elements[2].semantic?.press, mode === 'none' ? 'unknown' : 'supported');
    const judge = scriptedJudge((questions) => {
      assert.equal(mode, 'press', 'blocked controls never reach a model');
      return Object.fromEntries(
        Object.entries(questions).map(([id, question]) => [id, choice(question)]),
      );
    });
    const w = walker([screen], judge);
    const result = await runPlan(parsePlan('1. Tap the save control').blocks!, w.deps);
    assert.equal(result.verdict, mode === 'press' ? 'PASS' : 'FAIL', result.failure?.seen);
    assert.deepEqual(w.actions, mode === 'press' ? ['press @e2'] : []);
  }
});

test('generic and text competitors remain unknown for press and are never removed to make a choice', async () => {
  for (const type of ['Other', 'StaticText']) {
    const f = fixture();
    f.native.nodes.push({
      ...f.native.nodes[2],
      ref: '@e3',
      index: 3,
      identifier: undefined,
      type,
      label: 'Other contribution',
      presence: { ...f.native.nodes[2].presence, nodeIndex: 3 },
    });
    f.native.snapshotVerdict.nodeCount++;
    const screen = await f.capture();
    assert.equal(screen.elements.length, 4);
    assert.equal(screen.elements[3].semantic?.press, 'unknown');
    assert.ok('refuse' in semanticActionView(screen, 'press'));
  }
});

test('an admitted positive fill fact supports fill without inferring an input kind', async () => {
  const f = fixture();
  f.hostEvidence.hosts[0].capabilities = { fill: true };
  const screen = await f.capture();
  assert.equal(screen.elements[2].kind, 'other');
  assert.equal(screen.elements[2].semantic?.press, 'unknown');
  assert.deepEqual(semanticActionView(screen, 'fill'), { elements: [screen.elements[2]] });
});

test('all measured host controls count toward the unchanged 30-choice limit', async () => {
  for (const count of [30, 31]) {
    const f = fixture();
    for (let i = 1; i < count; i++) {
      f.native.nodes.push({
        ...structuredClone(f.native.nodes[2]),
        ref: `@e${i + 2}`,
        index: i + 2,
        identifier: `save-${i}`,
        presence: { ...f.native.nodes[2].presence, nodeIndex: i + 2 },
      });
      f.hostEvidence.hosts.push({
        ...structuredClone(f.hostEvidence.hosts[0]),
        testID: `save-${i}`,
      });
      f.hostEvidence.typography!.nodes.push({
        ...structuredClone(f.hostEvidence.typography!.nodes[0]),
        hostIndex: i,
      });
    }
    f.native.snapshotVerdict.nodeCount = f.native.nodes.length;
    const screen = await f.capture();
    assert.equal(screen.elements.length, count + 2);
    const judge = scriptedJudge((questions) => {
      assert.equal(count, 30);
      return Object.fromEntries(
        Object.entries(questions).map(([id, question]) => {
          assert.equal(Object.keys(question.criteria!).length, 31);
          return [id, choice(question)];
        }),
      );
    });
    const w = walker([screen], judge);
    const result = await runPlan(parsePlan('1. Tap the save control').blocks!, w.deps);
    assert.equal(result.verdict, count === 30 ? 'PASS' : 'FAIL', result.failure?.seen);
    if (count === 31) assert.match(result.failure!.seen, /CANDIDATE_LIMIT/);
    assert.deepEqual(w.actions, count === 30 ? ['press @e2'] : []);
  }
});

function possibleInputFixture(anonymousLabelFirst = false, onChangeOnly = false) {
  const f = fixture();
  const secret = 'prefilled-private-credential';
  const input = f.native.nodes[2];
  input.identifier = 'email';
  input.label = 'Email';
  input.value = secret;
  f.native.nodes.push({
    ...input,
    ref: '@e3',
    index: 3,
    identifier: undefined,
    type: 'StaticText',
    label: `Echo: ${secret}`,
    value: undefined,
    presence: { ...input.presence, nodeIndex: 3 },
  });
  f.native.snapshotVerdict.nodeCount++;
  const sandbox = createSandbox({
    fiberRoot: buildFiber({
      name: 'Form',
      children: [
        ...(anonymousLabelFirst
          ? [{ hostType: 'RCTView', props: { accessibilityLabel: 'Email', onPress() {} } }]
          : []),
        {
          hostType: 'RCTSinglelineTextInputView',
          props: {
            testID: 'email',
            accessibilityLabel: 'Email',
            ...(onChangeOnly ? { onChange() {} } : { onChangeText() {} }),
          },
        },
      ],
    }),
  });
  const produced = JSON.parse(
    vm.runInContext('__QAREN.getTree({ interactiveOnly: true, semanticEvidence: true })', sandbox),
  );
  assert.equal(produced.interactive.at(-1).role, onChangeOnly ? 'button' : 'textinput');
  const capture = () =>
    captureScreen({
      appId: 'com.test',
      native: async () => f.native,
      react: async () => produced,
    });
  return { native: f.native, produced, secret, capture };
}

test('real inferred textinput digest masks a generic native control value and its echo in CHECK', async () => {
  const f = possibleInputFixture();
  const screen = await f.capture();
  assert.equal(screen.elements[2].kind, 'other');
  assert.equal(screen.elements[2].value, f.secret, 'local observations remain intact');
  assert.equal(screen.elements[2].semantic?.fill, 'unknown');
  assert.equal(screen.elements[2].semantic?.press, 'unknown');
  const judge = scriptedJudge((questions, _, state) => {
    assert.equal(JSON.stringify({ questions, state }).includes(f.secret), false);
    assert.match(questions.check_1.instructions, /QAREN_VALUE/);
    assert.match(state.visibleText.join(' '), /Echo: \[QAREN_VALUE_/);
    return { check_1: { type: 'noul', noul: 0.99 } };
  });
  await decideScreen(screen, judge, {
    kind: 'check',
    literal: false,
    text: `The control value and its echo show ${f.secret}`,
    line: 1,
  });
  assert.equal(judge.requests.length, 1);
});

test('possible-input privacy survives invalid presence and a greedy anonymous label match before the exact ID', async () => {
  for (const variant of [
    'valid',
    'incomplete-native',
    'invalid-presence',
    'incomplete-react',
    'missing-hosts',
  ]) {
    const f = possibleInputFixture(true);
    if (variant === 'incomplete-native') f.native.truncated = true;
    if (variant === 'invalid-presence') f.native.presenceCapture.generation++;
    if (variant === 'incomplete-react') f.produced.hostEvidence.complete = false;
    if (variant === 'missing-hosts') delete f.produced.hostEvidence;
    const screen = await f.capture();
    assert.equal(screen.elements[2].kind, 'other');
    assert.equal(screen.elements[2].value, f.secret);
    assert.equal(screen.elements[2].semantic?.fill, 'unknown');
    assert.equal(screen.elements[2].semantic?.press, 'unknown');
    assert.ok('refuse' in semanticActionView(screen, 'fill'));
    const judge = scriptedJudge((questions, _, state) => {
      assert.equal(JSON.stringify({ questions, state }).includes(f.secret), false, variant);
      assert.match(state.visibleText.join(' '), /Echo: \[QAREN_VALUE_/);
      return { check_1: { type: 'noul', noul: 0.1 } };
    });
    await decideScreen(screen, judge, {
      kind: 'check',
      literal: false,
      text: 'The echo is correct',
      line: 1,
    });
    assert.equal(judge.requests.length, 1);
  }
});

test('secure possible-input values stay out of model requests and durable failures without changing ordinary evidence policy', async () => {
  for (const secure of [false, true]) {
    for (const variant of ['valid', 'incomplete-native', 'invalid-presence', 'missing-digest']) {
      const f = possibleInputFixture(true);
      f.native.nodes[2].secure = secure;
      if (variant === 'incomplete-native') f.native.truncated = true;
      if (variant === 'invalid-presence') f.native.presenceCapture.generation++;
      if (variant === 'missing-digest') f.produced.interactive = [];
      if (!secure && variant === 'missing-digest') continue;
      const screen = await f.capture();
      assert.equal(screen.elements[2].kind, 'other');
      assert.equal(screen.elements[2].value, secure ? undefined : f.secret);
      assert.equal(screen.elements[2].label, 'Email');
      assert.equal(screen.elements[2].testID, 'email');
      assert.equal(
        screen.elements[3].label,
        `Echo: ${f.secret}`,
        'local echo identity is not rewritten',
      );
      const before = JSON.stringify(screen);
      const judge = scriptedJudge((questions, _, state) => {
        assert.equal(JSON.stringify({ questions, state }).includes(f.secret), false, variant);
        assert.match(state.visibleText.join(' '), /Echo: \[QAREN_VALUE_/);
        return Object.fromEntries(
          Object.keys(questions).map((id) => [id, { type: 'noul', noul: 0.1 }]),
        );
      });
      const w = walker([screen], judge);
      const result = await runPlan(parsePlan('✓ The echo is correct').blocks!, w.deps);
      assert.equal(result.verdict, 'FAIL');
      assert.equal(judge.requests.length, 1);
      assert.equal(JSON.stringify({ result, rows: w.rows }).includes(f.secret), !secure, variant);
      if (secure) assert.match(result.failure!.seen, /Echo: •••/);
      assert.equal(JSON.stringify(screen), before);
      assert.deepEqual(w.actions, []);
    }
  }
});

test('value-derived or unproven native labels on possible inputs are masked without replacing their local identities', async () => {
  for (const variant of ['value-label', 'invalid-presence']) {
    const f = possibleInputFixture();
    f.native.nodes[2].label = f.secret;
    delete f.native.nodes[2].value;
    f.native.nodes[2].presence.labelSource = 'value';
    if (variant === 'invalid-presence') f.native.presenceCapture.generation++;
    const screen = await f.capture();
    assert.equal(screen.elements[2].kind, 'other');
    assert.equal(screen.elements[2].label, f.secret);
    const judge = scriptedJudge((questions, _, state) => {
      assert.equal(JSON.stringify({ questions, state }).includes(f.secret), false);
      return Object.fromEntries(
        Object.keys(questions).map((id) => [id, { type: 'noul', noul: 0.1 }]),
      );
    });
    const w = walker([screen], judge);
    const result = await runPlan(parsePlan('✓ The echo is correct').blocks!, w.deps);
    assert.equal(result.verdict, 'FAIL');
    assert.equal(JSON.stringify(result).includes(f.secret), false);
    assert.match(result.failure!.seen, /Echo: •••/);
  }
});

test('secure possible-input checks stay unsure while a legitimate batched phrase target is still judged', async () => {
  for (const type of ['Other', 'TextField']) {
    const f = possibleInputFixture();
    f.native.nodes[2].type = type;
    f.native.nodes[2].secure = true;
    f.native.nodes[2].enabled = false;
    f.native.nodes[3].type = 'Button';
    f.native.nodes[3].label = 'Continue';
    const screen = await f.capture();
    const judge = scriptedJudge((questions) => {
      assert.deepEqual(Object.keys(questions), ['target_2'], type);
      return { target_2: choice(questions.target_2) };
    });
    const decision = await decideScreen(
      screen,
      judge,
      { kind: 'check', literal: false, text: 'Email is valid', line: 1 },
      { kind: 'press', target: { phrase: 'the Continue control' }, line: 2 },
    );
    assert.equal(decision.check, 'unsure');
    assert.equal(decision.target.ref, '@e3');
    assert.equal(judge.requests.length, 1);
    assert.equal(screen.elements[2].kind, type === 'Other' ? 'other' : 'input');
    if (type === 'Other') assert.equal(screen.elements[2].semantic?.fill, 'unknown');
  }
});

test('real onChange-only host fill evidence conceals native values despite a legacy button role and unproven association', async () => {
  for (const variant of [
    'valid',
    'incomplete-hosts',
    'invalid-presence',
    'anonymous-label-first',
  ]) {
    const f = possibleInputFixture(variant === 'anonymous-label-first', true);
    assert.equal(f.produced.interactive.at(-1).capabilities.fill, false);
    assert.equal(f.produced.hostEvidence.hosts.at(-1).capabilities.fill, true);
    if (variant === 'incomplete-hosts') f.produced.hostEvidence.complete = false;
    if (variant === 'invalid-presence') f.native.presenceCapture.generation++;
    const screen = await f.capture();
    assert.equal(screen.elements[2].kind, 'other');
    assert.equal(screen.elements[2].semantic?.fill, 'unknown');
    assert.equal(screen.elements[2].semantic?.press, 'unknown');
    const judge = scriptedJudge((questions, _, state) => {
      assert.equal(JSON.stringify({ questions, state }).includes(f.secret), false, variant);
      assert.match(state.visibleText.join(' '), /Echo: \[QAREN_VALUE_/);
      return { check_1: { type: 'noul', noul: 0.99 } };
    });
    await decideScreen(screen, judge, {
      kind: 'check',
      literal: false,
      text: 'The echo is correct',
      line: 1,
    });
    assert.equal(judge.requests.length, 1);
  }
});

test('possible-input value bounds use local identities before masking and never ask a protected question', async () => {
  for (const variant of ['valid', 'invalid-presence', 'incomplete-hosts']) {
    const f = possibleInputFixture(true);
    f.native.nodes[2].secure = true;
    if (variant === 'invalid-presence') f.native.presenceCapture.generation++;
    if (variant === 'incomplete-hosts') f.produced.hostEvidence.complete = false;
    const screen = await f.capture();
    const judge = scriptedJudge(() =>
      assert.fail('protected value predicates must not reach the judge'),
    );
    for (const predicate of [
      'is valid',
      'is invalid',
      'is filled',
      'starts with abc',
      'has 4 characters',
      `equals ${f.secret}`,
    ]) {
      const result = await decideScreen(screen, judge, {
        kind: 'check',
        literal: false,
        text: `Email input ${predicate}`,
        line: 1,
      });
      assert.equal(result.check, 'unsure', `${variant}: ${predicate}`);
    }
    assert.equal(screen.elements[2].testID, 'email');
    assert.equal(screen.elements[2].label, 'Email');
    assert.equal(screen.elements[2].kind, 'other');
  }
});

test('privacy gathers all matching positive-fill candidate values and deduplicates them in observation order', () => {
  for (const source of ['digest', 'host']) {
    const f = fixture();
    f.native.nodes[2].value = 'native-private';
    f.hostEvidence.hosts[0].capabilities = source === 'host' ? { fill: true } : {};
    const screen = join(
      f.native.nodes,
      [
        { role: 'button', label: 'Save', value: 'first-private' },
        {
          role: 'button',
          testID: 'save',
          value: 'second-private',
          capabilities: { press: false, fill: source === 'digest' },
        },
        { role: 'button', testID: 'save', value: 'third-private' },
      ],
      'app',
      undefined,
      f.hostEvidence,
      'unknown',
    );
    assert.deepEqual(inputValues(screen), [
      'native-private',
      'first-private',
      'second-private',
      'third-private',
      'Save',
    ]);
    assert.equal(isPossibleInput(screen.elements[2]), true);
    assert.equal(screen.elements[2].kind, 'other');
    assert.equal(screen.elements[2].semantic?.fill, 'unknown');
  }
});

test('unassociated positive-fill observations retain privacy without acquiring native input eligibility', async () => {
  const secret = 'unassociated-private-value';
  const screen = join(
    [{ ref: '@echo', type: 'StaticText', label: `Echo: ${secret}` }],
    [
      {
        role: 'button',
        testID: 'editor',
        value: secret,
        capabilities: { press: false, fill: true },
      },
    ],
    'app',
    undefined,
    undefined,
    'unknown',
  );
  assert.equal(screen.elements[1].kind, 'button');
  assert.equal(screen.elements[1].semantic?.fill, 'unknown');
  const judge = scriptedJudge((questions, _, state) => {
    assert.equal(JSON.stringify({ questions, state }).includes(secret), false);
    return { check_1: { type: 'noul', noul: 0.99 } };
  });
  await decideScreen(screen, judge, {
    kind: 'check',
    literal: false,
    text: 'The echo is correct',
    line: 1,
  });
  assert.equal(judge.requests.length, 1);
});
