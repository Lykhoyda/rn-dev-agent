// GH #173 (sub-issue 3): cdp_run_action's `forceReload` flag acknowledges
// any human edit to the YAML as the new baseline before running. With the
// default `forceReload: true`, downstream cdp_repair_action no longer
// aborts with STALE_TARGET when the human is actively composing the YAML
// — that's the high-frequency friction the issue reports. Opt out with
// `forceReload: false` to get the Phase 129 "respect external edits"
// behavior back (the right choice for CI replays of fixed baselines).
//
// Tests are split into two layers:
//   1. `acknowledgeExternalEdit` helper — verifies the side effect:
//      sidecar's lastSeenMtimeMs is bumped to match the YAML's current
//      stat-mtime, and the no-op path (mtime unchanged) does not write.
//   2. `cdp_run_action` handler — verifies the flag is wired and acted
//      on: forceReload=true (default) bumps the sidecar BEFORE the run;
//      forceReload=false leaves the sidecar untouched.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createRunActionHandler } from "../../dist/tools/run-action.js";
import { acknowledgeExternalEdit, loadAction } from "../../dist/domain/action-store.js";
import { createTmpProject, fixtureYaml } from "../helpers/tmp-project.js";

let project;

beforeEach(() => {
  project = createTmpProject();
});

afterEach(() => {
  project.cleanup();
});

// ─────────────────────────────────────────────────────────────────────────────
// Helper-level: acknowledgeExternalEdit side effect
// ─────────────────────────────────────────────────────────────────────────────

test("acknowledgeExternalEdit: refreshes sidecar lastSeenMtimeMs to YAML current mtime", () => {
  const id = "demo";
  project.seedAction(id, fixtureYaml({ id }));
  const loaded = loadAction(project.root, id);
  assert.ok(loaded, "fixture should load");
  const baseline = loaded.state.lastSeenMtimeMs;

  project.simulateHumanEdit(id, fixtureYaml({ id, selectors: ["edited-by-human"] }));
  const editedYaml = loadAction(project.root, id);
  assert.ok(
    editedYaml.state.lastSeenMtimeMs === baseline,
    "sidecar mtime is still pre-edit (the bug surface)",
  );

  const acknowledged = acknowledgeExternalEdit(editedYaml);
  assert.ok(
    acknowledged.state.lastSeenMtimeMs > baseline,
    "returned action.state.lastSeenMtimeMs advanced",
  );

  // Persisted to disk — the next loadAction sees the new mtime.
  const reloaded = loadAction(project.root, id);
  assert.equal(
    reloaded.state.lastSeenMtimeMs,
    acknowledged.state.lastSeenMtimeMs,
    "sidecar JSON was rewritten with the new mtime",
  );
});

test("acknowledgeExternalEdit: no-op when sidecar already matches YAML mtime", () => {
  const id = "demo";
  project.seedAction(id, fixtureYaml({ id }));
  const loaded = loadAction(project.root, id);
  const sidecarBefore = project.readSidecar(id);

  const acknowledged = acknowledgeExternalEdit(loaded);

  // The returned action is the SAME object reference — no copy, no write.
  assert.equal(acknowledged, loaded, "returns the input action unchanged when no edit happened");
  const sidecarAfter = project.readSidecar(id);
  assert.deepEqual(sidecarAfter, sidecarBefore, "sidecar JSON is byte-identical");
});

// ─────────────────────────────────────────────────────────────────────────────
// Handler-level: cdp_run_action wires the flag correctly
// ─────────────────────────────────────────────────────────────────────────────

/**
 * fakeMaestroPass with a side seam: captures `lastSeenMtimeMs` from the
 * sidecar AT THE MOMENT maestroRun is invoked. Used to assert what the
 * sidecar looked like BEFORE the post-run RunRecord save (which also
 * bumps mtime), so we can prove the forceReload acknowledgment happened
 * pre-run and not just incidentally via the legitimate post-run save.
 */
function fakeMaestroPassWithSnapshot(snapshot) {
  return async () => {
    snapshot.midRunMtime = project.readSidecar("demo").lastSeenMtimeMs;
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: true,
            data: { passed: true, output: "pass", flowFile: "x", platform: "ios" },
          }),
        },
      ],
    };
  };
}

function fakeRepairUnused() {
  // The repair handler is never called on a passing first attempt, so a
  // throw here would catch any regression that incorrectly routes through it.
  return async () => {
    throw new Error("repair should not be called on a passing flow");
  };
}

test("cdp_run_action: forceReload=true (default) acknowledges the human edit BEFORE maestro runs", async () => {
  const id = "demo";
  project.seedAction(id, fixtureYaml({ id }));
  const baselineMtime = project.readSidecar(id).lastSeenMtimeMs;

  project.simulateHumanEdit(id, fixtureYaml({ id, selectors: ["user-edited"] }));

  const snapshot = {};
  const handler = createRunActionHandler({
    maestroRun: fakeMaestroPassWithSnapshot(snapshot),
    repairAction: fakeRepairUnused(),
  });
  // Default forceReload (omitted) — should be true.
  const result = await handler({ actionId: id, projectRoot: project.root });
  assert.equal(result.isError, undefined, "run should succeed");

  // The discriminating assertion: at the moment maestroRun fired, the
  // sidecar's lastSeenMtimeMs had ALREADY advanced past baseline. A
  // regression that skips the pre-run acknowledge step would leave the
  // sidecar at baseline mid-run (and only bump it via the post-run
  // RunRecord save), so this assertion would fail.
  assert.ok(
    snapshot.midRunMtime > baselineMtime,
    `pre-run sidecar should be acknowledged (baseline=${baselineMtime}, midRun=${snapshot.midRunMtime})`,
  );
});

test("cdp_run_action: forceReload=false on externally-edited YAML preserves strict Phase 129 behavior (run fails)", async () => {
  // Companion to the forceReload=true test: with strict mode, the human
  // edit is NOT acknowledged before the run, so the downstream
  // persistRun flow (which uses saveActionWithCAS + atomicWriter) sees
  // a YAML mtime greater than the in-memory action.state.lastSeenMtimeMs
  // and aborts. This is the user-facing pain that motivates GH #173 —
  // it's the right behavior when the human intends to protect offline
  // edits, the wrong behavior when they're actively composing. The
  // forceReload flag lets the caller pick.
  const id = "demo";
  project.seedAction(id, fixtureYaml({ id }));
  const baselineSidecar = project.readSidecar(id);
  const baselineMtime = baselineSidecar.lastSeenMtimeMs;

  project.simulateHumanEdit(id, fixtureYaml({ id, selectors: ["user-edited"] }));

  const snapshot = {};
  const handler = createRunActionHandler({
    maestroRun: fakeMaestroPassWithSnapshot(snapshot),
    repairAction: fakeRepairUnused(),
  });
  const result = await handler({ actionId: id, projectRoot: project.root, forceReload: false });
  assert.equal(result.isError, true, "strict mode should refuse to persist over a stale sidecar");

  // The discriminating assertion: at the moment maestroRun fired, the
  // sidecar's lastSeenMtimeMs was STILL at baseline (no pre-run bump).
  // A regression that incorrectly behaves like forceReload=true would
  // advance the sidecar before this snapshot.
  assert.equal(
    snapshot.midRunMtime,
    baselineMtime,
    `forceReload=false must skip pre-run acknowledgment (baseline=${baselineMtime}, midRun=${snapshot.midRunMtime})`,
  );
});
