// GH #741: pinned maestro-runner 1.0.9 cannot drive Android API 23-25, and
// RUNNER_OWNERSHIP_MISMATCH advised a status read that repairs nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMaestroRunHandler } from '../../dist/tools/maestro-run.js';
import type { MaestroDispatch } from '../../dist/tools/maestro-dispatch.js';
import { authorityErrorMeta, SessionAuthorityError } from '../../dist/session/registry.js';
import {
  MAESTRO_RUNNER_MIN_ANDROID_API,
  preOAndroidApiRefusal,
  olderSdkInstallDiagnosis,
  isOlderSdkInstallFailure,
} from '../../dist/domain/engine-pin.js';

const SERIAL = 'emulator-5560';
const APP_ID = 'dev.example.issue741';

function envelope(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0]!.text);
}

function dispatch(): MaestroDispatch {
  return {
    runner: 'maestro-runner',
    binPath: '/test/maestro-runner',
    buildArgs: (platform, flowFile, _appFile, deviceId) => [
      '--platform',
      platform,
      ...(deviceId ? ['--device', deviceId] : []),
      'test',
      flowFile,
    ],
  };
}

function baseHandler(overrides: Parameters<typeof createMaestroRunHandler>[0] = {}) {
  return createMaestroRunHandler({
    getActiveSession: () => ({
      name: 'issue-741',
      platform: 'android',
      deviceId: SERIAL,
      appId: APP_ID,
      openedAt: new Date(0).toISOString(),
    }),
    chooseDispatch: () => dispatch(),
    parkFlow: async (run) => run(),
    claimNativeOrigin: async () => {},
    completeNativeOrigin: async () => {},
    relaunchManagedApp: async () => {},
    reproveManagedOrigin: async () => {},
    fastHealthCheck: async () => false,
    ...overrides,
  });
}

const runArgs = {
  inlineYaml: '- launchApp',
  platform: 'android' as const,
  appId: APP_ID,
};

test('GH#741 RUNNER_OWNERSHIP_MISMATCH advises re-opening the device snapshot, not a status read', () => {
  const meta = authorityErrorMeta(
    new SessionAuthorityError('RUNNER_OWNERSHIP_MISMATCH', 'R authority is not bound'),
  );
  const advice = String(meta.nextAction);
  assert.match(advice, /device_snapshot/);
  assert.match(advice, /"open"/);
  assert.doesNotMatch(
    advice,
    /action "status" and repair/,
    'the generic status-read advice is a dead end: status reports every axis bound',
  );
});

test('GH#741 a site-specific nextAction still overrides the code-level advice', () => {
  const meta = authorityErrorMeta(
    new SessionAuthorityError('RUNNER_OWNERSHIP_MISMATCH', 'x', undefined, {
      nextAction: 'site-specific repair',
    }),
  );
  assert.equal(meta.nextAction, 'site-specific repair');
});

test('GH#741 pre-flight refuses API 25 with an explicit unsupported diagnosis, before dispatch', async () => {
  let executed = false;
  const handler = baseHandler({
    probeAndroidApiLevel: async () => 25,
    execFile: async () => {
      executed = true;
      return { stdout: '', stderr: '' };
    },
  });
  const result = await handler(runArgs);
  const body = envelope(result);
  assert.equal(result.isError, true);
  assert.equal(body.code, 'ANDROID_API_UNSUPPORTED');
  assert.match(String(body.error), /API 25/);
  assert.match(String(body.error), new RegExp(`API ${MAESTRO_RUNNER_MIN_ANDROID_API}`));
  assert.match(String(body.error), /INSTALL_FAILED_OLDER_SDK/);
  assert.match(String(body.error), /device_\*/, 'must point at the tier that does support API 23+');
  assert.equal(body.meta?.androidApiLevel, 25);
  assert.equal(executed, false, 'the runner must not be spawned against an unsupported device');
});

test('GH#741 API 26 passes the pre-flight gate', async () => {
  let executed = false;
  const handler = baseHandler({
    probeAndroidApiLevel: async () => 26,
    execFile: async () => {
      executed = true;
      return {
        stdout: `Connecting to Android device: ${SERIAL}\nFlow execution completed: 1 passed, 0 failed, 0 skipped`,
        stderr: '',
      };
    },
  });
  await handler(runArgs);
  assert.equal(executed, true);
});

test('GH#741 an unavailable API probe fails open', async () => {
  let executed = false;
  const handler = baseHandler({
    probeAndroidApiLevel: async () => null,
    execFile: async () => {
      executed = true;
      return {
        stdout: `Connecting to Android device: ${SERIAL}\nFlow execution completed: 1 passed, 0 failed, 0 skipped`,
        stderr: '',
      };
    },
  });
  await handler(runArgs);
  assert.equal(executed, true);
});

test('GH#741 a runtime INSTALL_FAILED_OLDER_SDK failure surfaces the capability diagnosis', async () => {
  const handler = baseHandler({
    probeAndroidApiLevel: async () => null,
    execFile: async () => {
      throw Object.assign(new Error('runner exited 1'), {
        stdout: '',
        stderr:
          'Failed to install appium-uiautomator2-server.apk: ' +
          'INSTALL_FAILED_OLDER_SDK: Requires development platform 26 but this is a development platform 25',
        code: 1,
      });
    },
  });
  const result = await handler(runArgs);
  const body = envelope(result);
  assert.equal(result.isError, true);
  assert.equal(body.code, 'ANDROID_API_UNSUPPORTED');
  assert.match(String(body.error), new RegExp(`API ${MAESTRO_RUNNER_MIN_ANDROID_API}`));
  assert.match(String(body.error), /device_\*/);
});

test('GH#741 pure helpers: refusal below the minimum only, diagnosis names the pinned engine', () => {
  assert.equal(preOAndroidApiRefusal(26), null);
  assert.equal(preOAndroidApiRefusal(34), null);
  assert.match(String(preOAndroidApiRefusal(23)), /API 23/);
  assert.match(olderSdkInstallDiagnosis(), /1\.0\.9|maestro-runner/);
});

test('GH#741 the diagnosis names the tier that actually rejected the install', () => {
  assert.match(olderSdkInstallDiagnosis('maestro-runner'), /pinned maestro-runner/);
  assert.match(olderSdkInstallDiagnosis('maestro-cli'), /Maestro CLI/);
  assert.doesNotMatch(
    olderSdkInstallDiagnosis('maestro-cli'),
    /maestro-runner/,
    'a CLI-tier reject must not be blamed on the maestro-runner pin',
  );
});

test('GH#741 an app-logged token is not an install reject (GH#249 class)', () => {
  assert.equal(
    isOlderSdkInstallFailure(
      'LOG: analytics event {"reason":"INSTALL_FAILED_OLDER_SDK"}\nFlow execution completed',
    ),
    false,
  );
  assert.equal(
    isOlderSdkInstallFailure(
      'adb: failed to install /tmp/appium-uiautomator2-server.apk: Failure [INSTALL_FAILED_OLDER_SDK]',
    ),
    true,
  );
});

test('GH#741 a probed supported API vetoes the runtime install mapping', async () => {
  const handler = baseHandler({
    probeAndroidApiLevel: async () => 34,
    execFile: async () => {
      throw Object.assign(new Error('runner exited 1'), {
        stdout: `Connecting to Android device: ${SERIAL}\nadb: failed to install helper.apk: Failure [INSTALL_FAILED_OLDER_SDK]`,
        stderr: '',
        code: 1,
      });
    },
  });
  const body = envelope(await handler(runArgs));
  assert.notEqual(
    body.code,
    'ANDROID_API_UNSUPPORTED',
    'a supported device must keep its real flow-failure evidence',
  );
});
