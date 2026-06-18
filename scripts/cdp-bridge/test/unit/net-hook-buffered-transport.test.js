import { test } from "node:test";
import assert from "node:assert/strict";
import { applyNetworkHookEntry } from "../../dist/cdp/event-handlers.js";
import { DeviceBufferManager } from "../../dist/ring-buffer.js";
import { NETWORK_CB_BUFFERED_SCRIPT } from "../../dist/injected-helpers.js";
import { drainNetworkHookBuffer } from "../../dist/cdp/net-hook-drain.js";

// Spec 2026-06-10-debugger-seat-optout Part 2: hook-mode network transport
// moves from console.log lines to an in-app ring buffer. applyNetworkHookEntry
// is the shared "entry → DeviceBufferManager" logic used by BOTH the legacy
// console-event path (back-compat, one release) and the new drain path.

function makeManager() {
  // Same construction as test/helpers/mock-cdp-client.js (the class lives in
  // src/ring-buffer.ts and takes an options object).
  return new DeviceBufferManager({
    capacityPerDevice: 100,
    maxDevices: 10,
    indexKey: (e) => e.id,
    timestampOf: (e) => new Date(e.timestamp).getTime(),
  });
}

test("applyNetworkHookEntry: request entry pushes into the buffer", () => {
  const mgr = makeManager();
  applyNetworkHookEntry("request", { id: "r1", method: "POST", url: "/api/x" }, mgr, "dev1");
  const all = mgr.getLast("dev1", 10);
  assert.equal(all.length, 1);
  assert.equal(all[0].id, "r1");
  assert.equal(all[0].method, "POST");
  assert.equal(all[0].url, "/api/x");
  assert.ok(all[0].timestamp);
});

test("applyNetworkHookEntry: response entry completes the matching request", () => {
  const mgr = makeManager();
  applyNetworkHookEntry("request", { id: "r1", method: "GET", url: "/a" }, mgr, "dev1");
  applyNetworkHookEntry("response", { id: "r1", status: 204, duration_ms: 17 }, mgr, "dev1");
  const entry = mgr.getByKey("dev1", "r1");
  assert.equal(entry.status, 204);
  assert.equal(entry.duration_ms, 17);
});

test("applyNetworkHookEntry: response without a matching request is a no-op", () => {
  const mgr = makeManager();
  applyNetworkHookEntry("response", { id: "ghost", status: 200, duration_ms: 1 }, mgr, "dev1");
  assert.equal(mgr.getLast("dev1", 10).length, 0);
});

test("applyNetworkHookEntry: unknown type is a no-op (forward-compat)", () => {
  const mgr = makeManager();
  applyNetworkHookEntry("telemetry", { id: "x" }, mgr, "dev1");
  assert.equal(mgr.getLast("dev1", 10).length, 0);
});

test("applyNetworkHookEntry: duplicate request id is not pushed twice", () => {
  const mgr = makeManager();
  applyNetworkHookEntry("request", { id: "r1", method: "GET", url: "/a" }, mgr, "dev1");
  applyNetworkHookEntry("request", { id: "r1", method: "GET", url: "/a" }, mgr, "dev1");
  assert.equal(mgr.getLast("dev1", 10).length, 1);
});

test("applyNetworkHookEntry: dedup keeps the FIRST entry (no upsert)", () => {
  const mgr = makeManager();
  applyNetworkHookEntry("request", { id: "r1", method: "GET", url: "/a" }, mgr, "dev1");
  applyNetworkHookEntry("request", { id: "r1", method: "GET", url: "/b" }, mgr, "dev1");
  assert.equal(mgr.getByKey("dev1", "r1").url, "/a");
});

test("applyNetworkHookEntry: second response overwrites (no dedup on responses)", () => {
  const mgr = makeManager();
  applyNetworkHookEntry("request", { id: "r1", method: "GET", url: "/a" }, mgr, "dev1");
  applyNetworkHookEntry("response", { id: "r1", status: 200, duration_ms: 5 }, mgr, "dev1");
  applyNetworkHookEntry("response", { id: "r1", status: 503, duration_ms: 9 }, mgr, "dev1");
  assert.equal(mgr.getByKey("dev1", "r1").status, 503);
});

// The callback definition is a JS string evaluated inside the app's Hermes
// context. Execute it here against an isolated fake globalThis to verify the
// ring-buffer semantics without a device.

function runCbScript() {
  const fakeGlobal = {};
  new Function("globalThis", NETWORK_CB_BUFFERED_SCRIPT)(fakeGlobal);
  return fakeGlobal;
}

test("NETWORK_CB_BUFFERED_SCRIPT: defines callback that pushes to __RN_AGENT_NET_BUF__", () => {
  const g = runCbScript();
  assert.equal(typeof g.__RN_AGENT_NETWORK_CB__, "function");
  const before = Date.now();
  g.__RN_AGENT_NETWORK_CB__("request", { id: "a", method: "GET", url: "/x" });
  const after = Date.now();
  const entry = g.__RN_AGENT_NET_BUF__[0];
  assert.equal(entry.t, "request");
  assert.deepEqual(entry.d, { id: "a", method: "GET", url: "/x" });
  assert.ok(typeof entry.ts === "number", "ts must be a number (ms epoch)");
  assert.ok(entry.ts >= before && entry.ts <= after, "ts must be ≈ Date.now() at push time");
});

// Fix 1(i): buffered entry includes numeric ts ≈ Date.now()
test("NETWORK_CB_BUFFERED_SCRIPT: buffered entry has numeric ts ≈ Date.now()", () => {
  const g = runCbScript();
  const before = Date.now();
  g.__RN_AGENT_NETWORK_CB__("request", { id: "ts-test", method: "POST", url: "/api/ts" });
  const after = Date.now();
  const entry = g.__RN_AGENT_NET_BUF__[0];
  assert.ok(typeof entry.ts === "number", "ts must be numeric");
  assert.ok(entry.ts >= before && entry.ts <= after, "ts must be within the call window");
});

test("NETWORK_CB_BUFFERED_SCRIPT: never calls console.log (the whole point)", () => {
  assert.ok(!NETWORK_CB_BUFFERED_SCRIPT.includes("console.log"));
  assert.ok(!NETWORK_CB_BUFFERED_SCRIPT.includes("__RN_NET__"));
});

test("NETWORK_CB_BUFFERED_SCRIPT: ring buffer caps at 100 (drop-oldest)", () => {
  const g = runCbScript();
  for (let i = 0; i < 150; i++) {
    g.__RN_AGENT_NETWORK_CB__("request", { id: "r" + i, method: "GET", url: "/x" });
  }
  assert.equal(g.__RN_AGENT_NET_BUF__.length, 100);
  assert.equal(g.__RN_AGENT_NET_BUF__[0].d.id, "r50");
  assert.equal(g.__RN_AGENT_NET_BUF__[99].d.id, "r149");
});

test("NETWORK_CB_BUFFERED_SCRIPT: re-running preserves an existing buffer", () => {
  const g = runCbScript();
  g.__RN_AGENT_NETWORK_CB__("request", { id: "keep", method: "GET", url: "/x" });
  new Function("globalThis", NETWORK_CB_BUFFERED_SCRIPT)(g);
  assert.equal(g.__RN_AGENT_NET_BUF__.length, 1, "reinjection must not wipe undrained entries");
});

test("NETWORK_CB_BUFFERED_SCRIPT: corrupted buffer is repaired and does not throw", () => {
  const g = runCbScript();
  g.__RN_AGENT_NET_BUF__ = "corrupted";
  assert.doesNotThrow(() =>
    g.__RN_AGENT_NETWORK_CB__("request", { id: "x", method: "GET", url: "/y" }),
  );
  assert.ok(Array.isArray(g.__RN_AGENT_NET_BUF__));
  assert.equal(g.__RN_AGENT_NET_BUF__.length, 1);
  assert.equal(g.__RN_AGENT_NET_BUF__[0].d.id, "x");
  assert.ok(typeof g.__RN_AGENT_NET_BUF__[0].ts === "number", "repaired entry still carries ts");
});

function makeDrainClient(bufEntries, mgr) {
  return {
    networkMode: "hook",
    activeDeviceKey: "dev1",
    networkBufferManager: mgr,
    evaluate: async () => ({ value: JSON.stringify(bufEntries) }),
  };
}

test("drainNetworkHookBuffer: merges drained entries into the manager", async () => {
  const mgr = makeManager();
  const client = makeDrainClient(
    [
      { t: "request", d: { id: "q1", method: "POST", url: "/api/otp" } },
      { t: "response", d: { id: "q1", status: 200, duration_ms: 758 } },
    ],
    mgr,
  );
  const drained = await drainNetworkHookBuffer(client);
  assert.equal(drained, 2);
  const entry = mgr.getByKey("dev1", "q1");
  assert.equal(entry.status, 200);
  assert.equal(entry.url, "/api/otp");
});

test("drainNetworkHookBuffer: no-op outside hook mode", async () => {
  const mgr = makeManager();
  const client = makeDrainClient([{ t: "request", d: { id: "x" } }], mgr);
  client.networkMode = "cdp";
  assert.equal(await drainNetworkHookBuffer(client), 0);
  assert.equal(mgr.getLast("dev1", 10).length, 0);
});

test("drainNetworkHookBuffer: evaluate failure is fail-open (0, no throw)", async () => {
  const mgr = makeManager();
  const client = makeDrainClient([], mgr);
  client.evaluate = async () => ({ error: "app reloaded" });
  assert.equal(await drainNetworkHookBuffer(client), 0);
});

test("drainNetworkHookBuffer: evaluate throw is fail-open (0, no throw)", async () => {
  const mgr = makeManager();
  const client = makeDrainClient([], mgr);
  client.evaluate = async () => {
    throw new Error("socket closed");
  };
  assert.equal(await drainNetworkHookBuffer(client), 0);
});

test("drainNetworkHookBuffer: malformed payload is fail-open", async () => {
  const mgr = makeManager();
  const client = makeDrainClient([], mgr);
  client.evaluate = async () => ({ value: "{ not json" });
  assert.equal(await drainNetworkHookBuffer(client), 0);
});

test("drainNetworkHookBuffer: malformed single entries are skipped, valid ones applied", async () => {
  const mgr = makeManager();
  const client = makeDrainClient(
    [
      null,
      { nope: true },
      { t: "request", d: { id: 42 } },
      { t: "request", d: { id: "ok1", method: "GET", url: "/good" } },
    ],
    mgr,
  );
  const drained = await drainNetworkHookBuffer(client);
  assert.equal(drained, 1);
  assert.equal(mgr.getByKey("dev1", "ok1").url, "/good");
});

// Fix 1(ii): entry with ts:<fixed epoch ms> lands in manager with timestamp === new Date(fixed).toISOString()
test("drainNetworkHookBuffer: entry with ts propagates app-side timestamp to the manager", async () => {
  const FIXED_EPOCH_MS = 1_700_000_000_000; // 2023-11-14T22:13:20.000Z
  const mgr = makeManager();
  const client = makeDrainClient(
    [{ t: "request", d: { id: "ts-req", method: "GET", url: "/timed" }, ts: FIXED_EPOCH_MS }],
    mgr,
  );
  await drainNetworkHookBuffer(client);
  const entry = mgr.getByKey("dev1", "ts-req");
  assert.equal(
    entry.timestamp,
    new Date(FIXED_EPOCH_MS).toISOString(),
    "drain must forward app-side ts so the request is stamped at fire-time, not drain-time",
  );
});

test("drainNetworkHookBuffer: entry without ts falls back to arrival-time (still a valid ISO string)", async () => {
  const before = Date.now();
  const mgr = makeManager();
  const client = makeDrainClient(
    [{ t: "request", d: { id: "no-ts", method: "GET", url: "/no-ts" } }],
    mgr,
  );
  await drainNetworkHookBuffer(client);
  const after = Date.now();
  const entry = mgr.getByKey("dev1", "no-ts");
  const stamped = new Date(entry.timestamp).getTime();
  assert.ok(!isNaN(stamped), "fallback timestamp must be a valid ISO date");
  assert.ok(stamped >= before && stamped <= after, "fallback must be ≈ drain time");
});

test("drainNetworkHookBuffer: non-numeric ts is treated as absent (falls back to arrival-time)", async () => {
  const before = Date.now();
  const mgr = makeManager();
  const client = makeDrainClient(
    [{ t: "request", d: { id: "bad-ts", method: "GET", url: "/bad-ts" }, ts: "not-a-number" }],
    mgr,
  );
  await drainNetworkHookBuffer(client);
  const after = Date.now();
  const entry = mgr.getByKey("dev1", "bad-ts");
  const stamped = new Date(entry.timestamp).getTime();
  assert.ok(!isNaN(stamped), "must still produce a valid timestamp");
  assert.ok(
    stamped >= before && stamped <= after,
    "non-numeric ts discarded, fallback is arrival-time",
  );
});

// Fix 1(iii): applyNetworkHookEntry with explicit atMs uses it; without, uses now
test("applyNetworkHookEntry: explicit atMs is used for the request timestamp", () => {
  const FIXED_MS = 1_600_000_000_000;
  const mgr = makeManager();
  applyNetworkHookEntry(
    "request",
    { id: "atms1", method: "GET", url: "/at" },
    mgr,
    "dev1",
    FIXED_MS,
  );
  const entry = mgr.getByKey("dev1", "atms1");
  assert.equal(entry.timestamp, new Date(FIXED_MS).toISOString());
});

test("applyNetworkHookEntry: without atMs timestamp falls back to approximately now", () => {
  const before = Date.now();
  const mgr = makeManager();
  applyNetworkHookEntry("request", { id: "atms2", method: "GET", url: "/at" }, mgr, "dev1");
  const after = Date.now();
  const stamped = new Date(mgr.getByKey("dev1", "atms2").timestamp).getTime();
  assert.ok(stamped >= before && stamped <= after);
});
