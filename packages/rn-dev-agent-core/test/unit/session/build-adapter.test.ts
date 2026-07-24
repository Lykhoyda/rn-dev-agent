import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBuildLaunchPlan } from '../../../dist/session/build-adapter.js';

const iosSession = {
  platform: 'ios',
  deviceId: '00000000-0000-0000-0000-000000000001',
  metroPort: 8341,
  sessionId: 'session-ios',
};

const androidSession = {
  platform: 'android',
  deviceId: 'emulator-5582',
  metroPort: 8342,
  sessionId: 'session-android',
};

test('plugin-absent path passes any original command through unchanged', () => {
  const command = ['custom-rn-build', '--flavor', 'internal'];
  const plan = createBuildLaunchPlan({ platform: 'ios', command, session: null });

  assert.deepEqual(plan, {
    mode: 'passthrough',
    command,
    env: {},
  });
});

test('Expo iOS receives exact device and Metro pinning', () => {
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
    '--port',
    '8341',
    '--no-bundler',
  ]);
  assert.deepEqual(plan.env, {
    RCT_METRO_PORT: '8341',
    RN_DEV_AGENT_SESSION_ID: 'session-ios',
  });
});

test('Expo Android receives exact device and Metro pinning', () => {
  const plan = createBuildLaunchPlan({
    platform: 'android',
    command: ['expo', 'run:android'],
    session: androidSession,
  });

  assert.deepEqual(plan.command, [
    'expo',
    'run:android',
    '--device',
    androidSession.deviceId,
    '--port',
    '8342',
    '--no-bundler',
  ]);
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
