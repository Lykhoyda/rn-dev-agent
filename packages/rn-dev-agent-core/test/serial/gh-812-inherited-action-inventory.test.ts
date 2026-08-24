import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { fixtureYaml } from '../helpers/tmp-project.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CORE_ROOT = join(HERE, '..', '..');
const INHERIT_CLI = join(CORE_ROOT, 'dist', 'worktree-inheritance.js');
const LEARNED_CLI = join(CORE_ROOT, 'dist', 'learned-actions.js');
const HANG_CEILING_MS = 30_000;

function git(cwd: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
}

function nodeCli(
  entry: string,
  args: string[],
  cwd: string,
): {
  durationMs: number;
  status: number | null;
  stderr: string;
  stdout: string;
} {
  const started = performance.now();
  const result = spawnSync(process.execPath, [entry, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: HANG_CEILING_MS,
  });
  if (result.error) throw result.error;
  return {
    durationMs: performance.now() - started,
    status: result.status,
    stderr: result.stderr ?? '',
    stdout: result.stdout ?? '',
  };
}

function inventory(root: string) {
  return nodeCli(
    LEARNED_CLI,
    [
      '--json',
      '--section',
      'b',
      '--workspace-root',
      root,
      '--memory-cwd',
      root,
      '--filter',
      'login-en',
      '--max',
      '5',
    ],
    root,
  );
}

function actionIds(stdout: string): string[] {
  const body = JSON.parse(stdout) as {
    sections: { flows: { items: Array<{ id: string }> } };
  };
  return body.sections.flows.items.map((item) => item.id);
}

test('24-action 32-worktree canonical and inherited inventory stay within the serial user-path bound', (t) => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'rn-812-serial-'));
  const primary = join(fixtureRoot, 'primary');
  const linked = join(fixtureRoot, 'linked');
  try {
    mkdirSync(primary);
    git(fixtureRoot, ['init', '-q', primary]);
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
    mkdirSync(join(primary, '.rn-agent', 'actions'), { recursive: true });
    mkdirSync(join(primary, '.rn-agent', 'state'), { recursive: true });
    writeFileSync(
      join(primary, '.rn-agent', 'actions', 'login-en.yaml'),
      fixtureYaml({ id: 'login-en' }),
    );
    for (let index = 1; index < 24; index += 1) {
      const id = `action-${String(index).padStart(2, '0')}`;
      writeFileSync(join(primary, '.rn-agent', 'actions', `${id}.yaml`), fixtureYaml({ id }));
    }
    git(primary, ['worktree', 'add', '-q', linked, '-b', 'linked']);
    for (let index = 0; index < 30; index += 1) {
      git(primary, [
        'worktree',
        'add',
        '-q',
        join(fixtureRoot, `extra-${index}`),
        '-b',
        `extra-${index}`,
      ]);
    }

    mkdirSync(join(linked, '.rn-agent'), { recursive: true });
    symlinkSync(join(primary, '.rn-agent', 'actions'), join(linked, '.rn-agent', 'actions'), 'dir');

    const planned = nodeCli(
      INHERIT_CLI,
      ['plan', '--host', 'claude', '--app-root', linked, '--json'],
      linked,
    );
    assert.equal(planned.status, 0, `${planned.stderr}\n${planned.stdout}`);
    const plan = JSON.parse(planned.stdout) as {
      resources: Array<{ state: string }>;
    };
    assert.equal(plan.resources[0]?.state, 'LINK_VALID_SAFE');

    const canonical = inventory(primary);
    assert.equal(canonical.status, 0, canonical.stderr);
    assert.equal(canonical.stderr, '');
    assert.deepEqual(actionIds(canonical.stdout), ['login-en']);

    const inherited = inventory(linked);
    assert.equal(inherited.status, 0, inherited.stderr);
    assert.equal(inherited.stderr, '');
    assert.deepEqual(actionIds(inherited.stdout), ['login-en']);
    assert.ok(inherited.durationMs < 8_000, `inherited inventory took ${inherited.durationMs}ms`);
    t.diagnostic(
      [
        `inventory result: plan=${plan.resources[0]?.state}`,
        `canonicalIds=${actionIds(canonical.stdout).join(',')}`,
        `inheritedIds=${actionIds(inherited.stdout).join(',')}`,
        `canonical=${canonical.durationMs.toFixed(1)}ms`,
        `inherited=${inherited.durationMs.toFixed(1)}ms`,
      ].join(' '),
    );
  } finally {
    rmSync(fixtureRoot, { force: true, recursive: true });
    assert.equal(existsSync(fixtureRoot), false);
  }
});
