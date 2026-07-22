// GH #317 Phase 2 Task 5 — CDP/JS replay fallback wired into cdp_run_action.
//
// Tests the new `replayDeps` factory dep on `createRunActionHandler`.
// When maestro returns SELECTOR_NOT_FOUND and the live CDP tree confirms
// the testID IS present, we skip Maestro entirely and replay via CDP/JS.
// When the testID is ABSENT from the tree, the fallback is skipped and
// the existing repair path runs unchanged.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRunActionHandler } from '../../dist/tools/run-action.js';
import { createTmpProject } from '../helpers/tmp-project.js';

let project;

beforeEach(() => {
  project = createTmpProject();
});

afterEach(() => {
  project.cleanup();
});

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generates a well-formed action YAML with steps at column-0 (valid Maestro
 * format). Uses `launchApp:` (object form) so normalizeSteps maps it to a
 * 'launch' step. The default fixtureYaml produces body YAML the YAML library
 * cannot parse; for CDP/JS replay tests we need parseable YAML bodies.
 */
function replayFixtureYaml({ id = 'demo', selector = 'fab-create-task' } = {}) {
  return [
    'appId: com.test.app',
    '---',
    `# id: ${id}`,
    '# intent: test fixture',
    '# tags: [fixture]',
    '# mutates: false',
    '# status: experimental',
    '',
    '- launchApp:',
    '    stopApp: false',
    '- tapOn:',
    `    id: "${selector}"`,
    '',
  ].join('\n');
}

const FAIL_SELECTOR_ENV = {
  ok: false,
  data: {
    passed: false,
    output: "Element with id 'fab-create-task' not found",
    flowFile: 'x',
    platform: 'ios',
  },
};

// WDA dies at launch before any selector → parseMaestroFailure returns kind:UNKNOWN
// (no "not found"/assertion pattern in the output). This is the real iOS 26.5
// failure mode the broadened trigger (GH #317 device-verification) handles.
const FAIL_UNKNOWN_ENV = {
  ok: false,
  data: {
    passed: false,
    output: '  maestro-runner 1.0.9\n  Building WDA...\n  (WDA failed to start; no steps executed)',
    flowFile: 'x',
    platform: 'ios',
  },
};

const PASS_ENV = {
  ok: true,
  data: {
    passed: true,
    output: 'Flow PASSED',
    flowFile: 'x',
    platform: 'ios',
    transport: 'maestro-runner',
    transportVersion: '1.0.9',
    fallback: 'none',
    steps: [
      { index: 0, name: 'tapOn: fab-create-task', verb: 'tapOn', status: 'pass', durationMs: 10 },
    ],
  },
};

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

function fakeRepairAction(envelope) {
  return async () => ({
    content: [{ type: 'text', text: JSON.stringify(envelope) }],
    ...(envelope.ok === false ? { isError: true } : {}),
  });
}

const REPAIR_NO_MATCH_ENV = {
  ok: false,
  error: 'cdp_repair_action: no confident replacement for "fab-create-task"',
  code: 'TESTID_NOT_FOUND',
};

// ─────────────────────────────────────────────────────────────────────────────
// Test 1: SELECTOR_NOT_FOUND + testID present in tree → CDP/JS fallback runs
// ─────────────────────────────────────────────────────────────────────────────

test('GH #317 Task 5: SELECTOR_NOT_FOUND + testID present → CDP/JS fallback; passed:true, transport:cdp-js, maestro NOT retried', async () => {
  project.seedAction('demo', replayFixtureYaml({ id: 'demo', selector: 'fab-create-task' }));

  let maestroCallCount = 0;
  let replayDepsCallCount = 0;
  const pressCalls = [];

  const handler = createRunActionHandler({
    maestroRun: async (...args) => {
      maestroCallCount++;
      return fakeMaestroRun([FAIL_SELECTOR_ENV])(...args);
    },
    repairAction: fakeRepairAction(REPAIR_NO_MATCH_ENV),
    replayDeps: (_args) => {
      replayDepsCallCount++;
      // treeFor returns a node with the expected testID present
      return {
        treeFor: async (id) => {
          if (id === 'fab-create-task') return { testID: 'fab-create-task', children: [] };
          return null;
        },
        pressByTestId: async (id) => {
          pressCalls.push(id);
        },
        typeByTestId: async () => {},
        launchApp: async () => {},
        settle: async () => {},
      };
    },
  });

  const result = await handler({ actionId: 'demo', projectRoot: project.root });

  assert.equal(result.isError, undefined, `expected ok result, got: ${result.content[0].text}`);
  const env = JSON.parse(result.content[0].text);
  assert.equal(env.ok, true);
  assert.equal(env.data.passed, true);
  assert.equal(env.data.transport, 'cdp-js', 'transport must be cdp-js for CDP/JS replay path');
  assert.equal(
    maestroCallCount,
    1,
    'maestro must NOT be retried — only one call (the failed first attempt)',
  );
  assert.equal(replayDepsCallCount, 1, 'replayDeps factory must be called once');
  assert.deepEqual(
    pressCalls,
    ['fab-create-task'],
    'replay must dispatch the tapOn step exactly once with the expected testID (not skip it)',
  );

  // RunRecord must reflect the CDP/JS transport and pass status.
  const sidecar = project.readSidecar('demo');
  assert.equal(sidecar.runHistory.length, 1);
  assert.equal(sidecar.runHistory[0].status, 'pass');
  assert.equal(sidecar.runHistory[0].transport, 'cdp-js');
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 2: SELECTOR_NOT_FOUND + testID ABSENT from tree → existing repair path
// ─────────────────────────────────────────────────────────────────────────────

test('GH #317 Task 5: SELECTOR_NOT_FOUND + testID absent from tree → existing repair path runs, replay NOT invoked', async () => {
  project.seedAction('demo', replayFixtureYaml({ id: 'demo', selector: 'fab-create-task' }));

  let repairCalled = false;
  let cdpReplayInvoked = false;

  const handler = createRunActionHandler({
    maestroRun: fakeMaestroRun([FAIL_SELECTOR_ENV]),
    repairAction: async (...args) => {
      repairCalled = true;
      return fakeRepairAction(REPAIR_NO_MATCH_ENV)(...args);
    },
    replayDeps: (_args) => ({
      treeFor: async () => ({ testID: 'some-other-element', children: [] }),
      pressByTestId: async (_id) => {
        cdpReplayInvoked = true;
      },
      typeByTestId: async () => {},
      launchApp: async () => {},
      settle: async () => {},
    }),
  });

  const result = await handler({ actionId: 'demo', projectRoot: project.root });

  // Should fall through to the existing repair path (which returns NO_MATCH fail).
  assert.equal(result.isError, true, 'expected failure since repair returned NO_MATCH');
  const env = JSON.parse(result.content[0].text);
  assert.equal(
    env.meta.autoRepair.refusedReason,
    'NO_MATCH',
    'should hit repair path, not CDP replay',
  );
  assert.equal(repairCalled, true, 'repair handler MUST be called when testID is absent');
  assert.equal(
    cdpReplayInvoked,
    false,
    'CDP/JS replay must NOT execute when testID absent from tree',
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 3: UNKNOWN failure + first testID present → CDP/JS fallback (broadened trigger)
// GH #317 device-verification finding: real iOS 26.5 maestro failure is UNKNOWN
// (WDA dies at launch), not SELECTOR_NOT_FOUND.
// ─────────────────────────────────────────────────────────────────────────────

test('GH #317: UNKNOWN failure + first testID present → CDP/JS fallback fires; passed:true, transport:cdp-js', async () => {
  project.seedAction('demo', replayFixtureYaml({ id: 'demo', selector: 'fab-create-task' }));

  const pressCalls = [];
  const handler = createRunActionHandler({
    maestroRun: fakeMaestroRun([FAIL_UNKNOWN_ENV]),
    replayDeps: (_args) => ({
      // probe is the action's FIRST testID (fab-create-task) — there is no
      // failure.selector on an UNKNOWN failure.
      treeFor: async (id) =>
        id === 'fab-create-task' ? { testID: 'fab-create-task', children: [] } : null,
      pressByTestId: async (id) => {
        pressCalls.push(id);
      },
      typeByTestId: async () => {},
      launchApp: async () => {},
      settle: async () => {},
    }),
  });

  const result = await handler({ actionId: 'demo', projectRoot: project.root });

  assert.equal(result.isError, undefined, `expected ok result, got: ${result.content[0].text}`);
  const env = JSON.parse(result.content[0].text);
  assert.equal(env.data.passed, true);
  assert.equal(env.data.transport, 'cdp-js', 'UNKNOWN-triggered replay must mark transport cdp-js');
  assert.deepEqual(pressCalls, ['fab-create-task'], 'replay must press the probed first testID');
  const sidecar = project.readSidecar('demo');
  assert.equal(sidecar.runHistory[0].transport, 'cdp-js');
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 4: a normal Maestro PASS exposes transport/readback but keeps legacy sidecar encoding
// ─────────────────────────────────────────────────────────────────────────────

test('GH #317: Maestro PASS explicitly reports transport/fallback/readback and never consults replayDeps', async () => {
  project.seedAction('demo', replayFixtureYaml({ id: 'demo', selector: 'fab-create-task' }));

  const handler = createRunActionHandler({
    maestroRun: fakeMaestroRun([PASS_ENV]),
    replayDeps: () => {
      throw new Error('replayDeps must not be consulted on a Maestro pass');
    },
  });

  const result = await handler({ actionId: 'demo', projectRoot: project.root });

  assert.equal(result.isError, undefined);
  const env = JSON.parse(result.content[0].text);
  assert.equal(env.data.passed, true);
  assert.equal(env.data.transport, 'maestro-runner');
  assert.equal(env.data.transportVersion, '1.0.9');
  assert.equal(env.data.fallback, 'none');
  assert.equal(env.data.repair.attempted, false);
  assert.equal(env.data.perStepReadback.complete, true);
  assert.equal(env.data.perStepReadback.steps[0].status, 'pass');
  assert.deepEqual(env.data.writes.actionYaml, {
    written: true,
    authorized: true,
    reason: 'lifecycle-promotion',
  });
  const sidecar = project.readSidecar('demo');
  assert.equal(sidecar.runHistory[0].status, 'pass');
  assert.equal(
    'transport' in sidecar.runHistory[0],
    false,
    'no transport field persisted on a Maestro pass (healthy-path byte-for-byte)',
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 5: a FAILED CDP/JS replay persists failureCode TRANSPORT_BLIND (not UNKNOWN)
// so run-history/MTTR can distinguish a transport-blind flow failure from a
// generic error.
// ─────────────────────────────────────────────────────────────────────────────

test('GH #317: failed CDP/JS replay → failResult TRANSPORT_BLIND + RunRecord.failureCode TRANSPORT_BLIND', async () => {
  // launchApp → tapOn fab-create-task (present) → assertVisible ghost (absent → replay fails)
  const yaml = [
    'appId: com.test.app',
    '---',
    '# id: demo',
    '# intent: failed-replay fixture',
    '# status: experimental',
    '',
    '- launchApp:',
    '    stopApp: false',
    '- tapOn:',
    '    id: "fab-create-task"',
    '- assertVisible:',
    '    id: "ghost-never-rendered"',
    '',
  ].join('\n');
  project.seedAction('demo', yaml);

  const handler = createRunActionHandler({
    maestroRun: fakeMaestroRun([FAIL_SELECTOR_ENV]),
    replayDeps: () => ({
      // probe (fab-create-task) present → fallback fires; ghost absent → assert fails
      treeFor: async (id) =>
        id === 'fab-create-task'
          ? { tree: { testID: 'fab-create-task', children: [] }, totalNodes: 1 }
          : { tree: null, totalNodes: 0 },
      pressByTestId: async () => {},
      typeByTestId: async () => {},
      launchApp: async () => {},
      settle: async () => {},
    }),
  });

  const result = await handler({ actionId: 'demo', projectRoot: project.root });

  assert.equal(result.isError, true, 'a failed replay must surface as an error');
  const env = JSON.parse(result.content[0].text);
  assert.equal(env.code, 'TRANSPORT_BLIND', 'envelope code must be TRANSPORT_BLIND');
  const sidecar = project.readSidecar('demo');
  assert.equal(sidecar.runHistory[0].status, 'fail');
  assert.equal(sidecar.runHistory[0].transport, 'cdp-js');
  assert.equal(
    sidecar.runHistory[0].failureCode,
    'TRANSPORT_BLIND',
    'failed replay must record failureCode TRANSPORT_BLIND, not UNKNOWN',
  );
});
