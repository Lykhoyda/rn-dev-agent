import assert from 'node:assert/strict';
import { test } from 'node:test';
import { captureScreen } from '../../../dist/qa/capture.js';
import type { ReactObservation } from '../../../dist/qa/capture.js';
import { parsePlan } from '../../../dist/qa/plan.js';
import { runPlan } from '../../../dist/qa/walker.js';
import type { NativeNode } from '../../../dist/qa/screen.js';
import { scriptedJudge, walker } from './judgment-fixtures.ts';
import { attested, nativeCapture } from './platform-presence-fixtures.ts';

type Extra = Partial<NativeNode> & { ref: string; type: string };

function native(extra: Extra[], presence = false) {
  const base = nativeCapture();
  const nodes = [
    ...base.nodes,
    ...extra.map((node, i) => ({
      ...base.nodes[1],
      identifier: undefined,
      label: undefined,
      ...node,
      index: base.nodes.length + i,
      presence: { ...base.nodes[1].presence, nodeIndex: base.nodes.length + i },
    })),
  ];
  return {
    ...base,
    presenceCapture: presence ? base.presenceCapture : undefined,
    nodes,
    snapshotVerdict: { ...base.snapshotVerdict, nodeCount: nodes.length },
  };
}

const digest = (extra: ReactObservation['interactive'] = []): ReactObservation => ({
  interactive: [
    { role: 'button', testID: 'save', capabilities: { press: true, fill: false } },
    ...(extra ?? []),
  ],
  verdict: { state: 'ok', path: 'interactive', complete: true },
  hostEvidence: {
    complete: true,
    hosts: [{ testID: 'save', role: 'button', roleSource: 'role', capabilities: { press: true } }],
  },
});

function deps(
  screens: Array<{ nodes: Extra[]; react?: ReactObservation; presence?: boolean }>,
  answer = 0.01,
) {
  let captures = 0;
  const judge = scriptedJudge((questions) =>
    Object.fromEntries(Object.keys(questions).map((key) => [key, { type: 'noul', noul: answer }])),
  );
  const f = walker([], judge);
  let shots = 0;
  f.deps.screenshot = async (name) => {
    shots += 1;
    return name;
  };
  f.deps.captureScreen = (options) => {
    const next = screens[Math.min(captures++, screens.length - 1)];
    return captureScreen({
      appId: 'com.test',
      requirePrivateInputs: true,
      timing: options?.timing,
      native: async () => native(next.nodes, next.presence),
      react: async () => next.react ?? digest(),
    });
  };
  return { f, judge, shots: () => shots };
}

const outputs = (value: unknown, judge: { requests: unknown[] }, rows: unknown[]) =>
  JSON.stringify({ value, rows, prompts: judge.requests });

test('a hidden but attached field and its same-screen echo are masked in the prompt and every output', async () => {
  const secret = 'secret-a@example.test';
  const { f, judge } = deps([
    {
      nodes: [
        {
          ref: '@hidden',
          type: 'TextField',
          identifier: 'hidden-email',
          label: 'Email',
          value: secret,
          rect: { x: 10, y: -2000, width: 200, height: 40 },
        },
        { ref: '@echo', type: 'StaticText', label: `Signed in as ${secret}` },
      ],
      presence: true,
    },
  ]);
  const result = await runPlan(
    parsePlan(`✓ The greeting names the signed-in account\n✓ "Nothing like this"`).blocks!,
    f.deps,
  );
  assert.equal(result.verdict, 'FAIL');
  assert.ok(
    judge.requests.length > 0,
    `the phrase check reached the model: ${JSON.stringify(result)}`,
  );
  const all = outputs(result, judge, f.rows);
  assert.equal(all.includes(secret), false, all);
});

test('strings from a React-only digest entry never reach any output', async () => {
  const reactOnly = 'react-only-secret-label';
  const { f, judge } = deps([
    {
      nodes: [{ ref: '@echo', type: 'StaticText', label: 'Welcome' }],
      react: digest([{ role: 'text', testID: 'ghost', text: reactOnly, label: reactOnly }]),
      presence: true,
    },
  ]);
  const result = await runPlan(
    parsePlan(`✓ The welcome text is shown\n✓ "Nothing like this"`).blocks!,
    f.deps,
  );
  const all = outputs(result, judge, f.rows);
  assert.equal(all.includes(reactOnly), false, all);
  const screen = await f.deps.captureScreen();
  assert.ok(screen.elements.some((element) => element.testID === 'ghost'));
  assert.equal(JSON.stringify(screen.elements).includes(reactOnly), false);
});

test('a field value seen earlier stays masked when echoed after navigation', async () => {
  const secret = 'history-b@example.test';
  const { f, judge } = deps([
    {
      nodes: [
        { ref: '@email', type: 'TextField', identifier: 'email', label: 'Email', value: secret },
      ],
    },
    { nodes: [{ ref: '@welcome', type: 'StaticText', label: `Welcome ${secret}` }] },
  ]);
  const result = await runPlan(parsePlan(`1. Tap "save"\n✓ "Nothing like this"`).blocks!, f.deps);
  assert.equal(result.verdict, 'FAIL');
  assert.deepEqual(f.actions, ['press @e1']);
  assert.equal(f.rows[0].outcome, 'pass');
  assert.match(result.failure!.seen, /Welcome •••/);
  const all = outputs(result, judge, f.rows);
  assert.equal(all.includes(secret), false, all);
});

test('a typed value echoed in a label is masked', async () => {
  const typed = 'typed-c@example.test';
  const { f, judge } = deps([
    { nodes: [{ ref: '@email', type: 'TextField', identifier: 'Email', label: 'Email' }] },
    { nodes: [{ ref: '@note', type: 'StaticText', label: `Sent to ${typed}` }] },
  ]);
  const result = await runPlan(
    parsePlan(`1. Fill "Email" with "${typed}"\n✓ "Nothing like this"`).blocks!,
    f.deps,
  );
  assert.deepEqual(f.actions, [`fill @email ${typed}`]);
  assert.equal(f.rows[0].outcome, 'pass');
  assert.match(result.failure!.seen, /Sent to •••/);
  const all = outputs(result, judge, f.rows);
  assert.equal(all.includes(typed), false, all);
});

test('a secure field is never written and withholds screenshots', async () => {
  const { f, judge, shots } = deps([
    {
      nodes: [
        {
          ref: '@password',
          type: 'SecureTextField',
          identifier: 'password',
          label: 'Password',
          value: '•••••••',
          secure: true,
        },
      ],
    },
  ]);
  const result = await runPlan(parsePlan(`✓ "Nothing like this"`).blocks!, f.deps);
  assert.equal(result.verdict, 'FAIL');
  assert.equal(shots(), 0);
  const all = outputs(result, judge, f.rows);
  assert.equal(all.includes('•••••••'), false, all);
});

test('a readable secure value and its echo are masked in every output', async () => {
  const secret = 'readable-secure-d';
  const { f, judge, shots } = deps([
    {
      nodes: [
        {
          ref: '@password',
          type: 'android.widget.EditText',
          identifier: 'password',
          label: secret,
          secure: true,
        },
        { ref: '@echo', type: 'android.widget.TextView', label: `Your password is ${secret}` },
      ],
    },
  ]);
  const result = await runPlan(parsePlan(`✓ "Nothing like this"`).blocks!, f.deps);
  assert.equal(result.verdict, 'FAIL');
  assert.equal(shots(), 0);
  assert.match(result.failure!.seen, /Your password is •••/);
  const all = outputs(result, judge, f.rows);
  assert.equal(all.includes(secret), false, all);
});

test('a literal check refuses when the native tree is not proven complete', async () => {
  for (const [broken, cause] of [
    [{ snapshotVerdict: undefined }, 'unattested'],
    [{ truncated: true }, 'truncated'],
  ] as const) {
    const judge = scriptedJudge(() => assert.fail('a refused capture must not call Jev'));
    const f = walker([], judge);
    f.deps.captureScreen = () =>
      captureScreen({
        appId: 'com.test',
        requirePrivateInputs: true,
        native: async () => ({
          ...native([{ ref: '@welcome', type: 'StaticText', label: 'Welcome' }]),
          ...broken,
        }),
        react: async () => digest(),
      });
    const result = await runPlan(parsePlan('✓ "Welcome"').blocks!, f.deps);
    assert.equal(result.verdict, 'REFUSED', cause);
    assert.equal('code' in result && result.code, 'PRIVATE_INPUT_CAPTURE_UNKNOWN');
    assert.match(result.failure!.seen, new RegExp(`causes=${cause}\\)`));
  }
});

test('an open field showing its placeholder stays public, a secure one does not', async () => {
  const fields = digest([
    { role: 'textbox', testID: 'search', placeholder: 'Search', capabilities: { fill: true } },
    { role: 'textbox', testID: 'code', placeholder: 'Code', capabilities: { fill: true } },
  ]);
  const { f } = deps([
    {
      nodes: [
        { ref: '@search', type: 'TextField', identifier: 'search', value: 'Search' },
        { ref: '@results', type: 'StaticText', label: 'Search results' },
        { ref: '@code', type: 'SecureTextField', identifier: 'code', value: 'Code', secure: true },
        { ref: '@sent', type: 'StaticText', label: 'Code sent' },
      ],
      react: fields,
    },
  ]);
  const result = await runPlan(parsePlan('✓ "Nothing like this"').blocks!, f.deps);
  assert.match(result.failure!.seen, /Search results/);
  assert.match(result.failure!.seen, /••• sent/);
});

function viewportTree(
  laterY: number,
  { window = true, scrollBottom = 0, scrollTop = 0, laterWidth = 200 } = {},
) {
  const screen = { x: 0, y: 0, width: 390, height: 844 };
  const parent = scrollBottom ? 3 : 1;
  return attested([
    { index: 0, ref: '@app', type: 'Application', rect: screen },
    { index: 1, ref: '@win', type: window ? 'Window' : 'Other', parentIndex: 0, rect: screen },
    {
      index: 2,
      ref: '@welcome',
      type: 'StaticText',
      label: 'Welcome',
      parentIndex: 1,
      rect: { x: 20, y: 100, width: 200, height: 30 },
    },
    ...(scrollBottom
      ? [
          {
            index: 3,
            ref: '@list',
            type: 'ScrollView',
            parentIndex: 1,
            rect: { x: 0, y: scrollTop, width: 390, height: scrollBottom - scrollTop },
          },
        ]
      : []),
    {
      index: scrollBottom ? 4 : 3,
      ref: '@later',
      type: 'StaticText',
      label: 'Later',
      parentIndex: parent,
      rect: { x: 20, y: laterY, width: laterWidth, height: 30 },
    },
  ]);
}

async function walkViewport(plan: string, trees: ReturnType<typeof viewportTree>[]) {
  const f = walker(
    [],
    scriptedJudge(() => assert.fail('literal plans must not call Jev')),
  );
  let captures = 0;
  f.deps.captureScreen = () =>
    captureScreen({
      appId: 'com.test',
      requirePrivateInputs: true,
      native: async () => trees[Math.min(captures++, trees.length - 1)],
      react: async () => digest(),
    });
  return { result: await runPlan(parsePlan(plan).blocks!, f.deps), f };
}

test('text below the native viewport is not on screen until scrolled into it', async () => {
  for (const tree of [
    viewportTree(1200),
    viewportTree(700, { scrollBottom: 600 }),
    viewportTree(90, { scrollTop: 100, scrollBottom: 100 }),
    viewportTree(1200, { laterWidth: 0 }),
  ]) {
    const { result } = await walkViewport('✓ "Later"', [tree]);
    assert.equal(result.verdict, 'FAIL');
    assert.match(result.failure!.seen, /on screen: Welcome$/);
  }
  const { result, f } = await walkViewport('1. Scroll until you see "Later"', [
    viewportTree(1200),
    viewportTree(500),
  ]);
  assert.equal(result.verdict, 'PASS', result.failure?.seen);
  assert.deepEqual(f.actions, ['scroll down']);
  const unproven = await walkViewport('✓ "Later"', [viewportTree(1200, { window: false })]);
  assert.equal(unproven.result.verdict, 'PASS', 'without a Window nothing is claimed off screen');
});
