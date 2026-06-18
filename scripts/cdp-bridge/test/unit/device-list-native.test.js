// Phase 2 Task 2: device_list enumerates devices natively via
// xcrun simctl + adb instead of calling agent-device.
// Tests:
//   1. parseSimctlDevicesAll — pure parser for simctl JSON
//   2. createDeviceListHandler — handler with injected exec, merges iOS + Android
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseSimctlDevicesAll,
  createDeviceListHandler,
  _setDeviceListExecForTest,
  _resetDeviceListExecForTest,
} from "../../dist/tools/device-list.js";

// ── fixtures ──────────────────────────────────────────────────────────────────

const SIMCTL_JSON = JSON.stringify({
  devices: {
    "com.apple.CoreSimulator.SimRuntime.iOS-18-0": [
      { udid: "ABC-123", name: "iPhone 15", state: "Booted" },
      { udid: "DEF-456", name: "iPad", state: "Shutdown" },
    ],
    "com.apple.CoreSimulator.SimRuntime.iOS-17-5": [
      { udid: "GHI-789", name: "iPhone 14", state: "Booted" },
    ],
  },
});

const ADB_OUTPUT = "List of devices attached\nemulator-5554\tdevice\n\n";

// ── 1. parseSimctlDevicesAll ──────────────────────────────────────────────────

test("parseSimctlDevicesAll: returns only Booted iOS devices", () => {
  const result = parseSimctlDevicesAll(SIMCTL_JSON);
  assert.equal(result.length, 2, "only 2 Booted devices across runtimes");
  for (const d of result) {
    assert.equal(d.platform, "ios");
    assert.equal(d.state, "Booted");
    assert.ok(typeof d.id === "string" && d.id.length > 0, "id present");
    assert.ok(typeof d.name === "string" && d.name.length > 0, "name present");
  }
});

test("parseSimctlDevicesAll: maps udid → id", () => {
  const result = parseSimctlDevicesAll(SIMCTL_JSON);
  const ids = result.map((d) => d.id).sort();
  assert.deepEqual(ids, ["ABC-123", "GHI-789"].sort());
});

test("parseSimctlDevicesAll: maps device names correctly", () => {
  const result = parseSimctlDevicesAll(SIMCTL_JSON);
  const names = result.map((d) => d.name).sort();
  assert.deepEqual(names, ["iPhone 15", "iPhone 14"].sort());
});

test("parseSimctlDevicesAll: returns [] on invalid JSON (defensive)", () => {
  const result = parseSimctlDevicesAll("not json at all");
  assert.deepEqual(result, []);
});

test("parseSimctlDevicesAll: returns [] when no devices booted", () => {
  const json = JSON.stringify({
    devices: {
      "com.apple.CoreSimulator.SimRuntime.iOS-18-0": [
        { udid: "AAA-000", name: "iPad Air", state: "Shutdown" },
      ],
    },
  });
  const result = parseSimctlDevicesAll(json);
  assert.deepEqual(result, []);
});

test("parseSimctlDevicesAll: returns [] on empty devices object", () => {
  const result = parseSimctlDevicesAll(JSON.stringify({ devices: {} }));
  assert.deepEqual(result, []);
});

// ── 2. createDeviceListHandler — injected exec ────────────────────────────────

test("createDeviceListHandler: merges iOS booted + Android serials", async () => {
  _setDeviceListExecForTest(async (cmd, _args) => {
    if (cmd === "xcrun") return { stdout: SIMCTL_JSON };
    if (cmd === "adb") return { stdout: ADB_OUTPUT };
    throw new Error(`Unexpected command: ${cmd}`);
  });
  try {
    const handler = createDeviceListHandler();
    const result = await handler({});
    const envelope = JSON.parse(result.content[0].text);
    assert.equal(envelope.ok, true, "result must be ok:true");
    const devices = envelope.data.devices;
    assert.ok(Array.isArray(devices), "devices must be an array");

    const ios = devices.filter((d) => d.platform === "ios");
    const android = devices.filter((d) => d.platform === "android");

    assert.equal(ios.length, 2, "two booted iOS simulators");
    assert.equal(android.length, 1, "one Android device");
    assert.equal(android[0].id, "emulator-5554");
    assert.equal(android[0].name, "emulator-5554");
    assert.equal(android[0].state, "device");
  } finally {
    _resetDeviceListExecForTest();
  }
});

test("createDeviceListHandler: iOS error does not fail Android result", async () => {
  _setDeviceListExecForTest(async (cmd) => {
    if (cmd === "xcrun") throw new Error("simctl not available");
    if (cmd === "adb") return { stdout: ADB_OUTPUT };
    throw new Error(`Unexpected: ${cmd}`);
  });
  try {
    const handler = createDeviceListHandler();
    const result = await handler({});
    const envelope = JSON.parse(result.content[0].text);
    assert.equal(envelope.ok, true, "result must still be ok:true when iOS fails");
    const devices = envelope.data.devices;
    const ios = devices.filter((d) => d.platform === "ios");
    const android = devices.filter((d) => d.platform === "android");
    assert.equal(ios.length, 0, "no iOS devices when simctl errors");
    assert.equal(android.length, 1, "Android devices still returned");
  } finally {
    _resetDeviceListExecForTest();
  }
});

test("createDeviceListHandler: Android error does not fail iOS result", async () => {
  _setDeviceListExecForTest(async (cmd) => {
    if (cmd === "xcrun") return { stdout: SIMCTL_JSON };
    if (cmd === "adb") throw new Error("adb not found");
    throw new Error(`Unexpected: ${cmd}`);
  });
  try {
    const handler = createDeviceListHandler();
    const result = await handler({});
    const envelope = JSON.parse(result.content[0].text);
    assert.equal(envelope.ok, true, "result must still be ok:true when Android fails");
    const devices = envelope.data.devices;
    const ios = devices.filter((d) => d.platform === "ios");
    const android = devices.filter((d) => d.platform === "android");
    assert.equal(ios.length, 2, "iOS devices still returned");
    assert.equal(android.length, 0, "no Android devices when adb errors");
  } finally {
    _resetDeviceListExecForTest();
  }
});

test("createDeviceListHandler: both fail → ok:true with empty devices array", async () => {
  _setDeviceListExecForTest(async () => {
    throw new Error("nothing works");
  });
  try {
    const handler = createDeviceListHandler();
    const result = await handler({});
    const envelope = JSON.parse(result.content[0].text);
    assert.equal(envelope.ok, true, "must be ok:true even when both platforms fail");
    assert.deepEqual(envelope.data.devices, []);
  } finally {
    _resetDeviceListExecForTest();
  }
});

test("createDeviceListHandler: does NOT call any agent-device path", async () => {
  const commandsCalled = [];
  _setDeviceListExecForTest(async (cmd, args) => {
    commandsCalled.push({ cmd, args });
    if (cmd === "xcrun") return { stdout: SIMCTL_JSON };
    if (cmd === "adb") return { stdout: ADB_OUTPUT };
    throw new Error(`Unexpected: ${cmd}`);
  });
  try {
    const handler = createDeviceListHandler();
    await handler({});
    // Only xcrun and adb should be called — never agent-device
    const hasAgentDevice = commandsCalled.some(({ cmd }) => String(cmd).includes("agent-device"));
    assert.equal(hasAgentDevice, false, "must not route through agent-device");
    // Confirm the expected native commands were called
    const cmds = commandsCalled.map(({ cmd }) => cmd);
    assert.ok(cmds.includes("xcrun"), "must call xcrun simctl");
    assert.ok(cmds.includes("adb"), "must call adb");
  } finally {
    _resetDeviceListExecForTest();
  }
});

test("parseSimctlDevicesAll: skips Booted entries missing udid (beta-runtime partial entry)", () => {
  const json = JSON.stringify({
    devices: {
      "runtime-x": [
        { name: "Ghost", state: "Booted" },
        { udid: "OK-1", name: "Real", state: "Booted" },
      ],
    },
  });
  assert.deepEqual(parseSimctlDevicesAll(json), [
    { platform: "ios", id: "OK-1", name: "Real", state: "Booted" },
  ]);
});
