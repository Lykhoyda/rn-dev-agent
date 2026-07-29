import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, test } from 'node:test';
import { clearActiveSession, setActiveSession } from '../../dist/agent-device-wrapper.js';
import { createDeviceSnapshotHandler } from '../../dist/tools/device-session.js';

afterEach(() => clearActiveSession());

test('supported iOS runner close restores the cold-rebuild recovery credit', async () => {
  let resets = 0;
  let unbinds = 0;
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
    unbindRunner: async (beforeRelease) => {
      unbinds += 1;
      beforeRelease?.('ios');
    },
  });

  const result = await handler({ action: 'close' });
  const envelope = JSON.parse(result.content[0].text);

  assert.equal(envelope.ok, true);
  assert.equal(resets, 1);
  assert.equal(unbinds, 1);
});

test('idempotent close resets iOS recovery credit for stranded runner authority', async () => {
  let resets = 0;
  let unbinds = 0;
  const handler = createDeviceSnapshotHandler({
    resetIosRunnerRebuildBudget: () => {
      resets += 1;
    },
    unbindRunner: async (beforeRelease) => {
      unbinds += 1;
      beforeRelease?.('ios');
    },
  });

  const result = await handler({ action: 'close', platform: 'ios' });
  const envelope = JSON.parse(result.content[0].text);

  assert.equal(envelope.ok, true);
  assert.equal(resets, 1);
  assert.equal(unbinds, 1);
});

test('idempotent close preserves iOS rebuild guard without runner authority', async () => {
  let resets = 0;
  let unbinds = 0;
  const handler = createDeviceSnapshotHandler({
    resetIosRunnerRebuildBudget: () => {
      resets += 1;
    },
    unbindRunner: async () => {
      unbinds += 1;
    },
  });

  const result = await handler({ action: 'close', platform: 'ios' });
  const envelope = JSON.parse(result.content[0].text);

  assert.equal(envelope.ok, true);
  assert.equal(resets, 0);
  assert.equal(unbinds, 1);
});
