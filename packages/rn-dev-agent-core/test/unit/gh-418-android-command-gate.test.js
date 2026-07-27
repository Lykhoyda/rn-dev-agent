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
  const budget = {
    alreadyRebuiltFor: () => false,
    recordRebuild: () => events.push('budget'),
  };
  const result = await runBoundedAndroidRunnerRebuild(
    new AndroidAuthorityStaleError('serial-a'),
    async () => {
      events.push('rebuild');
      return 'ready';
    },
    {
      acquire: () => {
        events.push('acquire');
        return { ownerNonce: 'lock-a' };
      },
      release: (lock) => events.push(`release:${lock.ownerNonce}`),
      budget,
    },
  );

  assert.equal(result, 'ready');
  assert.deepEqual(events, ['acquire', 'rebuild', 'budget', 'release:lock-a']);
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
        acquire: () => ({ ownerNonce: 'lock-a' }),
        release: () => {},
        budget: {
          alreadyRebuiltFor: () => false,
          recordRebuild: () => {},
        },
      },
    ),
    (error) =>
      error instanceof AndroidAuthorityStaleError &&
      error.message.startsWith('RUNNER_OWNERSHIP_MISMATCH'),
  );
});

test('Android artifact rebuild records its budget only after success', async () => {
  const events = [];
  await assert.rejects(
    runBoundedAndroidRunnerRebuild(
      new AndroidAuthorityStaleError('serial-a'),
      async () => {
        events.push('rebuild');
        throw new Error('transient build failure');
      },
      {
        acquire: () => ({ ownerNonce: 'lock-a' }),
        release: () => events.push('release'),
        budget: {
          alreadyRebuiltFor: () => false,
          recordRebuild: () => events.push('budget'),
        },
      },
    ),
    /transient build failure/,
  );
  assert.deepEqual(events, ['rebuild', 'release']);
});

test('Android artifact rebuild lock uses nonce-owned atomic takeover and release', () => {
  const directory = mkdtempSync(join(tmpdir(), 'rn-android-rebuild-lock-'));
  const database = join(directory, 'lock.sqlite');
  try {
    const first = acquireAndroidRunnerRebuildLock(1_000, 'owner-a', database);
    assert.deepEqual(first, { ownerNonce: 'owner-a' });
    assert.equal(acquireAndroidRunnerRebuildLock(1_001, 'owner-b', database), null);

    const replacement = acquireAndroidRunnerRebuildLock(
      1_000 + 15 * 60_000 + 1,
      'owner-b',
      database,
    );
    assert.deepEqual(replacement, { ownerNonce: 'owner-b' });
    releaseAndroidRunnerRebuildLock(first, database);
    assert.equal(
      acquireAndroidRunnerRebuildLock(1_000 + 15 * 60_000 + 2, 'owner-c', database),
      null,
    );

    releaseAndroidRunnerRebuildLock(replacement, database);
    const final = acquireAndroidRunnerRebuildLock(1_000 + 15 * 60_000 + 3, 'owner-c', database);
    assert.deepEqual(final, { ownerNonce: 'owner-c' });
    releaseAndroidRunnerRebuildLock(final, database);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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
        acquire: () => {
          assert.fail('lock should not be acquired after the rebuild budget is exhausted');
        },
        release: () => {},
        budget: {
          alreadyRebuiltFor: () => true,
          recordRebuild: () => {},
        },
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
