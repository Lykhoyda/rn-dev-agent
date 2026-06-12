// GH #265: device_screenshot with a `path` whose parent directory doesn't
// exist failed with "The device may be transitioning state (booting, OOM,
// locked)" — a pure misdiagnosis. Live repro: `xcrun simctl io <udid>
// screenshot docs/proof/<missing>/01.jpg` exits 4 with NSCocoaErrorDomain
// "The folder doesn't exist" (underlying NSPOSIXErrorDomain code=2) while the
// device is perfectly healthy. The capturer's bare `catch { return false }`
// erased the cause, and rawResultFail mapped every non-`no-device` failure to
// the device-state guess.
//
// Fix under test: `captureAndResizeScreenshot` mkdir-p's the parent of the
// derived path BEFORE any dispatch tier runs (simctl raw, rn-fast-runner,
// agent-device daemon/CLI, adb stream all write to that path), and when the
// mkdir itself fails it reports a target-directory error naming the path —
// never the transitioning-state message. New directories are the EXPECTED
// case: the tool's own advisories steer agents toward fresh
// `docs/proof/<slug>/` paths.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const RAW_MOD = '../../dist/tools/device-screenshot-raw.js';
const DEVICE_LIST_MOD = '../../dist/tools/device-list.js';

function makeTmpBase() {
  return mkdtempSync(join(tmpdir(), 'gh265-'));
}

function parseEnvelope(result) {
  return JSON.parse(result.content[0].text);
}

test('explicit-platform raw path: parent directory is created before the capturer runs (the #265 repro)', async (t) => {
  const raw = await import(RAW_MOD);
  const deviceList = await import(DEVICE_LIST_MOD);
  const base = makeTmpBase();
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const target = join(base, 'docs', 'proof', 'new-feature', '01.jpg');

  let parentExistedAtCapture = null;
  raw._setForTest({
    iosResolver: async () => 'UDID-265',
    // Behaves like real simctl: refuses to write into a missing directory.
    iosCapturer: async (_udid, path) => {
      parentExistedAtCapture = existsSync(dirname(path));
      return parentExistedAtCapture;
    },
  });
  try {
    const result = await deviceList.captureAndResizeScreenshot({
      path: target,
      platform: 'ios',
      platformExplicit: true,
    });
    const envelope = parseEnvelope(result);
    assert.equal(parentExistedAtCapture, true, 'capturer must see the parent directory already created');
    assert.equal(envelope.ok, true);
    assert.ok(!result.isError, `expected success, got: ${result.content[0].text}`);
  } finally {
    raw._resetForTest();
  }
});

test('mkdir failure (file blocks an intermediate segment): honest target-dir error, no device-state guess, no capture attempt', async (t) => {
  const raw = await import(RAW_MOD);
  const deviceList = await import(DEVICE_LIST_MOD);
  const base = makeTmpBase();
  t.after(() => rmSync(base, { recursive: true, force: true }));
  // A regular FILE occupies the would-be directory segment → mkdir -p ENOTDIR.
  const blocker = join(base, 'blocker');
  writeFileSync(blocker, 'not a directory');
  const target = join(blocker, 'sub', '01.jpg');

  let resolverCalls = 0;
  let capturerCalls = 0;
  raw._setForTest({
    iosResolver: async () => { resolverCalls++; return 'UDID-265'; },
    iosCapturer: async () => { capturerCalls++; return false; },
  });
  try {
    const result = await deviceList.captureAndResizeScreenshot({
      path: target,
      platform: 'ios',
      platformExplicit: true,
    });
    const envelope = parseEnvelope(result);
    assert.equal(result.isError, true);
    assert.equal(envelope.code, 'SCREENSHOT_FAILED');
    assert.doesNotMatch(envelope.error, /transitioning/i, 'must not blame device state for a filesystem precondition');
    assert.match(envelope.error, /directory/i, 'must name the directory problem');
    assert.ok(envelope.error.includes(target), 'must include the offending path');
    assert.equal(resolverCalls, 0, 'must short-circuit before probing devices');
    assert.equal(capturerCalls, 0, 'must short-circuit before any capture');
  } finally {
    raw._resetForTest();
  }
});

test('runner path (implicit platform): parent directory exists by the time runAgentDevice dispatches', async (t) => {
  const deviceList = await import(DEVICE_LIST_MOD);
  const base = makeTmpBase();
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const target = join(base, 'docs', 'diag', '2026-06-12', '01-symptom.jpg');

  let parentExistedAtDispatch = null;
  deviceList._setRunAgentDeviceForTest(async () => {
    parentExistedAtDispatch = existsSync(dirname(target));
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, data: { path: target } }) }] };
  });
  try {
    const result = await deviceList.captureAndResizeScreenshot({ path: target });
    const envelope = parseEnvelope(result);
    assert.equal(parentExistedAtDispatch, true, 'runner dispatch must see the parent directory already created');
    assert.equal(envelope.ok, true);
  } finally {
    deviceList._resetRunAgentDeviceForTest();
  }
});
