import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeviceResetStateHandler } from '../../dist/tools/device-reset-state.js';
import { resolveIosLifecycleTarget } from '../../dist/tools/app-lifecycle.js';

const UDID = '5C10B45B-2065-458B-B885-0F83F49747C8';
const APP_ID = 'com.rndevagent.testapp';

function client() {
  return {
    isConnected: true,
    helpersInjected: true,
    connectedTarget: null,
    evaluate: async () => ({ value: '{}' }),
    softReconnect: async () => undefined,
  } as never;
}

function envelope(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0]!.text) as {
    ok: boolean;
    data: { deviceId?: string; steps: Array<{ step: string; deviceId?: string }> };
  };
}

test('GH-588 V4: lifecycle reset threads the matching active iOS session UDID to terminate and launch', async () => {
  const calls: Array<{ operation: string; appId: string; platform: string; deviceId?: string }> =
    [];
  const handler = createDeviceResetStateHandler(() => client(), {
    getSession: () => ({ platform: 'ios', deviceId: UDID, appId: APP_ID }),
    terminateApp: async (appId, platform, deviceId) => {
      calls.push({ operation: 'terminate', appId, platform, deviceId });
    },
    launchApp: async (appId, platform, deviceId) => {
      calls.push({ operation: 'launch', appId, platform, deviceId });
    },
  });

  const result = envelope(
    await handler({
      appId: APP_ID,
      platform: 'ios',
      relaunch: true,
      waitForReady: false,
    }),
  );

  assert.equal(result.ok, true);
  assert.equal(result.data.deviceId, UDID);
  assert.deepEqual(calls, [
    { operation: 'terminate', appId: APP_ID, platform: 'ios', deviceId: UDID },
    { operation: 'launch', appId: APP_ID, platform: 'ios', deviceId: UDID },
  ]);
  assert.deepEqual(
    result.data.steps.map(({ step, deviceId }) => ({ step, deviceId })),
    [
      { step: 'terminate', deviceId: UDID },
      { step: 'launch', deviceId: UDID },
    ],
  );
});

test('GH-588 V4: another app session is never borrowed as lifecycle authority', async () => {
  const targets: Array<string | undefined> = [];
  const handler = createDeviceResetStateHandler(() => client(), {
    getSession: () => ({ platform: 'ios', deviceId: UDID, appId: 'com.other.app' }),
    terminateApp: async (_appId, _platform, deviceId) => {
      targets.push(deviceId);
    },
  });

  await handler({ appId: APP_ID, platform: 'ios', relaunch: false });

  assert.deepEqual(targets, [undefined]);
});

test('GH-588 V4: supplied iOS lifecycle identities are exact UDIDs or fail closed', () => {
  assert.equal(resolveIosLifecycleTarget(UDID), UDID);
  assert.equal(resolveIosLifecycleTarget(), 'booted');
  assert.throws(() => resolveIosLifecycleTarget('booted'), /exact simulator UDID/);
  assert.throws(() => resolveIosLifecycleTarget('emulator-5560'), /exact simulator UDID/);
});
