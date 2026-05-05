// Issue #103 — handler integration tests for cdp_repair_action.
//
// Covers the orchestration that pure repair-engine helpers can't reach:
// guardrail short-circuits (external edit, budget exhausted, snapshot
// failure), the on-disk YAML+sidecar round-trip after a successful
// repair, and the dryRun preview path.
//
// The handler reads a real fixture YAML from disk, calls a stubbed
// `runAgentDevice` to obtain a fake device snapshot, then writes back
// the patched YAML through the same atomic-pair-writer that
// `save-as-action` uses — so the atomicity invariant is exercised end-
// to-end.

import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRepairActionHandler } from '../../dist/tools/repair-action.js';
import {
  setActiveSession,
  resetActiveSessionInMemoryForTest,
  _setRunAgentDeviceForTest,
} from '../../dist/agent-device-wrapper.js';
import { atomicWriter } from '../../dist/domain/atomic-writer.js';
import { yamlEditedSinceLastSeen } from '../../dist/domain/sidecar-io.js';
import { loadAction } from '../../dist/domain/action-store.js';
import { createTmpProject, fixtureYaml, freshFixtureState } from '../helpers/tmp-project.js';

const FAKE_SESSION = {
  name: 'test-session-rep',
  platform: 'ios',
  deviceId: 'TEST-DEVICE-ID',
  openedAt: '2026-05-04T00:00:00.000Z',
  appId: 'com.test.app',
};

/** Build a fake snapshot envelope text shaped like agent-device's `snapshot -i`. */
function fakeSnapshot(testIDs) {
  const nodes = testIDs.map((id, i) => ({
    ref: `e${i}`,
    identifier: id,
    rect: { x: 0, y: 0, width: 100, height: 50 },
  }));
  return JSON.stringify({ ok: true, data: { nodes } });
}

/** Build a failed snapshot envelope (ok:false). */
function failedSnapshot() {
  return JSON.stringify({ ok: false, error: 'simulated agent-device unreachable' });
}

let project;

beforeEach(() => {
  project = createTmpProject();
  setActiveSession(FAKE_SESSION);
});

afterEach(() => {
  _setRunAgentDeviceForTest(null);
  resetActiveSessionInMemoryForTest();
  mock.reset();
  project.cleanup();
});

// ─────────────────────────────────────────────────────────────────────────────
// Happy path
// ─────────────────────────────────────────────────────────────────────────────

test('repair-action: happy path patches stale selector with fuzzy match', async () => {
  // Action references "fab-create-task" but the screen now has
  // "fab-create-task-btn" (a common rename pattern).
  project.seedAction(
    'wizard-create-task',
    fixtureYaml({ id: 'wizard-create-task', selectors: ['fab-create-task'] }),
  );

  _setRunAgentDeviceForTest(async (cliArgs) => ({
    content: [{ type: 'text', text: fakeSnapshot(['fab-create-task-btn', 'btn-cancel', 'header-home']) }],
  }));

  const handler = createRepairActionHandler();
  const result = await handler({
    actionId: 'wizard-create-task',
    failedSelector: 'fab-create-task',
    projectRoot: project.root,
    agentReasoning: 'maestro_run reported missing fab-create-task',
  });

  assert.equal(result.isError, undefined, `expected ok, got ${result.content[0].text}`);
  const env = JSON.parse(result.content[0].text);
  assert.equal(env.ok, true);
  assert.equal(env.data.patched, true);
  assert.equal(env.data.oldSelector, 'fab-create-task');
  assert.equal(env.data.newSelector, 'fab-create-task-btn');
  assert.equal(env.data.replacements, 1);

  // YAML on disk contains the new selector, not the old one.
  const yaml = project.readYaml('wizard-create-task');
  assert.match(yaml, /id:\s+"fab-create-task-btn"/);
  assert.doesNotMatch(yaml, /id:\s+"fab-create-task"$/m);

  // Sidecar reflects the repair: revision bumped, repairHistory populated.
  // RepairRecord schema is { timestamp, failureCode, diff: { selector: { from, to } }, ... }
  const sidecar = project.readSidecar('wizard-create-task');
  assert.ok(sidecar.revision > 1, 'revision should bump after repair');
  assert.equal(sidecar.repairHistory.length, 1);
  assert.equal(sidecar.repairHistory[0].failureCode, 'SELECTOR_NOT_FOUND');
  assert.equal(sidecar.repairHistory[0].diff.selector.from, 'fab-create-task');
  assert.equal(sidecar.repairHistory[0].diff.selector.to, 'fab-create-task-btn');
});

// ─────────────────────────────────────────────────────────────────────────────
// Validation paths
// ─────────────────────────────────────────────────────────────────────────────

test('repair-action: missing actionId returns BAD_FILENAME', async () => {
  const handler = createRepairActionHandler();
  const result = await handler({ failedSelector: 'foo', projectRoot: project.root });
  assert.equal(result.isError, true);
  const env = JSON.parse(result.content[0].text);
  assert.equal(env.code, 'BAD_FILENAME');
});

test('repair-action: missing failedSelector returns BAD_FILENAME', async () => {
  const handler = createRepairActionHandler();
  const result = await handler({ actionId: 'foo', projectRoot: project.root });
  assert.equal(result.isError, true);
  const env = JSON.parse(result.content[0].text);
  assert.equal(env.code, 'BAD_FILENAME');
});

// Issue #102 A3 — distinguish "caller passed a wrong selector hint"
// from "screen state doesn't have the testID". The first surfaces as
// BAD_FILENAME (the codebase's umbrella for "caller's input doesn't
// match the contract"); the second remains TESTID_NOT_FOUND.
test('Issue #102 A3: failedSelector not present in action body returns BAD_FILENAME (not TESTID_NOT_FOUND)', async () => {
  // Seed an action whose body references "fab-create-task" only.
  project.seedAction(
    'wrong-hint',
    fixtureYaml({ id: 'wrong-hint', selectors: ['fab-create-task'] }),
  );

  // A device snapshot exists (so the upstream guards don't short-
  // circuit), but the caller's failedSelector hint doesn't match
  // anything in the body.
  _setRunAgentDeviceForTest(async () => ({
    content: [{ type: 'text', text: fakeSnapshot(['fab-create-task-btn']) }],
  }));

  const handler = createRepairActionHandler();
  const result = await handler({
    actionId: 'wrong-hint',
    failedSelector: 'totally-different-selector-not-in-body',
    projectRoot: project.root,
  });

  assert.equal(result.isError, true);
  const env = JSON.parse(result.content[0].text);
  assert.equal(
    env.code,
    'BAD_FILENAME',
    `pre-#102-A3 fix this would have been TESTID_NOT_FOUND; the new code distinguishes hint-bug from screen-state-bug`,
  );
  assert.match(env.error, /not found in the action body|may be wrong/);
});

test('repair-action: action not found returns NO_PROJECT_ROOT', async () => {
  const handler = createRepairActionHandler();
  const result = await handler({
    actionId: 'does-not-exist',
    failedSelector: 'foo',
    projectRoot: project.root,
  });
  assert.equal(result.isError, true);
  const env = JSON.parse(result.content[0].text);
  assert.equal(env.code, 'NO_PROJECT_ROOT');
});

// ─────────────────────────────────────────────────────────────────────────────
// Guardrails
// ─────────────────────────────────────────────────────────────────────────────

test('repair-action: refuses when YAML was edited externally (mtime newer than lastSeenMtimeMs)', async () => {
  project.seedAction(
    'edited-externally',
    fixtureYaml({ id: 'edited-externally', selectors: ['fab-create-task'] }),
  );
  // Simulate human edit AFTER the sidecar was last refreshed.
  project.simulateHumanEdit(
    'edited-externally',
    fixtureYaml({ id: 'edited-externally', selectors: ['user-renamed-this'] }),
  );

  _setRunAgentDeviceForTest(async () => ({
    content: [{ type: 'text', text: fakeSnapshot(['anything']) }],
  }));

  const handler = createRepairActionHandler();
  const result = await handler({
    actionId: 'edited-externally',
    failedSelector: 'fab-create-task',
    projectRoot: project.root,
  });
  assert.equal(result.isError, true);
  const env = JSON.parse(result.content[0].text);
  assert.equal(env.code, 'STALE_TARGET');
  assert.match(env.error, /mtime is newer/);

  // YAML must NOT be modified by the handler.
  const yaml = project.readYaml('edited-externally');
  assert.match(yaml, /id:\s+"user-renamed-this"/);
});

test('repair-action: refuses when 24h repair budget is exhausted (3 recent repairs)', async () => {
  // Pre-seed sidecar with 3 RepairRecord entries inside the 24h window.
  // (RepairRecord schema: { timestamp, failureCode, diff: { selector: { from, to } }, durationMs }.)
  const nowIso = new Date().toISOString();
  const stateWithBudgetExhausted = freshFixtureState(0);
  const fakeRepair = (from, to) => ({
    timestamp: nowIso,
    failureCode: 'SELECTOR_NOT_FOUND',
    diff: { selector: { from, to } },
    durationMs: 0,
  });
  stateWithBudgetExhausted.repairHistory = [
    fakeRepair('a', 'a1'),
    fakeRepair('b', 'b1'),
    fakeRepair('c', 'c1'),
  ];

  project.seedAction(
    'budget-exhausted',
    fixtureYaml({ id: 'budget-exhausted', selectors: ['fab-create-task'] }),
    stateWithBudgetExhausted,
  );

  _setRunAgentDeviceForTest(async () => ({
    content: [{ type: 'text', text: fakeSnapshot(['fab-create-task-btn']) }],
  }));

  const handler = createRepairActionHandler();
  const result = await handler({
    actionId: 'budget-exhausted',
    failedSelector: 'fab-create-task',
    projectRoot: project.root,
  });
  assert.equal(result.isError, true);
  const env = JSON.parse(result.content[0].text);
  assert.equal(env.code, 'STALE_TARGET');
  assert.match(env.error, /repair budget/);
});

test('repair-action: SNAPSHOT_FAILED when agent-device snapshot returns ok:false', async () => {
  project.seedAction(
    'snap-fail',
    fixtureYaml({ id: 'snap-fail', selectors: ['fab-create-task'] }),
  );

  _setRunAgentDeviceForTest(async () => ({
    content: [{ type: 'text', text: failedSnapshot() }],
  }));

  const handler = createRepairActionHandler();
  const result = await handler({
    actionId: 'snap-fail',
    failedSelector: 'fab-create-task',
    projectRoot: project.root,
  });
  assert.equal(result.isError, true);
  const env = JSON.parse(result.content[0].text);
  assert.equal(env.code, 'SNAPSHOT_FAILED');
});

test('repair-action: snapshot returns 0 testIDs → TESTID_NOT_FOUND', async () => {
  project.seedAction(
    'empty-snap',
    fixtureYaml({ id: 'empty-snap', selectors: ['fab-create-task'] }),
  );

  _setRunAgentDeviceForTest(async () => ({
    content: [{ type: 'text', text: fakeSnapshot([]) }],
  }));

  const handler = createRepairActionHandler();
  const result = await handler({
    actionId: 'empty-snap',
    failedSelector: 'fab-create-task',
    projectRoot: project.root,
  });
  assert.equal(result.isError, true);
  const env = JSON.parse(result.content[0].text);
  assert.equal(env.code, 'TESTID_NOT_FOUND');
});

test('repair-action: no candidate clears threshold → TESTID_NOT_FOUND', async () => {
  project.seedAction(
    'no-match',
    fixtureYaml({ id: 'no-match', selectors: ['fab-create-task'] }),
  );

  // All candidates are wildly different — none clears the default 0.6 threshold.
  _setRunAgentDeviceForTest(async () => ({
    content: [{ type: 'text', text: fakeSnapshot(['totally-unrelated', 'header-x', 'menu-y']) }],
  }));

  const handler = createRepairActionHandler();
  const result = await handler({
    actionId: 'no-match',
    failedSelector: 'fab-create-task',
    projectRoot: project.root,
  });
  assert.equal(result.isError, true);
  const env = JSON.parse(result.content[0].text);
  assert.equal(env.code, 'TESTID_NOT_FOUND');
  assert.match(env.error, /no confident replacement/);
});

// ─────────────────────────────────────────────────────────────────────────────
// dryRun
// ─────────────────────────────────────────────────────────────────────────────

test('repair-action: dryRun returns diff without writing to disk', async () => {
  project.seedAction(
    'dry-run',
    fixtureYaml({ id: 'dry-run', selectors: ['fab-create-task'] }),
  );

  const yamlBefore = project.readYaml('dry-run');
  const sidecarBefore = JSON.parse(JSON.stringify(project.readSidecar('dry-run')));

  _setRunAgentDeviceForTest(async () => ({
    content: [{ type: 'text', text: fakeSnapshot(['fab-create-task-btn']) }],
  }));

  const handler = createRepairActionHandler();
  const result = await handler({
    actionId: 'dry-run',
    failedSelector: 'fab-create-task',
    projectRoot: project.root,
    dryRun: true,
  });

  assert.equal(result.isError, undefined);
  const env = JSON.parse(result.content[0].text);
  assert.equal(env.data.dryRun, true);
  assert.equal(env.data.oldSelector, 'fab-create-task');
  assert.equal(env.data.newSelector, 'fab-create-task-btn');
  assert.ok(env.data.diff?.before);
  assert.ok(env.data.diff?.after);

  // Files unchanged.
  assert.equal(project.readYaml('dry-run'), yamlBefore, 'YAML must be untouched in dryRun');
  assert.deepEqual(project.readSidecar('dry-run'), sidecarBefore, 'sidecar must be untouched in dryRun');
});

// ─────────────────────────────────────────────────────────────────────────────
// Atomicity (#101 regression test) — even if the YAML write fails after
// a successful sidecar write, a subsequent yamlEditedSinceLastSeen() must
// NOT report a false-positive external edit.
// ─────────────────────────────────────────────────────────────────────────────

test('repair-action: when YAML write fails after sidecar succeeds, no false-positive external-edit alarm', async () => {
  const seeded = project.seedAction(
    'partial-fail',
    fixtureYaml({ id: 'partial-fail', selectors: ['fab-create-task'] }),
  );
  const originalMtimeMs = seeded.mtimeMs;

  _setRunAgentDeviceForTest(async () => ({
    content: [{ type: 'text', text: fakeSnapshot(['fab-create-task-btn']) }],
  }));

  const realWriteFile = atomicWriter._writeFile.bind(atomicWriter);
  const stub = mock.method(atomicWriter, '_writeFile', (path, content) => {
    if (path.endsWith('.yaml.tmp')) {
      throw new Error('SIMULATED_DISK_FULL: yaml write failed');
    }
    return realWriteFile(path, content);
  });

  const handler = createRepairActionHandler();
  // The handler currently doesn't try/catch around saveAction, so the
  // error surfaces through the withSession→handler boundary as a
  // failResult (utils.ts wraps thrown errors). Either path is fine here
  // — what matters is the on-disk state afterwards.
  let didThrow = false;
  let envelope = null;
  try {
    const result = await handler({
      actionId: 'partial-fail',
      failedSelector: 'fab-create-task',
      projectRoot: project.root,
    });
    envelope = JSON.parse(result.content[0].text);
  } catch (err) {
    didThrow = true;
    assert.match(String(err), /SIMULATED_DISK_FULL/);
  }
  if (!didThrow) {
    assert.equal(envelope?.ok, false, 'expected failure envelope when write fails');
  }

  stub.mock.restore();

  // Critical invariant #1: the persisted sidecar's lastSeenMtimeMs must
  // be ≥ the on-disk YAML mtime, so yamlEditedSinceLastSeen returns
  // false (no false-positive alarm).
  const action = loadAction(project.root, 'partial-fail');
  assert.ok(action, 'action should still load after partial failure');
  assert.equal(
    yamlEditedSinceLastSeen(action.filePath, action.state),
    false,
    'no false-positive external-edit alarm after partial failure',
  );

  // Critical invariant #2 (PR #109 review finding C): the test must
  // strongly distinguish sidecar-first from a hypothetical YAML-first
  // implementation. Under sidecar-first, step 1+2 successfully overwrite
  // the seeded sidecar with `lastSeenMtimeMs = Date.now() + buffer`
  // BEFORE the YAML write throws. The persisted sidecar therefore has
  // a strictly LARGER mtime than the original seed — a YAML-first
  // implementation would leave the sidecar untouched (still equal to
  // `originalMtimeMs`), so this assertion would fail under that ordering.
  assert.ok(
    action.state.lastSeenMtimeMs > originalMtimeMs,
    `sidecar-first ordering must overwrite the sidecar with a future mtime ` +
    `before failing on the YAML write; got ${action.state.lastSeenMtimeMs} ` +
    `vs original ${originalMtimeMs}`,
  );

  // The YAML body should still be the ORIGINAL — partial failure must
  // not advertise a successful patch.
  assert.match(action.body, /id:\s+"fab-create-task"/);
});
