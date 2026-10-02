import assert from 'node:assert/strict';
import { test } from 'node:test';
import { captureScreen } from '../../../dist/qa/capture.js';
import type { ReactObservation } from '../../../dist/qa/capture.js';
import { parsePlan } from '../../../dist/qa/plan.js';
import { runPlan } from '../../../dist/qa/walker.js';
import type { NativeNode } from '../../../dist/qa/screen.js';
import { scriptedJudge, walker } from './judgment-fixtures.ts';
import { nativeCapture } from './platform-presence-fixtures.ts';

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
