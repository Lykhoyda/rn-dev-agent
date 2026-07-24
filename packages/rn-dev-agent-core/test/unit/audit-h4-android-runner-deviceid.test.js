import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldReuseAndroidRunner } from '../../dist/runners/rn-android-runner-client.js';

// Audit H4: parity with iOS shouldReuseRunner. A live Android runner bound to
// emulator-A must NOT be reused to drive emulator-B (its adb forward + port
// still target A — every device_* would silently hit the wrong emulator).

process.env.RN_DEV_AGENT_SESSION_ID = 'session-a';
process.env.RN_DEV_AGENT_CLAIM_EPOCH = '7';

const stateFor = (deviceId) => ({
  hostPort: 22089,
  devicePort: 22089,
  pid: 4242,
  deviceId,
  startedAt: 'now',
  sessionId: 'session-a',
  claimEpoch: 7,
  capability: 'x'.repeat(32),
});

test('H4: same emulator → reuse', () => {
  assert.equal(shouldReuseAndroidRunner(stateFor('emulator-5554'), 'emulator-5554'), true);
});

test('H4: different emulator → do NOT reuse (the wrong-device bug)', () => {
  assert.equal(shouldReuseAndroidRunner(stateFor('emulator-5554'), 'emulator-5556'), false);
});

test('H4: no live runner → cannot reuse', () => {
  assert.equal(shouldReuseAndroidRunner(null, 'emulator-5554'), false);
});

test('H4: no target requested never expands exact-device authority', () => {
  assert.equal(shouldReuseAndroidRunner(stateFor('emulator-5554'), undefined), false);
});

test('H4: runner with no recorded device + a specific target requested → do not reuse', () => {
  assert.equal(shouldReuseAndroidRunner(stateFor(undefined), 'emulator-5556'), false);
});

test('H4: sibling claim epoch cannot reuse the runner', () => {
  assert.equal(
    shouldReuseAndroidRunner({ ...stateFor('emulator-5554'), claimEpoch: 6 }, 'emulator-5554'),
    false,
  );
});
