import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createRunActionHandler } from "../../dist/tools/run-action.js";
import { loadAction } from "../../dist/domain/action-store.js";
import { createTmpProject, fixtureYaml } from "../helpers/tmp-project.js";

let project;
beforeEach(() => {
  project = createTmpProject();
});
afterEach(() => {
  project.cleanup();
});

function fakeMaestroRun(envelopes) {
  let i = 0;
  return async () => {
    const env = envelopes[Math.min(i, envelopes.length - 1)];
    i++;
    return {
      content: [{ type: "text", text: JSON.stringify(env) }],
      ...(env.ok === false ? { isError: true } : {}),
    };
  };
}

const PASS_ENV = {
  ok: true,
  data: { passed: true, output: "Flow passed", flowFile: "x", platform: "ios" },
};

// Audit H5: the documented "first clean replay auto-promotes experimental →
// active" lifecycle was never wired into a call site. A clean run must flip the
// on-disk status.
test("H5: a clean replay promotes an experimental action to active", async () => {
  project.seedAction("demo", fixtureYaml({ id: "demo", status: "experimental" }));

  const handler = createRunActionHandler({ maestroRun: fakeMaestroRun([PASS_ENV]) });
  const res = await handler({ actionId: "demo", projectRoot: project.root, platform: "ios" });
  assert.equal(res.isError, undefined, "the run should succeed");

  const reloaded = loadAction(project.root, "demo");
  assert.equal(
    reloaded.metadata.status,
    "active",
    "experimental must be promoted to active after a clean replay",
  );
});

test("H5: an already-active action stays active (no spurious churn)", async () => {
  project.seedAction("demo", fixtureYaml({ id: "demo", status: "active" }));
  const handler = createRunActionHandler({ maestroRun: fakeMaestroRun([PASS_ENV]) });
  await handler({ actionId: "demo", projectRoot: project.root, platform: "ios" });
  assert.equal(loadAction(project.root, "demo").metadata.status, "active");
});

// Audit M1: the ROUTE_DRIFT guard only fires when a CDP-backed getLiveRoute is
// supplied. The default no-op leaves it inert — so the DI seam must, when wired,
// actually reclassify a selector failure on an off-sequence screen as drift.
const FAIL_SELECTOR_ENV = {
  ok: false,
  data: {
    passed: false,
    output: "Element with id 'fab-create-task' not found",
    flowFile: "x",
    platform: "ios",
  },
};

test("M1: a wired getLiveRoute reclassifies an off-sequence selector failure as ROUTE_DRIFT", async () => {
  // Seed an action whose recorded route sequence expects [Home, Detail] but the
  // live route is an unexpected screen → drift, not a stale selector.
  const yaml = [
    "appId: com.test.app",
    "---",
    "# id: demo",
    "# intent: drift fixture",
    "# tags: [fixture]",
    "# mutates: false",
    "# status: active",
    "# expectedRouteSequence: [Home, Detail]",
    "",
    "- launchApp",
    "  - tapOn:",
    '      id: "fab-create-task"',
    "",
  ].join("\n");
  project.seedAction("demo", yaml);

  const handler = createRunActionHandler({
    maestroRun: fakeMaestroRun([FAIL_SELECTOR_ENV]),
    getLiveRoute: async () => "CouponCode", // an unexpected, off-sequence screen
  });
  const res = await handler({
    actionId: "demo",
    projectRoot: project.root,
    platform: "ios",
    autoRepair: true,
  });

  assert.equal(res.isError, true, "an off-sequence failure should not silently pass");
  const text = res.content?.[0]?.text ?? "";
  assert.match(
    text,
    /ROUTE_DRIFT|route-drift/i,
    "failure should be classified as route drift, not routed into selector repair",
  );
});
