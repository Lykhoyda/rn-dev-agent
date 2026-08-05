import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBuildLaunchPlan } from '../../../dist/session/build-adapter.js';

const iosSession = {
  platform: 'ios',
  deviceId: '00000000-0000-0000-0000-000000000001',
  appId: 'dev.example.ios',
  metroPort: 8341,
  sessionId: 'session-ios',
  simulator: true,
};

const androidSession = {
  platform: 'android',
  deviceId: 'emulator-5582',
  appId: 'dev.example.android',
  metroPort: 8342,
  sessionId: 'session-android',
};

const resolveAndroid = (deviceId: string) => ({
  deviceId,
  displayName: deviceId === 'emulator-5582' ? 'Pixel_API_35' : 'Pixel_8',
});

test('plugin-absent path passes any original command through unchanged', () => {
  const command = ['custom-rn-build', '--flavor', 'internal'];
  const plan = createBuildLaunchPlan({ platform: 'ios', command, session: null });

  assert.deepEqual(plan, {
    mode: 'passthrough',
    command,
    env: {},
  });
});

test('Expo iOS launches through its exact managed Metro proxy without starting a bundler', () => {
  const plan = createBuildLaunchPlan({
    platform: 'ios',
    command: ['npx', 'expo', 'run:ios', '--configuration', 'Debug'],
    session: iosSession,
  });

  assert.deepEqual(plan.command, [
    'npx',
    'expo',
    'run:ios',
    '--configuration',
    'Debug',
    '--device',
    iosSession.deviceId,
    '--no-bundler',
  ]);
  assert.deepEqual(plan.env, {
    ORG_GRADLE_PROJECT_reactNativeDevServerPort: '8341',
    RCT_METRO_PORT: '8341',
    RN_DEV_AGENT_SESSION_ID: 'session-ios',
    EXPO_PACKAGER_PROXY_URL: 'http://127.0.0.1:8341',
  });
  assert.deepEqual(plan.postInstall, {
    command: [
      'xcrun',
      'simctl',
      'launch',
      '--terminate-running-process',
      iosSession.deviceId,
      iosSession.appId,
      '--initialUrl',
      'http://127.0.0.1:8341',
    ],
    timeoutMs: 30_000,
  });
});

test('Expo Android emulator launches through its exact host Metro proxy', () => {
  const plan = createBuildLaunchPlan({
    platform: 'android',
    command: ['expo', 'run:android'],
    session: androidSession,
    resolveExpoAndroidDevice: resolveAndroid,
  });

  assert.deepEqual(plan.command, [
    'expo',
    'run:android',
    '--device',
    'Pixel_API_35',
    '--no-bundler',
  ]);
  assert.deepEqual(plan.env, {
    ORG_GRADLE_PROJECT_reactNativeDevServerPort: '8342',
    RCT_METRO_PORT: '8342',
    RN_DEV_AGENT_SESSION_ID: 'session-android',
    ANDROID_SERIAL: 'emulator-5582',
    EXPO_PACKAGER_PROXY_URL: 'http://10.0.2.2:8342',
  });
  assert.equal(plan.postInstall, undefined);
});

test('Expo never receives --port alongside --no-bundler and refuses a conflicting port', () => {
  for (const portArgs of [['--port', '8341'], ['--port=8341'], ['-p', '8341'], ['-p=8341']]) {
    const matching = createBuildLaunchPlan({
      platform: 'ios',
      command: ['expo', 'run:ios', ...portArgs, '--no-bundler'],
      session: iosSession,
    });

    assert.deepEqual(matching.command, [
      'expo',
      'run:ios',
      '--no-bundler',
      '--device',
      iosSession.deviceId,
    ]);
  }
  for (const conflicting of [['--port', '8081'], ['--port=8081'], ['-p', '8081']]) {
    assert.throws(
      () =>
        createBuildLaunchPlan({
          platform: 'ios',
          command: ['expo', 'run:ios', ...conflicting],
          session: iosSession,
        }),
      /SESSION_BUILD_IDENTITY_CONFLICT/,
    );
  }
  assert.throws(
    () =>
      createBuildLaunchPlan({
        platform: 'ios',
        command: ['expo', 'run:ios', '--device', iosSession.deviceId, '--device', 'foreign-device'],
        session: iosSession,
      }),
    /SESSION_BUILD_IDENTITY_CONFLICT/,
  );
});

test('Expo Android refuses foreign user device input and mapping drift before launch', () => {
  assert.throws(
    () =>
      createBuildLaunchPlan({
        platform: 'android',
        command: ['expo', 'run:android', '--device', 'foreign-device'],
        session: androidSession,
        resolveExpoAndroidDevice: resolveAndroid,
      }),
    /EXPO_DEVICE_IDENTITY_MISMATCH/,
  );

  let observations = 0;
  assert.throws(
    () =>
      createBuildLaunchPlan({
        platform: 'android',
        command: ['expo', 'run:android', `--device=${androidSession.deviceId}`],
        session: androidSession,
        resolveExpoAndroidDevice: (deviceId) => ({
          deviceId,
          displayName: observations++ === 0 ? 'Pixel_API_35' : 'Renamed_API_35',
        }),
      }),
    /EXPO_DEVICE_IDENTITY_MISMATCH.*changed immediately before Expo/,
  );
});

test('Expo Android physical device requires an explicit exact Dev Client endpoint', () => {
  assert.throws(
    () =>
      createBuildLaunchPlan({
        platform: 'android',
        command: ['expo', 'run:android'],
        session: { ...androidSession, deviceId: 'physical-serial' },
        resolveExpoAndroidDevice: resolveAndroid,
      }),
    /DEV_CLIENT_ENDPOINT_NOT_FOUND/,
  );

  const plan = createBuildLaunchPlan({
    platform: 'android',
    command: ['expo', 'run:android'],
    session: {
      ...androidSession,
      deviceId: 'physical-serial',
      devClientUrl: 'example://expo-development-client/?url=http%3A%2F%2F192.0.2.10%3A8342',
    },
    resolveExpoAndroidDevice: resolveAndroid,
  });

  assert.deepEqual(plan.command.slice(-3), ['--device', 'Pixel_8', '--no-bundler']);
  assert.equal(plan.env.ANDROID_SERIAL, 'physical-serial');
  assert.equal(plan.env.EXPO_PACKAGER_PROXY_URL, 'http://192.0.2.10:8342');
});

test('Expo iOS physical device keeps the supported Expo launch path', () => {
  const plan = createBuildLaunchPlan({
    platform: 'ios',
    command: ['expo', 'run:ios'],
    session: { ...iosSession, simulator: false },
  });

  assert.equal(plan.postInstall, undefined);
});

test('bare React Native iOS uses UDID and external managed Metro', () => {
  const plan = createBuildLaunchPlan({
    platform: 'ios',
    command: ['npx', 'react-native', 'run-ios'],
    session: iosSession,
  });

  assert.deepEqual(plan.command, [
    'npx',
    'react-native',
    'run-ios',
    '--udid',
    iosSession.deviceId,
    '--port',
    '8341',
    '--no-packager',
  ]);
});

test('bare React Native Android uses the exact adb serial', () => {
  const plan = createBuildLaunchPlan({
    platform: 'android',
    command: ['react-native', 'run-android'],
    session: androidSession,
  });

  assert.deepEqual(plan.command, [
    'react-native',
    'run-android',
    '--deviceId',
    androidSession.deviceId,
    '--port',
    '8342',
    '--no-packager',
  ]);
});

test('session-aware path refuses unsupported and conflicting command shapes', () => {
  assert.throws(
    () =>
      createBuildLaunchPlan({
        platform: 'ios',
        command: ['custom-rn-build'],
        session: iosSession,
      }),
    /SESSION_BUILD_COMMAND_UNSUPPORTED/,
  );
  assert.throws(
    () =>
      createBuildLaunchPlan({
        platform: 'ios',
        command: ['expo', 'run:ios', '--device', 'foreign-device'],
        session: iosSession,
      }),
    /SESSION_BUILD_IDENTITY_CONFLICT/,
  );
});
