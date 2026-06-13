import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { buildMmkvExpression, createMmkvHandler } from '../../dist/tools/mmkv.js';
import { createMockClient } from '../helpers/mock-cdp-client.js';
import { expectOk, expectFail } from '../helpers/result-helpers.js';

// GH #59 #7 / #60 feature-b: cdp_mmkv tool reads/writes MMKV via
// NitroModulesProxy from Hermes. Tests:
//   1. buildMmkvExpression returns valid JS for each action shape
//   2. The expression run in a VM with a mock NitroModulesProxy
//      produces correct results
//   3. The expression returns __agent_error when Nitro / MMKVFactory
//      / instance is missing
//   4. Argument validation surfaces clear errors

// ── 1. Pure expression-builder tests ──

test('buildMmkvExpression: get action produces an executable expression', () => {
  const expr = buildMmkvExpression({ action: 'get', key: 'foo' });
  assert.match(expr, /createHybridObject\('MMKVFactory'\)/);
  assert.match(expr, /createMMKV\(\{ id: "mmkv\.default" \}\)/);
  assert.match(expr, /getString\("foo"\)/);
});

test('buildMmkvExpression: get with type=number uses getNumber', () => {
  const expr = buildMmkvExpression({ action: 'get', key: 'count', type: 'number' });
  assert.match(expr, /getNumber\("count"\)/);
});

test('buildMmkvExpression: get with type=boolean uses getBoolean (GH #209 — getBool exists on no MMKV surface)', () => {
  const expr = buildMmkvExpression({ action: 'get', key: 'flag', type: 'boolean' });
  assert.match(expr, /getBoolean\("flag"\)/);
});

test('buildMmkvExpression: get without key returns __agent_error literal', () => {
  const expr = buildMmkvExpression({ action: 'get' });
  assert.match(expr, /__agent_error.*requires non-empty key/);
});

test('buildMmkvExpression: set action with string value', () => {
  const expr = buildMmkvExpression({ action: 'set', key: 'name', value: 'alice' });
  assert.match(expr, /\.set\("name", "alice"\)/);
});

test('buildMmkvExpression: set with type=number coerces value', () => {
  const expr = buildMmkvExpression({ action: 'set', key: 'count', value: '42', type: 'number' });
  assert.match(expr, /\.set\("count", 42\)/);
});

test('buildMmkvExpression: set with type=boolean accepts true and "true"', () => {
  const exprTrue = buildMmkvExpression({ action: 'set', key: 'flag', value: true, type: 'boolean' });
  assert.match(exprTrue, /\.set\("flag", true\)/);
  const exprStrTrue = buildMmkvExpression({ action: 'set', key: 'flag', value: 'true', type: 'boolean' });
  assert.match(exprStrTrue, /\.set\("flag", true\)/);
  const exprFalse = buildMmkvExpression({ action: 'set', key: 'flag', value: false, type: 'boolean' });
  assert.match(exprFalse, /\.set\("flag", false\)/);
});

test('buildMmkvExpression: set without value returns __agent_error', () => {
  const expr = buildMmkvExpression({ action: 'set', key: 'foo' });
  assert.match(expr, /__agent_error.*set requires value/);
});

test('buildMmkvExpression: delete prefers Nitro remove() with wrapper delete() fallback (GH #209)', () => {
  const expr = buildMmkvExpression({ action: 'delete', key: 'foo' });
  assert.match(expr, /mmkv\.remove\("foo"\)/);
  assert.match(expr, /mmkv\.delete\("foo"\)/);
  // remove (the hybrid-object spec name) must be tried first.
  assert.ok(expr.indexOf('mmkv.remove') < expr.indexOf('mmkv.delete'));
});

test('buildMmkvExpression: has uses contains()', () => {
  const expr = buildMmkvExpression({ action: 'has', key: 'foo' });
  assert.match(expr, /\.contains\("foo"\)/);
});

test('buildMmkvExpression: keys uses getAllKeys()', () => {
  const expr = buildMmkvExpression({ action: 'keys' });
  assert.match(expr, /\.getAllKeys\(\)/);
});

test('buildMmkvExpression: clear uses clearAll()', () => {
  const expr = buildMmkvExpression({ action: 'clear' });
  assert.match(expr, /\.clearAll\(\)/);
});

test('buildMmkvExpression: instanceId is forwarded into createMMKV', () => {
  const expr = buildMmkvExpression({ action: 'keys', instanceId: 'cart-store' });
  assert.match(expr, /createMMKV\(\{ id: "cart-store" \}\)/);
});

test('buildMmkvExpression: special chars in key are JSON-escaped', () => {
  // A key containing a quote must not break out of the JS string literal.
  const expr = buildMmkvExpression({ action: 'get', key: 'a"b' });
  // JSON.stringify('a"b') → "a\"b"
  assert.match(expr, /getString\("a\\"b"\)/);
});

test('buildMmkvExpression: malicious instanceId expression executes safely (no JS injection)', () => {
  // Stronger regression guard: actually parse and run the generated
  // expression. If injection persists, the throw runs and we never
  // reach the createMMKV-failure return.
  const evil = 'x"; throw new Error("INJECTED"); //';
  const expr = buildMmkvExpression({ action: 'keys', instanceId: evil });
  const sandbox = {
    globalThis: {},
    Array, Object, JSON, String, Number, Boolean, Error,
  };
  sandbox.globalThis = sandbox;
  // Force the createMMKV-failure branch by returning null from createMMKV.
  sandbox.NitroModulesProxy = {
    createHybridObject: () => ({ createMMKV: () => null }),
  };
  vm.createContext(sandbox);
  // If the injection were active, the IIFE's outer try/catch would
  // catch the thrown Error and surface it as MMKV op threw with the
  // INJECTED message — confirming code executed. With proper escaping,
  // the IIFE returns the createMMKV-failure envelope and the literal
  // payload appears as data inside __agent_error, not as executed code.
  const raw = vm.runInContext(expr, sandbox);
  const result = JSON.parse(raw);
  assert.match(result.__agent_error, /createMMKV returned no instance/, 'must reach the failure-branch return');
  assert.doesNotMatch(result.__agent_error, /MMKV op threw/, 'injection would surface as a thrown error envelope');
});

// ── 2. End-to-end: run the expression in a VM with a mock NitroModulesProxy ──

function runExpr(expr, mmkvImpl) {
  const sandbox = {
    globalThis: {},
    Array, Object, JSON,
    String, Number, Boolean,
  };
  sandbox.globalThis = sandbox;
  if (mmkvImpl !== null) {
    sandbox.NitroModulesProxy = {
      createHybridObject: (name) => {
        if (name === 'MMKVFactory') {
          return {
            createMMKV: (opts) => mmkvImpl(opts.id),
          };
        }
        return null;
      },
    };
  }
  vm.createContext(sandbox);
  const raw = vm.runInContext(expr, sandbox);
  return JSON.parse(raw);
}

test('expression runs against a mock instance: get returns stored value', () => {
  const instance = { getString: (k) => k === 'foo' ? 'bar' : undefined };
  const result = runExpr(
    buildMmkvExpression({ action: 'get', key: 'foo' }),
    () => instance,
  );
  assert.deepEqual(result, { value: 'bar' });
});

test('expression runs against a mock: get returns null when key missing', () => {
  const instance = { getString: () => undefined };
  const result = runExpr(buildMmkvExpression({ action: 'get', key: 'absent' }), () => instance);
  assert.deepEqual(result, { value: null });
});

test('expression runs against a mock: set + delete are wired', () => {
  const store = new Map();
  const instance = {
    set: (k, v) => store.set(k, v),
    delete: (k) => store.delete(k),
  };
  runExpr(buildMmkvExpression({ action: 'set', key: 'cooldown', value: '12345' }), () => instance);
  assert.equal(store.get('cooldown'), '12345');
  runExpr(buildMmkvExpression({ action: 'delete', key: 'cooldown' }), () => instance);
  assert.equal(store.has('cooldown'), false);
});

test('expression runs against a mock: keys returns array', () => {
  const instance = { getAllKeys: () => ['a', 'b', 'c'] };
  const result = runExpr(buildMmkvExpression({ action: 'keys' }), () => instance);
  assert.deepEqual(result, { keys: ['a', 'b', 'c'] });
});

test('expression runs against a mock: has returns boolean', () => {
  const instance = { contains: (k) => k === 'present' };
  const yes = runExpr(buildMmkvExpression({ action: 'has', key: 'present' }), () => instance);
  assert.deepEqual(yes, { present: true });
  const no = runExpr(buildMmkvExpression({ action: 'has', key: 'absent' }), () => instance);
  assert.deepEqual(no, { present: false });
});

// ── 3. Failure envelopes ──

test('expression returns __agent_error when NitroModulesProxy is missing', () => {
  const result = runExpr(buildMmkvExpression({ action: 'keys' }), null);
  assert.ok(result.__agent_error, 'should surface __agent_error sentinel');
  assert.match(result.__agent_error, /NitroModulesProxy not available/);
});

test('expression returns __agent_error when MMKVFactory is not registered', () => {
  const sandbox = {
    globalThis: {},
    Array, Object, JSON, String, Number, Boolean,
  };
  sandbox.globalThis = sandbox;
  sandbox.NitroModulesProxy = {
    createHybridObject: () => null,
  };
  vm.createContext(sandbox);
  const raw = vm.runInContext(buildMmkvExpression({ action: 'keys' }), sandbox);
  const result = JSON.parse(raw);
  assert.match(result.__agent_error, /MMKVFactory not registered/);
});

test('expression returns __agent_error when MMKV op throws', () => {
  const instance = { getString: () => { throw new Error('disk error'); } };
  const result = runExpr(buildMmkvExpression({ action: 'get', key: 'foo' }), () => instance);
  assert.match(result.__agent_error, /MMKV op threw.*disk error/);
});

// ── 4. Handler integration: parsed envelope → ToolResult ──

test('createMmkvHandler: returns failResult on __agent_error sentinel', async () => {
  const client = createMockClient({
    evaluate: async () => ({ value: JSON.stringify({ __agent_error: 'NitroModulesProxy not available' }) }),
  });
  const handler = createMmkvHandler(() => client);
  const error = expectFail(await handler({ action: 'keys' }));
  assert.match(error, /NitroModulesProxy not available/);
});

test('createMmkvHandler: parses successful response', async () => {
  const client = createMockClient({
    evaluate: async () => ({ value: JSON.stringify({ value: 'hello' }) }),
  });
  const handler = createMmkvHandler(() => client);
  const data = expectOk(await handler({ action: 'get', key: 'greeting' }));
  assert.deepEqual(data, { value: 'hello' });
});

test('createMmkvHandler: surfaces evaluate-level error', async () => {
  const client = createMockClient({
    evaluate: async () => ({ error: 'WebSocket closed' }),
  });
  const handler = createMmkvHandler(() => client);
  const error = expectFail(await handler({ action: 'keys' }));
  assert.match(error, /MMKV evaluate error.*WebSocket closed/);
});
