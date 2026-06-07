// GH #208 multi-review (Codex + Gemini) follow-up fixes:
// F1: storm-preempt must honor an explicit args.platform (tear down + autoConnect, not softReconnect).
// F2: AppDetachedError must NOT cold-restart iOS when the caller pinned a non-iOS platform.
// F3: recoverDetached must surface a simctl launch error (not hide it behind "still-detached").
// F4: the recovery-success path must not throw out of the catch if buildStatusResult fails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockClient } from '../helpers/mock-cdp-client.js';
import { parseEnvelope } from '../helpers/result-helpers.js';
import { createStatusHandler } from '../../dist/tools/status.js';
import { AppDetachedError } from '../../dist/cdp/discovery.js';
import { recoverDetached, resetDetachedRecoveryCounter } from '../../dist/cdp/recover-detached.js';
import {
  _setHasSessionForTest,
  _resetHasSessionForTest,
} from '../../dist/tools/dev-client-picker.js';

function makeStatusProbe() {
  return JSON.stringify({ appInfo: { __DEV__: true }, errorCount: 0, fiberTree: true, hasRedBox: false, helpersLoaded: true });
}

// F1
test('RC1 honors an explicit platform during a storm: tears down + autoConnect, not softReconnect', async () => {
  _setHasSessionForTest(false);
  const events = [];
  const client = createMockClient({
    _isConnected: false,
    _helpersInjected: true,
    reconnectState: { active: true, lastAttempt: null, attemptCount: 5 },
    disconnect: async () => { events.push('disconnect'); client._isConnected = false; },
    autoConnect: async () => { events.push('autoConnect'); client._isConnected = true; client._helpersInjected = true; return 'connected'; },
    softReconnect: async () => { events.push('softReconnect'); client._isConnected = true; return 'reconnected'; },
    evaluate: async () => ({ value: makeStatusProbe() }),
  });
  try {
    const handler = createStatusHandler(() => client, () => {}, () => client);
    parseEnvelope(await handler({ platform: 'ios' }));
    assert.ok(!events.includes('softReconnect'), 'must NOT softReconnect when a platform is explicitly pinned during a storm');
    assert.ok(events.includes('autoConnect'), 'must autoConnect (after teardown) to honor the pinned platform');
  } finally { _resetHasSessionForTest(); }
});

// F2
test('AppDetachedError does NOT auto-relaunch when the caller pinned a non-iOS platform', async () => {
  _setHasSessionForTest(false);
  let recoverCalled = 0;
  const client = createMockClient({
    _isConnected: false,
    _helpersInjected: true,
    reconnectState: { active: false, lastAttempt: null, attemptCount: 0 },
    autoConnect: async () => { throw new AppDetachedError(8081); },
  });
  try {
    const handler = createStatusHandler(() => client, () => {}, () => client, {
      recoverDetached: async () => { recoverCalled++; return { recovered: true, reason: 'recovered', attempt: 1 }; },
    });
    const env = parseEnvelope(await handler({ platform: 'android' }));
    assert.equal(recoverCalled, 0, 'must NOT cold-restart the iOS session when android was requested');
    assert.equal(env.ok, false);
    assert.equal(env.code, 'APP_DETACHED');
    assert.match(env.error, /iOS-only|device/i, 'should explain auto-relaunch is iOS-only');
  } finally { _resetHasSessionForTest(); }
});

// F3
test('recoverDetached surfaces a simctl launch error instead of hiding it behind still-detached', async () => {
  resetDetachedRecoveryCounter();
  const r = await recoverDetached({}, {
    getSession: () => ({ deviceId: 'U', appId: 'a', platform: 'ios' }),
    isFlowActive: () => false,
    isOptedOut: () => false,
    stopFastRunner: () => {},
    relaunchApp: async () => { throw new Error('Invalid device: bad UDID'); },
    reconnect: async () => {},
    probeAlive: async () => false,
    sleep: async () => {},
  });
  assert.equal(r.recovered, false);
  assert.equal(r.reason, 'still-detached');
  assert.match(r.error ?? '', /bad UDID/, 'the launch error must be surfaced on the result');
});

// F4
test('recovery-success path returns a result (not a throw) when buildStatusResult fails', async () => {
  _setHasSessionForTest(false);
  const client = createMockClient({
    _isConnected: false,
    _helpersInjected: true,
    reconnectState: { active: false, lastAttempt: null, attemptCount: 0 },
    autoConnect: async () => { throw new AppDetachedError(8081); },
    evaluate: async () => { throw new Error('evaluate exploded post-reconnect'); },
  });
  try {
    const handler = createStatusHandler(() => client, () => {}, () => client, {
      recoverDetached: async (c) => { c._isConnected = true; c._helpersInjected = true; return { recovered: true, reason: 'recovered', attempt: 1 }; },
    });
    const env = parseEnvelope(await handler({}));
    assert.equal(env.ok, true, 'must return a degraded ok/warn result, not throw out of the catch');
    assert.match(env.meta.warning, /auto-relaunch|retry/i);
  } finally { _resetHasSessionForTest(); }
});
