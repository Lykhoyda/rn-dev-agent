import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ACTION_ENGINE_PIN,
  MAESTRO_RUNNER_PIN,
  buildReplayEngineStatus,
} from '../../dist/domain/engine-pin.js';
import {
  actionEnginePinRefusal,
  actionReplayPreflight,
  migrateLearnedActions,
  regexSelectorCapabilityRefusal,
  upsertEnginePinHeader,
} from '../../dist/domain/action-engine-compat.js';
import { createRunActionHandler } from '../../dist/tools/run-action.js';
import { createMaestroTestAllHandler } from '../../dist/tools/maestro-test-all.js';
import { createMaestroRunHandler } from '../../dist/tools/maestro-run.js';
import { runMaestroInline } from '../../dist/maestro-invoke.js';
import { createTmpProject } from '../helpers/tmp-project.js';

const PINNED = () =>
  buildReplayEngineStatus('pinned-ok', MAESTRO_RUNNER_PIN.version, false, {
    selectedPath: '/pin-cache/maestro-runner/1.1.24/bin/maestro-runner',
    provenance: 'pin-cache',
  });

function actionYaml(id: string, extraHeader = '', body = '- tapOn:\n    id: "fab-create-task"\n') {
  return [
    'appId: com.test.app',
    '---',
    `# id: ${id}`,
    '# intent: test fixture',
    '# status: experimental',
    extraHeader,
    '',
    '- launchApp:',
    '    stopApp: false',
    body,
  ]
    .filter((line) => line !== '')
    .join('\n');
}

test('missing enginePin is a terminal format refusal', () => {
  const msg = actionEnginePinRefusal(undefined);
  assert.ok(msg);
  assert.match(msg, /not migrated/);
  assert.match(msg, /no manual fallback/i);
});

test('wrong enginePin is terminal and names both pins', () => {
  const msg = actionEnginePinRefusal('maestro-runner@1.0.9');
  assert.ok(msg);
  assert.match(msg, /maestro-runner@1\.0\.9/);
  assert.match(msg, new RegExp(ACTION_ENGINE_PIN.replace('.', '\\.')));
  assert.match(msg, /no manual fallback/i);
});

test('matching enginePin is accepted', () => {
  assert.equal(actionEnginePinRefusal(ACTION_ENGINE_PIN), null);
});

test('regex text selectors are refused before any runner spawn', () => {
  const msg = regexSelectorCapabilityRefusal([{ tapOn: '.*Getsafe.*' }]);
  assert.ok(msg);
  assert.match(msg, /1\.1\.24/);
  assert.match(msg, /No UI mutation/);
});

test('anchored regex text selectors are refused', () => {
  assert.match(String(regexSelectorCapabilityRefusal([{ tapOn: '^Login$' }])), /regex/);
});

test('id selectors pass regex preflight', () => {
  assert.equal(regexSelectorCapabilityRefusal([{ tapOn: { id: 'fab-create-task' } }]), null);
});

test('upsertEnginePinHeader inserts after status and is idempotent', () => {
  const source = '# id: x\n# intent: y\n# status: active\n- launchApp\n';
  const first = upsertEnginePinHeader(source);
  assert.equal(first.changed, true);
  assert.match(first.text, new RegExp(`# enginePin: ${ACTION_ENGINE_PIN}`));
  const second = upsertEnginePinHeader(first.text);
  assert.equal(second.changed, false);
  assert.equal(second.text, first.text);
});

test('migrateLearnedActions stamps compatible YAML and leaves regex actions unmutated', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-action-migrate-'));
  const dir = join(root, '.rn-agent', 'actions');
  mkdirSync(dir, { recursive: true });
  const okPath = join(dir, 'ok.yaml');
  const badPath = join(dir, 'regex.yaml');
  writeFileSync(
    okPath,
    'appId: com.x\n---\n# id: ok\n# intent: do it\n# status: active\n- tapOn:\n    id: "a"\n',
    'utf8',
  );
  writeFileSync(
    badPath,
    'appId: com.x\n---\n# id: regex\n# intent: bad\n# status: active\n- tapOn: ".*Nope.*"\n',
    'utf8',
  );
  const results = migrateLearnedActions(root);
  const ok = results.find((r) => r.id === 'ok');
  const bad = results.find((r) => r.id === 'regex');
  assert.equal(ok?.status, 'migrated');
  assert.equal(ok?.mutated, true);
  assert.match(readFileSync(okPath, 'utf8'), /enginePin: maestro-runner@1\.1\.24/);
  assert.equal(bad?.status, 'incompatible');
  assert.equal(bad?.mutated, false);
  assert.doesNotMatch(readFileSync(badPath, 'utf8'), /enginePin/);
});

test('migrateLearnedActions expands contained runFlow files before pinning', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-action-subflow-'));
  const dir = join(root, '.rn-agent', 'actions');
  const subflows = join(dir, 'subflows');
  mkdirSync(subflows, { recursive: true });
  writeFileSync(join(subflows, 'steps.yaml'), '- tapOn:\n    id: "continue"\n', 'utf8');
  const actionPath = join(dir, 'with-subflow.yaml');
  writeFileSync(
    actionPath,
    'appId: com.x\n---\n# id: with-subflow\n# intent: do it\n# status: active\n- runFlow: subflows/steps.yaml\n',
    'utf8',
  );
  const result = migrateLearnedActions(root).find((row) => row.id === 'with-subflow');
  assert.equal(result?.status, 'migrated');
  assert.match(readFileSync(actionPath, 'utf8'), /enginePin: maestro-runner@1\.1\.24/);
});

test('maestro_run refuses a drifted learned action before spawn', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-action-direct-'));
  const dir = join(root, '.rn-agent', 'actions');
  mkdirSync(dir, { recursive: true });
  const flowPath = join(dir, 'login.yaml');
  writeFileSync(flowPath, actionYaml('login', '# enginePin: maestro-runner@1.0.9'), 'utf8');
  let spawned = false;
  const handler = createMaestroRunHandler({
    getActiveSession: () => ({ platform: 'ios', deviceId: 'SIM', appId: 'com.test.app' }) as never,
    chooseDispatch: () => ({
      runner: 'maestro-runner',
      binPath: '/fake/maestro-runner',
      buildArgs: () => ['test', flowPath],
    }),
    resolveEngineStatus: async () => PINNED(),
    execFile: async () => {
      spawned = true;
      return { stdout: '', stderr: '' };
    },
  });
  const result = await handler({ platform: 'ios', flowPath });
  const body = JSON.parse(result.content[0]!.text);
  assert.equal(body.ok, false);
  assert.match(String(body.error), /1\.0\.9/);
  assert.equal(spawned, false);
});

test('inline replay refuses selectors before spawn', async () => {
  let spawned = false;
  const result = await runMaestroInline(
    '- tapOn: "^Login$"',
    { platform: 'ios' },
    {
      chooseDispatch: () => ({
        runner: 'maestro-runner',
        binPath: '/fake/maestro-runner',
        buildArgs: () => [],
      }),
      resolveEngineStatus: async () => PINNED(),
      spawnManaged: async () => {
        spawned = true;
        throw new Error('must not spawn');
      },
    },
  );
  assert.equal(result.passed, false);
  assert.match(String(result.error), /regex/);
  assert.equal(spawned, false);
});

test('NODE_TEST_CONTEXT cannot bypass a corrupt pin-cache binary', async () => {
  const previousCache = process.env.RN_DEV_AGENT_RUNNER_CACHE;
  const cache = mkdtempSync(join(tmpdir(), 'rn-corrupt-pin-'));
  const bin = join(cache, 'maestro-runner', MAESTRO_RUNNER_PIN.version, 'bin', 'maestro-runner');
  mkdirSync(join(bin, '..'), { recursive: true });
  writeFileSync(bin, '#!/bin/sh\necho maestro-runner 1.1.24\n', 'utf8');
  chmodSync(bin, 0o755);
  process.env.RN_DEV_AGENT_RUNNER_CACHE = cache;
  let spawned = false;
  try {
    const handler = createMaestroRunHandler({
      getActiveSession: () => ({ platform: 'ios', deviceId: 'SIM' }) as never,
      chooseDispatch: () => ({
        runner: 'maestro-runner',
        binPath: bin,
        buildArgs: () => [],
      }),
      execFile: async () => {
        spawned = true;
        return { stdout: '', stderr: '' };
      },
    });
    const result = await handler({ platform: 'ios', inlineYaml: '- tapOn: Continue' });
    const body = JSON.parse(result.content[0]!.text);
    assert.equal(body.ok, false);
    assert.match(String(body.error), /checksum/);
    assert.equal(spawned, false);
  } finally {
    if (previousCache === undefined) delete process.env.RN_DEV_AGENT_RUNNER_CACHE;
    else process.env.RN_DEV_AGENT_RUNNER_CACHE = previousCache;
  }
});

test('run-action pin mismatch refuses before maestro and before CDP probe', async () => {
  const project = createTmpProject();
  try {
    const yaml = actionYaml('no-fallback', '# enginePin: maestro-runner@1.0.9');
    project.seedAction('no-fallback', yaml);
    const maestroCalls: number[] = [];
    const probeCalls: number[] = [];
    const handler = createRunActionHandler({
      maestroRun: async () => {
        maestroCalls.push(1);
        return { content: [{ type: 'text', text: '{"ok":true}' }] };
      },
      replayDeps: () => ({
        pressByTestId: async () => {
          probeCalls.push(1);
        },
        typeByTestId: async () => {},
        treeFor: async () => ({}),
        launchApp: async () => {},
        settle: async () => {},
      }),
      engineStatus: async () => PINNED(),
    });
    const result = await handler({ actionId: 'no-fallback', projectRoot: project.root });
    assert.equal(result.isError, true);
    const body = JSON.parse(result.content[0]!.text);
    assert.equal(body.code, 'ENGINE_PIN_MISMATCH');
    assert.equal(body.meta.fallback, 'none');
    assert.match(String(body.error), /maestro-runner@1\.0\.9/);
    assert.equal(maestroCalls.length, 0);
    assert.equal(probeCalls.length, 0);
  } finally {
    project.cleanup();
  }
});

test('actionReplayPreflight is session-pin then format then selector', () => {
  const drifted = buildReplayEngineStatus('drift-newer', '1.2.0', false);
  assert.match(
    String(
      actionReplayPreflight({ enginePin: ACTION_ENGINE_PIN, commands: [], engineStatus: drifted }),
    ),
    /newer/,
  );
  assert.match(
    String(
      actionReplayPreflight({
        enginePin: undefined,
        commands: [{ tapOn: { id: 'x' } }],
        engineStatus: PINNED(),
      }),
    ),
    /not migrated/,
  );
  assert.match(
    String(
      actionReplayPreflight({
        enginePin: ACTION_ENGINE_PIN,
        commands: [{ tapOn: '.*x.*' }],
        engineStatus: PINNED(),
      }),
    ),
    /regex text selectors/,
  );
  assert.equal(
    actionReplayPreflight({
      enginePin: ACTION_ENGINE_PIN,
      commands: [{ tapOn: { id: 'x' } }],
      engineStatus: PINNED(),
    }),
    null,
  );
});

test('maestro_test_all refuses before spawn when the exact pin is missing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rn-test-all-pin-'));
  writeFileSync(join(dir, 'browse.yaml'), 'appId: com.test.app\n---\n- tapOn:\n    id: "browse"\n');
  let spawned = false;
  const handler = createMaestroTestAllHandler({
    getActiveSession: () => ({ platform: 'ios', deviceId: 'SIM', appId: 'com.test.app' }) as never,
    chooseDispatch: () => ({
      runner: 'maestro-runner',
      binPath: '/fake/maestro-runner',
      buildArgs: () => ['test', 'browse.yaml'],
    }),
    resolveEngineStatus: async () => buildReplayEngineStatus('not-installed', null, false),
    execFile: async () => {
      spawned = true;
      return { stdout: '', stderr: '' };
    },
  });
  const result = await handler({ platform: 'ios', flowDir: dir });
  const body = JSON.parse(result.content[0]!.text);
  assert.equal(body.ok, false);
  assert.equal(spawned, false);
  assert.equal(result.isError, true);
  assert.match(String(body.error), /1\.1\.24|pin-cache|not installed/i);
});

test('maestro_test_all requires M7 engine metadata in the owned corpus', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-owned-suite-'));
  const dir = join(root, '.rn-agent', 'actions');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'browse.yaml'), 'appId: com.test.app\n---\n- tapOn: Browse\n');
  let spawned = false;
  const handler = createMaestroTestAllHandler({
    getActiveSession: () => ({ platform: 'ios', deviceId: 'SIM', appId: 'com.test.app' }) as never,
    chooseDispatch: () => ({
      runner: 'maestro-runner',
      binPath: '/fake/maestro-runner',
      buildArgs: () => [],
    }),
    resolveEngineStatus: async () => PINNED(),
    execFile: async () => {
      spawned = true;
      return { stdout: '', stderr: '' };
    },
  });
  const result = await handler({ platform: 'ios', flowDir: dir });
  const body = JSON.parse(result.content[0]!.text);
  assert.equal(body.data.failed, 1);
  assert.match(String(body.data.results[0].error), /not migrated/);
  assert.equal(spawned, false);
});
