import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(
  '/Users/anton_personal/GitHub/claude-react-native-dev-plugin/scripts/cdp-bridge/src/agent-device-wrapper.ts',
  'utf8',
);

test('Android runner short-circuit is env-gated and platform-scoped', () => {
  assert.match(source, /targetPlatform === 'android'/);
  assert.match(source, /process\.env\.RN_ANDROID_RUNNER !== '0'/);
  assert.match(source, /RN_ANDROID_RUNNER_COMMANDS\.has\(cliArgs\[0\]\)/);
  assert.match(source, /import\('\.\/runners\/rn-android-runner-client\.js'\)/);
});

test('Android runner command set covers all MVP verbs', () => {
  for (const cmd of ['snapshot', 'tap', 'press', 'fill', 'type', 'back', 'screenshot', 'keyboard', 'swipe', 'scroll', 'drag', 'longpress', 'pinch']) {
    assert.match(source, new RegExp(`['"]${cmd}['"]`));
  }
});

test('Android runner can be disabled with RN_ANDROID_RUNNER=0', () => {
  const source = readFileSync(
    '/Users/anton_personal/GitHub/claude-react-native-dev-plugin/scripts/cdp-bridge/src/agent-device-wrapper.ts',
    'utf8',
  );
  assert.match(source, /process\.env\.RN_ANDROID_RUNNER !== '0'/);
});
