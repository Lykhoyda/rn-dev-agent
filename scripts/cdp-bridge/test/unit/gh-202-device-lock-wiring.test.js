import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const sessionSrc = readFileSync(resolve(__dirname, "../../src/tools/device-session.ts"), "utf8");
const indexSrc = readFileSync(resolve(__dirname, "../../src/index.ts"), "utf8");

test("GH#202 device-open acquires the UDID lock and refuses on conflict", () => {
  assert.match(sessionSrc, /acquireDeviceLockForSession\(lockPlatform, deviceId, appId\)/);
  assert.match(sessionSrc, /DEVICE_BUSY/);
});

test("GH#202 lock is acquired BEFORE setActiveSession (lock-first ordering)", () => {
  const lockIdx = sessionSrc.indexOf("acquireDeviceLockForSession(lockPlatform, deviceId, appId)");
  const sessionIdx = sessionSrc.indexOf("setActiveSession(");
  assert.ok(lockIdx !== -1, "acquireDeviceLockForSession call must exist");
  assert.ok(sessionIdx !== -1, "setActiveSession call must exist");
  assert.ok(lockIdx < sessionIdx, "lock must be acquired BEFORE setActiveSession");
});

test("GH#202 conflict path has no runAgentDevice close and no setActiveSession before DEVICE_BUSY", () => {
  // Verify the new lock-first shape: conflict returns DEVICE_BUSY immediately
  // with no preceding runAgentDevice(['close']) or setActiveSession.
  assert.match(sessionSrc, /lockResult\.status === 'conflict'[\s\S]{0,300}DEVICE_BUSY/);
  // The old teardown pattern (runAgentDevice close → clearActiveSession → DEVICE_BUSY) must be gone.
  assert.doesNotMatch(
    sessionSrc,
    /runAgentDevice\(\['close'\]\)[\s\S]{0,200}clearActiveSession\(\)[\s\S]{0,300}DEVICE_BUSY/,
  );
});

test("GH#202 acquire helper is single-owner (releases prior lock first)", () => {
  assert.match(
    sessionSrc,
    /function acquireDeviceLockForSession[\s\S]{0,260}releaseDeviceLockForSession\(\)[\s\S]{0,160}new DeviceLock/,
  );
});

test("GH#202 a degraded (fs-error) lock acquire is surfaced as a warning", () => {
  assert.match(sessionSrc, /lockResult\.degraded/);
});

test("GH#202 device-close releases the UDID lock", () => {
  assert.match(sessionSrc, /releaseDeviceLockForSession\(\)/);
});

test("GH#202 process exit releases the UDID lock", () => {
  assert.match(indexSrc, /releaseDeviceLockForSession/);
});

test("GH#202 Android open uses native resolvers (no UDID_RE parse from agent-device)", () => {
  assert.match(sessionSrc, /resolveAndroidSerial\(/);
  assert.match(sessionSrc, /resolveIosUdid\(/);
  assert.match(sessionSrc, /acquireDeviceLockForSession\(lockPlatform, deviceId, appId\)/);
});

test("GH#202 runAgentDevice open call is gone from the open branch", () => {
  // The open branch must no longer call runAgentDevice(['open', ...]) —
  // device resolution is now purely native (simctl / adb).
  assert.doesNotMatch(sessionSrc, /runAgentDevice\(\['open'/);
});
