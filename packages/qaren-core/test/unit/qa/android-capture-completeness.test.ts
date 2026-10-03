import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { captureScreen } from '../../../dist/qa/capture.js';
import { NativeSnapshotIncomplete } from '../../../dist/qa/private-input.js';
import { parsePlan } from '../../../dist/qa/plan.js';
import { runPlan } from '../../../dist/qa/walker.js';
import {
  _setAndroidRunnerStateForTest,
  _setFetchForTest,
  runAndroid,
} from '../../../dist/runners/rn-android-runner-client.js';
import {
  REQUIRED_ANDROID_COMMANDS,
  REQUIRED_ANDROID_FEATURES,
  RUNNER_PROTOCOL_VERSION,
  getPluginVersion,
} from '../../../dist/runners/protocol.js';
import { clearRefMap } from '../../../dist/fast-runner-ref-map.js';
import { QA_READ_ONLY_CAPABILITY } from '../../../dist/runners/qa-native-policy.js';
import { parseEnvelope } from '../../helpers/result-helpers.js';
import { scriptedJudge, walker } from './judgment-fixtures.ts';

beforeEach(() => {
  _setAndroidRunnerStateForTest({
    hostPort: 22089,
    devicePort: 22089,
    pid: process.pid,
    deviceId: 'test-emulator',
    bundleId: 'com.test',
    startedAt: 'now',
  });
});
afterEach(() => {
  _setFetchForTest(globalThis.fetch);
  _setAndroidRunnerStateForTest(null);
  clearRefMap();
});

const node = {
  index: 0,
  type: 'android.widget.Button',
  label: 'Save',
  identifier: 'save',
  packageName: 'com.test',
  enabled: true,
  hittable: true,
  rect: { x: 0, y: 0, width: 100, height: 50 },
};
const complete = () => ({
  nodes: [
    node,
    { ...node, index: 1, type: 'android.widget.EditText', label: 'Email', identifier: 'email' },
  ],
  truncated: false,
  normalizationDroppedNodes: 0,
});

async function capture(data: unknown) {
  _setFetchForTest(async (url, init) => {
    if (String(url).endsWith('/health'))
      return Response.json({
        ok: true,
        protocolVersion: RUNNER_PROTOCOL_VERSION,
        runnerVersion: getPluginVersion(),
        commands: REQUIRED_ANDROID_COMMANDS,
        capabilities: [...REQUIRED_ANDROID_FEATURES, QA_READ_ONLY_CAPABILITY],
      });
    assert.equal(JSON.parse(String(init?.body)).command, 'snapshot');
    return Response.json({ ok: true, data });
  });
  return captureScreen({
    appId: 'com.test',
    requirePrivateInputs: true,
    now: () => 0,
    native: async () => {
      const result = parseEnvelope(
        await runAndroid({
          command: 'snapshot',
          deviceId: 'test-emulator',
          bundleId: 'com.test',
          qaReadOnly: true,
        }),
      );
      assert.equal(result.ok, true);
      return { ...result.data, snapshotVerdict: result.meta.snapshotVerdict };
    },
    react: async () => ({
      interactive: [],
      verdict: { state: 'ok', path: 'interactive', complete: true },
      hostEvidence: { hosts: [], complete: true },
    }),
  });
}

test('Android production adapter → capture → walker admits complete literal actions and checks', async () => {
  for (const [plan, actions] of [
    ['1. Back', ['back']],
    ['1. Tap "Save"', ['press @e0']],
    ['1. Wait for "Save"', []],
    ['1. Fill "Email" with "Ada"', ['fill @e1 Ada']],
    ['1. Scroll down', ['scroll down']],
    ['1. Scroll until you see "Save"', []],
    ['✓ "Save"', []],
  ] as const) {
    const judge = scriptedJudge(() => assert.fail('literal plans must not call Jev'));
    const f = walker([], judge);
    f.deps.captureScreen = () => capture(complete());
    const result = await runPlan(parsePlan(plan).blocks!, f.deps);
    assert.equal(result.verdict, 'PASS', `${plan}: ${result.failure?.seen}`);
    assert.deepEqual(f.actions, actions);
  }
  const screen = await capture(complete());
  assert.equal(screen.captureCoverage?.native, 'complete');
  assert.equal(screen.coverage?.native, 'unknown', 'raw completeness is not semantic presence');
});

test('Android producer or host normalization losses never become usable literal acquisitions', async () => {
  for (const data of [
    { nodes: [node] },
    { ...complete(), truncated: true },
    { ...complete(), truncated: undefined },
    { ...complete(), truncated: 'false' },
    { ...complete(), normalizationDroppedNodes: 1 },
    { ...complete(), normalizationDroppedNodes: undefined },
    { ...complete(), normalizationDroppedNodes: -1 },
    { ...complete(), normalizationDroppedNodes: 0.5 },
    { ...complete(), normalizationDroppedNodes: '0' },
    { ...complete(), normalizationDroppedNodes: Number.MAX_SAFE_INTEGER + 1 },
    { ...complete(), nodes: [node, { index: 1, type: 'android.widget.TextView' }] },
    ...[
      null,
      { ...node, index: 2, rect: {} },
      { ...node, index: 2, rect: { ...node.rect, width: -1 } },
    ].map((invalid) => ({ ...complete(), nodes: [node, invalid] })),
    { ...complete(), nodes: [] },
  ]) {
    let screen;
    try {
      screen = await capture(data);
    } catch (error) {
      // A provably incomplete tree refuses at capture, which is never usable either.
      assert.ok(error instanceof NativeSnapshotIncomplete, JSON.stringify(data));
      continue;
    }
    assert.notEqual(screen.captureCoverage?.native, 'complete', JSON.stringify(data));
    for (const plan of ['1. Back', '1. Tap "Save"', '1. Wait for "Save"']) {
      const judge = scriptedJudge(() => assert.fail('unusable acquisition must not call Jev'));
      const f = walker([screen], judge);
      const result = await runPlan(parsePlan(plan).blocks!, f.deps);
      assert.equal(result.verdict, 'FAIL', plan);
      assert.match(result.failure!.seen, /NATIVE_ACQUISITION_UNUSABLE/);
      assert.deepEqual(f.actions, []);
    }
  }
});

test('Android acquisition reports producer and host losses together', async () => {
  await assert.rejects(
    capture({
      ...complete(),
      normalizationDroppedNodes: 2,
      nodes: [node, { index: 1, type: 'android.widget.TextView' }],
    }),
    (error) => error instanceof NativeSnapshotIncomplete && error.causes.includes('dropped=3'),
  );
});

test('Android incomplete producer reply never permits a mutation', async () => {
  for (const data of [
    { ...complete(), normalizationDroppedNodes: 2 },
    { ...complete(), truncated: true },
  ]) {
    const screen = await capture(data);
    const f = walker(
      [screen],
      scriptedJudge(() => assert.fail('incomplete capture must not ask Jev')),
    );
    const result = await runPlan(parsePlan('1. Tap "Save"').blocks!, f.deps);
    assert.equal(result.verdict, 'FAIL');
    assert.match(result.failure!.seen, /NATIVE_ACQUISITION_UNUSABLE/);
    assert.deepEqual(f.actions, []);
  }
});

test('Android input text reported as a label stays masked with its echo', async () => {
  const secret = 'prefilled-c@example.test';
  const data = {
    ...complete(),
    nodes: [
      node,
      { ...node, index: 1, type: 'android.widget.EditText', label: secret, identifier: 'email' },
      { ...node, index: 2, type: 'android.widget.TextView', label: `Sent to ${secret}` },
    ],
  };
  const f = walker(
    [],
    scriptedJudge(() => assert.fail('literal plans must not call Jev')),
  );
  f.deps.captureScreen = () => capture(data);
  const result = await runPlan(parsePlan('✓ "Nothing like this"').blocks!, f.deps);
  assert.equal(result.verdict, 'FAIL');
  assert.match(result.failure!.seen, /Sent to •••/);
  assert.equal(JSON.stringify({ result, rows: f.rows }).includes(secret), false);
});
