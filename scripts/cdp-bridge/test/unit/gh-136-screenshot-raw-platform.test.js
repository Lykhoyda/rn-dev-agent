// GH #136 PR-A: explicit-platform raw screenshot path. When the caller passes
// `platform: 'ios' | 'android'` explicitly (not inferred from CDP target),
// device_screenshot bypasses `runAgentDevice` and uses xcrun simctl / adb
// directly to disambiguate when both an iOS sim and an Android emu are booted.
//
// Tests cover (1) pure parsers for `xcrun simctl list -j devices booted` JSON
// and `adb devices` stdout, (2) the `tryRawScreenshot` orchestrator branches,
// and (3) the device-list `captureAndResizeScreenshot` plumbing — that the
// raw path is taken iff `platformExplicit` is true, and falls through to
// `runAgentDevice` on any failure (graceful degradation per spec).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const RAW_MOD = '../../dist/tools/device-screenshot-raw.js';
const DEVICE_LIST_MOD = '../../dist/tools/device-list.js';

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

test('tryRawScreenshot(ios): resolver returns null → returns null (no capture attempt)', async () => {
  const mod = await import(RAW_MOD);
  const { tryRawScreenshot, _setForTest, _resetForTest } = mod;
  let capturerCalled = false;
  _setForTest({
    iosResolver: async () => null,
    iosCapturer: async () => { capturerCalled = true; return true; },
  });
  try {
    const result = await tryRawScreenshot('ios', '/tmp/shot.jpg');
    assert.equal(result, null);
    assert.equal(capturerCalled, false);
  } finally {
    _resetForTest();
  }
});

test('tryRawScreenshot(ios): capturer fails → returns null', async () => {
  const mod = await import(RAW_MOD);
  const { tryRawScreenshot, _setForTest, _resetForTest } = mod;
  _setForTest({
    iosResolver: async () => 'UDID-X',
    iosCapturer: async () => false,
  });
  try {
    const result = await tryRawScreenshot('ios', '/tmp/shot.jpg');
    assert.equal(result, null);
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

test('captureAndResizeScreenshot: platformExplicit + resolver fails → falls through to runAgentDevice', async () => {
  const raw = await import(RAW_MOD);
  const dl = await import(DEVICE_LIST_MOD);
  const { captureAndResizeScreenshot, _setRunAgentDeviceForTest, _resetRunAgentDeviceForTest } = dl;
  let runAgentDeviceCalled = false;
  _setRunAgentDeviceForTest(async (args, opts) => {
    runAgentDeviceCalled = true;
    // Mimic agent-device success envelope shape.
    return {
      content: [{ type: 'text', text: JSON.stringify({ ok: true, data: { path: '/tmp/fallback.jpg' } }) }],
    };
  });
  raw._setForTest({
    iosResolver: async () => null, // resolver fails — should fall through
  });
  try {
    const result = await captureAndResizeScreenshot({
      platform: 'ios',
      platformExplicit: true,
      path: '/tmp/fallback.jpg',
      maxWidth: 0,
    });
    assert.equal(runAgentDeviceCalled, true, 'runAgentDevice should be the fallback');
    const envelope = JSON.parse(result.content[0].text);
    assert.equal(envelope.ok, true);
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
