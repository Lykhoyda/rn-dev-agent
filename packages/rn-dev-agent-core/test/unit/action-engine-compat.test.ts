import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
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
import { createMaestroGenerateHandler } from '../../dist/tools/maestro-generate.js';
import { generateMaestro } from '../../dist/tools/test-recorder-generators.js';
import { listActions } from '../../dist/domain/action-inventory.js';
import { atomicWriter } from '../../dist/domain/atomic-writer.js';
import { freshRuntimeState } from '../../dist/domain/reusable-action.js';
import { sidecarPathFor } from '../../dist/domain/sidecar-io.js';
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

test('wildcard regex text selectors such as Log.n are refused', () => {
  assert.match(String(regexSelectorCapabilityRefusal([{ tapOn: 'Log.n' }])), /regex/);
});

test('selector preflight covers command-specific selector shapes', () => {
  assert.match(
    String(
      regexSelectorCapabilityRefusal([
        { scrollUntilVisible: { element: 'Log.n', direction: 'DOWN' } },
      ]),
    ),
    /Log\.n/,
  );
  assert.match(
    String(regexSelectorCapabilityRefusal([{ copyTextFrom: 'Order.*' }])),
    /Order\.\*/,
  );
  assert.match(
    String(
      regexSelectorCapabilityRefusal([
        { runFlow: { when: { visible: { below: 'Sign.in' } }, commands: [] } },
      ]),
    ),
    /Sign\.in/,
  );
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

test('upsertEnginePinHeader normalizes duplicate pin headers', () => {
  const source =
    '# id: x\n# intent: y\n# enginePin: maestro-runner@1.1.24\n# enginePin: maestro-runner@1.0.9\n- launchApp\n';
  const updated = upsertEnginePinHeader(source);
  assert.equal(updated.changed, true);
  assert.equal(updated.text.match(/# enginePin:/g)?.length, 1);
  assert.match(updated.text, /# enginePin: maestro-runner@1\.1\.24/);
});

test('migrateLearnedActions stamps compatible YAML and leaves regex actions unmutated', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-action-migrate-'));
  const dir = join(root, '.rn-agent', 'actions');
  mkdirSync(dir, { recursive: true });
  const okPath = join(dir, 'ok.yaml');
  const ymlPath = join(dir, 'ok-yml.yml');
  const badPath = join(dir, 'regex.yaml');
  writeFileSync(
    okPath,
    'appId: com.x\n---\n# id: ok\n# intent: do it\n# status: active\n- tapOn:\n    id: "a"\n',
    'utf8',
  );
  writeFileSync(
    ymlPath,
    'appId: com.x\n---\n# id: ok-yml\n# intent: do it\n# status: active\n- tapOn:\n    id: "b"\n',
    'utf8',
  );
  writeFileSync(
    badPath,
    'appId: com.x\n---\n# id: regex\n# intent: bad\n# status: active\n- tapOn: ".*Nope.*"\n',
    'utf8',
  );
  const results = migrateLearnedActions(root);
  const ok = results.find((r) => r.id === 'ok');
  const yml = results.find((r) => r.id === 'ok-yml');
  const bad = results.find((r) => r.id === 'regex');
  assert.equal(ok?.status, 'migrated');
  assert.equal(ok?.mutated, true);
  assert.match(readFileSync(okPath, 'utf8'), /enginePin: maestro-runner@1\.1\.24/);
  assert.equal(yml?.status, 'migrated');
  assert.match(readFileSync(ymlPath, 'utf8'), /enginePin: maestro-runner@1\.1\.24/);
  assert.equal(bad?.status, 'incompatible');
  assert.equal(bad?.mutated, false);
  assert.doesNotMatch(readFileSync(badPath, 'utf8'), /enginePin/);
});

test('migrateLearnedActions atomically rebaselines an existing action sidecar', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-action-migrate-state-'));
  const dir = join(root, '.rn-agent', 'actions');
  mkdirSync(dir, { recursive: true });
  const actionPath = join(dir, 'checkout.yaml');
  writeFileSync(actionPath, actionYaml('checkout'), 'utf8');
  const sidecarPath = sidecarPathFor(actionPath);
  mkdirSync(join(sidecarPath, '..'), { recursive: true });
  const priorState = {
    ...freshRuntimeState(() => new Date('2026-01-01T00:00:00Z'), 1),
    revision: 7,
  };
  writeFileSync(sidecarPath, `${JSON.stringify(priorState)}\n`, 'utf8');

  const result = migrateLearnedActions(root).find((row) => row.id === 'checkout');
  const nextState = JSON.parse(readFileSync(sidecarPath, 'utf8'));

  assert.equal(result?.status, 'migrated');
  assert.equal(nextState.revision, 7);
  assert.ok(nextState.lastSeenMtimeMs >= statSync(actionPath).mtimeMs);
});

test('migrateLearnedActions preserves the previous YAML when its atomic write fails', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'rn-action-migrate-atomic-'));
  const dir = join(root, '.rn-agent', 'actions');
  mkdirSync(dir, { recursive: true });
  const actionPath = join(dir, 'checkout.yaml');
  const source = actionYaml('checkout');
  writeFileSync(actionPath, source, 'utf8');
  const originalWrite = atomicWriter._writeFile;
  t.mock.method(atomicWriter, '_writeFile', (path: string, content: string) => {
    if (path.startsWith(`${actionPath}.tmp.`)) throw new Error('ENOSPC');
    originalWrite(path, content);
  });

  const result = migrateLearnedActions(root).find((row) => row.id === 'checkout');

  assert.equal(result?.status, 'unreadable');
  assert.equal(readFileSync(actionPath, 'utf8'), source);
});

test('recorder refuses to stamp regex-shaped selectors as compatible actions', () => {
  assert.throws(
    () =>
      generateMaestro([{ type: 'tap', label: 'Log.n', t: 1 }], {
        id: 'open-log',
        intent: 'Open the visible log',
      }),
    /regex text selectors.*Log\.n/,
  );
});

test('migrateLearnedActions refuses inherited .rn-agent/actions symlinks', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-action-symlink-'));
  const shared = mkdtempSync(join(tmpdir(), 'rn-action-shared-'));
  const sharedActions = join(shared, 'actions');
  mkdirSync(sharedActions, { recursive: true });
  const sharedPath = join(sharedActions, 'ok.yaml');
  writeFileSync(
    sharedPath,
    'appId: com.x\n---\n# id: ok\n# intent: do it\n# status: active\n- tapOn:\n    id: "a"\n',
    'utf8',
  );
  mkdirSync(join(root, '.rn-agent'));
  symlinkSync(sharedActions, join(root, '.rn-agent', 'actions'));
  const results = migrateLearnedActions(root);
  assert.equal(results.length, 1);
  assert.equal(results[0]?.status, 'incompatible');
  assert.equal(results[0]?.mutated, false);
  assert.match(
    String(results[0]?.reason),
    /symlink-inherited|inherited \.rn-agent\/actions symlink/i,
  );
  assert.doesNotMatch(readFileSync(sharedPath, 'utf8'), /enginePin/);
});

test('migrateLearnedActions refuses per-file action symlinks', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-action-file-symlink-'));
  const shared = mkdtempSync(join(tmpdir(), 'rn-action-file-shared-'));
  const sharedPath = join(shared, 'shared.yml');
  writeFileSync(
    sharedPath,
    'appId: com.x\n---\n# id: shared\n# intent: do it\n# status: active\n- tapOn:\n    id: "a"\n',
    'utf8',
  );
  const dir = join(root, '.rn-agent', 'actions');
  mkdirSync(dir, { recursive: true });
  symlinkSync(sharedPath, join(dir, 'shared.yml'));
  const results = migrateLearnedActions(root);
  assert.equal(results.length, 1);
  assert.equal(results[0]?.status, 'incompatible');
  assert.equal(results[0]?.mutated, false);
  assert.match(String(results[0]?.reason), /inherited action symlink/i);
  assert.doesNotMatch(readFileSync(sharedPath, 'utf8'), /enginePin/);
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

test('migrateLearnedActions refuses yaml and yml action-id collisions without mutation', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-action-migrate-collision-'));
  const dir = join(root, '.rn-agent', 'actions');
  mkdirSync(dir, { recursive: true });
  const yamlPath = join(dir, 'login.yaml');
  const ymlPath = join(dir, 'login.yml');
  const source = actionYaml('login');
  writeFileSync(yamlPath, source, 'utf8');
  writeFileSync(ymlPath, source, 'utf8');

  const results = migrateLearnedActions(root);

  assert.equal(results.length, 2);
  assert.equal(results.every((result) => result.status === 'incompatible'), true);
  assert.equal(results.every((result) => result.mutated === false), true);
  assert.equal(results.every((result) => /both login\.yaml and login\.yml/.test(result.reason ?? '')), true);
  assert.equal(readFileSync(yamlPath, 'utf8'), source);
  assert.equal(readFileSync(ymlPath, 'utf8'), source);
});

test('migrateLearnedActions reports a non-directory corpus as unreadable', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-action-unreadable-'));
  mkdirSync(join(root, '.rn-agent'));
  writeFileSync(join(root, '.rn-agent', 'actions'), 'not a directory', 'utf8');
  const results = migrateLearnedActions(root);
  assert.equal(results.length, 1);
  assert.equal(results[0]?.status, 'unreadable');
  assert.equal(results[0]?.mutated, false);
});

test('cdp_run_action resolves yml actions and refuses extension collisions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-action-yml-replay-'));
  const dir = join(root, '.rn-agent', 'actions');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'login.yml'),
    actionYaml('login', '# enginePin: maestro-runner@1.0.9'),
    'utf8',
  );
  let spawned = false;
  const handler = createRunActionHandler({
    maestroRun: async () => {
      spawned = true;
      return { content: [{ type: 'text', text: '{"ok":true}' }] };
    },
    engineStatus: async () => PINNED(),
  });
  const ymlResult = await handler({ actionId: 'login', projectRoot: root });
  assert.match(String(JSON.parse(ymlResult.content[0]!.text).error), /1\.0\.9/);
  assert.equal(spawned, false);

  writeFileSync(
    join(dir, 'login.yaml'),
    actionYaml('login', '# enginePin: maestro-runner@1.1.24'),
    'utf8',
  );
  const collision = await handler({ actionId: 'login', projectRoot: root });
  assert.match(String(JSON.parse(collision.content[0]!.text).error), /both login\.yaml and login\.yml/);
  assert.equal(spawned, false);
});

test('cdp_run_action preflights relative subflows from the action directory', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-action-subflow-replay-'));
  const dir = join(root, '.rn-agent', 'actions');
  mkdirSync(join(dir, 'subflows'), { recursive: true });
  writeFileSync(join(dir, 'subflows', 'steps.yaml'), '- tapOn:\n    id: "continue"\n', 'utf8');
  writeFileSync(
    join(dir, 'checkout.yaml'),
    actionYaml(
      'checkout',
      '# enginePin: maestro-runner@1.1.24',
      '- runFlow: subflows/steps.yaml\n',
    ),
    'utf8',
  );
  let replayedPath: string | undefined;
  const handler = createRunActionHandler({
    maestroRun: async (args) => {
      replayedPath = args.flowPath;
      return { content: [{ type: 'text', text: '{"ok":true,"data":{"passed":true}}' }] };
    },
    engineStatus: async () => PINNED(),
  });

  const result = await handler({ actionId: 'checkout', projectRoot: root });
  const envelope = JSON.parse(result.content[0]!.text);

  assert.equal(envelope.ok, true);
  assert.equal(replayedPath, join(dir, 'checkout.yaml'));
});

test('maestro_generate emits a pinned replayable action without regex waits', async () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'rn-maestro-generate-'));
  const result = await createMaestroGenerateHandler()({
    name: 'Wait for checkout',
    outputDir,
    appId: 'com.test.app',
    steps: [{ action: 'wait', waitMs: 5000 }, { action: 'tap', testID: 'checkout' }],
  });
  const envelope = JSON.parse(result.content[0]!.text);
  assert.equal(envelope.ok, true);
  const generated = readFileSync(join(outputDir, 'wait-for-checkout.yaml'), 'utf8');
  assert.match(generated, /# id: wait-for-checkout/);
  assert.match(generated, /# intent: Wait for checkout/);
  assert.match(generated, /# enginePin: maestro-runner@1\.1\.24/);
  assert.match(generated, /waitForAnimationToEnd/);
  assert.doesNotMatch(generated, /visible:\s*['"]?\.\*/);
});

test('maestro_generate refuses invalid action ids before writing', async () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'rn-maestro-generate-invalid-'));
  for (const name of [' login', 'a'.repeat(65)]) {
    const result = await createMaestroGenerateHandler()({
      name,
      outputDir,
      steps: [{ action: 'tap', testID: 'continue' }],
    });
    assert.equal(JSON.parse(result.content[0]!.text).ok, false);
  }
  assert.equal(existsSync(join(outputDir, '-login.yaml')), false);
  assert.equal(existsSync(join(outputDir, `${'a'.repeat(65)}.yaml`)), false);
});

test('maestro_generate refuses unsafe metadata and incomplete steps before writing', async () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'rn-maestro-generate-shape-'));
  for (const args of [
    { name: 'unsafe\u0085intent', steps: [{ action: 'tap', testID: 'continue' }] },
    { name: 'missing tap target', steps: [{ action: 'tap' }] },
    { name: 'missing fill input', steps: [{ action: 'fill', testID: 'email' }] },
    { name: 'missing assertion target', steps: [{ action: 'assert' }] },
    { name: 'missing navigation url', steps: [{ action: 'navigate' }] },
    { name: 'invalid wait', steps: [{ action: 'wait', waitMs: 0 }] },
  ] as const) {
    const result = await createMaestroGenerateHandler()({ ...args, outputDir });
    assert.equal(JSON.parse(result.content[0]!.text).ok, false);
  }
  assert.deepEqual(readdirSync(outputDir), []);
});

test('maestro_generate refuses an existing yml action instead of creating a collision', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-maestro-generate-collision-'));
  const outputDir = join(root, '.rn-agent', 'actions');
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, 'login.yml'), actionYaml('login'), 'utf8');

  const result = await createMaestroGenerateHandler()({
    name: 'login',
    outputDir,
    steps: [{ action: 'tap', testID: 'continue' }],
  });

  const envelope = JSON.parse(result.content[0]!.text);
  assert.equal(envelope.ok, false);
  assert.match(String(envelope.error), /already exists/);
  assert.equal(existsSync(join(outputDir, 'login.yaml')), false);
});

test('maestro_generate refuses symlinked corpus ownership and dangling action links', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-maestro-generate-symlink-'));
  const rnAgentDir = join(root, '.rn-agent');
  const externalProject = mkdtempSync(join(tmpdir(), 'rn-maestro-generate-owner-'));
  const externalDir = join(externalProject, '.rn-agent', 'actions');
  mkdirSync(rnAgentDir, { recursive: true });
  mkdirSync(externalDir, { recursive: true });
  const outputDir = join(rnAgentDir, 'actions');
  symlinkSync(externalDir, outputDir, 'dir');

  const inherited = await createMaestroGenerateHandler()({
    name: 'login',
    outputDir,
    steps: [{ action: 'tap', testID: 'continue' }],
  });
  assert.equal(JSON.parse(inherited.content[0]!.text).ok, false);
  assert.equal(existsSync(join(externalDir, 'login.yaml')), false);

  const localRoot = mkdtempSync(join(tmpdir(), 'rn-maestro-generate-dangling-'));
  const localActions = join(localRoot, '.rn-agent', 'actions');
  mkdirSync(localActions, { recursive: true });
  symlinkSync(join(localRoot, 'missing.yml'), join(localActions, 'login.yml'));
  const dangling = await createMaestroGenerateHandler()({
    name: 'login',
    outputDir: localActions,
    steps: [{ action: 'tap', testID: 'continue' }],
  });
  assert.equal(JSON.parse(dangling.content[0]!.text).ok, false);
  assert.equal(existsSync(join(localActions, 'login.yaml')), false);
});

test('Observe action inventory refuses symlinked corpora and extension collisions', async () => {
  const inheritedRoot = mkdtempSync(join(tmpdir(), 'rn-action-inventory-symlink-'));
  const inheritedAgent = join(inheritedRoot, '.rn-agent');
  const externalDir = mkdtempSync(join(tmpdir(), 'rn-action-inventory-external-'));
  mkdirSync(inheritedAgent, { recursive: true });
  writeFileSync(join(externalDir, 'login.yaml'), actionYaml('login'), 'utf8');
  symlinkSync(externalDir, join(inheritedAgent, 'actions'), 'dir');
  await assert.rejects(() => listActions(inheritedRoot), /corpus symlink/);

  const collisionRoot = mkdtempSync(join(tmpdir(), 'rn-action-inventory-collision-'));
  const collisionDir = join(collisionRoot, '.rn-agent', 'actions');
  mkdirSync(collisionDir, { recursive: true });
  const source = actionYaml('login');
  writeFileSync(join(collisionDir, 'login.yaml'), source, 'utf8');
  writeFileSync(join(collisionDir, 'login.yml'), source, 'utf8');
  await assert.rejects(() => listActions(collisionRoot), /both login\.yaml and login\.yml/);
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

test('maestro_run enforces M7 engine metadata outside the learned-action directory', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rn-moved-action-'));
  const flowPath = join(dir, 'login.yaml');
  writeFileSync(flowPath, actionYaml('login', '# enginePin: maestro-runner@1.0.9'), 'utf8');
  let spawned = false;
  const handler = createMaestroRunHandler({
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

  const result = await handler({ platform: 'ios', flowPath });
  const envelope = JSON.parse(result.content[0]!.text);

  assert.equal(envelope.ok, false);
  assert.match(String(envelope.error), /maestro-runner@1\.0\.9/);
  assert.equal(spawned, false);
});

test('maestro_run refuses ambiguous actions and standalone action descendants', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-action-path-boundary-'));
  const dir = join(root, '.rn-agent', 'actions');
  const subflows = join(dir, 'subflows');
  mkdirSync(subflows, { recursive: true });
  const source = actionYaml('login', '# enginePin: maestro-runner@1.1.24');
  writeFileSync(join(dir, 'login.yaml'), source, 'utf8');
  writeFileSync(join(dir, 'login.yml'), source, 'utf8');
  const descendant = join(subflows, 'steps.yaml');
  writeFileSync(descendant, '- tapOn:\n    id: "continue"\n', 'utf8');
  const descendantAlias = join(root, 'steps-link.yaml');
  symlinkSync(descendant, descendantAlias);
  let spawned = false;
  const handler = createMaestroRunHandler({
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

  for (const flowPath of [join(dir, 'login.yaml'), descendant, descendantAlias]) {
    const result = await handler({ platform: 'ios', flowPath });
    const envelope = JSON.parse(result.content[0]!.text);
    assert.equal(envelope.ok, false);
    assert.equal(envelope.code, 'BAD_RECORDING');
  }
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
  assert.equal(body.ok, false);
  assert.equal(body.meta.failed, 1);
  assert.equal(body.meta.executed, 0);
  assert.match(String(body.meta.results[0].error), /not migrated/);
  assert.equal(spawned, false);
});

test('maestro_test_all preflights the complete suite before any execution', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-owned-suite-preflight-'));
  const dir = join(root, '.rn-agent', 'actions');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'a.yaml'),
    actionYaml('a', '# enginePin: maestro-runner@1.1.24'),
    'utf8',
  );
  writeFileSync(
    join(dir, 'b.yaml'),
    actionYaml('b', '# enginePin: maestro-runner@1.1.24', '- copyTextFrom: "Log.n"\n'),
    'utf8',
  );
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
  assert.equal(body.ok, false);
  assert.equal(body.meta.executed, 0);
  assert.match(String(body.meta.results[0].error), /Log\.n|regex/);
  assert.equal(spawned, false);
});

test('maestro_test_all refuses action extension collisions before execution', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-owned-suite-collision-'));
  const dir = join(root, '.rn-agent', 'actions');
  mkdirSync(dir, { recursive: true });
  const source = actionYaml('login', '# enginePin: maestro-runner@1.1.24');
  writeFileSync(join(dir, 'login.yaml'), source, 'utf8');
  writeFileSync(join(dir, 'login.yml'), source, 'utf8');
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
  const envelope = JSON.parse(result.content[0]!.text);

  assert.equal(envelope.ok, false);
  assert.equal(envelope.meta.executed, 0);
  assert.equal(envelope.meta.failed, 2);
  assert.match(String(envelope.meta.results[0].error), /both login\.yaml and login\.yml/);
  assert.equal(spawned, false);
});

test('maestro_test_all refuses a nested action subflow directory', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-owned-suite-descendant-'));
  const dir = join(root, '.rn-agent', 'actions', 'subflows');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'steps.yaml'), '- tapOn:\n    id: "continue"\n', 'utf8');
  const directoryAlias = join(root, 'subflow-link');
  symlinkSync(dir, directoryAlias, 'dir');
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

  for (const flowDir of [dir, directoryAlias]) {
    const result = await handler({ platform: 'ios', flowDir });
    const envelope = JSON.parse(result.content[0]!.text);
    assert.equal(envelope.ok, false);
    assert.match(String(envelope.error), /descendant/);
  }
  assert.equal(spawned, false);
});
