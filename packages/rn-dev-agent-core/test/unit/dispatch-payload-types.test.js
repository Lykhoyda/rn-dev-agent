// B139: cdp_dispatch must preserve payload types across the LLM↔MCP JSON-RPC
// boundary. The fix adds an optional `payloadJson` field that, when set, is
// parsed to a JS value with the original JSON types intact and used as the
// dispatch payload. Without `payloadJson`, the LLM's JSON encoder may coerce
// numeric-looking strings to numbers (e.g. "42" → 42), which silently breaks
// Redux actions that type-check their payload.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDispatchHandler } from '../../dist/tools/dispatch.js';
import { createMockClient } from '../helpers/mock-cdp-client.js';
import { parseEnvelope } from '../helpers/result-helpers.js';

function invoke(args) {
  const capture = { expressionSeen: null };
  const client = createMockClient({
    evaluate: async (expr) => {
      // Let probeFreshness's typeof __RN_AGENT probe return a number; capture
      // only the real dispatch call (identified by dispatchAction substring).
      if (typeof expr === 'string' && expr.includes('dispatchAction(')) {
        capture.expressionSeen = expr;
        return { value: JSON.stringify({ ok: true }) };
      }
      return { value: 13 };
    },
  });
  const handler = createDispatchHandler(() => client);
  return handler(args).then((result) => ({ result, captured: capture }));
}

test('B139: payloadJson "42" dispatches the STRING "42" (types preserved)', async () => {
  const { captured } = await invoke({ action: 'tasks/setDescription', payloadJson: '"42"' });
  assert.match(captured.expressionSeen, /"payload":"42"/);
});

test('B139: payloadJson 42 dispatches the NUMBER 42', async () => {
  const { captured } = await invoke({ action: 'counter/set', payloadJson: '42' });
  assert.match(captured.expressionSeen, /"payload":42[^"]/);
});

test('B139: payloadJson object round-trips through JSON.parse + JSON.stringify', async () => {
  const { captured } = await invoke({ action: 'cart/addItem', payloadJson: '{"id":"7","qty":3}' });
  assert.match(captured.expressionSeen, /"payload":\{"id":"7","qty":3\}/);
});

test('B139: payloadJson array preserves element types', async () => {
  const { captured } = await invoke({ action: 'tags/set', payloadJson: '["42","hello"]' });
  assert.match(captured.expressionSeen, /"payload":\["42","hello"\]/);
});

test('B139: payloadJson boolean preserved', async () => {
  const { captured } = await invoke({ action: 'flags/enable', payloadJson: 'true' });
  assert.match(captured.expressionSeen, /"payload":true/);
});

test('B139: payloadJson null preserved', async () => {
  const { captured } = await invoke({ action: 'session/clear', payloadJson: 'null' });
  assert.match(captured.expressionSeen, /"payload":null/);
});

test('B139: invalid payloadJson returns failResult', async () => {
  const { result } = await invoke({ action: 'anything', payloadJson: 'not-json' });
  const env = parseEnvelope(result);
  assert.equal(env.ok, false);
  assert.match(env.error, /Invalid payloadJson/);
});

test('B139: plain `payload` still works when payloadJson omitted (backward compat)', async () => {
  const { captured } = await invoke({ action: 'items/add', payload: { sku: 'abc' } });
  assert.match(captured.expressionSeen, /"payload":\{"sku":"abc"\}/);
});

test('B139: payloadJson takes precedence over payload when both set', async () => {
  const { captured } = await invoke({
    action: 'value/set',
    payload: 999,
    payloadJson: '"999"',
  });
  // payloadJson parses to string "999"; that wins.
  assert.match(captured.expressionSeen, /"payload":"999"/);
});

test('B139: dispatch without any payload omits the key (JSON.stringify drops undefined)', async () => {
  const { captured } = await invoke({ action: 'noop' });
  // With both payload and payloadJson omitted, the key is dropped by JSON.stringify.
  assert.ok(captured.expressionSeen.includes('"action":"noop"'));
  assert.ok(!captured.expressionSeen.includes('"payload"'));
});

test('B139: readPath propagates through to helperExpr', async () => {
  const { captured } = await invoke({ action: 'x', payloadJson: '{}', readPath: 'a.b.c' });
  assert.match(captured.expressionSeen, /"readPath":"a\.b\.c"/);
});
