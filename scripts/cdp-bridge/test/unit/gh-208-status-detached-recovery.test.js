// GH #208 (RC2+RC3 wiring): when connect throws AppDetachedError (Metro up, 0
// Hermes targets), cdp_status routes into the bounded auto-relaunch recovery.
// On success it returns a fresh status (warn); on refusal it returns a legible
// APP_DETACHED failure carrying the reconnect attempt count + an escape hatch —
// never a misleading "Metro not found".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockClient } from '../helpers/mock-cdp-client.js';
import { parseEnvelope } from '../helpers/result-helpers.js';
import { createStatusHandler } from '../../dist/tools/status.js';
import { AppDetachedError } from '../../dist/cdp/discovery.js';
import {
  _setHasSessionForTest,
  _resetHasSessionForTest,
} from '../../dist/tools/dev-client-picker.js';

function makeStatusProbe() {
  return JSON.stringify({
    appInfo: { __DEV__: true },
    errorCount: 0,
    fiberTree: true,
    hasRedBox: false,
    helpersLoaded: true,
  });
}

test('cdp_status: AppDetachedError → auto-relaunch recovers → fresh status (warn)', async () => {
  _setHasSessionForTest(false);
  const client = createMockClient({
    _isConnected: false,
    _helpersInjected: true,
    reconnectState: { active: false, lastAttempt: null, attemptCount: 0 },
    autoConnect: async () => {
      throw new AppDetachedError(8081);
    },
    evaluate: async () => ({ value: makeStatusProbe() }),
  });
  try {
    const handler = createStatusHandler(
      () => client,
      () => {},
      () => client,
      {
        recoverDetached: async (c) => {
          c._isConnected = true;
          c._helpersInjected = true;
          return { recovered: true, reason: 'recovered', attempt: 1 };
        },
      },
    );
    const env = parseEnvelope(await handler({}));
    assert.equal(env.ok, true, 'recovered detach should be a successful (warn) status');
    assert.match(env.meta.warning, /auto-relaunched|detached/i);
  } finally {
    _resetHasSessionForTest();
  }
});

test('cdp_status: AppDetachedError → recovery refused (opted-out) → legible APP_DETACHED failure with reconnect context', async () => {
  _setHasSessionForTest(false);
  const client = createMockClient({
    _isConnected: false,
    _helpersInjected: true,
    reconnectState: { active: true, lastAttempt: '2026-06-07T00:00:00.000Z', attemptCount: 7 },
    // active storm → cdp_status uses softReconnect (RC1); it throws the detached error.
    softReconnect: async () => {
      throw new AppDetachedError(8081);
    },
  });
  try {
    const handler = createStatusHandler(
      () => client,
      () => {},
      () => client,
      {
        recoverDetached: async () => ({ recovered: false, reason: 'opted-out', attempt: 0 }),
      },
    );
    const env = parseEnvelope(await handler({}));
    assert.equal(env.ok, false);
    assert.equal(env.code, 'APP_DETACHED');
    assert.match(env.error, /0 Hermes|detached/i, 'must explain the real cause');
    assert.match(
      env.error,
      /RN_AUTO_RELAUNCH_ON_DETACH|manually|cdp_restart/i,
      'must offer an escape hatch',
    );
    assert.equal(
      env.meta.reconnect.attemptCount,
      7,
      'must surface the reconnect attempt count for legibility',
    );
  } finally {
    _resetHasSessionForTest();
  }
});
