import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createMaestroRunHandler,
  isUiAutomationNotConnectedSessionCreationFailure,
  runFlowParked,
  type FlowParkOpts,
} from '../../dist/tools/maestro-run.js';
import type { MaestroDispatch } from '../../dist/tools/maestro-dispatch.js';
import { ExactAndroidDeviceRequiredError } from '../../dist/runners/release-android-slot.js';

const SERIAL = 'emulator-5580';
const APP_ID = 'dev.example.issue653';
const UIAUTOMATION_FAILURE =
  'Error: failed to create driver: create session: session not created: ' +
  'java.lang.IllegalStateException: UiAutomation not connected, ' +
  'UiAutomation@6baa57c[id=-1, displayId=0, flags=0]';

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

function directSuccess(serial = SERIAL): { stdout: string; stderr: string } {
  return {
    stdout: [
      `Connecting to Android device: ${serial}`,
      'Flow execution completed: 1 passed, 0 failed, 0 skipped',
    ].join('\n'),
    stderr: '',
  };
}

function execFailure(stderr: string, stdout = ''): Error {
  return Object.assign(new Error('runner exited 1'), { stdout, stderr, code: 1 });
}

function baseHandler(overrides: Parameters<typeof createMaestroRunHandler>[0] = {}) {
  return createMaestroRunHandler({
    getActiveSession: () => ({
      name: 'issue-653',
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

test('GH#653 classifies only the structured UiAutomation session-creation error record', () => {
  assert.equal(
    isUiAutomationNotConnectedSessionCreationFailure(execFailure(UIAUTOMATION_FAILURE)),
    true,
  );
  assert.equal(
    isUiAutomationNotConnectedSessionCreationFailure(
      Object.assign(new Error(UIAUTOMATION_FAILURE), { code: 1, stdout: '', stderr: '' }),
    ),
    false,
    'the exec error message is not the structured runner error channel',
  );
  assert.equal(
    isUiAutomationNotConnectedSessionCreationFailure(execFailure('', UIAUTOMATION_FAILURE)),
    false,
    'captured app/runner stdout must not trigger recovery',
  );
  assert.equal(
    isUiAutomationNotConnectedSessionCreationFailure(
      execFailure(`${UIAUTOMATION_FAILURE}\nError: Element with id 'missing' not found`),
    ),
    false,
    'a signature embedded before the actual terminal failure is not the session error record',
  );
  assert.equal(
    isUiAutomationNotConnectedSessionCreationFailure(
      execFailure(`APP_LOG ${UIAUTOMATION_FAILURE}`),
    ),
    false,
    'an app-log record containing the signature must not trigger recovery',
  );
  assert.equal(
    isUiAutomationNotConnectedSessionCreationFailure(
      execFailure('java.lang.IllegalStateException: UiAutomation not connected'),
    ),
    false,
  );
  assert.equal(
    isUiAutomationNotConnectedSessionCreationFailure(
      execFailure(
        'Error: failed to create driver: create session: session not created: java.lang.IllegalStateException: another failure',
      ),
    ),
    false,
  );
});

test('GH#653 maestro_run surfaces the no-exact-device refusal without dispatch', async () => {
  let executions = 0;
  const handler = baseHandler({
    getActiveSession: () => null,
    parkFlow: async () => {
      throw new ExactAndroidDeviceRequiredError();
    },
    execFile: async () => {
      executions += 1;
      return directSuccess();
    },
  });

  const body = envelope(await handler(runArgs));
  assert.equal(body.ok, false);
  assert.equal(body.code, 'EXACT_ANDROID_DEVICE_REQUIRED');
  assert.match(body.error, /No device was mutated/);
  assert.equal(executions, 0);
});

test('GH#653 pre-flow release warnings remain visible in maestro_run', async () => {
  const parkFlow = async <T>(run: () => Promise<T>, opts: FlowParkOpts): Promise<T> => {
    opts.onAndroidRelease?.({ warnings: ['owned test package could not be stopped'] });
    return run();
  };
  const handler = baseHandler({
    parkFlow,
    execFile: async () => directSuccess(),
  });

  const body = envelope(await handler(runArgs));
  assert.equal(body.ok, true);
  assert.deepEqual(body.data.androidSlotReleaseWarnings, [
    'owned test package could not be stopped',
  ]);
  assert.match(body.meta.warning, /Android interaction-slot release warnings/);
});

test('GH#653 reproduced wedge releases only the exact owned slot and retries once', async () => {
  let executions = 0;
  const releases: Array<{
    deviceId?: string;
    includeLegacy?: boolean;
    signal?: AbortSignal;
  }> = [];
  const handler = baseHandler({
    execFile: async () => {
      executions += 1;
      if (executions === 1) throw execFailure(UIAUTOMATION_FAILURE);
      return directSuccess();
    },
    releaseAndroidSlot: async (opts) => {
      releases.push(opts);
      return { warnings: [] };
    },
  });

  const body = envelope(await handler(runArgs));
  assert.equal(body.ok, true);
  assert.equal(body.data.passed, true);
  assert.equal(executions, 2);
  assert.equal(releases.length, 1);
  assert.equal(releases[0]!.deviceId, SERIAL);
  assert.equal(releases[0]!.includeLegacy, false);
  assert.ok(releases[0]!.signal instanceof AbortSignal);
  assert.deepEqual(body.data.androidUiAutomationRecovery, { retried: true, retryCount: 1 });
});

test('GH#653 release diagnostics survive an early device-authority refusal', async () => {
  let executions = 0;
  const handler = baseHandler({
    parkFlow: async (run, opts) => {
      opts.onAndroidRelease?.({ warnings: ['pre-flow owned-package release was partial'] });
      return run();
    },
    execFile: async () => {
      executions += 1;
      if (executions === 1) throw execFailure(UIAUTOMATION_FAILURE);
      return directSuccess('emulator-foreign');
    },
    releaseAndroidSlot: async () => ({
      warnings: ['retry owned-package release was partial'],
    }),
  });

  const body = envelope(await handler(runArgs));
  assert.equal(body.ok, false);
  assert.equal(body.code, 'DEVICE_AUTHORITY_MISMATCH');
  assert.equal(executions, 2);
  assert.deepEqual(body.meta.androidSlotReleaseWarnings, [
    'pre-flow owned-package release was partial',
    'retry owned-package release was partial',
  ]);
  assert.deepEqual(body.meta.androidUiAutomationRecovery, { retried: true, retryCount: 1 });
});

test('GH#653 retry release failures stay visible after recovery', async () => {
  let executions = 0;
  const handler = baseHandler({
    execFile: async () => {
      executions += 1;
      if (executions === 1) throw execFailure(UIAUTOMATION_FAILURE);
      return directSuccess();
    },
    releaseAndroidSlot: async () => ({
      warnings: ['am force-stop dev.lykhoyda.rndevagent.androidrunner failed: denied'],
    }),
  });

  const body = envelope(await handler(runArgs));
  assert.equal(body.ok, true);
  assert.deepEqual(body.data.androidSlotReleaseWarnings, [
    'am force-stop dev.lykhoyda.rndevagent.androidrunner failed: denied',
  ]);
  assert.match(body.meta.warning, /force-stop.*failed: denied/);
});

test('GH#237 shared pre-flow parking keeps legacy daemon cleanup enabled', async () => {
  const releases: Array<{ deviceId?: string; includeLegacy?: boolean }> = [];
  const parked = await runFlowParked(async () => 'ran', {
    platform: 'android',
    deviceId: SERIAL,
    markCdpStale: () => {},
    releaseAndroidSlot: async (opts) => {
      releases.push(opts);
    },
  });

  assert.equal(parked, 'ran');
  assert.deepEqual(releases, [{ deviceId: SERIAL }]);
  assert.equal(releases[0]!.includeLegacy, undefined);
});

test('GH#653 recovery release failure keeps the original UiAutomation failure', async () => {
  let executions = 0;
  const handler = baseHandler({
    execFile: async () => {
      executions += 1;
      throw execFailure(UIAUTOMATION_FAILURE, `Connecting to Android device: ${SERIAL}`);
    },
    releaseAndroidSlot: async () => {
      throw new ExactAndroidDeviceRequiredError();
    },
  });

  const body = envelope(await handler(runArgs));
  assert.equal(body.ok, false);
  assert.equal(executions, 1);
  assert.notEqual(body.code, 'EXACT_ANDROID_DEVICE_REQUIRED');
  assert.match(body.meta.output, /UiAutomation not connected/);
  assert.match(body.error, /UiAutomation recovery release failed/);
  assert.equal(body.meta.androidSlotReleaseWarnings.length, 1);
  assert.match(
    body.meta.androidSlotReleaseWarnings[0],
    /UiAutomation recovery release failed:.*without an exact serial/s,
  );
  assert.deepEqual(body.meta.androidUiAutomationRecovery, { retried: false, retryCount: 0 });
});

test('GH#653 exhausted flow deadline skips recovery cleanup and retry', async () => {
  let executions = 0;
  let releases = 0;
  const times = [0, 0, 5_001];
  const handler = baseHandler({
    now: () => times.shift() ?? 5_001,
    execFile: async () => {
      executions += 1;
      throw execFailure(UIAUTOMATION_FAILURE);
    },
    releaseAndroidSlot: async () => {
      releases += 1;
      return { warnings: [] };
    },
  });

  const body = envelope(await handler({ ...runArgs, timeoutMs: 5_000 }));
  assert.equal(body.ok, false);
  assert.equal(executions, 1);
  assert.equal(releases, 0);
  assert.deepEqual(body.meta.androidUiAutomationRecovery, { retried: false, retryCount: 0 });
  assert.deepEqual(body.meta.androidSlotReleaseWarnings, [
    'UiAutomation recovery skipped: Maestro flow timeout was exhausted',
  ]);
});

test('GH#653 recovery cleanup is aborted by the remaining flow deadline', async () => {
  let executions = 0;
  let releaseSignal: AbortSignal | undefined;
  const handler = baseHandler({
    now: () => 0,
    execFile: async () => {
      executions += 1;
      throw execFailure(UIAUTOMATION_FAILURE, `Connecting to Android device: ${SERIAL}`);
    },
    releaseAndroidSlot: async (opts) => {
      releaseSignal = opts.signal;
      await new Promise<void>((_resolve, reject) => {
        opts.signal?.addEventListener('abort', () => reject(opts.signal?.reason), { once: true });
      });
    },
  });

  const body = envelope(await handler({ ...runArgs, timeoutMs: 20 }));
  assert.equal(body.ok, false);
  assert.equal(executions, 1);
  assert.equal(releaseSignal?.aborted, true);
  assert.deepEqual(body.meta.androidUiAutomationRecovery, { retried: false, retryCount: 0 });
  assert.match(body.error, /UiAutomation recovery release failed/);
  assert.match(body.meta.output, /UiAutomation not connected/);
});

test('GH#653 a repeated wedge is bounded to one retry', async () => {
  let executions = 0;
  let releases = 0;
  const handler = baseHandler({
    execFile: async () => {
      executions += 1;
      throw execFailure(UIAUTOMATION_FAILURE);
    },
    releaseAndroidSlot: async () => {
      releases += 1;
      return { warnings: [] };
    },
  });

  const body = envelope(await handler(runArgs));
  assert.equal(body.ok, false);
  assert.equal(executions, 2);
  assert.equal(releases, 1);
  assert.deepEqual(body.meta.androidUiAutomationRecovery, { retried: true, retryCount: 1 });
});

test('GH#653 an app-log copy of the wedge signature never releases or retries', async () => {
  let executions = 0;
  let releases = 0;
  const handler = baseHandler({
    execFile: async () => {
      executions += 1;
      throw execFailure(
        `Error: Element with id 'missing' not found`,
        [
          `Connecting to Android device: ${SERIAL}`,
          `APP_LOG ${UIAUTOMATION_FAILURE}`,
          UIAUTOMATION_FAILURE,
        ].join('\n'),
      );
    },
    releaseAndroidSlot: async () => {
      releases += 1;
      return { warnings: [] };
    },
  });

  const body = envelope(await handler(runArgs));
  assert.equal(body.ok, false);
  assert.equal(executions, 1);
  assert.equal(releases, 0);
  assert.equal(body.meta.androidUiAutomationRecovery, undefined);
});

test('GH#653 unrelated Maestro failures never release or retry', async () => {
  let executions = 0;
  let releases = 0;
  const handler = baseHandler({
    execFile: async () => {
      executions += 1;
      throw execFailure(
        `Connecting to Android device: ${SERIAL}\nError: Element with id 'missing' not found`,
      );
    },
    releaseAndroidSlot: async () => {
      releases += 1;
      return { warnings: [] };
    },
  });

  const body = envelope(await handler(runArgs));
  assert.equal(body.ok, false);
  assert.equal(executions, 1);
  assert.equal(releases, 0);
  assert.equal(body.meta.androidUiAutomationRecovery, undefined);
});
