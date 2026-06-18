// GH #60 Feature-c / D687: device_reset_state orchestrator. Composes
// device_permission + cdp_mmkv + simctl/adb terminate+launch in one call,
// best-effort with per-step status. Tests cover the orchestration logic
// (sequence, partial-failure semantics, response shape) by mocking a
// CDPClient and observing the response envelope. Spawned subprocess paths
// (xcrun simctl, adb) may fail in the sandbox — we assert SHAPE rather than
// running them through.
import { test } from "node:test";
import assert from "node:assert/strict";

const MOD_PATH = "../../dist/tools/device-reset-state.js";

function makeMockClient(opts = {}) {
  const calls = { evaluate: [], softReconnect: 0 };
  return {
    isConnected: opts.isConnected ?? true,
    helpersInjected: opts.helpersInjected ?? true,
    metroPort: opts.metroPort ?? 8081,
    connectedTarget: opts.connectedTarget ?? null,
    proxyDesired: false,
    evaluate: async (expr) => {
      calls.evaluate.push(expr);
      if (opts.evaluateImpl) return opts.evaluateImpl(expr);
      return { value: JSON.stringify({ deleted: true }) };
    },
    softReconnect: async () => {
      calls.softReconnect += 1;
      if (opts.softReconnectImpl) return opts.softReconnectImpl();
    },
    autoConnect: async () => "connected",
    disconnect: async () => undefined,
    _calls: calls,
  };
}

function parseEnvelope(result) {
  return JSON.parse(result.content[0].text);
}

// ── Args validation ─────────────────────────────────────────────────────

test("args: missing appId returns DEVICE_RESET_INVALID_ARGS failResult", async () => {
  const { createDeviceResetStateHandler } = await import(MOD_PATH);
  const handler = createDeviceResetStateHandler(() => makeMockClient());
  const result = await handler({});
  assert.equal(result.isError, true);
  const env = parseEnvelope(result);
  assert.equal(env.code, "DEVICE_RESET_INVALID_ARGS");
  assert.match(env.error, /appId is required/);
});

test("args: explicit invalid platform returns DEVICE_RESET_INVALID_ARGS", async () => {
  const { createDeviceResetStateHandler } = await import(MOD_PATH);
  const handler = createDeviceResetStateHandler(() => makeMockClient());
  const result = await handler({ appId: "com.example.app", platform: "windows" });
  assert.equal(result.isError, true);
  const env = parseEnvelope(result);
  assert.equal(env.code, "DEVICE_RESET_INVALID_ARGS");
});

// ── Empty-input path ────────────────────────────────────────────────────

test("empty permissions + empty storageKeys + relaunch=false: only terminate runs", async () => {
  const { createDeviceResetStateHandler } = await import(MOD_PATH);
  const client = makeMockClient();
  const handler = createDeviceResetStateHandler(() => client);
  const result = await handler({
    appId: "com.example.app",
    platform: "ios",
    relaunch: false,
  });
  const env = parseEnvelope(result);
  assert.ok("content" in result);
  assert.ok(env.data, "envelope must carry data");
  assert.equal(env.data.platform, "ios");
  assert.equal(env.data.relaunch, false);
  assert.ok(Array.isArray(env.data.steps), "steps[] required");
  assert.equal(env.data.steps.length, 1, "only terminate step ran");
  assert.equal(env.data.steps[0].step, "terminate");
});

// ── Storage step: CDP not connected → all keys skipped ──────────────────

test("storageKeys when CDP not connected: each key marked skipped with CDP_NOT_CONNECTED", async () => {
  const { createDeviceResetStateHandler } = await import(MOD_PATH);
  const client = makeMockClient({ isConnected: false });
  const handler = createDeviceResetStateHandler(() => client);
  const result = await handler({
    appId: "com.example.app",
    platform: "ios",
    storageKeys: ["cooldown1", "cooldown2"],
    relaunch: false,
  });
  const env = parseEnvelope(result);
  const storageSteps = env.data.steps.filter((s) => s.step === "storage");
  assert.equal(storageSteps.length, 2);
  for (const s of storageSteps) {
    assert.equal(s.ok, false);
    assert.equal(s.code, "CDP_NOT_CONNECTED");
    assert.match(s.error, /CDP not connected/);
  }
  assert.equal(env.data.summary.skipped, 2);
  // No evaluate() calls when not connected.
  assert.equal(client._calls.evaluate.length, 0);
});

// ── Storage step: __agent_error sentinel surfaces as failure ────────────

test("storageKeys when MMKV unavailable: __agent_error surfaces per-key failure", async () => {
  const { createDeviceResetStateHandler } = await import(MOD_PATH);
  const client = makeMockClient({
    // CDP-003 guard: target description must include the appId so the
    // app-mismatch guard doesn't pre-empt the storage step under test.
    connectedTarget: {
      id: "p1",
      title: "Hermes",
      vm: "Hermes",
      description: "com.example.app",
      platform: "ios",
    },
    evaluateImpl: () => ({
      value: JSON.stringify({
        __agent_error: "NitroModulesProxy not available — MMKV requires react-native-mmkv v3+",
      }),
    }),
  });
  const handler = createDeviceResetStateHandler(() => client);
  const result = await handler({
    appId: "com.example.app",
    platform: "ios",
    storageKeys: ["cooldown1"],
    relaunch: false,
  });
  const env = parseEnvelope(result);
  const storage = env.data.steps.find((s) => s.step === "storage");
  assert.ok(storage);
  assert.equal(storage.ok, false);
  assert.match(storage.error, /NitroModulesProxy not available/);
  assert.equal(client._calls.evaluate.length, 1);
  assert.match(client._calls.evaluate[0], /MMKVFactory|mmkv\.delete|nitro/i);
});

// ── Storage step: happy path ────────────────────────────────────────────

test("storageKeys success: each key reports ok with action=delete", async () => {
  const { createDeviceResetStateHandler } = await import(MOD_PATH);
  const client = makeMockClient({
    // CDP-003 guard: matching target description.
    connectedTarget: {
      id: "p1",
      title: "Hermes",
      vm: "Hermes",
      description: "com.example.app",
      platform: "ios",
    },
    evaluateImpl: () => ({ value: JSON.stringify({ deleted: true }) }),
  });
  const handler = createDeviceResetStateHandler(() => client);
  const result = await handler({
    appId: "com.example.app",
    platform: "ios",
    storageKeys: ["k1", "k2"],
    relaunch: false,
  });
  const env = parseEnvelope(result);
  const storage = env.data.steps.filter((s) => s.step === "storage");
  assert.equal(storage.length, 2);
  assert.equal(storage[0].ok, true);
  assert.equal(storage[0].action, "delete");
  assert.equal(storage[0].target, "k1");
  assert.equal(storage[1].target, "k2");
});

// ── CDP-003: orchestrator-level wrong-app guard ─────────────────────────

test("CDP-003: storage skipped with CDP_TARGET_APP_MISMATCH when connected target belongs to a different app", async () => {
  const { createDeviceResetStateHandler } = await import(MOD_PATH);
  const client = makeMockClient({
    connectedTarget: {
      id: "p1",
      title: "Hermes",
      vm: "Hermes",
      description: "com.actual.different",
      platform: "ios",
    },
    evaluateImpl: () => ({ value: JSON.stringify({ deleted: true }) }),
  });
  const handler = createDeviceResetStateHandler(() => client);
  const result = await handler({
    appId: "com.requested.app",
    platform: "ios",
    storageKeys: ["k1"],
    relaunch: false,
  });
  const env = parseEnvelope(result);
  const storage = env.data.steps.find((s) => s.step === "storage");
  assert.equal(storage.ok, false);
  assert.equal(storage.code, "CDP_TARGET_APP_MISMATCH");
  assert.match(storage.error, /com\.requested\.app/);
  // Crucially: evaluate must NOT have been called — that's the wrong-app
  // deletion that the guard prevents.
  assert.equal(
    client._calls.evaluate.length,
    0,
    "guard must short-circuit before any MMKV mutation",
  );
});

// ── Permission shorthand string defaults to revoke ──────────────────────

test("permissions string shorthand normalizes to action=revoke", async () => {
  const { createDeviceResetStateHandler } = await import(MOD_PATH);
  const client = makeMockClient({ isConnected: false });
  const handler = createDeviceResetStateHandler(() => client);
  const result = await handler({
    appId: "com.example.app",
    platform: "ios",
    permissions: ["notifications"],
    relaunch: false,
  });
  const env = parseEnvelope(result);
  const perm = env.data.steps.find((s) => s.step === "permission");
  assert.ok(perm);
  assert.equal(perm.target, "notifications");
  assert.equal(perm.action, "revoke");
});

test("permissions object form preserves action=reset", async () => {
  const { createDeviceResetStateHandler } = await import(MOD_PATH);
  const handler = createDeviceResetStateHandler(() => makeMockClient({ isConnected: false }));
  const result = await handler({
    appId: "com.example.app",
    platform: "ios",
    permissions: [{ name: "notifications", action: "reset" }],
    relaunch: false,
  });
  const env = parseEnvelope(result);
  const perm = env.data.steps.find((s) => s.step === "permission");
  assert.equal(perm.action, "reset");
});

// ── Relaunch flag controls launch/reconnect/helpers ─────────────────────

test("relaunch=false: no launch / reconnect / helpers steps in output", async () => {
  const { createDeviceResetStateHandler } = await import(MOD_PATH);
  const handler = createDeviceResetStateHandler(() => makeMockClient());
  const result = await handler({
    appId: "com.example.app",
    platform: "ios",
    relaunch: false,
  });
  const env = parseEnvelope(result);
  const stepNames = env.data.steps.map((s) => s.step);
  assert.ok(!stepNames.includes("launch"));
  assert.ok(!stepNames.includes("reconnect"));
  assert.ok(!stepNames.includes("helpers"));
  assert.equal(env.data.relaunch, false);
});

test("relaunch=true + waitForReady=false: launch runs, reconnect/helpers do not", async () => {
  const { createDeviceResetStateHandler } = await import(MOD_PATH);
  const handler = createDeviceResetStateHandler(() => makeMockClient());
  const result = await handler({
    appId: "com.example.app",
    platform: "ios",
    relaunch: true,
    waitForReady: false,
  });
  const env = parseEnvelope(result);
  const stepNames = env.data.steps.map((s) => s.step);
  assert.ok(stepNames.includes("launch"));
  assert.ok(!stepNames.includes("reconnect"));
  assert.ok(!stepNames.includes("helpers"));
  assert.equal(env.data.reconnected, false);
});

// ── Multi-LLM review fixes (Codex + Gemini) ─────────────────────────────

test('reconnectAttempted flag distinguishes "skipped reconnect" from "failed reconnect"', async () => {
  // Codex/Gemini: reconnected:false alone is ambiguous — it means both
  // "reconnect failed" and "reconnect never attempted". We add an explicit
  // reconnectAttempted boolean and assert both states.
  const { createDeviceResetStateHandler } = await import(MOD_PATH);

  // Case A: relaunch=false → reconnectAttempted MUST be false.
  const h1 = createDeviceResetStateHandler(() => makeMockClient());
  const r1 = await h1({ appId: "com.example.app", platform: "ios", relaunch: false });
  const e1 = parseEnvelope(r1);
  assert.equal(e1.data.reconnectAttempted, false, "relaunch=false → reconnect not attempted");
  assert.equal(e1.data.reconnected, false);

  // Case B: relaunch=true + waitForReady=false → reconnectAttempted MUST be false.
  const h2 = createDeviceResetStateHandler(() => makeMockClient());
  const r2 = await h2({ appId: "com.example.app", platform: "ios", waitForReady: false });
  const e2 = parseEnvelope(r2);
  assert.equal(e2.data.reconnectAttempted, false, "waitForReady=false → reconnect not attempted");
});

test("summary.failed does NOT double-count CDP_NOT_CONNECTED skips (Codex review)", async () => {
  // Codex: previously summary.failed and summary.skipped both counted
  // CDP_NOT_CONNECTED entries → failed >= skipped always. Fix: failed
  // is steps-with-ok-false MINUS skipped.
  const { createDeviceResetStateHandler } = await import(MOD_PATH);
  const handler = createDeviceResetStateHandler(() => makeMockClient({ isConnected: false }));
  const result = await handler({
    appId: "com.example.app",
    platform: "ios",
    storageKeys: ["k1", "k2", "k3"],
    relaunch: false,
  });
  const env = parseEnvelope(result);
  // 3 storage skips + 1 terminate (terminate may fail in sandbox; that's fine).
  // Critical: skipped MUST NOT be inflated into failed.
  assert.equal(env.data.summary.skipped, 3, "three storage keys skipped");
  // failed counts only NON-skipped failures (the terminate step's outcome).
  assert.ok(env.data.summary.failed <= 1, "failed should not include the 3 skipped entries");
});

test("all-skipped (CDP down + no relaunch) returns okResult — not failed", async () => {
  // Codex: when only skipped steps fail, the response should be ok-shape
  // because the skips were intentional (CDP not connected, partial reset).
  // We assert this for the storage-only-skip case where terminate succeeds.
  // (Terminate may fail in sandbox; we only assert the not-isError case
  // when it does succeed.)
  const { createDeviceResetStateHandler } = await import(MOD_PATH);
  const handler = createDeviceResetStateHandler(() => makeMockClient({ isConnected: false }));
  const result = await handler({
    appId: "com.example.app",
    platform: "ios",
    storageKeys: ["k1"],
    relaunch: false,
  });
  const env = parseEnvelope(result);
  // If terminate succeeded in the sandbox, the only failure is the skip,
  // so failed === 0 and the envelope is NOT isError.
  if (env.data.summary.failed === 0) {
    assert.notEqual(result.isError, true, "all-skipped + no real failures → not isError");
  }
  // If terminate also failed, we get warnResult — still not isError.
  assert.notEqual(result.isError, true, "all-skipped paths are never isError");
});

// ── Source guards ───────────────────────────────────────────────────────

test("source guard: device_reset_state tool registered in built index.js", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const indexSrc = readFileSync(join(__dirname, "../../dist/index.js"), "utf-8");
  assert.match(indexSrc, /['"]device_reset_state['"]/);
  assert.match(indexSrc, /createDeviceResetStateHandler/);
});

test("source guard: orchestrator imports buildMmkvExpression + terminateApp + launchApp", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(__dirname, "../../dist/tools/device-reset-state.js"), "utf-8");
  assert.match(src, /buildMmkvExpression/);
  assert.match(src, /terminateApp/);
  assert.match(src, /launchApp/);
});

test("source guard: shared app-lifecycle helpers exported", async () => {
  const { terminateApp, launchApp } = await import("../../dist/tools/app-lifecycle.js");
  assert.equal(typeof terminateApp, "function");
  assert.equal(typeof launchApp, "function");
});

test("source guard: startup-replay reuses extracted helpers (no inline launchApp)", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(__dirname, "../../dist/tools/startup-replay.js"), "utf-8");
  assert.match(src, /from "\.\/app-lifecycle\.js"|from '\.\/app-lifecycle\.js'/);
  assert.equal(
    /^function launchApp\b/m.test(src),
    false,
    "private launchApp should have been removed",
  );
});
