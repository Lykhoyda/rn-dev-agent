import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'learned-actions.js');

function inventory(cwd: string): {
  count: number;
  roots: string[];
  items: Array<{ path: string }>;
} {
  const result = spawnSync(process.execPath, [CLI, '--section', 'b', '--json'], {
    cwd,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `inventory exited non-zero: ${result.stderr}`);
  return JSON.parse(result.stdout).sections.flows;
}

/** Boundary-safe containment — a `<root>-decoy` sibling must never satisfy this. */
function containedIn(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
}

function assertLocalOnly(
  flows: { roots: string[]; items: Array<{ path: string }> },
  worktree: string,
) {
  for (const entry of [...flows.roots, ...flows.items.map((item) => item.path)]) {
    assert.equal(containedIn(worktree, entry), true, `entry escaped the worktree: ${entry}`);
  }
}

function action(dir: string, id: string): void {
  writeFileSync(
    join(dir, `${id}.yaml`),
    `appId: com.synthetic.app\n---\n# id: ${id}\n- launchApp\n`,
  );
}

/** Primary holds the canonical private corpus; the worktree inherits it via a symlink. */
function makeInheritedLayout(appRelative: string): { root: string; worktree: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'rn-inventory-')));
  const primaryApp = join(root, 'primary', appRelative);
  mkdirSync(join(primaryApp, '.rn-agent', 'actions'), { recursive: true });
  action(join(primaryApp, '.rn-agent', 'actions'), 'canonical-one');
  action(join(primaryApp, '.rn-agent', 'actions'), 'canonical-two');

  const worktreeApp = join(root, 'wt', appRelative);
  mkdirSync(join(worktreeApp, '.rn-agent'), { recursive: true });
  symlinkSync(
    join(primaryApp, '.rn-agent', 'actions'),
    join(worktreeApp, '.rn-agent', 'actions'),
    'dir',
  );
  return { root, worktree: join(root, 'wt') };
}

test('repo-root cwd reports the inherited corpus once, by its worktree-local spelling', () => {
  const { root, worktree } = makeInheritedLayout('test-app');
  try {
    const flows = inventory(worktree);
    assert.equal(flows.count, 2, 'inherited actions must not be double-counted');

    const privateSource = join(root, 'primary');
    for (const entry of [...flows.roots, ...flows.items.map((item) => item.path)]) {
      assert.equal(
        entry.includes(privateSource),
        false,
        `canonical private source path leaked: ${entry}`,
      );
    }
    assertLocalOnly(flows, worktree);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('app-root cwd and repo-root cwd agree on the inherited corpus', () => {
  const { root, worktree } = makeInheritedLayout('test-app');
  try {
    const fromRoot = inventory(worktree);
    const fromApp = inventory(join(worktree, 'test-app'));
    assert.equal(fromRoot.count, fromApp.count);
    assert.deepEqual(
      fromRoot.items.map((item) => item.path.replace(worktree, '')).sort(),
      fromApp.items.map((item) => item.path.replace(worktree, '')).sort(),
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('a chained source symlink still reports only the local spelling', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'rn-inventory-chain-')));
  try {
    const store = join(root, 'out-of-repo-store', 'actions');
    mkdirSync(store, { recursive: true });
    action(store, 'canonical-chained');
    const primaryApp = join(root, 'primary', 'test-app', '.rn-agent');
    mkdirSync(primaryApp, { recursive: true });
    symlinkSync(store, join(primaryApp, 'actions'), 'dir');

    const worktreeApp = join(root, 'wt', 'test-app', '.rn-agent');
    mkdirSync(worktreeApp, { recursive: true });
    symlinkSync(join(primaryApp, 'actions'), join(worktreeApp, 'actions'), 'dir');

    const flows = inventory(join(root, 'wt'));
    assert.equal(flows.count, 1);
    for (const entry of [...flows.roots, ...flows.items.map((item) => item.path)]) {
      assert.equal(
        entry.includes(join(root, 'out-of-repo-store')),
        false,
        `store path leaked: ${entry}`,
      );
      assert.equal(entry.includes(join(root, 'primary')), false, `private source leaked: ${entry}`);
    }
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('a decoy corpus beside the worktree is never inventoried as the canonical one', () => {
  const { root, worktree } = makeInheritedLayout('test-app');
  try {
    const decoy = join(root, 'wt-decoy', 'test-app', '.rn-agent', 'actions');
    mkdirSync(decoy, { recursive: true });
    action(decoy, 'DECOY-MUST-NOT-APPEAR');

    const flows = inventory(worktree);
    const canonical = flows.items.filter((item) => containedIn(worktree, item.path));
    assert.deepEqual(
      canonical.map((item) => item.flow).sort(),
      ['canonical-one', 'canonical-two'],
      'only the inherited corpus may be reported as worktree-local, counted once',
    );
    const decoyEntries = flows.items.filter((item) => item.path.includes('wt-decoy'));
    for (const entry of decoyEntries) {
      assert.equal(
        containedIn(worktree, entry.path),
        false,
        `decoy claimed a local path: ${entry.path}`,
      );
    }
    assert.equal(
      flows.roots.filter((entry) => containedIn(worktree, entry)).length >= 1,
      true,
      'the worktree-local root must still be searched',
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('a root-level app (no nesting) reports its own corpus once', () => {
  const { root, worktree } = makeInheritedLayout('.');
  try {
    const flows = inventory(worktree);
    assert.equal(flows.count, 2);
    for (const entry of [...flows.roots, ...flows.items.map((item) => item.path)]) {
      assert.equal(entry.includes(join(root, 'primary')), false, `private source leaked: ${entry}`);
    }
    assertLocalOnly(flows, worktree);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
