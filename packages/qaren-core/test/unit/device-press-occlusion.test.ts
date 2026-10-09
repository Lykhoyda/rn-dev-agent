// A runner occlusion refusal on a press reaches the walker typed and mutation-free.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { _setActiveSessionForTest, _setRunAgentDeviceForTest, markSnapshotDirty } =
  await import('../../dist/agent-device-wrapper.js');
const { createDevicePressHandler } = await import('../../dist/handlers/device-interact.js');
const { updateRefMapFromFlat, clearRefMap } = await import('../../dist/fast-runner-ref-map.js');
const { okResult, failResult } = await import('../../dist/utils.js');

const NODES = [
  { ref: '@e1', identifier: 'go', type: 'Button', rect: { x: 20, y: 700, width: 300, height: 44 } },
];

async function press(result: unknown): Promise<{ env: any; presses: number }> {
  _setActiveSessionForTest({ platform: 'ios', deviceId: 'TEST-DEVICE', appId: 'com.test' });
  clearRefMap();
  markSnapshotDirty();
  updateRefMapFromFlat(NODES as never, { snapshotGeneration: 3, keyboardVisible: false });
  let presses = 0;
  _setRunAgentDeviceForTest(async (cliArgs: string[]) => {
    if (cliArgs[0] !== 'press') return okResult({ nodes: NODES });
    presses += 1;
    return result;
  });
  try {
    const handler = createDevicePressHandler((() => ({ isConnected: false })) as never);
    const out = await handler({ ref: '@e1' });
    return { env: JSON.parse(out.content[0].text), presses };
  } finally {
    _setRunAgentDeviceForTest(null);
    _setActiveSessionForTest(null);
    clearRefMap();
  }
}

test('an occluded tap keeps its code and mutation none, with no heal retry', async () => {
  const { env, presses } = await press(
    failResult('FOCUS_TARGET_OCCLUDED: covered', 'FOCUS_TARGET_OCCLUDED', { mutation: 'none' }),
  );
  assert.equal(env.ok, false);
  assert.equal(env.code, 'FOCUS_TARGET_OCCLUDED');
  assert.equal(env.meta.mutation, 'none');
  assert.equal(presses, 1);
});

test('O5: an unavailable hit test dispatches the tap as before', async () => {
  const { env, presses } = await press(
    okResult({ message: 'tapped', occlusionCheck: 'unavailable' }),
  );
  assert.equal(env.ok, true);
  assert.equal(presses, 1);
});
