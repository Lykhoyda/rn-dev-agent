import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assertStableExpoAndroidDevice,
  parseAdbDevices,
  resolveExpoAndroidDevice,
} from '../../../dist/session/expo-android-device.js';

function resolver(outputs: Record<string, string | Error>) {
  return {
    runAdb(args: readonly string[]) {
      const key = args.join(' ');
      const output = outputs[key];
      if (output instanceof Error) throw output;
      if (output === undefined) throw new Error(`unexpected adb invocation: ${key}`);
      return output;
    },
  };
}

for (const sdk of [55, 56]) {
  test(`Expo SDK ${sdk} identity shape uses the emulator AVD name and retains its serial`, () => {
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

test('Expo physical-device identity uses model name while retaining exact serial authority', () => {
  assert.deepEqual(
    resolveExpoAndroidDevice(
      'R58M1234ABC',
      resolver({
        'devices -l':
          'List of devices attached\nR58M1234ABC device usb:1-1 product:x model:Pixel_8 device:y transport_id:4\n',
      }),
    ),
    { deviceId: 'R58M1234ABC', displayName: 'Pixel_8' },
  );

  assert.deepEqual(
    resolveExpoAndroidDevice(
      'R58MNOINFO',
      resolver({
        'devices -l': 'List of devices attached\nR58MNOINFO device usb:1-1 transport_id:4\n',
      }),
    ),
    { deviceId: 'R58MNOINFO', displayName: 'Device R58MNOINFO' },
  );
});

test('Expo identity refuses duplicate display names instead of allowing first-device selection', () => {
  assert.throws(
    () =>
      resolveExpoAndroidDevice(
        'R58M111',
        resolver({
          'devices -l': [
            'List of devices attached',
            'R58M111 device usb:1-1 model:Pixel_8 transport_id:1',
            'R58M222 device usb:1-2 model:Pixel_8 transport_id:2',
            '',
          ].join('\n'),
        }),
      ),
    /EXPO_DEVICE_IDENTITY_MISMATCH.*multiple adb serials/,
  );
});

test('adb identity refuses duplicate serial records', () => {
  assert.throws(
    () =>
      parseAdbDevices(
        'List of devices attached\nemulator-5660 device\nemulator-5660 device transport_id:2\n',
      ),
    /EXPO_DEVICE_IDENTITY_MISMATCH.*duplicate records/,
  );
});

test('Expo identity refuses absent, offline, unauthorized, network-unauthorized, and wrong serials', () => {
  for (const output of [
    'List of devices attached\n',
    'List of devices attached\nemulator-5660 offline transport_id:1\n',
    'List of devices attached\nR58M123 unauthorized usb:1-1 transport_id:1\n',
    'List of devices attached\nexample._adb-tls-connect._tcp device transport_id:1\n',
    'List of devices attached\nemulator-5770 device model:sdk\n',
  ]) {
    assert.throws(
      () => resolveExpoAndroidDevice('emulator-5660', resolver({ 'devices -l': output })),
      /EXPO_DEVICE_IDENTITY_MISMATCH.*missing, offline, or unauthorized/,
    );
  }
});

test('Expo identity refuses an unavailable emulator name and mapping drift', () => {
  assert.throws(
    () =>
      resolveExpoAndroidDevice(
        'emulator-5660',
        resolver({
          'devices -l': 'List of devices attached\nemulator-5660 device transport_id:1\n',
          '-s emulator-5660 emu avd name': 'KO: emulator not ready\n',
        }),
      ),
    /EXPO_DEVICE_IDENTITY_MISMATCH.*AVD name is unavailable/,
  );

  assert.throws(
    () =>
      assertStableExpoAndroidDevice(
        { deviceId: 'emulator-5660', displayName: 'Pixel_API_35' },
        { deviceId: 'emulator-5660', displayName: 'Renamed_API_35' },
      ),
    /EXPO_DEVICE_IDENTITY_MISMATCH.*changed immediately before Expo/,
  );
});
