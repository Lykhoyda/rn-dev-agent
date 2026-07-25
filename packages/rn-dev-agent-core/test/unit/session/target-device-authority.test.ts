import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  proveTargetDeviceAssociation,
  proveTargetDeviceAssociations,
} from '../../../dist/session/target-device-authority.js';

test('target association accepts only one exact iOS device', async () => {
  await proveTargetDeviceAssociation(
    { platform: 'ios', deviceId: 'device-a', targetDeviceName: 'iPhone A' },
    {
      execute: async () => ({
        stdout: JSON.stringify({
          devices: {
            runtime: [{ udid: 'device-a', name: 'iPhone A', state: 'Booted' }],
          },
        }),
      }),
    },
  );

  await assert.rejects(
    proveTargetDeviceAssociation(
      { platform: 'ios', deviceId: 'device-a', targetDeviceName: 'iPhone A' },
      {
        execute: async () => ({
          stdout: JSON.stringify({
            devices: {
              runtime: [
                { udid: 'device-a', name: 'iPhone A', state: 'Booted' },
                { udid: 'device-b', name: 'iPhone A', state: 'Booted' },
              ],
            },
          }),
        }),
      },
    ),
    /ambiguous or foreign/,
  );
});

test('target association resolves one iOS inventory for multiple targets', async () => {
  let inventoryCalls = 0;
  await proveTargetDeviceAssociations(
    {
      platform: 'ios',
      deviceId: 'device-a',
      targetDeviceNames: ['Foreign', 'iPhone A'],
    },
    {
      execute: async () => {
        inventoryCalls += 1;
        return {
          stdout: JSON.stringify({
            devices: {
              runtime: [{ udid: 'device-a', name: 'iPhone A', state: 'Booted' }],
            },
          }),
        };
      },
    },
  );
  assert.equal(inventoryCalls, 1);
});

test('target association rejects an Android model belonging to another serial', async () => {
  await assert.rejects(
    proveTargetDeviceAssociation(
      { platform: 'android', deviceId: 'serial-a', targetDeviceName: 'Pixel 9' },
      {
        execute: async (file, args) => {
          if (file === 'adb' && args[0] === 'devices') {
            return { stdout: 'serial-a\tdevice\nserial-b\tdevice\n' };
          }
          return { stdout: args[1] === 'serial-b' ? 'Pixel 9\n' : 'Pixel 8\n' };
        },
      },
    ),
    /ambiguous or foreign/,
  );
});
