import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseMaestroDispatch } from '../../dist/tools/maestro-dispatch.js';

function runnerDispatch(platform: 'ios' | 'android') {
  const dispatch = chooseMaestroDispatch({ platform, maestroRunnerPath: () => '/runner' });
  if (!('buildArgs' in dispatch)) throw new Error('expected maestro-runner dispatch');
  return dispatch;
}

test('android replays pin the uiautomator2 driver instead of the runner default', () => {
  assert.deepEqual(
    runnerDispatch('android').buildArgs('android', '/tmp/flow.yaml', undefined, 'emulator-5554'),
    [
      '--platform',
      'android',
      '--driver',
      'uiautomator2',
      '--device',
      'emulator-5554',
      'test',
      '/tmp/flow.yaml',
    ],
  );
});

test('ios replays pin the wda driver instead of the runner default', () => {
  assert.deepEqual(
    runnerDispatch('ios').buildArgs('ios', '/tmp/flow.yaml', '/DerivedData/MyApp.app', 'SIM-UDID'),
    [
      '--app-file',
      '/DerivedData/MyApp.app',
      '--platform',
      'ios',
      '--driver',
      'wda',
      '--device',
      'SIM-UDID',
      'test',
      '/tmp/flow.yaml',
    ],
  );
});
