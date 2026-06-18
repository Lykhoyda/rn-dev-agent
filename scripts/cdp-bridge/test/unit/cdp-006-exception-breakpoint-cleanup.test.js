// CDP-006: exception breakpoint timed-capture handler cleanup.
// Previously: the temporary Debugger.paused handler was only restored
// when a prior handler existed; if none did, the temp handler stayed in
// the event-handler map and resumed unrelated pauses in later flows.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createExceptionBreakpointHandler } from "../../dist/tools/exception-breakpoint.js";
import { createMockClient } from "../helpers/mock-cdp-client.js";

function buildClient() {
  const client = createMockClient();
  client["eventHandlers"] = new Map();
  // record send calls so we can assert state transitions
  client.send = async (method) => {
    if (method === "Debugger.setPauseOnExceptions") return undefined;
    if (method === "Debugger.resume") return undefined;
    return undefined;
  };
  return client;
}

test("CDP-006: when no prior Debugger.paused handler, temp handler is DELETED after capture", async () => {
  const client = buildClient();
  // Sanity: no prior handler.
  assert.equal(client["eventHandlers"].has("Debugger.paused"), false);
  const handler = createExceptionBreakpointHandler(() => client);
  await handler({ state: "uncaught", durationMs: 1000 });
  // After cleanup the map must NOT contain a Debugger.paused entry.
  assert.equal(
    client["eventHandlers"].has("Debugger.paused"),
    false,
    "temp capture handler must be removed when no prior handler existed",
  );
});

test("CDP-006: when a prior Debugger.paused handler existed, it is RESTORED (regression preserved)", async () => {
  const client = buildClient();
  const original = () => "original-handler";
  client["eventHandlers"].set("Debugger.paused", original);
  const handler = createExceptionBreakpointHandler(() => client);
  await handler({ state: "uncaught", durationMs: 1000 });
  assert.equal(
    client["eventHandlers"].get("Debugger.paused"),
    original,
    "prior handler must be restored unchanged",
  );
});

test("CDP-006: same cleanup runs on the error/throw path (no leak on failure)", async () => {
  const client = buildClient();
  client.send = async (method) => {
    if (method === "Debugger.setPauseOnExceptions") {
      // Simulate setup failure
      throw new Error("setPauseOnExceptions blew up");
    }
    return undefined;
  };
  const handler = createExceptionBreakpointHandler(() => client);
  await handler({ state: "uncaught", durationMs: 1000 });
  assert.equal(
    client["eventHandlers"].has("Debugger.paused"),
    false,
    "temp handler must not leak on the error path either",
  );
});
