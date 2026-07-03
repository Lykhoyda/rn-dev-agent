// GH #423 — cdp_run_action failed opaque UNKNOWN (~50s) on iOS 26.x.
//
// Field root-cause chain: WDA died at launch (upstream iOS 26.x, #317 family);
// the CDP/JS replay fallback SHOULD have engaged (kind UNKNOWN is in its
// trigger), but the flow's app relaunch had dropped the CDP socket, the single
// `treeFor` probe failed mid-reconnect, `catch(() => null)` swallowed it, and
// the fallback silently skipped — surfacing an unexplained UNKNOWN.
//
// Fix under test:
//   1. the tree probe retries (bounded) so a reconnecting CDP doesn't disable
//      the fallback;
//   2. when the fallback is skipped anyway, the failure meta carries
//      cdpJsFallback { attempted:false, reason } and a cdp-unreachable skip
//      appends actionable guidance to the error message.

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

// WDA dies at launch before any selector → parseMaestroFailure → kind:UNKNOWN.
const FAIL_UNKNOWN_ENV = {
  ok: false,
  data: {
    passed: false,
    output:
      '  maestro-runner 1.1.16\n  Building WDA...\n  (WDA failed to start; no steps executed)',
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

const PROBE_RETRY_FAST = { attempts: 3, delayMs: 1 };

// ─────────────────────────────────────────────────────────────────────────────
// 1. Probe retry: CDP recovers on the 3rd attempt → fallback still engages
// ─────────────────────────────────────────────────────────────────────────────

test('GH #423: treeFor fails twice (CDP reconnecting) then succeeds → CDP/JS fallback still replays', async () => {
  project.seedAction('demo', replayFixtureYaml({ id: 'demo', selector: 'fab-create-task' }));

  let treeCalls = 0;
  const pressCalls = [];
  const handler = createRunActionHandler({
    maestroRun: fakeMaestroRun([FAIL_UNKNOWN_ENV]),
    probeRetry: PROBE_RETRY_FAST,
    replayDeps: () => ({
      treeFor: async (id) => {
        treeCalls++;
        if (treeCalls < 3) throw new Error('CDP not connected (reconnect in progress)');
        return id === 'fab-create-task' ? { testID: 'fab-create-task', children: [] } : null;
      },
      pressByTestId: async (id) => {
        pressCalls.push(id);
      },
      typeByTestId: async () => {},
      launchApp: async () => {},
      settle: async () => {},
    }),
  });

  const result = await handler({ actionId: 'demo', projectRoot: project.root });
  const env = JSON.parse(result.content[0].text);
  assert.equal(
    env.ok,
    true,
    `expected replay to engage after probe retries, got: ${result.content[0].text}`,
  );
  assert.equal(env.data.transport, 'cdp-js');
  // 2 failed probe attempts + 1 successful probe; the replay engine then makes
  // its own tree reads on top — only the probe's retry behavior is under test.
  assert.ok(
    treeCalls >= 3,
    `probe must retry through transient CDP failures (saw ${treeCalls} calls)`,
  );
  assert.deepEqual(pressCalls, ['fab-create-task']);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. CDP never recovers → skip is SURFACED, not silent, with actionable text
// ─────────────────────────────────────────────────────────────────────────────

test('GH #423: treeFor always fails → meta.cdpJsFallback reason cdp-unreachable + actionable message', async () => {
  project.seedAction('demo', replayFixtureYaml({ id: 'demo', selector: 'fab-create-task' }));

  let treeCalls = 0;
  const handler = createRunActionHandler({
    maestroRun: fakeMaestroRun([FAIL_UNKNOWN_ENV]),
    probeRetry: PROBE_RETRY_FAST,
    replayDeps: () => ({
      treeFor: async () => {
        treeCalls++;
        throw new Error('CDP not connected');
      },
      pressByTestId: async () => {},
      typeByTestId: async () => {},
      launchApp: async () => {},
      settle: async () => {},
    }),
  });

  const result = await handler({ actionId: 'demo', projectRoot: project.root });
  assert.equal(result.isError, true);
  const env = JSON.parse(result.content[0].text);
  assert.equal(env.meta.failureKind, 'UNKNOWN');
  assert.deepEqual(env.meta.cdpJsFallback, { attempted: false, reason: 'cdp-unreachable' });
  assert.equal(treeCalls, 3, 'probe must exhaust its retry budget before giving up');
  assert.match(
    env.error,
    /CDP was unreachable/i,
    'the UNKNOWN failure must explain WHY the CDP/JS fallback was skipped',
  );
  assert.match(env.error, /cdp_status/, 'message must point at a concrete next step');
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Tree readable but testID absent → distinct skip reason (app truly not there)
// ─────────────────────────────────────────────────────────────────────────────

test('GH #423: tree readable but probe testID absent → reason testid-not-in-tree', async () => {
  project.seedAction('demo', replayFixtureYaml({ id: 'demo', selector: 'fab-create-task' }));

  const handler = createRunActionHandler({
    maestroRun: fakeMaestroRun([FAIL_UNKNOWN_ENV]),
    probeRetry: PROBE_RETRY_FAST,
    replayDeps: () => ({
      treeFor: async () => ({ testID: 'some-other-screen', children: [] }),
      pressByTestId: async () => {},
      typeByTestId: async () => {},
      launchApp: async () => {},
      settle: async () => {},
    }),
  });

  const result = await handler({ actionId: 'demo', projectRoot: project.root });
  assert.equal(result.isError, true);
  const env = JSON.parse(result.content[0].text);
  assert.deepEqual(env.meta.cdpJsFallback, { attempted: false, reason: 'testid-not-in-tree' });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. No replay deps wired (non-iOS session / no session) → surfaced too
// ─────────────────────────────────────────────────────────────────────────────

test('GH #423: replayDeps unavailable → reason no-replay-deps in the UNKNOWN failure meta', async () => {
  project.seedAction('demo', replayFixtureYaml({ id: 'demo', selector: 'fab-create-task' }));

  const handler = createRunActionHandler({
    maestroRun: fakeMaestroRun([FAIL_UNKNOWN_ENV]),
    probeRetry: PROBE_RETRY_FAST,
    replayDeps: () => null,
  });

  const result = await handler({ actionId: 'demo', projectRoot: project.root });
  assert.equal(result.isError, true);
  const env = JSON.parse(result.content[0].text);
  assert.deepEqual(env.meta.cdpJsFallback, { attempted: false, reason: 'no-replay-deps' });
});
