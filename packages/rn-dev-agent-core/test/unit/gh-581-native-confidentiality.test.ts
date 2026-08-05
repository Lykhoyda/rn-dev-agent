import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  _setAndroidRunnerStateForTest,
  _setFetchForTest,
  runAndroid,
} from '../../dist/runners/rn-android-runner-client.js';
import { REQUIRED_ANDROID_COMMANDS } from '../../dist/runners/protocol.js';

test('Android runner fill keeps its privacy canary out of diagnostics and public output', async () => {
  const canary = 'RN_FILL_LOGCAT_PRIVACY_CANARY_581';
  const diagnostics: string[] = [];
  const originalError = console.error;
  const originalWarn = console.warn;
  console.error = (...args: unknown[]) => diagnostics.push(args.map(String).join(' '));
  console.warn = (...args: unknown[]) => diagnostics.push(args.map(String).join(' '));
  _setAndroidRunnerStateForTest({
    schemaVersion: 1,
    hostPort: 22089,
    devicePort: 22089,
    pid: process.pid,
    deviceId: 'emulator-581',
    bundleId: 'dev.test',
    startedAt: new Date(0).toISOString(),
    protocolVersion: 1,
  });
  _setFetchForTest(async (url) => {
    if (String(url).endsWith('/health')) {
      return new Response(
        JSON.stringify({
          ok: true,
          protocolVersion: 1,
          commands: [...REQUIRED_ANDROID_COMMANDS],
        }),
      );
    }
    return new Response(
      JSON.stringify({ ok: true, data: { filled: true, verify: 'exact', focusedBefore: false } }),
    );
  });

  try {
    const result = await runAndroid({
      command: 'fill',
      bundleId: 'dev.test',
      text: canary,
      exactIdentifier: 'field',
      exactType: 'android.widget.EditText',
    });
    assert.equal(result.isError, undefined);
    assert.doesNotMatch(result.content[0]!.text, new RegExp(canary));
    assert.doesNotMatch(diagnostics.join('\n'), new RegExp(canary));
  } finally {
    console.error = originalError;
    console.warn = originalWarn;
    _setAndroidRunnerStateForTest(null);
  }
});
