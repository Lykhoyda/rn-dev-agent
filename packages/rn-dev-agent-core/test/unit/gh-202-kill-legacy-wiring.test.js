import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sessionSrc = readFileSync(resolve(__dirname, '../../src/tools/device-session.ts'), 'utf8');
const indexSrc = readFileSync(resolve(__dirname, '../../src/index.ts'), 'utf8');

test('GH#202 device-open calls UDID-scoped ensureSingleRunner, default-on', () => {
  assert.match(sessionSrc, /ensureSingleRunner\(\{\s*udid:\s*deviceId\s*\}\)/);
  assert.match(sessionSrc, /RN_DEVICE_KILL_LEGACY !== ['"]0['"]/);
});

test('GH#202 the opt-in default-off behavior is gone', () => {
  assert.ok(
    !sessionSrc.includes("RN_DEVICE_KILL_LEGACY === '1'") &&
      !sessionSrc.includes('RN_DEVICE_KILL_LEGACY === "1"'),
    'old opt-in guard must be removed',
  );
});

test('GH#202 bridge startup runs the files-only ensureSingleRunner pass', () => {
  assert.match(indexSrc, /ensureSingleRunner\(\)/);
});

// Final-review fix (2026-06-11): the eradication + fast-runner gates must use
// the NORMALIZED platform (line ~182), not raw args.platform — an open with
// platform omitted defaults to iOS and must still eradicate/spawn.
test('GH#202-P4 iOS gates use normalized platform (omitted platform still counts as iOS)', () => {
  assert.match(
    sessionSrc,
    /RN_DEVICE_KILL_LEGACY !== ['"]0['"] && platform === ['"]ios['"] && deviceId/,
  );
  assert.ok(
    !sessionSrc.includes("args.platform === 'ios'") &&
      !sessionSrc.includes('args.platform === "ios"'),
    "raw args.platform === 'ios' would silently skip iOS-only steps when platform is omitted",
  );
});
