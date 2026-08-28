import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { afterEach, test } from 'node:test';
import {
  clearFastRunnerAfterVerifiedStop,
  _setFastRunnerStateForTest,
  _setFetchForTest,
  buildRunnerAuthorityEnv,
  buildRunnerAttachOnlyEnv,
  getFastRunnerState,
  probeFastRunnerAuthority,
  stopFastRunner,
} from '../../../dist/runners/rn-fast-runner-client.js';
import { readProcessBirth } from '../../../dist/session/process-birth.js';
import {
  androidHealthMatchesAuthority,
  buildInstrumentAuthorityArgs,
} from '../../../dist/runners/rn-android-runner-client.js';
import { bindNativeRunner, unbindNativeRunner } from '../../../dist/session/runner-binding.js';

afterEach(() => {
  _setFetchForTest(globalThis.fetch);
  _setFastRunnerStateForTest(null);
});

test('iOS forwards one runner capability and fenced identity through xcodebuild', () => {
  const env = buildRunnerAuthorityEnv({
    instanceId: 'runner-1',
    sessionId: 'session-1',
    claimEpoch: 9,
    capability: 'secret',
  });

  for (const key of [
    'RN_RUNNER_INSTANCE_ID',
    'RN_RUNNER_SESSION_ID',
    'RN_RUNNER_CLAIM_EPOCH',
    'RN_RUNNER_CAPABILITY',
  ]) {
    assert.equal(env[`TEST_RUNNER_${key}`], env[key]);
  }
});

test('iOS forwards attach-only through both direct and xcodebuild environments', () => {
  assert.deepEqual(buildRunnerAttachOnlyEnv(true), {
    RN_RUNNER_ATTACH_ONLY: '1',
    TEST_RUNNER_RN_RUNNER_ATTACH_ONLY: '1',
  });
  assert.deepEqual(buildRunnerAttachOnlyEnv(false), {
    RN_RUNNER_ATTACH_ONLY: '0',
    TEST_RUNNER_RN_RUNNER_ATTACH_ONLY: '0',
  });
});

test('Android instrumentation receives the complete runner authority tuple', () => {
  const args = buildInstrumentAuthorityArgs({
    instanceId: 'runner-1',
    sessionId: 'session-1',
    claimEpoch: 9,
    capability: 'secret',
    deviceId: 'emulator-5554',
    appId: 'dev.example',
  });
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 3) {
    assert.equal(args[index], '-e');
    values.set(args[index + 1]!, args[index + 2]!);
  }

  assert.deepEqual(Object.fromEntries(values), {
    RN_RUNNER_INSTANCE_ID: 'runner-1',
    RN_RUNNER_SESSION_ID: 'session-1',
    RN_RUNNER_CLAIM_EPOCH: '9',
    RN_RUNNER_CAPABILITY: 'secret',
    RN_RUNNER_DEVICE_ID: 'emulator-5554',
    RN_RUNNER_APP_ID: 'dev.example',
  });
});

test('fresh Android admission rejects a health tuple from another runner instance', () => {
  assert.equal(
    androidHealthMatchesAuthority(
      {
        reachable: true,
        ok: true,
        instanceId: 'legacy-runner',
        sessionId: 'session-1',
        claimEpoch: 9,
        deviceId: 'emulator-5554',
        appId: 'dev.example',
      },
      {
        instanceId: 'runner-1',
        sessionId: 'session-1',
        claimEpoch: 9,
        deviceId: 'emulator-5554',
        appId: 'dev.example',
      },
    ),
    false,
  );
});

test('retained iOS authority probe authenticates capability and exact tuple', async () => {
  let authorization = '';
  _setFetchForTest(async (_url, init) => {
    authorization = String(init?.headers?.authorization ?? '');
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        instanceId: 'runner-1',
        sessionId: 'session-1',
        claimEpoch: 9,
        deviceId: 'device-1',
        appId: 'dev.example',
      }),
    };
  });

  assert.equal(
    await probeFastRunnerAuthority({
      port: 9100,
      capability: 'secret',
      instanceId: 'runner-1',
      sessionId: 'session-1',
      claimEpoch: 9,
      deviceId: 'device-1',
      appId: 'dev.example',
    }),
    true,
  );
  assert.equal(authorization, 'Bearer secret');
});

test('persisted iOS teardown never signals a reused PID', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  try {
    const birth = readProcessBirth(child.pid!);
    assert.ok(birth);
    _setFastRunnerStateForTest({
      schemaVersion: 1,
      port: 12345,
      pid: child.pid!,
      deviceId: 'device-1',
      bundleId: 'dev.example',
      startedAt: new Date().toISOString(),
      protocolVersion: 1,
      processBirth: `${birth.token}-reused`,
    });

    await stopFastRunner('device-1');

    assert.doesNotThrow(() => process.kill(child.pid!, 0));
  } finally {
    child.kill('SIGKILL');
  }
});

test('verified runner cleanup clears local state without signalling the child again', () => {
  const deviceId = `unit-test-device-${process.pid}`;
  const binding = {
    pid: 4242,
    processBirth: 'birth-token',
    instanceId: 'runner-instance',
    deviceId,
  };
  _setFastRunnerStateForTest({
    schemaVersion: 1,
    port: 12345,
    pid: binding.pid,
    deviceId: binding.deviceId,
    bundleId: 'dev.example',
    startedAt: new Date().toISOString(),
    protocolVersion: 1,
    processBirth: binding.processBirth,
    instanceId: binding.instanceId,
  });

  clearFastRunnerAfterVerifiedStop(binding);

  assert.equal(getFastRunnerState(), null);
});

test('runner binding commits its claim and binding in one registry transaction', () => {
  const processBirth = readProcessBirth(process.pid);
  assert.ok(processBirth);
  _setFastRunnerStateForTest({
    schemaVersion: 1,
    port: 9100,
    pid: process.pid,
    deviceId: 'device-1',
    bundleId: 'dev.example',
    startedAt: new Date().toISOString(),
    protocolVersion: 1,
    processBirth: processBirth.token,
    instanceId: 'runner-1',
    sessionId: 'session-1',
    claimEpoch: 9,
    capability: 'secret',
  });
  let update;
  const status = {
    bindings: {
      device: { platform: 'ios', deviceId: 'device-1', appId: 'dev.example' },
    },
  };
  const runtime = {
    requireAvailable: () => ({
      registry: {
        getSessionStatus: () => status,
        updateBindings: (_session, input) => {
          update = input;
        },
      },
      session: { sessionId: 'session-1', claimEpoch: 9 },
    }),
  };

  bindNativeRunner(runtime, {
    platform: 'ios',
    deviceId: 'device-1',
    appId: 'dev.example',
  });

  assert.deepEqual(update.claimResources, [{ type: 'runner', key: 'ios:device-1:9100' }]);
  assert.equal(update.bindings.runner.instanceId, 'runner-1');
});

test('runner binding refuses unknown and mismatch with distinct attestation details', () => {
  _setFastRunnerStateForTest({
    schemaVersion: 1,
    port: 9100,
    pid: 4242,
    deviceId: 'device-1',
    bundleId: 'dev.example',
    startedAt: new Date().toISOString(),
    protocolVersion: 1,
    processBirth: 'runner-birth',
    instanceId: 'runner-1',
    sessionId: 'session-1',
    claimEpoch: 9,
    capability: 'secret',
  });
  let updates = 0;
  const runtime = {
    requireAvailable: () => ({
      registry: {
        getSessionStatus: () => ({
          bindings: {
            device: { platform: 'ios', deviceId: 'device-1', appId: 'dev.example' },
          },
        }),
        updateBindings: () => {
          updates += 1;
        },
      },
      session: { sessionId: 'session-1', claimEpoch: 9 },
    }),
  };
  const target = { platform: 'ios', deviceId: 'device-1', appId: 'dev.example' } as const;

  assert.throws(
    () =>
      bindNativeRunner(runtime, target, {
        inspectOwner: (owner) => ({
          status: 'unknown',
          pid: owner.pid,
          cause: {
            pid: owner.pid,
            step: 'helper',
            failure: 'timeout',
            elapsedMs: 2000,
          },
        }),
      }),
    (error: { code?: string; details?: Record<string, unknown> }) =>
      error.code === 'RUNNER_OWNERSHIP_MISMATCH' &&
      error.details?.attestation === 'unavailable' &&
      error.details?.step === 'helper' &&
      error.details?.failure === 'timeout' &&
      String(error.details?.nextAction).includes('loaded host') &&
      !String(error.details?.nextAction).includes('Re-open'),
  );
  assert.throws(
    () =>
      bindNativeRunner(runtime, target, {
        inspectOwner: (owner) => ({
          status: 'mismatch',
          pid: owner.pid,
          expected: 'runner-birth',
          observed: 'different-birth',
        }),
      }),
    (error: { code?: string; details?: Record<string, unknown> }) =>
      error.code === 'RUNNER_OWNERSHIP_MISMATCH' && error.details?.attestation === 'mismatch',
  );
  assert.equal(updates, 0);
});

test('runner unbind finalizes the bound platform before one atomic release+unbind write', () => {
  const calls: string[] = [];
  let update;
  const status = {
    bindings: {
      bundle: null,
      runner: { platform: 'ios', deviceId: 'device-1', port: 9100 },
    },
  };
  const runtime = {
    requireAvailable: () => ({
      registry: {
        getSessionStatus: () => status,
        updateBindings: (_session, input) => {
          calls.push('unbind');
          update = input;
        },
      },
      session: { sessionId: 'session-1', claimEpoch: 9 },
    }),
  };

  unbindNativeRunner(runtime, (platform) => calls.push(`finalize:${platform}`));

  // Claim release and binding clear must share one registry transaction.
  assert.deepEqual(calls, ['finalize:ios', 'unbind']);
  assert.deepEqual(update.releaseResources, [{ type: 'runner', key: 'ios:device-1:9100' }]);
  assert.equal(update.bindings.runner, null);
});

test('runner unbind skips finalization when authority is absent', () => {
  let finalized = false;
  const runtime = {
    requireAvailable: () => ({
      registry: {
        getSessionStatus: () => ({ bindings: { bundle: null, runner: null } }),
      },
      session: { sessionId: 'session-1', claimEpoch: 9 },
    }),
  };

  unbindNativeRunner(runtime, () => {
    finalized = true;
  });

  assert.equal(finalized, false);
});
