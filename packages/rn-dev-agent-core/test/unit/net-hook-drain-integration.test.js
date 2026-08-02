import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockClient } from '../helpers/mock-cdp-client.js';
import { expectOk } from '../helpers/result-helpers.js';
import { createNetworkLogHandler } from '../../dist/tools/network-log.js';
import { createWaitForNetworkHandler } from '../../dist/tools/wait-for-network.js';
import { createNetworkBodyHandler } from '../../dist/tools/network-body.js';

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
  const data = expectOk(
    await handler({
      url_pattern: '/auth/otp',
      timeout_ms: 500,
      since: '2000-01-01T00:00:00.000Z',
    }),
  );
  assert.equal(data.matched, true);
  assert.equal(data.mutation.id, 'q1');
});

test('cdp_network_body: hook branch drains buffer before body-cache lookup, returns body with entry metadata', async () => {
  // Track evaluation order to assert drain-before-body-cache-lookup.
  const callOrder = [];
  // BUF contains a request+response pair for 'hook-req1'. The drain evaluate
  // returns BUF on the first call then [] (empty) — same pattern as hookClient().
  let bufDrained = false;
  const client = createMockClient({
    _isConnected: true,
    _helpersInjected: true,
    _networkMode: 'hook',
    evaluate: async (expr) => {
      if (expr.includes('__RN_AGENT_NET_BUF__')) {
        callOrder.push('drain');
        const payload = bufDrained ? [] : BUF;
        bufDrained = true;
        return { value: JSON.stringify(payload) };
      }
      // D502 freshness probe (__RN_AGENT.__v) — return a version number
      return { value: 13 };
    },
    send: async (method, params) => {
      if (method === 'Runtime.evaluate') {
        return { result: { objectId: 'body-cache' } };
      }
      if (method === 'Runtime.callFunctionOn') {
        callOrder.push('body-cache');
        assert.deepEqual(params.arguments, [{ value: 'q1' }]);
        return { result: { value: JSON.stringify({ body: '{"token":"abc"}' }) } };
      }
      return {};
    },
  });

  // Phase 1: seed the network buffer via a network-log drain so getByKey
  // (called at the top of createNetworkBodyHandler, before the hook block)
  // can resolve the entry's url/status metadata.
  const logHandler = createNetworkLogHandler(() => client);
  expectOk(await logHandler({ limit: 20, clear: false }));

  // Phase 2: reset tracking, then call the body handler.
  callOrder.length = 0;
  bufDrained = true; // buffer already drained; second drain returns []
  const bodyHandler = createNetworkBodyHandler(() => client);
  const data = expectOk(await bodyHandler({ requestId: 'q1' }));

  // Body and metadata assertions.
  assert.equal(data.source, 'hook');
  assert.equal(data.requestId, 'q1');
  assert.equal(data.body, '{"token":"abc"}');
  // url and status come from the buffer entry populated by the phase-1 drain —
  // proving that the entry metadata was resolved from the drained buffer.
  assert.equal(data.url, '/api/v1/auth/otp');
  assert.equal(data.status, 200);

  // Drain ran before body-cache lookup within the body handler call.
  const drainIdx = callOrder.indexOf('drain');
  const bodyIdx = callOrder.indexOf('body-cache');
  assert.ok(drainIdx !== -1, 'drain evaluate should have been called');
  assert.ok(bodyIdx !== -1, 'body-cache evaluate should have been called');
  assert.ok(drainIdx < bodyIdx, 'drain must run before body-cache lookup');
});
