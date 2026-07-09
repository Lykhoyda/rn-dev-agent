import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createReadySignalParser,
  parseReadySignal,
} from '../../../dist/runners/rn-fast-runner-client.js';
import {
  resolveQuiescenceBypass,
  buildRunnerQuiescenceEnv,
} from '../../../dist/runners/quiescence.js';
import {
  _setRunnerStateForTest,
  _setFetchForTest,
  _resetQuiescenceAnnouncementForTest,
  runIOS,
  probeFastRunnerLivenessDetailed,
} from '../../../dist/runners/rn-fast-runner-client.js';
import { getDeviceSessionHealth } from '../../../dist/tools/device-session-health.js';
import { REQUIRED_IOS_COMMANDS } from '../../../dist/runners/protocol.js';

const READY = 'RN_FAST_RUNNER_LISTENER_READY\nRN_FAST_RUNNER_PORT=22088\n';

test('parser captures QUIESCENCE_BYPASS_ACTIVE marker before READY', () => {
  const result = parseReadySignal(
    `2026-07-02 10:00:00 Runner[1:2] RN_FAST_RUNNER_QUIESCENCE_BYPASS_ACTIVE\n${READY}`,
  );
  assert.deepEqual(result, { ready: true, port: 22088, quiescence: 'active' });
});

test('parser captures DISABLED and UNAVAILABLE markers', () => {
  assert.deepEqual(parseReadySignal(`RN_FAST_RUNNER_QUIESCENCE_BYPASS_DISABLED\n${READY}`), {
    ready: true,
    port: 22088,
    quiescence: 'disabled',
  });
  assert.deepEqual(parseReadySignal(`RN_FAST_RUNNER_QUIESCENCE_UNAVAILABLE\n${READY}`), {
    ready: true,
    port: 22088,
    quiescence: 'unavailable',
  });
});

test('parser omits quiescence when no marker seen (old runner binary)', () => {
  assert.deepEqual(parseReadySignal(READY), { ready: true, port: 22088 });
});

test('parser handles marker split across chunk boundaries', () => {
  const parser = createReadySignalParser();
  assert.equal(parser.feed('RN_FAST_RUNNER_QUIESCENCE_BYPASS_AC'), null);
  assert.equal(parser.feed('TIVE\nRN_FAST_RUNNER_LISTENER_READY\n'), null);
  assert.deepEqual(parser.feed('RN_FAST_RUNNER_PORT=9999\n'), {
    ready: true,
    port: 9999,
    quiescence: 'active',
  });
});

test('failure markers still win over quiescence markers', () => {
  const result = parseReadySignal(
    'RN_FAST_RUNNER_QUIESCENCE_BYPASS_ACTIVE\nRN_FAST_RUNNER_LISTENER_FAILED\n',
  );
  assert.deepEqual(result, { error: 'RN_FAST_RUNNER_LISTENER_FAILED' });
});

test('parser tolerates the =classic variant suffix on the ACTIVE marker', () => {
  const result = parseReadySignal(`RN_FAST_RUNNER_QUIESCENCE_BYPASS_ACTIVE=classic\n${READY}`);
  assert.deepEqual(result, { ready: true, port: 22088, quiescence: 'active' });
});

test('resolveQuiescenceBypass defaults ON and honors 0/false opt-out', () => {
  assert.equal(resolveQuiescenceBypass({}), true);
  assert.equal(resolveQuiescenceBypass({ RN_QUIESCENCE_BYPASS: '1' }), true);
  assert.equal(resolveQuiescenceBypass({ RN_QUIESCENCE_BYPASS: 'weird' }), true);
  assert.equal(resolveQuiescenceBypass({ RN_QUIESCENCE_BYPASS: '0' }), false);
  assert.equal(resolveQuiescenceBypass({ RN_QUIESCENCE_BYPASS: 'false' }), false);
  assert.equal(resolveQuiescenceBypass({ RN_QUIESCENCE_BYPASS: ' FALSE ' }), false);
});

test('buildRunnerQuiescenceEnv emits both plain and TEST_RUNNER_ forms', () => {
  assert.deepEqual(buildRunnerQuiescenceEnv({}), {
    RN_QUIESCENCE_BYPASS: '1',
    TEST_RUNNER_RN_QUIESCENCE_BYPASS: '1',
  });
  assert.deepEqual(buildRunnerQuiescenceEnv({ RN_QUIESCENCE_BYPASS: '0' }), {
    RN_QUIESCENCE_BYPASS: '0',
    TEST_RUNNER_RN_QUIESCENCE_BYPASS: '0',
  });
});

function fakeState(quiescence) {
  return {
    schemaVersion: 1,
    port: 12345,
    pid: process.pid,
    deviceId: 'UDID-TEST',
    bundleId: 'com.example.app',
    startedAt: '2026-07-02T00:00:00.000Z',
    protocolVersion: 1,
    ...(quiescence !== undefined ? { quiescence } : {}),
  };
}

function okFetch() {
  return async () =>
    new Response(JSON.stringify({ ok: true, v: 1, data: { message: 'done' } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
}

test('runIOS announces meta.quiescenceBypass exactly once after boot', async () => {
  _setRunnerStateForTest(fakeState('active'));
  _setFetchForTest(okFetch());
  _resetQuiescenceAnnouncementForTest(true);

  const first = JSON.parse((await runIOS({ command: 'tap', x: 1, y: 1 })).content[0].text);
  assert.equal(first.meta?.quiescenceBypass, 'active');

  const second = JSON.parse((await runIOS({ command: 'tap', x: 1, y: 1 })).content[0].text);
  assert.equal(second.meta?.quiescenceBypass, undefined);

  _setRunnerStateForTest(null);
});

test('runIOS announces disabled status too', async () => {
  _setRunnerStateForTest(fakeState('disabled'));
  _setFetchForTest(okFetch());
  _resetQuiescenceAnnouncementForTest(true);

  const first = JSON.parse((await runIOS({ command: 'tap', x: 1, y: 1 })).content[0].text);
  assert.equal(first.meta?.quiescenceBypass, 'disabled');

  _setRunnerStateForTest(null);
});

test('runIOS announces nothing when the runner reported no marker (old binary)', async () => {
  _setRunnerStateForTest(fakeState(undefined));
  _setFetchForTest(okFetch());
  _resetQuiescenceAnnouncementForTest(true);

  const first = JSON.parse((await runIOS({ command: 'tap', x: 1, y: 1 })).content[0].text);
  assert.equal(first.meta?.quiescenceBypass, undefined);

  _setRunnerStateForTest(null);
});

test('liveness detail carries capabilities from /health', async () => {
  const detail = await probeFastRunnerLivenessDetailed({
    getState: () => ({ pid: 1, port: 1, deviceId: 'D', bundleId: 'B' }),
    processAlive: () => true,
    httpProbe: async () => ({
      ok: true,
      status: 200,
      bodyOk: true,
      protocolVersion: 1,
      capabilities: ['QUIESCENCE_BYPASS'],
      commands: [...REQUIRED_IOS_COMMANDS],
    }),
    pluginVersion: null,
  });
  assert.equal(detail.liveness, 'alive');
  assert.deepEqual(detail.capabilities, ['QUIESCENCE_BYPASS']);
});

test('deviceSession health surfaces runnerCapabilities', async () => {
  const health = await getDeviceSessionHealth({
    getActiveSession: () => ({
      platform: 'ios',
      appId: 'com.example.app',
      deviceId: 'UDID-TEST',
    }),
    adopt: () => {},
    probeLiveness: async () => ({
      liveness: 'alive',
      runnerProtocolVersion: 1,
      capabilities: ['QUIESCENCE_BYPASS'],
    }),
  });
  assert.deepEqual(health.runnerCapabilities, ['QUIESCENCE_BYPASS']);
});

test('deviceSession health omits runnerCapabilities when probe has none', async () => {
  const health = await getDeviceSessionHealth({
    getActiveSession: () => ({
      platform: 'ios',
      appId: 'com.example.app',
      deviceId: 'UDID-TEST',
    }),
    adopt: () => {},
    probeLiveness: async () => ({ liveness: 'alive', runnerProtocolVersion: 1 }),
  });
  assert.equal(health.runnerCapabilities, undefined);
});

test('deviceSession health omits runnerCapabilities when the list is empty', async () => {
  // Every pre-#384 runner (and a disabled/unavailable one) reports [] from
  // /health — an empty list must not add noise to cdp_status.
  const health = await getDeviceSessionHealth({
    getActiveSession: () => ({
      platform: 'ios',
      appId: 'com.example.app',
      deviceId: 'UDID-TEST',
    }),
    adopt: () => {},
    probeLiveness: async () => ({ liveness: 'alive', runnerProtocolVersion: 1, capabilities: [] }),
  });
  assert.equal(health.runnerCapabilities, undefined);
});
