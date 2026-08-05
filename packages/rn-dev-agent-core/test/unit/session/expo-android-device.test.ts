import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  parseAdbDevices,
  resolveExpoAndroidDevice,
} from '../../../dist/session/expo-android-device.js';

function resolver(outputs: Record<string, string>) {
  return {
    runAdb(args: readonly string[]) {
      const key = args.join(' ');
      const output = outputs[key];
      if (output === undefined) throw new Error(`unexpected adb invocation: ${key}`);
      return output;
    },
  };
}

for (const sdk of [55, 56]) {
  test(`Expo SDK ${sdk} display-name boundary resolves back to the exact adb serial`, () => {
    const binding = resolveExpoAndroidDevice(
      'emulator-5660',
      resolver({
        'devices -l':
          'List of devices attached\nemulator-5660 device product:sdk model:sdk_gphone64_arm64 transport_id:1\n',
        '-s emulator-5660 emu avd name': 'rn_exact_sdk_android\nOK\n',
      }),
    );

    assert.deepEqual(binding, {
      deviceId: 'emulator-5660',
      displayName: 'rn_exact_sdk_android',
    });
  });
}

test('Expo device resolution refuses a disconnected, offline, or missing exact serial', () => {
  for (const output of [
    'List of devices attached\n',
    'List of devices attached\nemulator-5660 offline transport_id:1\n',
    'List of devices attached\nemulator-5770 device model:sdk\n',
  ]) {
    assert.throws(
      () => resolveExpoAndroidDevice('emulator-5660', resolver({ 'devices -l': output })),
      /EXPO_DEVICE_IDENTITY_MISMATCH/,
    );
  }
});

test('Expo device resolution refuses duplicate names instead of selecting the first device', () => {
  assert.throws(
    () =>
      resolveExpoAndroidDevice(
        'emulator-5660',
        resolver({
          'devices -l': [
            'List of devices attached',
            'emulator-5660 device model:sdk transport_id:1',
            'emulator-5662 device model:sdk transport_id:2',
            '',
          ].join('\n'),
          '-s emulator-5660 emu avd name': 'duplicate_name\nOK\n',
          '-s emulator-5662 emu avd name': 'duplicate_name\nOK\n',
        }),
      ),
    /does not resolve uniquely/,
  );
});

test('Expo physical-device names retain exact serial authority', () => {
  const binding = resolveExpoAndroidDevice(
    'R58M1234ABC',
    resolver({
      'devices -l':
        'List of devices attached\nR58M1234ABC device usb:1-1 product:x model:Pixel_8 device:y\n',
    }),
  );
  assert.deepEqual(binding, { deviceId: 'R58M1234ABC', displayName: 'Pixel_8' });
});

test('adb enumeration rejects duplicate serial records', () => {
  assert.throws(
    () =>
      parseAdbDevices(
        'List of devices attached\nemulator-5660 device\nemulator-5660 device transport_id:2\n',
      ),
    /duplicate serial/,
  );
});
