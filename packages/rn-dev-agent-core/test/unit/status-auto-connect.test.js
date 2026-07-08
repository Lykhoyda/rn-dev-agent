import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockClient } from '../helpers/mock-cdp-client.js';
import { expectOk } from '../helpers/result-helpers.js';
import { createStatusHandler } from '../../dist/tools/status.js';
import { CDPClient } from '../../dist/cdp-client.js';

// Spec 2026-06-10-debugger-seat-optout: cdp_status must surface the resolved
// autoConnect mode + its source so users/doctor can see why the bridge does
// (or does not) fight for the debugger seat.

function makeStatusProbe(extraAppInfo = {}) {
  return JSON.stringify({
    appInfo: { __DEV__: true, ...extraAppInfo },
    errorCount: 0,
    fiberTree: true,
    hasRedBox: false,
    helpersLoaded: true,
  });
}

test('cdp_status: payload includes autoConnect resolution', async () => {
  const client = createMockClient({
    _isConnected: true,
    _helpersInjected: true,
    autoConnectState: { enabled: false, source: 'env' },
    evaluate: async () => ({ value: makeStatusProbe() }),
  });
  const handler = createStatusHandler(
    () => client,
    () => {},
    () => client,
  );
  const result = await handler({});
  const data = expectOk(result);
  assert.deepEqual(data.autoConnect, { enabled: false, source: 'env' });
});

test('CDPClient.autoConnectState: resolved once, stable across env flips', () => {
  const prev = process.env.RN_CDP_AUTOCONNECT;
  process.env.RN_CDP_AUTOCONNECT = '0';
  try {
    const client = new CDPClient();
    assert.deepEqual(client.autoConnectState, { enabled: false, source: 'env' });
    process.env.RN_CDP_AUTOCONNECT = '1';
    assert.deepEqual(
      client.autoConnectState,
      { enabled: false, source: 'env' },
      'resolution must be cached, not re-read',
    );
  } finally {
    if (prev === undefined) delete process.env.RN_CDP_AUTOCONNECT;
    else process.env.RN_CDP_AUTOCONNECT = prev;
  }
});
