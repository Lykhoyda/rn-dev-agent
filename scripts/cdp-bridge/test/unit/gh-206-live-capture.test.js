// test/unit/gh-206-live-capture.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maybeCaptureLiveFrame, _resetLiveCaptureForTest } from '../../dist/observability/live-device.js';

function baseDeps(over = {}) {
  const pushed = [];
  const deps = {
    hasObservers: () => true,
    isFlowActive: () => false,
    getPlatform: () => 'ios',
    captureScreenshot: async (_p, path) => ({ ok: true, path }),
    readRoute: async () => 'Home',
    readShotFile: () => ({ buf: Buffer.from([1]), contentType: 'image/jpeg' }),
    pushLive: (f) => pushed.push(f),
    tmpPath: () => '/tmp/x.jpg',
    ...over,
  };
  return { deps, pushed };
}

test('captures shot + route and pushes once', async () => {
  _resetLiveCaptureForTest();
  const { deps, pushed } = baseDeps();
  await maybeCaptureLiveFrame(deps);
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0].route, 'Home');
  assert.ok(pushed[0].shot);
});

test('skips when no observers', async () => {
  _resetLiveCaptureForTest();
  const { deps, pushed } = baseDeps({ hasObservers: () => false });
  await maybeCaptureLiveFrame(deps);
  assert.equal(pushed.length, 0);
});

test('skips when a flow is active', async () => {
  _resetLiveCaptureForTest();
  const { deps, pushed } = baseDeps({ isFlowActive: () => true });
  await maybeCaptureLiveFrame(deps);
  assert.equal(pushed.length, 0);
});

test('skips when no platform resolvable (no session and CDP not connected)', async () => {
  _resetLiveCaptureForTest();
  const { deps, pushed } = baseDeps({ getPlatform: () => null });
  await maybeCaptureLiveFrame(deps);
  assert.equal(pushed.length, 0);
});

test('route read failure (CDP down) still pushes the shot', async () => {
  _resetLiveCaptureForTest();
  const { deps, pushed } = baseDeps({ readRoute: async () => null });
  await maybeCaptureLiveFrame(deps);
  assert.equal(pushed.length, 1);
  assert.ok(pushed[0].shot);
  assert.equal(pushed[0].route, undefined);
});

test('screenshot failure still pushes the route', async () => {
  _resetLiveCaptureForTest();
  const { deps, pushed } = baseDeps({ captureScreenshot: async () => ({ ok: false }) });
  await maybeCaptureLiveFrame(deps);
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0].shot, undefined);
  assert.equal(pushed[0].route, 'Home');
});

test('errors in deps never throw out of maybeCaptureLiveFrame', async () => {
  _resetLiveCaptureForTest();
  const { deps } = baseDeps({ captureScreenshot: async () => { throw new Error('boom'); }, readRoute: async () => { throw new Error('boom2'); } });
  await maybeCaptureLiveFrame(deps); // must resolve, not reject
});

test('single-flight trailing-coalesce: one trailing capture after an in-flight burst', async () => {
  _resetLiveCaptureForTest();
  let calls = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const { deps, pushed } = baseDeps({
    captureScreenshot: async (_p, path) => { calls++; await gate; return { ok: true, path }; },
  });
  const first = maybeCaptureLiveFrame(deps); // starts, blocks on gate
  await maybeCaptureLiveFrame(deps);         // in-flight → sets pending, returns
  await maybeCaptureLiveFrame(deps);         // in-flight → pending already set, returns
  assert.equal(calls, 1, 'only the first capture has started');
  release();
  await first;
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls, 2, 'exactly one trailing capture ran (not zero, not three)');
  assert.equal(pushed.length, 2);
});
