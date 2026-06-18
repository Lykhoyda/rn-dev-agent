import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockClient } from '../helpers/mock-cdp-client.js';
import { parseEnvelope, expectOk, expectFail, expectWarn } from '../helpers/result-helpers.js';

import { createEvaluateHandler } from '../../dist/tools/evaluate.js';
import { createComponentTreeHandler } from '../../dist/tools/component-tree.js';
import { createConsoleLogHandler } from '../../dist/tools/console-log.js';
import { createStoreStateHandler } from '../../dist/tools/store-state.js';
import { createNavigationStateHandler } from '../../dist/tools/navigation-state.js';
import { createErrorLogHandler } from '../../dist/tools/error-log.js';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// cdp_evaluate
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

test('evaluate: returns value on success', async () => {
  const client = createMockClient({
    evaluate: async () => ({ value: 42 }),
  });
  const handler = createEvaluateHandler(() => client);
  const data = expectOk(await handler({ expression: '1+1', awaitPromise: false }));
  assert.deepEqual(data, { value: 42 });
});

test('evaluate: returns failResult on evaluation error', async () => {
  const client = createMockClient({
    evaluate: async () => ({ error: 'ReferenceError: x is not defined' }),
  });
  const handler = createEvaluateHandler(() => client);
  const error = expectFail(await handler({ expression: 'x', awaitPromise: false }));
  assert.match(error, /ReferenceError/);
});

test('evaluate: passes awaitPromise to client.evaluate', async () => {
  let receivedAwait;
  const client = createMockClient({
    evaluate: async (_expr, awaitPromise) => {
      receivedAwait = awaitPromise;
      return { value: 'resolved' };
    },
  });
  const handler = createEvaluateHandler(() => client);
  await handler({ expression: 'fetch()', awaitPromise: true });
  assert.equal(receivedAwait, true);
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// cdp_component_tree
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

test('component_tree: returns parsed tree on success', async () => {
  const tree = { root: { type: 'View', children: [] }, nodeCount: 1 };
  const client = createMockClient({
    evaluate: async () => ({ value: JSON.stringify(tree) }),
  });
  const handler = createComponentTreeHandler(() => client);
  const data = expectOk(await handler({ depth: 3 }));
  assert.deepEqual(data.root, tree.root);
});

test('component_tree: clamps depth to [1, 12]', async () => {
  let capturedExpr;
  const client = createMockClient({
    evaluate: async (expr) => {
      capturedExpr = expr;
      return { value: JSON.stringify({ root: null }) };
    },
  });
  const handler = createComponentTreeHandler(() => client);

  await handler({ depth: 0 });
  assert.match(capturedExpr, /"maxDepth":1/);

  await handler({ depth: 99 });
  assert.match(capturedExpr, /"maxDepth":12/);
});

test('component_tree: returns failResult on evaluate error', async () => {
  const client = createMockClient({
    evaluate: async () => ({ error: 'Timeout' }),
  });
  const handler = createComponentTreeHandler(() => client);
  const error = expectFail(await handler({ depth: 3 }));
  assert.match(error, /Timeout/);
});

test('component_tree: returns warnResult for APP_HAS_REDBOX', async () => {
  const client = createMockClient({
    evaluate: async () => ({
      value: JSON.stringify({ warning: 'APP_HAS_REDBOX', message: 'Error on screen' }),
    }),
  });
  const handler = createComponentTreeHandler(() => client);
  const result = await handler({ depth: 3 });
  const { warning } = expectWarn(result);
  assert.equal(warning, 'APP_HAS_REDBOX');
});

test('component_tree: returns failResult when response is not a string', async () => {
  const client = createMockClient({
    evaluate: async () => ({ value: 42 }),
  });
  const handler = createComponentTreeHandler(() => client);
  const error = expectFail(await handler({ depth: 3 }));
  assert.match(error, /expected JSON string/);
});

test('component_tree: returns failResult for invalid JSON', async () => {
  const client = createMockClient({
    evaluate: async () => ({ value: 'not{json' }),
  });
  const handler = createComponentTreeHandler(() => client);
  const error = expectFail(await handler({ depth: 3 }));
  assert.match(error, /Failed to parse/);
});

test('component_tree: passes filter when provided', async () => {
  let capturedExpr;
  const client = createMockClient({
    evaluate: async (expr) => {
      capturedExpr = expr;
      return { value: JSON.stringify({ root: null }) };
    },
  });
  const handler = createComponentTreeHandler(() => client);
  await handler({ depth: 3, filter: 'submit-btn' });
  assert.match(capturedExpr, /"filter":"submit-btn"/);
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// cdp_console_log
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

test('console_log: returns entries on success (array format)', async () => {
  const entries = [{ level: 'log', text: 'hello' }];
  const client = createMockClient({
    evaluate: async () => ({ value: JSON.stringify(entries) }),
  });
  const handler = createConsoleLogHandler(() => client);
  const data = expectOk(await handler({ level: 'all', limit: 50, clear: false }));
  assert.equal(data.count, 1);
  assert.deepEqual(data.entries, entries);
});

test('console_log: returns entries on success ({ entries } format)', async () => {
  const entries = [{ level: 'error', text: 'fail' }];
  const client = createMockClient({
    evaluate: async () => ({ value: JSON.stringify({ entries }) }),
  });
  const handler = createConsoleLogHandler(() => client);
  const data = expectOk(await handler({ level: 'all', limit: 50, clear: false }));
  assert.equal(data.count, 1);
});

test('console_log: clear mode returns { cleared: true }', async () => {
  const client = createMockClient({
    evaluate: async () => ({ value: undefined }),
  });
  const handler = createConsoleLogHandler(() => client);
  const data = expectOk(await handler({ level: 'all', limit: 50, clear: true }));
  assert.equal(data.cleared, true);
});

test('console_log: clamps limit to [1, 200]', async () => {
  let capturedExpr;
  const client = createMockClient({
    evaluate: async (expr) => {
      capturedExpr = expr;
      return { value: JSON.stringify([]) };
    },
  });
  const handler = createConsoleLogHandler(() => client);
  await handler({ level: 'all', limit: 999, clear: false });
  assert.match(capturedExpr, /"limit":200/);
});

test('console_log: returns failResult on evaluate error', async () => {
  const client = createMockClient({
    evaluate: async () => ({ error: 'timeout' }),
  });
  const handler = createConsoleLogHandler(() => client);
  const error = expectFail(await handler({ level: 'all', limit: 50, clear: false }));
  assert.match(error, /timeout/);
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// cdp_store_state
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

test('store_state: returns parsed state on success', async () => {
  const state = { user: { name: 'Alice' } };
  const client = createMockClient({
    evaluate: async () => ({ value: JSON.stringify(state) }),
  });
  const handler = createStoreStateHandler(() => client);
  const data = expectOk(await handler({}));
  assert.deepEqual(data, state);
});

test('store_state: handles __agent_truncated response', async () => {
  const client = createMockClient({
    evaluate: async () => ({
      value: JSON.stringify({ __agent_truncated: true, originalLength: 50000 }),
    }),
  });
  const handler = createStoreStateHandler(() => client);
  const result = await handler({});
  const env = parseEnvelope(result);
  assert.equal(env.ok, true);
  assert.equal(env.truncated, true);
});

test('store_state: handles __agent_error response', async () => {
  const client = createMockClient({
    evaluate: async () => ({
      value: JSON.stringify({ __agent_error: 'No stores found', hint: 'Add __ZUSTAND_STORES__' }),
    }),
  });
  const handler = createStoreStateHandler(() => client);
  const error = expectFail(await handler({}));
  assert.match(error, /No stores found/);
});

test('store_state: passes path and storeType to expression', async () => {
  let capturedExpr;
  const client = createMockClient({
    evaluate: async (expr) => {
      capturedExpr = expr;
      return { value: JSON.stringify({ count: 0 }) };
    },
  });
  const handler = createStoreStateHandler(() => client);
  await handler({ path: 'user.name', storeType: 'zustand' });
  assert.match(capturedExpr, /getStoreState\("user\.name",\s*"zustand"\)/);
});

test('store_state: returns { raw } for unparseable string', async () => {
  const client = createMockClient({
    evaluate: async () => ({ value: 'not-json' }),
  });
  const handler = createStoreStateHandler(() => client);
  const data = expectOk(await handler({}));
  assert.deepEqual(data, { raw: 'not-json' });
});

test('store_state: passes storeType jotai to expression', async () => {
  let capturedExpr;
  const client = createMockClient({
    evaluate: async (expr) => {
      capturedExpr = expr;
      return { value: JSON.stringify({ type: 'jotai', state: { count: 0 } }) };
    },
  });
  const handler = createStoreStateHandler(() => client);
  await handler({ storeType: 'jotai' });
  assert.match(capturedExpr, /getStoreState\(undefined,\s*"jotai"\)/);
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// cdp_navigation_state
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

test('navigation_state: returns parsed navigation state', async () => {
  const navState = { currentRoute: 'HomeScreen', index: 0, routes: [{ name: 'HomeScreen' }] };
  const client = createMockClient({
    evaluate: async () => ({ value: JSON.stringify(navState) }),
  });
  const handler = createNavigationStateHandler(() => client);
  const data = expectOk(await handler({}));
  assert.equal(data.currentRoute, 'HomeScreen');
});

test('navigation_state: returns failResult on error response', async () => {
  const client = createMockClient({
    evaluate: async () => ({
      value: JSON.stringify({ error: 'No navigation container found' }),
    }),
  });
  const handler = createNavigationStateHandler(() => client);
  const error = expectFail(await handler({}));
  assert.match(error, /No navigation container/);
});

test('navigation_state: returns failResult when response is not a string', async () => {
  const client = createMockClient({
    evaluate: async () => ({ value: 42 }),
  });
  const handler = createNavigationStateHandler(() => client);
  const error = expectFail(await handler({}));
  assert.match(error, /expected JSON string/);
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// cdp_error_log
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

test('error_log: returns error entries', async () => {
  const errors = [{ message: 'TypeError', stack: 'at foo:1', timestamp: '2026-04-13T00:00:00Z' }];
  const client = createMockClient({
    evaluate: async () => ({ value: JSON.stringify(errors) }),
  });
  const handler = createErrorLogHandler(() => client);
  const data = expectOk(await handler({ clear: false }));
  assert.equal(data.count, 1);
  assert.equal(data.errors[0].message, 'TypeError');
});

test('error_log: returns hint when no errors', async () => {
  const client = createMockClient({
    evaluate: async () => ({ value: JSON.stringify([]) }),
  });
  const handler = createErrorLogHandler(() => client);
  const result = await handler({ clear: false });
  const env = parseEnvelope(result);
  assert.equal(env.ok, true);
  assert.equal(env.data.count, 0);
  assert.match(env.meta.hint, /No JS errors/);
});

test('error_log: clear mode clears and returns { cleared: true }', async () => {
  const client = createMockClient({
    evaluate: async () => ({ value: undefined }),
  });
  const handler = createErrorLogHandler(() => client);
  const data = expectOk(await handler({ clear: true }));
  assert.equal(data.cleared, true);
});
