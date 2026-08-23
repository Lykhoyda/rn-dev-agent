import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
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
import { loadAction, loadActionFromContext } from '../../dist/domain/action-store.js';
import { listUnfollowedDirectory, readUnfollowedFile } from '../../dist/domain/unfollowed-file.js';
import {
  createPinnedRunActionHandler as createRunActionHandler,
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
    const actionStoreUrl = pathToFileURL(join(CORE_ROOT, 'dist', 'domain', 'action-store.js')).href;
    writeFileSync(
      replayHelper,
      `import { loadAction } from ${JSON.stringify(actionStoreUrl)};\nconst action = loadAction(process.argv[2], 'login');\nif (action?.metadata.id !== 'login') process.exit(2);\n`,
    );
    probe.reset();
    const replay = nodeCli(replayHelper, [worktree], worktree, {
      env: probe.env,
      timeout: 30_000,
    });
    assert.equal(replay.status, 0, replay.stderr);
    assert.deepEqual(normalizedGitCalls(probe.readCalls()), oneCalls);

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

test('exact-ID replay executes the safely loaded YAML after a file symlink swap', async () => {
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
    const env = JSON.parse(result.content[0]!.text) as { ok?: boolean };
    assert.equal(env.ok, true);
    assert.throws(() => loadAction(worktree, 'login'), /symlink/);
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
    assert.equal(inventory.status, 3);
    assert.equal(JSON.parse(inventory.stdout).sections.flows.count, 0);
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

test('discovery skips a file swapped for a symlink under an approved corpus', () => {
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
    assert.throws(() => loadAction(worktree, 'login'), /symlink|inherited action/);
    const inventory = nodeCli(
      LEARNED_CLI,
      ['--json', '--section', 'b', '--workspace-root', worktree, '--memory-cwd', worktree],
      worktree,
    );
    assert.equal(inventory.status, 0, inventory.stderr);
    const ids = (
      JSON.parse(inventory.stdout) as { sections: { flows: { items: Array<{ id: string }> } } }
    ).sections.flows.items.map((item) => item.id);
    assert.deepEqual(ids, ['other']);
  } finally {
    fixture.cleanup();
  }
});
