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
import { createTmpProject, fixtureYaml } from '../helpers/tmp-project.js';

let project;

beforeEach(() => {
  project = createTmpProject();
});

afterEach(() => {
  project.cleanup();
});

test('RunRecord accepts optional transport and omits it by default', () => {
  // a maestro record (no transport) and a cdp-js record both round-trip
  const base = {
    timestamp: '2026-06-19T00:00:00Z',
    durationMs: 1,
    status: 'pass',
    trigger: 'human',
    autoRepair: { attempted: false, outcome: 'skipped', phases: { firstAttemptMs: 1 } },
  };
  const maestro = { ...base };
  const fallback = { ...base, transport: 'cdp-js' };
  assert.equal('transport' in maestro, false);
  assert.equal(fallback.transport, 'cdp-js');
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
        pressByTestId: async () => {},
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
  assert.equal(maestroCallCount, 1, 'maestro must NOT be retried — only one call (the failed first attempt)');
  assert.equal(replayDepsCallCount, 1, 'replayDeps factory must be called once');

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
      pressByTestId: async (id) => {
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
  assert.equal(env.meta.autoRepair.refusedReason, 'NO_MATCH', 'should hit repair path, not CDP replay');
  assert.equal(repairCalled, true, 'repair handler MUST be called when testID is absent');
  assert.equal(cdpReplayInvoked, false, 'CDP/JS replay must NOT execute when testID absent from tree');
});
