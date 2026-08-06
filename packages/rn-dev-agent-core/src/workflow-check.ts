#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { inspectPackageIntegrationFileState } from './session/package-integration.js';
import { getStateDir } from './util/secure-state-file.js';

type PackageManagerName = 'pnpm' | 'yarn' | 'npm' | 'bun';
type PackageManagerDeclaration =
  | { kind: 'absent' }
  | { kind: 'declared'; manager: PackageManagerName }
  | { kind: 'invalid-manifest' }
  | { kind: 'unsupported' };

interface Stop {
  code: string;
  action: string;
}

interface PreflightFacts {
  packageManager: PackageManagerName | null;
  packageManagerSource: 'packageManager-field' | 'lockfile' | null;
  lockfile: string | null;
  installCommand: string | null;
  nodeModulesPresent: boolean;
  claudeMdBlock: 'present' | 'absent';
  claudeMdSentinel: boolean;
  stateRoot: { resolved: boolean; kind: 'xdg' | 'darwin' | 'home' };
}

interface PostflightFacts {
  integrationMarkersPresent: boolean;
  recordingResidue: boolean;
  stateRoot: { resolved: boolean; kind: 'xdg' | 'darwin' | 'home' };
  session: {
    provided: boolean;
    state: string | null;
    metroBound: boolean | null;
    runnerBound: boolean | null;
    recorderClaim: boolean | null;
  };
}

const LOCKFILES: Array<{ file: string; manager: PackageManagerName }> = [
  { file: 'pnpm-lock.yaml', manager: 'pnpm' },
  { file: 'yarn.lock', manager: 'yarn' },
  { file: 'package-lock.json', manager: 'npm' },
  { file: 'bun.lock', manager: 'bun' },
  { file: 'bun.lockb', manager: 'bun' },
];

const INSTALL_COMMANDS: Record<PackageManagerName, string> = {
  pnpm: 'corepack pnpm install --frozen-lockfile',
  yarn: 'corepack yarn install --immutable',
  npm: 'npm ci',
  bun: 'bun install --frozen-lockfile',
};

const TEMPLATE_HEADING = '## React Native Development (rn-dev-agent)';
const TEMPLATE_SENTINEL = '<!-- rn-dev-agent:template-end -->';
function fail(code: number, message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function readTextIfFile(filePath: string): string | null {
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile()) return null;
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function stateRootFacts(): { resolved: boolean; kind: 'xdg' | 'darwin' | 'home' } {
  const kind = process.env.XDG_STATE_HOME
    ? 'xdg'
    : process.platform === 'darwin'
      ? 'darwin'
      : 'home';
  return { resolved: getStateDir().length > 0, kind };
}

function isPackageManagerName(value: string): value is PackageManagerName {
  return value === 'pnpm' || value === 'yarn' || value === 'npm' || value === 'bun';
}

function detectPackageManagerField(raw: string): PackageManagerDeclaration {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'invalid-manifest' };
  }
  if (!isRecord(parsed)) return { kind: 'invalid-manifest' };
  if (!Object.hasOwn(parsed, 'packageManager')) return { kind: 'absent' };
  const field = parsed.packageManager;
  if (typeof field !== 'string') return { kind: 'unsupported' };
  const separator = field.indexOf('@');
  const name = separator === -1 ? field : field.slice(0, separator);
  const version = separator === -1 ? null : field.slice(separator + 1);
  if (
    !isPackageManagerName(name) ||
    (version !== null && (version.length === 0 || /[@\s]/.test(version)))
  ) {
    return { kind: 'unsupported' };
  }
  return { kind: 'declared', manager: name };
}

function detectLockfiles(
  projectRoot: string,
): Array<{ file: string; manager: PackageManagerName }> {
  return LOCKFILES.filter((candidate) => fs.existsSync(path.join(projectRoot, candidate.file)));
}

function nodeModulesPresent(projectRoot: string): boolean {
  try {
    const entries = fs.readdirSync(path.join(projectRoot, 'node_modules'));
    return entries.some((entry) => !entry.startsWith('.'));
  } catch {
    return false;
  }
}

function preflight(projectRoot: string): { facts: PreflightFacts; stop: Stop | null } {
  const packageJson = readTextIfFile(path.join(projectRoot, 'package.json'));
  if (packageJson === null) {
    return {
      facts: emptyPreflight(),
      stop: {
        code: 'PROJECT_MANIFEST_MISSING',
        action: 'Run workflow-check from the app root that contains package.json.',
      },
    };
  }

  const declaration = detectPackageManagerField(packageJson);
  const field = declaration.kind === 'declared' ? declaration.manager : null;
  const locks = detectLockfiles(projectRoot);
  const lockManagers = new Set(locks.map((lock) => lock.manager));
  const inferredLock = declaration.kind === 'absent' && lockManagers.size === 1 ? locks[0] : null;
  const claudeMd = readTextIfFile(path.join(projectRoot, 'CLAUDE.md'));
  const claudeMdBlock =
    claudeMd !== null && claudeMd.includes(TEMPLATE_HEADING) ? 'present' : 'absent';

  const facts: PreflightFacts = {
    packageManager: field ?? inferredLock?.manager ?? null,
    packageManagerSource: field ? 'packageManager-field' : inferredLock ? 'lockfile' : null,
    lockfile: inferredLock?.file ?? null,
    installCommand: null,
    nodeModulesPresent: nodeModulesPresent(projectRoot),
    claudeMdBlock,
    claudeMdSentinel: claudeMd !== null && claudeMd.includes(TEMPLATE_SENTINEL),
    stateRoot: stateRootFacts(),
  };

  if (declaration.kind === 'invalid-manifest') {
    return {
      facts,
      stop: {
        code: 'PROJECT_MANIFEST_INVALID',
        action: 'package.json is not valid JSON; repair it before package-manager inference.',
      },
    };
  }
  if (declaration.kind === 'unsupported') {
    return {
      facts,
      stop: {
        code: 'PACKAGE_MANAGER_UNSUPPORTED',
        action:
          'package.json has an unsupported or unparseable "packageManager" value; use pnpm, yarn, npm, or bun before installing.',
      },
    };
  }
  const conflictingLocks = field === null ? [] : locks.filter((lock) => lock.manager !== field);
  if (conflictingLocks.length > 0) {
    return {
      facts,
      stop: {
        code: 'PACKAGE_MANAGER_CONFLICT',
        action: `package.json declares ${field} but ${conflictingLocks.map((lock) => lock.file).join(', ')} ${conflictingLocks.length === 1 ? 'is' : 'are'} present; align the project before installing — do not guess.`,
      },
    };
  }
  if (field === null && lockManagers.size > 1) {
    return {
      facts,
      stop: {
        code: 'PACKAGE_MANAGER_CONFLICT',
        action: `Multiple package managers are inferred from ${locks.map((lock) => lock.file).join(', ')}; declare packageManager or remove stale lockfiles before installing — do not guess.`,
      },
    };
  }
  if (facts.packageManager === null) {
    return {
      facts,
      stop: {
        code: 'PACKAGE_MANAGER_UNDECLARED',
        action:
          'Declare "packageManager" in package.json (or commit a lockfile) so the install command is unambiguous.',
      },
    };
  }
  facts.installCommand = INSTALL_COMMANDS[facts.packageManager];

  if (!facts.nodeModulesPresent) {
    return {
      facts,
      stop: {
        code: 'DEPENDENCIES_MISSING',
        action: `Install dependencies with the declared manager: ${facts.installCommand}`,
      },
    };
  }
  return { facts, stop: null };
}

function emptyPreflight(): PreflightFacts {
  return {
    packageManager: null,
    packageManagerSource: null,
    lockfile: null,
    installCommand: null,
    nodeModulesPresent: false,
    claudeMdBlock: 'absent',
    claudeMdSentinel: false,
    stateRoot: stateRootFacts(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readSessionStatus(statusFile: string | null): {
  session: PostflightFacts['session'];
  stop: Stop | null;
} {
  const absent: PostflightFacts['session'] = {
    provided: false,
    state: null,
    metroBound: null,
    runnerBound: null,
    recorderClaim: null,
  };
  if (statusFile === null) return { session: absent, stop: null };
  const raw = readTextIfFile(statusFile);
  if (raw === null) fail(2, 'workflow-check: --status-file is missing or unreadable');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return fail(2, 'workflow-check: --status-file is not valid JSON');
  }
  const data = isRecord(parsed) && isRecord(parsed.data) ? parsed.data : null;
  const authority = data && isRecord(data.authority) ? data.authority : null;
  const runtime = authority && isRecord(authority.runtime) ? authority.runtime : null;
  const automation = authority && isRecord(authority.automation) ? authority.automation : null;
  const isCanonical =
    isRecord(parsed) &&
    parsed.ok === true &&
    authority !== null &&
    typeof authority.state === 'string' &&
    runtime !== null &&
    typeof runtime.metroBound === 'boolean' &&
    automation !== null &&
    typeof automation.runnerBound === 'boolean' &&
    typeof automation.recorderBound === 'boolean';
  if (!isCanonical) {
    return {
      session: {
        provided: true,
        state: authority && typeof authority.state === 'string' ? authority.state : null,
        metroBound: null,
        runnerBound: null,
        recorderClaim: null,
      },
      stop: {
        code: 'SESSION_STATUS_INVALID',
        action:
          'Provide the complete redacted rn_session status envelope with data.authority.runtime and data.authority.automation bindings; cleanup cannot be proven from an unknown shape.',
      },
    };
  }
  return {
    session: {
      provided: true,
      state: authority.state as string,
      metroBound: runtime.metroBound as boolean,
      runnerBound: automation.runnerBound as boolean,
      recorderClaim: automation.recorderBound as boolean,
    },
    stop: null,
  };
}

function postflight(
  projectRoot: string,
  statusFile: string | null,
): { facts: PostflightFacts; stop: Stop | null } {
  let integrationMarkersPresent = true;
  try {
    integrationMarkersPresent =
      inspectPackageIntegrationFileState(projectRoot).verdict !== 'unintegrated';
  } catch {
    integrationMarkersPresent = true;
  }
  const recordingsDir = path.join(projectRoot, '.rn-agent', 'recordings');
  let recordingResidue = false;
  try {
    recordingResidue = fs.readdirSync(recordingsDir).some((entry) => entry.endsWith('.json'));
  } catch {
    recordingResidue = false;
  }

  const status = readSessionStatus(statusFile);
  const facts: PostflightFacts = {
    integrationMarkersPresent,
    recordingResidue,
    stateRoot: stateRootFacts(),
    session: status.session,
  };

  if (status.stop) return { facts, stop: status.stop };
  if (facts.session.provided && facts.session.runnerBound) {
    return {
      facts,
      stop: {
        code: 'RUNNER_STILL_BOUND',
        action:
          'Close the native runner first: device_snapshot action=close, then stop_metro, restore_integration, release.',
      },
    };
  }
  if (facts.session.provided && facts.session.metroBound) {
    return {
      facts,
      stop: {
        code: 'METRO_STILL_BOUND',
        action:
          'Managed Metro is still bound; run rn_session stop_metro before restore_integration and release.',
      },
    };
  }
  if (facts.session.provided && facts.session.recorderClaim) {
    return {
      facts,
      stop: {
        code: 'RECORDER_CLAIM_OUTSTANDING',
        action:
          'A recorder claim is still held; stop the recording through device_record so the claim is released.',
      },
    };
  }
  if (facts.integrationMarkersPresent) {
    return {
      facts,
      stop: {
        code: 'INTEGRATION_NOT_RESTORED',
        action:
          'Package integration residue remains; run rn_session restore_integration (confirmed: true) after stop_metro, then release.',
      },
    };
  }
  return { facts, stop: null };
}

function parseArgs(argv: string[]): {
  mode: string;
  projectRoot: string;
  statusFile: string | null;
} {
  const mode = argv[0];
  if (mode !== 'preflight' && mode !== 'postflight') {
    fail(2, 'workflow-check: first argument must be "preflight" or "postflight"');
  }
  let projectRoot = process.cwd();
  let statusFile: string | null = null;
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--project' && argv[i + 1]) {
      projectRoot = path.resolve(argv[i + 1]);
      i += 1;
    } else if (arg === '--status-file' && argv[i + 1]) {
      statusFile = path.resolve(argv[i + 1]);
      i += 1;
    } else {
      fail(2, `workflow-check: unknown argument ${arg}`);
    }
  }
  return { mode, projectRoot, statusFile };
}

function main(): void {
  const { mode, projectRoot, statusFile } = parseArgs(process.argv.slice(2));
  const result =
    mode === 'preflight' ? preflight(projectRoot) : postflight(projectRoot, statusFile);
  const verdict = result.stop === null ? 'pass' : 'stop';
  process.stdout.write(
    `${JSON.stringify({ mode, verdict, stop: result.stop, facts: result.facts }, null, 2)}\n`,
  );
  process.exit(verdict === 'pass' ? 0 : 3);
}

main();
