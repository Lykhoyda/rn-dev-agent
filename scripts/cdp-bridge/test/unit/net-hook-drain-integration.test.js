import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockClient } from '../helpers/mock-cdp-client.js';
import { expectOk } from '../helpers/result-helpers.js';
import { createNetworkLogHandler } from '../../dist/tools/network-log.js';
import { createWaitForNetworkHandler } from '../../dist/tools/wait-for-network.js';

// Spec 2026-06-10-debugger-seat-optout Part 2: the network-reading tools
// drain the in-app hook buffer before serving reads, so hook-mode entries
// flow without any console transport.

const BUF = [
  { t: 'request', d: { id: 'q1', method: 'POST', url: '/api/v1/auth/otp' } },
  { t: 'response', d: { id: 'q1', status: 200, duration_ms: 758 } },
];

// Note: createMockClient exposes networkMode via a getter on _networkMode,
// and evaluate is a direct method overridable via the overrides spread.
// Use _networkMode: 'hook' (not networkMode: 'hook') for the mode seam.
function hookClient(extra = {}) {
  let drained = false;
  const client = createMockClient({
    _isConnected: true,
    _helpersInjected: true,
    _networkMode: 'hook',
    evaluate: async (expr) => {
      if (expr.includes('__RN_AGENT_NET_BUF__')) {
        const payload = drained ? [] : BUF;
        drained = true;
        return { value: JSON.stringify(payload) };
      }
      return { value: 'null' };
    },
    ...extra,
  });
  return client;
}

test('cdp_network_log: hook mode drains the in-app buffer before reading', async () => {
  const client = hookClient();
  const handler = createNetworkLogHandler(() => client);
  const data = expectOk(await handler({ limit: 20, clear: false }));
  assert.equal(data.count, 1);
  assert.equal(data.requests[0].id, 'q1');
  assert.equal(data.requests[0].status, 200);
});

test('cdp_network_log: cdp mode does not evaluate a drain', async () => {
  let drainEvaluated = 0;
  const client = hookClient({
    _networkMode: 'cdp',
    // withConnection's freshness probe also calls evaluate (for __RN_AGENT.__v).
    // Only count the drain-specific evaluate (the one reading __RN_AGENT_NET_BUF__).
    evaluate: async (expr) => {
      if (expr.includes('__RN_AGENT_NET_BUF__')) drainEvaluated++;
      return { value: 13 };
    },
  });
  const handler = createNetworkLogHandler(() => client);
  expectOk(await handler({ limit: 20, clear: false }));
  assert.equal(drainEvaluated, 0);
});

test('cdp_network_log: clear also empties freshly drained entries', async () => {
  const client = hookClient();
  const handler = createNetworkLogHandler(() => client);
  expectOk(await handler({ limit: 20, clear: true }));
  const data = expectOk(await handler({ limit: 20, clear: false }));
  assert.equal(data.count, 0, 'in-app entries drained during clear must be cleared too');
});

test('cdp_wait_for_network: retroactive match against drained entries', async () => {
  const client = hookClient();
  const handler = createWaitForNetworkHandler(() => client);
  const data = expectOk(await handler({
    url_pattern: '/auth/otp',
    timeout_ms: 500,
    since: '2000-01-01T00:00:00.000Z',
  }));
  assert.equal(data.matched, true);
  assert.equal(data.mutation.id, 'q1');
});
