// GH #397 Phase 2 — iOS-only at-risk gate truth table + simctl runtime parser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateBlindProbeGate,
  parseIosRuntimeMajorForUdid,
  getIosRuntimeMajorForUdid,
  _resetIosRuntimeCacheForTest,
} from '../../dist/domain/blind-probe-gate.js';
import { shouldAutoPromoteToActive } from '../../dist/domain/reusable-action.js';
import type { RunRecord } from '../../src/domain/reusable-action.js';

const REC = (over: Partial<RunRecord> = {}): RunRecord => ({
  timestamp: '2026-07-01T00:00:00Z',
  durationMs: 1000,
  status: 'fail',
  failureCode: 'TRANSPORT_BLIND',
  trigger: 'agent',
  ...over,
});

test('gh-397: android never at-risk', () => {
  assert.equal(
    evaluateBlindProbeGate({
      platform: 'android',
      iosRuntimeMajor: 26,
      deviceId: 'X',
      runHistory: [REC({ deviceId: 'X' })],
    }).atRisk,
    null,
  );
});

test('gh-397: iOS >= 26 runtime is at-risk regardless of history', () => {
  assert.equal(
    evaluateBlindProbeGate({
      platform: 'ios',
      iosRuntimeMajor: 26,
      deviceId: 'X',
      runHistory: [],
    }).atRisk,
    'ios26',
  );
  assert.equal(
    evaluateBlindProbeGate({
      platform: undefined,
      iosRuntimeMajor: 27,
      deviceId: 'X',
      runHistory: [],
    }).atRisk,
    'ios26',
  );
});

test('gh-397: iOS 18 with unrelated failures is NOT at-risk (healthy path untouched)', () => {
  assert.equal(
    evaluateBlindProbeGate({
      platform: 'ios',
      iosRuntimeMajor: 18,
      deviceId: 'X',
      runHistory: [REC({ failureCode: 'SELECTOR_NOT_FOUND', deviceId: 'X' })],
    }).atRisk,
    null,
  );
});

test('gh-397: history latch requires a STRICT deviceId match', () => {
  const gate = (recOver: Partial<RunRecord>, deviceId: string | null) =>
    evaluateBlindProbeGate({
      platform: 'ios',
      iosRuntimeMajor: 18,
      deviceId,
      runHistory: [REC(recOver)],
    }).atRisk;
  assert.equal(gate({ deviceId: 'X' }, 'X'), 'prior-transport-blind');
  assert.equal(gate({ deviceId: 'Y' }, 'X'), null, 'other device never latches');
  assert.equal(gate({}, 'X'), null, 'pre-upgrade record without deviceId never latches');
  assert.equal(gate({ deviceId: 'X' }, null), null, 'unknown live device never latches');
});

test('gh-397: latch recency + reset semantics (bounded window, clean-pass reset)', () => {
  const hist = (...recs: RunRecord[]) =>
    evaluateBlindProbeGate({
      platform: 'ios',
      iosRuntimeMajor: 18,
      deviceId: 'X',
      runHistory: recs,
    }).atRisk;
  const TB = REC({ deviceId: 'X' });
  const MAESTRO_PASS = REC({ status: 'pass', failureCode: undefined, deviceId: 'X' });
  const CDPJS_PASS = REC({
    status: 'pass',
    failureCode: undefined,
    transport: 'cdp-js',
    deviceId: 'X',
  });
  const NEUTRAL = REC({ failureCode: 'SELECTOR_NOT_FOUND', deviceId: 'X' });
  assert.equal(hist(TB, MAESTRO_PASS), null, 'clean maestro pass clears the latch');
  assert.equal(hist(MAESTRO_PASS, TB), 'prior-transport-blind', 'TB after the pass latches');
  assert.equal(hist(TB, CDPJS_PASS), 'prior-transport-blind', 'cdp-js pass does not clear');
  assert.equal(
    hist(TB, NEUTRAL, NEUTRAL, NEUTRAL, NEUTRAL, NEUTRAL),
    null,
    'TB ages out of the 5-record window',
  );
  assert.equal(
    hist(TB, NEUTRAL, NEUTRAL, NEUTRAL, NEUTRAL),
    'prior-transport-blind',
    'TB still inside the window latches',
  );
});

test('gh-397: platform undefined with no runtime evidence never latches (fail-open)', () => {
  assert.equal(
    evaluateBlindProbeGate({
      platform: undefined,
      iosRuntimeMajor: null,
      deviceId: 'X',
      runHistory: [REC({ deviceId: 'X' })],
    }).atRisk,
    null,
  );
});

test('gh-397: FALLBACK_REPLAY_FAILED is non-decisive for the latch', () => {
  assert.equal(
    evaluateBlindProbeGate({
      platform: 'ios',
      iosRuntimeMajor: 18,
      deviceId: 'X',
      runHistory: [
        REC({ deviceId: 'X' }),
        REC({ deviceId: 'X', failureCode: 'FALLBACK_REPLAY_FAILED', transport: 'cdp-js' }),
      ],
    }).atRisk,
    'prior-transport-blind',
    'probe-routed failures neither clear nor re-set the latch',
  );
});

test('gh-397: probe-routed cdp-js passes never auto-promote', () => {
  const meta = { status: 'experimental' } as Parameters<typeof shouldAutoPromoteToActive>[0];
  const pass = REC({ status: 'pass', failureCode: undefined });
  assert.equal(shouldAutoPromoteToActive(meta, pass), true, 'baseline promotion intact');
  assert.equal(
    shouldAutoPromoteToActive(meta, {
      ...pass,
      transport: 'cdp-js',
      blindProbe: { atRisk: 'ios26', skippedMaestro: true },
    }),
    false,
  );
});

test('gh-397: parseIosRuntimeMajorForUdid finds the runtime key holding the udid', () => {
  const json = {
    devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-18-5': [{ udid: 'AAA', state: 'Booted' }],
      'com.apple.CoreSimulator.SimRuntime.iOS-26-0': [{ udid: 'BBB', state: 'Shutdown' }],
      'com.apple.CoreSimulator.SimRuntime.watchOS-11-0': [{ udid: 'CCC' }],
    },
  };
  assert.equal(parseIosRuntimeMajorForUdid(json, 'AAA'), 18);
  assert.equal(parseIosRuntimeMajorForUdid(json, 'BBB'), 26);
  assert.equal(parseIosRuntimeMajorForUdid(json, 'CCC'), null, 'watchOS is not iOS');
  assert.equal(parseIosRuntimeMajorForUdid(json, 'ZZZ'), null);
  assert.equal(parseIosRuntimeMajorForUdid(null, 'AAA'), null);
  assert.equal(parseIosRuntimeMajorForUdid({ devices: 'garbage' }, 'AAA'), null);
});

test('gh-397: getIosRuntimeMajorForUdid caches per udid and fails open', async () => {
  _resetIosRuntimeCacheForTest();
  let calls = 0;
  const exec = async () => {
    calls++;
    return {
      stdout: JSON.stringify({
        devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-26-1': [{ udid: 'U1' }] },
      }),
    };
  };
  assert.equal(await getIosRuntimeMajorForUdid('U1', exec), 26);
  assert.equal(await getIosRuntimeMajorForUdid('U1', exec), 26);
  assert.equal(calls, 1, 'second call served from cache');

  _resetIosRuntimeCacheForTest();
  const boom = async () => {
    throw new Error('no xcrun');
  };
  assert.equal(await getIosRuntimeMajorForUdid('U2', boom), null);
  _resetIosRuntimeCacheForTest();
});
