import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { authorityErrorMeta, SessionAuthorityError } from '../../dist/session/registry.js';
import {
  createPinnedRunActionHandler as createRunActionHandler,
  createTmpProject,
  fixtureYaml,
} from '../helpers/tmp-project.js';

type Envelope = { ok: boolean; [key: string]: unknown };

const PASS_ENV = {
  ok: true,
  data: { passed: true, output: 'Flow passed', flowFile: 'x', platform: 'ios' },
};
const FAIL_SELECTOR_ENV = {
  ok: false,
  data: {
    passed: false,
    output: "Element with id 'fab-create-task' not found",
    flowFile: 'x',
    platform: 'ios',
  },
};
const FAIL_TIMEOUT_ENV = {
  ok: false,
  data: {
    passed: false,
    output: "Timed out waiting for element with id 'spinner-done'",
    flowFile: 'x',
    platform: 'ios',
  },
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

function fakeMaestroRun(envelopes: readonly Envelope[]) {
  let index = 0;
  return async () => {
    const envelope = envelopes[Math.min(index, envelopes.length - 1)];
    index += 1;
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(envelope) }],
      ...(envelope.ok === false ? { isError: true as const } : {}),
    };
  };
}

function fakeRepairAction(envelope: Envelope) {
  return async () => ({
    content: [{ type: 'text' as const, text: JSON.stringify(envelope) }],
    ...(envelope.ok === false ? { isError: true as const } : {}),
  });
}

function setupProject(t: TestContext) {
  const project = createTmpProject();
  t.after(() => project.cleanup());
  return project;
}

function setupRuntimeRoot(t: TestContext) {
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'rn-session-runtime-'));
  const priorRuntimeRoot = process.env.RN_DEV_AGENT_SESSION_RUNTIME_ROOT;
  process.env.RN_DEV_AGENT_SESSION_RUNTIME_ROOT = runtimeRoot;
  t.after(() => {
    if (priorRuntimeRoot === undefined) delete process.env.RN_DEV_AGENT_SESSION_RUNTIME_ROOT;
    else process.env.RN_DEV_AGENT_SESSION_RUNTIME_ROOT = priorRuntimeRoot;
    rmSync(runtimeRoot, { force: true, recursive: true });
  });
  return runtimeRoot;
}

function seedEditedRuntimeState(
  project: ReturnType<typeof createTmpProject>,
  runtimeRoot: string,
  selector: string,
) {
  const originalYaml = fixtureYaml({ id: 'demo', selectors: [selector] });
  project.seedAction('demo', originalYaml);
  const expectedPath = join(runtimeRoot, 'state', 'demo.state.json');
  mkdirSync(join(runtimeRoot, 'state'), { recursive: true });
  writeFileSync(expectedPath, JSON.stringify(project.readSidecar('demo')), 'utf8');
  project.simulateHumanEdit('demo', `${originalYaml}\n# operator edit\n`);
  return { expectedPath, originalYaml };
}

test('successful fenced replays disclose isolated sidecars while YAML promotion carries forward', async (t) => {
  const project = setupProject(t);
  project.seedAction('demo', fixtureYaml({ id: 'demo', selectors: ['fab-create-task'] }));
  const firstRuntimeRoot = mkdtempSync(join(tmpdir(), 'rn-session-runtime-a-'));
  const secondRuntimeRoot = mkdtempSync(join(tmpdir(), 'rn-session-runtime-b-'));
  const priorRuntimeRoot = process.env.RN_DEV_AGENT_SESSION_RUNTIME_ROOT;
  t.after(() => {
    if (priorRuntimeRoot === undefined) delete process.env.RN_DEV_AGENT_SESSION_RUNTIME_ROOT;
    else process.env.RN_DEV_AGENT_SESSION_RUNTIME_ROOT = priorRuntimeRoot;
    rmSync(firstRuntimeRoot, { force: true, recursive: true });
    rmSync(secondRuntimeRoot, { force: true, recursive: true });
  });

  process.env.RN_DEV_AGENT_SESSION_RUNTIME_ROOT = firstRuntimeRoot;
  const firstResult = await createRunActionHandler({
    maestroRun: fakeMaestroRun([PASS_ENV]),
  })({ actionId: 'demo', projectRoot: project.root });
  const firstEnvelope = JSON.parse(firstResult.content[0].text);
  const firstPath = join(firstRuntimeRoot, 'state', 'demo.state.json');

  assert.equal(firstEnvelope.ok, true);
  assert.equal(firstEnvelope.data.writes.runtimeStatePath, firstPath);
  assert.equal(readFileSync(project.yamlPath('demo'), 'utf8').includes('# status: active'), true);

  process.env.RN_DEV_AGENT_SESSION_RUNTIME_ROOT = secondRuntimeRoot;
  const secondResult = await createRunActionHandler({
    maestroRun: fakeMaestroRun([PASS_ENV]),
  })({ actionId: 'demo', projectRoot: project.root });
  const secondEnvelope = JSON.parse(secondResult.content[0].text);
  const secondPath = join(secondRuntimeRoot, 'state', 'demo.state.json');
  const firstState = JSON.parse(readFileSync(firstPath, 'utf8'));
  const secondState = JSON.parse(readFileSync(secondPath, 'utf8'));

  assert.equal(secondEnvelope.ok, true);
  assert.equal(secondEnvelope.data.writes.runtimeStatePath, secondPath);
  assert.notEqual(secondPath, firstPath);
  assert.equal(firstState.revision, 1);
  assert.equal(secondState.revision, 1);
  assert.equal(firstState.runHistory.length, 1);
  assert.equal(secondState.runHistory.length, 1);
  assert.deepEqual(secondState.repairHistory, []);
  assert.deepEqual(secondEnvelope.data.writes.actionYaml, {
    written: false,
    reason: 'repair-not-applied',
  });
  assert.equal(project.readSidecar('demo').runHistory.length, 0);
});

test('failed replay discloses the session-private runtime sidecar path', async (t) => {
  const project = setupProject(t);
  const runtimeRoot = setupRuntimeRoot(t);
  project.seedAction('demo', fixtureYaml({ id: 'demo', selectors: ['spinner-done'] }));
  const result = await createRunActionHandler({
    maestroRun: fakeMaestroRun([FAIL_TIMEOUT_ENV]),
    repairAction: fakeRepairAction(REPAIR_PATCHED_ENV),
  })({ actionId: 'demo', projectRoot: project.root, autoRepair: false });
  const envelope = JSON.parse(result.content[0].text);
  const expectedPath = join(runtimeRoot, 'state', 'demo.state.json');

  assert.equal(envelope.ok, false);
  assert.equal(envelope.meta.writes.runtimeState, 'sidecar');
  assert.equal(envelope.meta.writes.runtimeStatePath, expectedPath);
  assert.equal(existsSync(expectedPath), true);
  const sessionState = JSON.parse(readFileSync(expectedPath, 'utf8'));
  assert.equal(sessionState.revision, 1);
  assert.equal(sessionState.runHistory.length, 1);
  assert.equal(sessionState.runHistory[0].status, 'fail');
  assert.equal(project.readSidecar('demo').runHistory.length, 0);
});

test('forceReload disclosure survives a later target refusal', async (t) => {
  const project = setupProject(t);
  const runtimeRoot = setupRuntimeRoot(t);
  const { expectedPath } = seedEditedRuntimeState(project, runtimeRoot, 'spinner-done');
  const result = await createRunActionHandler({
    maestroRun: fakeMaestroRun([PASS_ENV]),
    targetContext: () => ({ platform: 'ios', deviceId: 'simulator-1' }),
  })({ actionId: 'demo', projectRoot: project.root, platform: 'android' });
  const envelope = JSON.parse(result.content[0].text);

  assert.equal(envelope.code, 'TARGET_SESSION_MISMATCH');
  assert.equal(envelope.meta.writes.runtimeStatePath, expectedPath);
  assert.equal(existsSync(expectedPath), true);
});

test('forceReload disclosure survives authority loss during replay', async (t) => {
  const project = setupProject(t);
  const runtimeRoot = setupRuntimeRoot(t);
  const { expectedPath } = seedEditedRuntimeState(project, runtimeRoot, 'spinner-done');
  const handler = createRunActionHandler({
    maestroRun: async () => {
      throw new SessionAuthorityError(
        'AUTHORITY_LOST_DURING_OPERATION',
        'device authority changed during replay',
      );
    },
  });

  await assert.rejects(
    () => handler({ actionId: 'demo', projectRoot: project.root }),
    (error) => {
      assert.ok(error instanceof SessionAuthorityError);
      assert.equal(authorityErrorMeta(error).writes.runtimeStatePath, expectedPath);
      return true;
    },
  );
});

test('earlier runtime path remains disclosed when RunRecord persistence is refused', async (t) => {
  const project = setupProject(t);
  const runtimeRoot = setupRuntimeRoot(t);
  const { expectedPath } = seedEditedRuntimeState(project, runtimeRoot, 'spinner-done');
  const result = await createRunActionHandler({
    maestroRun: async () => {
      writeFileSync(expectedPath, '{', 'utf8');
      return fakeMaestroRun([FAIL_TIMEOUT_ENV])();
    },
  })({ actionId: 'demo', projectRoot: project.root, autoRepair: false });
  const envelope = JSON.parse(result.content[0].text);

  assert.equal(envelope.meta.writes.runtimeState, 'refused-external-write');
  assert.equal(envelope.meta.writes.runtimeStatePath, expectedPath);
});

test('successful repair write is disclosed when repaired YAML is invalid', async (t) => {
  const project = setupProject(t);
  const runtimeRoot = setupRuntimeRoot(t);
  const originalYaml = fixtureYaml({ id: 'demo', selectors: ['fab-create-task'] });
  project.seedAction('demo', originalYaml);
  const expectedPath = join(runtimeRoot, 'state', 'demo.state.json');
  const result = await createRunActionHandler({
    maestroRun: fakeMaestroRun([FAIL_SELECTOR_ENV]),
    repairAction: async () => {
      mkdirSync(join(runtimeRoot, 'state'), { recursive: true });
      writeFileSync(expectedPath, JSON.stringify(project.readSidecar('demo')), 'utf8');
      writeFileSync(
        project.yamlPath('demo'),
        originalYaml.replace('- launchApp', '- runFlow: missing.yaml'),
        'utf8',
      );
      return fakeRepairAction({
        ...REPAIR_PATCHED_ENV,
        data: { ...REPAIR_PATCHED_ENV.data, sidecarPath: expectedPath },
      })();
    },
  })({ actionId: 'demo', projectRoot: project.root });
  const envelope = JSON.parse(result.content[0].text);

  assert.equal(envelope.code, 'BAD_RECORDING');
  assert.equal(envelope.meta.writes.runtimeStatePath, expectedPath);
  assert.equal(existsSync(expectedPath), true);
});

test('repair YAML write remains disclosed when action metadata disappears', async (t) => {
  const project = setupProject(t);
  const runtimeRoot = setupRuntimeRoot(t);
  project.seedAction('demo', fixtureYaml({ id: 'demo', selectors: ['fab-create-task'] }));
  const expectedPath = join(runtimeRoot, 'state', 'demo.state.json');
  const result = await createRunActionHandler({
    maestroRun: fakeMaestroRun([FAIL_SELECTOR_ENV]),
    repairAction: async () => {
      mkdirSync(join(runtimeRoot, 'state'), { recursive: true });
      writeFileSync(expectedPath, JSON.stringify(project.readSidecar('demo')), 'utf8');
      writeFileSync(project.yamlPath('demo'), 'appId: com.test.app\n---\n- launchApp\n', 'utf8');
      return fakeRepairAction({
        ...REPAIR_PATCHED_ENV,
        data: { ...REPAIR_PATCHED_ENV.data, sidecarPath: expectedPath },
      })();
    },
  })({ actionId: 'demo', projectRoot: project.root });
  const envelope = JSON.parse(result.content[0].text);

  assert.equal(envelope.code, 'NO_PROJECT_ROOT');
  assert.deepEqual(envelope.meta.writes.actionYaml, {
    written: true,
    authorized: true,
    reason: 'auto-repair',
  });
  assert.equal(envelope.meta.writes.runtimeStatePath, expectedPath);
});

test('repair YAML write remains disclosed when refresh throws', async (t) => {
  const project = setupProject(t);
  const runtimeRoot = setupRuntimeRoot(t);
  project.seedAction('demo', fixtureYaml({ id: 'demo', selectors: ['fab-create-task'] }));
  const expectedPath = join(runtimeRoot, 'state', 'demo.state.json');
  const result = await createRunActionHandler({
    maestroRun: fakeMaestroRun([FAIL_SELECTOR_ENV]),
    repairAction: async () => {
      mkdirSync(join(runtimeRoot, 'state'), { recursive: true });
      writeFileSync(expectedPath, JSON.stringify(project.readSidecar('demo')), 'utf8');
      rmSync(project.actionsDir, { force: true, recursive: true });
      writeFileSync(project.actionsDir, 'replaced while refreshing', 'utf8');
      return fakeRepairAction({
        ...REPAIR_PATCHED_ENV,
        data: { ...REPAIR_PATCHED_ENV.data, sidecarPath: expectedPath },
      })();
    },
  })({ actionId: 'demo', projectRoot: project.root });
  const envelope = JSON.parse(result.content[0].text);

  assert.match(envelope.error, /uncaught exception during orchestration/);
  assert.deepEqual(envelope.meta.writes.actionYaml, {
    written: true,
    authorized: true,
    reason: 'auto-repair',
  });
  assert.equal(envelope.meta.writes.runtimeStatePath, expectedPath);
});
