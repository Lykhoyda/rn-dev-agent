// CDP-014: device_permission must reject unknown platforms instead of
// silently routing them to the Android branch. A typo like "andriod"
// previously reached adb-side mutations.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createDevicePermissionHandler } from "../../dist/tools/device-permission.js";

function parseEnvelope(result) {
  return JSON.parse(result.content[0].text);
}

test('CDP-014: typo "andriod" returns INVALID_PLATFORM (not Android branch)', async () => {
  const handler = createDevicePermissionHandler();
  const r = await handler({
    action: "revoke",
    permission: "notifications",
    appId: "com.example.app",
    platform: "andriod", // typo
  });
  assert.equal(r.isError, true);
  const env = parseEnvelope(r);
  assert.equal(env.code, "INVALID_PLATFORM");
  assert.match(env.error, /Invalid platform "andriod"/);
});

test("CDP-014: arbitrary platform string returns INVALID_PLATFORM", async () => {
  const handler = createDevicePermissionHandler();
  const r = await handler({
    action: "reset",
    permission: "all",
    appId: "com.example.app",
    platform: "windows",
  });
  assert.equal(r.isError, true);
  const env = parseEnvelope(r);
  assert.equal(env.code, "INVALID_PLATFORM");
});

test('CDP-014: explicit "ios" still routes to iOS handler (regression preserved)', async () => {
  // We only need to confirm validation passes — the iOS branch will then
  // try to spawn xcrun, which we can't run in the sandbox. The error message
  // distinguishes "INVALID_PLATFORM" from "xcrun simctl privacy failed".
  const handler = createDevicePermissionHandler();
  const r = await handler({
    action: "revoke",
    permission: "notifications",
    appId: "com.example.app",
    platform: "ios",
  });
  if (r.isError) {
    const env = parseEnvelope(r);
    assert.notEqual(env.code, "INVALID_PLATFORM", "ios must NOT be rejected as invalid");
  }
});
