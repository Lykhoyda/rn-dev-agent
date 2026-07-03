// GH #418: the Android health probe parses /health.commands, the classify
// helper enforces REQUIRED_ANDROID_COMMANDS, and remediation is a REAL
// invalidation tier — deleting the APKs forces resolveAndroidInstallAction
// into 'build-then-install' (review amendment: 'install' alone re-installs
// the same stale APK and never runs Gradle).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  probeAndroidRunnerHealthInfo,
  resolveAndroidInstallAction,
  invalidateAndroidRunnerApks,
  _androidRunnerApkPathsForTest,
  AndroidCommandsStaleError,
  _setFetchForTest,
} from '../../dist/runners/rn-android-runner-client.js';
import {
  classifyRunnerCompatibility,
  REQUIRED_ANDROID_COMMANDS,
} from '../../dist/runners/protocol.js';

test('gh-418 android: probe parses commands array (non-strings filtered)', async () => {
  _setFetchForTest(async () => ({
    ok: true,
    json: async () => ({
      ok: true,
      protocolVersion: 1,
      commands: ['tap', 'type', 7, 'snapshot'],
    }),
  }));
  try {
    const info = await probeAndroidRunnerHealthInfo(4723);
    assert.deepEqual(info.commands, ['tap', 'type', 'snapshot']);
  } finally {
    _setFetchForTest(globalThis.fetch);
  }
});

test('gh-418 android: absent commands + required list → missing-commands', () => {
  assert.deepEqual(
    classifyRunnerCompatibility({ protocolVersion: 1 }, null, REQUIRED_ANDROID_COMMANDS),
    {
      compatible: false,
      reason: 'missing-commands',
      missing: [...REQUIRED_ANDROID_COMMANDS],
    },
  );
});

test('gh-418 android: AndroidCommandsStaleError message carries the typed prefix + hint', () => {
  const err = new AndroidCommandsStaleError(['dismissKeyboard'], 'com.example');
  assert.ok(err.message.startsWith('RUNNER_COMMANDS_STALE'));
  assert.match(err.message, /dismissKeyboard/);
  assert.match(err.message, /device_snapshot action=open/);
  assert.deepEqual(err.missing, ['dismissKeyboard']);
});

test('gh-418 android: invalidation deletes exactly the paths the apksExist check reads', () => {
  const removed = [];
  invalidateAndroidRunnerApks((p) => removed.push(p));
  // Same source of truth (RUNNER_APK_PATHS) as androidRunnerApksExist — a
  // drift between what is deleted and what is existence-checked fails here.
  assert.deepEqual(removed, [..._androidRunnerApkPathsForTest()]);
  assert.ok(removed.some((p) => p.endsWith('app-debug.apk')));
  assert.ok(removed.some((p) => p.endsWith('app-debug-androidTest.apk')));
  // With the APKs gone the pure decision is Gradle:
  assert.equal(
    resolveAndroidInstallAction({ instrumentationRegistered: false, apksExist: false }),
    'build-then-install',
  );
  // …whereas a stale-but-present APK alone would only be re-installed, never
  // rebuilt — the blind spot this tier closes:
  assert.equal(
    resolveAndroidInstallAction({ instrumentationRegistered: false, apksExist: true }),
    'install',
  );
});
