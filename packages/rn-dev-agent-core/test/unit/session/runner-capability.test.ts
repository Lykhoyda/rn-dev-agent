import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { afterEach, test } from 'node:test';
import {
  _setFastRunnerStateForTest,
  _setFetchForTest,
  buildRunnerAuthorityEnv,
  probeFastRunnerAuthority,
  stopFastRunner,
} from '../../../dist/runners/rn-fast-runner-client.js';
import { readProcessBirth } from '../../../dist/session/process-birth.js';
import {
  androidHealthMatchesAuthority,
  buildInstrumentAuthorityArgs,
} from '../../../dist/runners/rn-android-runner-client.js';

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

    stopFastRunner('device-1');

    assert.doesNotThrow(() => process.kill(child.pid!, 0));
  } finally {
    child.kill('SIGKILL');
  }
});
