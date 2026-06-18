#!/usr/bin/env node
// Behavioral test: instrumentTool must time the call and notify the observer
// with the right status (PASS / FAIL / ERROR). Runs against the built dist.
import assert from "node:assert";
import {
  instrumentTool,
  setToolObserver,
} from "../cdp-bridge/dist/observability/instrumentation.js";

const seen = [];
setToolObserver((o) => seen.push(o));

const okTool = instrumentTool("demo_ok", async () => ({ content: [{ text: '{"ok":true}' }] }));
await okTool({ a: 1 });

const failTool = instrumentTool("demo_fail", async () => ({
  content: [{ text: '{"ok":false,"error":"boom"}' }],
}));
await failTool({});

const errTool = instrumentTool("demo_err", async () => {
  throw new Error("kaboom");
});
await assert.rejects(() => errTool({}), /kaboom/);

assert.equal(seen.length, 3, `expected 3 observations, got ${seen.length}`);
assert.equal(seen[0].tool, "demo_ok");
assert.equal(seen[0].status, "PASS");
assert.equal(seen[1].tool, "demo_fail");
assert.equal(seen[1].status, "FAIL");
assert.equal(seen[1].error, "boom");
assert.equal(seen[2].tool, "demo_err");
assert.equal(seen[2].status, "ERROR");
assert.ok(typeof seen[0].latencyMs === "number");
console.log("PASS instrumentation.test.mjs");
