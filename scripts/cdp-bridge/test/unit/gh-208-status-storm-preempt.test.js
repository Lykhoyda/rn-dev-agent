// GH #208 (RC1): during an in-flight reconnect storm, cdp_status must NOT call
// bare autoConnect — its guard throws "Already connecting to Metro..." which
// dead-ends the one tool meant to diagnose+recover. Instead it preempts the
// storm via softReconnect (the existing 3s softReconnectRequested handshake),
// getting one fresh, real connection attempt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockClient } from '../helpers/mock-cdp-client.js';
import { expectOk } from '../helpers/result-helpers.js';
import { createStatusHandler } from '../../dist/tools/status.js';
import {
  _setHasSessionForTest,
  _resetHasSessionForTest,
} from '../../dist/tools/dev-client-picker.js';

function makeStatusProbe(extraAppInfo = {}) {
  return JSON.stringify({
    appInfo: { __DEV__: true, ...extraAppInfo },
    errorCount: 0,
    fiberTree: true,
    hasRedBox: false,
    helpersLoaded: true,
  });
}

test('cdp_status preempts an active reconnect storm via softReconnect, not bare autoConnect', async () => {
  _setHasSessionForTest(false); // keep the dev-client picker out of the path
  const events = [];
  const client = createMockClient({
    _isConnected: false,
    _helpersInjected: true,
    reconnectState: { active: true, lastAttempt: '2026-06-07T00:00:00.000Z', attemptCount: 12 },
    autoConnect: async () => {
      events.push('autoConnect');
      client._isConnected = true;
      client._helpersInjected = true;
      return 'connected';
    },
    softReconnect: async () => {
      events.push('softReconnect');
      client._isConnected = true;
      client._helpersInjected = true;
      return 'reconnected';
    },
    evaluate: async () => ({ value: makeStatusProbe() }),
  });
  try {
    const handler = createStatusHandler(
      () => client,
      () => {},
      () => client,
    );
    expectOk(await handler({}));
    assert.deepEqual(
      events,
      ['softReconnect'],
      'a reconnect storm must be preempted via softReconnect, never bare autoConnect',
    );
  } finally {
    _resetHasSessionForTest();
  }
});

test('cdp_status uses autoConnect (not softReconnect) when disconnected with no active storm', async () => {
  _setHasSessionForTest(false);
  const events = [];
  const client = createMockClient({
    _isConnected: false,
    _helpersInjected: true,
    reconnectState: { active: false, lastAttempt: null, attemptCount: 0 },
    autoConnect: async () => {
      events.push('autoConnect');
      client._isConnected = true;
      client._helpersInjected = true;
      return 'connected';
    },
    softReconnect: async () => {
      events.push('softReconnect');
      client._isConnected = true;
      client._helpersInjected = true;
      return 'reconnected';
    },
    evaluate: async () => ({ value: makeStatusProbe() }),
  });
  try {
    const handler = createStatusHandler(
      () => client,
      () => {},
      () => client,
    );
    expectOk(await handler({}));
    assert.deepEqual(
      events,
      ['autoConnect'],
      'a normal disconnected status should use autoConnect',
    );
  } finally {
    _resetHasSessionForTest();
  }
});
