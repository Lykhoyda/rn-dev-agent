import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createObserveRootResolver,
  ObserveRootUnavailableError,
  type ObserveRootDeps,
} from '../../../dist/observability/observe-project-root.js';
import {
  collectMatchingRnProjects,
  findProjectRoot,
  isRnProject,
  readProjectBundleId,
} from '../../../dist/nav-graph/storage.js';
import { listActions } from '../../../dist/domain/action-inventory.js';

function makeDeps(over: Partial<ObserveRootDeps> = {}): ObserveRootDeps {
  return {
    sessionAppRoot: () => null,
    sessionAppId: () => null,
    explicitEnvRoot: () => null,
    heuristicRoot: () => null,
    matchingRoots: () => [],
    isProject: () => false,
    projectBundleId: () => null,
    ...over,
  };
}

function makeRnApp(root: string, bundleId?: string, actionIds: string[] = []): void {
  mkdirSync(join(root, '.rn-agent', 'actions'), { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'app', dependencies: { 'react-native': '0.83.0' } }),
  );
  if (bundleId) {
    writeFileSync(
      join(root, 'app.json'),
      JSON.stringify({ expo: { ios: { bundleIdentifier: bundleId } } }),
    );
  }
  for (const id of actionIds) {
    writeFileSync(
      join(root, '.rn-agent', 'actions', `${id}.yaml`),
      `# id: ${id}\n# intent: Do ${id}\n# status: active\n- launchApp\n`,
    );
  }
}

function scratch(name: string): string {
  const root = join(
    tmpdir(),
    `observe-root-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(root, { recursive: true });
  return root;
}

test('bound session app root wins over heuristic discovery', async () => {
  const root = scratch('session-wins');
  try {
    const workspaceApp = join(root, 'workspace', 'test-app');
    const foreignApp = join(root, 'pool', 'other-app');
    makeRnApp(workspaceApp, 'com.workspace.testapp', ['login']);
    makeRnApp(foreignApp, 'com.other.app', ['foreign-flow']);
    const resolve = createObserveRootResolver(
      makeDeps({
        sessionAppRoot: () => workspaceApp,
        heuristicRoot: () => foreignApp,
        isProject: isRnProject,
        projectBundleId: readProjectBundleId,
      }),
    );
    const resolved = resolve();
    assert.ok(resolved.ok);
    assert.equal(resolved.root, workspaceApp);
    assert.equal(resolved.origin, 'session');
    const actions = await listActions(resolved.root);
    assert.deepEqual(
      actions.map((a) => a.id),
      ['login'],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('worktree checkout with a bound session loads the workspace app without scanning', () => {
  const root = scratch('worktree');
  try {
    const workspaceApp = join(root, 'workspace', 'test-app');
    makeRnApp(workspaceApp, 'com.workspace.testapp', ['login']);
    // Heuristic discovery cannot reach the workspace app from the worktree cwd.
    const resolve = createObserveRootResolver(
      makeDeps({
        sessionAppRoot: () => workspaceApp,
        heuristicRoot: () => {
          throw new Error('heuristic discovery must not run when the session root is usable');
        },
        matchingRoots: () => {
          throw new Error('candidate scanning must not run when the session root is usable');
        },
        isProject: isRnProject,
      }),
    );
    const resolved = resolve();
    assert.ok(resolved.ok);
    assert.equal(resolved.root, workspaceApp);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('declared session root wins even when the legacy session appId disagrees', () => {
  const root = scratch('session-identity');
  try {
    const declaredApp = join(root, 'declared-app');
    makeRnApp(declaredApp, 'com.declared.app');
    // The declared source root is the ownership boundary the authority gate
    // fences against; the device-session appId never overrides it.
    const resolve = createObserveRootResolver(
      makeDeps({
        sessionAppRoot: () => declaredApp,
        sessionAppId: () => 'com.other.bound-app',
        isProject: isRnProject,
        projectBundleId: readProjectBundleId,
      }),
    );
    const resolved = resolve();
    assert.ok(resolved.ok);
    assert.equal(resolved.root, declaredApp);
    assert.equal(resolved.origin, 'session');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('non-project session root with no heuristic hit refuses truthfully', () => {
  const root = scratch('refuse');
  try {
    const worktree = join(root, 'pool', 'rn-dev-agent');
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, 'package.json'), JSON.stringify({ name: 'rn-dev-agent' }));
    const resolve = createObserveRootResolver(
      makeDeps({
        sessionAppRoot: () => worktree,
        isProject: isRnProject,
      }),
    );
    const resolved = resolve();
    assert.ok(!resolved.ok);
    assert.match(resolved.reason, /not a React Native project/);
    assert.match(resolved.reason, /heuristic discovery found none/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('non-project session root with a bound app refuses a foreign discoverable checkout', () => {
  const root = scratch('non-project-foreign');
  try {
    const worktree = join(root, 'pool', 'rn-dev-agent');
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, 'package.json'), JSON.stringify({ name: 'rn-dev-agent' }));
    const foreignApp = join(root, 'pool', 'other-app');
    makeRnApp(foreignApp, 'com.other.app', ['foreign-flow']);
    const resolve = createObserveRootResolver(
      makeDeps({
        sessionAppRoot: () => worktree,
        sessionAppId: () => 'com.workspace.testapp',
        heuristicRoot: () => foreignApp,
        isProject: isRnProject,
        projectBundleId: readProjectBundleId,
      }),
    );
    const resolved = resolve();
    assert.ok(!resolved.ok);
    assert.match(resolved.reason, /com\.other\.app/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('non-project session root without app authority keeps the workspace-sibling fallback', () => {
  const root = scratch('primary-compat');
  try {
    const pluginCheckout = join(root, 'rn-dev-agent');
    mkdirSync(pluginCheckout, { recursive: true });
    writeFileSync(join(pluginCheckout, 'package.json'), JSON.stringify({ name: 'rn-dev-agent' }));
    const workspaceApp = join(root, 'rn-dev-agent-workspace', 'test-app');
    makeRnApp(workspaceApp, 'com.workspace.testapp', ['login']);
    // Primary-checkout dogfooding: the supervisor session declares the plugin
    // repo as its root, and the workspace app is reached heuristically.
    const resolve = createObserveRootResolver(
      makeDeps({
        sessionAppRoot: () => pluginCheckout,
        heuristicRoot: () => workspaceApp,
        isProject: isRnProject,
        projectBundleId: readProjectBundleId,
      }),
    );
    const resolved = resolve();
    assert.ok(resolved.ok);
    assert.equal(resolved.root, workspaceApp);
    assert.equal(resolved.origin, 'heuristic');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('foreign heuristic root that declares another app refuses truthfully', () => {
  const root = scratch('foreign');
  try {
    const foreignApp = join(root, 'pool', 'other-app');
    makeRnApp(foreignApp, 'com.other.app', ['foreign-flow']);
    const resolve = createObserveRootResolver(
      makeDeps({
        sessionAppId: () => 'com.workspace.testapp',
        heuristicRoot: () => foreignApp,
        isProject: isRnProject,
        projectBundleId: readProjectBundleId,
      }),
    );
    const resolved = resolve();
    assert.ok(!resolved.ok);
    assert.match(resolved.reason, /com\.other\.app/);
    assert.match(resolved.reason, /com\.workspace\.testapp/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('multiple checkouts declaring the bound app refuse as ambiguous', () => {
  const resolve = createObserveRootResolver(
    makeDeps({
      sessionAppId: () => 'com.workspace.testapp',
      heuristicRoot: () => '/checkouts/a',
      matchingRoots: () => ['/checkouts/a', '/checkouts/b'],
      projectBundleId: () => 'com.workspace.testapp',
    }),
  );
  const resolved = resolve();
  assert.ok(!resolved.ok);
  assert.match(resolved.reason, /multiple checkouts/);
  assert.match(resolved.reason, /RN_PROJECT_ROOT/);
});

test('valid RN_PROJECT_ROOT stays an explicit override without identity checks', () => {
  const root = scratch('env-valid');
  try {
    const envApp = join(root, 'env-app');
    makeRnApp(envApp, 'com.env.app');
    const resolve = createObserveRootResolver(
      makeDeps({
        sessionAppId: () => 'com.workspace.testapp',
        explicitEnvRoot: () => envApp,
        heuristicRoot: () => {
          throw new Error('heuristic discovery must not run when RN_PROJECT_ROOT is valid');
        },
        isProject: isRnProject,
      }),
    );
    const resolved = resolve();
    assert.ok(resolved.ok);
    assert.equal(resolved.root, envApp);
    assert.equal(resolved.origin, 'env');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('invalid RN_PROJECT_ROOT refuses instead of falling back to another checkout', () => {
  const root = scratch('env-invalid');
  try {
    const foreignApp = join(root, 'other-app');
    makeRnApp(foreignApp, 'com.other.app');
    const resolve = createObserveRootResolver(
      makeDeps({
        explicitEnvRoot: () => join(root, 'missing-dir'),
        heuristicRoot: () => foreignApp,
        isProject: isRnProject,
      }),
    );
    const resolved = resolve();
    assert.ok(!resolved.ok);
    assert.match(resolved.reason, /RN_PROJECT_ROOT is not a React Native project/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('without a bound session the heuristic path is preserved', () => {
  const root = scratch('heuristic');
  try {
    const app = join(root, 'app');
    makeRnApp(app, 'com.primary.app');
    const resolve = createObserveRootResolver(
      makeDeps({
        heuristicRoot: () => app,
        isProject: isRnProject,
        projectBundleId: readProjectBundleId,
      }),
    );
    const resolved = resolve();
    assert.ok(resolved.ok);
    assert.equal(resolved.root, app);
    assert.equal(resolved.origin, 'heuristic');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolution is last-writer-wins: a later session bind changes the result', () => {
  const root = scratch('last-writer');
  try {
    const first = join(root, 'first-app');
    const second = join(root, 'second-app');
    makeRnApp(first);
    makeRnApp(second);
    let boundRoot = first;
    const resolve = createObserveRootResolver(
      makeDeps({
        sessionAppRoot: () => boundRoot,
        isProject: isRnProject,
      }),
    );
    const before = resolve();
    assert.ok(before.ok);
    assert.equal(before.root, first);
    boundRoot = second;
    const after = resolve();
    assert.ok(after.ok);
    assert.equal(after.root, second);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ObserveRootUnavailableError carries a stable code and the reason', () => {
  const error = new ObserveRootUnavailableError('no root anywhere');
  assert.equal(error.code, 'PROJECT_ROOT_UNAVAILABLE');
  assert.equal(error.name, 'ObserveRootUnavailableError');
  assert.equal(error.message, 'no root anywhere');
});

test('collectMatchingRnProjects reports every checkout declaring the bundle id', () => {
  const root = scratch('collect');
  const previousCwd = process.cwd();
  const previousUserCwd = process.env.CLAUDE_USER_CWD;
  const previousEnvRoot = process.env.RN_PROJECT_ROOT;
  try {
    delete process.env.RN_PROJECT_ROOT;
    const worktree = join(root, 'pool', 'rn-dev-agent');
    mkdirSync(worktree, { recursive: true });
    makeRnApp(join(root, 'pool', 'checkout-a'), 'com.dup.app');
    makeRnApp(join(root, 'pool', 'checkout-b'), 'com.dup.app');
    makeRnApp(join(root, 'pool', 'unrelated'), 'com.unrelated.app');
    delete process.env.CLAUDE_USER_CWD;
    process.chdir(worktree);
    const matches = collectMatchingRnProjects('com.dup.app');
    assert.equal(matches.length, 2);
    assert.ok(matches.every((m) => m.includes('checkout-')));
    assert.equal(findProjectRoot({ bundleId: 'com.unrelated.app' })?.endsWith('unrelated'), true);
  } finally {
    process.chdir(previousCwd);
    if (previousUserCwd === undefined) delete process.env.CLAUDE_USER_CWD;
    else process.env.CLAUDE_USER_CWD = previousUserCwd;
    if (previousEnvRoot === undefined) delete process.env.RN_PROJECT_ROOT;
    else process.env.RN_PROJECT_ROOT = previousEnvRoot;
    rmSync(root, { recursive: true, force: true });
  }
});
