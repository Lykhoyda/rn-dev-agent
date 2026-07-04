import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  maybeCaptureLiveFrame,
  _resetLiveCaptureForTest,
} from '../../dist/observability/live-device.js';

function deps({ mirrorActive }) {
  const calls = { screenshot: 0, route: 0, pushed: [] };
  return {
    calls,
    deps: {
      hasObservers: () => true,
      isFlowActive: () => false,
      getPlatform: () => 'ios',
      captureScreenshot: async (_p, path) => {
        calls.screenshot++;
        return { ok: true, path };
      },
      readRoute: async () => {
        calls.route++;
        return '/home';
      },
      readShotFile: () => ({ buf: Buffer.from('x'), contentType: 'image/jpeg' }),
      pushLive: (f) => calls.pushed.push(f),
      tmpPath: () => '/tmp/x.jpg',
      isMirrorActive: () => mirrorActive,
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
