import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  androidDeeplinkCommandArgs,
  iosDeeplinkCommandArgs,
} from '../../dist/tools/device-deeplink.js';

test('device_deeplink command builders honor an explicit target', () => {
  assert.deepEqual(iosDeeplinkCommandArgs('proof://fixture', 'IOS-UDID'), [
    'simctl',
    'openurl',
    'IOS-UDID',
    'proof://fixture',
  ]);
  assert.deepEqual(androidDeeplinkCommandArgs('proof://fixture', undefined, 'emulator-5556'), [
    '-s',
    'emulator-5556',
    'shell',
    'am',
    'start',
    '-a',
    'android.intent.action.VIEW',
    '-d',
    "'proof://fixture'",
  ]);
});

test('device_deeplink exposes explicit simulator or device selection through MCP', async () => {
  const source = await readFile(resolve(import.meta.dirname, '../../src/index.ts'), 'utf8');
  const start = source.indexOf("trackedTool(\n  'device_deeplink'");
  const end = source.indexOf("trackedTool(\n  'cdp_dismiss_dev_client_picker'", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);

  const registration = source.slice(start, end);
  assert.match(
    registration,
    /deviceId:\s*z\s*\.string\(\)\s*\.min\(1\)\s*\.max\(256\)\s*\.optional\(\)/,
  );
  assert.match(registration, /iOS simulator UDID or Android adb serial/);
});
