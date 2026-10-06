// A runner occlusion refusal at dispatch scrolls once and retries the same identity.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePlan } from '../../../dist/qa/plan.js';
import { join } from '../../../dist/qa/screen.js';
import type { NativeNode, Screen } from '../../../dist/qa/screen.js';
import { choice, scriptedJudge } from './judgment-fixtures.ts';
import { walkBlock } from '../../../dist/qa/walker.js';
import type { ActResult, WalkerDeps } from '../../../dist/qa/walker.js';

const OCCLUDED: ActResult = {
  ok: false,
  proven: false,
  mutation: 'none',
  error: 'FOCUS_TARGET_OCCLUDED: the focus or tap point is covered by another element',
};

for (const kind of ['press', 'fill'] as const) {
  test(`a native moved-target refusal never succeeds or clears by scrolling (${kind})`, async () => {
    const type = kind === 'press' ? 'Button' : 'TextField';
    const moved: ActResult = {
      ok: false,
      proven: false,
      mutation: 'none',
      error:
        'TARGET_MOVED_BEFORE_DISPATCH: target moved before dispatch; no tap or typing was performed',
    };
    const f = fake([at(400, type)], { [kind]: [moved, moved] });
    const outcome = await walkBlock(
      block(kind === 'press' ? '1. Tap "go"\n' : '1. Fill "field" with "x"\n'),
      f.deps,
    );
    assert.equal(outcome.block.outcome, 'fail');
    assert.match(outcome.failure?.seen ?? '', /TARGET_MOVED_BEFORE_DISPATCH/);
    assert.equal(f.calls.filter((call) => call.startsWith('scroll')).length, 0);
  });
}

for (const kind of ['press', 'fill', 'back', 'dialog', 'scroll'] as const) {
  test(`a proven no-mutation ${kind} refusal cannot pass on lower-to-middle readback movement`, async () => {
    const moved: ActResult = {
      ok: false,
      proven: false,
      mutation: 'none',
      error: 'TARGET_MOVED_BEFORE_DISPATCH: target moved before dispatch',
      ...(kind === 'fill' ? { evidence: 'unavailable' as const } : {}),
    };
    const type = kind === 'fill' ? 'TextField' : 'Button';
    const f = fake([at(700, type), at(400, type)], { [kind]: [moved, moved] });
    if (kind === 'back' || kind === 'dialog' || kind === 'scroll') f.deps[kind] = async () => moved;
    const steps = {
      press: '1. Tap "go"\n',
      fill: '1. Fill "field" with "x"\n',
      back: '1. Back\n',
      dialog: '1. Accept dialog\n',
      scroll: '1. Scroll down\n',
    };
    const outcome = await walkBlock(block(steps[kind]), f.deps);
    assert.equal(outcome.block.outcome, 'fail');
    assert.match(outcome.failure?.seen ?? '', /TARGET_MOVED_BEFORE_DISPATCH/);
    assert.equal(
      outcome.rows.some((row) => row.outcome === 'pass'),
      false,
    );
  });
}

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

const covered = (screen: Screen): Screen => ({
  ...screen,
  coverage: { native: 'complete', react: 'complete' },
});

function at(y: number, type = 'Button', extra: NativeNode[] = []): Screen {
  const id = type === 'Button' ? 'go' : 'field';
  return covered(
    join(
      [
        ...root(),
        {
          ref: '@target',
          index: 2,
          parentIndex: 1,
          type,
          identifier: id,
          label: type === 'Button' ? 'Go' : undefined,
          hittable: true,
          rect: { x: 20, y, width: 300, height: 44 },
        },
        ...extra,
      ],
      [],
    ),
  );
}

const done = (): Screen =>
  covered(
    join(
      [
        ...root(),
        {
          ref: '@done',
          index: 2,
          parentIndex: 1,
          type: 'StaticText',
          label: 'Done',
          hittable: true,
          rect: { x: 20, y: 100, width: 300, height: 44 },
        },
      ],
      [],
    ),
  );

function fake(screens: Screen[], results: { press?: ActResult[]; fill?: ActResult[] }) {
  const calls: string[] = [];
  const queue = [...screens];
  const press = [...(results.press ?? [])];
  const fill = [...(results.fill ?? [])];
  let clock = 0;
  const deps: WalkerDeps = {
    async captureScreen() {
      calls.push('capture');
      return queue.length > 1 ? queue.shift()! : queue[0];
    },
    async press(ref) {
      calls.push(`press ${ref}`);
      return press.shift() ?? { ok: true, proven: false };
    },
    async fill(ref) {
      calls.push(`fill ${ref}`);
      return fill.shift() ?? { ok: true, proven: true };
    },
    async scroll(direction) {
      calls.push(`scroll ${direction}`);
      return { ok: true, proven: false };
    },
    async back() {
      return { ok: true, proven: false };
    },
    async dialog() {
      return { ok: true, proven: true };
    },
    async screenshot(name) {
      return name;
    },
    now: () => (clock += 100),
    async sleep(ms) {
      clock += ms;
    },
    row: () => undefined,
  };
  return { deps, calls };
}

function block(markdown: string) {
  const parsed = parsePlan(markdown);
  assert.ok(parsed.blocks, JSON.stringify(parsed.refused));
  return parsed.blocks[0];
}

const targetOf = (screen: Screen, ref: string) => screen.elements.find((e) => e.ref === ref);

test('O1: an occluded press scrolls once toward clearance and presses the same identity', async () => {
  const screens = [at(700), at(400), at(400), done()];
  const f = fake(screens, { press: [OCCLUDED] });
  const outcome = await walkBlock(block('1. Tap "go"\n'), f.deps);
  assert.equal(outcome.block.outcome, 'pass');
  assert.deepEqual(f.calls, [
    'capture',
    'press @target',
    'scroll down',
    'capture',
    'capture',
    'press @target',
    'capture',
  ]);
  assert.equal(targetOf(screens[0], '@target')?.testID, 'go');
  assert.equal(targetOf(screens[1], '@target')?.testID, 'go');
});

test('O1: a target in the upper half scrolls up', async () => {
  const f = fake([at(80), at(300), at(300), done()], { press: [OCCLUDED] });
  const outcome = await walkBlock(block('1. Tap "go"\n'), f.deps);
  assert.equal(outcome.block.outcome, 'pass');
  assert.ok(f.calls.includes('scroll up'));
});

test('O2: occluded twice fails after one scroll, never as an uncertain outcome', async () => {
  const f = fake([at(700), at(650)], { press: [OCCLUDED, OCCLUDED] });
  const outcome = await walkBlock(block('1. Tap "go"\n'), f.deps);
  assert.equal(outcome.block.outcome, 'fail');
  assert.equal(f.calls.filter((c) => c.startsWith('press')).length, 2);
  assert.equal(f.calls.filter((c) => c.startsWith('scroll')).length, 1);
  assert.match(
    outcome.failure?.seen ?? '',
    /^FOCUS_TARGET_OCCLUDED: .*"go" stayed off screen after one scroll/,
  );
  assert.doesNotMatch(JSON.stringify(outcome), /ACTION_OUTCOME_UNCERTAIN/);
});

test('O3: an occluded exact fill scrolls once, then fills verified', async () => {
  const f = fake([at(700, 'TextField'), at(300, 'TextField'), at(300, 'TextField')], {
    fill: [OCCLUDED],
  });
  const outcome = await walkBlock(block('1. Fill "field" with "x"\n'), f.deps);
  assert.equal(outcome.block.outcome, 'pass');
  assert.deepEqual(f.calls.slice(0, 6), [
    'capture',
    'fill @target',
    'scroll down',
    'capture',
    'capture',
    'fill @target',
  ]);
});

test('O4: a later transparent full-screen container never makes a hittable target scroll', async () => {
  const overlay: NativeNode = {
    ref: '@overlay',
    index: 3,
    parentIndex: 1,
    type: 'Other',
    hittable: true,
    rect: { x: 0, y: 0, width: 400, height: 800 },
  };
  const f = fake([at(700, 'Button', [overlay]), done()], {});
  const outcome = await walkBlock(block('1. Tap "go"\n'), f.deps);
  assert.equal(outcome.block.outcome, 'pass');
  assert.deepEqual(f.calls, ['capture', 'press @target', 'capture']);
});

test('O5: a refusal other than occlusion keeps its existing path', async () => {
  const other: ActResult = { ...OCCLUDED, error: 'STALE_REF: gone' };
  const f = fake([at(700)], { press: [other, other] });
  await walkBlock(block('1. Tap "go"\n'), f.deps);
  assert.equal(f.calls.filter((c) => c.startsWith('scroll')).length, 0);
});

for (const kind of ['press', 'fill'] as const) {
  test(`occlusion never switches a ${kind} to a same-label twin`, async () => {
    const first = at(700, kind === 'press' ? 'Button' : 'TextField');
    targetOf(first, '@target')!.label = 'Save';
    const twin = at(300, kind === 'press' ? 'Button' : 'TextField');
    targetOf(twin, '@target')!.testID = 'twin';
    targetOf(twin, '@target')!.label = 'Save';
    const f = fake([first, twin], { [kind === 'press' ? 'press' : 'fill']: [OCCLUDED] });
    const outcome = await walkBlock(
      block(kind === 'press' ? '1. Tap "Save"\n' : '1. Fill "Save" with "x"\n'),
      f.deps,
    );
    assert.equal(outcome.block.outcome, 'fail');
    assert.equal(f.calls.filter((call) => call.startsWith(kind)).length, 1);
    assert.equal(f.calls.filter((call) => call.startsWith('scroll')).length, 1);
    assert.match(outcome.failure?.seen ?? '', /TARGET_NOT_FOUND/);
  });
}

function wrapperAt(y: number, keyboardVisible: boolean): Screen {
  const screen = at(y, 'Button');
  targetOf(screen, '@target')!.testID = 'email-pressable';
  screen.keyboardVisible = keyboardVisible;
  screen.coverage = { native: 'complete', react: 'incomplete' };
  return screen;
}

for (const secondOcclusion of [false, true]) {
  test(`keyboard fallback clears occlusion once (${secondOcclusion ? 'refused' : 'typed'})`, async () => {
    const f = fake(
      [wrapperAt(700, false), wrapperAt(300, false), wrapperAt(300, false), wrapperAt(300, true)],
      {
        press: secondOcclusion ? [OCCLUDED, OCCLUDED] : [OCCLUDED],
      },
    );
    let typed = 0;
    f.deps.typeFocused = async () => {
      typed += 1;
      return { ok: true, proven: false };
    };
    const outcome = await walkBlock(block('1. Fill "email" with "x"\n'), f.deps);
    assert.equal(outcome.block.outcome, secondOcclusion ? 'fail' : 'pass');
    assert.equal(typed, secondOcclusion ? 0 : 1);
    assert.equal(f.calls.filter((call) => call.startsWith('scroll')).length, 1);
    assert.equal(f.calls.filter((call) => call.startsWith('press')).length, 2);
    if (secondOcclusion)
      assert.match(
        outcome.failure?.seen ?? '',
        /stayed off screen after one scroll.*nothing was typed/,
      );
  });
}

test('keyboard fallback never taps a replacement wrapper after clearance', async () => {
  const twin = wrapperAt(300, false);
  targetOf(twin, '@target')!.testID = 'other-pressable';
  const f = fake([wrapperAt(700, false), twin], { press: [OCCLUDED] });
  let typed = 0;
  f.deps.typeFocused = async () => {
    typed += 1;
    return { ok: true, proven: false };
  };
  const outcome = await walkBlock(block('1. Fill "email" with "x"\n'), f.deps);
  assert.equal(outcome.block.outcome, 'fail');
  assert.equal(typed, 0);
  assert.equal(f.calls.filter((call) => call.startsWith('press')).length, 1);
});

test('a semantic target stays pinned after occlusion without another model choice', async () => {
  const first = at(700);
  const twin = at(300);
  targetOf(twin, '@target')!.testID = 'twin';
  first.elements = [targetOf(first, '@target')!];
  twin.elements = [targetOf(twin, '@target')!];
  const judge = scriptedJudge((questions) =>
    Object.fromEntries(Object.entries(questions).map(([id, question]) => [id, choice(question)])),
  );
  const f = fake([first, twin], { press: [OCCLUDED] });
  f.deps.judge = judge;
  const outcome = await walkBlock(block('1. Tap the save button\n'), f.deps);
  assert.equal(outcome.block.outcome, 'fail');
  assert.equal(judge.requests.length, 1);
  assert.equal(f.calls.filter((call) => call.startsWith('press')).length, 1);
});

test('duplicate refused testIDs cannot rebind after clearance', async () => {
  const duplicate = at(300, 'Button', [
    {
      ref: '@duplicate',
      index: 3,
      parentIndex: 1,
      type: 'Button',
      identifier: 'go',
      label: 'Go',
      hittable: true,
      rect: { x: 20, y: 400, width: 300, height: 44 },
    },
  ]);
  const f = fake([at(700), duplicate], { press: [OCCLUDED] });
  const outcome = await walkBlock(block('1. Tap "go"\n'), f.deps);
  assert.equal(outcome.block.outcome, 'fail');
  assert.equal(f.calls.filter((call) => call.startsWith('press')).length, 1);
});

for (const kind of ['press', 'fill'] as const) {
  for (const semantic of [false, true]) {
    for (const y of [80, 700]) {
      test(`an unidentified ${semantic ? 'semantic' : 'literal'} ${kind} never retries a same-label twin at its old frame (${y})`, async () => {
        const type = kind === 'press' ? 'Button' : 'TextField';
        const first = at(y, type);
        const original = targetOf(first, '@target')!;
        delete original.testID;
        original.label = 'Save';
        const after = at(300, type, [
          {
            ref: '@twin',
            index: 3,
            parentIndex: 1,
            type,
            label: 'Save',
            hittable: true,
            rect: { x: 20, y, width: 300, height: 44 },
          },
        ]);
        const moved = targetOf(after, '@target')!;
        delete moved.testID;
        moved.label = 'Save';
        if (semantic) {
          first.elements = [original];
          after.elements = [moved, targetOf(after, '@twin')!];
        }
        const f = fake([first, after], { [kind]: [OCCLUDED] });
        const judge = scriptedJudge((questions) =>
          Object.fromEntries(
            Object.entries(questions).map(([id, question]) => [id, choice(question)]),
          ),
        );
        if (semantic) f.deps.judge = judge;
        const target = semantic ? 'the save control' : '"Save"';
        const instruction =
          kind === 'press' ? `1. Tap ${target}\n` : `1. Fill ${target} with "x"\n`;
        const outcome = await walkBlock(block(instruction), f.deps);
        assert.equal(outcome.block.outcome, 'fail');
        assert.deepEqual(f.calls, [
          'capture',
          `${kind} @target`,
          `scroll ${y < 400 ? 'up' : 'down'}`,
          'capture',
          'capture',
        ]);
        assert.match(outcome.failure?.seen ?? '', /stayed off screen after one scroll/);
        assert.doesNotMatch(JSON.stringify(outcome), /ACTION_OUTCOME_UNCERTAIN/);
        if (semantic) assert.equal(judge.requests.length, 1);
      });
    }
  }
}

function clipped(y: number, type = 'Button', occluder: 'tabs' | 'keyboard' = 'tabs'): Screen {
  const id = type === 'Button' ? 'go' : 'field';
  return covered(
    join(
      [
        ...root(),
        {
          ref: '@scroll',
          index: 2,
          parentIndex: 1,
          type: 'ScrollView',
          rect: { x: 0, y: 0, width: 400, height: occluder === 'tabs' ? 720 : 800 },
        },
        {
          ref: '@target',
          index: 3,
          parentIndex: 2,
          type,
          identifier: id,
          label: type === 'Button' ? 'Go' : undefined,
          hittable: true,
          rect: { x: 20, y, width: 300, height: 44 },
        },
        ...(occluder === 'keyboard'
          ? [
              {
                ref: '@keyboard',
                index: 4,
                parentIndex: 1,
                type: 'Keyboard',
                hittable: true,
                rect: { x: 0, y: 500, width: 400, height: 300 },
              },
            ]
          : []),
      ],
      [],
    ),
  );
}

test('O5: a press whose centre lies past its scroll clip scrolls before any dispatch', async () => {
  const f = fake([clipped(700), clipped(400), clipped(400), done()], {});
  const outcome = await walkBlock(block('1. Tap "go"\n'), f.deps);
  assert.equal(outcome.block.outcome, 'pass');
  assert.deepEqual(f.calls, [
    'capture',
    'scroll down',
    'capture',
    'capture',
    'press @target',
    'capture',
  ]);
});

test('O5: a fill whose centre lies under the keyboard scrolls before any dispatch', async () => {
  const kb = (y: number) => clipped(y, 'TextField', 'keyboard');
  const f = fake([kb(700), kb(300), kb(300)], {});
  const outcome = await walkBlock(block('1. Fill "field" with "x"\n'), f.deps);
  assert.equal(outcome.block.outcome, 'pass');
  assert.deepEqual(f.calls.slice(0, 5), [
    'capture',
    'scroll down',
    'capture',
    'capture',
    'fill @target',
  ]);
});

test('O5: a target still covered after one scroll refuses with no dispatch', async () => {
  for (const [screen, step] of [
    [(y: number) => clipped(y), '1. Tap "go"\n'],
    [(y: number) => clipped(y, 'TextField', 'keyboard'), '1. Fill "field" with "x"\n'],
  ] as const) {
    const f = fake([screen(700), screen(710)], {});
    const outcome = await walkBlock(block(step), f.deps);
    assert.equal(outcome.block.outcome, 'fail');
    assert.equal(f.calls.filter((c) => /^(press|fill)/.test(c)).length, 0, f.calls.join());
    assert.equal(f.calls.filter((c) => c.startsWith('scroll')).length, 1);
    assert.match(outcome.failure?.seen ?? '', /stayed off screen after one scroll/);
  }
});

test('O6: a keyboard-cleared fill waits for the scroll to stop before dispatching', async () => {
  const kb = (y: number) => clipped(y, 'TextField', 'keyboard');
  const f = fake([kb(700), kb(450), kb(400), kb(400)], {});
  const outcome = await walkBlock(block('1. Fill "field" with "x"\n'), f.deps);
  assert.equal(outcome.block.outcome, 'pass');
  assert.deepEqual(f.calls.slice(0, 6), [
    'capture',
    'scroll down',
    'capture',
    'capture',
    'capture',
    'fill @target',
  ]);
});

for (const kind of ['press', 'fill'] as const) {
  for (const axis of ['x', 'y'] as const) {
    for (const start of [80, 700]) {
      test(`a moving ${kind} refuses after clearance (${axis}, ${start})`, async () => {
        const type = kind === 'press' ? 'Button' : 'TextField';
        const moving = [450, 400, 350, 300].map((position) => {
          const observed = at(axis === 'y' ? position : 300, type);
          if (axis === 'x') {
            const node = {
              ...root()[0],
              ref: '@target',
              index: 2,
              parentIndex: 1,
              type,
              identifier: kind === 'press' ? 'go' : 'field',
              hittable: true,
              rect: { x: position, y: 300, width: 44, height: 44 },
            };
            return covered(join([...root(), node], []));
          }
          return observed;
        });
        const initial = at(start, type);
        targetOf(initial, '@target')!.hittable = false;
        targetOf(initial, '@target')!.offscreen = true;
        const f = fake([initial, ...moving], {});
        const outcome = await walkBlock(
          block(kind === 'press' ? '1. Tap "go"\n' : '1. Fill "field" with "x"\n'),
          f.deps,
        );
        assert.equal(outcome.block.outcome, 'fail');
        assert.equal(f.calls.filter((c) => /^(press|fill)/.test(c)).length, 0);
        assert.match(outcome.failure?.seen ?? '', /stayed off screen after one scroll/);
      });
    }
  }
}

test('keyboard fallback refuses a wrapper that never settles after clearance', async () => {
  const f = fake([wrapperAt(700, false), ...[450, 400, 350, 300].map((y) => wrapperAt(y, false))], {
    press: [OCCLUDED],
  });
  let typed = 0;
  f.deps.typeFocused = async () => {
    typed += 1;
    return { ok: true, proven: false };
  };
  const outcome = await walkBlock(block('1. Fill "email" with "x"\n'), f.deps);
  assert.equal(outcome.block.outcome, 'fail');
  assert.equal(typed, 0);
  assert.equal(f.calls.filter((c) => c.startsWith('press')).length, 1);
});

test('a wrapped pressable settles on equal native frames whatever key order the runner emits', async () => {
  const keyed = (keys: ('x' | 'y' | 'width' | 'height')[], keyboardVisible: boolean): Screen => {
    const frame = { x: 20, y: 300, width: 300, height: 44 };
    const screen = covered(
      join(
        [
          ...root(),
          {
            ref: '@target',
            index: 2,
            parentIndex: 1,
            type: 'Button',
            identifier: 'go',
            label: 'Go',
            hittable: true,
            rect: Object.fromEntries(keys.map((key) => [key, frame[key]])) as typeof frame,
          },
        ],
        [],
      ),
    );
    targetOf(screen, '@target')!.testID = 'email-pressable';
    screen.keyboardVisible = keyboardVisible;
    screen.coverage = { native: 'complete', react: 'incomplete' };
    return screen;
  };
  const f = fake(
    [
      keyed(['x', 'y', 'width', 'height'], false),
      keyed(['y', 'width', 'x', 'height'], true),
      keyed(['width', 'x', 'y', 'height'], true),
      keyed(['height', 'y', 'x', 'width'], true),
      keyed(['height', 'width', 'x', 'y'], true),
    ],
    {},
  );
  let typed = 0;
  f.deps.typeFocused = async () => {
    typed += 1;
    return { ok: true, proven: false };
  };
  const outcome = await walkBlock(block('1. Fill "email" with "x"\n'), f.deps);
  assert.doesNotMatch(outcome.failure?.seen ?? '', /SCROLL_UNSETTLED/);
  assert.equal(typed, 1);
  assert.equal(f.calls.filter((c) => c.startsWith('press')).length, 1);
});

test('expired post-scroll evidence requires settlement again before dispatch', async () => {
  const f = fake(
    [clipped(700), clipped(400), clipped(400), ...[450, 400, 350, 300].map((y) => clipped(y))],
    {},
  );
  const press = f.deps.press;
  let expired = false;
  f.deps.press = async (ref, context) => {
    if (!expired) {
      expired = true;
      context.refuse('EVIDENCE_EXPIRED');
    }
    return press(ref, context);
  };
  const outcome = await walkBlock(block('1. Tap "go"\n'), f.deps);
  assert.equal(outcome.block.outcome, 'fail');
  assert.equal(f.calls.filter((c) => c.startsWith('press')).length, 0);
});

test('a second press after clearance refuses keyboard auto-scroll before dispatch', async () => {
  const f = fake(
    [
      clipped(700),
      clipped(400),
      clipped(400),
      clipped(380),
      ...[350, 340, 330, 320].map((y) => clipped(y)),
    ],
    {},
  );
  const outcome = await walkBlock(block('1. Tap "go"\n'), f.deps);
  assert.equal(outcome.block.outcome, 'fail');
  assert.match(outcome.failure?.seen ?? '', /SCROLL_UNSETTLED/);
  assert.equal(f.calls.filter((c) => c.startsWith('press')).length, 1);
});

for (const mode of ['strict', 'keyboard', 'poll'] as const) {
  test(`fallback focus ${mode} refuses moving readbacks before typing`, async () => {
    const inputAt = (y: number) => {
      const screen = at(y, 'TextField');
      targetOf(screen, '@target')!.testID = 'email';
      screen.keyboardVisible = true;
      return screen;
    };
    const moving = [450, 400, 350, 300].map((y) =>
      mode === 'keyboard' ? wrapperAt(y, true) : inputAt(y),
    );
    const screens = [
      wrapperAt(300, false),
      ...(mode === 'poll' ? [wrapperAt(300, false), wrapperAt(300, false)] : []),
      ...moving,
    ];
    const f = fake(screens, {});
    let typed = 0;
    f.deps.typeFocused = async () => {
      typed += 1;
      return { ok: true, proven: false };
    };
    const outcome = await walkBlock(block('1. Fill "email" with "x"\n'), f.deps);
    assert.equal(outcome.block.outcome, 'fail');
    assert.match(outcome.failure?.seen ?? '', /SCROLL_UNSETTLED/);
    assert.equal(f.calls.filter((c) => c.startsWith('press')).length, 1);
    assert.equal(f.calls.filter((c) => c.startsWith('fill')).length, 0);
    assert.equal(typed, 0);
  });
}

test('expired strict fill after fallback focus requires settlement before refreshing', async () => {
  const inputAt = (y: number) => {
    const screen = at(y, 'TextField');
    targetOf(screen, '@target')!.testID = 'email';
    screen.keyboardVisible = true;
    return screen;
  };
  const f = fake(
    [wrapperAt(300, false), inputAt(400), inputAt(400), ...[350, 340, 330, 320].map(inputAt)],
    {},
  );
  const fill = f.deps.fill;
  let expired = false;
  f.deps.fill = async (ref, text, context) => {
    if (!expired) {
      expired = true;
      context.refuse('EVIDENCE_EXPIRED');
    }
    return fill(ref, text, context);
  };
  f.deps.typeFocused = async () => assert.fail('strict input must not use keyboard typing');
  const outcome = await walkBlock(block('1. Fill "email" with "x"\n'), f.deps);
  assert.equal(outcome.block.outcome, 'fail');
  assert.match(outcome.failure?.seen ?? '', /SCROLL_UNSETTLED/);
  assert.equal(f.calls.filter((c) => c.startsWith('press')).length, 1);
  assert.equal(f.calls.filter((c) => c.startsWith('fill')).length, 0);
});
