// GH #418: the Android health probe parses /health.commands, the classify
// helper enforces REQUIRED_ANDROID_COMMANDS, and remediation is a REAL
// invalidation tier — deleting the APKs forces resolveAndroidInstallAction
// into 'build-then-install' (review amendment: 'install' alone re-installs
// the same stale APK and never runs Gradle).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireAndroidRunnerRebuildLock,
  AndroidAuthorityStaleError,
  completeAndroidRunnerRebuildLock,
  heartbeatAndroidRunnerRebuildLock,
  probeAndroidRunnerHealthInfo,
  resolveAndroidInstallAction,
  invalidateAndroidRunnerApks,
  _androidRunnerApkPathsForTest,
  AndroidCommandsStaleError,
  androidRetryCleanupContext,
  runBoundedAndroidRunnerRebuild,
  releaseAndroidRunnerRebuildLock,
  _setFetchForTest,
} from '../../dist/runners/rn-android-runner-client.js';
import {
  classifyRunnerCompatibility,
  REQUIRED_ANDROID_COMMANDS,
} from '../../dist/runners/protocol.js';

const runnerSource = readFileSync(
  new URL('../../src/runners/rn-android-runner-client.ts', import.meta.url),
  'utf8',
);

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

test('Android authority upgrades use the bounded artifact rebuild owner', () => {
  const err = new AndroidAuthorityStaleError();
  assert.ok(err.message.startsWith('RUNNER_OWNERSHIP_MISMATCH'));
  assert.match(
    runnerSource,
    /err instanceof AndroidAuthorityStaleError[\s\S]*?runBoundedAndroidRunnerRebuild\(err,[\s\S]*?invalidateAndroidRunnerApks\(\)[\s\S]*?_forceLocalBuild: true/,
  );
});

test('Android artifact rebuild is serialized and budgeted once', async () => {
  const events = [];
  const result = await runBoundedAndroidRunnerRebuild(
    new AndroidAuthorityStaleError('serial-a'),
    async () => {
      events.push('rebuild');
      return 'ready';
    },
    {
      acquire: (pluginVersion) => {
        events.push('acquire');
        return {
          status: 'acquired',
          lock: { ownerNonce: 'lock-a', pluginVersion },
        };
      },
      heartbeat: () => true,
      complete: (lock) => {
        events.push(`complete:${lock.ownerNonce}`);
        return true;
      },
      release: () => assert.fail('successful rebuild must not be released as failed'),
    },
  );

  assert.equal(result, 'ready');
  assert.deepEqual(events, ['acquire', 'rebuild', 'complete:lock-a']);
});

test('Android artifact rebuild preserves ownership mismatch after a failed rebuild', async () => {
  const mismatch = new AndroidAuthorityStaleError('serial-a');
  await assert.rejects(
    runBoundedAndroidRunnerRebuild(
      mismatch,
      async () => {
        throw mismatch;
      },
      {
        acquire: (pluginVersion) => ({
          status: 'acquired',
          lock: { ownerNonce: 'lock-a', pluginVersion },
        }),
        heartbeat: () => true,
        complete: () => {
          assert.fail('failed rebuild must not be completed');
        },
        release: () => true,
      },
    ),
    (error) =>
      error instanceof AndroidAuthorityStaleError &&
      error.message.startsWith('RUNNER_OWNERSHIP_MISMATCH'),
  );
});

test('Android artifact rebuild consumes a bounded attempt after failure', async () => {
  const events = [];
  await assert.rejects(
    runBoundedAndroidRunnerRebuild(
      new AndroidAuthorityStaleError('serial-a'),
      async () => {
        events.push('rebuild');
        throw new Error('transient build failure');
      },
      {
        acquire: (pluginVersion) => ({
          status: 'acquired',
          lock: { ownerNonce: 'lock-a', pluginVersion },
        }),
        heartbeat: () => true,
        complete: () => {
          assert.fail('failed rebuild must not be completed');
        },
        release: () => {
          events.push('failed');
          return true;
        },
      },
    ),
    /transient build failure/,
  );
  assert.deepEqual(events, ['rebuild', 'failed']);
});

test('Android artifact rebuild lease heartbeats and finalizes under its nonce', () => {
  const directory = mkdtempSync(join(tmpdir(), 'rn-android-rebuild-lock-'));
  const database = join(directory, 'lock.sqlite');
  try {
    const first = acquireAndroidRunnerRebuildLock('1.0.0', 1_000, 'owner-a', database);
    assert.deepEqual(first, {
      status: 'acquired',
      lock: { ownerNonce: 'owner-a', pluginVersion: '1.0.0' },
    });
    assert.deepEqual(acquireAndroidRunnerRebuildLock('1.0.0', 1_001, 'owner-b', database), {
      status: 'busy',
    });
    assert.equal(heartbeatAndroidRunnerRebuildLock(first.lock, 2_000, database), true);
    assert.deepEqual(
      acquireAndroidRunnerRebuildLock('1.0.0', 1_000 + 15 * 60_000 + 1, 'owner-b', database),
      { status: 'busy' },
    );

    const replacement = acquireAndroidRunnerRebuildLock(
      '1.0.0',
      2_000 + 15 * 60_000 + 1,
      'owner-b',
      database,
    );
    assert.deepEqual(replacement, {
      status: 'acquired',
      lock: { ownerNonce: 'owner-b', pluginVersion: '1.0.0' },
    });
    assert.equal(releaseAndroidRunnerRebuildLock(first.lock, 2_001, database), false);
    assert.equal(completeAndroidRunnerRebuildLock(replacement.lock, 2_002, database), true);
    assert.deepEqual(acquireAndroidRunnerRebuildLock('1.0.0', 2_003, 'owner-c', database), {
      status: 'exhausted',
    });

    const nextVersion = acquireAndroidRunnerRebuildLock('2.0.0', 2_004, 'owner-c', database);
    assert.equal(nextVersion.status, 'acquired');
    assert.equal(releaseAndroidRunnerRebuildLock(nextVersion.lock, 2_005, database), true);
    assert.deepEqual(acquireAndroidRunnerRebuildLock('2.0.0', 2_006, 'owner-d', database), {
      status: 'exhausted',
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Android artifact rebuild heartbeats while the protected operation runs', async () => {
  let heartbeats = 0;
  const result = await runBoundedAndroidRunnerRebuild(
    new AndroidAuthorityStaleError('serial-a'),
    () => new Promise((resolve) => setTimeout(() => resolve('ready'), 35)),
    {
      acquire: (pluginVersion) => ({
        status: 'acquired',
        lock: { ownerNonce: 'lock-a', pluginVersion },
      }),
      heartbeat: () => {
        heartbeats += 1;
        return true;
      },
      complete: () => true,
      release: () => true,
      heartbeatIntervalMs: 5,
    },
  );

  assert.equal(result, 'ready');
  assert.ok(heartbeats >= 2);
});

test('Android artifact completion failure does not abandon a ready runner', async () => {
  let released = false;
  const result = await runBoundedAndroidRunnerRebuild(
    new AndroidAuthorityStaleError('serial-a'),
    async () => 'ready',
    {
      acquire: (pluginVersion) => ({
        status: 'acquired',
        lock: { ownerNonce: 'lock-a', pluginVersion },
      }),
      heartbeat: () => true,
      complete: () => {
        throw new Error('database unavailable');
      },
      release: () => {
        released = true;
        return true;
      },
    },
  );

  assert.equal(result, 'ready');
  assert.equal(released, false);
});

test('Android artifact rebuild budget refuses repeated ownership upgrades', async () => {
  const mismatch = new AndroidAuthorityStaleError('serial-a');
  let rebuildAttempted = false;
  await assert.rejects(
    runBoundedAndroidRunnerRebuild(
      mismatch,
      async () => {
        rebuildAttempted = true;
      },
      {
        acquire: () => ({ status: 'exhausted' }),
      },
    ),
    (error) =>
      error instanceof AndroidAuthorityStaleError &&
      error.message.startsWith('RUNNER_OWNERSHIP_MISMATCH'),
  );
  assert.equal(rebuildAttempted, false);
});

test('Android retry cleanup preserves the attempted device before runner readiness', () => {
  const authorityError = new AndroidAuthorityStaleError('serial-a');
  const commandsError = new AndroidCommandsStaleError(
    ['dismissKeyboard'],
    'com.example',
    'serial-b',
  );

  assert.deepEqual(androidRetryCleanupContext(null, authorityError), { deviceId: 'serial-a' });
  assert.deepEqual(androidRetryCleanupContext(null, commandsError), { deviceId: 'serial-b' });
  assert.deepEqual(androidRetryCleanupContext({ deviceId: 'persisted' }, authorityError), {
    deviceId: 'persisted',
  });
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
