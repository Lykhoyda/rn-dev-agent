// GH #136 PR-A: explicit-platform raw screenshot path. When the caller passes
// `platform: 'ios' | 'android'` explicitly (not inferred from CDP target),
// device_screenshot bypasses `runAgentDevice` and uses xcrun simctl / adb
// directly to disambiguate when both an iOS sim and an Android emu are booted.
//
// Tests cover (1) pure parsers for `xcrun simctl list -j devices booted` JSON
// and `adb devices` stdout, (2) the `tryRawScreenshot` orchestrator branches
// (now returning a discriminated union `{ok:true,path}` | `{ok:false,reason}`),
// and (3) the device-list `captureAndResizeScreenshot` plumbing — that the
// raw path is taken iff `platformExplicit` is true, and **hard-fails with an
// actionable SCREENSHOT_FAILED envelope** when raw fails (per PR-B; the
// original PR-A graceful-fallback was the regression vector for #136).
// Implicit-platform calls (platformExplicit=false) still route through
// runAgentDevice — backward parity preserved.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const RAW_MOD = '../../dist/tools/device-screenshot-raw.js';
const DEVICE_LIST_MOD = '../../dist/tools/device-list.js';

// ── resolveCaptureOutcome (deepsec 2026-05-12 follow-up) ────────────
// The Android capturer waits for BOTH the WriteStream's 'finish' event AND
// adb's exit code before settling. Node doesn't order these two events, so
// the decision helper must report 'pending' until both have arrived, and
// only return 'success' when both happened cleanly. The earlier version
// resolved on whichever fired first — adb exiting non-zero after the
// stream finished was silently swallowed (deepsec finding "Android
// screenshot can report success before adb exit status is known").

test('resolveCaptureOutcome: pending until both signals arrive', async () => {
  const { resolveCaptureOutcome } = await import(RAW_MOD);
  assert.equal(resolveCaptureOutcome(false, null), 'pending');
  assert.equal(resolveCaptureOutcome(true, null), 'pending');
  assert.equal(resolveCaptureOutcome(false, 0), 'pending');
});

test('resolveCaptureOutcome: success only when stream finished AND exit code 0', async () => {
  const { resolveCaptureOutcome } = await import(RAW_MOD);
  assert.equal(resolveCaptureOutcome(true, 0), 'success');
});

test('resolveCaptureOutcome: stream finished + non-zero exit → failure (the deepsec race)', async () => {
  const { resolveCaptureOutcome } = await import(RAW_MOD);
  // This is the exact scenario the deepsec scan caught: WriteStream drained
  // cleanly, then adb exited with non-zero status. Prior code reported
  // success on the 'finish' event; the new code must report failure once
  // both signals are in.
  assert.equal(resolveCaptureOutcome(true, 1), 'failure');
  assert.equal(resolveCaptureOutcome(true, 127), 'failure');
  assert.equal(resolveCaptureOutcome(true, -1), 'failure');
});

// ── Pure parsers ────────────────────────────────────────────────────

test('parseSimctlBootedUDID: returns first Booted device UDID, skips Shutdown', async () => {
  const { parseSimctlBootedUDID } = await import(RAW_MOD);
  // `xcrun simctl list -j devices booted` actually only returns booted devices,
  // but the parser should still tolerate mixed state in case the caller passes
  // unfiltered output.
  const json = JSON.stringify({
    devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [
        { udid: 'ABC-SHUTDOWN', state: 'Shutdown', name: 'iPhone 16' },
        { udid: 'DEF-BOOTED-IOS', state: 'Booted', name: 'iPhone 17 Pro' },
      ],
    },
  });
  assert.equal(parseSimctlBootedUDID(json), 'DEF-BOOTED-IOS');
});

test('parseSimctlBootedUDID: returns null on no Booted device or malformed JSON', async () => {
  const { parseSimctlBootedUDID } = await import(RAW_MOD);
  // No booted device
  const noBootedJson = JSON.stringify({
    devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [
        { udid: 'X', state: 'Shutdown', name: 'iPhone 16' },
      ],
    },
  });
  assert.equal(parseSimctlBootedUDID(noBootedJson), null);
  // Empty devices object
  assert.equal(parseSimctlBootedUDID(JSON.stringify({ devices: {} })), null);
  // Malformed JSON
  assert.equal(parseSimctlBootedUDID('not-json'), null);
  // Missing devices key
  assert.equal(parseSimctlBootedUDID('{}'), null);
});

test('parseAdbDevicesEmu: returns first emulator-N device, skips offline/unauthorized', async () => {
  const { parseAdbDevicesEmu } = await import(RAW_MOD);
  // adb devices output format. Note: physical device IDs are typically
  // alphanumeric without the emulator- prefix, so they're skipped.
  const stdout =
    'List of devices attached\n' +
    'emulator-5554\toffline\n' +
    'physical-abc-123\tdevice\n' +
    'emulator-5556\tdevice\n' +
    'emulator-5558\tunauthorized\n';
  assert.equal(parseAdbDevicesEmu(stdout), 'emulator-5556');
});

test('parseAdbDevicesEmu: returns null when no online emulator', async () => {
  const { parseAdbDevicesEmu } = await import(RAW_MOD);
  assert.equal(parseAdbDevicesEmu(''), null);
  assert.equal(parseAdbDevicesEmu('List of devices attached\n'), null);
  assert.equal(parseAdbDevicesEmu('List of devices attached\nemulator-5554\toffline\n'), null);
});

// ── tryRawScreenshot orchestrator ───────────────────────────────────

test('tryRawScreenshot(ios): resolver returns UDID, capturer succeeds → envelope returned', async () => {
  const mod = await import(RAW_MOD);
  const { tryRawScreenshot, _setForTest, _resetForTest } = mod;
  const captures = [];
  _setForTest({
    iosResolver: async () => 'DEF-UDID',
    iosCapturer: async (udid, path) => { captures.push({ udid, path }); return true; },
  });
  try {
    const result = await tryRawScreenshot('ios', '/tmp/shot.jpg');
    assert.deepEqual(result, { ok: true, path: '/tmp/shot.jpg' });
    assert.deepEqual(captures, [{ udid: 'DEF-UDID', path: '/tmp/shot.jpg' }]);
  } finally {
    _resetForTest();
  }
});

test('tryRawScreenshot(ios): resolver returns null → ok:false with reason no-device (no capture attempt)', async () => {
  const mod = await import(RAW_MOD);
  const { tryRawScreenshot, _setForTest, _resetForTest } = mod;
  let capturerCalled = false;
  _setForTest({
    iosResolver: async () => null,
    iosCapturer: async () => { capturerCalled = true; return true; },
  });
  try {
    const result = await tryRawScreenshot('ios', '/tmp/shot.jpg');
    assert.deepEqual(result, { ok: false, reason: 'no-device' });
    assert.equal(capturerCalled, false);
  } finally {
    _resetForTest();
  }
});

test('tryRawScreenshot(ios): capturer fails → ok:false with reason capture-failed', async () => {
  const mod = await import(RAW_MOD);
  const { tryRawScreenshot, _setForTest, _resetForTest } = mod;
  _setForTest({
    iosResolver: async () => 'UDID-X',
    iosCapturer: async () => false,
  });
  try {
    const result = await tryRawScreenshot('ios', '/tmp/shot.jpg');
    assert.deepEqual(result, { ok: false, reason: 'capture-failed' });
  } finally {
    _resetForTest();
  }
});

test('tryRawScreenshot(android): resolver returns emu-id, capturer succeeds → envelope returned', async () => {
  const mod = await import(RAW_MOD);
  const { tryRawScreenshot, _setForTest, _resetForTest } = mod;
  const captures = [];
  _setForTest({
    androidResolver: async () => 'emulator-5556',
    androidCapturer: async (emuId, path) => { captures.push({ emuId, path }); return true; },
  });
  try {
    const result = await tryRawScreenshot('android', '/tmp/shot.png');
    assert.deepEqual(result, { ok: true, path: '/tmp/shot.png' });
    assert.deepEqual(captures, [{ emuId: 'emulator-5556', path: '/tmp/shot.png' }]);
  } finally {
    _resetForTest();
  }
});

test('tryRawScreenshot(android): capturer fails → ok:false capture-failed (mirrors iOS for symmetry)', async () => {
  const mod = await import(RAW_MOD);
  const { tryRawScreenshot, _setForTest, _resetForTest } = mod;
  _setForTest({
    androidResolver: async () => 'emulator-5556',
    androidCapturer: async () => false,
  });
  try {
    const result = await tryRawScreenshot('android', '/tmp/shot.png');
    assert.deepEqual(result, { ok: false, reason: 'capture-failed' });
  } finally {
    _resetForTest();
  }
});

// ── device-list integration ─────────────────────────────────────────

test('captureAndResizeScreenshot: platformExplicit + ios resolved → raw path taken (no runAgentDevice)', async () => {
  const raw = await import(RAW_MOD);
  const dl = await import(DEVICE_LIST_MOD);
  const { captureAndResizeScreenshot, _setRunAgentDeviceForTest, _resetRunAgentDeviceForTest } = dl;
  let runAgentDeviceCalled = false;
  _setRunAgentDeviceForTest(async () => {
    runAgentDeviceCalled = true;
    return { content: [{ type: 'text', text: JSON.stringify({ ok: false }) }], isError: true };
  });
  raw._setForTest({
    iosResolver: async () => 'IOS-UDID',
    iosCapturer: async () => true,
  });
  try {
    const result = await captureAndResizeScreenshot({
      platform: 'ios',
      platformExplicit: true,
      path: '/tmp/raw-ios.jpg',
      maxWidth: 0, // skip resize so we don't need sips
    });
    assert.equal(runAgentDeviceCalled, false, 'runAgentDevice should NOT have been called');
    const envelope = JSON.parse(result.content[0].text);
    assert.equal(envelope.ok, true);
    assert.equal(envelope.data.path, '/tmp/raw-ios.jpg');
  } finally {
    _resetRunAgentDeviceForTest();
    raw._resetForTest();
  }
});

test('captureAndResizeScreenshot: platformExplicit + android resolved → raw path taken (no runAgentDevice)', async () => {
  // Mirrors the iOS-explicit test — covers the other arm of the
  // `platform === 'ios' ? iosResolver : androidResolver` dispatch in
  // tryRawScreenshot. Without this, a branch inversion in device-list.ts
  // (e.g., calling iosResolver for android) would land green.
  const raw = await import(RAW_MOD);
  const dl = await import(DEVICE_LIST_MOD);
  const { captureAndResizeScreenshot, _setRunAgentDeviceForTest, _resetRunAgentDeviceForTest } = dl;
  let runAgentDeviceCalled = false;
  const captures = [];
  _setRunAgentDeviceForTest(async () => {
    runAgentDeviceCalled = true;
    return { content: [{ type: 'text', text: JSON.stringify({ ok: false }) }], isError: true };
  });
  raw._setForTest({
    androidResolver: async () => 'emulator-5556',
    androidCapturer: async (id, p) => { captures.push({ id, p }); return true; },
  });
  try {
    const result = await captureAndResizeScreenshot({
      platform: 'android',
      platformExplicit: true,
      path: '/tmp/raw-android.png',
      maxWidth: 0,
    });
    assert.equal(runAgentDeviceCalled, false, 'runAgentDevice should NOT have been called for android explicit path');
    assert.deepEqual(captures, [{ id: 'emulator-5556', p: '/tmp/raw-android.png' }]);
    const envelope = JSON.parse(result.content[0].text);
    assert.equal(envelope.ok, true);
    assert.equal(envelope.data.path, '/tmp/raw-android.png');
  } finally {
    _resetRunAgentDeviceForTest();
    raw._resetForTest();
  }
});

test('captureAndResizeScreenshot: platformExplicit + resolver miss → hard-fails (does NOT fall through to runAgentDevice)', async () => {
  // GH #136 PR-B: the original PR-A behavior was to fall through to
  // runAgentDevice on resolver miss. That was the regression vector — the
  // fallback re-introduced the broken `--platform` routing. With an explicit
  // platform, we must hard-fail with an actionable message instead.
  const raw = await import(RAW_MOD);
  const dl = await import(DEVICE_LIST_MOD);
  const { captureAndResizeScreenshot, _setRunAgentDeviceForTest, _resetRunAgentDeviceForTest } = dl;
  let runAgentDeviceCalled = false;
  _setRunAgentDeviceForTest(async () => {
    runAgentDeviceCalled = true;
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, data: { path: '/tmp/wrong.jpg' } }) }] };
  });
  raw._setForTest({
    androidResolver: async () => null, // no booted Android emulator
  });
  try {
    const result = await captureAndResizeScreenshot({
      platform: 'android',
      platformExplicit: true,
      path: '/tmp/shot.png',
      maxWidth: 0,
    });
    assert.equal(runAgentDeviceCalled, false, 'runAgentDevice MUST NOT be the fallback when platform is explicit');
    assert.equal(result.isError, true);
    const envelope = JSON.parse(result.content[0].text);
    assert.equal(envelope.ok, false);
    assert.equal(envelope.code, 'SCREENSHOT_FAILED');
    assert.equal(envelope.meta.platform, 'android');
    assert.equal(envelope.meta.reason, 'no-device');
    // Error message names the platform and the underlying CLI so users know what to fix.
    assert.match(envelope.error, /platform=android/);
    assert.match(envelope.error, /adb/);
  } finally {
    _resetRunAgentDeviceForTest();
    raw._resetForTest();
  }
});

test('captureAndResizeScreenshot: platformExplicit + capture fails → hard-fails with capture-failed reason', async () => {
  // Distinct from the resolver-miss case: device IS detected but the
  // capture command itself failed (transient adb error, simctl crash,
  // disk full, etc.). User-facing hint differs from "no device booted".
  const raw = await import(RAW_MOD);
  const dl = await import(DEVICE_LIST_MOD);
  const { captureAndResizeScreenshot, _setRunAgentDeviceForTest, _resetRunAgentDeviceForTest } = dl;
  let runAgentDeviceCalled = false;
  _setRunAgentDeviceForTest(async () => {
    runAgentDeviceCalled = true;
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, data: { path: '/tmp/wrong.jpg' } }) }] };
  });
  raw._setForTest({
    iosResolver: async () => 'UDID-IOS',
    iosCapturer: async () => false,
  });
  try {
    const result = await captureAndResizeScreenshot({
      platform: 'ios',
      platformExplicit: true,
      path: '/tmp/shot.jpg',
      maxWidth: 0,
    });
    assert.equal(runAgentDeviceCalled, false);
    assert.equal(result.isError, true);
    const envelope = JSON.parse(result.content[0].text);
    assert.equal(envelope.ok, false);
    assert.equal(envelope.code, 'SCREENSHOT_FAILED');
    assert.equal(envelope.meta.reason, 'capture-failed');
    assert.match(envelope.error, /xcrun simctl/);
  } finally {
    _resetRunAgentDeviceForTest();
    raw._resetForTest();
  }
});

test('captureAndResizeScreenshot: platformExplicit=false → uses runAgentDevice (backward parity)', async () => {
  const raw = await import(RAW_MOD);
  const dl = await import(DEVICE_LIST_MOD);
  const { captureAndResizeScreenshot, _setRunAgentDeviceForTest, _resetRunAgentDeviceForTest } = dl;
  let runAgentDeviceCalled = false;
  let resolverCalled = false;
  _setRunAgentDeviceForTest(async () => {
    runAgentDeviceCalled = true;
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, data: { path: '/tmp/x.jpg' } }) }] };
  });
  raw._setForTest({
    iosResolver: async () => { resolverCalled = true; return 'X'; },
  });
  try {
    // No platformExplicit field (or false) — even with platform set,
    // we must NOT attempt raw path (only client-inferred platforms here).
    await captureAndResizeScreenshot({
      platform: 'ios',
      // platformExplicit deliberately omitted
      path: '/tmp/x.jpg',
      maxWidth: 0,
    });
    assert.equal(runAgentDeviceCalled, true);
    assert.equal(resolverCalled, false, 'resolver MUST NOT be called when platformExplicit is falsy');
  } finally {
    _resetRunAgentDeviceForTest();
    raw._resetForTest();
  }
});

test('captureAndResizeScreenshot: raw path still gets EPHEMERAL_PATH advisory for /tmp paths', async () => {
  const raw = await import(RAW_MOD);
  const dl = await import(DEVICE_LIST_MOD);
  const { captureAndResizeScreenshot, _setRunAgentDeviceForTest, _resetRunAgentDeviceForTest } = dl;
  _setRunAgentDeviceForTest(async () => ({ content: [{ type: 'text', text: '{}' }], isError: true }));
  raw._setForTest({
    iosResolver: async () => 'UDID',
    iosCapturer: async () => true,
  });
  try {
    const result = await captureAndResizeScreenshot({
      platform: 'ios',
      platformExplicit: true,
      path: '/tmp/ephemeral.jpg',
      maxWidth: 0,
    });
    const envelope = JSON.parse(result.content[0].text);
    const codes = (envelope.meta?.advisories ?? []).map((a) => a.code);
    assert.ok(codes.includes('EPHEMERAL_PATH'), `expected EPHEMERAL_PATH advisory, got ${JSON.stringify(codes)}`);
  } finally {
    _resetRunAgentDeviceForTest();
    raw._resetForTest();
  }
});
