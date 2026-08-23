import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
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
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import {
  applyInheritance,
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

function nodeCli(entry: string, args: string[], cwd: string) {
  const result = spawnSync(process.execPath, [entry, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 60_000,
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

function seedLoginCorpus(primary: string): void {
  mkdirSync(join(primary, '.rn-agent', 'actions'), { recursive: true });
  mkdirSync(join(primary, '.rn-agent', 'state'), { recursive: true });
  writeFileSync(join(primary, '.rn-agent', 'actions', 'login.yaml'), fixtureYaml({ id: 'login' }));
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
