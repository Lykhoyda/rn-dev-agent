// Reproduces the post-flow state where only the authority device binding remains.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import {
  buildLiveDeps,
  maybeCaptureLiveFrame,
  _resetLiveCaptureForTest,
} from '../../dist/observability/live-device.js';
import { buildMirrorTargetResolver } from '../../dist/observability/mirror/target.js';
import {
  tryRawScreenshot,
  _setForTest,
  _resetForTest,
} from '../../dist/tools/device-screenshot-raw.js';
import { Recorder } from '../../dist/observability/recorder.js';

const AUTHORITY_UDID = 'AAAAAAAA-1111-2222-3333-444444444444';
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

type RegistryBinding = { platform?: string; deviceId?: string };
type BlockedOutcome = { code: string; reason: string };
type LiveDepsOverrides = {
  resolveTarget?: ReturnType<typeof buildMirrorTargetResolver>;
  getClient?: () => { isConnected: boolean; connectedTarget?: unknown };
  captureScreenshot?: (
    platform: 'ios' | 'android',
    path: string,
    deviceId: string,
  ) => Promise<{ ok: true; path: string } | { ok: false }>;
  readRoute?: (client: unknown) => Promise<string | null>;
  readShotFile?: (path: string) => { buf: Buffer; contentType: string } | null;
  reportBlocked?: (outcome: BlockedOutcome) => void;
};

function parkedRunnerResolver(registryBinding: RegistryBinding) {
  return buildMirrorTargetResolver({
    getPlatform: () => null,
    getSessionDeviceId: () => undefined,
    getRegistryDeviceBinding: () => registryBinding,
    resolveIosUdid: async () => undefined,
    listAndroidSerials: async () => [],
  });
}

function liveDepsFor(overrides: LiveDepsOverrides = {}) {
  const recorder = new Recorder();
  recorder.attach(() => {});
  const blocked: BlockedOutcome[] = [];
  const deps = buildLiveDeps({
    recorder,
    isFlowActive: () => false,
    resolveTarget: parkedRunnerResolver({
      platform: 'ios',
      deviceId: AUTHORITY_UDID,
    }),
    getClient: () => ({ isConnected: false, connectedTarget: null }),
    captureScreenshot: (platform, path, deviceId) => tryRawScreenshot(platform, path, deviceId),
    readRoute: async () => null,
    readShotFile: () => ({ buf: JPEG, contentType: 'image/jpeg' }),
    reportBlocked: (o) => blocked.push(o),
    ...overrides,
  });
  return { deps, recorder, blocked };
}

test('parked runner + stale CDP: the supported simctl fallback still lands a real frame', async () => {
  _resetLiveCaptureForTest();
  _resetForTest();
  const capturedWith: string[] = [];
  _setForTest({
    // Ambient resolution is unavailable; only the authority binding may resolve.
    iosResolver: async () => null,
    iosCapturer: async (udid, path) => {
      capturedWith.push(udid);
      writeFileSync(path, JPEG);
      return true;
    },
  });
  try {
    const { deps, recorder } = liveDepsFor();
    const outcome = await maybeCaptureLiveFrame(deps);
    const shot = recorder.getLiveScreenshot();
    assert.ok(shot, 'the Device pane received a real frame');
    assert.deepEqual(shot.buf, JPEG);
    assert.deepEqual(capturedWith, [AUTHORITY_UDID], 'captured the authority-proven device');
    assert.deepEqual(outcome, { ok: true, pushed: 'frame' });
  } finally {
    _resetForTest();
  }
});

for (const [label, buf] of [
  ['zero-byte', Buffer.alloc(0)],
  ['oversized', Buffer.alloc(4_000_001)],
] as const) {
  test(`${label} screenshot is truthfully reported as unavailable`, async () => {
    _resetLiveCaptureForTest();
    const { deps, recorder, blocked } = liveDepsFor({
      captureScreenshot: async (_platform, path) => ({ ok: true, path }),
      readShotFile: () => ({ buf, contentType: 'image/jpeg' }),
    });
    const outcome = await maybeCaptureLiveFrame(deps);
    assert.equal(outcome.ok, false);
    if (outcome.ok) assert.fail('unusable screenshot must not report success');
    assert.equal(outcome.code, 'LIVE_FRAME_UNAVAILABLE');
    assert.match(outcome.reason, /empty or oversized/);
    assert.deepEqual(blocked, [{ code: outcome.code, reason: outcome.reason }]);
    assert.equal(recorder.getLiveScreenshot(), undefined);
  });
}

test('no provable device: truthful typed refusal, no blank or fabricated frame', async () => {
  _resetLiveCaptureForTest();
  // An empty authority binding must refuse instead of selecting an ambient device.
  const { deps, recorder, blocked } = liveDepsFor({
    resolveTarget: parkedRunnerResolver({}),
    captureScreenshot: async () => {
      throw new Error('capture must not be attempted without a proven device');
    },
  });
  const outcome = await maybeCaptureLiveFrame(deps);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, 'DEVICE_AUTHORITY_UNBOUND');
  assert.match(outcome.reason, /device authority is not bound/);
  assert.deepEqual(blocked, [{ code: outcome.code, reason: outcome.reason }]);
  assert.equal(recorder.getLiveScreenshot(), undefined, 'nothing was pushed to the Device pane');
});

test('neither supported source proves a frame: typed refusal, nothing pushed', async () => {
  _resetLiveCaptureForTest();
  const { deps, recorder, blocked } = liveDepsFor({
    captureScreenshot: async () => ({ ok: false }),
    readRoute: async () => null,
  });
  const outcome = await maybeCaptureLiveFrame(deps);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, 'LIVE_FRAME_UNAVAILABLE');
  assert.match(outcome.reason, /simctl/);
  assert.equal(blocked.length, 1);
  assert.equal(recorder.getLiveScreenshot(), undefined);
});

test('a capture that throws is reported, never swallowed into a blank pane', async () => {
  _resetLiveCaptureForTest();
  const { deps, recorder, blocked } = liveDepsFor({
    captureScreenshot: async () => {
      throw new Error('simctl io screenshot timed out');
    },
    readRoute: async () => null,
  });
  const outcome = await maybeCaptureLiveFrame(deps);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, 'LIVE_FRAME_UNAVAILABLE');
  assert.match(outcome.reason, /timed out/);
  assert.equal(blocked.length, 1);
  assert.equal(recorder.getLiveScreenshot(), undefined);
});

test('the route leg alone still lands a frame when pixels are unavailable', async () => {
  _resetLiveCaptureForTest();
  const { deps, blocked } = liveDepsFor({
    getClient: () => ({ isConnected: true, connectedTarget: null }),
    captureScreenshot: async () => ({ ok: false }),
    readRoute: async () => 'Tasks',
  });
  const outcome = await maybeCaptureLiveFrame(deps);
  assert.deepEqual(outcome, { ok: true, pushed: 'frame' });
  assert.equal(blocked.length, 0);
});
