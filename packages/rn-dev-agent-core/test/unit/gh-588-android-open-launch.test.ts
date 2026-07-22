import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAndroidAppLaunchArgs,
  buildAndroidPidofArgs,
  createDeviceSnapshotHandler,
  isAppRunning,
  releaseDeviceLockForSession,
} from '../../dist/tools/device-session.js';
import { clearActiveSession } from '../../dist/agent-device-wrapper.js';
import { okResult } from '../../dist/utils.js';

const SERIAL = 'emulator-5560';
const OTHER_SERIAL = 'emulator-5556';
const APP_ID = 'com.rndevagent.testapp';

function envelope(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0]!.text) as {
    ok: boolean;
    code?: string;
    error?: string;
    data?: Record<string, unknown>;
  };
}

function cleanup(): void {
  clearActiveSession();
  releaseDeviceLockForSession();
}

test('GH-588 final Android validation: launcher is exact-serial and keyless-AVD safe', () => {
  assert.deepEqual(buildAndroidAppLaunchArgs(SERIAL, APP_ID), [
    '-s',
    SERIAL,
    'shell',
    'monkey',
    '--pct-syskeys',
    '0',
    '-p',
    APP_ID,
    '-c',
    'android.intent.category.LAUNCHER',
    '1',
  ]);
  assert.equal(buildAndroidAppLaunchArgs(SERIAL, APP_ID).includes(OTHER_SERIAL), false);
  assert.deepEqual(buildAndroidPidofArgs(APP_ID, SERIAL), ['-s', SERIAL, 'shell', 'pidof', APP_ID]);
  assert.equal(buildAndroidPidofArgs(APP_ID, SERIAL).includes(OTHER_SERIAL), false);
});

test('GH-588 final Android validation: attach probe receives the selected serial', async () => {
  let observed: [string, string | undefined] | null = null;
  const running = await isAppRunning(
    'android',
    APP_ID,
    {
      android: async (appId, deviceId) => {
        observed = [appId, deviceId];
        return true;
      },
    },
    SERIAL,
  );
  assert.equal(running, true);
  assert.deepEqual(observed, [APP_ID, SERIAL]);
});

test('GH-588 final Android validation: device_snapshot open follows the proven exact app/device path', async () => {
  const calls: string[] = [];
  const handler = createDeviceSnapshotHandler({
    isAppRunning: async () => {
      throw new Error('normal open must not use attach-only probe');
    },
    startAndroidRunner: async (deviceId, appId) => {
      calls.push(`runner:${deviceId}:${appId}`);
    },
    launchAndroidApp: async (deviceId, appId) => {
      calls.push(`launch:${deviceId}:${appId}`);
    },
    probeAndroidUi: async (deviceId, appId) => {
      calls.push(`ui:${deviceId}:${appId}`);
      return okResult({ nodes: [] });
    },
    probeReactNativeUi: async (_platform, deviceId, appId) => {
      calls.push(`rn:${deviceId}:${appId}`);
      return true;
    },
  });

  try {
    const body = envelope(
      await handler({
        action: 'open',
        platform: 'android',
        deviceId: SERIAL,
        appId: APP_ID,
        sessionName: 'issue588-regression',
      }),
    );
    assert.equal(body.ok, true);
    assert.deepEqual(calls, [
      `runner:${SERIAL}:${APP_ID}`,
      `launch:${SERIAL}:${APP_ID}`,
      `ui:${SERIAL}:${APP_ID}`,
      `rn:${SERIAL}:${APP_ID}`,
    ]);
    assert.equal(body.data?.deviceId, SERIAL);
    assert.equal(body.data?.appId, APP_ID);
  } finally {
    cleanup();
  }
});

test('GH-588 final Android validation: attach-only does not accept an unrelated emulator', async () => {
  let runnerStarted = false;
  const handler = createDeviceSnapshotHandler({
    isAppRunning: async (_platform, _appId, deviceId) => {
      assert.equal(deviceId, SERIAL);
      return false;
    },
    startAndroidRunner: async () => {
      runnerStarted = true;
    },
  });

  try {
    const body = envelope(
      await handler({
        action: 'open',
        platform: 'android',
        deviceId: SERIAL,
        appId: APP_ID,
        attachOnly: true,
      }),
    );
    assert.equal(body.ok, false);
    assert.equal(body.code, 'NOT_CONNECTED');
    assert.equal(runnerStarted, false);
  } finally {
    cleanup();
  }
});

test('GH-588 final Android validation: launcher failure is not masked as runner-down', async () => {
  const handler = createDeviceSnapshotHandler({
    startAndroidRunner: async () => undefined,
    launchAndroidApp: async () => {
      throw new Error('launcher exited 251');
    },
  });

  try {
    const body = envelope(
      await handler({ action: 'open', platform: 'android', deviceId: SERIAL, appId: APP_ID }),
    );
    assert.equal(body.ok, false);
    assert.equal(body.code, 'APP_LAUNCH_FAILED');
    assert.match(body.error!, /launcher exited 251/);
  } finally {
    cleanup();
  }
});

test('GH-588 final Android validation: genuine runner startup failure remains runner-down', async () => {
  const handler = createDeviceSnapshotHandler({
    startAndroidRunner: async () => {
      throw new Error('instrumentation exited before readiness');
    },
    launchAndroidApp: async () => {
      throw new Error('must not launch after runner failure');
    },
  });

  try {
    const body = envelope(
      await handler({ action: 'open', platform: 'android', deviceId: SERIAL, appId: APP_ID }),
    );
    assert.equal(body.ok, false);
    assert.equal(body.code, 'RN_ANDROID_RUNNER_DOWN');
    assert.match(body.error!, /instrumentation exited before readiness/);
  } finally {
    cleanup();
  }
});
