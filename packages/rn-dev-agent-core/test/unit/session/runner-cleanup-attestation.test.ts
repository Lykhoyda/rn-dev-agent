import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reapStaleFastRunner } from '../../../dist/runners/rn-fast-runner-client.js';
import { stopBoundRunner } from '../../../dist/session/process-cleanup.js';
import { PROCESS_ATTESTATION_UNAVAILABLE_NEXT_ACTION } from '../../../dist/session/process-owner.js';
import { SessionAuthorityError } from '../../../dist/session/registry.js';

const pid = 12_345;
const state = {
  pid,
  port: 22_088,
  deviceId: 'sim-1',
  bundleId: 'com.example',
  processBirth: 'birth-12345',
};
const matchingBirth = {
  status: 'present' as const,
  birth: { pid, source: 'darwin-libproc' as const, token: state.processBirth },
};
const unavailableBirth = {
  status: 'unknown' as const,
  cause: { pid, step: 'helper' as const, failure: 'timeout' as const, elapsedMs: 2_000 },
};

function sequence<T>(...values: T[]): () => T {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)]!;
}

function isUnavailableRefusal(error: unknown, message: string): boolean {
  assert.ok(error instanceof SessionAuthorityError);
  assert.equal(error.code, 'RUNNER_ADOPTION_REQUIRED');
  assert.equal(error.message, `RUNNER_ADOPTION_REQUIRED: ${message}`);
  assert.deepEqual(error.details, {
    attestation: 'unavailable',
    ...unavailableBirth.cause,
    nextAction: PROCESS_ATTESTATION_UNAVAILABLE_NEXT_ACTION,
  });
  return true;
}

test('architect R5: iOS stale-runner cleanup preserves unavailable attestation details', async () => {
  const scenarios = [
    {
      state: { ...state, processBirth: undefined },
      probes: [unavailableBirth],
      message: 'live persisted iOS runner lacks process-birth authority',
      signals: [] as NodeJS.Signals[],
    },
    {
      state,
      probes: [unavailableBirth],
      message: 'iOS runner process identity is unproven',
      signals: [] as NodeJS.Signals[],
    },
    {
      state,
      probes: [matchingBirth, unavailableBirth],
      message: 'iOS runner termination is unproven',
      signals: ['SIGTERM'] as NodeJS.Signals[],
    },
    {
      state,
      probes: [matchingBirth, matchingBirth, unavailableBirth],
      message: 'iOS runner termination is unproven',
      signals: ['SIGTERM', 'SIGKILL'] as NodeJS.Signals[],
    },
  ];

  for (const scenario of scenarios) {
    const signals: NodeJS.Signals[] = [];
    await assert.rejects(
      reapStaleFastRunner({
        getState: () => scenario.state,
        probeProcessBirth: sequence(...scenario.probes),
        sendSignal: (_pid, signal) => signals.push(signal),
        sleep: async () => {},
        clearState: () => assert.fail('unavailable identity must preserve runner state'),
        graceMs: 0,
      }),
      (error: unknown) => isUnavailableRefusal(error, scenario.message),
    );
    assert.deepEqual(signals, scenario.signals);
  }
});

const binding = {
  pid,
  processBirth: state.processBirth,
  platform: 'ios',
  deviceId: 'sim-1',
  port: 9_200,
  instanceId: 'runner-instance-1',
  capability: 'runner-capability',
};

test('architect R6: bound-runner cleanup preserves initial unavailable attestation details', async () => {
  const signals: NodeJS.Signals[] = [];
  await assert.rejects(
    stopBoundRunner(
      binding,
      () => unavailableBirth,
      (_pid, signal) => signals.push(signal),
    ),
    (error: unknown) => isUnavailableRefusal(error, 'runner process identity is unavailable'),
  );
  assert.deepEqual(signals, []);
});

test('architect R7: bound-runner shutdown preserves unavailable attestation details', async () => {
  const scenarios = [
    {
      probes: [matchingBirth, unavailableBirth],
      termGraceMs: 500,
      signals: ['SIGTERM'] as NodeJS.Signals[],
    },
    {
      probes: [matchingBirth, matchingBirth, unavailableBirth],
      termGraceMs: 0,
      signals: ['SIGTERM'] as NodeJS.Signals[],
    },
    {
      probes: [matchingBirth, matchingBirth, matchingBirth, unavailableBirth],
      termGraceMs: 0,
      signals: ['SIGTERM', 'SIGKILL'] as NodeJS.Signals[],
    },
  ];

  for (const scenario of scenarios) {
    const signals: NodeJS.Signals[] = [];
    await assert.rejects(
      stopBoundRunner(
        binding,
        sequence(...scenario.probes),
        (_pid, signal) => signals.push(signal),
        2_000,
        async () => assert.fail('iOS cleanup must not invoke adb'),
        scenario.termGraceMs,
      ),
      (error: unknown) =>
        isUnavailableRefusal(
          error,
          'runner process did not stop before the cleanup deadline; shutdown identity is unknown',
        ),
    );
    assert.deepEqual(signals, scenario.signals);
  }
});
