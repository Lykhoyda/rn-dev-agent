import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { canonicalAuthorityJson } from './authority-json.js';

const DARWIN_SANDBOX_EXECUTABLE = '/usr/bin/sandbox-exec';
const DARWIN_CODESIGN_EXECUTABLE = '/usr/bin/codesign';
const DARWIN_PLATFORM_SIGNING_LEAF_AUTHORITIES = [
  'Authority=Software Signing',
  'Authority=macOS Software Signing',
];

interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  signal?: string | null;
  timedOut?: boolean;
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
  lstat?: (path: string) => { isSymbolicLink(): boolean };
  readBytes?: (path: string) => Buffer;
  run?: (command: string, args: readonly string[]) => CommandResult;
  runtimeCache?: () => string | null;
  runtimeFiles?: (nodeExecutable: string) => readonly string[];
  runtimeVersion?: (nodeExecutable: string) => string;
}

export interface ManagedMetroEnforcementInput {
  platform: NodeJS.Platform;
  appRoot: string;
  sourceRoot: string;
  runtimeRoot: string;
  nodeExecutable: string;
  nodeVersion: string;
  commandExecutable: string;
  commandArguments?: readonly string[];
  commandProbeArguments?: readonly string[];
  baseNodeOptions?: string;
  commandExecutableMappings?: readonly string[];
  commandChainInputs?: readonly string[];
  protectedRuntimeRoots?: readonly string[];
  nativeAddonRoots?: readonly string[];
  cssInteropCacheRoot?: string | null;
  port: number;
  instanceId: string;
  runtimeInputs: readonly string[];
}

export interface ManagedMetroSigningIdentity {
  identifier: string;
  cdHash: string;
  authorities: string[];
}

export interface ManagedMetroRuntimeFileAttestation {
  path: string;
  sha256: string;
  signingIdentity: ManagedMetroSigningIdentity | null;
}

export interface ManagedMetroNodeRuntimeAttestation {
  version: 1;
  executable: ManagedMetroRuntimeFileAttestation;
  runtimeVersion: string;
  linkedRuntimePaths: string[];
  loadedRuntimeFiles: ManagedMetroRuntimeFileAttestation[];
  sharedRuntimeCache: ManagedMetroRuntimeFileAttestation | null;
  executableMappings: ManagedMetroRuntimeFileAttestation[];
}

export interface ManagedMetroEnforcementReceipt {
  version: 2;
  kind: 'darwin-seatbelt-v2';
  profileSha256: string;
  sandboxExecutableSha256: string;
  sandboxExecutableCdHash: string;
  commandLaunchSha256: string;
  resolvedCommandSha256: string;
  descendantCreationAllowed: true;
  unauthorizedExecutableDenied: true;
  unmanifestedReadDenied: true;
  unmanifestedWriteDenied: true;
  symlinkEscapeDenied: true;
  unallocatedListenerDenied: true;
  allocatedListenerAllowed: true;
  networkOutboundDenied: true;
  resolvedCommandAllowed: true;
  commandCleanupConfirmed: true;
  commandChainStable: true;
  nodeRuntimeAttestation: ManagedMetroNodeRuntimeAttestation;
  commandChainAttestation: ManagedMetroRuntimeFileAttestation[];
}

export interface ManagedMetroEnforcementPlan {
  status: 'enforced';
  kind: 'darwin-seatbelt-v2';
  sandboxExecutable: '/usr/bin/sandbox-exec';
  sandboxExecutableSha256: string;
  sandboxExecutableCdHash: string;
  commandLaunchSha256: string;
  resolvedCommandSha256: string;
  profile: string;
  profileSha256: string;
  canaryPath: string;
  descendantCanaryPath: string;
  symlinkCanaryPath: string;
  commandStderrPath: string;
  port: number;
  unallocatedPort: number;
  nodeExecutable: string;
  appRoot: string;
  commandExecutable: string;
  commandArguments: string[];
  baseNodeOptions: string;
  preflightEnvironmentPath: string;
  nodeRuntimeAttestation: ManagedMetroNodeRuntimeAttestation;
  commandChainAttestation: ManagedMetroRuntimeFileAttestation[];
}

export type ManagedMetroEnforcement =
  | ManagedMetroEnforcementPlan
  | {
      status: 'unsupported';
      reason:
        | 'host-enforcement-unavailable'
        | 'sandbox-executable-unverified'
        | 'node-runtime-unverified'
        | 'sandbox-preflight-failed';
    };

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function defaultRun(command: string, args: readonly string[]): CommandResult {
  const result = spawnSync(command, [...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 25_000,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? result.error?.message ?? '',
    signal: result.signal ?? null,
    timedOut: (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT',
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
      !DARWIN_PLATFORM_SIGNING_LEAF_AUTHORITIES.some((leaf) => authorities.includes(leaf)) ||
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

function signingIdentity(
  path: string,
  run: (command: string, args: readonly string[]) => CommandResult,
): ManagedMetroSigningIdentity | null {
  const verification = run(DARWIN_CODESIGN_EXECUTABLE, ['--verify', '--strict', path]);
  if (verification.status !== 0) return null;
  const details = run(DARWIN_CODESIGN_EXECUTABLE, ['-dv', '--verbose=4', path]);
  const identifier = field(details.stderr, 'Identifier');
  const cdHash = field(details.stderr, 'CDHash');
  if (details.status !== 0 || !identifier || !/^[a-f0-9]{40,64}$/.test(cdHash ?? '')) {
    return null;
  }
  return {
    identifier,
    cdHash: cdHash!,
    authorities: details.stderr
      .split('\n')
      .filter((line) => line.startsWith('Authority='))
      .map((line) => line.slice('Authority='.length))
      .sort(),
  };
}

function defaultRuntimeVersion(
  nodeExecutable: string,
  run: (command: string, args: readonly string[]) => CommandResult,
): string {
  const result = run(nodeExecutable, ['--version']);
  if (result.status !== 0) throw new Error('node version unavailable');
  return result.stdout.trim();
}

function defaultRuntimeFiles(
  nodeExecutable: string,
  run: (command: string, args: readonly string[]) => CommandResult,
): string[] {
  const result = run('/usr/bin/otool', ['-L', nodeExecutable]);
  if (result.status !== 0) throw new Error('node runtime dependencies unavailable');
  return result.stdout
    .split('\n')
    .slice(1)
    .map((line) => line.trim().split(/\s+\(/, 1)[0])
    .filter((path) => path.startsWith('/'));
}

function defaultRuntimeCache(exists: (path: string) => boolean): string | null {
  const architecture = process.arch === 'arm64' ? 'arm64e' : process.arch;
  return (
    [
      `/System/Volumes/Preboot/Cryptexes/OS/System/Library/dyld/dyld_shared_cache_${architecture}`,
      `/System/Library/dyld/dyld_shared_cache_${architecture}`,
    ].find(exists) ?? null
  );
}

function attestRuntimeFile(
  path: string,
  dependencies: ManagedMetroEnforcementDependencies,
): ManagedMetroRuntimeFileAttestation {
  const canonicalize = dependencies.canonicalize ?? realpathSync;
  const stat = dependencies.stat ?? statSync;
  const readBytes = dependencies.readBytes ?? readFileSync;
  const run = dependencies.run ?? defaultRun;
  const canonical = canonicalize(path);
  if (!stat(canonical).isFile()) throw new Error('runtime input is not a file');
  return {
    path: canonical,
    sha256: sha256(readBytes(canonical)),
    signingIdentity: signingIdentity(canonical, run),
  };
}

function attestNodeRuntime(
  input: ManagedMetroEnforcementInput,
  executableMappings: readonly string[],
  dependencies: ManagedMetroEnforcementDependencies,
): ManagedMetroNodeRuntimeAttestation | null {
  const run = dependencies.run ?? defaultRun;
  const exists = dependencies.exists ?? existsSync;
  const runtimeVersion =
    dependencies.runtimeVersion?.(input.nodeExecutable) ??
    defaultRuntimeVersion(input.nodeExecutable, run);
  if (runtimeVersion !== input.nodeVersion) return null;
  try {
    const executable = attestRuntimeFile(input.nodeExecutable, dependencies);
    const linkedRuntimePaths = [
      ...new Set(
        dependencies.runtimeFiles?.(executable.path) ?? defaultRuntimeFiles(executable.path, run),
      ),
    ].sort();
    if (linkedRuntimePaths.length === 0) return null;
    const missingRuntimePaths = linkedRuntimePaths.filter((path) => !exists(path));
    if (
      missingRuntimePaths.some(
        (path) => !path.startsWith('/System/Library/') && !path.startsWith('/usr/lib/'),
      )
    ) {
      return null;
    }
    const runtimeCachePath =
      missingRuntimePaths.length > 0
        ? (dependencies.runtimeCache?.() ?? defaultRuntimeCache(exists))
        : null;
    if (missingRuntimePaths.length > 0 && !runtimeCachePath) return null;
    const loadedRuntimeFiles = [executable.path, ...linkedRuntimePaths.filter(exists)]
      .sort()
      .map((path) => attestRuntimeFile(path, dependencies));
    const mappings = [...new Set(executableMappings)]
      .sort()
      .map((path) => attestRuntimeFile(path, dependencies));
    return {
      version: 1,
      executable,
      runtimeVersion,
      linkedRuntimePaths,
      loadedRuntimeFiles,
      sharedRuntimeCache: runtimeCachePath
        ? attestRuntimeFile(runtimeCachePath, dependencies)
        : null,
      executableMappings: mappings,
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

function ownedCssInteropCacheRoot(
  candidate: string | null | undefined,
  owner: {
    sourceRoot: string;
    appRoot: string;
    runtimeRoot: string;
    protectedRuntimeRoots: readonly string[];
  },
  canonicalize: (path: string) => string,
  lstat: (path: string) => { isSymbolicLink(): boolean },
): string | null {
  if (!candidate) return null;
  const packageRoot = dirname(candidate);
  const overlaps = (a: string, b: string) =>
    a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
  try {
    if (basename(candidate) !== '.cache') return null;
    if (basename(packageRoot) !== 'react-native-css-interop') return null;
    if (canonicalize(packageRoot) !== packageRoot) return null;
    if (![owner.sourceRoot, owner.appRoot].some((root) => packageRoot.startsWith(`${root}/`))) {
      return null;
    }
    if (
      [owner.runtimeRoot, ...owner.protectedRuntimeRoots].some((root) => overlaps(candidate, root))
    ) {
      return null;
    }
    try {
      if (lstat(candidate).isSymbolicLink()) return null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null;
    }
    return candidate;
  } catch {
    return null;
  }
}

function managedMetroSandboxProfile(input: {
  readRoots: readonly string[];
  writeRoots: readonly string[];
  executablePaths: readonly string[];
  executableMapPaths: readonly string[];
  nativeAddonRoots: readonly string[];
  protectedRuntimeRoots: readonly string[];
  port: number;
}): string {
  const readRoots = [...new Set(input.readRoots)].sort();
  const writeRoots = [...new Set(input.writeRoots)].sort();
  const executablePaths = [...new Set(input.executablePaths)].sort();
  const executableMapPaths = [...new Set(input.executableMapPaths)].sort();
  const nativeAddonRoots = [...new Set(input.nativeAddonRoots)].sort();
  const protectedRuntimeRoots = [...new Set(input.protectedRuntimeRoots)].sort();
  const pathAncestors = [...new Set([...readRoots, ...writeRoots])].sort();
  return `(version 1)
(deny default)
(import "system.sb")
(allow process-fork)
(allow signal (target children))
(deny network-outbound)
(allow file-map-executable
${executableMapPaths.map((path) => `    (literal ${sandboxString(path)})`).join('\n')})
(allow file-map-executable
${nativeAddonRoots
  .map(
    (path) => `    (require-all
      (subpath ${sandboxString(path)})
      (extension "node"))`,
  )
  .join('\n')})
(allow process-exec
${executablePaths.map((path) => `    (literal ${sandboxString(path)})`).join('\n')})
(allow file-read* file-test-existence
${pathFilters(readRoots)})
(allow file-read-metadata file-test-existence
${pathAncestors.map((path) => `    (path-ancestors ${sandboxString(path)})`).join('\n')})
(allow file-write* file-test-existence
${pathFilters(writeRoots)})
${
  protectedRuntimeRoots.length > 0
    ? `(deny file-write*
${pathFilters(protectedRuntimeRoots)})`
    : ''
}
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
  const commandArguments = [...(input.commandArguments ?? [])];
  const commandExecutableMappings = (input.commandExecutableMappings ?? []).map((path) =>
    canonicalPath(path, canonicalize),
  );
  const commandChainInputs = (input.commandChainInputs ?? []).map((path) =>
    canonicalPath(path, canonicalize),
  );
  const protectedRuntimeRoots = (input.protectedRuntimeRoots ?? []).map((path) =>
    canonicalPath(path, canonicalize),
  );
  const nativeAddonRoots = (input.nativeAddonRoots ?? [sourceRoot, appRoot]).map((path) =>
    canonicalPath(path, canonicalize),
  );
  const runtimeInputs = input.runtimeInputs.map((path) => canonicalPath(path, canonicalize));
  const expoStateRoot = resolve(appRoot, '.expo');
  const cssInteropCacheRoot = ownedCssInteropCacheRoot(
    input.cssInteropCacheRoot,
    { sourceRoot, appRoot, runtimeRoot, protectedRuntimeRoots },
    canonicalize,
    dependencies.lstat ?? lstatSync,
  );
  const readRoots = [
    '/dev/fd',
    sourceRoot,
    appRoot,
    runtimeRoot,
    nodeExecutable,
    commandExecutable,
    ...commandExecutableMappings,
    ...commandChainInputs,
    ...runtimeInputs,
  ];
  const executablePaths = [
    nodeExecutable,
    commandExecutable,
    ...commandExecutableMappings,
    '/usr/bin/env',
  ];
  const nodeRuntimeAttestation = attestNodeRuntime(
    {
      ...input,
      nodeExecutable,
      commandExecutable,
      runtimeInputs,
    },
    executablePaths,
    dependencies,
  );
  if (!nodeRuntimeAttestation) {
    return { status: 'unsupported', reason: 'node-runtime-unverified' };
  }
  let commandChainAttestation: ManagedMetroRuntimeFileAttestation[];
  try {
    commandChainAttestation = [...new Set(commandChainInputs)]
      .sort()
      .map((path) => attestRuntimeFile(path, dependencies));
  } catch {
    return { status: 'unsupported', reason: 'node-runtime-unverified' };
  }
  const profile = managedMetroSandboxProfile({
    readRoots,
    writeRoots: [runtimeRoot, expoStateRoot, ...(cssInteropCacheRoot ? [cssInteropCacheRoot] : [])],
    executablePaths,
    executableMapPaths: [
      ...nodeRuntimeAttestation.loadedRuntimeFiles.map((entry) => entry.path),
      ...nodeRuntimeAttestation.executableMappings.map((entry) => entry.path),
    ],
    nativeAddonRoots,
    protectedRuntimeRoots,
    port: input.port,
  });
  const canaryId = sha256(`${input.instanceId}\0${input.port}`).slice(0, 32);
  return {
    status: 'enforced',
    kind: 'darwin-seatbelt-v2',
    sandboxExecutable: sandbox.path,
    sandboxExecutableSha256: sandbox.sha256,
    sandboxExecutableCdHash: sandbox.cdHash,
    commandLaunchSha256: sha256(
      canonicalAuthorityJson({ executable: commandExecutable, arguments: commandArguments }),
    ),
    resolvedCommandSha256: sha256(
      canonicalAuthorityJson({
        executable: commandExecutable,
        arguments: commandArguments,
      }),
    ),
    profile,
    profileSha256: sha256(profile),
    canaryPath: `/private/tmp/rn-dev-agent-metro-${canaryId}.canary`,
    descendantCanaryPath: resolve(runtimeRoot, `descendant-${canaryId}.cjs`),
    symlinkCanaryPath: resolve(runtimeRoot, `enforcement-${canaryId}.canary`),
    commandStderrPath: resolve(runtimeRoot, `preflight-stderr-${canaryId}.log`),
    port: input.port,
    unallocatedPort: 0,
    nodeExecutable,
    appRoot,
    commandExecutable,
    commandArguments,
    baseNodeOptions: input.baseNodeOptions ?? '',
    preflightEnvironmentPath: resolve(runtimeRoot, `preflight-environment-${canaryId}.json`),
    nodeRuntimeAttestation,
    commandChainAttestation,
  };
}

const PREFLIGHT_SOURCE = String.raw`
const { spawn, spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { closeSync, constants, fstatSync, openSync, readFileSync, readSync, writeFileSync } = require('node:fs');
const { createConnection, createServer } = require('node:net');
const input = JSON.parse(process.argv[1]);
const logicalArgumentPrefix = 'rn-dev-agent-logical-path:';
const startedAt = performance.now();
const elapsed = () => Math.round(performance.now() - startedAt);
const timings = {};
let commandExit = null;
let commandStderrTail = null;
let commandStderrTruncated = false;
const diagnosticInputLimit = 65536;
const denied = (run) => {
  try {
    run();
    return false;
  } catch (error) {
    return error && (error.code === 'EPERM' || error.code === 'EACCES');
  }
};
const unauthorizedResult = spawnSync('/usr/bin/true', []);
const unauthorizedExecutableDenied =
  unauthorizedResult.status === null &&
  unauthorizedResult.error &&
  (unauthorizedResult.error.code === 'EPERM' || unauthorizedResult.error.code === 'EACCES');
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
const waitUntil = async (predicate, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
};
const processGroupExists = (pid) => {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error && error.code !== 'ESRCH';
  }
};
(async () => {
  const commandSnapshots = [];
  const boundPaths = new Map();
  const argumentPaths = new Set(
    input.commandArguments.map((argument) =>
      argument.startsWith(logicalArgumentPrefix)
        ? argument.slice(logicalArgumentPrefix.length)
        : argument,
    ),
  );
  for (const entry of input.commandChainAttestation) {
    if (!argumentPaths.has(entry.path)) continue;
    const descriptor = openSync(entry.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const size = fstatSync(descriptor).size;
    const contents = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const count = readSync(descriptor, contents, offset, size - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    closeSync(descriptor);
    const snapshot = contents.subarray(0, offset);
    if (createHash('sha256').update(snapshot).digest('hex') !== entry.sha256) {
      throw new Error('command-chain identity mismatch');
    }
    boundPaths.set(entry.path, '/dev/fd/' + (10 + commandSnapshots.length));
    commandSnapshots.push(snapshot);
  }
  const allocated = await listen(input.port);
  timings.allocatedMs = elapsed();
  if (!allocated.ok) throw new Error('allocated listener unavailable before command');
  const commandEnvironment = JSON.parse(readFileSync(input.preflightEnvironmentPath, 'utf8'));
  let stderrDescriptor;
  try {
    stderrDescriptor = openSync(input.commandStderrPath, 'w', 0o600);
  } catch {}
  const stdio = ['ignore', 'ignore', stderrDescriptor ?? 'ignore', 'ipc'];
  while (stdio.length < 9) stdio.push('ignore');
  stdio[8] = 'pipe';
  stdio.push('pipe');
  stdio.push(...commandSnapshots.map(() => 'pipe'));
  let command;
  try {
    command = spawn(
      input.commandExecutable,
      input.commandArguments.map((argument) =>
        argument.startsWith(logicalArgumentPrefix)
          ? argument.slice(logicalArgumentPrefix.length)
          : boundPaths.get(argument) ?? argument,
      ),
      {
        cwd: input.appRoot,
        detached: true,
        env: commandEnvironment,
        stdio,
      },
    );
  } finally {
    if (stderrDescriptor !== undefined) {
      try {
        closeSync(stderrDescriptor);
      } catch {}
    }
  }
  command.stdio[8].end('admitted\n');
  for (let index = 0; index < commandSnapshots.length; index += 1) {
    command.stdio[10 + index].end(commandSnapshots[index]);
  }
  command.stdio[9].resume();
  command.once('exit', (code, signal) => {
    commandExit = { code, signal, atMs: elapsed() };
  });
  command.once('error', () => {});
  timings.spawnedMs = elapsed();
  const resolvedCommandAllowed = await waitUntil(async () => {
    const probe = await listen(input.port);
    return !probe.ok && probe.code === 'EADDRINUSE';
  }, 15000);
  timings.occupancyMs = elapsed();
  let commandCleanupConfirmed = false;
  if (Number.isSafeInteger(command.pid)) {
    try {
      command.kill('SIGTERM');
    } catch {}
    try {
      process.kill(-command.pid, 'SIGTERM');
    } catch {}
    await waitUntil(() => command.exitCode !== null, 2000);
    commandCleanupConfirmed = !processGroupExists(command.pid);
    if (!commandCleanupConfirmed) {
      try {
        command.kill('SIGKILL');
      } catch {}
      try {
        process.kill(-command.pid, 'SIGKILL');
      } catch {}
      await waitUntil(() => command.exitCode !== null, 2000);
      commandCleanupConfirmed = !processGroupExists(command.pid);
    }
  }
  const released = await listen(input.port);
  commandCleanupConfirmed = commandCleanupConfirmed && released.ok;
  timings.cleanupMs = elapsed();
  if (stderrDescriptor !== undefined) {
    let readDescriptor;
    try {
      readDescriptor = openSync(input.commandStderrPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      const metadata = fstatSync(readDescriptor);
      if (metadata.isFile()) {
        const position = Math.max(0, metadata.size - diagnosticInputLimit);
        const contents = Buffer.alloc(Math.min(metadata.size, diagnosticInputLimit));
        let offset = 0;
        while (offset < contents.length) {
          const count = readSync(readDescriptor, contents, offset, contents.length - offset, position + offset);
          if (count === 0) break;
          offset += count;
        }
        if (offset === contents.length && fstatSync(readDescriptor).size === metadata.size) {
          commandStderrTruncated = position > 0;
          const lineStart = commandStderrTruncated ? contents.indexOf(10) + 1 : 0;
          commandStderrTail = commandStderrTruncated && lineStart === 0
            ? ''
            : contents.subarray(lineStart).toString('utf8');
        }
      }
    } catch {} finally {
      if (readDescriptor !== undefined) {
        try {
          closeSync(readDescriptor);
        } catch {}
      }
    }
  }
  const commandChainStable = true;
  const descendantCreationAllowed = resolvedCommandAllowed && commandCleanupConfirmed;
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
    descendantCreationAllowed,
    unauthorizedExecutableDenied: Boolean(unauthorizedExecutableDenied),
    unmanifestedReadDenied,
    unmanifestedWriteDenied,
    symlinkEscapeDenied,
    unallocatedListenerDenied:
      !unallocated.ok && (unallocated.code === 'EPERM' || unallocated.code === 'EACCES'),
    allocatedListenerAllowed: allocated.ok,
    networkOutboundDenied,
    resolvedCommandAllowed,
    commandCleanupConfirmed,
    commandChainStable,
  };
  timings.totalMs = elapsed();
  writeFileSync(1, JSON.stringify({ ...receipt, diagnostic: { timings, commandExit, commandStderrTail, commandStderrTruncated } }));
  process.exit(Object.values(receipt).every(Boolean) ? 0 : 1);
})().catch((error) => {
  try {
    timings.totalMs = elapsed();
    writeFileSync(
      1,
      JSON.stringify({
        diagnostic: {
          timings,
          commandExit,
          commandStderrTail,
          commandStderrTruncated,
          exception: String((error && error.message) || error).length <= diagnosticInputLimit
            ? String((error && error.message) || error)
            : null,
        },
      }),
    );
  } catch {}
  process.exit(1);
});
`;

const PREFLIGHT_FLAGS = [
  'descendantCreationAllowed',
  'unauthorizedExecutableDenied',
  'unmanifestedReadDenied',
  'unmanifestedWriteDenied',
  'symlinkEscapeDenied',
  'unallocatedListenerDenied',
  'allocatedListenerAllowed',
  'networkOutboundDenied',
  'resolvedCommandAllowed',
  'commandCleanupConfirmed',
  'commandChainStable',
] as const;

export interface ManagedMetroPreflightObservation {
  version: 1;
  outcome: 'receipt' | 'incomplete' | 'failed' | 'invalid';
  complete: boolean;
  status: number | null;
  signal: string | null;
  outerTimedOut: boolean;
  elapsedMs: number;
  flags: Record<(typeof PREFLIGHT_FLAGS)[number], boolean> | null;
  timings: Record<string, number> | null;
  commandExit: { code: number | null; signal: string | null; atMs: number } | null;
  commandStderrTail: string | null;
  preflightStderrTail: string | null;
  exception: string | null;
}

interface ManagedMetroPreflightDependencies {
  writeCanary?: (path: string, contents: string) => void;
  removeCanary?: (path: string) => void;
  run?: (command: string, args: readonly string[]) => CommandResult;
  environment?: NodeJS.ProcessEnv;
  observe?: (observation: ManagedMetroPreflightObservation) => void;
  // Without a sanitizer every process-output tail is dropped, so raw stderr cannot escape.
  sanitize?: (value: string, truncatedStart?: boolean) => string;
}

const OBSERVATION_TAIL_BYTES = 8_192;

function observationTail(
  value: unknown,
  sanitize: ManagedMetroPreflightDependencies['sanitize'],
  truncatedStart = false,
): string | null {
  if (typeof value !== 'string' || !sanitize) return null;
  const bytes = Buffer.from(sanitize(value, truncatedStart), 'utf8');
  let start = Math.max(0, bytes.length - OBSERVATION_TAIL_BYTES);
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString('utf8');
}

function preflightObservation(
  result: CommandResult,
  elapsedMs: number,
  sanitize: ManagedMetroPreflightDependencies['sanitize'],
): ManagedMetroPreflightObservation {
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = result.stdout ? (JSON.parse(result.stdout) as Record<string, unknown>) : null;
  } catch {
    parsed = null;
  }
  const flags =
    parsed && PREFLIGHT_FLAGS.every((flag) => typeof parsed[flag] === 'boolean')
      ? (Object.fromEntries(
          PREFLIGHT_FLAGS.map((flag) => [flag, parsed[flag] as boolean]),
        ) as ManagedMetroPreflightObservation['flags'])
      : null;
  const diagnostic =
    parsed && parsed.diagnostic && typeof parsed.diagnostic === 'object'
      ? (parsed.diagnostic as Record<string, unknown>)
      : null;
  const timings =
    diagnostic && diagnostic.timings && typeof diagnostic.timings === 'object'
      ? Object.fromEntries(
          Object.entries(diagnostic.timings as Record<string, unknown>).filter(
            (entry): entry is [string, number] => Number.isFinite(entry[1]),
          ),
        )
      : null;
  const exit =
    diagnostic && diagnostic.commandExit && typeof diagnostic.commandExit === 'object'
      ? (diagnostic.commandExit as Record<string, unknown>)
      : null;
  return {
    version: 1,
    outcome:
      result.status !== 0
        ? 'failed'
        : flags && PREFLIGHT_FLAGS.every((flag) => flags[flag])
          ? 'receipt'
          : 'incomplete',
    complete: result.status !== null && result.timedOut !== true && parsed !== null,
    status: result.status,
    signal: result.signal ?? null,
    outerTimedOut: result.timedOut === true,
    elapsedMs,
    flags,
    timings,
    commandExit: exit
      ? {
          code: typeof exit.code === 'number' ? exit.code : null,
          signal: typeof exit.signal === 'string' ? exit.signal : null,
          atMs: typeof exit.atMs === 'number' ? exit.atMs : -1,
        }
      : null,
    commandStderrTail: observationTail(
      diagnostic?.commandStderrTail,
      sanitize,
      diagnostic?.commandStderrTruncated === true,
    ),
    preflightStderrTail: observationTail(result.stderr, sanitize),
    exception:
      typeof diagnostic?.exception === 'string' && sanitize
        ? sanitize(diagnostic.exception).slice(0, 512)
        : null,
  };
}

export function runManagedMetroEnforcementPreflight(
  plan: ManagedMetroEnforcementPlan,
  dependencies: ManagedMetroPreflightDependencies = {},
): ManagedMetroEnforcementReceipt {
  const writeCanary =
    dependencies.writeCanary ??
    ((path: string, contents: string) => {
      const descriptor = openSync(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      try {
        writeSync(descriptor, contents);
      } finally {
        closeSync(descriptor);
      }
    });
  const removeCanary =
    dependencies.removeCanary ?? ((path: string) => rmSync(path, { force: true }));
  const run = dependencies.run ?? defaultRun;
  const observe = (createObservation: () => ManagedMetroPreflightObservation) => {
    try {
      dependencies.observe?.(createObservation());
    } catch {}
  };
  const startedAt = performance.now();
  let observationEmitted = false;
  let canaryCreated = false;
  let environmentCreated = false;
  let symlinkCreated = false;
  try {
    writeCanary(plan.canaryPath, 'rn-dev-agent sandbox canary');
    canaryCreated = true;
    mkdirSync(dirname(plan.preflightEnvironmentPath), { recursive: true });
    const preflightEnvironment = Object.fromEntries(
      Object.entries(dependencies.environment ?? process.env),
    );
    preflightEnvironment.NODE_OPTIONS = plan.baseNodeOptions;
    delete preflightEnvironment.RN_DEV_AGENT_METRO_EVIDENCE_FD;
    delete preflightEnvironment.RN_DEV_AGENT_METRO_NATIVE_ADDON_ACK_ROOT;
    writeCanary(plan.preflightEnvironmentPath, canonicalAuthorityJson(preflightEnvironment));
    environmentCreated = true;
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
        commandExecutable: plan.commandExecutable,
        commandArguments: plan.commandArguments,
        commandChainAttestation: plan.commandChainAttestation,
        preflightEnvironmentPath: plan.preflightEnvironmentPath,
        appRoot: plan.appRoot,
        commandStderrPath: plan.commandStderrPath,
        port: plan.port,
        unallocatedPort: plan.unallocatedPort,
      }),
    ]);
    observationEmitted = true;
    observe(() =>
      preflightObservation(
        result,
        Math.round(performance.now() - startedAt),
        dependencies.sanitize,
      ),
    );
    if (result.status !== 0) {
      throw new Error('METRO_RUNTIME_ENFORCEMENT_UNAVAILABLE: sandbox preflight failed');
    }
    const observed = JSON.parse(result.stdout) as Record<string, unknown>;
    if (
      observed.descendantCreationAllowed !== true ||
      observed.unauthorizedExecutableDenied !== true ||
      observed.unmanifestedReadDenied !== true ||
      observed.unmanifestedWriteDenied !== true ||
      observed.symlinkEscapeDenied !== true ||
      observed.unallocatedListenerDenied !== true ||
      observed.allocatedListenerAllowed !== true ||
      observed.networkOutboundDenied !== true ||
      observed.resolvedCommandAllowed !== true ||
      observed.commandCleanupConfirmed !== true ||
      observed.commandChainStable !== true
    ) {
      throw new Error('METRO_RUNTIME_ENFORCEMENT_UNAVAILABLE: sandbox preflight is incomplete');
    }
    return {
      version: 2,
      kind: plan.kind,
      profileSha256: plan.profileSha256,
      sandboxExecutableSha256: plan.sandboxExecutableSha256,
      sandboxExecutableCdHash: plan.sandboxExecutableCdHash,
      commandLaunchSha256: plan.commandLaunchSha256,
      resolvedCommandSha256: plan.resolvedCommandSha256,
      descendantCreationAllowed: true,
      unauthorizedExecutableDenied: true,
      unmanifestedReadDenied: true,
      unmanifestedWriteDenied: true,
      symlinkEscapeDenied: true,
      unallocatedListenerDenied: true,
      allocatedListenerAllowed: true,
      networkOutboundDenied: true,
      resolvedCommandAllowed: true,
      commandCleanupConfirmed: true,
      commandChainStable: true,
      nodeRuntimeAttestation: plan.nodeRuntimeAttestation,
      commandChainAttestation: plan.commandChainAttestation,
    };
  } catch (error) {
    if (!observationEmitted) {
      observationEmitted = true;
      observe(() => ({
        version: 1,
        outcome: 'invalid',
        complete: false,
        status: null,
        signal: null,
        outerTimedOut: false,
        elapsedMs: Math.round(performance.now() - startedAt),
        flags: null,
        timings: null,
        commandExit: null,
        commandStderrTail: null,
        preflightStderrTail: null,
        exception: dependencies.sanitize
          ? dependencies
              .sanitize(error instanceof Error ? error.message : String(error))
              .slice(0, 512)
          : null,
      }));
    }
    if (error instanceof Error && error.message.startsWith('METRO_RUNTIME_ENFORCEMENT_')) {
      throw error;
    }
    throw new Error('METRO_RUNTIME_ENFORCEMENT_UNAVAILABLE: sandbox preflight is invalid', {
      cause: error,
    });
  } finally {
    try {
      rmSync(plan.commandStderrPath, { force: true });
    } catch {}
    if (symlinkCreated) rmSync(plan.symlinkCanaryPath, { force: true });
    if (environmentCreated) removeCanary(plan.preflightEnvironmentPath);
    if (canaryCreated) removeCanary(plan.canaryPath);
  }
}

export function verifyManagedMetroEnforcementReceipt(
  input: ManagedMetroEnforcementInput,
  receipt: unknown,
  dependencies: ManagedMetroEnforcementDependencies = {},
): receipt is ManagedMetroEnforcementReceipt {
  if (!receipt || typeof receipt !== 'object') return false;
  const observed = receipt as Partial<ManagedMetroEnforcementReceipt>;
  const plan = prepareManagedMetroEnforcement(input, dependencies);
  return (
    plan.status === 'enforced' &&
    observed.version === 2 &&
    observed.kind === plan.kind &&
    observed.profileSha256 === plan.profileSha256 &&
    observed.sandboxExecutableSha256 === plan.sandboxExecutableSha256 &&
    observed.sandboxExecutableCdHash === plan.sandboxExecutableCdHash &&
    observed.commandLaunchSha256 === plan.commandLaunchSha256 &&
    observed.resolvedCommandSha256 === plan.resolvedCommandSha256 &&
    observed.descendantCreationAllowed === true &&
    observed.unauthorizedExecutableDenied === true &&
    observed.unmanifestedReadDenied === true &&
    observed.unmanifestedWriteDenied === true &&
    observed.symlinkEscapeDenied === true &&
    observed.unallocatedListenerDenied === true &&
    observed.allocatedListenerAllowed === true &&
    observed.networkOutboundDenied === true &&
    observed.resolvedCommandAllowed === true &&
    observed.commandCleanupConfirmed === true &&
    observed.commandChainStable === true &&
    canonicalAuthorityJson(observed.nodeRuntimeAttestation) ===
      canonicalAuthorityJson(plan.nodeRuntimeAttestation) &&
    canonicalAuthorityJson(observed.commandChainAttestation) ===
      canonicalAuthorityJson(plan.commandChainAttestation)
  );
}
