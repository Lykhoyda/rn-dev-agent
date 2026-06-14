// test/unit/gh-206-live-deps-wiring.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLiveDeps, maybeCaptureLiveFrame, _resetLiveCaptureForTest } from '../../dist/observability/live-device.js';
import { Recorder } from '../../dist/observability/recorder.js';

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

// Regression: buildLiveDeps must pass a BOUND pushLive. A raw `recorder.pushLive`
// method reference loses `this`, so the real call path throws "this.subs is not
// iterable" — a bug the arrow-function fakes in the other tests can't catch.
// This drives a REAL Recorder end-to-end through buildLiveDeps + the capture.
test('pushLive is bound to the recorder — real frame lands via the capture path', async () => {
  _resetLiveCaptureForTest();
  const rec = new Recorder();
  rec.attach(() => {}); // a connected observer
  const deps = buildLiveDeps({
    recorder: rec,
    isFlowActive: () => false,
    getActiveSession: () => ({ platform: 'ios' }),
    getClient: () => ({ isConnected: false, connectedTarget: { platform: 'ios' } }),
    captureScreenshot: async (_p, path) => ({ ok: true, path }),
    readRoute: async () => null,
    readShotFile: () => ({ buf: Buffer.from([0xff, 0xd8, 0xff]), contentType: 'image/jpeg' }),
  });
  await maybeCaptureLiveFrame(deps); // must not throw
  const shot = rec.getLiveScreenshot();
  assert.ok(shot, 'recorder received the live frame');
  assert.deepEqual(shot.buf, Buffer.from([0xff, 0xd8, 0xff]));
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
