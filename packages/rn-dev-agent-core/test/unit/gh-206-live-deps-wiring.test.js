// test/unit/gh-206-live-deps-wiring.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLiveDeps,
  maybeCaptureLiveFrame,
  _resetLiveCaptureForTest,
} from '../../dist/observability/live-device.js';
import { Recorder } from '../../dist/observability/recorder.js';

const baseInput = (over = {}) => ({
  recorder: { hasSubscribers: () => true, pushLive: () => {} },
  isFlowActive: () => false,
  resolveTarget: async () => ({ ok: false, reason: 'no device' }),
  getClient: () => ({ isConnected: true }),
  captureScreenshot: async () => ({ ok: false }),
  readRoute: async () => null,
  readShotFile: () => null,
  ...over,
});

test('resolveTarget is passed straight through to the capture deps', async () => {
  const resolution = { ok: true, target: { platform: 'ios', deviceId: 'UDID-1' } };
  const deps = buildLiveDeps(baseInput({ resolveTarget: async () => resolution }));
  assert.deepEqual(await deps.resolveTarget(), resolution);
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
    resolveTarget: async () => ({ ok: true, target: { platform: 'ios', deviceId: 'UDID-1' } }),
    getClient: () => ({ isConnected: false }),
    captureScreenshot: async (_p, path) => ({ ok: true, path }),
    readRoute: async () => null,
    readShotFile: () => ({ buf: Buffer.from([0xff, 0xd8, 0xff]), contentType: 'image/jpeg' }),
  });
  await maybeCaptureLiveFrame(deps); // must not throw
  const shot = rec.getLiveScreenshot();
  assert.ok(shot, 'recorder received the live frame');
  assert.deepEqual(shot.buf, Buffer.from([0xff, 0xd8, 0xff]));
});

test('readRoute returns null when CDP disconnected (no eval attempted)', async () => {
  let called = false;
  const deps = buildLiveDeps(
    baseInput({
      getClient: () => ({ isConnected: false }),
      readRoute: async () => {
        called = true;
        return 'X';
      },
    }),
  );
  assert.equal(await deps.readRoute(), null);
  assert.equal(called, false, 'must not call the route reader when disconnected');
});
