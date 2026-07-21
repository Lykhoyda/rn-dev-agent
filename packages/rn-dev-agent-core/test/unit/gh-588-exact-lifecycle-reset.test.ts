import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeviceResetStateHandler } from '../../dist/tools/device-reset-state.js';
import {
  buildAndroidLaunchArgv,
  resolveAndroidLifecycleTarget,
  resolveIosLifecycleTarget,
} from '../../dist/tools/app-lifecycle.js';
import { resolveReplayLifecycleDevice } from '../../dist/tools/startup-replay.js';

const UDID = '5C10B45B-2065-458B-B885-0F83F49747C8';
const SERIAL = 'emulator-5556';
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

// A foreign-app session is not lifecycle authority for this bundle — but the
// reset must not silently degrade to the ambiguous `booted` alias either. It
// refuses, so nothing is ever dispatched at an unidentified simulator.
test('GH-588 V4: another app session is never borrowed as lifecycle authority', async () => {
  const targets: Array<string | undefined> = [];
  const handler = createDeviceResetStateHandler(() => client(), {
    getSession: () => ({ platform: 'ios', deviceId: UDID, appId: 'com.other.app' }),
    terminateApp: async (_appId, _platform, deviceId) => {
      targets.push(deviceId);
    },
  });

  const result = await handler({ appId: APP_ID, platform: 'ios', relaunch: false });

  assert.deepEqual(targets, []);
  assert.equal(result.isError, true);
  const envelope = JSON.parse(result.content[0].text);
  assert.equal(envelope.code, 'TARGET_SESSION_MISMATCH');
  assert.equal(envelope.meta.activeSessionDeviceId, UDID);
});

test('GH-588 V4: supplied iOS lifecycle identities are exact UDIDs or fail closed', () => {
  assert.equal(resolveIosLifecycleTarget(UDID), UDID);
  assert.equal(resolveIosLifecycleTarget(), 'booted');
  assert.throws(() => resolveIosLifecycleTarget('booted'), /exact simulator UDID/);
  assert.throws(() => resolveIosLifecycleTarget('emulator-5560'), /exact simulator UDID/);
});

test('GH-588 V4: lifecycle reset threads the matching active Android serial to terminate and launch', async () => {
  const calls: Array<{ operation: string; deviceId?: string }> = [];
  const handler = createDeviceResetStateHandler(() => client(), {
    getSession: () => ({ platform: 'android', deviceId: SERIAL, appId: APP_ID }),
    terminateApp: async (_appId, _platform, deviceId) => {
      calls.push({ operation: 'terminate', deviceId });
    },
    launchApp: async (_appId, _platform, deviceId) => {
      calls.push({ operation: 'launch', deviceId });
    },
  });

  const result = envelope(
    await handler({
      appId: APP_ID,
      platform: 'android',
      relaunch: true,
      waitForReady: false,
    }),
  );

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    { operation: 'terminate', deviceId: SERIAL },
    { operation: 'launch', deviceId: SERIAL },
  ]);
});

test('GH-588 V4: Android lifecycle argv binds adb to the exact serial or fails closed', () => {
  assert.deepEqual(resolveAndroidLifecycleTarget(SERIAL), ['-s', SERIAL]);
  assert.deepEqual(resolveAndroidLifecycleTarget(), []);
  assert.throws(() => resolveAndroidLifecycleTarget('emulator 5556'), /exact adb serial/);
  assert.throws(() => resolveAndroidLifecycleTarget('a;rm -rf /'), /exact adb serial/);

  assert.deepEqual(buildAndroidLaunchArgv(APP_ID, SERIAL).slice(0, 3), ['-s', SERIAL, 'shell']);
  assert.equal(buildAndroidLaunchArgv(APP_ID)[0], 'shell');
});

test('GH-588 V4: startup replay refuses rather than dropping a cross-platform session device', () => {
  const refused = resolveReplayLifecycleDevice(
    { platform: 'ios', deviceId: UDID, appId: APP_ID },
    'android',
  );
  assert.equal(refused.ok, false);
  assert.match(refused.error, /Refusing startup replay on android/);
  assert.match(refused.error, new RegExp(UDID));
});

test('GH-588 V4: startup replay threads a matching session device and never invents one', () => {
  assert.deepEqual(resolveReplayLifecycleDevice({ platform: 'ios', deviceId: UDID }, 'ios'), {
    ok: true,
    deviceId: UDID,
  });
  assert.deepEqual(resolveReplayLifecycleDevice({ platform: 'android', deviceId: SERIAL }, 'android'), {
    ok: true,
    deviceId: SERIAL,
  });
  assert.deepEqual(resolveReplayLifecycleDevice(null, 'ios'), { ok: true, deviceId: undefined });
  assert.deepEqual(resolveReplayLifecycleDevice({ platform: 'ios' }, 'android'), {
    ok: true,
    deviceId: undefined,
  });
});
