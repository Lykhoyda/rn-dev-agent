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
  detectLegacyRootRepair,
  parseWorktreeRecords,
  planInheritance,
  repairLegacyRoot,
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

function seedLegacyDamage(worktree: string, primaryApp: string): void {
  const backup = join(worktree, '.rn-agent.bak');
  mkdirSync(join(backup, 'integration'), { recursive: true });
  mkdirSync(join(backup, 'local'), { recursive: true });
  mkdirSync(join(backup, 'actions'), { recursive: true });
  writeFileSync(join(backup, 'integration', 'launcher.cjs'), 'KEEP-INTEGRATION');
  writeFileSync(join(backup, 'local', 'troubleshooting.md'), 'KEEP-LOCAL');
  writeFileSync(join(backup, 'actions', 'local.yaml'), 'KEEP-LOCAL-ACTION');
  symlinkSync(join(primaryApp, '.rn-agent'), join(worktree, '.rn-agent'), 'dir');
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

test('non-linked projects keep their real integration and local state unchanged', () => {
  const fixture = makeFixture();
  try {
    const primaryApp = seedPrivateCorpus(fixture);
    mkdirSync(join(primaryApp, '.rn-agent', 'local'));
    writeFileSync(join(primaryApp, '.rn-agent', 'local', 'troubleshooting.md'), 'KEEP-LOCAL');

    assert.equal(detectLegacyRootRepair({ cwd: primaryApp }).status, 'unchanged');
    assert.equal(repairLegacyRoot({ cwd: primaryApp }).status, 'unchanged');
    assert.equal(
      readFileSync(join(primaryApp, '.rn-agent', 'integration', 'authority.json'), 'utf8'),
      'FOREIGN-AUTHORITY',
    );
    assert.equal(
      readFileSync(join(primaryApp, '.rn-agent', 'local', 'troubleshooting.md'), 'utf8'),
      'KEEP-LOCAL',
    );
  } finally {
    fixture.cleanup();
  }
});

test('legacy damage is detection-only until explicit repair restores local state', () => {
  const fixture = makeFixture();
  try {
    const primaryApp = seedPrivateCorpus(fixture);
    const worktree = addWorktree(fixture);
    seedLegacyDamage(worktree, primaryApp);

    const plan = planInheritance({ cwd: worktree, appRoot: worktree, host: 'claude' });
    assert.equal(plan.resources[0].state, 'LEGACY_ROOT_LINK');
    assert.equal(plan.resources[0].action, 'none');
    assert.match(plan.resources[0].remediation ?? '', /RN_AGENT_LEGACY_ROOT_REPAIR_REQUIRED/);
    assert.equal(detectLegacyRootRepair({ cwd: worktree }).status, 'required');

    const startupApply = applyInheritance({
      cwd: worktree,
      appRoot: worktree,
      host: 'claude',
      allowRepair: true,
    });
    assert.equal(startupApply.outcomes[0].result, 'skipped');
    assert.equal(lstatSync(join(worktree, '.rn-agent')).isSymbolicLink(), true);
    assert.equal(
      readFileSync(join(worktree, '.rn-agent.bak', 'local', 'troubleshooting.md'), 'utf8'),
      'KEEP-LOCAL',
    );

    const repaired = repairLegacyRoot({ cwd: worktree, appRoot: worktree });
    assert.equal(repaired.status, 'repaired', JSON.stringify(repaired));
    assert.equal(repaired.code, 'RN_AGENT_LEGACY_ROOT_REPAIR_COMPLETED');
    assert.deepEqual(repaired.retainedPaths, ['.rn-agent/actions.pre-repair']);
    assertSplitLayout(worktree, primaryApp);
    assert.equal(
      readFileSync(join(worktree, '.rn-agent', 'integration', 'launcher.cjs'), 'utf8'),
      'KEEP-INTEGRATION',
    );
    assert.equal(
      readFileSync(join(worktree, '.rn-agent', 'local', 'troubleshooting.md'), 'utf8'),
      'KEEP-LOCAL',
    );
    assert.equal(
      readFileSync(join(worktree, '.rn-agent', 'actions.pre-repair', 'local.yaml'), 'utf8'),
      'KEEP-LOCAL-ACTION',
    );
    assert.equal(repairLegacyRoot({ cwd: worktree }).status, 'unchanged');
  } finally {
    fixture.cleanup();
  }
});

test('explicit repair refuses Git-visible state without moving the legacy layout', () => {
  const fixture = makeFixture({ ignore: '' });
  try {
    const primaryApp = seedPrivateCorpus(fixture);
    const worktree = addWorktree(fixture);
    seedLegacyDamage(worktree, primaryApp);

    const report = repairLegacyRoot({ cwd: worktree, appRoot: worktree });
    assert.equal(report.status, 'refused');
    assert.match(report.reason, /Git-visible/);
    assert.equal(lstatSync(join(worktree, '.rn-agent')).isSymbolicLink(), true);
    assert.equal(
      readFileSync(join(worktree, '.rn-agent.bak', 'local', 'troubleshooting.md'), 'utf8'),
      'KEEP-LOCAL',
    );
  } finally {
    fixture.cleanup();
  }
});

test('explicit repair preserves ambiguous action corpora and refuses a preservation collision', () => {
  const fixture = makeFixture();
  try {
    const primaryApp = seedPrivateCorpus(fixture);
    const worktree = addWorktree(fixture);
    seedLegacyDamage(worktree, primaryApp);
    mkdirSync(join(worktree, '.rn-agent.bak', 'actions.pre-repair'));
    writeFileSync(
      join(worktree, '.rn-agent.bak', 'actions.pre-repair', 'older.yaml'),
      'KEEP-OLDER',
    );

    const report = repairLegacyRoot({ cwd: worktree });
    assert.equal(report.status, 'refused');
    assert.match(report.reason, /Both actions and actions\.pre-repair/);
    assert.equal(lstatSync(join(worktree, '.rn-agent')).isSymbolicLink(), true);
    assert.equal(
      readFileSync(join(worktree, '.rn-agent.bak', 'actions', 'local.yaml'), 'utf8'),
      'KEEP-LOCAL-ACTION',
    );
    assert.equal(
      readFileSync(join(worktree, '.rn-agent.bak', 'actions.pre-repair', 'older.yaml'), 'utf8'),
      'KEEP-OLDER',
    );
  } finally {
    fixture.cleanup();
  }
});

test('explicit repair is serialized by the common-worktree lock', () => {
  const fixture = makeFixture();
  try {
    const primaryApp = seedPrivateCorpus(fixture);
    const worktree = addWorktree(fixture);
    seedLegacyDamage(worktree, primaryApp);
    const lockDirectory = join(fixture.primary, '.git', 'rn-dev-agent');
    mkdirSync(lockDirectory);
    writeFileSync(join(lockDirectory, 'worktree-root-repair.lock'), 'owned elsewhere');

    const report = repairLegacyRoot({ cwd: worktree });
    assert.equal(report.code, 'RN_AGENT_LEGACY_ROOT_REPAIR_LOCKED');
    assert.equal(lstatSync(join(worktree, '.rn-agent')).isSymbolicLink(), true);
    assert.equal(
      readFileSync(join(worktree, '.rn-agent.bak', 'local', 'troubleshooting.md'), 'utf8'),
      'KEEP-LOCAL',
    );
  } finally {
    fixture.cleanup();
  }
});

test('explicit repair refuses a foreign repository-lock directory', () => {
  const fixture = makeFixture();
  try {
    const primaryApp = seedPrivateCorpus(fixture);
    const worktree = addWorktree(fixture);
    seedLegacyDamage(worktree, primaryApp);
    const foreign = join(fixture.root, 'foreign-lock-state');
    mkdirSync(foreign);
    symlinkSync(foreign, join(fixture.primary, '.git', 'rn-dev-agent'), 'dir');

    const report = repairLegacyRoot({ cwd: worktree });
    assert.equal(report.status, 'refused');
    assert.match(report.reason, /lock directory is not a verified real directory/);
    assert.equal(lstatSync(join(worktree, '.rn-agent')).isSymbolicLink(), true);
    assert.equal(
      readFileSync(join(worktree, '.rn-agent.bak', 'local', 'troubleshooting.md'), 'utf8'),
      'KEEP-LOCAL',
    );
  } finally {
    fixture.cleanup();
  }
});

test('explicit repair creates an empty canonical corpus when no actions corpus exists', () => {
  const fixture = makeFixture();
  try {
    const primaryApp = appPath(fixture.primary, fixture.appRelative);
    const worktree = addWorktree(fixture);
    mkdirSync(join(worktree, '.rn-agent.bak', 'integration'), { recursive: true });
    mkdirSync(join(worktree, '.rn-agent.bak', 'local'), { recursive: true });
    writeFileSync(join(worktree, '.rn-agent.bak', 'local', 'troubleshooting.md'), 'KEEP-LOCAL');
    symlinkSync(join(primaryApp, '.rn-agent'), join(worktree, '.rn-agent'), 'dir');

    const report = repairLegacyRoot({ cwd: worktree });
    assert.equal(report.status, 'repaired', JSON.stringify(report));
    assert.equal(lstatSync(join(primaryApp, '.rn-agent')).isDirectory(), true);
    assertSplitLayout(worktree, primaryApp);
    assert.equal(
      readFileSync(join(worktree, '.rn-agent', 'local', 'troubleshooting.md'), 'utf8'),
      'KEEP-LOCAL',
    );
  } finally {
    fixture.cleanup();
  }
});

test('explicit repair leaves a healthy real root unchanged and refuses partial backup collisions', () => {
  const healthy = makeFixture();
  try {
    const primaryApp = seedPrivateCorpus(healthy);
    const worktree = addWorktree(healthy);
    applyInheritance({ cwd: worktree, appRoot: worktree, host: 'claude' });
    mkdirSync(join(worktree, '.rn-agent', 'local'));
    writeFileSync(join(worktree, '.rn-agent', 'local', 'unique.txt'), 'KEEP');

    const unchanged = repairLegacyRoot({ cwd: worktree });
    assert.equal(unchanged.status, 'unchanged');
    assert.equal(readFileSync(join(worktree, '.rn-agent', 'local', 'unique.txt'), 'utf8'), 'KEEP');

    mkdirSync(join(worktree, '.rn-agent.bak'));
    writeFileSync(join(worktree, '.rn-agent.bak', 'retained.txt'), 'KEEP-BACKUP');
    const partial = repairLegacyRoot({ cwd: worktree });
    assert.equal(partial.status, 'refused');
    assert.match(partial.reason, /partial migration/);
    assert.equal(readFileSync(join(worktree, '.rn-agent', 'local', 'unique.txt'), 'utf8'), 'KEEP');
    assert.equal(
      readFileSync(join(worktree, '.rn-agent.bak', 'retained.txt'), 'utf8'),
      'KEEP-BACKUP',
    );
    assertSplitLayout(worktree, primaryApp);
  } finally {
    healthy.cleanup();
  }
});

test('explicit repair refuses missing-root and unsafe-backup partial migrations', () => {
  const fixture = makeFixture();
  try {
    seedPrivateCorpus(fixture);
    const worktree = addWorktree(fixture);
    mkdirSync(join(worktree, '.rn-agent.bak'));
    writeFileSync(join(worktree, '.rn-agent.bak', 'retained.txt'), 'KEEP');

    const missingRoot = repairLegacyRoot({ cwd: worktree });
    assert.equal(missingRoot.status, 'refused');
    assert.match(missingRoot.reason, /without its displaced root/);
    assert.equal(readFileSync(join(worktree, '.rn-agent.bak', 'retained.txt'), 'utf8'), 'KEEP');

    const unsafeBackup = join(fixture.root, 'unsafe-backup');
    mkdirSync(unsafeBackup);
    symlinkSync(unsafeBackup, join(worktree, '.rn-agent'));
    const foreign = repairLegacyRoot({ cwd: worktree });
    assert.equal(foreign.status, 'refused');
    assert.equal(readFileSync(join(worktree, '.rn-agent.bak', 'retained.txt'), 'utf8'), 'KEEP');
  } finally {
    fixture.cleanup();
  }
});

test('report prints a typed executable remedy without mutating legacy damage', () => {
  const fixture = makeFixture();
  try {
    const primaryApp = seedPrivateCorpus(fixture);
    const worktree = addWorktree(fixture);
    seedLegacyDamage(worktree, primaryApp);

    const report = cli(worktree, ['report', '--host', 'claude', '--app-root', worktree]);
    assert.equal(report.status, 0, report.stderr);
    assert.match(report.stdout, /RN_AGENT_LEGACY_ROOT_REPAIR_REQUIRED/);
    assert.match(report.stdout, /worktree-inheritance\.js.* repair --app-root/);
    assert.equal(lstatSync(join(worktree, '.rn-agent')).isSymbolicLink(), true);
    assert.equal(
      readFileSync(join(worktree, '.rn-agent.bak', 'integration', 'launcher.cjs'), 'utf8'),
      'KEEP-INTEGRATION',
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

test('post-checkout lifecycle detects legacy damage without repairing it', () => {
  const fixture = makeFixture();
  try {
    const primaryApp = seedPrivateCorpus(fixture);
    const install = cli(fixture.primary, ['hook', 'install', '--host', 'claude'], PACKAGED_CLI);
    assert.equal(install.status, 0, install.stderr);
    const worktree = addWorktree(fixture, 'legacy-hook');
    rmSync(join(worktree, '.rn-agent'), { recursive: true });
    seedLegacyDamage(worktree, primaryApp);

    const hook = join(fixture.primary, '.git', 'hooks', 'post-checkout');
    const lifecycle = spawnSync(hook, ['old-head', 'new-head', '1'], {
      cwd: worktree,
      encoding: 'utf8',
    });
    assert.equal(lifecycle.status, 0, lifecycle.stderr);
    assert.equal(lstatSync(join(worktree, '.rn-agent')).isSymbolicLink(), true);
    assert.equal(
      readFileSync(join(worktree, '.rn-agent.bak', 'local', 'troubleshooting.md'), 'utf8'),
      'KEEP-LOCAL',
    );
    const lastRun = JSON.parse(
      readFileSync(
        join(fixture.primary, '.git', 'rn-dev-agent', 'worktree-inheritance-last-run.json'),
        'utf8',
      ),
    ) as { outcomes: Array<{ state: string; result: string }> };
    assert.deepEqual(lastRun.outcomes, [
      { id: 'rn-agent-actions', state: 'LEGACY_ROOT_LINK', result: 'skipped' },
    ]);
  } finally {
    fixture.cleanup();
  }
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
