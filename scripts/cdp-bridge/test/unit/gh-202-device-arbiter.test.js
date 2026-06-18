import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DeviceSessionArbiter,
  planeForTool,
  arbiterWrap,
} from "../../dist/lifecycle/device-arbiter.js";

test("GH#202 introspection + interaction coexist (shared)", () => {
  const a = new DeviceSessionArbiter();
  const r1 = a.tryAcquire("introspection", "cdp_store_state");
  const r2 = a.tryAcquire("interaction", "device_press");
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  a.release(r1.lease);
  a.release(r2.lease);
});

test("GH#202 flow is exclusive: refused while any op is active, and names the blocker", () => {
  const a = new DeviceSessionArbiter();
  const r1 = a.tryAcquire("interaction", "device_press");
  const rf = a.tryAcquire("flow", "maestro_run");
  assert.equal(rf.ok, false);
  assert.equal(rf.code, "BUSY_FLOW_ACTIVE");
  assert.equal(rf.holder.tool, "device_press");
  assert.equal(rf.holder.plane, "interaction");
  a.release(r1.lease);
  assert.equal(a.tryAcquire("flow", "maestro_run").ok, true);
});

test("GH#202 reads/taps refused while a flow lease is held; holder is the flow", () => {
  const a = new DeviceSessionArbiter();
  const rf = a.tryAcquire("flow", "maestro_run");
  assert.equal(rf.ok, true);
  const ri = a.tryAcquire("introspection", "cdp_store_state");
  const rx = a.tryAcquire("interaction", "device_press");
  assert.equal(ri.ok, false);
  assert.equal(ri.code, "BUSY_FLOW_ACTIVE");
  assert.equal(rx.ok, false);
  assert.equal(ri.holder.opId, rf.lease.opId);
  assert.equal(ri.holder.tool, "maestro_run");
  a.release(rf.lease);
  assert.equal(a.tryAcquire("introspection", "cdp_store_state").ok, true);
});

test("GH#202 release is idempotent and only frees its own op", () => {
  const a = new DeviceSessionArbiter();
  const r1 = a.tryAcquire("interaction", "device_press");
  a.release(r1.lease);
  a.release(r1.lease);
  assert.equal(a.tryAcquire("flow", "maestro_run").ok, true);
});

test("GH#202 reset() clears a leaked lease so flows can run again", () => {
  const a = new DeviceSessionArbiter();
  a.tryAcquire("flow", "maestro_run");
  assert.equal(a.tryAcquire("flow", "maestro_run").ok, false);
  const r = a.reset("test");
  assert.equal(r.hadFlow, true);
  assert.ok(r.clearedOps >= 1);
  assert.equal(a.tryAcquire("flow", "maestro_run").ok, true);
});

test("GH#202 planeForTool: flow incl. auto-login/reload/restart; mutating CDP = interaction", () => {
  assert.equal(planeForTool("maestro_run"), "flow");
  assert.equal(planeForTool("cdp_run_action"), "flow");
  assert.equal(planeForTool("cdp_auto_login"), "flow");
  assert.equal(planeForTool("cdp_reload"), "flow");
  assert.equal(planeForTool("cdp_restart"), "flow");
  assert.equal(planeForTool("device_press"), "interaction");
  assert.equal(planeForTool("cdp_navigate"), "interaction");
  assert.equal(planeForTool("cdp_dispatch"), "interaction");
  assert.equal(planeForTool("cdp_store_state"), "introspection");
  assert.equal(planeForTool("cdp_status"), null);
  assert.equal(planeForTool("cdp_connect"), null);
  assert.equal(planeForTool("device_list"), null);
});

test("GH#202 arbiterWrap refuses with a TOP-LEVEL code while a flow runs, then frees it", async () => {
  const a = new DeviceSessionArbiter();
  let releaseFlow;
  const flowGate = new Promise((res) => {
    releaseFlow = res;
  });
  const flow = arbiterWrap(
    "maestro_run",
    async () => {
      await flowGate;
      return { ok: true };
    },
    a,
  );
  const tap = arbiterWrap("device_press", async () => ({ ok: true, _t: "tap-done" }), a);
  const flowP = flow({});
  await Promise.resolve();
  const refused = await tap({});
  const env = JSON.parse(refused.content[0].text);
  assert.equal(env.code, "BUSY_FLOW_ACTIVE");
  releaseFlow();
  await flowP;
  const tap2 = await tap({});
  assert.equal(tap2._t, "tap-done");
});

test("GH#202 arbiterWrap passes through unarbitrated tools untouched (even mid-flow)", async () => {
  const a = new DeviceSessionArbiter();
  const status = arbiterWrap("cdp_status", async () => ({ _t: "status" }), a);
  const rf = a.tryAcquire("flow", "maestro_run");
  assert.equal((await status({}))._t, "status");
  a.release(rf.lease);
});
