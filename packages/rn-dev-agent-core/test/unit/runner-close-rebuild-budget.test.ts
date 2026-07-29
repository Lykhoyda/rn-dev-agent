import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, test } from 'node:test';
import { clearActiveSession, setActiveSession } from '../../dist/agent-device-wrapper.js';
import { createDeviceSnapshotHandler } from '../../dist/tools/device-session.js';

afterEach(() => clearActiveSession());

test('supported iOS runner close restores the cold-rebuild recovery credit', async () => {
  let resets = 0;
  setActiveSession({
    name: 'runner-budget',
    platform: 'ios',
    deviceId: randomUUID().toUpperCase(),
    appId: 'com.rndevagent.testapp',
  });
  const handler = createDeviceSnapshotHandler({
    resetIosRunnerRebuildBudget: () => {
      resets += 1;
    },
  });

  const result = await handler({ action: 'close' });
  const envelope = JSON.parse(result.content[0].text);

  assert.equal(envelope.ok, true);
  assert.equal(resets, 1);
});
