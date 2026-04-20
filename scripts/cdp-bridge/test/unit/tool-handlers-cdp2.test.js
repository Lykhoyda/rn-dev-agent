import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockClient } from '../helpers/mock-cdp-client.js';
import { expectOk, expectFail, expectWarn, parseEnvelope } from '../helpers/result-helpers.js';

import { createInteractHandler } from '../../dist/tools/interact.js';
import { createNetworkLogHandler } from '../../dist/tools/network-log.js';
import { createNetworkBodyHandler } from '../../dist/tools/network-body.js';
import { createDispatchHandler } from '../../dist/tools/dispatch.js';
import { createDevSettingsHandler } from '../../dist/tools/dev-settings.js';
import { createHeapUsageHandler, createCpuProfileHandler } from '../../dist/tools/profiling.js';
import { createObjectInspectHandler } from '../../dist/tools/object-inspect.js';
import { createExceptionBreakpointHandler } from '../../dist/tools/exception-breakpoint.js';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// cdp_interact
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

test('interact: success press by testID', async () => {
  const client = createMockClient({
    evaluate: async () => ({ value: JSON.stringify({ action_executed: 'press', testID: 'btn' }) }),
  });
  const handler = createInteractHandler(() => client);
  const data = expectOk(await handler({ action: 'press', testID: 'btn', animated: false }));
  assert.equal(data.action_executed, 'press');
});

test('interact: fails when neither testID nor accessibilityLabel provided', async () => {
  const client = createMockClient();
  const handler = createInteractHandler(() => client);
  const error = expectFail(await handler({ action: 'press', animated: false }));
  assert.match(error, /testID or accessibilityLabel/);
});

test('interact: fails when typeText action missing text param', async () => {
  const client = createMockClient();
  const handler = createInteractHandler(() => client);
  const error = expectFail(await handler({ action: 'typeText', testID: 'input', animated: false }));
  assert.match(error, /text parameter is required/);
});

test('interact: returns failResult on evaluate error', async () => {
  const client = createMockClient({
    evaluate: async () => ({ error: 'Runtime error' }),
  });
  const handler = createInteractHandler(() => client);
  const error = expectFail(await handler({ action: 'press', testID: 'btn', animated: false }));
  assert.match(error, /Runtime error/);
});

test('interact: returns failResult when parsed response has error', async () => {
  const client = createMockClient({
    evaluate: async () => ({ value: JSON.stringify({ error: 'Element not found', hint: 'Check testID' }) }),
  });
  const handler = createInteractHandler(() => client);
  const error = expectFail(await handler({ action: 'press', testID: 'missing-btn', animated: false }));
  assert.match(error, /Element not found/);
});

test('interact: returns warnResult when action_executed with handler_error', async () => {
  const client = createMockClient({
    evaluate: async () => ({
      value: JSON.stringify({ action_executed: 'press', handler_error: 'onPress threw an error' }),
    }),
  });
  const handler = createInteractHandler(() => client);
  const { warning } = expectWarn(await handler({ action: 'press', testID: 'btn', animated: false }));
  assert.match(warning, /handler threw/);
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// cdp_network_log
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

test('network_log: returns entries from buffer', async () => {
  const client = createMockClient();
  client.networkBufferManager.push(client.activeDeviceKey,{ id: 'req1', method: 'GET', url: 'https://api.example.com/users', timestamp: '2026-04-13T00:00:00Z', status: 200 });
  client.networkBufferManager.push(client.activeDeviceKey,{ id: 'req2', method: 'POST', url: 'https://api.example.com/login', timestamp: '2026-04-13T00:00:01Z', status: 401 });
  const handler = createNetworkLogHandler(() => client);
  const data = expectOk(await handler({ limit: 10, clear: false }));
  assert.equal(data.count, 2);
  assert.equal(data.requests.length, 2);
});

test('network_log: filters entries by URL substring', async () => {
  const client = createMockClient();
  client.networkBufferManager.push(client.activeDeviceKey,{ id: 'req1', method: 'GET', url: 'https://api.example.com/users', timestamp: '2026-04-13T00:00:00Z', status: 200 });
  client.networkBufferManager.push(client.activeDeviceKey,{ id: 'req2', method: 'GET', url: 'https://cdn.example.com/image.png', timestamp: '2026-04-13T00:00:01Z', status: 200 });
  const handler = createNetworkLogHandler(() => client);
  const data = expectOk(await handler({ limit: 10, filter: 'api.example', clear: false }));
  assert.equal(data.count, 1);
  assert.equal(data.requests[0].id, 'req1');
});

test('network_log: clear mode empties buffer', async () => {
  const client = createMockClient();
  client.networkBufferManager.push(client.activeDeviceKey,{ id: 'req1', method: 'GET', url: 'https://api.example.com/users', timestamp: '2026-04-13T00:00:00Z', status: 200 });
  const handler = createNetworkLogHandler(() => client);
  const data = expectOk(await handler({ limit: 10, clear: true }));
  assert.equal(data.cleared, true);
  const afterData = expectOk(await handler({ limit: 10, clear: false }));
  assert.equal(afterData.count, 0);
});

test('network_log: clamps limit to [1, 100]', async () => {
  const client = createMockClient();
  for (let i = 0; i < 5; i++) {
    client.networkBufferManager.push(client.activeDeviceKey,{ id: `req${i}`, method: 'GET', url: `https://api.example.com/${i}`, timestamp: '2026-04-13T00:00:00Z', status: 200 });
  }
  const handler = createNetworkLogHandler(() => client);
  const dataLow = expectOk(await handler({ limit: 0, clear: false }));
  assert.equal(dataLow.requests.length, 1, 'limit:0 should clamp to 1');
  const dataHigh = expectOk(await handler({ limit: 200, clear: false }));
  assert.equal(dataHigh.requests.length, 5, 'limit:200 clamps to 100, but only 5 entries exist');
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// cdp_network_body
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

test('network_body: CDP path success', async () => {
  const client = createMockClient({
    _networkMode: 'cdp',
    send: async (method) => {
      if (method === 'Network.getResponseBody') {
        return { body: '{"users":[]}', base64Encoded: false };
      }
      return {};
    },
  });
  client.networkBufferManager.push(client.activeDeviceKey,{ id: 'req1', method: 'GET', url: 'https://api.example.com/users', timestamp: '2026-04-13T00:00:00Z', status: 200 });
  const handler = createNetworkBodyHandler(() => client);
  const data = expectOk(await handler({ requestId: 'req1' }));
  assert.equal(data.source, 'cdp');
  assert.equal(data.body, '{"users":[]}');
});

test('network_body: CDP path not found in buffer', async () => {
  const client = createMockClient({ _networkMode: 'cdp' });
  const handler = createNetworkBodyHandler(() => client);
  const error = expectFail(await handler({ requestId: 'nonexistent' }));
  assert.match(error, /not found in network buffer/);
});

test('network_body: hook path success', async () => {
  const client = createMockClient({
    _networkMode: 'hook',
    evaluate: async () => ({ value: JSON.stringify({ body: '{"data":"test"}' }) }),
  });
  client.networkBufferManager.push(client.activeDeviceKey,{ id: 'hook-req1', method: 'GET', url: 'https://api.example.com/data', timestamp: '2026-04-13T00:00:00Z', status: 200 });
  const handler = createNetworkBodyHandler(() => client);
  const data = expectOk(await handler({ requestId: 'hook-req1' }));
  assert.equal(data.source, 'hook');
  assert.equal(data.body, '{"data":"test"}');
});

test('network_body: hook path cache miss returns failResult', async () => {
  const client = createMockClient({
    _networkMode: 'hook',
    evaluate: async () => ({ value: JSON.stringify({ error: 'not_found' }) }),
  });
  client.networkBufferManager.push(client.activeDeviceKey,{ id: 'hook-req2', method: 'GET', url: 'https://api.example.com/other', timestamp: '2026-04-13T00:00:00Z', status: 200 });
  const handler = createNetworkBodyHandler(() => client);
  const error = expectFail(await handler({ requestId: 'hook-req2' }));
  assert.match(error, /not in cache/);
});

test('network_body: no network mode returns failResult', async () => {
  const client = createMockClient({ _networkMode: 'none' });
  client.networkBufferManager.push(client.activeDeviceKey,{ id: 'req-none', method: 'GET', url: 'https://api.example.com/test', timestamp: '2026-04-13T00:00:00Z', status: 200 });
  const handler = createNetworkBodyHandler(() => client);
  const error = expectFail(await handler({ requestId: 'req-none' }));
  assert.match(error, /not active/);
});

test('network_body: missing requestId returns failResult', async () => {
  const client = createMockClient();
  const handler = createNetworkBodyHandler(() => client);
  const error = expectFail(await handler({}));
  assert.match(error, /requestId is required/);
});

test('network_body: truncates body when exceeding maxLength', async () => {
  const longBody = 'x'.repeat(20000);
  const client = createMockClient({
    _networkMode: 'cdp',
    send: async (method) => {
      if (method === 'Network.getResponseBody') {
        return { body: longBody, base64Encoded: false };
      }
      return {};
    },
  });
  client.networkBufferManager.push(client.activeDeviceKey,{ id: 'big-req', method: 'GET', url: 'https://api.example.com/big', timestamp: '2026-04-13T00:00:00Z', status: 200 });
  const handler = createNetworkBodyHandler(() => client);
  const result = await handler({ requestId: 'big-req', maxLength: 100 });
  const env = parseEnvelope(result);
  assert.equal(env.ok, true);
  assert.equal(env.truncated, true);
  assert.equal(env.data.body.length, 100);
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// cdp_dispatch
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

test('dispatch: success returns parsed response', async () => {
  const client = createMockClient({
    evaluate: async () => ({ value: JSON.stringify({ dispatched: true, newState: { count: 1 } }) }),
  });
  const handler = createDispatchHandler(() => client);
  const data = expectOk(await handler({ action: 'INCREMENT', payload: { amount: 1 } }));
  assert.equal(data.dispatched, true);
});

test('dispatch: returns failResult on evaluate error', async () => {
  const client = createMockClient({
    evaluate: async () => ({ error: 'Store not found' }),
  });
  const handler = createDispatchHandler(() => client);
  const error = expectFail(await handler({ action: 'INCREMENT' }));
  assert.match(error, /Store not found/);
});

test('dispatch: returns failResult when response contains __agent_error', async () => {
  const client = createMockClient({
    evaluate: async () => ({ value: JSON.stringify({ __agent_error: 'No Redux store detected' }) }),
  });
  const handler = createDispatchHandler(() => client);
  const error = expectFail(await handler({ action: 'SOME_ACTION' }));
  assert.match(error, /No Redux store detected/);
});

test('dispatch: returns { raw } for unparseable response', async () => {
  const client = createMockClient({
    evaluate: async () => ({ value: 'dispatched-ok' }),
  });
  const handler = createDispatchHandler(() => client);
  const data = expectOk(await handler({ action: 'SOME_ACTION' }));
  assert.deepEqual(data, { raw: 'dispatched-ok' });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// cdp_dev_settings
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

test('dev_settings: success toggleInspector returns executed true', async () => {
  const client = createMockClient({
    evaluate: async () => ({ value: 'ok' }),
  });
  const handler = createDevSettingsHandler(() => client);
  const data = expectOk(await handler({ action: 'toggleInspector' }));
  assert.equal(data.executed, true);
  assert.equal(data.action, 'toggleInspector');
});

test('dev_settings: no_method_available returns warnResult', async () => {
  const client = createMockClient({
    evaluate: async () => ({ value: 'no_method_available' }),
  });
  const handler = createDevSettingsHandler(() => client);
  const { warning } = expectWarn(await handler({ action: 'togglePerfMonitor' }));
  assert.match(warning, /not available/);
});

test('dev_settings: reload with WebSocket disconnect returns okResult with note', async () => {
  const client = createMockClient({
    evaluate: async () => { throw new Error('WebSocket closed'); },
  });
  const handler = createDevSettingsHandler(() => client);
  const result = await handler({ action: 'reload' });
  const env = parseEnvelope(result);
  assert.equal(env.ok, true);
  assert.equal(env.data.executed, true);
});

test('dev_settings: evaluate error on non-reload action returns failResult', async () => {
  const client = createMockClient({
    evaluate: async (expr) => {
      if (expr.includes('typeof globalThis.__RN_AGENT')) return { value: 1 };
      if (expr.includes('typeof __DEV__')) return { value: true };
      throw new Error('Unexpected crash');
    },
  });
  const handler = createDevSettingsHandler(() => client);
  const error = expectFail(await handler({ action: 'toggleInspector' }));
  assert.match(error, /Unexpected crash/);
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// cdp_heap_usage
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

test('heap_usage: success returns MB and utilization', async () => {
  const client = createMockClient({
    send: async () => ({ usedSize: 10 * 1024 * 1024, totalSize: 100 * 1024 * 1024 }),
  });
  const handler = createHeapUsageHandler(() => client);
  const data = expectOk(await handler({}));
  assert.equal(data.usedMB, 10);
  assert.equal(data.totalMB, 100);
  assert.equal(data.utilization, 10);
});

test('heap_usage: returns failResult when send throws', async () => {
  const client = createMockClient({
    send: async () => { throw new Error('Runtime not available'); },
  });
  const handler = createHeapUsageHandler(() => client);
  const error = expectFail(await handler({}));
  assert.match(error, /Heap usage unavailable/);
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// cdp_cpu_profile
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

test('cpu_profile: CDP path success with hot functions', async () => {
  const mockProfile = {
    nodes: [
      { callFrame: { functionName: 'renderApp', url: 'App.js', lineNumber: 10 }, hitCount: 42 },
      { callFrame: { functionName: 'processData', url: 'utils.js', lineNumber: 5 }, hitCount: 18 },
      { callFrame: { functionName: '', url: 'bundle.js', lineNumber: 100 }, hitCount: 3 },
    ],
    startTime: 1000,
    endTime: 1500,
  };
  let sendCallCount = 0;
  const client = createMockClient({
    _profilerAvailable: true,
    send: async (method) => {
      sendCallCount++;
      if (method === 'Profiler.stop') return { profile: mockProfile };
      return {};
    },
  });
  const handler = createCpuProfileHandler(() => client);
  const data = expectOk(await handler({ durationMs: 500 }));
  assert.equal(data.hotFunctions[0].name, 'renderApp');
  assert.equal(data.hotFunctions[0].hitCount, 42);
  assert.equal(data.nodeCount, 3);
  assert.ok(data.startTime !== undefined);
});

test('cpu_profile: JS sampling fallback when profilerAvailable is false', async () => {
  let evaluateCallCount = 0;
  const client = createMockClient({
    _profilerAvailable: false,
    evaluate: async (expr) => {
      evaluateCallCount++;
      if (expr.includes('__RN_AGENT_PROFILE_RESULT__') && !expr.includes('delete')) {
        return { value: JSON.stringify({ renderApp: 15, processData: 8 }) };
      }
      return { value: 'sampling' };
    },
  });
  const handler = createCpuProfileHandler(() => client);
  const data = expectOk(await handler({ durationMs: 500 }));
  assert.equal(data.source, 'js-sampling');
  assert.ok(data.hotFunctions.length > 0);
  assert.equal(data.hotFunctions[0].name, 'renderApp');
}, { timeout: 3000 });

test('cpu_profile: CDP path returns failResult when send throws', async () => {
  const client = createMockClient({
    _profilerAvailable: true,
    send: async (method) => {
      if (method === 'Profiler.enable') throw new Error('Profiler domain not enabled');
      return {};
    },
  });
  const handler = createCpuProfileHandler(() => client);
  const error = expectFail(await handler({ durationMs: 500 }));
  assert.match(error, /CPU profiling failed/);
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// cdp_object_inspect
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

test('object_inspect: primitive result (no objectId)', async () => {
  const client = createMockClient({
    send: async (method) => {
      if (method === 'Runtime.evaluate') {
        return { result: { type: 'number', value: 42, description: '42' } };
      }
      return {};
    },
  });
  const handler = createObjectInspectHandler(() => client);
  const data = expectOk(await handler({ expression: '42' }));
  assert.equal(data.primitive, true);
  assert.equal(data.value, 42);
  assert.equal(data.type, 'number');
});

test('object_inspect: object result with properties', async () => {
  const client = createMockClient({
    send: async (method, params) => {
      if (method === 'Runtime.evaluate') {
        return {
          result: {
            type: 'object',
            objectId: 'obj-1',
            className: 'Object',
            description: 'Object',
          },
        };
      }
      if (method === 'Runtime.getProperties') {
        return {
          result: [
            { name: 'name', isOwn: true, value: { type: 'string', value: 'Alice', description: 'Alice' } },
            { name: 'age', isOwn: true, value: { type: 'number', value: 30, description: '30' } },
          ],
        };
      }
      return {};
    },
  });
  const handler = createObjectInspectHandler(() => client);
  const data = expectOk(await handler({ expression: 'someObj', depth: 1 }));
  assert.equal(data.primitive, false);
  assert.equal(data.className, 'Object');
  assert.equal(data.properties.length, 2);
  assert.equal(data.properties[0].name, 'name');
});

test('object_inspect: expression throws returns failResult', async () => {
  const client = createMockClient({
    send: async (method) => {
      if (method === 'Runtime.evaluate') {
        return {
          exceptionDetails: { text: 'ReferenceError: undeclaredVar is not defined' },
          result: { type: 'undefined' },
        };
      }
      return {};
    },
  });
  const handler = createObjectInspectHandler(() => client);
  const error = expectFail(await handler({ expression: 'undeclaredVar' }));
  assert.match(error, /Expression threw/);
});

test('object_inspect: depth is clamped to [0, 3]', async () => {
  const sendCalls = [];
  const client = createMockClient({
    send: async (method, params) => {
      sendCalls.push({ method, params });
      if (method === 'Runtime.evaluate') {
        return {
          result: { type: 'object', objectId: 'obj-1', className: 'Object', description: 'Object' },
        };
      }
      if (method === 'Runtime.getProperties') {
        return { result: [] };
      }
      return {};
    },
  });
  const handler = createObjectInspectHandler(() => client);
  await handler({ expression: 'x', depth: 99 });
  const evalCall = sendCalls.find(c => c.method === 'Runtime.evaluate');
  assert.ok(evalCall, 'Runtime.evaluate should have been called');
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// cdp_exception_breakpoint
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

test('exception_breakpoint: set without duration returns message', async () => {
  const client = createMockClient({
    send: async () => ({}),
  });

  const handler = createExceptionBreakpointHandler(() => client);
  const data = expectOk(await handler({ state: 'uncaught' }));
  assert.equal(data.state, 'uncaught');
  assert.match(data.message, /Exception breakpoint set/);
});

test('exception_breakpoint: send failure returns failResult', async () => {
  const client = createMockClient({
    send: async () => { throw new Error('Debugger domain not available'); },
  });

  const handler = createExceptionBreakpointHandler(() => client);
  const error = expectFail(await handler({ state: 'all' }));
  assert.match(error, /Exception breakpoint failed/);
});

test('exception_breakpoint: state=none disables breakpoints', async () => {
  const setPauseStates = [];
  const client = createMockClient({
    send: async (method, params) => {
      if (method === 'Debugger.setPauseOnExceptions') {
        setPauseStates.push(params.state);
      }
      return {};
    },
  });

  const handler = createExceptionBreakpointHandler(() => client);
  const data = expectOk(await handler({ state: 'none' }));
  assert.equal(data.state, 'none');
  assert.ok(setPauseStates.includes('none'));
});
