// GH #210 Task 1: cdp_status.deviceSession reports the iOS rn-fast-runner liveness
// so the agent can see the XCUITest runner state before calling device_*. iOS-gated:
// the /health probe (:22088) and the foreign-runner `ps ax` scan run ONLY for an iOS
// session — Android leaves rnFastRunner:'dead' and skips both (A4, multi-review).
import { test } from "node:test";
import assert from "node:assert/strict";
import { getDeviceSessionHealth } from "../../dist/tools/device-session-health.js";

const session = (over = {}) => ({
  name: "s",
  platform: "ios",
  deviceId: "UDID-1",
  openedAt: "now",
  appId: "com.x",
  ...over,
});

test("#210 health: no active session → sessionOpen:false, rnFastRunner:dead, probe NOT called", async () => {
  let probed = 0;
  const h = await getDeviceSessionHealth({
    getActiveSession: () => null,
    probeLiveness: async () => {
      probed++;
      return "alive";
    },
  });
  assert.deepEqual(h, { sessionOpen: false, rnFastRunner: "dead" });
  assert.equal(probed, 0, "must not probe /health when no session is open");
});

test("#210 health: Android session → rnFastRunner:dead, probe + detectForeign NOT called (iOS-only)", async () => {
  let probed = 0,
    detected = 0;
  const h = await getDeviceSessionHealth({
    getActiveSession: () => session({ platform: "android" }),
    probeLiveness: async () => {
      probed++;
      return "alive";
    },
    detectForeign: async () => {
      detected++;
      return { detected: true };
    },
  });
  assert.equal(h.sessionOpen, true);
  assert.equal(h.rnFastRunner, "dead", "Android never uses the iOS runner");
  assert.equal(probed, 0, "must not probe :22088 on Android");
  assert.equal(detected, 0, "must not run the ps-scan on Android");
  assert.equal(h.foreignRunner, undefined);
});

test("#210 health: session open + runner alive → reports alive + appId/deviceId", async () => {
  const h = await getDeviceSessionHealth({
    getActiveSession: () => session(),
    probeLiveness: async () => "alive",
  });
  assert.equal(h.sessionOpen, true);
  assert.equal(h.rnFastRunner, "alive");
  assert.equal(h.appId, "com.x");
  assert.equal(h.deviceId, "UDID-1");
});

test("#210 health: session open + runner stale → reports stale", async () => {
  const h = await getDeviceSessionHealth({
    getActiveSession: () => session(),
    probeLiveness: async () => "stale",
  });
  assert.equal(h.rnFastRunner, "stale");
});

test("#210 health: probe throws → degrades to dead (never throws)", async () => {
  const h = await getDeviceSessionHealth({
    getActiveSession: () => session(),
    probeLiveness: async () => {
      throw new Error("boom");
    },
  });
  assert.equal(h.rnFastRunner, "dead");
});

test("#210 health: foreign Maestro/WDA flow detected → foreignRunner.detected", async () => {
  const h = await getDeviceSessionHealth({
    getActiveSession: () => session(),
    probeLiveness: async () => "alive",
    detectForeign: async (udid) => (udid === "UDID-1" ? { detected: true } : null),
  });
  assert.deepEqual(h.foreignRunner, { detected: true });
});

test("#210 health: detectForeign throws → omitted (best-effort, never throws)", async () => {
  const h = await getDeviceSessionHealth({
    getActiveSession: () => session(),
    probeLiveness: async () => "alive",
    detectForeign: async () => {
      throw new Error("ps failed");
    },
  });
  assert.equal(h.foreignRunner, undefined);
});
