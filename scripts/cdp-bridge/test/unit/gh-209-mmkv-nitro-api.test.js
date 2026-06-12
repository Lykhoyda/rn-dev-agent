// GH #209: cdp_mmkv delete threw "mmkv.delete is not a function" on the Nitro
// react-native-mmkv line (v4 / 3.0 betas; stable v3 is TurboModule and never
// reaches NitroModulesProxy).
//
// Root cause: buildMmkvExpression was written against the JS wrapper class API
// (`delete(key)`), but the expression executes against the RAW Nitro hybrid
// object from createHybridObject('MMKVFactory').createMMKV(...) whose spec
// (MMKV.nitro.ts, HybridMMKV.cpp) exposes `remove(key): boolean` — no
// `delete`. Same class of bug, worse: `get type=boolean` emitted
// `mmkv.getBool(...)`, which exists on NEITHER surface (wrapper and hybrid
// object both spell it `getBoolean`) — broken since the tool shipped.
//
// These tests run the generated expression in a VM against a mock that models
// the REAL v4 hybrid-object surface (remove/getBoolean present, delete/getBool
// absent), so wrapper-API regressions fail here instead of on a live device.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const MOD = '../../dist/tools/mmkv.js';

function runExpr(expr, mmkvImpl) {
  const sandbox = {
    globalThis: {},
    Array, Object, JSON,
    String, Number, Boolean,
  };
  sandbox.globalThis = sandbox;
  sandbox.NitroModulesProxy = {
    createHybridObject: (name) => {
      if (name === 'MMKVFactory') {
        return { createMMKV: (opts) => mmkvImpl(opts.id) };
      }
      return null;
    },
  };
  vm.createContext(sandbox);
  return JSON.parse(vm.runInContext(expr, sandbox));
}

// Models the v4 Nitro hybrid object: spec-faithful method names ONLY.
// (remove returns boolean per HybridMMKV.cpp; no delete, no getBool.)
function makeNitroV4Instance(store) {
  return {
    set: (k, v) => store.set(k, v),
    getString: (k) => store.get(k),
    getNumber: (k) => store.get(k),
    getBoolean: (k) => store.get(k),
    contains: (k) => store.has(k),
    remove: (k) => store.delete(k),
    getAllKeys: () => [...store.keys()],
    clearAll: () => store.clear(),
  };
}

test('delete works against the real Nitro v4 surface (remove, no delete) — the #209 repro', async () => {
  const { buildMmkvExpression } = await import(MOD);
  const store = new Map([['authAccessToken', 'tok-123']]);
  const result = runExpr(
    buildMmkvExpression({ action: 'delete', key: 'authAccessToken' }),
    () => makeNitroV4Instance(store),
  );
  assert.equal(result.__agent_error, undefined, `expected success, got: ${JSON.stringify(result)}`);
  assert.equal(result.ok, true);
  assert.equal(store.has('authAccessToken'), false, 'key must actually be removed');
});

test('delete still works against a legacy wrapper-shaped object (delete, no remove)', async () => {
  const { buildMmkvExpression } = await import(MOD);
  const store = new Map([['k', 'v']]);
  const wrapperShaped = {
    delete: (k) => store.delete(k),
  };
  const result = runExpr(
    buildMmkvExpression({ action: 'delete', key: 'k' }),
    () => wrapperShaped,
  );
  assert.equal(result.ok, true);
  assert.equal(store.has('k'), false);
});

test('delete with neither remove nor delete surfaces a clear error (not a TypeError)', async () => {
  const { buildMmkvExpression } = await import(MOD);
  const result = runExpr(
    buildMmkvExpression({ action: 'delete', key: 'k' }),
    () => ({}),
  );
  assert.match(String(result.__agent_error), /neither remove\(\) nor delete\(\)/i);
});

test('get type=boolean works against the real Nitro v4 surface (getBoolean, no getBool)', async () => {
  const { buildMmkvExpression } = await import(MOD);
  const store = new Map([['flag', true]]);
  const result = runExpr(
    buildMmkvExpression({ action: 'get', key: 'flag', type: 'boolean' }),
    () => makeNitroV4Instance(store),
  );
  assert.equal(result.__agent_error, undefined, `expected success, got: ${JSON.stringify(result)}`);
  assert.equal(result.value, true);
});
