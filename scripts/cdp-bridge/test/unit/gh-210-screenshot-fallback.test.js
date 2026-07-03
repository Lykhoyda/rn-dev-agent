// GH #210 Task 4: device_screenshot never hard-fails on iOS. It falls back to
// simctl/adb (tryRawScreenshot) when the rn-fast-runner is down OR a Maestro flow owns
// the device. Two multi-review HIGHs are guarded here: runIOS THROWS when down (not
// {isError}) so the runner call is wrapped in try/catch (A2); and during a flow the
// runner is NEVER touched — raw-only, never falling through (A3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chooseScreenshotPath,
  captureAndResizeScreenshot,
  _setRunAgentDeviceForTest,
  _resetRunAgentDeviceForTest,
} from '../../dist/tools/device-list.js';
import { arbiter } from '../../dist/lifecycle/device-arbiter.js';
import {
  _setForTest as setRawForTest,
  _resetForTest as resetRawForTest,
} from '../../dist/tools/device-screenshot-raw.js';

function parse(res) {
  return JSON.parse(res.content[0].text);
}

// ── chooseScreenshotPath (pure) — must NEVER return 'runner' while a flow is active (A3) ──
test('#210 screenshot-route: flow active + platform → simctl (skip runner)', () => {
  assert.equal(chooseScreenshotPath({ flowActive: true, platform: 'ios' }), 'simctl');
});

test('#210 screenshot-route: no flow, Android → runner first (iOS moved to simctl in GH #422)', () => {
  assert.equal(chooseScreenshotPath({ flowActive: false, platform: 'android' }), 'runner');
});

test('#210 screenshot-route: no flow + no platform → runner (agent-device resolves default)', () => {
  assert.equal(chooseScreenshotPath({ flowActive: false, platform: null }), 'runner');
});

test('#210 screenshot-route: flow active + NO platform → fail (must NOT touch the runner)', () => {
  assert.equal(chooseScreenshotPath({ flowActive: true, platform: null }), 'fail');
});

// ── integration: the wiring the pure helpers can't catch (A7) ──
// GH #422: iOS goes DIRECT to simctl (runner never consulted — its screenshot
// verb can't honor the caller's path), so the iOS runner-throw variant of A2 is
// intentionally unreachable now. The A2 catch+fallback logic itself stays
// covered by the android runner-throw test below (same code path).
test('#210 screenshot-int: iOS routes direct to simctl, runner never called (GH #422)', async () => {
  let runnerCalls = 0;
  _setRunAgentDeviceForTest(async () => {
    runnerCalls++;
    throw new Error('rn-fast-runner not started');
  });
  setRawForTest({ iosResolver: async () => 'UDID-TEST', iosCapturer: async () => true });
  try {
    const res = await captureAndResizeScreenshot({
      platform: 'ios',
      platformExplicit: false,
      maxWidth: 0,
    });
    assert.ok(!res.isError, 'iOS capture must succeed via simctl without touching the runner');
    assert.equal(parse(res).data.via, 'simctl');
    assert.equal(runnerCalls, 0, 'iOS must not consult the runner for pixels (GH #422)');
  } finally {
    _resetRunAgentDeviceForTest();
    resetRawForTest();
  }
});

test('#210 screenshot-int: flow active → runner fn is NEVER called (raw-only)', async () => {
  let runnerCalls = 0;
  _setRunAgentDeviceForTest(async () => {
    runnerCalls++;
    return { content: [] };
  });
  setRawForTest({ iosResolver: async () => 'UDID-TEST', iosCapturer: async () => true });
  const lease = arbiter.tryAcquire('flow', 'maestro_run');
  assert.equal(lease.ok, true, 'test setup: flow lease must be acquired');
  try {
    const res = await captureAndResizeScreenshot({
      platform: 'ios',
      platformExplicit: false,
      maxWidth: 0,
    });
    assert.equal(runnerCalls, 0, 'during a flow, the XCUITest runner must never be invoked');
    assert.ok(!res.isError);
  } finally {
    if (lease.ok) arbiter.release(lease.lease);
    _resetRunAgentDeviceForTest();
    resetRawForTest();
  }
});

test('#210 screenshot-int: flow active + raw fails → SCREENSHOT_FAILED, runner still NEVER called', async () => {
  let runnerCalls = 0;
  _setRunAgentDeviceForTest(async () => {
    runnerCalls++;
    return { content: [] };
  });
  setRawForTest({ iosResolver: async () => 'UDID-TEST', iosCapturer: async () => false });
  const lease = arbiter.tryAcquire('flow', 'maestro_run');
  assert.equal(lease.ok, true, 'test setup: flow lease must be acquired');
  try {
    const res = await captureAndResizeScreenshot({
      platform: 'ios',
      platformExplicit: false,
      maxWidth: 0,
    });
    assert.equal(res.isError, true);
    assert.equal(parse(res).code, 'SCREENSHOT_FAILED');
    assert.equal(
      runnerCalls,
      0,
      'must NOT fall through to the runner when simctl fails during a flow',
    );
  } finally {
    if (lease.ok) arbiter.release(lease.lease);
    _resetRunAgentDeviceForTest();
    resetRawForTest();
  }
});

test('#210 screenshot-int: android raw fallback reports via:adb (accurate backend name)', async () => {
  let runnerCalls = 0;
  _setRunAgentDeviceForTest(async () => {
    runnerCalls++;
    throw new Error('runner down');
  });
  setRawForTest({
    androidResolver: async () => 'emulator-test',
    androidCapturer: async () => true,
  });
  try {
    const res = await captureAndResizeScreenshot({
      platform: 'android',
      platformExplicit: false,
      maxWidth: 0,
    });
    assert.ok(!res.isError);
    assert.equal(parse(res).data.via, 'adb');
    assert.equal(runnerCalls, 1, 'the A2 throw path must actually exercise the runner first');
  } finally {
    _resetRunAgentDeviceForTest();
    resetRawForTest();
  }
});
