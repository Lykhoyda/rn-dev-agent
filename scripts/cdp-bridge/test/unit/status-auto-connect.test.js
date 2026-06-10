import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockClient } from '../helpers/mock-cdp-client.js';
import { expectOk } from '../helpers/result-helpers.js';
import { createStatusHandler } from '../../dist/tools/status.js';

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
  const handler = createStatusHandler(() => client, () => {}, () => client);
  const result = await handler({});
  const data = expectOk(result);
  assert.deepEqual(data.autoConnect, { enabled: false, source: 'env' });
});
