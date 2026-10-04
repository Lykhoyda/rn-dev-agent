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
      replay: 'REPLAY_SELECTOR',
    },
    {
      name: 'a disabled twin',
      screen: join(disabledTwin, []),
      quoted: 'Save',
      identities: 2,
      press: 'TARGET_AMBIGUOUS',
      replay: 'REPLAY_SELECTOR',
    },
    {
      name: 'a React-only twin',
      screen: join(node(root(), { identifier: 'twin', y: 100 }), reactTwin),
      quoted: 'twin',
      identities: 2,
      press: 'TARGET_AMBIGUOUS',
      replay: 'REPLAY_SELECTOR',
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
      replay: 'REPLAY_SELECTOR',
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
    // A Jev pick of an echoing text acts on its control's identity.
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
      assert.equal(outcome(decideTarget(phrase, choice)), shape.press);
    }
  });
}

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
  assert.equal(bindFillIdentity(fill, screen, 'email'), undefined);
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
