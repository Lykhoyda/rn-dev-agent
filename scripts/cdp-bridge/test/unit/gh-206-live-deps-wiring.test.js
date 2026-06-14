// test/unit/gh-206-live-deps-wiring.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLiveDeps } from '../../dist/observability/live-device.js';

const baseInput = (over = {}) => ({
  recorder: { hasSubscribers: () => true, pushLive: () => {} },
  isFlowActive: () => false,
  getActiveSession: () => null,
  getClient: () => ({ isConnected: true, connectedTarget: null }),
  captureScreenshot: async () => ({ ok: false }),
  readRoute: async () => null,
  readShotFile: () => null,
  ...over,
});

test('getPlatform prefers a valid agent-device session platform', () => {
  const deps = buildLiveDeps(baseInput({ getActiveSession: () => ({ platform: 'ios', deviceId: 'UDID-1' }) }));
  assert.equal(deps.getPlatform(), 'ios');
});

test('getPlatform falls back to the connected CDP target when there is no session (the reporter flow)', () => {
  const deps = buildLiveDeps(baseInput({
    getActiveSession: () => null,
    getClient: () => ({ isConnected: true, connectedTarget: { platform: 'ios' } }),
  }));
  assert.equal(deps.getPlatform(), 'ios');
});

test('getPlatform returns null when neither session nor CDP target yields ios/android', () => {
  const deps = buildLiveDeps(baseInput({
    getActiveSession: () => ({ platform: 'web' }),
    getClient: () => ({ isConnected: true, connectedTarget: { platform: undefined } }),
  }));
  assert.equal(deps.getPlatform(), null);
});

test('readRoute returns null when CDP disconnected (no eval attempted)', async () => {
  let called = false;
  const deps = buildLiveDeps(baseInput({
    getClient: () => ({ isConnected: false, connectedTarget: null }),
    readRoute: async () => { called = true; return 'X'; },
  }));
  assert.equal(await deps.readRoute(), null);
  assert.equal(called, false, 'must not call the route reader when disconnected');
});
