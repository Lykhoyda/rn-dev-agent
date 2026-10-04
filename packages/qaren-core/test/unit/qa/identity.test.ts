// One identity model: every consumer counts the same identities for the same exact target.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from '../../../dist/qa/screen.js';
import type { DigestEntry, NativeNode, Screen } from '../../../dist/qa/screen.js';
import { exactIdentities, wrapperEquivalence } from '../../../dist/qa/identity.js';
import {
  bindFillIdentity,
  decideTarget,
  keyboardFallbackTarget,
  prepareTarget,
  targetVisible,
} from '../../../dist/qa/resolve.js';
import type { Step } from '../../../dist/qa/plan.js';

const root = (): NativeNode[] => [
  { ref: '@app', index: 0, type: 'Application', rect: { x: 0, y: 0, width: 400, height: 800 } },
  {
    ref: '@win',
    index: 1,
    parentIndex: 0,
    type: 'Window',
    rect: { x: 0, y: 0, width: 400, height: 800 },
  },
];

function node(nodes: NativeNode[], extra: Partial<NativeNode> & { y: number }): NativeNode[] {
  const { y, ...rest } = extra;
  return [
    ...nodes,
    {
      ref: `@n${nodes.length}`,
      index: nodes.length,
      parentIndex: 1,
      type: 'Button',
      hittable: true,
      rect: { x: 20, y, width: 300, height: 44 },
      ...rest,
    },
  ];
}

interface Shape {
  name: string;
  screen: Screen;
  quoted: string;
  identities: number;
  press: string;
  replay: string;
}

const shapes = (): Shape[] => {
  const nativeTwins = node(node(root(), { identifier: 'twin', y: 100 }), {
    identifier: 'twin',
    y: 200,
  });
  const disabledTwin = node(node(root(), { label: 'Save', y: 100 }), {
    label: 'Save',
    enabled: false,
    y: 200,
  });
  const echo = node(root(), { type: 'Other', label: 'Skip', identifier: 'skip', y: 600 });
  echo.push({
    ref: '@echo-text',
    index: echo.length,
    parentIndex: 2,
    type: 'StaticText',
    label: 'Skip',
    hittable: true,
    rect: { x: 150, y: 610, width: 60, height: 24 },
  });
  // The same text child drawn outside its control's frame is not a proven duplicate.
  const detached = echo.map((n) =>
    n.ref === '@echo-text' ? { ...n, rect: { x: 150, y: 700, width: 60, height: 24 } } : n,
  );
  const reactTwin: DigestEntry[] = [
    { role: 'button', testID: 'twin' },
    { role: 'button', testID: 'twin' },
  ];
  return [
    {
      name: 'native twins',
      screen: join(nativeTwins, []),
      quoted: 'twin',
      identities: 2,
      press: 'TARGET_AMBIGUOUS',
      replay: 'TARGET_AMBIGUOUS',
    },
    {
      name: 'a disabled twin',
      screen: join(disabledTwin, []),
      quoted: 'Save',
      identities: 2,
      press: 'TARGET_AMBIGUOUS',
      replay: 'TARGET_AMBIGUOUS',
    },
    {
      name: 'a React-only twin',
      screen: join(node(root(), { identifier: 'twin', y: 100 }), reactTwin),
      quoted: 'twin',
      identities: 2,
      press: 'TARGET_AMBIGUOUS',
      replay: 'TARGET_AMBIGUOUS',
    },
    {
      name: 'a container echo',
      screen: join(echo, []),
      quoted: 'Skip',
      identities: 1,
      press: '@n2',
      replay: '@n2',
    },
    {
      name: 'an echo drawn outside its control',
      screen: join(detached, []),
      quoted: 'Skip',
      identities: 2,
      press: 'TARGET_AMBIGUOUS',
      replay: 'TARGET_AMBIGUOUS',
    },
  ];
};

const outcome = (resolution: ReturnType<typeof prepareTarget>): string =>
  'ref' in resolution ? resolution.ref : 'refuse' in resolution ? resolution.refuse : 'question';

for (const shape of shapes()) {
  test(`I1 ${shape.name}: press, replay and Jev selection agree on one identity count`, () => {
    const target = { quoted: shape.quoted, phrase: shape.quoted };
    assert.equal(exactIdentities(shape.screen, target, 'press').length, shape.identities);
    assert.equal(outcome(prepareTarget({ kind: 'press', target }, shape.screen)), shape.press);
    const exact = shape.quoted === 'twin' ? 'id' : 'text';
    assert.equal(
      outcome(prepareTarget({ kind: 'press', target: { ...target, exact } }, shape.screen)),
      shape.replay,
    );
    if (shape.name === 'a container echo') {
      const candidates = shape.screen.elements.filter((e) => e.hittable);
      const keys = candidates.map((_, i) => `e${i}`).concat('none');
      const phrase = {
        candidates,
        question: {
          type: 'choice' as const,
          instructions: 'Which element is the skip control?',
          criteria: Object.fromEntries(keys.map((k) => [k, k])),
        },
      };
      const pick = `e${candidates.findIndex((e) => e.ref === '@echo-text')}`;
      assert.notEqual(pick, 'e-1');
      const probabilities = Object.fromEntries(
        keys.map((k) => [k, k === pick ? 0.99 : 0.01 / (keys.length - 1)]),
      );
      const choice = { type: 'choice' as const, choice: pick, probabilities, confidence: 0.99 };
      assert.equal(outcome(decideTarget(phrase, choice)), '@echo-text');
    }
  });
}

test('I1 a covered non-hittable twin still counts before eligibility', () => {
  const covered = node(node(root(), { label: 'Continue', hittable: false, y: 400 }), {
    label: 'Continue',
    y: 700,
  });
  const screen = join(covered, []);
  const target = { quoted: 'Continue', phrase: 'Continue' };
  assert.equal(exactIdentities(screen, target, 'press').length, 2);
  assert.equal(outcome(prepareTarget({ kind: 'press', target }, screen)), 'TARGET_AMBIGUOUS');
});

test('I1 input twins refuse fill, fallback and rebind alike', () => {
  const inputs = node(node(root(), { type: 'TextField', identifier: 'email', y: 100 }), {
    type: 'TextField',
    identifier: 'email',
    y: 200,
  });
  const screen = join(inputs, []);
  const fill: Step & { kind: 'fill' } = {
    kind: 'fill',
    target: { quoted: 'email', phrase: 'email' },
    text: 'x',
  };
  assert.equal(exactIdentities(screen, fill.target, 'fill').length, 2);
  assert.equal(outcome(prepareTarget(fill, screen)), 'TARGET_AMBIGUOUS');
  assert.equal(keyboardFallbackTarget(fill, screen), undefined);
  assert.throws(() => bindFillIdentity(fill, screen, 'email'), { code: 'TARGET_AMBIGUOUS' });
});

for (const inner of [true, false]) {
  test(`I1 a wrapper ${inner ? 'with' : 'without'} an observed inner field`, () => {
    const screen = join(
      node(root(), { type: 'Other', identifier: 'email-pressable', label: 'Email', y: 100 }),
      inner ? [{ role: 'textinput', testID: 'email', capabilities: { fill: true } }] : [],
    );
    const fill: Step & { kind: 'fill' } = {
      kind: 'fill',
      target: { quoted: 'email', phrase: 'email' },
      text: 'x',
    };
    assert.equal(outcome(prepareTarget(fill, screen)), 'TARGET_NOT_FOUND');
    assert.equal(!!wrapperEquivalence(screen, 'email'), inner);
    const wrapper = screen.elements.find((e) => e.testID === 'email-pressable')!;
    // Never an invented suffix: the wrapper stands for "email" only while both ends are seen.
    assert.deepEqual(
      keyboardFallbackTarget(fill, screen),
      inner ? { element: wrapper, oracleTestID: 'email' } : undefined,
    );
    const rebound = bindFillIdentity(fill, screen, 'email');
    assert.equal(rebound?.kind, inner ? 'fallback' : undefined);
    // The wrapper's own id keeps its own focus identity when its inner field is unseen.
    const quotedWrapper = {
      ...fill,
      target: { quoted: 'email-pressable', phrase: 'email-pressable' },
    };
    assert.deepEqual(keyboardFallbackTarget(quotedWrapper, screen), {
      element: wrapper,
      oracleTestID: inner ? 'email' : 'email-pressable',
    });
    assert.equal(
      exactIdentities(screen, { quoted: 'email-pressable', phrase: '' }, 'press')[0].tag,
      inner ? 'wrapper' : 'native',
    );
  });
}

for (const exact of [undefined, 'id', 'text'] as const) {
  test(`duplicate ${exact ?? 'quoted'} identities refuse actions and visibility`, () => {
    const observed = join(
      node(node(root(), { label: 'Save', identifier: 'Save', y: 100 }), {
        type: 'TextField',
        label: 'Save',
        identifier: 'Save',
        hittable: false,
        y: 200,
      }),
      [],
    );
    const target = { quoted: 'Save', phrase: 'Save', exact };
    for (const kind of ['press', 'fill', 'wait', 'scroll'] as const) {
      const step: Step =
        kind === 'fill'
          ? { kind, target, text: 'x' }
          : kind === 'scroll'
            ? { kind, direction: 'down', until: target }
            : { kind, target };
      assert.equal(outcome(prepareTarget(step, observed)), 'TARGET_AMBIGUOUS');
    }
    // Stored selectors are terminal on duplicates; a plain quoted wait keeps the visibility rule S-VIS owns.
    if (exact) assert.throws(() => targetVisible(target, observed), { code: 'TARGET_AMBIGUOUS' });
    else assert.equal(targetVisible(target, observed), true);
  });
}

test('text enclosing a control does not prove a label echo', () => {
  const nodes = node(root(), { label: 'Save', y: 100 });
  nodes.push({
    ref: '@text',
    parentIndex: 2,
    type: 'StaticText',
    label: 'Save',
    rect: { x: 0, y: 90, width: 400, height: 70 },
    hittable: true,
  });
  const observed = join(nodes, []);
  const target = { quoted: 'Save', phrase: 'Save' };
  assert.equal(exactIdentities(observed, target, 'press').length, 2);
  assert.equal(outcome(prepareTarget({ kind: 'press', target }, observed)), 'TARGET_AMBIGUOUS');
});

test('B: a visible form label is not a fill twin of the input it names', () => {
  const nodes = node(node(root(), { type: 'StaticText', label: 'Email', y: 100 }), {
    type: 'TextField',
    label: 'Email',
    y: 140,
  });
  const screen = join(nodes, []);
  const fill: Step = { kind: 'fill', target: { quoted: 'Email', phrase: 'Email' }, text: 'x' };
  assert.equal(exactIdentities(screen, fill.target, 'fill').length, 1);
  assert.equal(outcome(prepareTarget(fill, screen)), '@n3');
  // A press still counts both.
  assert.equal(
    outcome(prepareTarget({ kind: 'press', target: fill.target }, screen)),
    'TARGET_AMBIGUOUS',
  );
});

test('B: a non-input carrying the fill target testID is a twin', () => {
  const nodes = node(node(root(), { type: 'Button', identifier: 'email', y: 100 }), {
    type: 'TextField',
    identifier: 'email',
    y: 140,
  });
  const fill: Step = { kind: 'fill', target: { quoted: 'email', phrase: 'email' }, text: 'x' };
  assert.equal(outcome(prepareTarget(fill, join(nodes, []))), 'TARGET_AMBIGUOUS');
});

const inputHost = {
  testID: 'notes',
  role: 'textinput',
  roleSource: 'role',
  capabilities: { fill: true },
} as const;
for (const [name, digest, hosts, expected] of [
  [
    'a forwarding composite joined first',
    [
      { role: 'button', testID: 'notes', compositeWrapper: true, inputHostIndices: [0] },
      { role: 'textinput', testID: 'notes' },
    ],
    [inputHost],
    '@n2',
  ],
  [
    'a forwarding composite left over',
    [
      { role: 'textinput', testID: 'notes' },
      { role: 'button', testID: 'notes', compositeWrapper: true, inputHostIndices: [0] },
    ],
    [inputHost],
    '@n2',
  ],
  [
    'an unrelated React button with the same id',
    [
      { role: 'textinput', testID: 'notes' },
      { role: 'button', testID: 'notes' },
    ],
    [inputHost],
    'TARGET_AMBIGUOUS',
  ],
  [
    'a composite without ancestry evidence',
    [
      { role: 'textinput', testID: 'notes' },
      { role: 'button', testID: 'notes', compositeWrapper: true },
    ],
    [],
    'TARGET_AMBIGUOUS',
  ],
  [
    'a second React input host',
    [
      { role: 'textinput', testID: 'notes' },
      { role: 'textinput', testID: 'notes' },
    ],
    [inputHost, inputHost],
    'TARGET_AMBIGUOUS',
  ],
] as const) {
  test(`C: ${name} ${expected === '@n2' ? 'collapses into the one native input' : 'stays a twin'}`, () => {
    const screen = join(
      node(root(), { type: 'TextField', identifier: 'notes', y: 100 }),
      digest as unknown as DigestEntry[],
      'app',
      undefined,
      { hosts: hosts as never, complete: true },
    );
    const fill: Step = { kind: 'fill', target: { quoted: 'notes', phrase: 'notes' }, text: 'x' };
    assert.equal(outcome(prepareTarget(fill, screen)), expected);
  });
}

const notesHost = {
  testID: 'notes',
  role: null,
  roleSource: 'none',
  capabilities: { fill: true },
} as const;
for (const [name, digest, hosts, expected] of [
  [
    'the input host left beside its joined composite ancestor',
    [
      { role: 'textinput', testID: 'notes', inputHostIndices: [0] },
      { role: 'button', testID: 'notes', inputHostIndices: [0] },
    ],
    [notesHost],
    '@n2',
  ],
  [
    'an unrelated React element sharing the testID',
    [
      { role: 'textinput', testID: 'notes', inputHostIndices: [0] },
      { role: 'button', testID: 'notes' },
    ],
    [notesHost],
    'TARGET_AMBIGUOUS',
  ],
  [
    'a second input host under another ancestor',
    [
      { role: 'textinput', testID: 'notes', inputHostIndices: [0] },
      { role: 'button', testID: 'notes', inputHostIndices: [1] },
    ],
    [notesHost, notesHost],
    'TARGET_AMBIGUOUS',
  ],
] as const) {
  test(`forwarding proof: ${name}`, () => {
    const screen = join(
      node(root(), { type: 'Other', identifier: 'notes', y: 100 }),
      digest as unknown as DigestEntry[],
      'app',
      undefined,
      { hosts: hosts as never, complete: true },
    );
    const fill: Step = { kind: 'fill', target: { quoted: 'notes', phrase: 'notes' }, text: 'x' };
    assert.equal(outcome(prepareTarget(fill, screen)), expected);
  });
}
