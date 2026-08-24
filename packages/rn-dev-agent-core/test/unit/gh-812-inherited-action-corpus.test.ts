import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import {
  applyInheritance,
  assertReadableActionOperationUnchanged,
  captureReadableActionOperationSnapshot,
  planInheritance,
  readableActionsSnapshot,
  resolveReadableActionCorpus,
  sameReadableActionCorpus,
} from '../../dist/session/worktree-inheritance.js';
import { listActions } from '../../dist/domain/action-inventory.js';
import {
  loadAction,
  loadActionFromContext,
  openReadableActionLoadContext,
  writeRecordedActionTransaction,
} from '../../dist/domain/action-store.js';
import {
  listUnfollowedDirectory,
  readUnfollowedFile,
  readUnfollowedFiles,
} from '../../dist/domain/unfollowed-file.js';
import {
  createPinnedRunActionHandler as createRunActionHandler,
  freshFixtureState,
  fixtureYaml,
} from '../helpers/tmp-project.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CORE_ROOT = join(HERE, '..', '..');
const INHERIT_CLI = join(CORE_ROOT, 'dist', 'worktree-inheritance.js');
const LEARNED_CLI = join(CORE_ROOT, 'dist', 'learned-actions.js');

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return (result.stdout ?? '').trim();
}

function nodeCli(
  entry: string,
  args: string[],
  cwd: string,
  options: { env?: NodeJS.ProcessEnv; timeout?: number } = {},
) {
  const result = spawnSync(process.execPath, [entry, ...args], {
    cwd,
    encoding: 'utf8',
    env: options.env ?? process.env,
    timeout: options.timeout ?? 60_000,
  });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

interface Fixture {
  root: string;
  primary: string;
  cleanup: () => void;
}

function makeFixture(): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'rn-812-')));
  const primary = join(root, 'primary');
  mkdirSync(primary, { recursive: true });
  git(root, ['init', '-q', primary]);
  git(primary, ['config', 'user.email', 'fixture@example.test']);
  git(primary, ['config', 'user.name', 'fixture']);
  git(primary, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(
    join(primary, 'package.json'),
    JSON.stringify({ name: 'app', dependencies: { 'react-native': '0.76.0' } }),
  );
  writeFileSync(join(primary, '.gitignore'), '.rn-agent/\n');
  git(primary, ['add', '-A']);
  git(primary, ['commit', '-qm', 'init']);
  return { root, primary, cleanup: () => rmSync(root, { force: true, recursive: true }) };
}

function seedLoginCorpus(primary: string, id = 'login'): void {
  mkdirSync(join(primary, '.rn-agent', 'actions'), { recursive: true });
  mkdirSync(join(primary, '.rn-agent', 'state'), { recursive: true });
  writeFileSync(join(primary, '.rn-agent', 'actions', `${id}.yaml`), fixtureYaml({ id }));
}

function addWorktree(fixture: Fixture, name = 'linked'): string {
  const worktree = join(fixture.root, name);
  git(fixture.primary, ['worktree', 'add', '-q', worktree, '-b', name]);
  return worktree;
}

function inherit(worktree: string): void {
  const report = applyInheritance({ cwd: worktree, appRoot: worktree, host: 'claude' });
  assert.equal(report.applied, 1, JSON.stringify(report));
}

interface GitProbeCall {
  args: string[];
  cwd: string;
}

function createGitProbe(fixture: Fixture): {
  env: NodeJS.ProcessEnv;
  readCalls: () => GitProbeCall[];
  reset: () => void;
} {
  const directory = join(fixture.root, 'git-probe');
  const executable = join(directory, 'git');
  const log = join(directory, 'calls.jsonl');
  mkdirSync(directory);
  writeFileSync(
    executable,
    `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const { delimiter, dirname } = require('node:path');
const args = process.argv.slice(2);
appendFileSync(process.env.RN_GIT_PROBE_LOG, JSON.stringify({ args, cwd: process.cwd() }) + '\\n');
const wrapperDirectory = dirname(process.argv[1]);
const cleanPath = (process.env.PATH || '').split(delimiter).filter((entry) => entry !== wrapperDirectory).join(delimiter);
const result = spawnSync('git', args, { encoding: 'utf8', env: { ...process.env, PATH: cleanPath }, stdio: ['ignore', 'pipe', 'pipe'] });
if (result.error) throw result.error;
let stdout = result.stdout || '';
if (args.join(' ') === 'worktree list --porcelain') {
  if (process.env.RN_GIT_PROBE_EMPTY_LIST) stdout = '';
  if (process.env.RN_GIT_PROBE_MAIN_PATH) stdout = stdout.replace(/^worktree [^\\n]*/m, 'worktree ' + process.env.RN_GIT_PROBE_MAIN_PATH);
  if (process.env.RN_GIT_PROBE_MAIN_MARKER) stdout = stdout.replace(/^(worktree [^\\n]*)/m, '$1\\n' + process.env.RN_GIT_PROBE_MAIN_MARKER);
  if (process.env.RN_GIT_PROBE_MALFORMED_MAIN) stdout = stdout.replace(/^worktree [^\\n]*/m, 'HEAD malformed-main');
}
if (process.cwd() === process.env.RN_GIT_PROBE_PRIMARY && args.join(' ') === 'rev-parse --path-format=absolute --git-common-dir' && process.env.RN_GIT_PROBE_PRIMARY_COMMON) {
  stdout = process.env.RN_GIT_PROBE_PRIMARY_COMMON + '\\n';
}
if (process.cwd() === process.env.RN_GIT_PROBE_PRIMARY && args.join(' ') === 'rev-parse --show-toplevel' && process.env.RN_GIT_PROBE_PRIMARY_TOP) {
  stdout = process.env.RN_GIT_PROBE_PRIMARY_TOP + '\\n';
}
if (process.cwd() === process.env.RN_GIT_PROBE_PRIMARY && args.join(' ') === 'rev-parse --path-format=absolute --git-dir' && process.env.RN_GIT_PROBE_PRIMARY_GIT_DIR) {
  stdout = process.env.RN_GIT_PROBE_PRIMARY_GIT_DIR + '\\n';
}
process.stdout.write(stdout);
process.stderr.write(result.stderr || '');
process.exit(result.status ?? 1);
`,
  );
  chmodSync(executable, 0o700);
  writeFileSync(log, '');
  return {
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH ?? ''}`,
      RN_GIT_PROBE_LOG: log,
      RN_GIT_PROBE_PRIMARY: fixture.primary,
    },
    readCalls: () =>
      readFileSync(log, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as GitProbeCall),
    reset: () => writeFileSync(log, ''),
  };
}

function countGitCalls(calls: GitProbeCall[], cwd: string, args: readonly string[]): number {
  return calls.filter((call) => call.cwd === cwd && call.args.join('\0') === args.join('\0'))
    .length;
}

function normalizedGitCalls(calls: GitProbeCall[]): string[] {
  return calls.map((call) => `${call.cwd}\0${call.args.join('\0')}`);
}

function snapshotTree(root: string): string {
  const hashes: string[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries.sort()) {
      const path = join(dir, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        hashes.push(`${path}\tlink:${readlinkSync(path)}`);
        continue;
      }
      if (stat.isDirectory()) {
        walk(path);
        continue;
      }
      hashes.push(`${path}\t${createHash('sha256').update(readFileSync(path)).digest('hex')}`);
    }
  };
  walk(root);
  return hashes.join('\n');
}

test('real actions directory stays readable for inventory and exact-ID load', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-812-real-'));
  try {
    seedLoginCorpus(root);
    const corpus = resolveReadableActionCorpus(root);
    assert.equal(corpus.status, 'owned-directory');
    assert.deepEqual(
      (await listActions(root)).map((action) => action.id),
      ['login'],
    );
    assert.equal(loadAction(root, 'login')?.metadata.id, 'login');
    const inventory = nodeCli(
      LEARNED_CLI,
      ['--json', '--section', 'b', '--workspace-root', root, '--memory-cwd', root],
      root,
    );
    assert.equal(inventory.status, 0, inventory.stderr);
    const parsed = JSON.parse(inventory.stdout) as {
      sections: { flows: { count: number; items: Array<{ id: string }> } };
    };
    assert.equal(parsed.sections.flows.count, 1);
    assert.equal(parsed.sections.flows.items[0]?.id, 'login');
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('primary verification is constant and malformed main records never fall back', () => {
  const fixture = makeFixture();
  try {
    seedLoginCorpus(fixture.primary);
    const worktree = addWorktree(fixture);
    inherit(worktree);
    const extra = addWorktree(fixture, 'extra');
    const probe = createGitProbe(fixture);
    const planArgs = ['plan', '--host', 'claude', '--app-root', worktree, '--json'];
    const plan = nodeCli(INHERIT_CLI, planArgs, worktree, {
      env: probe.env,
      timeout: 30_000,
    });
    assert.equal(plan.status, 0, `${plan.stderr}\n${plan.stdout}`);
    const body = JSON.parse(plan.stdout) as {
      kind: string;
      resources: Array<{ state: string }>;
    };
    assert.equal(body.kind, 'linked');
    assert.equal(body.resources[0]?.state, 'LINK_VALID_SAFE');

    const calls = probe.readCalls();
    const listCalls = calls.filter((call) => call.args.join(' ') === 'worktree list --porcelain');
    assert.equal(listCalls.length, 1);
    for (const args of [
      ['rev-parse', '--show-toplevel'],
      ['rev-parse', '--path-format=absolute', '--git-dir'],
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    ]) {
      assert.equal(countGitCalls(calls, fixture.primary, args), 1);
      assert.equal(countGitCalls(calls, worktree, args), 1);
      assert.equal(countGitCalls(calls, extra, args), 0);
    }

    const primaryAlias = join(fixture.root, 'primary-alias');
    symlinkSync(fixture.primary, primaryAlias, 'dir');
    probe.reset();
    const canonical = nodeCli(INHERIT_CLI, planArgs, worktree, {
      env: { ...probe.env, RN_GIT_PROBE_MAIN_PATH: primaryAlias },
      timeout: 30_000,
    });
    assert.equal(canonical.status, 0, `${canonical.stderr}\n${canonical.stdout}`);
    assert.equal(JSON.parse(canonical.stdout).resources[0]?.state, 'LINK_VALID_SAFE');

    const wrongCommon = join(fixture.root, 'wrong-common');
    const wrongTop = join(fixture.root, 'wrong-top');
    const wrongGitDir = join(fixture.root, 'wrong-git-dir');
    mkdirSync(wrongCommon);
    mkdirSync(wrongTop);
    mkdirSync(wrongGitDir);
    for (const scenario of [
      { name: 'empty', empty: true, probesMain: false },
      { name: 'malformed', malformed: true, probesMain: false },
      { name: 'missing', path: join(fixture.root, 'missing-main'), probesMain: false },
      { name: 'bare', marker: 'bare', probesMain: false },
      { name: 'prunable', marker: 'prunable fixture', probesMain: false },
      { name: 'wrong-top-level', top: wrongTop, probesMain: true },
      { name: 'wrong-git-dir', gitDir: wrongGitDir, probesMain: true },
      { name: 'wrong-common-dir', common: wrongCommon, probesMain: true },
    ]) {
      probe.reset();
      const env = { ...probe.env };
      if (scenario.empty) env.RN_GIT_PROBE_EMPTY_LIST = '1';
      if (scenario.malformed) env.RN_GIT_PROBE_MALFORMED_MAIN = '1';
      if (scenario.path) env.RN_GIT_PROBE_MAIN_PATH = scenario.path;
      if (scenario.marker) env.RN_GIT_PROBE_MAIN_MARKER = scenario.marker;
      if (scenario.top) env.RN_GIT_PROBE_PRIMARY_TOP = scenario.top;
      if (scenario.gitDir) env.RN_GIT_PROBE_PRIMARY_GIT_DIR = scenario.gitDir;
      if (scenario.common) env.RN_GIT_PROBE_PRIMARY_COMMON = scenario.common;
      const refused = nodeCli(INHERIT_CLI, planArgs, worktree, {
        env,
        timeout: 30_000,
      });
      assert.equal(refused.status, 3, `${scenario.name}: ${refused.stderr}`);
      const refusal = JSON.parse(refused.stdout) as {
        kind: string;
        refusal: string;
        resources: unknown[];
      };
      assert.equal(refusal.kind, 'refused');
      assert.equal(refusal.refusal, 'NO_PRIMARY');
      assert.deepEqual(refusal.resources, []);
      const refusedCalls = probe.readCalls();
      assert.equal(
        countGitCalls(refusedCalls, fixture.primary, ['rev-parse', '--show-toplevel']),
        scenario.probesMain ? 1 : 0,
      );
      for (const args of [
        ['rev-parse', '--show-toplevel'],
        ['rev-parse', '--path-format=absolute', '--git-dir'],
        ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      ]) {
        assert.equal(countGitCalls(refusedCalls, extra, args), 0);
      }
    }
  } finally {
    fixture.cleanup();
  }
});

test('inventory and replay Git calls are independent of action count', () => {
  const fixture = makeFixture();
  try {
    seedLoginCorpus(fixture.primary);
    const worktree = addWorktree(fixture);
    inherit(worktree);
    const probe = createGitProbe(fixture);
    const inventoryArgs = [
      '--json',
      '--section',
      'b',
      '--workspace-root',
      worktree,
      '--memory-cwd',
      worktree,
      '--max',
      '20',
    ];

    probe.reset();
    const one = nodeCli(LEARNED_CLI, inventoryArgs, worktree, {
      env: probe.env,
      timeout: 30_000,
    });
    assert.equal(one.status, 0, one.stderr);
    const oneCalls = normalizedGitCalls(probe.readCalls());

    for (let index = 1; index < 10; index += 1) {
      const id = `action-${String(index).padStart(2, '0')}`;
      writeFileSync(
        join(fixture.primary, '.rn-agent', 'actions', `${id}.yaml`),
        fixtureYaml({ id }),
      );
    }
    probe.reset();
    const ten = nodeCli(LEARNED_CLI, inventoryArgs, worktree, {
      env: probe.env,
      timeout: 30_000,
    });
    assert.equal(ten.status, 0, ten.stderr);
    const tenCalls = normalizedGitCalls(probe.readCalls());
    assert.deepEqual(tenCalls, oneCalls);

    const replayHelper = join(fixture.root, 'load-action.mjs');
    const helperUrl = pathToFileURL(join(HERE, '..', 'helpers', 'tmp-project.js')).href;
    writeFileSync(
      replayHelper,
      `import { createPinnedRunActionHandler } from ${JSON.stringify(helperUrl)};\nconst handler = createPinnedRunActionHandler({ maestroRun: async () => ({ content: [{ type: 'text', text: JSON.stringify({ ok: true, data: { passed: true, output: 'Flow passed' } }) }] }) });\nconst result = await handler({ actionId: 'login', projectRoot: process.argv[2], autoRepair: false, forceReload: false });\nif (JSON.parse(result.content[0].text).ok !== true) process.exit(2);\n`,
    );
    probe.reset();
    const replay = nodeCli(replayHelper, [worktree], worktree, {
      env: probe.env,
      timeout: 30_000,
    });
    assert.equal(replay.status, 0, replay.stderr);
    assert.deepEqual(normalizedGitCalls(probe.readCalls()), [...oneCalls, ...oneCalls]);

    const corpus = resolveReadableActionCorpus(worktree);
    assert.equal(corpus.status, 'approved-inherited');
    const operation = captureReadableActionOperationSnapshot(corpus);
    assert.ok(operation);
    assert.equal(Object.isFrozen(operation), true);
    assert.equal(Object.isFrozen(operation.directoryIdentity), true);
    assert.equal(Object.isFrozen(operation.linkIdentity), true);
    assert.equal(Object.isFrozen(operation.primaryIdentity), true);
    assert.equal(operation.primaryIdentity?.topLevel.path, fixture.primary);
    assert.equal(
      operation.primaryIdentity?.commonDir.path,
      realpathSync(join(fixture.primary, '.git')),
    );
  } finally {
    fixture.cleanup();
  }
});

test('approved linked corpus shares action IDs and reaches runner preflight', async () => {
  const fixture = makeFixture();
  try {
    seedLoginCorpus(fixture.primary);
    const worktree = addWorktree(fixture);
    inherit(worktree);
    writeFileSync(
      join(fixture.primary, '.rn-agent', 'actions', 'broken.yaml'),
      'not: yaml: with: no: m7: header\n',
    );

    const corpus = resolveReadableActionCorpus(worktree);
    assert.equal(corpus.status, 'approved-inherited');
    assert.equal(
      (await listActions(worktree)).map((action) => action.id).join(','),
      (await listActions(fixture.primary)).map((action) => action.id).join(','),
    );
    assert.equal(loadAction(worktree, 'login')?.metadata.id, 'login');
    assert.equal(loadAction(worktree, 'broken'), null);

    const inventory = nodeCli(
      LEARNED_CLI,
      ['--json', '--section', 'b', '--workspace-root', worktree, '--memory-cwd', worktree],
      worktree,
    );
    assert.equal(inventory.status, 0, inventory.stderr);
    const parsed = JSON.parse(inventory.stdout) as {
      sections: {
        flows: { count: number; items: Array<{ id: string | null; flow: string; replay: string }> };
      };
    };
    const login = parsed.sections.flows.items.find((item) => item.id === 'login');
    assert.ok(login, 'inherited inventory must include login');
    assert.match(login.replay, /cdp_run_action/);
    assert.match(login.replay, new RegExp(worktree.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    let maestroCalls = 0;
    const handler = createRunActionHandler({
      maestroRun: async () => {
        maestroCalls += 1;
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                ok: true,
                data: {
                  passed: true,
                  output: 'Flow passed',
                  flowFile: 'login',
                  platform: 'android',
                },
              }),
            },
          ],
        };
      },
    });
    const result = await handler({
      actionId: 'login',
      projectRoot: worktree,
      autoRepair: false,
      forceReload: false,
      proofReplay: true,
    });
    const env = JSON.parse(result.content[0]!.text) as { ok?: boolean; code?: string };
    assert.notEqual(env.code, 'BAD_FILENAME');
    assert.equal(env.ok, true, result.content[0]!.text);
    assert.equal(maestroCalls, 1);
  } finally {
    fixture.cleanup();
  }
});

test('nested runFlow files are captured in one batch per depth for exact loads', () => {
  const fixture = makeFixture();
  try {
    const actionsDir = join(fixture.primary, '.rn-agent', 'actions');
    const flowsDir = join(actionsDir, 'flows');
    mkdirSync(flowsDir, { recursive: true });
    mkdirSync(join(fixture.primary, '.rn-agent', 'state'), { recursive: true });
    const references = Array.from(
      { length: 10 },
      (_, index) => `- runFlow: flows/child-${index}.yaml`,
    ).join('\n');
    writeFileSync(
      join(actionsDir, 'login.yaml'),
      fixtureYaml({ id: 'login', selectors: [] }).replace('- launchApp', references),
    );
    for (let index = 0; index < 10; index += 1) {
      writeFileSync(join(flowsDir, `child-${index}.yaml`), `- tapOn:\n    id: "child-${index}"\n`);
      writeFileSync(
        join(actionsDir, `unrelated-${index}.yaml`),
        fixtureYaml({ id: `unrelated-${index}` }),
      );
    }
    const worktree = addWorktree(fixture);
    inherit(worktree);
    const batches: string[][] = [];
    const context = openReadableActionLoadContext(worktree, {
      actionId: 'login',
      includeRunFlowFiles: true,
      readFiles: (directory, identity, paths) => {
        batches.push([...paths]);
        return readUnfollowedFiles(directory, identity, paths);
      },
    });
    assert.ok(context);
    const action = loadActionFromContext(context, 'login');
    assert.ok(action?.replay.ok);
    assert.deepEqual(
      batches.map((batch) => batch.length),
      [1, 10],
    );
    assert.equal(
      batches.flat().some((file) => file.startsWith('unrelated-')),
      false,
    );
    for (let index = 0; index < 10; index += 1) {
      assert.match(action.replay.cdpYaml, new RegExp(`child-${index}`));
    }
  } finally {
    fixture.cleanup();
  }
});

test('nested batch reads recheck every previously selected YAML identity', () => {
  const fixture = makeFixture();
  try {
    const actionsDir = join(fixture.primary, '.rn-agent', 'actions');
    mkdirSync(actionsDir, { recursive: true });
    const actionPath = join(actionsDir, 'login.yaml');
    writeFileSync(
      actionPath,
      fixtureYaml({ id: 'login', selectors: [] }).replace('- launchApp', '- runFlow: child.yaml'),
    );
    writeFileSync(join(actionsDir, 'child.yaml'), '- tapOn:\n    id: "child"\n');
    const worktree = addWorktree(fixture, 'accumulated-files');
    inherit(worktree);

    assert.throws(
      () =>
        openReadableActionLoadContext(worktree, {
          actionId: 'login',
          includeRunFlowFiles: true,
          readFiles: (directory, identity, paths) => {
            const contents = readUnfollowedFiles(directory, identity, paths);
            if (paths.includes('child.yaml')) {
              rmSync(actionPath);
              writeFileSync(actionPath, fixtureYaml({ id: 'replacement' }));
            }
            return contents;
          },
        }),
      /Refusing replaced learned-action corpus/,
    );
  } finally {
    fixture.cleanup();
  }
});

test('runFlow prefetch uses the validator native path semantics', () => {
  const fixture = makeFixture();
  try {
    const actionsDir = join(fixture.primary, '.rn-agent', 'actions');
    mkdirSync(actionsDir, { recursive: true });
    const reference = 'sub\\flow.yaml';
    writeFileSync(
      join(actionsDir, 'login.yaml'),
      fixtureYaml({ id: 'login', selectors: [] }).replace('- launchApp', `- runFlow: ${reference}`),
    );
    const childPath = join(actionsDir, reference);
    mkdirSync(dirname(childPath), { recursive: true });
    writeFileSync(childPath, '- tapOn:\n    id: "native-path-child"\n');
    const worktree = addWorktree(fixture, 'native-runflow-path');
    inherit(worktree);

    const action = loadAction(worktree, 'login');
    assert.equal(action?.replay.ok, true);
    assert.match(action?.replay.ok ? action.replay.cdpYaml : '', /native-path-child/);
  } finally {
    fixture.cleanup();
  }
});

test('overwriting an action does not resolve its missing nested flow', () => {
  const fixture = makeFixture();
  try {
    const actionsDir = join(fixture.primary, '.rn-agent', 'actions');
    mkdirSync(actionsDir, { recursive: true });
    writeFileSync(
      join(actionsDir, 'login.yaml'),
      fixtureYaml({ id: 'login', selectors: [] }).replace('- launchApp', '- runFlow: missing.yaml'),
    );
    const replacement = fixtureYaml({ id: 'login', selectors: ['replacement-selector'] });
    const broken = loadAction(fixture.primary, 'login');

    assert.equal(broken?.replay.ok, false);

    const result = writeRecordedActionTransaction(
      fixture.primary,
      'login',
      replacement,
      freshFixtureState(),
      true,
    );

    assert.equal(result.ok, true);
    assert.equal(readFileSync(join(actionsDir, 'login.yaml'), 'utf8'), replacement);
  } finally {
    fixture.cleanup();
  }
});

test('engine lookup corpus mutation returns a structured refusal without replay', async () => {
  const fixture = makeFixture();
  try {
    seedLoginCorpus(fixture.primary);
    const worktree = addWorktree(fixture);
    inherit(worktree);
    const actionsDir = join(fixture.primary, '.rn-agent', 'actions');
    let maestroCalls = 0;
    const handler = createRunActionHandler({
      engineStatus: async () => {
        renameSync(actionsDir, join(fixture.root, 'engine-lookup-actions'));
        mkdirSync(actionsDir);
        return null;
      },
      maestroRun: async () => {
        maestroCalls += 1;
        throw new Error('replay must not start');
      },
    });
    const result = await handler({
      actionId: 'login',
      projectRoot: worktree,
      autoRepair: false,
      forceReload: false,
    });
    const envelope = JSON.parse(result.content[0]!.text) as {
      ok?: boolean;
      code?: string;
      error?: string;
    };
    assert.equal(envelope.ok, false);
    assert.equal(envelope.code, 'BAD_FILENAME', result.content[0]!.text);
    assert.match(envelope.error ?? '', /Refusing replaced learned-action corpus symlink/);
    assert.equal(maestroCalls, 0);
  } finally {
    fixture.cleanup();
  }
});

test('blind-probe corpus mutation refuses before replay dispatch', async () => {
  const fixture = makeFixture();
  try {
    seedLoginCorpus(fixture.primary);
    const worktree = addWorktree(fixture);
    inherit(worktree);
    const actionsDir = join(fixture.primary, '.rn-agent', 'actions');
    let maestroCalls = 0;
    const handler = createRunActionHandler({
      blindProbeContext: async () => {
        renameSync(actionsDir, join(fixture.root, 'blind-probe-actions'));
        mkdirSync(actionsDir);
        return null;
      },
      maestroRun: async () => {
        maestroCalls += 1;
        throw new Error('replay must not start');
      },
    });
    const result = await handler({
      actionId: 'login',
      projectRoot: worktree,
      autoRepair: false,
      forceReload: false,
    });
    const envelope = JSON.parse(result.content[0]!.text) as {
      ok?: boolean;
      code?: string;
      error?: string;
    };
    assert.equal(envelope.ok, false);
    assert.equal(envelope.code, 'BAD_FILENAME', result.content[0]!.text);
    assert.match(envelope.error ?? '', /Refusing replaced learned-action corpus symlink/);
    assert.equal(maestroCalls, 0);
  } finally {
    fixture.cleanup();
  }
});

test('exact-ID replay refuses success after a selected file symlink swap', async () => {
  const fixture = makeFixture();
  try {
    mkdirSync(join(fixture.primary, '.rn-agent', 'actions'), { recursive: true });
    mkdirSync(join(fixture.primary, '.rn-agent', 'state'), { recursive: true });
    const capturedYaml = fixtureYaml({ id: 'login', selectors: ['captured-selector'] });
    const actionPath = join(fixture.primary, '.rn-agent', 'actions', 'login.yaml');
    writeFileSync(actionPath, capturedYaml);
    const worktree = addWorktree(fixture);
    inherit(worktree);
    const swappedPath = join(fixture.root, 'swapped-login.yaml');
    writeFileSync(swappedPath, fixtureYaml({ id: 'login', selectors: ['swapped-selector'] }));

    const handler = createRunActionHandler({
      maestroRun: async (args) => {
        rmSync(actionPath);
        symlinkSync(swappedPath, actionPath);
        assert.equal(args.flowPath, undefined);
        const replayYaml = args.inlineYaml ?? readFileSync(args.flowPath!, 'utf8');
        const passed =
          replayYaml.includes('captured-selector') && !replayYaml.includes('swapped-selector');
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                ok: passed,
                data: { passed, output: passed ? 'Flow passed' : 'Wrong flow executed' },
              }),
            },
          ],
        };
      },
    });
    const result = await handler({
      actionId: 'login',
      projectRoot: worktree,
      autoRepair: false,
      forceReload: false,
      proofReplay: true,
    });
    const env = JSON.parse(result.content[0]!.text) as { ok?: boolean; error?: string };
    assert.equal(env.ok, false);
    assert.match(env.error ?? '', /Refusing replaced learned-action corpus/);
    assert.throws(() => loadAction(worktree, 'login'), /symlink|replaced learned-action corpus/);
  } finally {
    fixture.cleanup();
  }
});

test('ordinary replay refuses success after its corpus changes during dispatch', async () => {
  const fixture = makeFixture();
  try {
    seedLoginCorpus(fixture.primary);
    const worktree = addWorktree(fixture, 'post-dispatch-corpus');
    inherit(worktree);
    const actionsDir = join(fixture.primary, '.rn-agent', 'actions');

    const handler = createRunActionHandler({
      maestroRun: async () => {
        renameSync(actionsDir, join(fixture.root, 'original-post-dispatch-actions'));
        mkdirSync(actionsDir);
        writeFileSync(join(actionsDir, 'login.yaml'), fixtureYaml({ id: 'login' }));
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ ok: true, data: { passed: true, output: 'Flow passed' } }),
            },
          ],
        };
      },
    });
    const result = await handler({
      actionId: 'login',
      projectRoot: worktree,
      autoRepair: false,
      forceReload: false,
    });
    const envelope = JSON.parse(result.content[0]!.text) as { ok?: boolean; error?: string };

    assert.equal(envelope.ok, false);
    assert.match(envelope.error ?? '', /Refusing replaced learned-action corpus/);
  } finally {
    fixture.cleanup();
  }
});

test('replay expands a safely captured subflow before mutable paths can change', async () => {
  const fixture = makeFixture();
  try {
    mkdirSync(join(fixture.primary, '.rn-agent', 'actions'), { recursive: true });
    mkdirSync(join(fixture.primary, '.rn-agent', 'state'), { recursive: true });
    const actionPath = join(fixture.primary, '.rn-agent', 'actions', 'login.yaml');
    const childPath = join(fixture.primary, '.rn-agent', 'actions', 'child.yaml');
    writeFileSync(
      actionPath,
      fixtureYaml({ id: 'login', selectors: [] }).replace(
        '- launchApp\n',
        '- runFlow: child.yaml\n',
      ),
    );
    writeFileSync(childPath, '- tapOn:\n    id: "captured-child"\n');
    const worktree = addWorktree(fixture);
    inherit(worktree);

    const handler = createRunActionHandler({
      maestroRun: async (args) => {
        writeFileSync(childPath, '- tapOn:\n    id: "swapped-child"\n');
        assert.equal(args.flowPath, undefined);
        const replayYaml = args.inlineYaml ?? '';
        const passed =
          replayYaml.includes('captured-child') && !replayYaml.includes('swapped-child');
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ ok: passed, data: { passed, output: 'Flow result' } }),
            },
          ],
        };
      },
    });
    const result = await handler({
      actionId: 'login',
      projectRoot: worktree,
      autoRepair: false,
      forceReload: false,
      proofReplay: true,
    });
    assert.equal((JSON.parse(result.content[0]!.text) as { ok?: boolean }).ok, true);
  } finally {
    fixture.cleanup();
  }
});

test('verified directory operations refuse a replaced inherited target', () => {
  const fixture = makeFixture();
  try {
    seedLoginCorpus(fixture.primary);
    const worktree = addWorktree(fixture);
    inherit(worktree);
    const corpus = resolveReadableActionCorpus(worktree);
    assert.equal(corpus.status, 'approved-inherited');
    const snapshot = readableActionsSnapshot(corpus);
    assert.ok(snapshot);
    assert.match(
      readUnfollowedFile(snapshot.directory, snapshot.identity, 'login.yaml'),
      /# id: login/,
    );

    const original = join(fixture.root, 'original-actions');
    renameSync(snapshot.directory, original);
    mkdirSync(snapshot.directory);
    writeFileSync(
      join(snapshot.directory, 'login.yaml'),
      fixtureYaml({ id: 'login', intent: 'foreign' }),
    );
    assert.throws(
      () => readUnfollowedFile(snapshot.directory, snapshot.identity, 'login.yaml'),
      /Refusing inherited action symlink/,
    );
    assert.throws(
      () => listUnfollowedDirectory(snapshot.directory, snapshot.identity),
      /Refusing replaced learned-action corpus/,
    );
  } finally {
    fixture.cleanup();
  }
});

test('verified directory batch returns readable files and refuses a symlink entry', () => {
  const fixture = makeFixture();
  try {
    seedLoginCorpus(fixture.primary);
    const actionsDir = join(fixture.primary, '.rn-agent', 'actions');
    writeFileSync(join(actionsDir, 'other.yaml'), fixtureYaml({ id: 'other' }));
    const leaked = join(fixture.root, 'leaked.yaml');
    writeFileSync(leaked, fixtureYaml({ id: 'leaked' }));
    symlinkSync(leaked, join(actionsDir, 'linked.yaml'));
    const worktree = addWorktree(fixture);
    inherit(worktree);
    const corpus = resolveReadableActionCorpus(worktree);
    assert.equal(corpus.status, 'approved-inherited');
    const snapshot = readableActionsSnapshot(corpus);
    assert.ok(snapshot);
    const entries = readUnfollowedFiles(snapshot.directory, snapshot.identity, [
      'login.yaml',
      'other.yaml',
      'linked.yaml',
    ]);
    assert.match(entries[0]!, /# id: login/);
    assert.match(entries[1]!, /# id: other/);
    assert.equal(entries[2], null);
  } finally {
    fixture.cleanup();
  }
});

test('verified directory reads chunk a corpus larger than the helper output limit', () => {
  const fixture = makeFixture();
  try {
    const actionsDir = join(fixture.primary, '.rn-agent', 'actions');
    mkdirSync(actionsDir, { recursive: true });
    const fileNames = Array.from({ length: 33 }, (_, index) => `large-${index}.yaml`);
    const contents = `${'x'.repeat(1024 * 1024 - 1)}\n`;
    for (const fileName of fileNames) writeFileSync(join(actionsDir, fileName), contents);
    const worktree = addWorktree(fixture);
    inherit(worktree);
    const corpus = resolveReadableActionCorpus(worktree);
    assert.equal(corpus.status, 'approved-inherited');
    const snapshot = readableActionsSnapshot(corpus);
    assert.ok(snapshot);
    const entries = readUnfollowedFiles(snapshot.directory, snapshot.identity, fileNames);
    assert.equal(entries.length, fileNames.length);
    assert.equal(
      entries.every((entry) => entry === contents),
      true,
    );
  } finally {
    fixture.cleanup();
  }
});

test('inventory refuses per-file mutation during its batched snapshot read', () => {
  for (const scenario of ['delete', 'replace', 'symlink'] as const) {
    const fixture = makeFixture();
    try {
      seedLoginCorpus(fixture.primary);
      const worktree = addWorktree(fixture, `file-${scenario}`);
      inherit(worktree);
      const actionPath = join(fixture.primary, '.rn-agent', 'actions', 'login.yaml');
      const replacement = join(fixture.root, 'replacement.yaml');
      writeFileSync(replacement, fixtureYaml({ id: 'replacement' }));

      assert.throws(
        () =>
          openReadableActionLoadContext(worktree, {
            readFiles: (directory, identity, paths) => {
              if (scenario === 'delete') rmSync(actionPath);
              if (scenario === 'replace') {
                rmSync(actionPath);
                writeFileSync(actionPath, fixtureYaml({ id: 'replacement' }));
              }
              if (scenario === 'symlink') {
                rmSync(actionPath);
                symlinkSync(replacement, actionPath);
              }
              return readUnfollowedFiles(directory, identity, paths);
            },
          }),
        /Refusing replaced learned-action corpus/,
        scenario,
      );
    } finally {
      fixture.cleanup();
    }
  }
});

test('inventory stays bound to its original corpus snapshot', async () => {
  const fixture = makeFixture();
  try {
    seedLoginCorpus(fixture.primary);
    const worktree = addWorktree(fixture);
    inherit(worktree);
    const actionsDir = join(fixture.primary, '.rn-agent', 'actions');
    let replaced = false;

    await assert.rejects(
      () =>
        listActions(worktree, {
          loadAction: (context, actionId) => {
            if (!replaced) {
              replaced = true;
              renameSync(actionsDir, join(fixture.root, 'original-inventory-actions'));
              mkdirSync(actionsDir);
              writeFileSync(
                join(actionsDir, 'login.yaml'),
                fixtureYaml({ id: 'login', intent: 'replacement' }),
              );
            }
            return loadActionFromContext(context, actionId);
          },
        }),
      /Refusing replaced learned-action corpus|Refusing inherited action symlink/,
    );
  } finally {
    fixture.cleanup();
  }
});

test('single-action inventory refuses a corpus replaced after its final load', async () => {
  const fixture = makeFixture();
  try {
    seedLoginCorpus(fixture.primary);
    const worktree = addWorktree(fixture);
    inherit(worktree);
    const actionsDir = join(fixture.primary, '.rn-agent', 'actions');

    await assert.rejects(
      () =>
        listActions(worktree, {
          loadAction: (context, actionId) => {
            const action = loadActionFromContext(context, actionId);
            renameSync(actionsDir, join(fixture.root, 'original-final-actions'));
            mkdirSync(actionsDir);
            return action;
          },
        }),
      /Refusing replaced learned-action corpus symlink/,
    );
  } finally {
    fixture.cleanup();
  }
});

test('inventory refuses every inherited corpus identity mutation between file loads', async () => {
  for (const scenario of ['retarget-link', 'replace-link', 'replace-target'] as const) {
    const fixture = makeFixture();
    try {
      seedLoginCorpus(fixture.primary, 'alpha');
      writeFileSync(
        join(fixture.primary, '.rn-agent', 'actions', 'beta.yaml'),
        fixtureYaml({ id: 'beta' }),
      );
      const worktree = addWorktree(fixture, scenario);
      inherit(worktree);
      const link = join(worktree, '.rn-agent', 'actions');
      const target = join(fixture.primary, '.rn-agent', 'actions');
      let loaded = 0;

      await assert.rejects(
        () =>
          listActions(worktree, {
            loadAction: (context, actionId) => {
              const action = loadActionFromContext(context, actionId);
              loaded += 1;
              if (loaded !== 1) return action;
              if (scenario === 'retarget-link') {
                const foreign = join(fixture.root, 'foreign-actions');
                mkdirSync(foreign);
                rmSync(link);
                symlinkSync(foreign, link, 'dir');
              } else if (scenario === 'replace-link') {
                rmSync(link);
                mkdirSync(link);
              } else {
                renameSync(target, join(fixture.root, 'original-actions'));
                mkdirSync(target);
                writeFileSync(join(target, 'beta.yaml'), fixtureYaml({ id: 'beta' }));
              }
              return action;
            },
          }),
        /Refusing replaced learned-action corpus symlink/,
        scenario,
      );
      assert.equal(loaded, 1, `${scenario} must refuse before a second file is accepted`);
    } finally {
      fixture.cleanup();
    }
  }
});

test('operation snapshot refuses a replaced Git common-directory identity', () => {
  const fixture = makeFixture();
  try {
    seedLoginCorpus(fixture.primary);
    const worktree = addWorktree(fixture);
    inherit(worktree);
    const corpus = resolveReadableActionCorpus(worktree);
    assert.equal(corpus.status, 'approved-inherited');
    const operation = captureReadableActionOperationSnapshot(corpus);
    assert.ok(operation);
    const commonDir = realpathSync(join(fixture.primary, '.git'));
    renameSync(commonDir, join(fixture.root, 'original-git-common-dir'));
    mkdirSync(commonDir);
    assert.throws(
      () => assertReadableActionOperationUnchanged(operation),
      /Refusing replaced learned-action corpus symlink/,
    );
  } finally {
    fixture.cleanup();
  }
});

test('operation snapshot refuses a replaced linked project root', () => {
  const fixture = makeFixture();
  try {
    seedLoginCorpus(fixture.primary);
    const worktree = addWorktree(fixture, 'replaced-project-root');
    inherit(worktree);
    const corpus = resolveReadableActionCorpus(worktree);
    assert.equal(corpus.status, 'approved-inherited');
    const operation = captureReadableActionOperationSnapshot(corpus);
    assert.ok(operation);
    const displaced = join(fixture.root, 'original-project-root');
    renameSync(worktree, displaced);
    mkdirSync(join(worktree, '.rn-agent'), { recursive: true });
    renameSync(join(displaced, '.rn-agent', 'actions'), join(worktree, '.rn-agent', 'actions'));

    assert.throws(
      () => assertReadableActionOperationUnchanged(operation),
      /Refusing replaced learned-action corpus symlink/,
    );
  } finally {
    fixture.cleanup();
  }
});

test('operation snapshot refuses a replaced linked Git entry', () => {
  for (const scenario of ['delete', 'replace'] as const) {
    const fixture = makeFixture();
    try {
      seedLoginCorpus(fixture.primary);
      const worktree = addWorktree(fixture, `git-entry-${scenario}`);
      inherit(worktree);
      const corpus = resolveReadableActionCorpus(worktree);
      assert.equal(corpus.status, 'approved-inherited');
      const operation = captureReadableActionOperationSnapshot(corpus);
      assert.ok(operation);
      const gitEntry = join(worktree, '.git');
      const contents = readFileSync(gitEntry, 'utf8');
      rmSync(gitEntry);
      if (scenario === 'replace') writeFileSync(gitEntry, contents);

      assert.throws(
        () => assertReadableActionOperationUnchanged(operation),
        /Refusing replaced learned-action corpus symlink/,
      );
    } finally {
      fixture.cleanup();
    }
  }
});

test('corpus resolution binds the Git common-directory identity it verified', () => {
  const fixture = makeFixture();
  const commonDir = realpathSync(join(fixture.primary, '.git'));
  const displaced = join(fixture.root, 'verified-git-common-dir');
  try {
    seedLoginCorpus(fixture.primary);
    const worktree = addWorktree(fixture);
    inherit(worktree);
    const corpus = resolveReadableActionCorpus(worktree, {
      beforeTargetOpen: () => {
        renameSync(commonDir, displaced);
        mkdirSync(commonDir);
      },
    });
    assert.equal(corpus.status, 'refused');
    if (corpus.status === 'refused') assert.match(corpus.reason, /replaced learned-action corpus/);
  } finally {
    if (existsSync(displaced)) {
      rmSync(commonDir, { recursive: true, force: true });
      renameSync(displaced, commonDir);
    }
    fixture.cleanup();
  }
});

test('read approval requires setup LINK_VALID_SAFE classification', () => {
  for (const scenario of ['tracked', 'git-visible'] as const) {
    const fixture = makeFixture();
    try {
      seedLoginCorpus(fixture.primary);
      if (scenario === 'git-visible') {
        writeFileSync(join(fixture.primary, '.gitignore'), '');
        git(fixture.primary, ['add', '.gitignore']);
        git(fixture.primary, ['commit', '-qm', 'make action link visible']);
      }
      const worktree = addWorktree(fixture, scenario);
      mkdirSync(join(worktree, '.rn-agent'), { recursive: true });
      symlinkSync(
        join(fixture.primary, '.rn-agent', 'actions'),
        join(worktree, '.rn-agent', 'actions'),
        'dir',
      );
      if (scenario === 'tracked') {
        git(worktree, ['add', '-f', '.rn-agent/actions']);
        git(worktree, ['commit', '-qm', 'track action link']);
      }
      const plan = planInheritance({ cwd: worktree, appRoot: worktree, host: 'claude' });
      const expected = scenario === 'tracked' ? 'TRACKED' : 'LINK_VALID_GIT_VISIBLE';
      assert.equal(plan.resources[0]?.state, expected);
      const corpus = resolveReadableActionCorpus(worktree);
      assert.equal(corpus.status, 'refused');
      if (corpus.status === 'refused') assert.match(corpus.reason, new RegExp(expected));
    } finally {
      fixture.cleanup();
    }
  }
});

test('read approval binds the opened target to both setup source snapshots', () => {
  const fixture = makeFixture();
  try {
    seedLoginCorpus(fixture.primary);
    const worktree = addWorktree(fixture);
    inherit(worktree);
    const actionsDir = join(fixture.primary, '.rn-agent', 'actions');
    const approvedDir = join(fixture.root, 'approved-actions');
    const foreignDir = join(fixture.root, 'foreign-actions');
    mkdirSync(foreignDir);
    writeFileSync(join(foreignDir, 'login.yaml'), fixtureYaml({ id: 'login', intent: 'foreign' }));

    const corpus = resolveReadableActionCorpus(worktree, {
      beforeTargetOpen: () => {
        renameSync(actionsDir, approvedDir);
        renameSync(foreignDir, actionsDir);
      },
      afterTargetOpen: () => {
        renameSync(actionsDir, foreignDir);
        renameSync(approvedDir, actionsDir);
      },
    });

    assert.equal(corpus.status, 'refused');
    if (corpus.status === 'refused') assert.match(corpus.reason, /replaced learned-action corpus/);
  } finally {
    fixture.cleanup();
  }
});

test('documented setup plan args classify the same corpus as replay and mutate nothing', () => {
  const fixture = makeFixture();
  try {
    seedLoginCorpus(fixture.primary);
    const worktree = addWorktree(fixture);
    inherit(worktree);
    const beforePrimary = snapshotTree(join(fixture.primary, '.rn-agent'));
    const beforeWorktree = snapshotTree(join(worktree, '.rn-agent'));
    const unrelated = mkdtempSync(join(tmpdir(), 'rn-812-cwd-'));
    const plan = nodeCli(
      INHERIT_CLI,
      ['plan', '--host', 'claude', '--app-root', worktree, '--json'],
      unrelated,
    );
    assert.equal(plan.status, 0, `${plan.stderr}\n${plan.stdout}`);
    const body = JSON.parse(plan.stdout) as {
      kind: string;
      resources: Array<{ state: string; action: string; repair: boolean }>;
    };
    assert.equal(body.kind, 'linked');
    assert.equal(body.resources[0]?.state, 'LINK_VALID_SAFE');
    assert.equal(body.resources[0]?.action, 'none');
    assert.equal(body.resources[0]?.repair, false);
    const corpus = resolveReadableActionCorpus(worktree);
    assert.equal(corpus.status, 'approved-inherited');
    assert.equal(snapshotTree(join(fixture.primary, '.rn-agent')), beforePrimary);
    assert.equal(snapshotTree(join(worktree, '.rn-agent')), beforeWorktree);
  } finally {
    fixture.cleanup();
  }
});

test('follow-all-symlinks would accept a foreign corpus that the allowlist refuses', async () => {
  const fixture = makeFixture();
  try {
    seedLoginCorpus(fixture.primary);
    const worktree = addWorktree(fixture);
    inherit(worktree);
    const foreign = join(fixture.root, 'foreign-actions');
    mkdirSync(foreign, { recursive: true });
    writeFileSync(join(foreign, 'login.yaml'), fixtureYaml({ id: 'login', intent: 'foreign' }));
    rmSync(join(worktree, '.rn-agent', 'actions'), { force: true });
    symlinkSync(foreign, join(worktree, '.rn-agent', 'actions'), 'dir');

    assert.equal(statSync(join(worktree, '.rn-agent', 'actions')).isDirectory(), true);
    const corpus = resolveReadableActionCorpus(worktree);
    assert.equal(corpus.status, 'refused');
    assert.match(corpus.reason, /LINK_FOREIGN/);
    await assert.rejects(() => listActions(worktree), /LINK_FOREIGN/);
    assert.equal(sameReadableActionCorpus(corpus, resolveReadableActionCorpus(worktree)), true);
    const inventory = nodeCli(
      LEARNED_CLI,
      ['--json', '--section', 'b', '--workspace-root', worktree, '--memory-cwd', worktree],
      worktree,
    );
    assert.equal(inventory.status, 1);
    assert.equal(inventory.stdout, '');
    assert.match(inventory.stderr, /LINK_FOREIGN/);
  } finally {
    fixture.cleanup();
  }
});

test('dangling, whole-directory, and replaced links are refused', async () => {
  const fixture = makeFixture();
  try {
    seedLoginCorpus(fixture.primary);
    const worktree = addWorktree(fixture);
    inherit(worktree);

    rmSync(join(fixture.primary, '.rn-agent', 'actions'), { recursive: true });
    const dangling = resolveReadableActionCorpus(worktree);
    assert.equal(dangling.status, 'refused');
    assert.match(dangling.reason, /dangling learned-action corpus symlink/);

    mkdirSync(join(fixture.primary, '.rn-agent', 'actions'), { recursive: true });
    writeFileSync(
      join(fixture.primary, '.rn-agent', 'actions', 'login.yaml'),
      fixtureYaml({ id: 'login' }),
    );
    const whole = join(fixture.root, 'whole-root');
    git(fixture.primary, ['worktree', 'add', '-q', whole, '-b', 'whole-root']);
    rmSync(join(whole, '.rn-agent'), { recursive: true, force: true });
    symlinkSync(join(fixture.primary, '.rn-agent'), join(whole, '.rn-agent'), 'dir');
    const wholeCorpus = resolveReadableActionCorpus(whole);
    assert.equal(wholeCorpus.status, 'refused');
    assert.match(wholeCorpus.reason, /learned-action corpus symlink at .*\/\.rn-agent/);

    const linked = addWorktree(fixture, 'replaced');
    inherit(linked);
    const approved = resolveReadableActionCorpus(linked);
    assert.equal(approved.status, 'approved-inherited');
    rmSync(join(linked, '.rn-agent', 'actions'));
    const foreign = join(fixture.root, 'swapped');
    mkdirSync(foreign);
    writeFileSync(join(foreign, 'login.yaml'), fixtureYaml({ id: 'login' }));
    symlinkSync(foreign, join(linked, '.rn-agent', 'actions'), 'dir');
    const replaced = resolveReadableActionCorpus(linked);
    assert.equal(replaced.status, 'refused');
    assert.equal(sameReadableActionCorpus(approved, replaced), false);
    assert.throws(() => loadAction(linked, 'login'), /foreign|replaced/);
  } finally {
    fixture.cleanup();
  }
});

test('built inventory refuses a file symlink without partial results', () => {
  const fixture = makeFixture();
  try {
    seedLoginCorpus(fixture.primary);
    writeFileSync(
      join(fixture.primary, '.rn-agent', 'actions', 'other.yaml'),
      fixtureYaml({ id: 'other' }),
    );
    const worktree = addWorktree(fixture);
    inherit(worktree);
    const leaked = join(fixture.root, 'leaked.yaml');
    writeFileSync(leaked, fixtureYaml({ id: 'leaked', intent: 'should-not-inventory' }));
    const loginPath = join(fixture.primary, '.rn-agent', 'actions', 'login.yaml');
    rmSync(loginPath);
    symlinkSync(leaked, loginPath);
    assert.throws(
      () => loadAction(worktree, 'login'),
      /symlink|inherited action|replaced learned-action corpus/,
    );
    const inventory = nodeCli(
      LEARNED_CLI,
      ['--json', '--section', 'b', '--workspace-root', worktree, '--memory-cwd', worktree],
      worktree,
    );
    assert.equal(inventory.status, 1);
    assert.equal(inventory.stdout, '');
    assert.match(inventory.stderr, /Refusing replaced learned-action corpus/);
  } finally {
    fixture.cleanup();
  }
});
