import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  applyInheritance,
  parseWorktreeRecords,
  planInheritance,
  resourcesForHost,
} from '../../../dist/session/worktree-inheritance.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CORE_ROOT = join(HERE, '..', '..', '..');
const CLI = join(CORE_ROOT, 'dist', 'worktree-inheritance.js');
const PACKAGED_CLI = join(
  CORE_ROOT,
  '..',
  'claude-plugin',
  'rn-dev-agent-core',
  'dist',
  'worktree-inheritance.js',
);

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return (result.stdout ?? '').trim();
}

function cli(cwd: string, args: string[], entry = CLI, env: NodeJS.ProcessEnv = process.env) {
  const result = spawnSync(process.execPath, [entry, ...args], {
    cwd,
    encoding: 'utf8',
    env,
    timeout: 60_000,
  });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

interface Fixture {
  root: string;
  primary: string;
  appRelative: string;
  cleanup: () => void;
}

function makeFixture(
  options: { prefix?: string; appRelative?: string; ignore?: string } = {},
): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), options.prefix ?? 'rn-wt-')));
  const primary = join(root, 'primary');
  const appRelative = options.appRelative ?? '.';
  const app = appRelative === '.' ? primary : join(primary, appRelative);
  mkdirSync(app, { recursive: true });
  git(root, ['init', '-q', primary]);
  git(primary, ['config', 'user.email', 'fixture@example.test']);
  git(primary, ['config', 'user.name', 'fixture']);
  git(primary, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(
    join(app, 'package.json'),
    JSON.stringify({ name: 'app', dependencies: { 'react-native': '0.76.0' } }),
  );
  writeFileSync(
    join(primary, '.gitignore'),
    options.ignore ?? `${appRelative === '.' ? '' : `${appRelative}/`}.rn-agent/\n`,
  );
  git(primary, ['add', '-A']);
  git(primary, ['commit', '-qm', 'init']);
  return {
    root,
    primary,
    appRelative,
    cleanup: () => rmSync(root, { force: true, recursive: true }),
  };
}

function appPath(root: string, appRelative: string): string {
  return appRelative === '.' ? root : join(root, appRelative);
}

function seedPrivateCorpus(fixture: Fixture): string {
  const app = appPath(fixture.primary, fixture.appRelative);
  mkdirSync(join(app, '.rn-agent', 'actions'), { recursive: true });
  mkdirSync(join(app, '.rn-agent', 'integration'), { recursive: true });
  mkdirSync(join(app, '.rn-agent', 'state'), { recursive: true });
  mkdirSync(join(app, '.rn-agent', 'recordings'), { recursive: true });
  writeFileSync(join(app, '.rn-agent', 'actions', 'login.yaml'), 'appId: fixture\n');
  writeFileSync(join(app, '.rn-agent', 'integration', 'authority.json'), 'FOREIGN-AUTHORITY');
  writeFileSync(join(app, '.rn-agent', 'state', 'session.json'), 'FOREIGN-STATE');
  writeFileSync(join(app, '.rn-agent', 'recordings', 'capture.json'), 'FOREIGN-RECORDING');
  return app;
}

function addWorktree(fixture: Fixture, name = 'linked'): string {
  const worktree = join(fixture.root, name);
  git(fixture.primary, [
    'worktree',
    'add',
    '-q',
    worktree,
    '-b',
    name.replace(/[^a-z0-9-]/gi, '-'),
  ]);
  return worktree;
}

function assertSplitLayout(worktreeApp: string, primaryApp: string): void {
  assert.equal(lstatSync(join(worktreeApp, '.rn-agent')).isDirectory(), true);
  assert.equal(lstatSync(join(worktreeApp, '.rn-agent')).isSymbolicLink(), false);
  assert.equal(lstatSync(join(worktreeApp, '.rn-agent', 'actions')).isSymbolicLink(), true);
  assert.equal(
    realpathSync(join(worktreeApp, '.rn-agent', 'actions')),
    realpathSync(join(primaryApp, '.rn-agent', 'actions')),
  );
}

test('parses worktree porcelain paths with spaces', () => {
  const records = parseWorktreeRecords(
    'worktree /repos/with space/main\nHEAD abc\nbranch refs/heads/main\n\nworktree /gone\nprunable reason\n',
  );
  assert.equal(records[0].path, '/repos/with space/main');
  assert.equal(records[1].prunable, true);
});

test('only the stable actions resource is shareable for either host', () => {
  assert.deepEqual(
    resourcesForHost('claude').map((resource) => resource.path),
    ['.rn-agent/actions'],
  );
  assert.deepEqual(
    resourcesForHost('codex').map((resource) => resource.path),
    ['.rn-agent/actions'],
  );
});

test('setup creates a real local root and inherits actions without foreign-root writes', () => {
  const fixture = makeFixture();
  try {
    const primaryApp = seedPrivateCorpus(fixture);
    const foreignStateBefore = readFileSync(
      join(primaryApp, '.rn-agent', 'state', 'session.json'),
      'utf8',
    );
    const worktree = addWorktree(fixture);

    const plan = planInheritance({ cwd: worktree, appRoot: worktree, host: 'claude' });
    assert.deepEqual(
      plan.resources.map((resource) => resource.state),
      ['DEST_MISSING'],
    );
    const report = applyInheritance({ cwd: worktree, appRoot: worktree, host: 'claude' });
    assert.equal(report.applied, 1);
    assertSplitLayout(worktree, primaryApp);
    for (const mutable of ['integration', 'state', 'recordings']) {
      assert.equal(existsSync(join(worktree, '.rn-agent', mutable)), false);
    }
    assert.equal(
      readFileSync(join(primaryApp, '.rn-agent', 'state', 'session.json'), 'utf8'),
      foreignStateBefore,
    );
    assert.equal(git(worktree, ['status', '--porcelain']), '');
  } finally {
    fixture.cleanup();
  }
});

test('legacy whole-root link migrates to actions-only without copying mutable authority', () => {
  const fixture = makeFixture();
  try {
    const primaryApp = seedPrivateCorpus(fixture);
    const worktree = addWorktree(fixture);
    symlinkSync(join(primaryApp, '.rn-agent'), join(worktree, '.rn-agent'), 'dir');

    const plan = planInheritance({ cwd: worktree, appRoot: worktree, host: 'claude' });
    assert.equal(plan.resources[0].state, 'LEGACY_ROOT_LINK');
    assert.equal(plan.resources[0].action, 'migrate');
    const withoutConsent = applyInheritance({ cwd: worktree, appRoot: worktree, host: 'claude' });
    assert.equal(withoutConsent.outcomes[0].result, 'skipped');
    assert.equal(lstatSync(join(worktree, '.rn-agent')).isSymbolicLink(), true);

    const migrated = applyInheritance({
      cwd: worktree,
      appRoot: worktree,
      host: 'claude',
      allowRepair: true,
    });
    assert.equal(migrated.outcomes[0].result, 'repaired');
    assertSplitLayout(worktree, primaryApp);
    for (const mutable of ['integration', 'state', 'recordings']) {
      assert.equal(existsSync(join(worktree, '.rn-agent', mutable)), false);
    }
    assert.equal(
      readFileSync(join(primaryApp, '.rn-agent', 'integration', 'authority.json'), 'utf8'),
      'FOREIGN-AUTHORITY',
    );
  } finally {
    fixture.cleanup();
  }
});

test('legacy migration rolls back when the split actions link would be Git-visible', () => {
  const fixture = makeFixture({ ignore: '' });
  try {
    const primaryApp = seedPrivateCorpus(fixture);
    const worktree = addWorktree(fixture);
    symlinkSync(join(primaryApp, '.rn-agent'), join(worktree, '.rn-agent'), 'dir');

    const report = applyInheritance({
      cwd: worktree,
      appRoot: worktree,
      host: 'claude',
      allowRepair: true,
    });
    assert.equal(report.outcomes[0].state, 'LINK_VALID_GIT_VISIBLE');
    assert.equal(report.outcomes[0].result, 'refused');
    assert.equal(lstatSync(join(worktree, '.rn-agent')).isSymbolicLink(), true);
    assert.equal(
      readFileSync(join(primaryApp, '.rn-agent', 'state', 'session.json'), 'utf8'),
      'FOREIGN-STATE',
    );
  } finally {
    fixture.cleanup();
  }
});

test('foreign root links are refused and never written through, including blocked-startup ordering', () => {
  const fixture = makeFixture();
  try {
    seedPrivateCorpus(fixture);
    const worktree = addWorktree(fixture);
    const foreign = join(fixture.root, 'foreign');
    mkdirSync(foreign);
    writeFileSync(join(foreign, 'sentinel'), 'UNCHANGED');
    symlinkSync(foreign, join(worktree, '.rn-agent'), 'dir');

    const report = applyInheritance({
      cwd: worktree,
      appRoot: worktree,
      host: 'claude',
      allowRepair: true,
    });
    assert.equal(report.outcomes[0].state, 'LINK_FOREIGN');
    assert.equal(report.outcomes[0].result, 'skipped');
    assert.equal(readFileSync(join(foreign, 'sentinel'), 'utf8'), 'UNCHANGED');
    assert.equal(lstatSync(join(worktree, '.rn-agent')).isSymbolicLink(), true);
  } finally {
    fixture.cleanup();
  }
});

test('foreign canonical actions links are refused without creating a write path', () => {
  const fixture = makeFixture();
  try {
    const primaryApp = appPath(fixture.primary, fixture.appRelative);
    const foreign = join(fixture.root, 'foreign-actions');
    mkdirSync(foreign);
    writeFileSync(join(foreign, 'sentinel'), 'UNCHANGED');
    mkdirSync(join(primaryApp, '.rn-agent'));
    symlinkSync(foreign, join(primaryApp, '.rn-agent', 'actions'), 'dir');
    const worktree = addWorktree(fixture);

    const plan = planInheritance({ cwd: worktree, appRoot: worktree, host: 'claude' });
    assert.equal(plan.resources[0].sourceState, 'WRONG_TYPE');
    assert.equal(plan.resources[0].state, 'SOURCE_WRONG_TYPE');

    const report = applyInheritance({ cwd: worktree, appRoot: worktree, host: 'claude' });
    assert.equal(report.applied, 0);
    assert.equal(existsSync(join(worktree, '.rn-agent', 'actions')), false);
    assert.equal(readFileSync(join(foreign, 'sentinel'), 'utf8'), 'UNCHANGED');
  } finally {
    fixture.cleanup();
  }
});

test('foreign canonical action ancestors and existing links are refused', () => {
  const fixture = makeFixture();
  try {
    const primaryApp = appPath(fixture.primary, fixture.appRelative);
    const foreign = join(fixture.root, 'foreign-root');
    mkdirSync(join(foreign, 'actions'), { recursive: true });
    writeFileSync(join(foreign, 'actions', 'sentinel'), 'UNCHANGED');
    symlinkSync(foreign, join(primaryApp, '.rn-agent'), 'dir');
    const worktree = addWorktree(fixture);

    const missingPlan = planInheritance({ cwd: worktree, appRoot: worktree, host: 'claude' });
    assert.equal(missingPlan.resources[0].sourceState, 'WRONG_TYPE');
    assert.equal(missingPlan.resources[0].state, 'SOURCE_WRONG_TYPE');

    mkdirSync(join(worktree, '.rn-agent'));
    symlinkSync(
      join(primaryApp, '.rn-agent', 'actions'),
      join(worktree, '.rn-agent', 'actions'),
      'dir',
    );
    const linkedPlan = planInheritance({ cwd: worktree, appRoot: worktree, host: 'claude' });
    assert.notEqual(linkedPlan.resources[0].state, 'LINK_VALID_SAFE');
    assert.equal(
      applyInheritance({ cwd: worktree, appRoot: worktree, host: 'claude' }).outcomes[0].result,
      'skipped',
    );
    assert.equal(readFileSync(join(foreign, 'actions', 'sentinel'), 'utf8'), 'UNCHANGED');
  } finally {
    fixture.cleanup();
  }
});

test('source identity swaps between plan and apply are refused', () => {
  const fixture = makeFixture();
  try {
    const primaryApp = seedPrivateCorpus(fixture);
    const worktree = addWorktree(fixture);
    const wrapperDirectory = join(fixture.root, 'bin');
    const wrapper = join(wrapperDirectory, 'git');
    const marker = join(fixture.root, 'source-swapped');
    const source = join(primaryApp, '.rn-agent', 'actions');
    const realGit = spawnSync('/bin/sh', ['-c', 'command -v git'], {
      encoding: 'utf8',
    }).stdout.trim();
    mkdirSync(wrapperDirectory);
    writeFileSync(
      wrapper,
      '#!/bin/sh\nif [ "$1" = "check-ignore" ] && [ ! -e "$RN_SWAP_MARKER" ]; then\n  "$RN_REAL_GIT" "$@"\n  result=$?\n  mv "$RN_SWAP_SOURCE" "$RN_SWAP_SOURCE.before"\n  mkdir "$RN_SWAP_SOURCE"\n  : > "$RN_SWAP_MARKER"\n  exit "$result"\nfi\nexec "$RN_REAL_GIT" "$@"\n',
    );
    chmodSync(wrapper, 0o700);

    const result = cli(
      worktree,
      ['apply', '--host', 'claude', '--app-root', worktree, '--json'],
      CLI,
      {
        ...process.env,
        PATH: `${wrapperDirectory}:${process.env.PATH ?? ''}`,
        RN_REAL_GIT: realGit,
        RN_SWAP_MARKER: marker,
        RN_SWAP_SOURCE: source,
      },
    );
    const report = JSON.parse(result.stdout) as { outcomes: Array<{ result: string }> };
    assert.equal(result.status, 3);
    assert.equal(report.outcomes[0].result, 'refused');
    assert.equal(existsSync(join(worktree, '.rn-agent', 'actions')), false);
  } finally {
    fixture.cleanup();
  }
});

test('tracked actions remain Git-owned and private unignored actions remain visible/refused', () => {
  const tracked = makeFixture({ ignore: '' });
  try {
    const primaryApp = appPath(tracked.primary, tracked.appRelative);
    mkdirSync(join(primaryApp, '.rn-agent', 'actions'), { recursive: true });
    writeFileSync(join(primaryApp, '.rn-agent', 'actions', 'team.yaml'), 'appId: team\n');
    git(tracked.primary, ['add', '.rn-agent/actions/team.yaml']);
    git(tracked.primary, ['commit', '-qm', 'tracked actions']);
    const worktree = addWorktree(tracked);
    const plan = planInheritance({ cwd: worktree, appRoot: worktree, host: 'codex' });
    assert.equal(plan.resources[0].state, 'TRACKED');
    assert.equal(lstatSync(join(worktree, '.rn-agent', 'actions')).isDirectory(), true);
  } finally {
    tracked.cleanup();
  }

  const privateFixture = makeFixture({ ignore: '' });
  try {
    seedPrivateCorpus(privateFixture);
    const worktree = addWorktree(privateFixture);
    const plan = planInheritance({ cwd: worktree, appRoot: worktree, host: 'claude' });
    assert.equal(plan.resources[0].state, 'IGNORE_UNSAFE');
    assert.match(plan.resources[0].remediation ?? '', /file-form rule/);
    assert.equal(applyInheritance({ cwd: worktree, appRoot: worktree, host: 'claude' }).applied, 0);
  } finally {
    privateFixture.cleanup();
  }
});

test('paths with spaces and nested monorepo app roots inherit correctly', () => {
  const fixture = makeFixture({
    prefix: 'rn worktrees with spaces-',
    appRelative: 'apps/mobile app',
  });
  try {
    const primaryApp = seedPrivateCorpus(fixture);
    const worktree = addWorktree(fixture, 'linked worktree');
    const worktreeApp = appPath(worktree, fixture.appRelative);
    const result = cli(worktree, ['apply', '--host', 'codex', '--app-root', worktreeApp]);
    assert.equal(result.status, 0, result.stderr);
    assertSplitLayout(worktreeApp, primaryApp);
    assert.equal(existsSync(join(worktree, '.rn-agent')), false);
  } finally {
    fixture.cleanup();
  }
});

test('post-checkout hook prepares fresh worktrees before SessionStart and keeps Git clean', () => {
  const fixture = makeFixture();
  try {
    const primaryApp = seedPrivateCorpus(fixture);
    const install = cli(fixture.primary, ['hook', 'install', '--host', 'claude'], PACKAGED_CLI);
    assert.equal(install.status, 0, install.stderr);
    const worktree = addWorktree(fixture, 'hook-created');
    assertSplitLayout(worktree, primaryApp);
    assert.equal(git(worktree, ['status', '--porcelain']), '');

    const hookBody = readFileSync(join(fixture.primary, '.git', 'hooks', 'post-checkout'), 'utf8');
    assert.match(hookBody, /post-checkout/);
    assert.doesNotMatch(hookBody, /ln -s|cp -R|\.rn-agent\/integration/);
  } finally {
    fixture.cleanup();
  }
});

test('SessionStart hook is report-only and cannot create a whole-root link', () => {
  const hook = readFileSync(
    join(CORE_ROOT, '..', 'claude-plugin', 'hooks', 'detect-rn-project.sh'),
    'utf8',
  );
  const inheritanceBlock = hook.slice(
    hook.indexOf('# REPORT ONLY:'),
    hook.indexOf('# Scaffold the repo-local'),
  );
  assert.match(inheritanceBlock, /worktree-inheritance\.js" report/);
  assert.doesNotMatch(inheritanceBlock, /\bln\b|\bcp\b|\bmv\b|\brm\b/);
});

test('CLI reports no private source paths or action bodies', () => {
  const fixture = makeFixture();
  try {
    const primaryApp = seedPrivateCorpus(fixture);
    writeFileSync(join(primaryApp, '.rn-agent', 'actions', 'secret.yaml'), 'PRIVATE-BODY-MARKER');
    const worktree = addWorktree(fixture);
    const result = cli(worktree, ['plan', '--host', 'claude', '--app-root', worktree, '--json']);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(
      result.stdout,
      new RegExp(fixture.root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    );
    assert.doesNotMatch(result.stdout, /PRIVATE-BODY-MARKER/);
    assert.match(result.stdout, /\.rn-agent\/actions/);
  } finally {
    fixture.cleanup();
  }
});
