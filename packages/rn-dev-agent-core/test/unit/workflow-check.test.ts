import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'workflow-check.js');

const ONBOARDED_CLAUDE_MD = [
  '# Project',
  '',
  '## React Native Development (rn-dev-agent)',
  'body',
  '<!-- rn-dev-agent:template-end -->',
  '',
].join('\n');
const INTEGRATED_PACKAGE_JSON = {
  name: 'app',
  scripts: { ios: 'node .rn-agent/integration/rn-session-adapter.cjs ios' },
};

interface ProjectSpec {
  packageJson?: Record<string, unknown> | null;
  packageJsonRaw?: string;
  lockfile?: string;
  lockfiles?: string[];
  nodeModules?: boolean;
  claudeMd?: string | null;
  metroConfig?: string | null;
  recordings?: string[];
  integrationFiles?: string[];
  gitRoot?: boolean;
}

function makeProject(spec: ProjectSpec): string {
  const root = mkdtempSync(join(tmpdir(), 'workflow-check-'));
  if (spec.gitRoot ?? true) mkdirSync(join(root, '.git'));
  if (spec.packageJson !== null) {
    writeFileSync(
      join(root, 'package.json'),
      spec.packageJsonRaw ?? JSON.stringify(spec.packageJson ?? { name: 'app' }),
    );
  }
  if (spec.lockfile) writeFileSync(join(root, spec.lockfile), '');
  for (const lockfile of spec.lockfiles ?? []) writeFileSync(join(root, lockfile), '');
  if (spec.nodeModules ?? true) {
    mkdirSync(join(root, 'node_modules', 'react'), { recursive: true });
  }
  if (spec.claudeMd !== null) {
    writeFileSync(join(root, 'CLAUDE.md'), spec.claudeMd ?? ONBOARDED_CLAUDE_MD);
  }
  if (spec.metroConfig !== null) {
    writeFileSync(join(root, 'metro.config.js'), spec.metroConfig ?? 'module.exports = {};\n');
  }
  for (const integrationFile of spec.integrationFiles ?? []) {
    mkdirSync(join(root, '.rn-agent', 'integration'), { recursive: true });
    writeFileSync(join(root, '.rn-agent', 'integration', integrationFile), '{}');
  }
  for (const recording of spec.recordings ?? []) {
    mkdirSync(join(root, '.rn-agent', 'recordings'), { recursive: true });
    writeFileSync(join(root, '.rn-agent', 'recordings', recording), '{}');
  }
  return root;
}

function run(args: string[], env: Record<string, string | undefined> = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  let body: Record<string, unknown> | null = null;
  try {
    body = JSON.parse(result.stdout) as Record<string, unknown>;
  } catch {
    body = null;
  }
  return { result, body };
}

function stopCode(body: Record<string, unknown> | null): string | null {
  const stop = body?.stop as { code?: string } | null | undefined;
  return stop?.code ?? null;
}

function facts(body: Record<string, unknown> | null): Record<string, unknown> {
  return (body?.facts ?? {}) as Record<string, unknown>;
}

function statusEnvelope(
  state: string,
  metroBound: boolean,
  runnerBound: boolean,
  recorderBound: boolean,
): Record<string, unknown> {
  return {
    ok: true,
    data: {
      authority: {
        state,
        runtime: { metroBound },
        automation: { runnerBound, recorderBound },
      },
    },
  };
}

test('preflight passes a declared pnpm project and reports the frozen-lockfile install', () => {
  const root = makeProject({
    packageJson: { name: 'app', packageManager: 'pnpm@11.5.2' },
    lockfile: 'pnpm-lock.yaml',
  });
  const { result, body } = run(['preflight', '--project', root]);
  assert.equal(result.status, 0);
  assert.equal(body?.verdict, 'pass');
  assert.equal(facts(body).packageManager, 'pnpm');
  assert.equal(facts(body).packageManagerSource, 'packageManager-field');
  assert.equal(facts(body).installCommand, 'corepack pnpm install --frozen-lockfile');
  rmSync(root, { recursive: true, force: true });
});

test('preflight infers yarn from the lockfile and never proposes pnpm for it', () => {
  const root = makeProject({ lockfile: 'yarn.lock' });
  const { result, body } = run(['preflight', '--project', root]);
  assert.equal(result.status, 0);
  assert.equal(facts(body).packageManager, 'yarn');
  assert.equal(facts(body).packageManagerSource, 'lockfile');
  assert.equal(facts(body).installCommand, 'corepack yarn install --immutable');
  assert.ok(!result.stdout.includes('pnpm'));
  rmSync(root, { recursive: true, force: true });
});

test('preflight stops on a packageManager field that contradicts the lockfile', () => {
  const root = makeProject({
    packageJson: { name: 'app', packageManager: 'yarn@4.17.0' },
    lockfile: 'pnpm-lock.yaml',
  });
  const { result, body } = run(['preflight', '--project', root]);
  assert.equal(result.status, 3);
  assert.equal(stopCode(body), 'PACKAGE_MANAGER_CONFLICT');
  assert.equal(facts(body).installCommand, null);
  rmSync(root, { recursive: true, force: true });
});

test('preflight stops when lockfiles infer multiple package managers', () => {
  const root = makeProject({ lockfiles: ['pnpm-lock.yaml', 'yarn.lock'] });
  const { result, body } = run(['preflight', '--project', root]);
  assert.equal(result.status, 3);
  assert.equal(stopCode(body), 'PACKAGE_MANAGER_CONFLICT');
  const stop = body?.stop as { action: string };
  assert.match(stop.action, /pnpm-lock\.yaml/);
  assert.match(stop.action, /yarn\.lock/);
  rmSync(root, { recursive: true, force: true });
});

test('preflight accepts multiple lockfiles for the same package manager', () => {
  const root = makeProject({ lockfiles: ['bun.lock', 'bun.lockb'] });
  const { result, body } = run(['preflight', '--project', root]);
  assert.equal(result.status, 0);
  assert.equal(facts(body).packageManager, 'bun');
  rmSync(root, { recursive: true, force: true });
});

test('preflight rejects malformed package.json before lockfile inference', () => {
  const root = makeProject({ packageJsonRaw: '{', lockfile: 'yarn.lock' });
  const { result, body } = run(['preflight', '--project', root]);
  assert.equal(result.status, 3);
  assert.equal(stopCode(body), 'PROJECT_MANIFEST_INVALID');
  assert.equal(facts(body).packageManager, null);
  assert.equal(facts(body).packageManagerSource, null);
  rmSync(root, { recursive: true, force: true });
});

test('preflight rejects an unsupported packageManager before lockfile inference', () => {
  const root = makeProject({
    packageJson: { name: 'app', packageManager: 'volta@2.0.2' },
    lockfile: 'yarn.lock',
  });
  const { result, body } = run(['preflight', '--project', root]);
  assert.equal(result.status, 3);
  assert.equal(stopCode(body), 'PACKAGE_MANAGER_UNSUPPORTED');
  assert.equal(facts(body).packageManager, null);
  assert.equal(facts(body).packageManagerSource, null);
  rmSync(root, { recursive: true, force: true });
});

test('preflight stops when neither packageManager field nor lockfile exists', () => {
  const root = makeProject({});
  const { result, body } = run(['preflight', '--project', root]);
  assert.equal(result.status, 3);
  assert.equal(stopCode(body), 'PACKAGE_MANAGER_UNDECLARED');
  rmSync(root, { recursive: true, force: true });
});

test('preflight stops with the declared install command when node_modules is missing', () => {
  const root = makeProject({
    packageJson: { name: 'app', packageManager: 'pnpm@11.5.2' },
    lockfile: 'pnpm-lock.yaml',
    nodeModules: false,
  });
  const { result, body } = run(['preflight', '--project', root]);
  assert.equal(result.status, 3);
  assert.equal(stopCode(body), 'DEPENDENCIES_MISSING');
  const stop = body?.stop as { action: string };
  assert.ok(stop.action.includes('corepack pnpm install --frozen-lockfile'));
  rmSync(root, { recursive: true, force: true });
});

test('preflight reports an absent CLAUDE.md block without owning onboarding policy', () => {
  const root = makeProject({ lockfile: 'yarn.lock', claudeMd: '# Project\n' });
  const { result, body } = run(['preflight', '--project', root]);
  assert.equal(result.status, 0);
  assert.equal(stopCode(body), null);
  assert.equal(facts(body).claudeMdBlock, 'absent');
  rmSync(root, { recursive: true, force: true });
});

test('preflight stops when package.json is missing entirely', () => {
  const root = makeProject({ packageJson: null, claudeMd: null, nodeModules: false });
  const { result, body } = run(['preflight', '--project', root]);
  assert.equal(result.status, 3);
  assert.equal(stopCode(body), 'PROJECT_MANIFEST_MISSING');
  rmSync(root, { recursive: true, force: true });
});

test('state root kind follows XDG_STATE_HOME and platform defaults', () => {
  const root = makeProject({ lockfile: 'yarn.lock' });
  const xdg = mkdtempSync(join(tmpdir(), 'workflow-xdg-'));
  const withXdg = run(['preflight', '--project', root], { XDG_STATE_HOME: xdg });
  const stateRoot = facts(withXdg.body).stateRoot as { exists: boolean; kind: string };
  assert.equal(stateRoot.exists, false);
  assert.equal(stateRoot.kind, 'xdg');
  mkdirSync(join(xdg, 'rn-dev-agent'), { recursive: true });
  const populated = run(['preflight', '--project', root], { XDG_STATE_HOME: xdg });
  assert.equal((facts(populated.body).stateRoot as { exists: boolean }).exists, true);
  const withoutXdg = run(['preflight', '--project', root], { XDG_STATE_HOME: undefined });
  const defaultRoot = facts(withoutXdg.body).stateRoot as { kind: string };
  assert.equal(defaultRoot.kind, process.platform === 'darwin' ? 'darwin' : 'home');
  rmSync(root, { recursive: true, force: true });
  rmSync(xdg, { recursive: true, force: true });
});

test('output never leaks absolute project or home paths', () => {
  const root = makeProject({
    packageJson: { name: 'app', packageManager: 'pnpm@11.5.2' },
    lockfile: 'pnpm-lock.yaml',
    nodeModules: false,
  });
  const { result } = run(['preflight', '--project', root]);
  assert.ok(!result.stdout.includes(root));
  assert.ok(!result.stdout.includes(homedir()));
  rmSync(root, { recursive: true, force: true });
});

test('postflight stops while package.json still carries the session integration', () => {
  const root = makeProject({ packageJson: INTEGRATED_PACKAGE_JSON });
  const { result, body } = run(['postflight', '--project', root]);
  assert.equal(result.status, 3);
  assert.equal(stopCode(body), 'INTEGRATION_NOT_RESTORED');
  rmSync(root, { recursive: true, force: true });
});

test('postflight stops on Metro sentinels without package-script residue', () => {
  const root = makeProject({
    metroConfig:
      '// rn-dev-agent session integration: begin\nmodule.exports = {};\n// rn-dev-agent session integration: end\n',
  });
  const { result, body } = run(['postflight', '--project', root]);
  assert.equal(result.status, 3);
  assert.equal(stopCode(body), 'INTEGRATION_NOT_RESTORED');
  rmSync(root, { recursive: true, force: true });
});

test('postflight stops on generated integration files without manifest references', () => {
  const root = makeProject({ integrationFiles: ['rn-session-adapter.cjs'] });
  const { result, body } = run(['postflight', '--project', root]);
  assert.equal(result.status, 3);
  assert.equal(stopCode(body), 'INTEGRATION_NOT_RESTORED');
  rmSync(root, { recursive: true, force: true });
});

test('postflight passes a clean project and reports recording residue as a fact', () => {
  const root = makeProject({ recordings: ['walk.json'] });
  const { result, body } = run(['postflight', '--project', root]);
  assert.equal(result.status, 0);
  assert.equal(body?.verdict, 'pass-unproven');
  assert.equal(facts(body).recordingResidue, true);
  rmSync(root, { recursive: true, force: true });
});

test('postflight surfaces outstanding authority from a provided status projection in reverse-cleanup order', () => {
  const root = makeProject({ packageJson: INTEGRATED_PACKAGE_JSON });
  const statusFile = join(root, 'status.json');
  writeFileSync(statusFile, JSON.stringify(statusEnvelope('running', true, true, true)));
  const runnerFirst = run(['postflight', '--project', root, '--status-file', statusFile]);
  assert.equal(stopCode(runnerFirst.body), 'RUNNER_STILL_BOUND');

  writeFileSync(statusFile, JSON.stringify(statusEnvelope('running', true, false, false)));
  const metroNext = run(['postflight', '--project', root, '--status-file', statusFile]);
  assert.equal(stopCode(metroNext.body), 'METRO_STILL_BOUND');

  writeFileSync(statusFile, JSON.stringify(statusEnvelope('closing', false, false, true)));
  const recorderLast = run(['postflight', '--project', root, '--status-file', statusFile]);
  assert.equal(stopCode(recorderLast.body), 'RECORDER_CLAIM_OUTSTANDING');

  writeFileSync(statusFile, JSON.stringify(statusEnvelope('closing', false, false, false)));
  const integrationLast = run(['postflight', '--project', root, '--status-file', statusFile]);
  assert.equal(stopCode(integrationLast.body), 'INTEGRATION_NOT_RESTORED');
  rmSync(root, { recursive: true, force: true });
});

test('postflight stops when the provided status is not the canonical public envelope', () => {
  const root = makeProject({ packageJson: INTEGRATED_PACKAGE_JSON });
  const statusFile = join(root, 'status.json');
  writeFileSync(statusFile, JSON.stringify({ state: 'closing', runtime: {}, automation: {} }));
  const { result, body } = run(['postflight', '--project', root, '--status-file', statusFile]);
  assert.equal(result.status, 3);
  assert.equal(stopCode(body), 'SESSION_STATUS_INVALID');
  rmSync(root, { recursive: true, force: true });
});

test('preflight rejects a packageManager value without an exact corepack version', () => {
  for (const value of ['pnpm', 'pnpm@latest', 'yarn@^4.0.0']) {
    const root = makeProject({
      packageJson: { name: 'app', packageManager: value },
      lockfile: 'pnpm-lock.yaml',
    });
    const { result, body } = run(['preflight', '--project', root]);
    assert.equal(result.status, 3, value);
    assert.equal(stopCode(body), 'PACKAGE_MANAGER_UNSUPPORTED', value);
    rmSync(root, { recursive: true, force: true });
  }
});

test('yarn install command follows the declared major generation', () => {
  const classic = makeProject({
    packageJson: { name: 'app', packageManager: 'yarn@1.22.22' },
    lockfile: 'yarn.lock',
  });
  const classicRun = run(['preflight', '--project', classic]);
  assert.equal(classicRun.result.status, 0);
  assert.equal(facts(classicRun.body).installCommand, 'corepack yarn install --frozen-lockfile');
  assert.equal(facts(classicRun.body).lockfile, 'yarn.lock');
  rmSync(classic, { recursive: true, force: true });

  const berry = makeProject({
    packageJson: { name: 'app', packageManager: 'yarn@4.17.0' },
    lockfile: 'yarn.lock',
  });
  const berryRun = run(['preflight', '--project', berry]);
  assert.equal(berryRun.result.status, 0);
  assert.equal(facts(berryRun.body).installCommand, 'corepack yarn install --immutable');
  rmSync(berry, { recursive: true, force: true });
});

test('inferred yarn classic lockfile content selects the frozen-lockfile command', () => {
  const root = makeProject({});
  writeFileSync(join(root, 'yarn.lock'), '# yarn lockfile v1\n');
  const { result, body } = run(['preflight', '--project', root]);
  assert.equal(result.status, 0);
  assert.equal(facts(body).installCommand, 'corepack yarn install --frozen-lockfile');
  rmSync(root, { recursive: true, force: true });
});

test('yarn plug-n-play installation counts as dependency readiness', () => {
  const root = makeProject({
    packageJson: { name: 'app', packageManager: 'yarn@4.17.0' },
    lockfile: 'yarn.lock',
    nodeModules: false,
  });
  writeFileSync(join(root, '.pnp.cjs'), 'module.exports = {};\n');
  const { result, body } = run(['preflight', '--project', root]);
  assert.equal(result.status, 0);
  assert.equal(facts(body).yarnPnpPresent, true);
  assert.equal(facts(body).dependenciesReady, true);
  rmSync(root, { recursive: true, force: true });
});

test('a declared manager without its lockfile stops before recommending a frozen install', () => {
  const root = makeProject({ packageJson: { name: 'app', packageManager: 'pnpm@11.5.2' } });
  const { result, body } = run(['preflight', '--project', root]);
  assert.equal(result.status, 3);
  assert.equal(stopCode(body), 'LOCKFILE_MISSING');
  const stop = body?.stop as { action: string };
  assert.match(stop.action, /pnpm-lock\.yaml/);
  rmSync(root, { recursive: true, force: true });
});

function makeMonorepo(options: { nestedLockfile?: boolean; rootNodeModules?: boolean }): {
  repoRoot: string;
  appRoot: string;
} {
  const repoRoot = mkdtempSync(join(tmpdir(), 'workflow-check-monorepo-'));
  mkdirSync(join(repoRoot, '.git'));
  writeFileSync(
    join(repoRoot, 'package.json'),
    JSON.stringify({ name: 'root', private: true, packageManager: 'pnpm@11.5.2' }),
  );
  writeFileSync(join(repoRoot, 'pnpm-lock.yaml'), '');
  if (options.rootNodeModules ?? true) {
    mkdirSync(join(repoRoot, 'node_modules', 'react'), { recursive: true });
  }
  const appRoot = join(repoRoot, 'apps', 'mobile');
  mkdirSync(appRoot, { recursive: true });
  writeFileSync(join(appRoot, 'package.json'), JSON.stringify({ name: 'mobile' }));
  writeFileSync(join(appRoot, 'CLAUDE.md'), ONBOARDED_CLAUDE_MD);
  if (options.nestedLockfile) {
    writeFileSync(join(appRoot, 'yarn.lock'), '# yarn lockfile v1\n');
    mkdirSync(join(appRoot, 'node_modules', 'react'), { recursive: true });
  }
  return { repoRoot, appRoot };
}

test('preflight resolves the hoisted monorepo workspace root from the app directory', () => {
  const { repoRoot, appRoot } = makeMonorepo({});
  const { result, body } = run(['preflight', '--project', appRoot]);
  assert.equal(result.status, 0);
  assert.equal(body?.verdict, 'pass');
  assert.equal(facts(body).packageManager, 'pnpm');
  assert.equal(facts(body).packageManagerSource, 'packageManager-field');
  assert.equal(facts(body).lockfile, 'pnpm-lock.yaml');
  assert.equal(facts(body).installCommand, 'corepack pnpm install --frozen-lockfile');
  assert.equal(facts(body).dependenciesReady, true);
  assert.equal(facts(body).workspaceRoot, '../..');
  assert.equal(facts(body).workspaceRootDepth, 2);
  assert.equal(facts(body).claudeMdBlock, 'present');
  assert.ok(!result.stdout.includes(repoRoot));
  rmSync(repoRoot, { recursive: true, force: true });
});

test('preflight reports the hoisted workspace install command when the root has no node_modules', () => {
  const { repoRoot, appRoot } = makeMonorepo({ rootNodeModules: false });
  const { result, body } = run(['preflight', '--project', appRoot]);
  assert.equal(result.status, 3);
  assert.equal(stopCode(body), 'DEPENDENCIES_MISSING');
  const stop = body?.stop as { action: string };
  assert.ok(stop.action.includes('corepack pnpm install --frozen-lockfile'));
  rmSync(repoRoot, { recursive: true, force: true });
});

test('a lockfile beside the app wins over the monorepo workspace root', () => {
  const { repoRoot, appRoot } = makeMonorepo({ nestedLockfile: true });
  const { result, body } = run(['preflight', '--project', appRoot]);
  assert.equal(result.status, 0);
  assert.equal(facts(body).packageManager, 'yarn');
  assert.equal(facts(body).packageManagerSource, 'lockfile');
  assert.equal(facts(body).installCommand, 'corepack yarn install --frozen-lockfile');
  assert.equal(facts(body).workspaceRoot, '.');
  assert.equal(facts(body).workspaceRootDepth, 0);
  rmSync(repoRoot, { recursive: true, force: true });
});

test('the workspace walk never escapes the git repository root', () => {
  const outer = mkdtempSync(join(tmpdir(), 'workflow-check-outer-'));
  writeFileSync(
    join(outer, 'package.json'),
    JSON.stringify({ name: 'outer', packageManager: 'npm@10.9.2' }),
  );
  writeFileSync(join(outer, 'package-lock.json'), '');
  const repoRoot = join(outer, 'repo');
  mkdirSync(join(repoRoot, '.git'), { recursive: true });
  writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ name: 'app' }));
  const { result, body } = run(['preflight', '--project', repoRoot]);
  assert.equal(result.status, 3);
  assert.equal(stopCode(body), 'PACKAGE_MANAGER_UNDECLARED');
  assert.equal(facts(body).workspaceRoot, '.');
  rmSync(outer, { recursive: true, force: true });
});

test('postflight without a status file passes as unproven cleanup', () => {
  const root = makeProject({});
  const { result, body } = run(['postflight', '--project', root]);
  assert.equal(result.status, 0);
  assert.equal(body?.verdict, 'pass-unproven');
  assert.equal(facts(body).cleanupProven, false);
  const session = facts(body).session as { provided: boolean };
  assert.equal(session.provided, false);
  rmSync(root, { recursive: true, force: true });
});

test('postflight proves cleanup only from a status envelope with every binding clear', () => {
  const root = makeProject({});
  const statusFile = join(root, 'status.json');
  writeFileSync(statusFile, JSON.stringify(statusEnvelope('released', false, false, false)));
  const { result, body } = run(['postflight', '--project', root, '--status-file', statusFile]);
  assert.equal(result.status, 0);
  assert.equal(body?.verdict, 'pass');
  assert.equal(facts(body).cleanupProven, true);
  rmSync(root, { recursive: true, force: true });
});

test('invalid arguments exit 2 without a verdict', () => {
  const { result } = run(['sideways']);
  assert.equal(result.status, 2);
});
