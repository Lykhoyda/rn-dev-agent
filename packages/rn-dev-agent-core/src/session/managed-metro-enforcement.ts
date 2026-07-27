import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';

const DARWIN_SANDBOX_EXECUTABLE = '/usr/bin/sandbox-exec';
const DARWIN_CODESIGN_EXECUTABLE = '/usr/bin/codesign';

interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

interface FileMetadata {
  isFile(): boolean;
  uid: number;
  mode: number;
}

interface ManagedMetroEnforcementDependencies {
  exists?: (path: string) => boolean;
  canonicalize?: (path: string) => string;
  stat?: (path: string) => FileMetadata;
  readBytes?: (path: string) => Buffer;
  run?: (command: string, args: readonly string[]) => CommandResult;
}

export interface ManagedMetroEnforcementInput {
  platform: NodeJS.Platform;
  appRoot: string;
  sourceRoot: string;
  runtimeRoot: string;
  nodeExecutable: string;
  commandExecutable: string;
  port: number;
  instanceId: string;
  runtimeInputs: readonly string[];
}

export interface ManagedMetroEnforcementReceipt {
  version: 1;
  kind: 'darwin-seatbelt-v1';
  profileSha256: string;
  sandboxExecutableSha256: string;
  sandboxExecutableCdHash: string;
  processCreationDenied: true;
  unmanifestedReadDenied: true;
  unmanifestedWriteDenied: true;
  symlinkEscapeDenied: true;
  unallocatedListenerDenied: true;
  allocatedListenerAllowed: true;
  networkOutboundDenied: true;
}

export interface ManagedMetroEnforcementPlan {
  status: 'enforced';
  kind: 'darwin-seatbelt-v1';
  sandboxExecutable: '/usr/bin/sandbox-exec';
  sandboxExecutableSha256: string;
  sandboxExecutableCdHash: string;
  profile: string;
  profileSha256: string;
  canaryPath: string;
  symlinkCanaryPath: string;
  port: number;
  unallocatedPort: number;
  nodeExecutable: string;
}

export type ManagedMetroEnforcement =
  | ManagedMetroEnforcementPlan
  | {
      status: 'unsupported';
      reason:
        | 'host-enforcement-unavailable'
        | 'sandbox-executable-unverified'
        | 'sandbox-preflight-failed';
    };

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function defaultRun(command: string, args: readonly string[]): CommandResult {
  const result = spawnSync(command, [...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 5_000,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? result.error?.message ?? '',
  };
}

function field(details: string, name: string): string | null {
  const prefix = `${name}=`;
  return (
    details
      .split('\n')
      .find((line) => line.startsWith(prefix))
      ?.slice(prefix.length)
      .trim() ?? null
  );
}

function verifiedSandboxExecutable(dependencies: ManagedMetroEnforcementDependencies): {
  path: '/usr/bin/sandbox-exec';
  sha256: string;
  cdHash: string;
} | null {
  const exists = dependencies.exists ?? existsSync;
  const canonicalize = dependencies.canonicalize ?? realpathSync;
  const stat = dependencies.stat ?? statSync;
  const readBytes = dependencies.readBytes ?? readFileSync;
  const run = dependencies.run ?? defaultRun;
  try {
    if (!exists(DARWIN_SANDBOX_EXECUTABLE)) return null;
    if (canonicalize(DARWIN_SANDBOX_EXECUTABLE) !== DARWIN_SANDBOX_EXECUTABLE) return null;
    const metadata = stat(DARWIN_SANDBOX_EXECUTABLE);
    if (!metadata.isFile() || metadata.uid !== 0 || (metadata.mode & 0o022) !== 0) return null;
    const verification = run(DARWIN_CODESIGN_EXECUTABLE, [
      '--verify',
      '--strict',
      DARWIN_SANDBOX_EXECUTABLE,
    ]);
    if (verification.status !== 0) return null;
    const details = run(DARWIN_CODESIGN_EXECUTABLE, [
      '-dv',
      '--verbose=4',
      DARWIN_SANDBOX_EXECUTABLE,
    ]);
    const authorities = details.stderr.split('\n').filter((line) => line.startsWith('Authority='));
    const cdHash = field(details.stderr, 'CDHash');
    if (
      details.status !== 0 ||
      field(details.stderr, 'Identifier') !== 'com.apple.sandbox-exec' ||
      !/^\d+$/.test(field(details.stderr, 'Platform identifier') ?? '') ||
      !/^[a-f0-9]{40,64}$/.test(cdHash ?? '') ||
      !authorities.includes('Authority=Software Signing') ||
      !authorities.includes('Authority=Apple Code Signing Certification Authority') ||
      !authorities.includes('Authority=Apple Root CA')
    ) {
      return null;
    }
    return {
      path: DARWIN_SANDBOX_EXECUTABLE,
      sha256: sha256(readBytes(DARWIN_SANDBOX_EXECUTABLE)),
      cdHash: cdHash!,
    };
  } catch {
    return null;
  }
}

function sandboxString(value: string): string {
  if (value.includes('\0')) throw new Error('METRO_RUNTIME_ENFORCEMENT_PATH_INVALID');
  return JSON.stringify(value);
}

function canonicalPath(path: string, canonicalize: (path: string) => string): string {
  try {
    return canonicalize(path);
  } catch {
    return resolve(path);
  }
}

function pathFilters(paths: readonly string[]): string {
  return paths
    .flatMap((path) => [
      `    (literal ${sandboxString(path)})`,
      `    (subpath ${sandboxString(path)})`,
    ])
    .join('\n');
}

function managedMetroSandboxProfile(input: {
  readRoots: readonly string[];
  writeRoots: readonly string[];
  executablePaths: readonly string[];
  executableMapDenyRoots: readonly string[];
  port: number;
}): string {
  const readRoots = [...new Set(input.readRoots)].sort();
  const writeRoots = [...new Set(input.writeRoots)].sort();
  const executablePaths = [...new Set(input.executablePaths)].sort();
  const executableMapDenyRoots = [...new Set(input.executableMapDenyRoots)].sort();
  const pathAncestors = [...new Set([...readRoots, ...writeRoots])].sort();
  return `(version 1)
(deny default)
(import "system.sb")
(deny process-fork)
(deny network-outbound)
(deny file-map-executable
${pathFilters(executableMapDenyRoots)})
(allow process-exec
${executablePaths.map((path) => `    (literal ${sandboxString(path)})`).join('\n')})
(allow file-read* file-test-existence
${pathFilters(readRoots)})
(allow file-read-metadata file-test-existence
${pathAncestors.map((path) => `    (path-ancestors ${sandboxString(path)})`).join('\n')})
(allow file-write* file-test-existence
${pathFilters(writeRoots)})
(allow network-bind
    (local tcp ${sandboxString(`*:${input.port}`)}))
(allow network-inbound
    (local tcp ${sandboxString(`*:${input.port}`)}))
`;
}

export function prepareManagedMetroEnforcement(
  input: ManagedMetroEnforcementInput,
  dependencies: ManagedMetroEnforcementDependencies = {},
): ManagedMetroEnforcement {
  if (input.platform !== 'darwin') {
    return { status: 'unsupported', reason: 'host-enforcement-unavailable' };
  }
  const sandbox = verifiedSandboxExecutable(dependencies);
  if (!sandbox) {
    return { status: 'unsupported', reason: 'sandbox-executable-unverified' };
  }
  const canonicalize = dependencies.canonicalize ?? realpathSync;
  const sourceRoot = canonicalPath(input.sourceRoot, canonicalize);
  const appRoot = canonicalPath(input.appRoot, canonicalize);
  const runtimeRoot = canonicalPath(input.runtimeRoot, canonicalize);
  const nodeExecutable = canonicalPath(input.nodeExecutable, canonicalize);
  const commandExecutable = canonicalPath(input.commandExecutable, canonicalize);
  const runtimeInputs = input.runtimeInputs.map((path) => canonicalPath(path, canonicalize));
  const expoStateRoot = resolve(appRoot, '.expo');
  const readRoots = [
    sourceRoot,
    appRoot,
    runtimeRoot,
    dirname(dirname(nodeExecutable)),
    nodeExecutable,
    commandExecutable,
    ...runtimeInputs,
  ];
  const executablePaths = [
    nodeExecutable,
    commandExecutable,
    '/usr/bin/env',
    '/bin/sh',
    '/bin/bash',
  ];
  const profile = managedMetroSandboxProfile({
    readRoots,
    writeRoots: [runtimeRoot, expoStateRoot],
    executablePaths,
    executableMapDenyRoots: [sourceRoot, appRoot, ...runtimeInputs],
    port: input.port,
  });
  const canaryId = sha256(`${input.instanceId}\0${input.port}`).slice(0, 32);
  return {
    status: 'enforced',
    kind: 'darwin-seatbelt-v1',
    sandboxExecutable: sandbox.path,
    sandboxExecutableSha256: sandbox.sha256,
    sandboxExecutableCdHash: sandbox.cdHash,
    profile,
    profileSha256: sha256(profile),
    canaryPath: `/private/tmp/rn-dev-agent-metro-${canaryId}.canary`,
    symlinkCanaryPath: resolve(runtimeRoot, `enforcement-${canaryId}.canary`),
    port: input.port,
    unallocatedPort: 0,
    nodeExecutable,
  };
}

const PREFLIGHT_SOURCE = String.raw`
const { spawnSync } = require('node:child_process');
const { readFileSync, writeFileSync } = require('node:fs');
const { createConnection, createServer } = require('node:net');
const input = JSON.parse(process.argv[1]);
const denied = (run) => {
  try {
    run();
    return false;
  } catch (error) {
    return error && (error.code === 'EPERM' || error.code === 'EACCES');
  }
};
const processResult = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
const processCreationDenied =
  processResult.status === null &&
  processResult.error &&
  (processResult.error.code === 'EPERM' || processResult.error.code === 'EACCES');
const unmanifestedReadDenied = denied(() => readFileSync(input.canaryPath));
const unmanifestedWriteDenied = denied(() => writeFileSync(input.canaryPath, 'forged'));
const symlinkEscapeDenied = denied(() => readFileSync(input.symlinkCanaryPath));
const listen = (port) =>
  new Promise((resolve) => {
    const server = createServer();
    server.once('error', (error) => resolve({ ok: false, code: error.code }));
    server.listen(port, '127.0.0.1', () =>
      server.close((error) => resolve({ ok: !error, code: error && error.code })),
    );
  });
(async () => {
  const allocated = await listen(input.port);
  const unallocated = await listen(input.unallocatedPort);
  const networkOutboundDenied = await new Promise((resolve) => {
    const connection = createConnection(input.port, '127.0.0.1');
    connection.once('connect', () => {
      connection.destroy();
      resolve(false);
    });
    connection.once('error', (error) =>
      resolve(error.code === 'EPERM' || error.code === 'EACCES'),
    );
  });
  const receipt = {
    processCreationDenied: Boolean(processCreationDenied),
    unmanifestedReadDenied,
    unmanifestedWriteDenied,
    symlinkEscapeDenied,
    unallocatedListenerDenied:
      !unallocated.ok && (unallocated.code === 'EPERM' || unallocated.code === 'EACCES'),
    allocatedListenerAllowed: allocated.ok,
    networkOutboundDenied,
  };
  process.stdout.write(JSON.stringify(receipt));
  process.exit(Object.values(receipt).every(Boolean) ? 0 : 1);
})().catch(() => process.exit(1));
`;

interface ManagedMetroPreflightDependencies {
  writeCanary?: (path: string) => void;
  removeCanary?: (path: string) => void;
  run?: (command: string, args: readonly string[]) => CommandResult;
}

export function runManagedMetroEnforcementPreflight(
  plan: ManagedMetroEnforcementPlan,
  dependencies: ManagedMetroPreflightDependencies = {},
): ManagedMetroEnforcementReceipt {
  const writeCanary =
    dependencies.writeCanary ??
    ((path: string) => {
      const descriptor = openSync(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      try {
        writeSync(descriptor, 'rn-dev-agent sandbox canary');
      } finally {
        closeSync(descriptor);
      }
    });
  const removeCanary =
    dependencies.removeCanary ?? ((path: string) => rmSync(path, { force: true }));
  const run = dependencies.run ?? defaultRun;
  let canaryCreated = false;
  let symlinkCreated = false;
  try {
    writeCanary(plan.canaryPath);
    canaryCreated = true;
    mkdirSync(dirname(plan.symlinkCanaryPath), { recursive: true });
    rmSync(plan.symlinkCanaryPath, { force: true });
    symlinkSync(plan.canaryPath, plan.symlinkCanaryPath);
    symlinkCreated = true;
    const result = run(plan.sandboxExecutable, [
      '-p',
      plan.profile,
      plan.nodeExecutable,
      '-e',
      PREFLIGHT_SOURCE,
      JSON.stringify({
        canaryPath: plan.canaryPath,
        symlinkCanaryPath: plan.symlinkCanaryPath,
        port: plan.port,
        unallocatedPort: plan.unallocatedPort,
      }),
    ]);
    if (result.status !== 0) {
      throw new Error('METRO_RUNTIME_ENFORCEMENT_UNAVAILABLE: sandbox preflight failed');
    }
    const observed = JSON.parse(result.stdout) as Record<string, unknown>;
    if (
      observed.processCreationDenied !== true ||
      observed.unmanifestedReadDenied !== true ||
      observed.unmanifestedWriteDenied !== true ||
      observed.symlinkEscapeDenied !== true ||
      observed.unallocatedListenerDenied !== true ||
      observed.allocatedListenerAllowed !== true ||
      observed.networkOutboundDenied !== true
    ) {
      throw new Error('METRO_RUNTIME_ENFORCEMENT_UNAVAILABLE: sandbox preflight is incomplete');
    }
    return {
      version: 1,
      kind: plan.kind,
      profileSha256: plan.profileSha256,
      sandboxExecutableSha256: plan.sandboxExecutableSha256,
      sandboxExecutableCdHash: plan.sandboxExecutableCdHash,
      processCreationDenied: true,
      unmanifestedReadDenied: true,
      unmanifestedWriteDenied: true,
      symlinkEscapeDenied: true,
      unallocatedListenerDenied: true,
      allocatedListenerAllowed: true,
      networkOutboundDenied: true,
    };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('METRO_RUNTIME_ENFORCEMENT_')) {
      throw error;
    }
    throw new Error('METRO_RUNTIME_ENFORCEMENT_UNAVAILABLE: sandbox preflight is invalid', {
      cause: error,
    });
  } finally {
    if (symlinkCreated) rmSync(plan.symlinkCanaryPath, { force: true });
    if (canaryCreated) removeCanary(plan.canaryPath);
  }
}

export function verifyManagedMetroEnforcementReceipt(
  input: ManagedMetroEnforcementInput,
  receipt: unknown,
): receipt is ManagedMetroEnforcementReceipt {
  if (!receipt || typeof receipt !== 'object') return false;
  const observed = receipt as Partial<ManagedMetroEnforcementReceipt>;
  const plan = prepareManagedMetroEnforcement(input);
  return (
    plan.status === 'enforced' &&
    observed.version === 1 &&
    observed.kind === plan.kind &&
    observed.profileSha256 === plan.profileSha256 &&
    observed.sandboxExecutableSha256 === plan.sandboxExecutableSha256 &&
    observed.sandboxExecutableCdHash === plan.sandboxExecutableCdHash &&
    observed.processCreationDenied === true &&
    observed.unmanifestedReadDenied === true &&
    observed.unmanifestedWriteDenied === true &&
    observed.symlinkEscapeDenied === true &&
    observed.unallocatedListenerDenied === true &&
    observed.allocatedListenerAllowed === true &&
    observed.networkOutboundDenied === true
  );
}
