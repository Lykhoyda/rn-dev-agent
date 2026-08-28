import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  maybeCaptureLiveFrame,
  _resetLiveCaptureForTest,
} from '../../dist/observability/live-device.js';

function deps({ mirrorActive, route = '/home', screenshotAvailable = true }) {
  const calls = { target: 0, screenshot: 0, route: 0, pushed: [], blocked: [] };
  return {
    calls,
    deps: {
      hasObservers: () => true,
      isFlowActive: () => false,
      resolveTarget: async () => {
        calls.target++;
        return { ok: true, target: { platform: 'ios', deviceId: 'UDID-1' } };
      },
      captureScreenshot: async (_p, path) => {
        calls.screenshot++;
        return screenshotAvailable ? { ok: true, path } : { ok: false };
      },
      readRoute: async () => {
        calls.route++;
        return route;
      },
      readShotFile: () => ({ buf: Buffer.from('x'), contentType: 'image/jpeg' }),
      pushLive: (f) => calls.pushed.push(f),
      tmpPath: () => '/tmp/x.jpg',
      isMirrorActive: () => mirrorActive,
      reportBlocked: (outcome) => calls.blocked.push(outcome),
    },
  };
}

test('mirror streaming → screenshot skipped, route still read and pushed', async () => {
  _resetLiveCaptureForTest();
  const { calls, deps: d } = deps({ mirrorActive: true });
  await maybeCaptureLiveFrame(d);
  assert.equal(calls.screenshot, 0, 'redundant screenshot skipped while mirroring');
  assert.equal(calls.route, 1);
  assert.deepEqual(calls.pushed, [{ route: '/home' }]);
});

test('mirror not streaming → screenshot captured as before', async () => {
  _resetLiveCaptureForTest();
  const { calls, deps: d } = deps({ mirrorActive: false });
  await maybeCaptureLiveFrame(d);
  assert.equal(calls.screenshot, 1);
  assert.equal(calls.pushed.length, 1);
  assert.ok(calls.pushed[0].shot);
});

test('mirror streaming without a route is a successful capture skip', async () => {
  _resetLiveCaptureForTest();
  const { calls, deps: d } = deps({ mirrorActive: true, route: null });
  const outcome = await maybeCaptureLiveFrame(d);
  assert.deepEqual(outcome, { ok: true, pushed: 'skipped', reason: 'mirror-active' });
  assert.equal(calls.target, 0);
  assert.equal(calls.screenshot, 0);
  assert.equal(calls.route, 1);
  assert.deepEqual(calls.pushed, []);
  assert.deepEqual(calls.blocked, []);
});

test('no mirror, still, or route reports a truthful blocked capture', async () => {
  _resetLiveCaptureForTest();
  const { calls, deps: d } = deps({
    mirrorActive: false,
    route: null,
    screenshotAvailable: false,
  });
  const outcome = await maybeCaptureLiveFrame(d);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, 'LIVE_FRAME_UNAVAILABLE');
  assert.equal(calls.target, 1);
  assert.equal(calls.screenshot, 1);
  assert.equal(calls.route, 1);
  assert.deepEqual(calls.pushed, []);
  assert.deepEqual(calls.blocked, [{ code: outcome.code, reason: outcome.reason }]);
});
