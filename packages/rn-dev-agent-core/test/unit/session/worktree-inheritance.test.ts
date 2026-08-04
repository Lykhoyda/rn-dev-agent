import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  applyInheritance,
  parseWorktreeRecords,
  planInheritance,
  resolveWorktreeLayout,
  resourcesForHost,
  SHAREABLE_RESOURCES,
} from '../../../dist/session/worktree-inheritance.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CORE_ROOT = join(HERE, '..', '..', '..');
const CLI = join(CORE_ROOT, 'dist', 'worktree-inheritance.js');
// The committed, self-contained artifact a marketplace install actually runs.
const PACKAGED_CLI = join(
  CORE_ROOT,
  '..',
  'claude-plugin',
  'rn-dev-agent-core',
  'dist',
  'worktree-inheritance.js',
);

const PRIVATE_MARKER = 'SYNTHETIC-PRIVATE-BODY-DO-NOT-LEAK';

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return (result.stdout ?? '').trim();
}

function cli(cwd: string, args: string[], entry: string = CLI) {
  const result = spawnSync(process.execPath, [entry, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (result.error) throw result.error;
  assert.notEqual(result.status, null, `helper did not exit cleanly (signal ${result.signal})`);
  return {
    status: result.status as number,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

interface Fixture {
  root: string;
  primary: string;
  cleanup: () => void;
}

function makeFixture(
  options: { appRelative?: string; ignore?: string; prefix?: string } = {},
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
  writeFileSync(join(app, 'app.json'), '{}');
  const ignore =
    options.ignore ??
    `${appRelative === '.' ? '' : `${appRelative}/`}.rn-agent/\nCLAUDE.local.md\n`;
  writeFileSync(join(primary, '.gitignore'), ignore);
  git(primary, ['add', '-A']);
  git(primary, ['commit', '-qm', 'init']);
  return {
    root,
    primary,
    cleanup: () => rmSync(root, { force: true, recursive: true }),
  };
}

function seedPrivateCorpus(primary: string, appRelative = '.'): void {
  const app = appRelative === '.' ? primary : join(primary, appRelative);
  mkdirSync(join(app, '.rn-agent', 'actions'), { recursive: true });
  mkdirSync(join(app, '.rn-agent', 'state'), { recursive: true });
  writeFileSync(
    join(app, '.rn-agent', 'actions', 'canonical-synthetic.yaml'),
    `appId: com.synthetic.app\n---\n# id: canonical-synthetic\n- launchApp\n`,
  );
  writeFileSync(join(app, '.rn-agent', 'state', 'actions.db'), 'PRIMARY-LOCAL-STATE');
  writeFileSync(join(primary, 'CLAUDE.local.md'), `# private\n${PRIVATE_MARKER}\n`);
}

function addWorktree(primary: string, path: string, branch: string, extra: string[] = []): void {
  git(primary, ['worktree', 'add', '-q', ...extra, path, '-b', branch]);
}

test('parses porcelain records and rejects bare and prunable entries', () => {
  const records = parseWorktreeRecords(
    [
      'worktree /repos/with space/main',
      'HEAD abc',
      'branch refs/heads/main',
      '',
      'worktree /repos/bare',
      'bare',
      '',
      'worktree /repos/gone',
      'prunable gitdir file points to non-existent location',
      '',
    ].join('\n'),
  );
  assert.equal(records.length, 3);
  assert.equal(records[0].path, '/repos/with space/main');
  assert.equal(records[0].bare, false);
  assert.equal(records[1].bare, true);
  assert.equal(records[2].prunable, true);
});

test('standard linked worktree links the corpus and the local instructions', () => {
  const fixture = makeFixture();
  try {
    seedPrivateCorpus(fixture.primary);
    const worktree = join(fixture.root, 'wt');
    addWorktree(fixture.primary, worktree, 'feature');

    const plan = planInheritance({ cwd: worktree, host: 'claude' });
    assert.equal(plan.layout.kind, 'linked');
    assert.deepEqual(
      plan.resources.map((entry) => entry.state),
      ['DEST_MISSING', 'DEST_MISSING'],
    );

    const report = applyInheritance({ cwd: worktree, host: 'claude' });
    assert.equal(report.applied, 2);
    assert.equal(
      readFileSync(
        join(worktree, '.rn-agent', 'actions', 'canonical-synthetic.yaml'),
        'utf8',
      ).includes('canonical-synthetic'),
      true,
    );
    assert.equal(
      readFileSync(join(worktree, 'CLAUDE.local.md'), 'utf8').includes(PRIVATE_MARKER),
      true,
    );

    assert.equal(lstatSync(join(worktree, '.rn-agent')).isSymbolicLink(), false);
    assert.equal(lstatSync(join(worktree, '.rn-agent', 'actions')).isSymbolicLink(), true);
    assert.equal(git(worktree, ['status', '--porcelain']), '');
  } finally {
    fixture.cleanup();
  }
});

test('mutable runtime state stays local while only the corpus is shared', () => {
  const fixture = makeFixture();
  try {
    seedPrivateCorpus(fixture.primary);
    const worktree = join(fixture.root, 'wt');
    addWorktree(fixture.primary, worktree, 'feature');
    applyInheritance({ cwd: worktree, host: 'claude' });

    assert.equal(existsSync(join(worktree, '.rn-agent', 'state')), false);
    writeFileSync(join(worktree, '.rn-agent', 'state-probe'), 'local');
    assert.equal(existsSync(join(fixture.primary, '.rn-agent', 'state-probe')), false);

    const shared = SHAREABLE_RESOURCES.map((entry) => entry.path);
    assert.deepEqual(shared, ['.rn-agent/actions', 'CLAUDE.local.md']);
    for (const runtime of ['state', 'recordings', 'snapshots', 'diag', 'local', 'integration']) {
      assert.equal(
        shared.some((entry) => entry.startsWith(`.rn-agent/${runtime}`)),
        false,
        `${runtime} must never be shared`,
      );
    }
  } finally {
    fixture.cleanup();
  }
});

test('idempotent re-plan converges and writes nothing', () => {
  const fixture = makeFixture();
  try {
    seedPrivateCorpus(fixture.primary);
    const worktree = join(fixture.root, 'wt');
    addWorktree(fixture.primary, worktree, 'feature');
    applyInheritance({ cwd: worktree, host: 'claude' });

    const plan = planInheritance({ cwd: worktree, host: 'claude' });
    assert.deepEqual(
      plan.resources.map((entry) => entry.state),
      ['LINK_VALID_SAFE', 'LINK_VALID_SAFE'],
    );
    const second = applyInheritance({ cwd: worktree, host: 'claude' });
    assert.equal(second.applied, 0);
    assert.deepEqual(
      second.outcomes.map((entry) => entry.result),
      ['converged', 'converged'],
    );
  } finally {
    fixture.cleanup();
  }
});

test('nested RN app maps app-relative into the primary and never anchors at the Git root', () => {
  const fixture = makeFixture({ appRelative: 'apps/mobile' });
  try {
    seedPrivateCorpus(fixture.primary, 'apps/mobile');
    mkdirSync(join(fixture.primary, '.rn-agent', 'actions'), { recursive: true });
    writeFileSync(join(fixture.primary, '.rn-agent', 'actions', 'DECOY.yaml'), 'appId: decoy');

    const worktree = join(fixture.root, 'wt');
    addWorktree(fixture.primary, worktree, 'feature');
    const appRoot = join(worktree, 'apps', 'mobile');

    const plan = planInheritance({ cwd: worktree, appRoot, host: 'claude' });
    assert.equal(plan.layout.appRelative, 'apps/mobile');
    assert.equal(plan.resources[0].destination, 'apps/mobile/.rn-agent/actions');

    applyInheritance({ cwd: worktree, appRoot, host: 'claude' });
    assert.equal(
      existsSync(join(appRoot, '.rn-agent', 'actions', 'canonical-synthetic.yaml')),
      true,
    );
    assert.equal(existsSync(join(appRoot, '.rn-agent', 'actions', 'DECOY.yaml')), false);
    assert.equal(existsSync(join(worktree, '.rn-agent', 'actions')), false);
  } finally {
    fixture.cleanup();
  }
});

test('paths with spaces and a symlinked invocation path resolve correctly', () => {
  const fixture = makeFixture({ prefix: 'rn wt space-' });
  try {
    seedPrivateCorpus(fixture.primary);
    const worktree = join(fixture.root, 'wt with spaces');
    addWorktree(fixture.primary, worktree, 'feature');

    const alias = join(fixture.root, 'alias');
    symlinkSync(worktree, alias, 'dir');

    const report = applyInheritance({ cwd: alias, host: 'claude' });
    assert.equal(report.applied, 2);
    assert.equal(
      existsSync(join(worktree, '.rn-agent', 'actions', 'canonical-synthetic.yaml')),
      true,
    );
  } finally {
    fixture.cleanup();
  }
});

test('tracked corpus keeps the team regime and is never inherited', () => {
  const fixture = makeFixture({ ignore: '' });
  try {
    mkdirSync(join(fixture.primary, '.rn-agent', 'actions'), { recursive: true });
    writeFileSync(join(fixture.primary, '.rn-agent', 'actions', 'team.yaml'), 'appId: com.team');
    git(fixture.primary, ['add', '-A']);
    git(fixture.primary, ['commit', '-qm', 'track corpus']);

    const worktree = join(fixture.root, 'wt');
    addWorktree(fixture.primary, worktree, 'feature');

    const plan = planInheritance({ cwd: worktree, host: 'claude' });
    const corpus = plan.resources.find((entry) => entry.id === 'rn-agent-actions')!;
    assert.equal(corpus.regime, 'GIT_MANAGED');
    assert.equal(corpus.state, 'TRACKED');
    assert.equal(corpus.action, 'none');

    const report = applyInheritance({ cwd: worktree, host: 'claude' });
    assert.equal(report.applied, 0);
    assert.equal(lstatSync(join(worktree, '.rn-agent', 'actions')).isSymbolicLink(), false);
    assert.equal(git(worktree, ['status', '--porcelain']), '');
  } finally {
    fixture.cleanup();
  }
});

test('a Git-visible destination refuses with a file-form rule and no absolute path', () => {
  const fixture = makeFixture({ ignore: 'node_modules/\n' });
  try {
    seedPrivateCorpus(fixture.primary);
    const worktree = join(fixture.root, 'wt');
    addWorktree(fixture.primary, worktree, 'feature');

    const plan = planInheritance({ cwd: worktree, host: 'claude' });
    for (const resource of plan.resources) {
      assert.equal(resource.state, 'IGNORE_UNSAFE');
      assert.equal(resource.action, 'none');
      assert.match(resource.remediation!, /file-form rule/);
      assert.equal(resource.remediation!.includes(fixture.primary), false);
    }
    const report = applyInheritance({ cwd: worktree, host: 'claude' });
    assert.equal(report.applied, 0);
    assert.equal(existsSync(join(worktree, 'CLAUDE.local.md')), false);
    assert.equal(git(worktree, ['status', '--porcelain']), '');
  } finally {
    fixture.cleanup();
  }
});

test('an already valid but Git-visible link is reported rather than silently accepted', () => {
  const fixture = makeFixture({ ignore: 'node_modules/\n' });
  try {
    seedPrivateCorpus(fixture.primary);
    const worktree = join(fixture.root, 'wt');
    addWorktree(fixture.primary, worktree, 'feature');
    symlinkSync(
      join(fixture.primary, 'CLAUDE.local.md'),
      join(worktree, 'CLAUDE.local.md'),
      'file',
    );

    const plan = planInheritance({ cwd: worktree, host: 'claude', resources: ['claude-local-md'] });
    assert.equal(plan.resources[0].state, 'LINK_VALID_GIT_VISIBLE');
  } finally {
    fixture.cleanup();
  }
});

test('stale, foreign, chained, collision and wrong-type states are classified independently', () => {
  const fixture = makeFixture();
  try {
    seedPrivateCorpus(fixture.primary);
    const worktree = join(fixture.root, 'wt');
    addWorktree(fixture.primary, worktree, 'feature');

    symlinkSync(
      join(fixture.primary, 'CLAUDE.local.md'),
      join(worktree, 'CLAUDE.local.md'),
      'file',
    );
    mkdirSync(join(worktree, '.rn-agent'), { recursive: true });
    symlinkSync(join(fixture.root, 'nowhere'), join(worktree, '.rn-agent', 'actions'), 'dir');

    let plan = planInheritance({ cwd: worktree, host: 'claude' });
    assert.equal(plan.resources[0].state, 'LINK_STALE_SOURCE_AVAILABLE');
    assert.equal(plan.resources[0].action, 'repair');
    assert.equal(plan.resources[1].state, 'LINK_VALID_SAFE');

    const noRepair = applyInheritance({ cwd: worktree, host: 'claude' });
    assert.equal(noRepair.applied, 0);
    assert.equal(lstatSync(join(worktree, '.rn-agent', 'actions')).isSymbolicLink(), true);

    const repaired = applyInheritance({ cwd: worktree, host: 'claude', allowRepair: true });
    assert.equal(
      repaired.outcomes.find((entry) => entry.id === 'rn-agent-actions')!.result,
      'repaired',
    );
    assert.equal(
      existsSync(join(worktree, '.rn-agent', 'actions', 'canonical-synthetic.yaml')),
      true,
    );

    rmSync(join(worktree, '.rn-agent', 'actions'));
    const elsewhere = join(fixture.root, 'elsewhere');
    mkdirSync(elsewhere, { recursive: true });
    symlinkSync(elsewhere, join(worktree, '.rn-agent', 'actions'), 'dir');
    plan = planInheritance({ cwd: worktree, host: 'claude', resources: ['rn-agent-actions'] });
    assert.equal(plan.resources[0].state, 'LINK_FOREIGN');
    assert.equal(applyInheritance({ cwd: worktree, host: 'claude', allowRepair: true }).applied, 0);
    assert.equal(realpathSync(join(worktree, '.rn-agent', 'actions')), elsewhere);

    rmSync(join(worktree, '.rn-agent', 'actions'));
    mkdirSync(join(worktree, '.rn-agent', 'actions'), { recursive: true });
    writeFileSync(join(worktree, '.rn-agent', 'actions', 'mine.yaml'), 'local-only');
    plan = planInheritance({ cwd: worktree, host: 'claude', resources: ['rn-agent-actions'] });
    assert.equal(plan.resources[0].state, 'COLLISION_DIRECTORY');
    applyInheritance({ cwd: worktree, host: 'claude', allowRepair: true });
    assert.equal(
      readFileSync(join(worktree, '.rn-agent', 'actions', 'mine.yaml'), 'utf8'),
      'local-only',
    );

    rmSync(join(worktree, 'CLAUDE.local.md'));
    writeFileSync(join(worktree, 'CLAUDE.local.md'), 'REAL LOCAL FILE');
    plan = planInheritance({ cwd: worktree, host: 'claude', resources: ['claude-local-md'] });
    assert.equal(plan.resources[0].state, 'COLLISION_FILE');
    applyInheritance({ cwd: worktree, host: 'claude', allowRepair: true });
    assert.equal(readFileSync(join(worktree, 'CLAUDE.local.md'), 'utf8'), 'REAL LOCAL FILE');
  } finally {
    fixture.cleanup();
  }
});

test('a chained source symlink is accepted only after canonical type verification', () => {
  const fixture = makeFixture();
  try {
    const store = join(fixture.root, 'out-of-repo-store');
    mkdirSync(join(store, 'actions'), { recursive: true });
    writeFileSync(join(store, 'actions', 'canonical-synthetic.yaml'), 'appId: com.synthetic.app');
    mkdirSync(join(fixture.primary, '.rn-agent'), { recursive: true });
    symlinkSync(join(store, 'actions'), join(fixture.primary, '.rn-agent', 'actions'), 'dir');

    const worktree = join(fixture.root, 'wt');
    addWorktree(fixture.primary, worktree, 'feature');
    const report = applyInheritance({
      cwd: worktree,
      host: 'claude',
      resources: ['rn-agent-actions'],
    });
    assert.equal(report.applied, 1);
    assert.equal(
      existsSync(join(worktree, '.rn-agent', 'actions', 'canonical-synthetic.yaml')),
      true,
    );
    assert.equal(
      planInheritance({ cwd: worktree, host: 'claude', resources: ['rn-agent-actions'] })
        .resources[0].state,
      'LINK_VALID_SAFE',
    );
  } finally {
    fixture.cleanup();
  }
});

test('a wrong-type source refuses instead of linking', () => {
  const fixture = makeFixture();
  try {
    mkdirSync(join(fixture.primary, '.rn-agent'), { recursive: true });
    writeFileSync(join(fixture.primary, '.rn-agent', 'actions'), 'not a directory');
    mkdirSync(join(fixture.primary, 'CLAUDE.local.md'), { recursive: true });

    const worktree = join(fixture.root, 'wt');
    addWorktree(fixture.primary, worktree, 'feature');
    const plan = planInheritance({ cwd: worktree, host: 'claude' });
    assert.deepEqual(
      plan.resources.map((entry) => entry.state),
      ['SOURCE_WRONG_TYPE', 'SOURCE_WRONG_TYPE'],
    );
    assert.equal(applyInheritance({ cwd: worktree, host: 'claude' }).applied, 0);
  } finally {
    fixture.cleanup();
  }
});

test('a missing source reports SOURCE_MISSING and never creates a dangling link', () => {
  const fixture = makeFixture();
  try {
    const worktree = join(fixture.root, 'wt');
    addWorktree(fixture.primary, worktree, 'feature');
    const plan = planInheritance({ cwd: worktree, host: 'claude' });
    assert.deepEqual(
      plan.resources.map((entry) => entry.state),
      ['SOURCE_MISSING', 'SOURCE_MISSING'],
    );
    applyInheritance({ cwd: worktree, host: 'claude' });
    assert.equal(existsSync(join(worktree, '.rn-agent')), false);
    assert.equal(lstatSync(worktree).isDirectory(), true);
  } finally {
    fixture.cleanup();
  }
});

test('a source deleted between plan and apply refuses instead of linking', () => {
  const fixture = makeFixture();
  try {
    seedPrivateCorpus(fixture.primary);
    const worktree = join(fixture.root, 'wt');
    addWorktree(fixture.primary, worktree, 'feature');

    const plan = planInheritance({ cwd: worktree, host: 'claude', resources: ['claude-local-md'] });
    assert.equal(plan.resources[0].action, 'link');

    rmSync(join(fixture.primary, 'CLAUDE.local.md'));
    const report = applyInheritance({
      cwd: worktree,
      host: 'claude',
      resources: ['claude-local-md'],
    });
    assert.equal(report.applied, 0);
    assert.equal(existsSync(join(worktree, 'CLAUDE.local.md')), false);
    assert.equal(lstatSync(worktree).isDirectory(), true);
  } finally {
    fixture.cleanup();
  }
});

test('concurrent creation converges and partial outcomes are explicit', () => {
  const fixture = makeFixture();
  try {
    seedPrivateCorpus(fixture.primary);
    rmSync(join(fixture.primary, 'CLAUDE.local.md'));
    const worktree = join(fixture.root, 'wt');
    addWorktree(fixture.primary, worktree, 'feature');

    mkdirSync(join(worktree, '.rn-agent'), { recursive: true });
    symlinkSync(
      join(fixture.primary, '.rn-agent', 'actions'),
      join(worktree, '.rn-agent', 'actions'),
      'dir',
    );

    const report = applyInheritance({ cwd: worktree, host: 'claude' });
    assert.equal(report.requested, 2);
    assert.equal(report.applied, 0);
    const corpus = report.outcomes.find((entry) => entry.id === 'rn-agent-actions')!;
    const local = report.outcomes.find((entry) => entry.id === 'claude-local-md')!;
    assert.equal(corpus.result, 'converged');
    assert.equal(local.state, 'SOURCE_MISSING');
  } finally {
    fixture.cleanup();
  }
});

test('a permission-denied destination parent refuses without mutation', () => {
  if (process.getuid?.() === 0) return;
  const fixture = makeFixture();
  try {
    seedPrivateCorpus(fixture.primary);
    const worktree = join(fixture.root, 'wt');
    addWorktree(fixture.primary, worktree, 'feature');
    mkdirSync(join(worktree, '.rn-agent'), { recursive: true });
    chmodSync(join(worktree, '.rn-agent'), 0o500);
    try {
      const report = applyInheritance({
        cwd: worktree,
        host: 'claude',
        resources: ['rn-agent-actions'],
      });
      assert.equal(report.applied, 0);
      assert.equal(report.outcomes[0].result, 'refused');
      assert.equal(existsSync(join(worktree, '.rn-agent', 'actions')), false);
    } finally {
      chmodSync(join(worktree, '.rn-agent'), 0o700);
    }
  } finally {
    fixture.cleanup();
  }
});

test('a legacy whole-directory .rn-agent symlink is never written through', () => {
  const fixture = makeFixture();
  try {
    seedPrivateCorpus(fixture.primary);
    const worktree = join(fixture.root, 'wt');
    addWorktree(fixture.primary, worktree, 'feature');
    symlinkSync(join(fixture.primary, '.rn-agent'), join(worktree, '.rn-agent'), 'dir');

    const plan = planInheritance({
      cwd: worktree,
      host: 'claude',
      resources: ['rn-agent-actions'],
    });
    assert.equal(plan.resources[0].state, 'LINK_FOREIGN');
    assert.match(plan.resources[0].remediation!, /legacy layout/);
    const report = applyInheritance({
      cwd: worktree,
      host: 'claude',
      resources: ['rn-agent-actions'],
      allowRepair: true,
    });
    assert.equal(report.applied, 0);
    assert.equal(lstatSync(join(worktree, '.rn-agent')).isSymbolicLink(), true);
  } finally {
    fixture.cleanup();
  }
});

test('a decoy beside a separate git dir is never selected', () => {
  const fixture = makeFixture();
  try {
    const root = fixture.root;
    const detached = join(root, 'detached');
    mkdirSync(detached, { recursive: true });
    const separate = join(root, 'separate-app');
    mkdirSync(separate, { recursive: true });
    git(root, ['init', '-q', `--separate-git-dir=${join(detached, 'gitdir')}`, separate]);
    git(separate, ['config', 'user.email', 'fixture@example.test']);
    git(separate, ['config', 'user.name', 'fixture']);
    writeFileSync(
      join(separate, 'package.json'),
      JSON.stringify({ dependencies: { 'react-native': '0.76.0' } }),
    );
    writeFileSync(join(separate, '.gitignore'), '.rn-agent/\nCLAUDE.local.md\n');
    git(separate, ['add', '-A']);
    git(separate, ['commit', '-qm', 'init']);

    mkdirSync(join(detached, '.rn-agent', 'actions'), { recursive: true });
    writeFileSync(join(detached, '.rn-agent', 'actions', 'DECOY.yaml'), 'appId: decoy');
    writeFileSync(join(detached, 'CLAUDE.local.md'), 'DECOY');

    const worktree = join(root, 'separate-wt');
    git(separate, ['worktree', 'add', '-q', worktree, '-b', 'feature']);

    const layout = resolveWorktreeLayout({ cwd: worktree });
    assert.equal('refusal' in layout ? layout.refusal : undefined, 'NO_PRIMARY');
    const report = applyInheritance({ cwd: worktree, host: 'claude' });
    assert.equal(report.applied, 0);
    assert.equal(existsSync(join(worktree, '.rn-agent')), false);
    assert.equal(existsSync(join(worktree, 'CLAUDE.local.md')), false);
    assert.equal(existsSync(join(detached, '.rn-agent', 'actions', 'DECOY.yaml')), true);
  } finally {
    fixture.cleanup();
  }
});

test('a bare primary refuses with NO_PRIMARY and no mutation', () => {
  const fixture = makeFixture();
  try {
    const bare = join(fixture.root, 'bare.git');
    git(fixture.root, ['clone', '-q', '--bare', fixture.primary, bare]);
    const worktree = join(fixture.root, 'bare-wt');
    git(bare, ['worktree', 'add', '-q', worktree, '-b', 'feature']);

    const layout = resolveWorktreeLayout({ cwd: worktree });
    assert.equal('refusal' in layout ? layout.refusal : undefined, 'NO_PRIMARY');
    assert.equal(applyInheritance({ cwd: worktree, host: 'claude' }).applied, 0);
  } finally {
    fixture.cleanup();
  }
});

test('pooled and prunable sibling registrations do not create ambiguity', () => {
  const fixture = makeFixture();
  try {
    seedPrivateCorpus(fixture.primary);
    const pooled = join(fixture.root, 'pool-1');
    addWorktree(fixture.primary, pooled, 'pooled');
    const disposable = join(fixture.root, 'pool-2');
    addWorktree(fixture.primary, disposable, 'disposable');
    rmSync(disposable, { force: true, recursive: true });

    const layout = resolveWorktreeLayout({ cwd: pooled });
    assert.equal('refusal' in layout ? layout.refusal : undefined, undefined);
    assert.equal('primaryRoot' in layout ? layout.primaryRoot : '', fixture.primary);
    assert.equal(applyInheritance({ cwd: pooled, host: 'claude' }).applied, 2);
  } finally {
    fixture.cleanup();
  }
});

test('a moved and repaired worktree keeps working after git worktree repair', () => {
  const fixture = makeFixture();
  try {
    seedPrivateCorpus(fixture.primary);
    const original = join(fixture.root, 'wt');
    addWorktree(fixture.primary, original, 'feature');
    const moved = join(fixture.root, 'wt-moved');
    cpSync(original, moved, { recursive: true, verbatimSymlinks: true });
    rmSync(original, { force: true, recursive: true });
    git(fixture.primary, ['worktree', 'repair', moved]);

    const report = applyInheritance({ cwd: moved, host: 'claude' });
    assert.equal(report.applied, 2);
  } finally {
    fixture.cleanup();
  }
});

test('the primary worktree itself is never a link target', () => {
  const fixture = makeFixture();
  try {
    seedPrivateCorpus(fixture.primary);
    const plan = planInheritance({ cwd: fixture.primary, host: 'claude' });
    assert.equal(plan.layout.kind, 'primary');
    assert.deepEqual(plan.resources, []);
    assert.equal(applyInheritance({ cwd: fixture.primary, host: 'claude' }).requested, 0);
  } finally {
    fixture.cleanup();
  }
});

test('a non-RN directory refuses without inspecting any corpus', () => {
  const fixture = makeFixture();
  try {
    rmSync(join(fixture.primary, 'package.json'));
    git(fixture.primary, ['add', '-A']);
    git(fixture.primary, ['commit', '-qm', 'drop manifest']);
    const worktree = join(fixture.root, 'wt');
    addWorktree(fixture.primary, worktree, 'feature');
    const layout = resolveWorktreeLayout({ cwd: worktree });
    assert.equal('refusal' in layout ? layout.refusal : undefined, 'NOT_RN_APP');
  } finally {
    fixture.cleanup();
  }
});

test('Codex sees only the corpus resource and never Claude local instructions', () => {
  assert.deepEqual(
    resourcesForHost('codex').map((entry) => entry.id),
    ['rn-agent-actions'],
  );
  assert.deepEqual(
    resourcesForHost('claude').map((entry) => entry.id),
    ['rn-agent-actions', 'claude-local-md'],
  );
});

test('CLI output never leaks a private absolute path or a private body', () => {
  const fixture = makeFixture();
  try {
    seedPrivateCorpus(fixture.primary);
    const worktree = join(fixture.root, 'wt');
    addWorktree(fixture.primary, worktree, 'feature');

    for (const args of [
      ['plan'],
      ['plan', '--json'],
      ['report'],
      ['apply', '--host', 'claude'],
      ['report'],
    ]) {
      const result = cli(worktree, args);
      const combined = `${result.stdout}${result.stderr}`;
      assert.equal(combined.includes(PRIVATE_MARKER), false, `body leaked by ${args.join(' ')}`);
      assert.equal(
        combined.includes(fixture.primary),
        false,
        `source path leaked by ${args.join(' ')}`,
      );
      assert.equal(combined.includes('canonical-synthetic'), false);
    }
    assert.equal(existsSync(join(worktree, 'CLAUDE.local.md')), true);
  } finally {
    fixture.cleanup();
  }
});

test('the CLI report is silent when everything is already inherited', () => {
  const fixture = makeFixture();
  try {
    seedPrivateCorpus(fixture.primary);
    const worktree = join(fixture.root, 'wt');
    addWorktree(fixture.primary, worktree, 'feature');
    cli(worktree, ['apply', '--host', 'claude']);
    assert.equal(cli(worktree, ['report']).stdout.trim(), '');
    assert.equal(cli(fixture.primary, ['report']).stdout.trim(), '');
  } finally {
    fixture.cleanup();
  }
});

test('the CLI never imports or executes the MCP server entry', () => {
  const source = readFileSync(join(CORE_ROOT, 'src', 'worktree-inheritance.ts'), 'utf8');
  const imports = source.match(/from '[^']+'/g) ?? [];
  assert.equal(
    imports.some((entry) => entry.includes('index.js') || entry.includes("from './index")),
    false,
  );
  assert.equal(readFileSync(PACKAGED_CLI, 'utf8').includes('rn_dev_agent_mcp_started'), false);
});

test('the packaged helper runs from an isolated host-package layout', () => {
  const fixture = makeFixture();
  try {
    seedPrivateCorpus(fixture.primary);
    const worktree = join(fixture.root, 'wt');
    addWorktree(fixture.primary, worktree, 'feature');

    const isolated = join(fixture.root, 'installed-plugin', 'rn-dev-agent-core', 'dist');
    mkdirSync(isolated, { recursive: true });
    const entry = join(isolated, 'worktree-inheritance.js');
    cpSync(PACKAGED_CLI, entry);

    const result = cli(worktree, ['apply', '--host', 'claude'], entry);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      existsSync(join(worktree, '.rn-agent', 'actions', 'canonical-synthetic.yaml')),
      true,
    );
    assert.equal(existsSync(join(fixture.root, 'installed-plugin', 'node_modules')), false);
  } finally {
    fixture.cleanup();
  }
});

test('hook install is idempotent, repository-local, and drives git worktree add', () => {
  const fixture = makeFixture();
  try {
    seedPrivateCorpus(fixture.primary);
    const install = cli(fixture.primary, ['hook', 'install', '--host', 'claude'], PACKAGED_CLI);
    assert.equal(install.status, 0, install.stderr);
    const hookPath = join(fixture.primary, '.git', 'hooks', 'post-checkout');
    assert.equal(
      readFileSync(hookPath, 'utf8').includes('rn-dev-agent:worktree-inheritance'),
      true,
    );
    assert.equal(cli(fixture.primary, ['hook', 'status']).stdout.includes('installed'), true);
    assert.equal(
      cli(fixture.primary, ['hook', 'install', '--host', 'claude'], PACKAGED_CLI).status,
      0,
    );

    const worktree = join(fixture.root, 'auto');
    addWorktree(fixture.primary, worktree, 'auto');
    assert.equal(
      existsSync(join(worktree, '.rn-agent', 'actions', 'canonical-synthetic.yaml')),
      true,
    );
    assert.equal(
      readFileSync(join(worktree, 'CLAUDE.local.md'), 'utf8').includes(PRIVATE_MARKER),
      true,
    );
    assert.equal(git(worktree, ['status', '--porcelain']), '');

    git(worktree, ['checkout', '-q', '-b', 're-entry']);
    assert.equal(lstatSync(join(worktree, '.rn-agent', 'actions')).isSymbolicLink(), true);

    const skipped = join(fixture.root, 'no-checkout');
    git(fixture.primary, ['worktree', 'add', '-q', '--no-checkout', skipped, '-b', 'skipped']);
    assert.equal(existsSync(join(skipped, '.rn-agent')), false);

    assert.equal(cli(fixture.primary, ['hook', 'uninstall']).status, 0);
    assert.equal(existsSync(hookPath), false);
  } finally {
    fixture.cleanup();
  }
});

test('a Codex hook install never drops the Claude resource a previous install configured', () => {
  const fixture = makeFixture();
  try {
    seedPrivateCorpus(fixture.primary);
    cli(fixture.primary, ['hook', 'install', '--host', 'claude'], PACKAGED_CLI);
    cli(fixture.primary, ['hook', 'install', '--host', 'codex'], PACKAGED_CLI);
    const config = JSON.parse(
      readFileSync(
        join(fixture.primary, '.git', 'rn-dev-agent', 'worktree-inheritance.json'),
        'utf8',
      ),
    );
    assert.deepEqual(config.resources.sort(), ['claude-local-md', 'rn-agent-actions']);

    const worktree = join(fixture.root, 'after-codex');
    addWorktree(fixture.primary, worktree, 'after-codex');
    assert.equal(existsSync(join(worktree, 'CLAUDE.local.md')), true);
  } finally {
    fixture.cleanup();
  }
});

test('a branch without the nested app still inherits the worktree-root resource', () => {
  const fixture = makeFixture({ appRelative: 'apps/mobile' });
  try {
    seedPrivateCorpus(fixture.primary, 'apps/mobile');
    cli(
      join(fixture.primary, 'apps', 'mobile'),
      ['hook', 'install', '--host', 'claude'],
      PACKAGED_CLI,
    );
    git(fixture.primary, ['rm', '-rq', 'apps']);
    git(fixture.primary, ['commit', '-qm', 'drop app']);

    const worktree = join(fixture.root, 'no-app');
    addWorktree(fixture.primary, worktree, 'no-app');
    assert.equal(existsSync(join(worktree, 'apps', 'mobile')), false);
    assert.equal(
      readFileSync(join(worktree, 'CLAUDE.local.md'), 'utf8').includes(PRIVATE_MARKER),
      true,
    );
  } finally {
    fixture.cleanup();
  }
});

test('hook install refuses to overwrite a foreign hook or a managed core.hooksPath', () => {
  const fixture = makeFixture();
  try {
    const hookPath = join(fixture.primary, '.git', 'hooks', 'post-checkout');
    writeFileSync(hookPath, '#!/bin/bash\necho other-manager\n', { mode: 0o755 });
    const refused = cli(fixture.primary, ['hook', 'install', '--host', 'claude'], PACKAGED_CLI);
    assert.equal(refused.status, 3);
    assert.match(refused.stderr, /never overwritten/);
    assert.match(refused.stderr, /Manual composition/);
    assert.equal(readFileSync(hookPath, 'utf8'), '#!/bin/bash\necho other-manager\n');
    rmSync(hookPath);

    const managed = join(fixture.root, 'managed-hooks');
    mkdirSync(managed, { recursive: true });
    git(fixture.primary, ['config', 'core.hooksPath', managed]);
    const blocked = cli(fixture.primary, ['hook', 'install', '--host', 'claude'], PACKAGED_CLI);
    assert.equal(blocked.status, 3);
    assert.match(blocked.stderr, /core\.hooksPath/);
    assert.equal(existsSync(join(fixture.primary, '.git', 'hooks', 'post-checkout')), false);
  } finally {
    fixture.cleanup();
  }
});

test('the installed hook wrapper is Bash 3.2 compatible, bounded and never backgrounds work', () => {
  const fixture = makeFixture();
  try {
    seedPrivateCorpus(fixture.primary);
    cli(fixture.primary, ['hook', 'install', '--host', 'claude'], PACKAGED_CLI);
    const hookPath = join(fixture.primary, '.git', 'hooks', 'post-checkout');
    const body = readFileSync(hookPath, 'utf8');

    const syntax = spawnSync('/bin/bash', ['--posix', '-n'], { input: body, encoding: 'utf8' });
    assert.equal(syntax.status, 0, syntax.stderr);
    for (const bashFourPlus of ['declare -A', 'readlink -f', 'mapfile', '${!', '&>', ';;&']) {
      assert.equal(body.includes(bashFourPlus), false, `hook must not use ${bashFourPlus}`);
    }
    for (const unbounded of ['curl', 'wget', 'npm ', 'yarn ', 'brew', 'nohup', 'disown']) {
      assert.equal(body.includes(unbounded), false, `hook must not contain ${unbounded}`);
    }
    for (const line of body.split('\n')) {
      assert.equal(/&\s*$/.test(line), false, `hook must not background work: ${line}`);
    }
    assert.equal(body.includes('unset GIT_DIR'), true);

    // A file-checkout invocation (flag 0) must be a fast no-op.
    const worktree = join(fixture.root, 'wt');
    addWorktree(fixture.primary, worktree, 'feature');
    rmSync(join(worktree, '.rn-agent', 'actions'));
    rmSync(join(worktree, 'CLAUDE.local.md'));
    const started = process.hrtime.bigint();
    const noop = spawnSync('/bin/bash', [hookPath, 'HEAD', 'HEAD', '0'], {
      cwd: worktree,
      encoding: 'utf8',
      timeout: 20_000,
    });
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.equal(noop.status, 0, noop.stderr);
    assert.equal(noop.stdout, '');
    assert.ok(elapsedMs < 5_000, `file-checkout hook must stay cheap (took ${elapsedMs}ms)`);
    assert.equal(existsSync(join(worktree, '.rn-agent', 'actions')), false);
    assert.equal(existsSync(join(worktree, 'CLAUDE.local.md')), false);
  } finally {
    fixture.cleanup();
  }
});

test('the hook helper copy lives under the common Git directory, not a plugin cache', () => {
  const fixture = makeFixture();
  try {
    cli(fixture.primary, ['hook', 'install', '--host', 'claude'], PACKAGED_CLI);
    const stateDir = join(fixture.primary, '.git', 'rn-dev-agent');
    assert.equal(existsSync(join(stateDir, 'worktree-inheritance.js')), true);
    const config = JSON.parse(readFileSync(join(stateDir, 'worktree-inheritance.json'), 'utf8'));
    assert.equal(config.version, 1);
    assert.equal(config.appRelative, '.');
    const body = readFileSync(join(fixture.primary, '.git', 'hooks', 'post-checkout'), 'utf8');
    assert.equal(body.includes('plugins/cache'), false);
    assert.equal(body.includes(fixture.primary), false);
  } finally {
    fixture.cleanup();
  }
});

test('discovery and apply succeed even when every private body is unreadable', () => {
  if (process.getuid?.() === 0) return;
  const fixture = makeFixture();
  try {
    seedPrivateCorpus(fixture.primary);
    const corpusFile = join(fixture.primary, '.rn-agent', 'actions', 'canonical-synthetic.yaml');
    const localFile = join(fixture.primary, 'CLAUDE.local.md');
    chmodSync(corpusFile, 0o000);
    chmodSync(localFile, 0o000);
    const worktree = join(fixture.root, 'wt');
    addWorktree(fixture.primary, worktree, 'feature');
    try {
      const plan = planInheritance({ cwd: worktree, host: 'claude' });
      assert.deepEqual(
        plan.resources.map((entry) => entry.state),
        ['DEST_MISSING', 'DEST_MISSING'],
      );
      const report = applyInheritance({ cwd: worktree, host: 'claude' });
      assert.equal(report.applied, 2, 'planning and linking must never depend on reading a body');
      const result = cli(worktree, ['plan', '--json']);
      assert.equal(result.status, 0, result.stderr);
    } finally {
      chmodSync(corpusFile, 0o600);
      chmodSync(localFile, 0o600);
    }
  } finally {
    fixture.cleanup();
  }
});

test('the private corpus is never copied into the worktree', () => {
  const fixture = makeFixture();
  try {
    seedPrivateCorpus(fixture.primary);
    const worktree = join(fixture.root, 'wt');
    addWorktree(fixture.primary, worktree, 'feature');
    applyInheritance({ cwd: worktree, host: 'claude' });

    const corpusLink = join(worktree, '.rn-agent', 'actions');
    const localLink = join(worktree, 'CLAUDE.local.md');
    assert.equal(lstatSync(corpusLink).isSymbolicLink(), true);
    assert.equal(lstatSync(localLink).isSymbolicLink(), true);
    assert.equal(
      lstatSync(join(fixture.primary, '.rn-agent', 'actions'), { bigint: true }).ino,
      lstatSync(realpathSync(corpusLink), { bigint: true }).ino,
    );
    assert.equal(
      resolve(dirname(localLink), readlinkSync(localLink)),
      join(fixture.primary, 'CLAUDE.local.md'),
    );
  } finally {
    fixture.cleanup();
  }
});
