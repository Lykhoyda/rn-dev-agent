import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyNetworkHookEntry } from '../../dist/cdp/event-handlers.js';
import { DeviceBufferManager } from '../../dist/ring-buffer.js';

// Spec 2026-06-10-debugger-seat-optout Part 2: hook-mode network transport
// moves from console.log lines to an in-app ring buffer. applyNetworkHookEntry
// is the shared "entry → DeviceBufferManager" logic used by BOTH the legacy
// console-event path (back-compat, one release) and the new drain path.

function makeManager() {
  // Same construction as test/helpers/mock-cdp-client.js (the class lives in
  // src/ring-buffer.ts and takes an options object).
  return new DeviceBufferManager({
    capacityPerDevice: 100,
    maxDevices: 10,
    indexKey: (e) => e.id,
    timestampOf: (e) => new Date(e.timestamp).getTime(),
  });
}

test('applyNetworkHookEntry: request entry pushes into the buffer', () => {
  const mgr = makeManager();
  applyNetworkHookEntry('request', { id: 'r1', method: 'POST', url: '/api/x' }, mgr, 'dev1');
  const all = mgr.getLast('dev1', 10);
  assert.equal(all.length, 1);
  assert.equal(all[0].id, 'r1');
  assert.equal(all[0].method, 'POST');
  assert.equal(all[0].url, '/api/x');
  assert.ok(all[0].timestamp);
});

test('applyNetworkHookEntry: response entry completes the matching request', () => {
  const mgr = makeManager();
  applyNetworkHookEntry('request', { id: 'r1', method: 'GET', url: '/a' }, mgr, 'dev1');
  applyNetworkHookEntry('response', { id: 'r1', status: 204, duration_ms: 17 }, mgr, 'dev1');
  const entry = mgr.getByKey('dev1', 'r1');
  assert.equal(entry.status, 204);
  assert.equal(entry.duration_ms, 17);
});

test('applyNetworkHookEntry: response without a matching request is a no-op', () => {
  const mgr = makeManager();
  applyNetworkHookEntry('response', { id: 'ghost', status: 200, duration_ms: 1 }, mgr, 'dev1');
  assert.equal(mgr.getLast('dev1', 10).length, 0);
});

test('applyNetworkHookEntry: unknown type is a no-op (forward-compat)', () => {
  const mgr = makeManager();
  applyNetworkHookEntry('telemetry', { id: 'x' }, mgr, 'dev1');
  assert.equal(mgr.getLast('dev1', 10).length, 0);
});

test('applyNetworkHookEntry: duplicate request id is not pushed twice', () => {
  const mgr = makeManager();
  applyNetworkHookEntry('request', { id: 'r1', method: 'GET', url: '/a' }, mgr, 'dev1');
  applyNetworkHookEntry('request', { id: 'r1', method: 'GET', url: '/a' }, mgr, 'dev1');
  assert.equal(mgr.getLast('dev1', 10).length, 1);
});
