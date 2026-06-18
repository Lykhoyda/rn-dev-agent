// Live-sim speedup (GH #321, quick win #4): device_batch returns a compact
// SALIENT final payload (only actionable a11y nodes) by default instead of the
// full snapshot, and a `finalSnapshot: 'none'` option skips the implicit
// trailing snapshot entirely (~1,450 ms saved for action-only batches).
import { test } from "node:test";
import assert from "node:assert/strict";
import { salientizeSnapshotData, createDeviceBatchHandler } from "../../dist/tools/device-batch.js";
import {
  _setRunAgentDeviceForTest,
  setActiveSessionInMemoryForTest,
  resetActiveSessionInMemoryForTest,
} from "../../dist/agent-device-wrapper.js";

const FULL = {
  nodes: [
    {
      ref: "@e0",
      type: "Application",
      label: "app",
      rect: { x: 0, y: 0, width: 1, height: 1 },
      enabled: true,
      hittable: true,
    },
    {
      ref: "@e1",
      type: "StaticText",
      label: "Welcome",
      rect: { x: 0, y: 0, width: 1, height: 1 },
      enabled: true,
    },
    {
      ref: "@e2",
      type: "Button",
      label: "Submit",
      identifier: "submit-btn",
      rect: { x: 0, y: 0, width: 1, height: 1 },
      enabled: true,
      hittable: true,
    },
    {
      ref: "@e3",
      type: "TextField",
      label: "",
      identifier: "email",
      rect: { x: 0, y: 0, width: 1, height: 1 },
      enabled: true,
      hittable: true,
    },
    {
      ref: "@e4",
      type: "Switch",
      label: "Notifications",
      rect: { x: 0, y: 0, width: 1, height: 1 },
      enabled: true,
      hittable: true,
    },
    {
      ref: "@e5",
      type: "Image",
      identifier: "house.fill",
      rect: { x: 0, y: 0, width: 1, height: 1 },
    },
  ],
};

// ── pure salientizer ────────────────────────────────────────────────────

test("salientizeSnapshotData keeps actionable types AND any identified (testID) node", () => {
  const out = salientizeSnapshotData(FULL);
  const types = out.nodes.map((n) => n.type).sort();
  // Button/TextField/Switch by type; the Image is kept because it has an identifier.
  assert.deepEqual(types, ["Button", "Image", "Switch", "TextField"]);
  assert.equal(out.salient, true);
  assert.equal(out.fullNodeCount, 6);
});

test("salientizeSnapshotData keeps a testID-bearing node even when its type is not interactive (fail-safe)", () => {
  const data = {
    nodes: [
      {
        ref: "@e0",
        type: "Other",
        identifier: "custom-pressable",
        label: "Tap me",
        hittable: true,
      },
      { ref: "@e1", type: "Other", label: "decorative wrapper" }, // no testID, non-interactive -> dropped
    ],
  };
  const out = salientizeSnapshotData(data);
  assert.deepEqual(
    out.nodes.map((n) => n.identifier),
    ["custom-pressable"],
  );
  assert.equal(out.nodes.length, 1, "a custom Pressable surfacing as type Other is NOT dropped");
});

test("salientizeSnapshotData compacts entries (drops rect/enabled) but keeps ref/identifier", () => {
  const out = salientizeSnapshotData(FULL);
  const btn = out.nodes.find((n) => n.identifier === "submit-btn");
  assert.equal(btn.ref, "@e2");
  assert.equal(btn.label, "Submit");
  assert.equal(btn.rect, undefined);
  assert.equal(btn.enabled, undefined);
});

test("salientizeSnapshotData passes through non-node data (e.g. a screenshot result)", () => {
  const shot = { path: "/tmp/x.jpg", resize: { width: 800 } };
  assert.deepEqual(salientizeSnapshotData(shot), shot);
});

test("salientizeSnapshotData tolerates missing/empty nodes", () => {
  assert.deepEqual(salientizeSnapshotData({ nodes: [] }), {
    nodes: [],
    salient: true,
    fullNodeCount: 0,
  });
  assert.deepEqual(salientizeSnapshotData(null), null);
});

// ── handler wiring ──────────────────────────────────────────────────────

function envelope(data) {
  return { content: [{ type: "text", text: JSON.stringify({ ok: true, data }) }] };
}

test("device_batch default returns a SALIENT final snapshot", async () => {
  let snapshots = 0;
  _setRunAgentDeviceForTest((cliArgs) => {
    if (cliArgs[0] === "snapshot") snapshots++;
    return Promise.resolve(envelope(FULL));
  });
  setActiveSessionInMemoryForTest({
    name: "t",
    platform: "ios",
    appId: "com.test",
    openedAt: "now",
  });
  try {
    const handler = createDeviceBatchHandler();
    const res = await handler({ steps: [{ action: "wait", ms: 0 }], delayMs: 0 });
    const body = JSON.parse(res.content[0].text);
    assert.equal(body.ok, true);
    assert.equal(body.data.final_snapshot.salient, true, "default final payload is salient");
    assert.equal(snapshots, 1, "one trailing snapshot taken");
  } finally {
    _setRunAgentDeviceForTest(null);
    resetActiveSessionInMemoryForTest();
  }
});

test("device_batch finalSnapshot:'none' skips the implicit trailing snapshot", async () => {
  let snapshots = 0;
  _setRunAgentDeviceForTest((cliArgs) => {
    if (cliArgs[0] === "snapshot") snapshots++;
    return Promise.resolve(envelope(FULL));
  });
  setActiveSessionInMemoryForTest({
    name: "t",
    platform: "ios",
    appId: "com.test",
    openedAt: "now",
  });
  try {
    const handler = createDeviceBatchHandler();
    const res = await handler({
      steps: [{ action: "wait", ms: 0 }],
      delayMs: 0,
      finalSnapshot: "none",
    });
    const body = JSON.parse(res.content[0].text);
    assert.equal(body.ok, true);
    assert.equal(snapshots, 0, "no trailing snapshot round-trip when finalSnapshot=none");
    assert.equal(body.data.final_snapshot ?? null, null);
  } finally {
    _setRunAgentDeviceForTest(null);
    resetActiveSessionInMemoryForTest();
  }
});

test("device_batch finalSnapshot:'full' preserves the full node list", async () => {
  _setRunAgentDeviceForTest(() => Promise.resolve(envelope(FULL)));
  setActiveSessionInMemoryForTest({
    name: "t",
    platform: "ios",
    appId: "com.test",
    openedAt: "now",
  });
  try {
    const handler = createDeviceBatchHandler();
    const res = await handler({
      steps: [{ action: "wait", ms: 0 }],
      delayMs: 0,
      finalSnapshot: "full",
    });
    const body = JSON.parse(res.content[0].text);
    assert.equal(body.data.final_snapshot.nodes.length, 6, "full node list preserved");
    assert.equal(body.data.final_snapshot.salient, undefined);
  } finally {
    _setRunAgentDeviceForTest(null);
    resetActiveSessionInMemoryForTest();
  }
});
