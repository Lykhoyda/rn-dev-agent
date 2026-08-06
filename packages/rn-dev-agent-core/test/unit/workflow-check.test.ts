// Hermetic tests for dist/workflow-check.js — package-manager/dependency
// detection, private-state-root kind, onboarding gate, postflight residue,
// and redaction. No device, network, or registry access.
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

interface ProjectSpec {
  packageJson?: Record<string, unknown> | null;
  lockfile?: string;
  nodeModules?: boolean;
  claudeMd?: string | null;
  recordings?: string[];
}

function makeProject(spec: ProjectSpec): string {
  const root = mkdtempSync(join(tmpdir(), 'workflow-check-'));
  if (spec.packageJson !== null) {
    writeFileSync(join(root, 'package.json'), JSON.stringify(spec.packageJson ?? { name: 'app' }));
  }
  if (spec.lockfile) writeFileSync(join(root, spec.lockfile), '');
  if (spec.nodeModules ?? true) {
    mkdirSync(join(root, 'node_modules', 'react'), { recursive: true });
  }
  if (spec.claudeMd !== null) {
    writeFileSync(join(root, 'CLAUDE.md'), spec.claudeMd ?? ONBOARDED_CLAUDE_MD);
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

test('preflight stops on a project without the injected CLAUDE.md block', () => {
  const root = makeProject({ lockfile: 'yarn.lock', claudeMd: '# Project\n' });
  const { result, body } = run(['preflight', '--project', root]);
  assert.equal(result.status, 3);
  assert.equal(stopCode(body), 'PROJECT_NOT_ONBOARDED');
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
  const stateRoot = facts(withXdg.body).stateRoot as { resolved: boolean; kind: string };
  assert.equal(stateRoot.resolved, true);
  assert.equal(stateRoot.kind, 'xdg');
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
  const root = makeProject({
    packageJson: {
      name: 'app',
      scripts: { ios: 'node .rn-agent/integration/rn-session-adapter.cjs ios' },
    },
  });
  const { result, body } = run(['postflight', '--project', root]);
  assert.equal(result.status, 3);
  assert.equal(stopCode(body), 'INTEGRATION_NOT_RESTORED');
  rmSync(root, { recursive: true, force: true });
});

test('postflight passes a clean project and reports recording residue as a fact', () => {
  const root = makeProject({ recordings: ['walk.json'] });
  const { result, body } = run(['postflight', '--project', root]);
  assert.equal(result.status, 0);
  assert.equal(body?.verdict, 'pass');
  assert.equal(facts(body).recordingResidue, true);
  rmSync(root, { recursive: true, force: true });
});

test('postflight surfaces outstanding authority from a provided status projection in reverse-cleanup order', () => {
  const root = makeProject({});
  const statusFile = join(root, 'status.json');
  writeFileSync(
    statusFile,
    JSON.stringify({
      state: 'running',
      runtime: { metro: { bound: true } },
      automation: { runner: { bound: true }, recorder: { claimed: true } },
    }),
  );
  const runnerFirst = run(['postflight', '--project', root, '--status-file', statusFile]);
  assert.equal(stopCode(runnerFirst.body), 'RUNNER_STILL_BOUND');

  writeFileSync(
    statusFile,
    JSON.stringify({ state: 'running', runtime: { metro: { bound: true } }, automation: {} }),
  );
  const metroNext = run(['postflight', '--project', root, '--status-file', statusFile]);
  assert.equal(stopCode(metroNext.body), 'METRO_STILL_BOUND');

  writeFileSync(
    statusFile,
    JSON.stringify({ state: 'closing', runtime: {}, automation: { recorder: { claimed: true } } }),
  );
  const recorderLast = run(['postflight', '--project', root, '--status-file', statusFile]);
  assert.equal(stopCode(recorderLast.body), 'RECORDER_CLAIM_OUTSTANDING');

  writeFileSync(statusFile, JSON.stringify({ state: 'closing', runtime: {}, automation: {} }));
  const clean = run(['postflight', '--project', root, '--status-file', statusFile]);
  assert.equal(clean.result.status, 0);
  rmSync(root, { recursive: true, force: true });
});

test('invalid arguments exit 2 without a verdict', () => {
  const { result } = run(['sideways']);
  assert.equal(result.status, 2);
});
