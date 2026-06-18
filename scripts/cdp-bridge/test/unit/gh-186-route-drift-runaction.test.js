// GH #186 P1: run-action reclassifies a SELECTOR_NOT_FOUND as ROUTE_DRIFT (and
// SKIPS the fuzzy selector repair) when the action recorded an expected route
// sequence and the live route is off it — a screen was inserted/changed.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createRunActionHandler } from "../../dist/tools/run-action.js";
import { createTmpProject } from "../helpers/tmp-project.js";

const FAIL_SELECTOR_ENV = {
  ok: false,
  data: {
    passed: false,
    output: "Element with id 'addr-line1' not found",
    flowFile: "x",
    platform: "ios",
  },
};
const fakeMaestroRun = (env) => async () => ({
  content: [{ type: "text", text: JSON.stringify(env) }],
  isError: true,
});

const ACTION_YAML = [
  "# id: demo",
  "# intent: address flow",
  "# status: active",
  "# expectedRouteSequence: [HomeAddress, PhoneNumber]",
  "",
  "- tapOn:",
  '    id: "addr-line1"',
].join("\n");

let project;
beforeEach(() => {
  project = createTmpProject();
});
afterEach(() => {
  project.cleanup();
});

function parse(r) {
  return JSON.parse(r.content[0].text);
}

test("SELECTOR_NOT_FOUND on an OFF-sequence live route → ROUTE_DRIFT, repair skipped", async () => {
  project.seedAction("demo", ACTION_YAML);
  let repairCalled = false;
  const handler = createRunActionHandler({
    maestroRun: fakeMaestroRun(FAIL_SELECTOR_ENV),
    repairAction: async () => {
      repairCalled = true;
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: true, data: { patched: true } }) }],
      };
    },
    getLiveRoute: async () => "CouponCode", // an inserted screen, not in the expected sequence
  });
  const env = parse(await handler({ actionId: "demo", projectRoot: project.root }));
  assert.equal(env.ok, false);
  assert.equal(env.code, "ROUTE_DRIFT");
  assert.equal(repairCalled, false, "fuzzy selector repair must be skipped on structural drift");
});

test("SELECTOR_NOT_FOUND on an EXPECTED live route still attempts repair (not drift)", async () => {
  project.seedAction("demo", ACTION_YAML);
  let repairCalled = false;
  const handler = createRunActionHandler({
    maestroRun: fakeMaestroRun(FAIL_SELECTOR_ENV),
    repairAction: async () => {
      repairCalled = true;
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: false, data: { patched: false } }) }],
      };
    },
    getLiveRoute: async () => "PhoneNumber", // on the expected sequence → not drift
  });
  await handler({ actionId: "demo", projectRoot: project.root });
  assert.equal(repairCalled, true, "an expected-route selector failure should still go to repair");
});

test("no expectedRouteSequence → drift check is inert, repair attempted as before", async () => {
  project.seedAction(
    "demo",
    ["# id: demo", "# intent: x", "# status: active", "", "- tapOn:", '    id: "addr-line1"'].join(
      "\n",
    ),
  );
  let repairCalled = false;
  const handler = createRunActionHandler({
    maestroRun: fakeMaestroRun(FAIL_SELECTOR_ENV),
    repairAction: async () => {
      repairCalled = true;
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: false, data: { patched: false } }) }],
      };
    },
    getLiveRoute: async () => "CouponCode", // would be drift IF a sequence were recorded
  });
  await handler({ actionId: "demo", projectRoot: project.root });
  assert.equal(repairCalled, true, "without a recorded sequence the drift check must not fire");
});
