// CDP-001: cdp_connect must NOT short-circuit alreadyConnected when the
// requested filter dimensions (targetId / bundleId / metroPort / platform)
// don't match the current target. Previous logic only checked platform and
// silently kept stale targets attached.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createConnectHandler } from "../../dist/tools/connection.js";
import { createMockClient } from "../helpers/mock-cdp-client.js";

function buildHarness(
  currentTarget = {
    id: "old-page",
    title: "React Native (Hermes)",
    vm: "Hermes",
    description: "com.old.app",
    platform: "ios",
    webSocketDebuggerUrl: "ws://127.0.0.1:8081/debugger/old-page",
  },
  currentPort = 8081,
) {
  const client = createMockClient({
    _connectedTarget: currentTarget,
    _metroPort: currentPort,
  });
  let disconnectCalls = 0;
  client.disconnect = async () => {
    disconnectCalls++;
    client._isConnected = false;
  };
  let autoConnectArgs = null;
  client.autoConnect = async (port, opts) => {
    autoConnectArgs = { port, opts };
    client._isConnected = true;
    return "connected";
  };
  let createCalls = [];
  const createClient = (port) => {
    createCalls.push(port);
    return client;
  };
  const setClient = () => {};
  return {
    client,
    handler: createConnectHandler(() => client, setClient, createClient),
    counts: () => ({ disconnects: disconnectCalls, creates: createCalls.slice() }),
    autoConnect: () => autoConnectArgs,
  };
}

test("CDP-001: same target + same port + matching platform → alreadyConnected (fast path preserved)", async () => {
  const h = buildHarness();
  const result = await h.handler({
    platform: "ios",
    metroPort: 8081,
    targetId: "old-page",
    bundleId: "com.old.app",
  });
  const data = JSON.parse(result.content[0].text);
  assert.equal(data.ok, true);
  assert.equal(data.data.alreadyConnected, true);
  assert.equal(h.counts().disconnects, 0);
  assert.equal(h.autoConnect(), null, "should not have called autoConnect");
});

test("CDP-001: targetId mismatch must trigger disconnect + reconnect with requested filters", async () => {
  const h = buildHarness();
  await h.handler({ targetId: "new-page" });
  assert.equal(h.counts().disconnects, 1, "must disconnect when targetId differs");
  const ac = h.autoConnect();
  assert.ok(ac, "must have called autoConnect");
  assert.equal(ac.opts.targetId, "new-page");
});

test("CDP-001: bundleId mismatch must trigger disconnect + reconnect", async () => {
  const h = buildHarness();
  await h.handler({ bundleId: "com.different.app" });
  assert.equal(h.counts().disconnects, 1);
  const ac = h.autoConnect();
  assert.equal(ac.opts.bundleId, "com.different.app");
});

test("CDP-001: metroPort mismatch must trigger disconnect + reconnect on requested port", async () => {
  const h = buildHarness(undefined, 8081);
  await h.handler({ metroPort: 9999 });
  assert.equal(h.counts().disconnects, 1);
  const ac = h.autoConnect();
  assert.equal(ac.port, 9999);
});

test("CDP-001: platform mismatch (ios target, requested android) must reconnect", async () => {
  const h = buildHarness({
    id: "p1",
    title: "iOS hermes",
    vm: "Hermes",
    description: "com.old.app",
    platform: "ios",
    webSocketDebuggerUrl: "ws://127.0.0.1:8081/debugger/p1",
  });
  await h.handler({ platform: "android" });
  assert.equal(h.counts().disconnects, 1, "platform mismatch must reconnect");
});

test("CDP-001: bundleId match by description (case-insensitive) keeps fast path", async () => {
  const h = buildHarness({
    id: "page1",
    title: "React Native (Hermes)",
    vm: "Hermes",
    description: "COM.OLD.APP",
    platform: "ios",
    webSocketDebuggerUrl: "ws://127.0.0.1:8081/debugger/page1",
  });
  const result = await h.handler({ bundleId: "com.old.app" });
  const data = JSON.parse(result.content[0].text);
  assert.equal(data.data.alreadyConnected, true);
  assert.equal(h.counts().disconnects, 0);
});

test("CDP-001: no filters at all → alreadyConnected (no over-eager reconnect)", async () => {
  const h = buildHarness();
  const result = await h.handler({});
  const data = JSON.parse(result.content[0].text);
  assert.equal(data.data.alreadyConnected, true);
  assert.equal(h.counts().disconnects, 0);
});

test("CDP-001: multi-mismatch (targetId + bundleId) only disconnects once", async () => {
  const h = buildHarness();
  await h.handler({ targetId: "new", bundleId: "com.other" });
  assert.equal(h.counts().disconnects, 1, "should not double-disconnect on multi-filter mismatch");
});

// ── Phase 134.5 (deepsec BUG: substring bundleId match) ────────────
// The prior `haystack.includes(bundleId)` would treat `com.old.app`
// as "already connected" when the live target was actually
// `com.old.app-test` or `com.old.app2`. The fix uses a regex with
// non-bundle-id boundary characters so the match is anchored.

test("Phase 134.5: bundleId `com.old.app` does NOT match haystack containing `com.old.app-test` (regression)", async () => {
  // Live target is com.old.app-test, caller asks for com.old.app.
  // Substring match would say "already connected" wrongly.
  const h = buildHarness({
    id: "page1",
    title: "com.old.app-test (Hermes)",
    vm: "Hermes",
    description: "com.old.app-test",
    platform: "ios",
    webSocketDebuggerUrl: "ws://127.0.0.1:8081/debugger/page1",
  });
  const result = await h.handler({ bundleId: "com.old.app" });
  const data = JSON.parse(result.content[0].text);
  // Bundle mismatch should trigger reconnect, NOT alreadyConnected
  assert.notEqual(
    data.data?.alreadyConnected,
    true,
    "must NOT short-circuit on substring false-positive",
  );
  assert.equal(h.counts().disconnects, 1, "should reconnect to fetch the correct target");
});

test("Phase 134.5: bundleId `com.old.app` does NOT match haystack containing `com.old.app2` (regression)", async () => {
  const h = buildHarness({
    id: "page1",
    title: "com.old.app2 (Hermes)",
    vm: "Hermes",
    description: "com.old.app2",
    platform: "ios",
    webSocketDebuggerUrl: "ws://127.0.0.1:8081/debugger/page1",
  });
  const result = await h.handler({ bundleId: "com.old.app" });
  const data = JSON.parse(result.content[0].text);
  assert.notEqual(data.data?.alreadyConnected, true);
  assert.equal(h.counts().disconnects, 1);
});

test("Phase 134.5: bundleId match still works when surrounded by punctuation (positive parity)", async () => {
  // Haystack with the bundleId as a standalone token bordered by
  // whitespace + brackets. The word-boundary check still recognizes it.
  const h = buildHarness({
    id: "page1",
    title: "React Native [com.old.app] (Hermes)",
    vm: "Hermes",
    description: "app: com.old.app, target: page1",
    platform: "ios",
    webSocketDebuggerUrl: "ws://127.0.0.1:8081/debugger/page1",
  });
  const result = await h.handler({ bundleId: "com.old.app" });
  const data = JSON.parse(result.content[0].text);
  assert.equal(data.data.alreadyConnected, true, "whole-token match still recognized");
  assert.equal(h.counts().disconnects, 0);
});
