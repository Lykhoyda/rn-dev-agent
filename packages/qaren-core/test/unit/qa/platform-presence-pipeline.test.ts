import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import vm from 'node:vm';
import { captureScreen } from '../../../dist/qa/capture.js';
import { parsePlan } from '../../../dist/qa/plan.js';
import { decideScreen } from '../../../dist/qa/resolve.js';
import { runPlan } from '../../../dist/qa/walker.js';
import { clearRefMap } from '../../../dist/fast-runner-ref-map.js';
import {
  _setCapabilitiesForTest,
  _setFetchForTest,
  _setRunnerStateForTest,
  runIOS,
} from '../../../dist/runners/rn-fast-runner-client.js';
import { parseEnvelope } from '../../helpers/result-helpers.js';
import { buildFiber, createSandbox } from '../helpers/inject-harness.js';
import { choice, scriptedJudge, walker } from './judgment-fixtures.ts';
import { nativeCapture } from './platform-presence-fixtures.ts';
import { REQUIRED_IOS_COMMANDS, REQUIRED_IOS_FEATURES } from '../../../dist/runners/protocol.js';
import { inputValues, redactEvidence } from '../../../dist/qa/privacy.js';

afterEach(() => {
  _setFetchForTest(globalThis.fetch);
  _setRunnerStateForTest(null);
  _setCapabilitiesForTest([]);
  clearRefMap();
});

async function capture(source = nativeCapture(), elapsed = 0, hostType = 'RCTView') {
  _setRunnerStateForTest({
    port: 22088,
    pid: process.pid,
    deviceId: 'sim',
    bundleId: 'com.test',
    startedAt: 'now',
  });
  _setCapabilitiesForTest(['PLATFORM_PRESENCE_V1']);
  _setFetchForTest(async (url, init) => {
    if (String(url).endsWith('/health'))
      return Response.json({
        ok: true,
        protocolVersion: 2,
        commands: REQUIRED_IOS_COMMANDS,
        capabilities: [...REQUIRED_IOS_FEATURES, 'HONEST_HITTABLE', 'PLATFORM_PRESENCE_V1'],
      });
    const request = JSON.parse(String(init?.body));
    assert.equal(request.platformPresence, true);
    assert.equal(request.appBundleId, 'com.test');
    assert.equal(request.interactiveOnly, undefined);
    return Response.json({ ok: true, data: source });
  });
  const sandbox = createSandbox({
    fiberRoot: buildFiber({ hostType, props: { testID: 'save', onClick() {} } }),
  });
  let clock = 0;
  return captureScreen({
    appId: 'com.test',
    now: () => clock,
    native: async () => {
      const { data, meta } = parseEnvelope(
        await runIOS({ command: 'snapshot', bundleId: 'com.test', platformPresence: true }),
      );
      return { ...data, snapshotVerdict: meta.snapshotVerdict };
    },
    react: async () => {
      clock = elapsed;
      return JSON.parse(
        vm.runInContext(
          '__QAREN.getTree({ interactiveOnly: true, semanticEvidence: true })',
          sandbox,
        ),
      );
    },
  });
}

test('native wire through normalization, real React producer and capture reaches a positive phrase presence judgment', async () => {
  const screen = await capture();
  assert.deepEqual(screen.coverage, { native: 'complete', react: 'complete' });
  assert.equal(screen.elements[0].semantic?.visibility, 'unknown');
  assert.equal(screen.elements[1].semantic?.visibility, 'visible');
  const judge = scriptedJudge((questions, _index, state) => {
    assert.equal(questions.visibility_1.type, 'noul');
    assert.match(questions.visibility_1.instructions, /not complete visual exposure/);
    assert.deepEqual(state.visibilityEvidence, [
      'Button "Save" [testID save] (native accessibility name; platform-observed presence)',
    ]);
    return { visibility_1: { type: 'noul', noul: 0.99 } };
  });
  const f = walker([screen], judge);
  const result = await runPlan(parsePlan('1. Wait for the save control').blocks!, f.deps);
  assert.equal(result.verdict, 'PASS', result.failure?.seen);
  assert.equal(result.steps[0].resolvedBy, 'jev');
  assert.equal(judge.requests.length, 1);
  assert.deepEqual(f.actions, []);
});

test('live platform presence is independent of the geometric hint and enabledness', async () => {
  const source = nativeCapture();
  source.nodes[1].hittable = false;
  source.nodes[1].enabled = false;
  const screen = await capture(source);
  const judge = scriptedJudge(() => ({ visibility_1: { type: 'noul', noul: 0.99 } }));
  const f = walker([screen], judge);
  const result = await runPlan(parsePlan('1. Wait for the save control').blocks!, f.deps);
  assert.equal(result.verdict, 'PASS', result.failure?.seen);
  assert.deepEqual(f.actions, []);
  const action = await decideScreen(screen, judge, undefined, {
    kind: 'press',
    target: { phrase: 'save' },
    line: 2,
  });
  assert.ok(action.target && 'refuse' in action.target);
});

test('a native button can be selected only with complete positive native observation', async () => {
  const screen = await capture();
  const judge = scriptedJudge((questions) => ({ target_1: choice(questions.target_1) }));
  const f = walker([screen], judge);
  const result = await runPlan(parsePlan('1. Tap the save control').blocks!, f.deps);
  assert.equal(result.verdict, 'PASS', result.failure?.seen);
  assert.deepEqual(f.actions, ['press @e1']);
});

test('unknown native observations refuse instead of authorizing absence, polling or scrolling', async () => {
  const source = nativeCapture();
  source.nodes[1].presence.status = 'unknown';
  delete source.nodes[1].presence.observedUptimeMs;
  const screen = await capture(source);
  assert.equal(screen.coverage?.native, 'complete');
  assert.equal(screen.elements[1].semantic?.visibility, 'unknown');
  for (const line of [
    'Wait for the save control',
    'Scroll down until the save control',
    'Tap the save control',
  ]) {
    const judge = scriptedJudge(() => assert.fail('unknown platform presence cannot reach Jev'));
    const f = walker([screen], judge);
    const result = await runPlan(parsePlan(`1. ${line}`).blocks!, f.deps);
    assert.equal(result.verdict, 'FAIL');
    assert.match(result.failure!.seen, /SCREEN_EVIDENCE_INCOMPLETE/);
    assert.deepEqual(f.actions, []);
  }
});

test('old, partial, wrong-app and over-budget evidence cannot become positive presence', async () => {
  for (const patch of [
    { presenceCapture: undefined },
    { presenceCapture: { ...nativeCapture().presenceCapture, appId: 'other.app' } },
    { presenceCapture: { ...nativeCapture().presenceCapture, complete: false } },
    { snapshotGeneration: 8 },
    { truncated: true },
    { presenceCapture: { ...nativeCapture().presenceCapture, endedUptimeMs: 5100 } },
  ]) {
    const screen = await capture({ ...nativeCapture(), ...patch });
    assert.notEqual(screen.coverage?.native, 'complete');
    const judge = scriptedJudge(() => assert.fail('invalid evidence must not reach Jev'));
    const result = await decideScreen(screen, judge, undefined, {
      kind: 'wait',
      target: { phrase: 'save' },
      line: 1,
    });
    assert.ok(result.visibility && 'refuse' in result.visibility);
  }
  for (const elapsed of [5000, 5001, -1, NaN]) {
    const screen = await capture(nativeCapture(), elapsed);
    assert.equal(screen.coverage?.native, 'incomplete');
  }
});

test('presence names do not gain heading, spatial, visual or aggregate-label semantics', async () => {
  const screen = await capture();
  for (const phrase of [
    'the save heading',
    'the red save control',
    'the save control at the top',
  ]) {
    const judge = scriptedJudge(() => assert.fail('unsupported trait must not reach Jev'));
    const result = await decideScreen(screen, judge, undefined, {
      kind: 'wait',
      target: { phrase },
      line: 1,
    });
    if (phrase === 'the save heading') {
      assert.deepEqual(result.visibility, { verdict: 'pending' });
      continue;
    }
    assert.ok(result.visibility && 'refuse' in result.visibility);
    assert.equal(result.visibility.refuse, 'VISIBILITY_UNSUPPORTED');
  }
  for (const labelSource of ['value', 'descendant']) {
    const source = nativeCapture();
    source.nodes[1].presence.labelSource = labelSource;
    const projected = await capture(source);
    const judge = scriptedJudge(() => assert.fail('derived labels must not reach Jev'));
    const result = await decideScreen(projected, judge, undefined, {
      kind: 'wait',
      target: { phrase: 'save' },
      line: 1,
    });
    assert.ok(result.visibility && 'refuse' in result.visibility);
  }
});

test('component inference cannot turn a native generic container into a proven control', async () => {
  const source = nativeCapture();
  source.nodes[1].type = 'Other';
  const screen = await capture(source);
  assert.equal(screen.elements[1].kind, 'other', 'presence mode retains native classification');
  assert.equal(screen.elements[1].semantic?.press, 'unknown');
  const judge = scriptedJudge(() =>
    assert.fail('unassociated inferred role cannot supply eligibility'),
  );
  for (const kind of ['wait', 'press'] as const) {
    const result = await decideScreen(screen, judge, undefined, {
      kind,
      target: { phrase: 'save' },
      line: 1,
    });
    const decision = result.visibility ?? result.target;
    assert.ok(decision && 'refuse' in decision);
  }
});

test('native-only names cannot prove a private input value', async () => {
  const source = nativeCapture();
  source.nodes[1].type = 'TextField';
  const screen = await capture(source, 0, 'AndroidTextInput');
  const judge = scriptedJudge(() => assert.fail('name observations cannot establish input values'));
  for (const predicate of [
    'equals private-value',
    'is empty',
    'is blank',
    'is not empty',
    'is not blank',
    'is filled',
    'has no value',
  ]) {
    const result = await decideScreen(screen, judge, undefined, {
      kind: 'wait',
      target: { phrase: `Save ${predicate}` },
      line: 1,
    });
    assert.deepEqual(result.visibility, { verdict: 'unsure' });
  }
});

test('rejected native evidence still protects value-derived input names in checks and failure ledgers', async () => {
  const privateValue = 'unshared-sensitive-value';
  for (const failure of [
    'incomplete',
    'generation',
    'expired',
    'malformed-node',
    'missing-node',
    'missing-envelope',
  ]) {
    const source = nativeCapture();
    source.nodes[1].type = 'TextField';
    source.nodes[1].label = privateValue;
    source.nodes[1].presence.labelSource = 'value';
    if (failure === 'incomplete') source.presenceCapture.complete = false;
    if (failure === 'generation') source.snapshotGeneration = 8;
    if (failure === 'malformed-node') source.nodes[1].presence.status = 'bad';
    if (failure === 'missing-node') delete source.nodes[1].presence;
    if (failure === 'missing-envelope') delete source.presenceCapture;
    const screen = await capture(source, failure === 'expired' ? 5000 : 0, 'AndroidTextInput');
    assert.notEqual(screen.coverage?.native, 'complete');
    assert.ok(inputValues(screen).includes(privateValue), failure);
    assert.equal(redactEvidence(screen, privateValue), '•••', failure);
    const judge = scriptedJudge((questions, _index, state) => {
      assert.deepEqual(Object.keys(questions), ['check_1']);
      assert.equal(JSON.stringify({ state, questions }).includes(privateValue), false, failure);
      return { check_1: { type: 'noul', noul: 0.99 } };
    });
    const f = walker([screen], judge);
    const result = await runPlan(
      parsePlan('✓ Save appeared\n1. Wait for the save control').blocks!,
      f.deps,
    );
    assert.equal(result.verdict, 'FAIL');
    assert.equal(JSON.stringify(result).includes(privateValue), false, failure);
    assert.deepEqual(f.actions, []);
  }
});

test('native presence cannot authorize positional actions without layout evidence', async () => {
  const source = nativeCapture();
  source.nodes.push({
    ...source.nodes[1],
    ref: '@e2',
    index: 2,
    identifier: 'other-save',
    rect: { ...source.nodes[1].rect, y: 700 },
    presence: { ...source.nodes[1].presence, nodeIndex: 2 },
  });
  const screen = await capture(source);
  for (const target of ['the bottom Save button', 'the top Save button', 'the red Save button']) {
    const judge = scriptedJudge(() => assert.fail('missing layout evidence cannot reach Jev'));
    const f = walker([screen], judge);
    const result = await runPlan(parsePlan(`1. Tap ${target}`).blocks!, f.deps);
    assert.match(result.failure!.seen, /TARGET_UNSUPPORTED/);
    assert.deepEqual(f.actions, []);
  }
});

test('independent native names retain the unchanged 30-contribution limit', async () => {
  for (const count of [30, 31]) {
    const source = nativeCapture();
    for (let index = 2; index <= count; index++) {
      source.nodes.push({
        ...source.nodes[1],
        ref: `@e${index}`,
        index,
        identifier: `save-${index}`,
        rect: { ...source.nodes[1].rect, y: index * 20 },
        presence: { ...source.nodes[1].presence, nodeIndex: index },
      });
    }
    const screen = await capture(source);
    const judge = scriptedJudge((_questions, _index, state) => {
      assert.equal(state.visibilityEvidence.length, 30);
      return { visibility_1: { type: 'noul', noul: 0.99 } };
    });
    const result = await decideScreen(screen, judge, undefined, {
      kind: 'wait',
      target: { phrase: 'Save' },
      line: 1,
    });
    if (count === 30) assert.deepEqual(result.visibility, { verdict: 'present' });
    else {
      assert.equal(result.visibility.refuse, 'CANDIDATE_LIMIT');
      assert.equal(judge.requests.length, 0);
    }
  }
});
