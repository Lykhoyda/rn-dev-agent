// Story 05 Task 8 (GH #386): device_batch testID resolution refuses ambiguous
// matches for mutating steps (press / fill / find+tap) instead of guess-tapping
// the first match. A pure inspection find (no tap) stays permissive — first
// match — but reports the ambiguity in its ok payload (review consensus #5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findRefsByTestID, findRefByTestID } from '../../dist/tools/device-batch.js';

// createDeviceBatchHandler's top-level envelope shape differs by outcome:
// a fully-successful (or continueOnError) batch returns okResult({..., results})
// -> env.data.results; a hard step failure (default continueOnError:false)
// returns failResult(msg, { ..., results }) -> the 2-arg object form lands
// under env.meta (utils.js failResult), so results live at env.meta.results.
// Read whichever is present so tests don't care which branch fired.
function batchResults(env) {
  return env.data?.results ?? env.meta?.results;
}

const flatEnvelope = JSON.stringify({
  ok: true,
  data: {
    nodes: [
      { ref: '@e0', identifier: 'row' },
      { ref: '@e1', identifier: 'row' },
      { ref: '@e2', identifier: 'save-btn' },
    ],
  },
});
const treeEnvelope = JSON.stringify({
  ok: true,
  data: {
    tree: {
      ref: 'e0',
      children: [
        { ref: 'e1', identifier: 'row' },
        { ref: 'e2', identifier: 'row', children: [{ ref: 'e3', identifier: 'save-btn' }] },
      ],
    },
  },
});

test('flat shape: returns ALL matches, bare refs', () => {
  assert.deepEqual(findRefsByTestID(flatEnvelope, 'row'), ['e0', 'e1']);
  assert.deepEqual(findRefsByTestID(flatEnvelope, 'save-btn'), ['e2']);
  assert.deepEqual(findRefsByTestID(flatEnvelope, 'missing'), []);
});

test('tree shape: returns ALL matches, bare refs', () => {
  assert.deepEqual(findRefsByTestID(treeEnvelope, 'row'), ['e1', 'e2']);
  assert.deepEqual(findRefsByTestID(treeEnvelope, 'save-btn'), ['e3']);
});

test('findRefByTestID back-compat: first match or null', () => {
  assert.equal(findRefByTestID(flatEnvelope, 'row'), 'e0');
  assert.equal(findRefByTestID(flatEnvelope, 'missing'), null);
});

test('batch press step refuses ambiguous testID with candidates', async () => {
  const { _setActiveSessionForTest, _setRunAgentDeviceForTest } =
    await import('../../dist/agent-device-wrapper.js');
  const { createDeviceBatchHandler } = await import('../../dist/tools/device-batch.js');
  const { okResult } = await import('../../dist/utils.js');
  _setActiveSessionForTest({ platform: 'ios', deviceId: 'TEST-UDID', appId: 'com.test' });
  const presses = [];
  _setRunAgentDeviceForTest(async (cliArgs) => {
    if (cliArgs[0] === 'snapshot') {
      return { content: [{ type: 'text', text: flatEnvelope }] };
    }
    presses.push(cliArgs);
    return okResult({});
  });
  try {
    const handler = createDeviceBatchHandler();
    // screenshotOn: 'none' — isolates this assertion from the unrelated
    // failure-screenshot capture (captureAndResizeScreenshot also dispatches
    // through the same runNative mock and would otherwise pollute `presses`
    // with a ['screenshot', ...] call, which is not what this test is about).
    const result = await handler({
      steps: [{ action: 'press', testID: 'row' }],
      screenshotOn: 'none',
    });
    const env = JSON.parse(result.content[0].text);
    const step = batchResults(env)[0];
    assert.equal(step.success, false);
    assert.match(step.error, /AMBIGUOUS_TESTID|matches 2/);
    assert.equal(presses.filter((c) => c[0] === 'press').length, 0); // never guess-tapped
  } finally {
    _setRunAgentDeviceForTest(null);
    _setActiveSessionForTest(null);
  }
});

test('batch find WITHOUT tap returns first match + ambiguity info instead of refusing', async () => {
  const { _setActiveSessionForTest, _setRunAgentDeviceForTest } =
    await import('../../dist/agent-device-wrapper.js');
  const { createDeviceBatchHandler } = await import('../../dist/tools/device-batch.js');
  _setActiveSessionForTest({ platform: 'ios', deviceId: 'TEST-UDID', appId: 'com.test' });
  _setRunAgentDeviceForTest(async () => ({ content: [{ type: 'text', text: flatEnvelope }] }));
  try {
    const result = await createDeviceBatchHandler()({
      steps: [{ action: 'find', testID: 'row' }],
      screenshotOn: 'none',
    });
    const env = JSON.parse(result.content[0].text);
    const step = batchResults(env)[0];
    assert.equal(step.success, true);
    assert.equal(step.data.resolved, 'e0');
    assert.equal(step.data.ambiguous, true);
    assert.deepEqual(step.data.candidates, ['@e0', '@e1']);
  } finally {
    _setRunAgentDeviceForTest(null);
    _setActiveSessionForTest(null);
  }
});

test('batch find+tap refuses ambiguous testID with candidates', async () => {
  const { _setActiveSessionForTest, _setRunAgentDeviceForTest } =
    await import('../../dist/agent-device-wrapper.js');
  const { createDeviceBatchHandler } = await import('../../dist/tools/device-batch.js');
  const { okResult } = await import('../../dist/utils.js');
  _setActiveSessionForTest({ platform: 'ios', deviceId: 'TEST-UDID', appId: 'com.test' });
  const presses = [];
  _setRunAgentDeviceForTest(async (cliArgs) => {
    if (cliArgs[0] === 'snapshot') {
      return { content: [{ type: 'text', text: flatEnvelope }] };
    }
    presses.push(cliArgs);
    return okResult({});
  });
  try {
    const result = await createDeviceBatchHandler()({
      steps: [{ action: 'find', testID: 'row', tap: true }],
      screenshotOn: 'none',
    });
    const env = JSON.parse(result.content[0].text);
    const step = batchResults(env)[0];
    assert.equal(step.success, false);
    assert.match(step.error, /AMBIGUOUS_TESTID|matches 2/);
    assert.equal(presses.filter((c) => c[0] === 'press').length, 0);
  } finally {
    _setRunAgentDeviceForTest(null);
    _setActiveSessionForTest(null);
  }
});

test('batch fill step refuses ambiguous testID with candidates', async () => {
  const { _setActiveSessionForTest, _setRunAgentDeviceForTest } =
    await import('../../dist/agent-device-wrapper.js');
  const { createDeviceBatchHandler } = await import('../../dist/tools/device-batch.js');
  const { okResult } = await import('../../dist/utils.js');
  _setActiveSessionForTest({ platform: 'ios', deviceId: 'TEST-UDID', appId: 'com.test' });
  const fills = [];
  _setRunAgentDeviceForTest(async (cliArgs) => {
    if (cliArgs[0] === 'snapshot') {
      return { content: [{ type: 'text', text: flatEnvelope }] };
    }
    fills.push(cliArgs);
    return okResult({});
  });
  try {
    const result = await createDeviceBatchHandler()({
      steps: [{ action: 'fill', testID: 'row', text: 'hello' }],
      screenshotOn: 'none',
    });
    const env = JSON.parse(result.content[0].text);
    const step = batchResults(env)[0];
    assert.equal(step.success, false);
    assert.match(step.error, /AMBIGUOUS_TESTID|matches 2/);
    assert.equal(fills.filter((c) => c[0] === 'fill').length, 0);
  } finally {
    _setRunAgentDeviceForTest(null);
    _setActiveSessionForTest(null);
  }
});

test('batch press step with unique testID still succeeds (no false-positive refusal)', async () => {
  const { _setActiveSessionForTest, _setRunAgentDeviceForTest } =
    await import('../../dist/agent-device-wrapper.js');
  const { createDeviceBatchHandler } = await import('../../dist/tools/device-batch.js');
  const { okResult } = await import('../../dist/utils.js');
  _setActiveSessionForTest({ platform: 'ios', deviceId: 'TEST-UDID', appId: 'com.test' });
  const presses = [];
  _setRunAgentDeviceForTest(async (cliArgs) => {
    if (cliArgs[0] === 'snapshot') {
      return { content: [{ type: 'text', text: flatEnvelope }] };
    }
    presses.push(cliArgs);
    return okResult({});
  });
  try {
    const result = await createDeviceBatchHandler()({
      steps: [{ action: 'press', testID: 'save-btn' }],
      screenshotOn: 'none',
    });
    const env = JSON.parse(result.content[0].text);
    const step = batchResults(env)[0];
    assert.equal(step.success, true);
    assert.deepEqual(
      presses.filter((c) => c[0] === 'press'),
      [['press', '@e2']],
    );
  } finally {
    _setRunAgentDeviceForTest(null);
    _setActiveSessionForTest(null);
  }
});
