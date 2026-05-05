// Issue #104 — handler integration tests for cdp_run_action.
//
// Uses the dependency-injection seam (`RunActionDeps`) to stub the
// underlying maestro_run + repair-action handlers. The orchestration
// logic — failure parsing, auto-repair gating, RunRecord telemetry —
// is what's being tested; the underlying tools have their own coverage
// elsewhere.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRunActionHandler } from '../../dist/tools/run-action.js';
import { loadAction } from '../../dist/domain/action-store.js';
import { createTmpProject, fixtureYaml } from '../helpers/tmp-project.js';

let project;

beforeEach(() => {
  project = createTmpProject();
});

afterEach(() => {
  project.cleanup();
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Build a fake maestro_run handler that returns a pre-shaped envelope. */
function fakeMaestroRun(envelopes) {
  let i = 0;
  return async () => {
    const env = envelopes[Math.min(i, envelopes.length - 1)];
    i++;
    return {
      content: [{ type: 'text', text: JSON.stringify(env) }],
      ...(env.ok === false ? { isError: true } : {}),
    };
  };
}

/** Build a fake repair-action handler. */
function fakeRepairAction(envelope) {
  return async () => ({
    content: [{ type: 'text', text: JSON.stringify(envelope) }],
    ...(envelope.ok === false ? { isError: true } : {}),
  });
}

const PASS_ENV = { ok: true, data: { passed: true, output: 'Flow passed', flowFile: 'x', platform: 'ios' } };
const FAIL_SELECTOR_ENV = {
  ok: false,
  data: { passed: false, output: "Element with id 'fab-create-task' not found", flowFile: 'x', platform: 'ios' },
};
const FAIL_TIMEOUT_ENV = {
  ok: false,
  data: { passed: false, output: "Timed out waiting for element with id 'spinner-done'", flowFile: 'x', platform: 'ios' },
};
const REPAIR_PATCHED_ENV = {
  ok: true,
  data: {
    patched: true,
    actionId: 'demo',
    oldSelector: 'fab-create-task',
    newSelector: 'fab-create-task-btn',
    score: 0.91,
    replacements: 1,
  },
};
const REPAIR_BUDGET_EXHAUSTED_ENV = {
  ok: false,
  error: 'cdp_repair_action: action "demo" exhausted its 24h repair budget',
  code: 'STALE_TARGET',
};
const REPAIR_NO_MATCH_ENV = {
  ok: false,
  error: 'cdp_repair_action: no confident replacement for "fab-create-task"',
  code: 'TESTID_NOT_FOUND',
};

// ─────────────────────────────────────────────────────────────────────────────
// Validation paths
// ─────────────────────────────────────────────────────────────────────────────

test('run-action: missing actionId returns BAD_FILENAME', async () => {
  const handler = createRunActionHandler({
    maestroRun: fakeMaestroRun([PASS_ENV]),
    repairAction: fakeRepairAction(REPAIR_PATCHED_ENV),
  });
  const result = await handler({ projectRoot: project.root });
  assert.equal(result.isError, true);
  const env = JSON.parse(result.content[0].text);
  assert.equal(env.code, 'BAD_FILENAME');
});

test('run-action: action not found returns NO_PROJECT_ROOT', async () => {
  const handler = createRunActionHandler({
    maestroRun: fakeMaestroRun([PASS_ENV]),
    repairAction: fakeRepairAction(REPAIR_PATCHED_ENV),
  });
  const result = await handler({
    actionId: 'does-not-exist',
    projectRoot: project.root,
  });
  assert.equal(result.isError, true);
  const env = JSON.parse(result.content[0].text);
  assert.equal(env.code, 'NO_PROJECT_ROOT');
});

// ─────────────────────────────────────────────────────────────────────────────
// Happy path — first attempt passes
// ─────────────────────────────────────────────────────────────────────────────

test('run-action: first-attempt pass appends RunRecord with no auto-repair', async () => {
  project.seedAction('demo', fixtureYaml({ id: 'demo', selectors: ['fab-create-task'] }));

  const handler = createRunActionHandler({
    maestroRun: fakeMaestroRun([PASS_ENV]),
    repairAction: fakeRepairAction(REPAIR_PATCHED_ENV),
  });
  const result = await handler({ actionId: 'demo', projectRoot: project.root });

  assert.equal(result.isError, undefined);
  const env = JSON.parse(result.content[0].text);
  assert.equal(env.ok, true);
  assert.equal(env.data.passed, true);
  assert.equal(env.data.autoRepair.attempted, false);
  assert.equal(env.data.autoRepair.outcome, 'skipped');

  // Sidecar should have one RunRecord with status 'pass' and no autoRepair.
  const sidecar = project.readSidecar('demo');
  assert.equal(sidecar.runHistory.length, 1);
  assert.equal(sidecar.runHistory[0].status, 'pass');
  assert.equal(sidecar.runHistory[0].trigger, 'agent');
  assert.equal(sidecar.runHistory[0].autoRepair, undefined);
});

// ─────────────────────────────────────────────────────────────────────────────
// Auto-repair end-to-end: SELECTOR_NOT_FOUND → repair → retry passes
// ─────────────────────────────────────────────────────────────────────────────

test('run-action: SELECTOR_NOT_FOUND → repair patched → retry passes; RunRecord shows AUTO_REPAIR_PASS-equivalent', async () => {
  project.seedAction('demo', fixtureYaml({ id: 'demo', selectors: ['fab-create-task'] }));

  const handler = createRunActionHandler({
    maestroRun: fakeMaestroRun([FAIL_SELECTOR_ENV, PASS_ENV]),
    repairAction: fakeRepairAction(REPAIR_PATCHED_ENV),
  });
  const result = await handler({ actionId: 'demo', projectRoot: project.root });

  assert.equal(result.isError, undefined, `unexpected fail: ${result.content[0].text}`);
  const env = JSON.parse(result.content[0].text);
  assert.equal(env.ok, true);
  assert.equal(env.data.passed, true);
  assert.equal(env.data.retriedAfterRepair, true);
  assert.equal(env.data.autoRepair.attempted, true);
  assert.equal(env.data.autoRepair.outcome, 'passed');
  assert.deepEqual(env.data.autoRepair.diff.selector, {
    from: 'fab-create-task',
    to: 'fab-create-task-btn',
  });

  // Telemetry: one RunRecord, status 'pass', autoRepair.outcome = 'passed'.
  const sidecar = project.readSidecar('demo');
  assert.equal(sidecar.runHistory.length, 1);
  const r = sidecar.runHistory[0];
  assert.equal(r.status, 'pass');
  assert.equal(r.autoRepair?.attempted, true);
  assert.equal(r.autoRepair?.outcome, 'passed');
  assert.equal(r.autoRepair?.diff?.selector?.from, 'fab-create-task');
});

// ─────────────────────────────────────────────────────────────────────────────
// Auto-repair: repair patched, retry STILL fails → RunRecord shows
// AUTO_REPAIR_FAIL-equivalent.
// ─────────────────────────────────────────────────────────────────────────────

test('run-action: repair patched but retry still fails → autoRepair.outcome = "failed"', async () => {
  project.seedAction('demo', fixtureYaml({ id: 'demo', selectors: ['fab-create-task'] }));

  const handler = createRunActionHandler({
    // Both maestro calls fail (rare but possible — repair patched the
    // selector but a deeper screen change still breaks the flow).
    maestroRun: fakeMaestroRun([FAIL_SELECTOR_ENV, FAIL_SELECTOR_ENV]),
    repairAction: fakeRepairAction(REPAIR_PATCHED_ENV),
  });
  const result = await handler({ actionId: 'demo', projectRoot: project.root });

  assert.equal(result.isError, true);
  const env = JSON.parse(result.content[0].text);
  assert.equal(env.code, 'TESTID_NOT_FOUND');
  assert.equal(env.meta.autoRepair.attempted, true);
  assert.equal(env.meta.autoRepair.outcome, 'failed');

  const sidecar = project.readSidecar('demo');
  // Two RunRecords now: the repair-action handler appends its own
  // RepairRecord (not a RunRecord) so we should see exactly ONE RunRecord
  // describing the orchestration outcome.
  assert.equal(sidecar.runHistory.length, 1);
  assert.equal(sidecar.runHistory[0].status, 'fail');
  assert.equal(sidecar.runHistory[0].autoRepair?.outcome, 'failed');
});

// ─────────────────────────────────────────────────────────────────────────────
// Auto-repair refused: budget exhausted
// ─────────────────────────────────────────────────────────────────────────────

test('run-action: repair refused (budget exhausted) → autoRepair.outcome = "refused", reason = BUDGET_EXHAUSTED', async () => {
  project.seedAction('demo', fixtureYaml({ id: 'demo', selectors: ['fab-create-task'] }));

  const handler = createRunActionHandler({
    maestroRun: fakeMaestroRun([FAIL_SELECTOR_ENV]),
    repairAction: fakeRepairAction(REPAIR_BUDGET_EXHAUSTED_ENV),
  });
  const result = await handler({ actionId: 'demo', projectRoot: project.root });

  assert.equal(result.isError, true);
  const env = JSON.parse(result.content[0].text);
  assert.equal(env.code, 'TESTID_NOT_FOUND');
  assert.equal(env.meta.autoRepair.attempted, true);
  assert.equal(env.meta.autoRepair.outcome, 'refused');
  assert.equal(env.meta.autoRepair.refusedReason, 'BUDGET_EXHAUSTED');

  const sidecar = project.readSidecar('demo');
  assert.equal(sidecar.runHistory.length, 1);
  assert.equal(sidecar.runHistory[0].autoRepair?.outcome, 'refused');
  assert.equal(sidecar.runHistory[0].autoRepair?.refusedReason, 'BUDGET_EXHAUSTED');
});

test('run-action: repair refused (no fuzzy match) → autoRepair.refusedReason = NO_MATCH', async () => {
  project.seedAction('demo', fixtureYaml({ id: 'demo', selectors: ['fab-create-task'] }));

  const handler = createRunActionHandler({
    maestroRun: fakeMaestroRun([FAIL_SELECTOR_ENV]),
    repairAction: fakeRepairAction(REPAIR_NO_MATCH_ENV),
  });
  const result = await handler({ actionId: 'demo', projectRoot: project.root });

  assert.equal(result.isError, true);
  const env = JSON.parse(result.content[0].text);
  assert.equal(env.meta.autoRepair.refusedReason, 'NO_MATCH');
});

// ─────────────────────────────────────────────────────────────────────────────
// Auto-repair gating: autoRepair=false explicitly disables the path.
// ─────────────────────────────────────────────────────────────────────────────

test('run-action: autoRepair=false skips repair entirely on selector failure', async () => {
  project.seedAction('demo', fixtureYaml({ id: 'demo', selectors: ['fab-create-task'] }));

  let repairCalled = false;
  const handler = createRunActionHandler({
    maestroRun: fakeMaestroRun([FAIL_SELECTOR_ENV]),
    repairAction: async () => {
      repairCalled = true;
      return { content: [{ type: 'text', text: JSON.stringify(REPAIR_PATCHED_ENV) }] };
    },
  });
  const result = await handler({ actionId: 'demo', projectRoot: project.root, autoRepair: false });

  assert.equal(result.isError, true);
  assert.equal(repairCalled, false, 'repair handler MUST NOT be invoked when autoRepair=false');

  const env = JSON.parse(result.content[0].text);
  assert.equal(env.meta.autoRepair.attempted, false);
  assert.equal(env.meta.autoRepair.outcome, 'refused');
});

// ─────────────────────────────────────────────────────────────────────────────
// Non-repairable failure kinds (TIMEOUT, ASSERTION_FAILED, UNKNOWN) skip
// repair without invoking the handler.
// ─────────────────────────────────────────────────────────────────────────────

test('run-action: TIMEOUT failure does NOT invoke repair (phase 1 scope)', async () => {
  project.seedAction('demo', fixtureYaml({ id: 'demo', selectors: ['spinner-done'] }));

  let repairCalled = false;
  const handler = createRunActionHandler({
    maestroRun: fakeMaestroRun([FAIL_TIMEOUT_ENV]),
    repairAction: async () => {
      repairCalled = true;
      return { content: [{ type: 'text', text: JSON.stringify(REPAIR_PATCHED_ENV) }] };
    },
  });
  const result = await handler({ actionId: 'demo', projectRoot: project.root });

  assert.equal(result.isError, true);
  assert.equal(repairCalled, false, 'TIMEOUT failures are not auto-repairable in phase 1');

  const env = JSON.parse(result.content[0].text);
  assert.equal(env.meta.autoRepair.attempted, false);
  assert.equal(env.meta.autoRepair.outcome, 'skipped');
  assert.equal(env.meta.autoRepair.refusedReason, 'NOT_REPAIRABLE_KIND');

  // RunRecord uses the action-domain code (TIMEOUT, not TESTID_NOT_FOUND).
  const sidecar = project.readSidecar('demo');
  assert.equal(sidecar.runHistory[0].failureCode, 'TIMEOUT');
});

// ─────────────────────────────────────────────────────────────────────────────
// trigger annotation
// ─────────────────────────────────────────────────────────────────────────────

test('run-action: trigger="ci" surfaces in the RunRecord', async () => {
  project.seedAction('demo', fixtureYaml({ id: 'demo', selectors: ['fab-create-task'] }));

  const handler = createRunActionHandler({
    maestroRun: fakeMaestroRun([PASS_ENV]),
    repairAction: fakeRepairAction(REPAIR_PATCHED_ENV),
  });
  await handler({ actionId: 'demo', projectRoot: project.root, trigger: 'ci' });

  const sidecar = project.readSidecar('demo');
  assert.equal(sidecar.runHistory[0].trigger, 'ci');
});
