import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

export interface GitSourceIdentity {
  kind: 'git';
  contentRoot: string;
  appRoot: string;
  sourceKey: string;
  worktreeKey: string;
  appRootKey: string;
  head: string;
}

export interface DeclaredSourceIdentity {
  kind: 'declared-root';
  contentRoot: string;
  appRoot: string;
  sourceKey: string;
  worktreeKey: string;
  appRootKey: string;
  manifestDigest: string;
  declaredManifests: string[];
}

export type SourceIdentity = GitSourceIdentity | DeclaredSourceIdentity;

interface SourceIdentityDependencies {
  git?: (root: string, args: readonly string[]) => string;
  canonicalize?: (path: string) => string;
  exists?: (path: string) => boolean;
  readMetroEvidenceHead?: (socket: string, challenge: string) => string;
  metroRuntimePolicy?: {
    sessionId: string;
    metroInstanceId: string;
    capability: string;
    evidencePath: string;
    evidenceSocket: string;
  };
  declaredRoot?: string;
  declaredManifests?: readonly string[];
}

function digest(parts: readonly (string | Buffer)[]): string {
  const hash = createHash('sha256');
  for (const part of parts) {
    hash.update(part);
    hash.update('\0');
  }
  return hash.digest('hex');
}

const MAX_STRICT_PROOF_FILES = 4_096;
const MAX_STRICT_PROOF_FILE_BYTES = 16 * 1024 * 1024;
const MAX_STRICT_PROOF_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_STRICT_PROOF_DEPENDENCY_ENTRIES = 50_000;
const MAX_STRICT_PROOF_DEPENDENCY_DEPTH = 128;
const MAX_STRICT_PROOF_DEPENDENCY_FILE_BYTES = 128 * 1024 * 1024;
const MAX_STRICT_PROOF_DEPENDENCY_TOTAL_BYTES = 512 * 1024 * 1024;
const STRICT_PROOF_READ_BUFFER_BYTES = 64 * 1024;
const DEPENDENCY_STORE_PATHS = [
  ':(top,glob)**/node_modules/**',
  ':(top,glob)**/.yarn/cache/**',
  ':(top,glob)**/.yarn/unplugged/**',
] as const;
const EXCLUDED_RUNTIME_DIRECTORIES = [
  '.gradle',
  '.expo',
  '.cache',
  'ios/Pods',
  'ios/build',
  'ios/DerivedData',
  'android/build',
  'android/app/build',
  'android/app/.cxx',
] as const;
const IGNORED_RUNTIME_INPUT_PATHS = [
  ':(top,glob)**',
  ':(top,exclude,glob)**/node_modules/**',
  ':(top,exclude,glob)**/.yarn/cache/**',
  ':(top,exclude,glob)**/.yarn/unplugged/**',
  ...EXCLUDED_RUNTIME_DIRECTORIES.map((entry) => `:(top,exclude,glob)**/${entry}/**`),
] as const;
const METRO_INTEGRATION_START = '// rn-dev-agent session integration: begin';
const METRO_INTEGRATION_END = '// rn-dev-agent session integration: end';
const METRO_INTEGRATION_BLOCK = `${METRO_INTEGRATION_START}
module.exports = require('./.rn-agent/integration/rn-session-metro.cjs')(module.exports);
${METRO_INTEGRATION_END}`;
const METRO_RUNTIME_POLICY = '.rn-agent/integration/metro-runtime-policy.json';
const METRO_EVIDENCE_HEAD_CLIENT = String.raw`
const { createConnection } = require('node:net');
const socket = createConnection(process.argv[1]);
let response = '';
socket.setEncoding('utf8');
socket.setTimeout(1500);
socket.once('connect', () => socket.write(process.argv[2] + '\n'));
socket.on('data', (chunk) => {
  response += chunk;
  if (response.length > 4096) process.exit(2);
});
socket.once('end', () => process.stdout.write(response));
socket.once('timeout', () => process.exit(3));
socket.once('error', () => process.exit(4));
`;

function readMetroEvidenceHead(socket: string, challenge: string): string {
  return execFileSync(process.execPath, ['-e', METRO_EVIDENCE_HEAD_CLIENT, socket, challenge], {
    encoding: 'utf8',
    maxBuffer: 4_096,
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 2_000,
  });
}

function updateFramed(hash: ReturnType<typeof createHash>, part: string | Buffer): void {
  const bytes = Buffer.isBuffer(part) ? part : Buffer.from(part);
  hash.update(`${bytes.byteLength}:`);
  hash.update(bytes);
}

function updateFramedFile(hash: ReturnType<typeof createHash>, path: string, size: number): void {
  hash.update(`${size}:`);
  const descriptor = openSync(path, 'r');
  const buffer = Buffer.allocUnsafe(Math.min(STRICT_PROOF_READ_BUFFER_BYTES, Math.max(size, 1)));
  try {
    let offset = 0;
    while (offset < size) {
      const bytesRead = readSync(
        descriptor,
        buffer,
        0,
        Math.min(buffer.length, size - offset),
        offset,
      );
      if (bytesRead === 0) {
        throw new Error('STRICT_PROOF_SOURCE_READ_FAILED: source file changed while hashing');
      }
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
  } finally {
    closeSync(descriptor);
  }
}

function fileDigest(path: string): string {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > MAX_STRICT_PROOF_DEPENDENCY_FILE_BYTES) {
    throw new Error('STRICT_PROOF_UNVERIFIED_METRO_POLICY: runtime input is not bounded');
  }
  const hash = createHash('sha256');
  const descriptor = openSync(path, 'r');
  const buffer = Buffer.allocUnsafe(
    Math.min(STRICT_PROOF_READ_BUFFER_BYTES, Math.max(stat.size, 1)),
  );
  try {
    let offset = 0;
    while (offset < stat.size) {
      const bytesRead = readSync(
        descriptor,
        buffer,
        0,
        Math.min(buffer.length, stat.size - offset),
        offset,
      );
      if (bytesRead === 0) {
        throw new Error(
          'STRICT_PROOF_UNVERIFIED_METRO_POLICY: runtime input changed while hashing',
        );
      }
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
  } finally {
    closeSync(descriptor);
  }
  return hash.digest('hex');
}

interface DependencyHashState {
  entries: number;
  totalBytes: number;
  visitedDirectories: Set<string>;
}

interface DependencyHashTask {
  path: string;
  label: string;
  depth: number;
}

function updateDependencyPath(
  hash: ReturnType<typeof createHash>,
  path: string,
  label: string,
  state: DependencyHashState,
): void {
  const pending: DependencyHashTask[] = [{ path, label, depth: 0 }];
  while (pending.length > 0) {
    const current = pending.pop()!;
    state.entries += 1;
    if (state.entries > MAX_STRICT_PROOF_DEPENDENCY_ENTRIES) {
      throw new Error('STRICT_PROOF_DEPENDENCY_LIMIT: dependency entry count exceeds the limit');
    }
    if (current.depth > MAX_STRICT_PROOF_DEPENDENCY_DEPTH) {
      throw new Error('STRICT_PROOF_DEPENDENCY_LIMIT: dependency depth exceeds the limit');
    }
    const stat = lstatSync(current.path);
    updateFramed(hash, current.label);
    updateFramed(hash, String(stat.mode & 0o777));
    if (stat.isSymbolicLink()) {
      const link = readlinkSync(current.path);
      const target = realpathSync(current.path);
      state.totalBytes += Buffer.byteLength(link);
      if (state.totalBytes > MAX_STRICT_PROOF_DEPENDENCY_TOTAL_BYTES) {
        throw new Error('STRICT_PROOF_DEPENDENCY_LIMIT: dependency bytes exceed the total limit');
      }
      updateFramed(hash, 'symlink');
      updateFramed(hash, link);
      updateFramed(hash, target);
      pending.push({
        path: target,
        label: `target:${target}`,
        depth: current.depth + 1,
      });
      continue;
    }
    if (stat.isDirectory()) {
      const canonical = realpathSync(current.path);
      if (state.visitedDirectories.has(canonical)) {
        updateFramed(hash, 'directory-reference');
        updateFramed(hash, canonical);
        continue;
      }
      state.visitedDirectories.add(canonical);
      updateFramed(hash, 'directory');
      for (const entry of readdirSync(current.path).sort().reverse()) {
        pending.push({
          path: join(current.path, entry),
          label: `${current.label}/${entry}`,
          depth: current.depth + 1,
        });
      }
      continue;
    }
    if (!stat.isFile()) {
      throw new Error(
        `STRICT_PROOF_UNSUPPORTED_DEPENDENCY: ${current.label} is not a regular file, directory, or symlink`,
      );
    }
    if (stat.size > MAX_STRICT_PROOF_DEPENDENCY_FILE_BYTES) {
      throw new Error(`STRICT_PROOF_DEPENDENCY_LIMIT: ${current.label} exceeds the per-file limit`);
    }
    state.totalBytes += stat.size;
    if (state.totalBytes > MAX_STRICT_PROOF_DEPENDENCY_TOTAL_BYTES) {
      throw new Error('STRICT_PROOF_DEPENDENCY_LIMIT: dependency bytes exceed the total limit');
    }
    updateFramed(hash, 'file');
    updateFramedFile(hash, current.path, stat.size);
  }
}

function isContained(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return (
    child !== '..' &&
    !child.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) &&
    !isAbsolute(child)
  );
}

function isExcludedRuntimePath(root: string, candidate: string): boolean {
  const entry = relative(root, candidate).split('\\').join('/');
  return EXCLUDED_RUNTIME_DIRECTORIES.some(
    (excluded) =>
      entry === excluded ||
      entry.startsWith(`${excluded}/`) ||
      entry.endsWith(`/${excluded}`) ||
      entry.includes(`/${excluded}/`),
  );
}

function assertFinalMetroIntegration(identity: GitSourceIdentity): void {
  const candidates = ['metro.config.js', 'metro.config.cjs']
    .map((entry) => join(identity.appRoot, entry))
    .filter(existsSync);
  if (candidates.length === 0) return;
  const source = readFileSync(candidates[0]!, 'utf8');
  const start = source.indexOf(METRO_INTEGRATION_START);
  const end = source.indexOf(METRO_INTEGRATION_END);
  if (
    start < 0 ||
    end < start ||
    source.indexOf(METRO_INTEGRATION_START, start + METRO_INTEGRATION_START.length) >= 0 ||
    source.indexOf(METRO_INTEGRATION_END, end + METRO_INTEGRATION_END.length) >= 0 ||
    source.slice(start, end + METRO_INTEGRATION_END.length) !== METRO_INTEGRATION_BLOCK ||
    source.slice(end + METRO_INTEGRATION_END.length).trim()
  ) {
    throw new Error(
      'STRICT_PROOF_UNVERIFIED_METRO_CONFIG: session integration must be one exact terminal block',
    );
  }
}

function metroRuntimeInputs(
  identity: GitSourceIdentity,
  authority: SourceIdentityDependencies['metroRuntimePolicy'],
  readEvidenceHead: (socket: string, challenge: string) => string,
): { paths: string[]; semantics: string[] } {
  if (!authority) return { paths: [], semantics: [] };
  const raw = readFileSync(join(identity.appRoot, METRO_RUNTIME_POLICY), 'utf8');
  const receipt = JSON.parse(raw) as {
    version?: unknown;
    sessionId?: unknown;
    metroInstanceId?: unknown;
    contentRoot?: unknown;
    appRoot?: unknown;
    runtimeInputs?: unknown;
    violations?: unknown;
    signature?: unknown;
  };
  const payload = {
    version: receipt.version,
    sessionId: receipt.sessionId,
    metroInstanceId: receipt.metroInstanceId,
    contentRoot: receipt.contentRoot,
    appRoot: receipt.appRoot,
    runtimeInputs: receipt.runtimeInputs,
    violations: receipt.violations,
  };
  const expected = createHmac('sha256', authority.capability)
    .update(JSON.stringify(payload))
    .digest();
  const observed =
    typeof receipt.signature === 'string' ? Buffer.from(receipt.signature, 'hex') : Buffer.alloc(0);
  if (
    receipt.version !== 1 ||
    receipt.sessionId !== authority.sessionId ||
    receipt.metroInstanceId !== authority.metroInstanceId ||
    receipt.contentRoot !== identity.contentRoot ||
    receipt.appRoot !== identity.appRoot ||
    !Array.isArray(receipt.runtimeInputs) ||
    receipt.runtimeInputs.some((entry) => typeof entry !== 'string') ||
    !Array.isArray(receipt.violations) ||
    receipt.violations.some((entry) => typeof entry !== 'string') ||
    observed.length !== expected.length ||
    !timingSafeEqual(observed, expected)
  ) {
    throw new Error('STRICT_PROOF_UNVERIFIED_METRO_POLICY: runtime policy receipt is invalid');
  }
  if (receipt.violations.length > 0) {
    throw new Error(`STRICT_PROOF_UNVERIFIED_METRO_POLICY: ${receipt.violations[0]}`);
  }
  const runtimeInputs = new Set(receipt.runtimeInputs);
  const runtimeLoadsPath = authority.evidencePath;
  let runtimeLoadsRaw: string;
  try {
    const runtimeLoadsStat = lstatSync(runtimeLoadsPath);
    if (!runtimeLoadsStat.isFile() || runtimeLoadsStat.size > MAX_STRICT_PROOF_FILE_BYTES) {
      throw new Error('runtime load evidence is not a bounded regular file');
    }
    runtimeLoadsRaw = readFileSync(runtimeLoadsPath, 'utf8');
  } catch (error) {
    throw new Error('STRICT_PROOF_UNVERIFIED_METRO_POLICY: runtime load evidence is invalid', {
      cause: error,
    });
  }
  const runtimeLoads = new Map<
    string,
    { kind: 'input' | 'violation'; value: string; digest: string | null }
  >();
  const descendantLaunches = new Set<string>();
  const descendantAttestations = new Set<string>();
  const descendantSemanticDigests = new Set<string>();
  const runtimeSemantics = new Set<string>();
  const runtimeEvidenceKeys = new Set<string>();
  let evidenceSequence = 0;
  let previousEvidenceSignature: string | null = null;
  for (const rawLoad of runtimeLoadsRaw.split('\n').filter(Boolean)) {
    let load: {
      version?: unknown;
      sessionId?: unknown;
      metroInstanceId?: unknown;
      kind?: unknown;
      value?: unknown;
      digest?: unknown;
      sequence?: unknown;
      previousSignature?: unknown;
      signature?: unknown;
    };
    try {
      load = JSON.parse(rawLoad) as {
        version?: unknown;
        sessionId?: unknown;
        metroInstanceId?: unknown;
        kind?: unknown;
        value?: unknown;
        digest?: unknown;
        sequence?: unknown;
        previousSignature?: unknown;
        signature?: unknown;
      };
    } catch (error) {
      throw new Error('STRICT_PROOF_UNVERIFIED_METRO_POLICY: runtime load evidence is invalid', {
        cause: error,
      });
    }
    const loadPayload = {
      version: load.version,
      sessionId: load.sessionId,
      metroInstanceId: load.metroInstanceId,
      kind: load.kind,
      value: load.value,
      digest: load.digest,
      sequence: load.sequence,
      previousSignature: load.previousSignature,
    };
    const expectedLoad = createHmac('sha256', authority.capability)
      .update(JSON.stringify(loadPayload))
      .digest();
    const observedLoad =
      typeof load.signature === 'string' ? Buffer.from(load.signature, 'hex') : Buffer.alloc(0);
    if (
      load.version !== 1 ||
      load.sessionId !== authority.sessionId ||
      load.metroInstanceId !== authority.metroInstanceId ||
      (load.kind !== 'input' &&
        load.kind !== 'violation' &&
        load.kind !== 'launch' &&
        load.kind !== 'attestation' &&
        load.kind !== 'semantics') ||
      typeof load.value !== 'string' ||
      !Number.isSafeInteger(load.sequence) ||
      load.sequence !== evidenceSequence + 1 ||
      load.previousSignature !== previousEvidenceSignature ||
      (load.kind === 'input'
        ? typeof load.digest !== 'string' || !/^[a-f0-9]{64}$/.test(load.digest)
        : load.digest !== null) ||
      observedLoad.length !== expectedLoad.length ||
      !timingSafeEqual(observedLoad, expectedLoad)
    ) {
      throw new Error('STRICT_PROOF_UNVERIFIED_METRO_POLICY: runtime load evidence is invalid');
    }
    evidenceSequence = load.sequence as number;
    previousEvidenceSignature = load.signature as string;
    const key = `${load.kind}\0${load.value}`;
    runtimeEvidenceKeys.add(key);
    if (runtimeEvidenceKeys.size > MAX_STRICT_PROOF_DEPENDENCY_ENTRIES) {
      throw new Error('STRICT_PROOF_UNVERIFIED_METRO_POLICY: runtime load evidence is unbounded');
    }
    if (load.kind === 'launch' || load.kind === 'attestation') {
      if (!/^[a-f0-9]{32}:(?:process|worker):\d+:[a-f0-9]{64}$/.test(load.value)) {
        throw new Error('STRICT_PROOF_UNVERIFIED_METRO_POLICY: runtime load evidence is invalid');
      }
      (load.kind === 'launch' ? descendantLaunches : descendantAttestations).add(load.value);
      descendantSemanticDigests.add(load.value.slice(-64));
      continue;
    }
    if (load.kind === 'semantics') {
      if (load.value.length > 4_096) {
        throw new Error('STRICT_PROOF_UNVERIFIED_METRO_POLICY: runtime semantics are unbounded');
      }
      runtimeSemantics.add(load.value);
      continue;
    }
    const prior = runtimeLoads.get(key);
    if (prior && prior.digest !== load.digest) {
      throw new Error(
        'STRICT_PROOF_UNVERIFIED_METRO_POLICY: runtime input changed between executions',
      );
    }
    runtimeLoads.set(key, {
      kind: load.kind,
      value: load.value,
      digest: load.digest as string | null,
    });
  }
  if (evidenceSequence === 0 || previousEvidenceSignature === null) {
    throw new Error('STRICT_PROOF_UNVERIFIED_METRO_POLICY: runtime load evidence is empty');
  }
  const challenge = randomBytes(32).toString('hex');
  let head: {
    version?: unknown;
    sessionId?: unknown;
    metroInstanceId?: unknown;
    challenge?: unknown;
    sequence?: unknown;
    journalSignature?: unknown;
    signature?: unknown;
  };
  try {
    head = JSON.parse(readEvidenceHead(authority.evidenceSocket, challenge)) as typeof head;
  } catch (error) {
    throw new Error('STRICT_PROOF_UNVERIFIED_METRO_POLICY: runtime evidence head is unavailable', {
      cause: error,
    });
  }
  const headPayload = {
    version: head.version,
    sessionId: head.sessionId,
    metroInstanceId: head.metroInstanceId,
    challenge: head.challenge,
    sequence: head.sequence,
    journalSignature: head.journalSignature,
  };
  const expectedHead = createHmac('sha256', authority.capability)
    .update(JSON.stringify(headPayload))
    .digest();
  const observedHead =
    typeof head.signature === 'string' ? Buffer.from(head.signature, 'hex') : Buffer.alloc(0);
  if (
    head.version !== 1 ||
    head.sessionId !== authority.sessionId ||
    head.metroInstanceId !== authority.metroInstanceId ||
    head.challenge !== challenge ||
    head.sequence !== evidenceSequence ||
    head.journalSignature !== previousEvidenceSignature ||
    observedHead.length !== expectedHead.length ||
    !timingSafeEqual(observedHead, expectedHead)
  ) {
    throw new Error('STRICT_PROOF_UNVERIFIED_METRO_POLICY: runtime evidence head is invalid');
  }
  for (const launch of descendantLaunches) {
    if (!descendantAttestations.has(launch)) {
      throw new Error(
        'STRICT_PROOF_UNVERIFIED_METRO_POLICY: descendant execution was not attested',
      );
    }
  }
  for (const attestation of descendantAttestations) {
    if (!descendantLaunches.has(attestation)) {
      throw new Error('STRICT_PROOF_UNVERIFIED_METRO_POLICY: descendant attestation has no launch');
    }
  }
  const observedSemanticDigests = new Set(
    [...runtimeSemantics].map((value) => createHash('sha256').update(value).digest('hex')),
  );
  for (const semantics of descendantSemanticDigests) {
    if (!observedSemanticDigests.has(semantics)) {
      throw new Error(
        'STRICT_PROOF_UNVERIFIED_METRO_POLICY: descendant execution semantics are missing',
      );
    }
  }
  for (const load of runtimeLoads.values()) {
    if (load.kind === 'violation') {
      throw new Error(`STRICT_PROOF_UNVERIFIED_METRO_POLICY: ${load.value}`);
    }
    const candidate = realpathSync(load.value);
    if (fileDigest(candidate) !== load.digest) {
      throw new Error(
        'STRICT_PROOF_UNVERIFIED_METRO_POLICY: runtime input bytes changed after execution',
      );
    }
    runtimeInputs.add(candidate);
  }
  return {
    paths: [...runtimeInputs].sort().flatMap((entry) => {
      const candidate = realpathSync(entry);
      return !isContained(identity.contentRoot, candidate) ||
        isExcludedRuntimePath(identity.contentRoot, candidate)
        ? [candidate]
        : [];
    }),
    semantics: [...runtimeSemantics].sort(),
  };
}

function dependencyStoreRoots(
  identity: GitSourceIdentity,
  git: (root: string, args: readonly string[]) => string,
  pathExists: (path: string) => boolean,
): string[] {
  const entries = git(identity.contentRoot, [
    'ls-files',
    '--others',
    '--ignored',
    '--exclude-standard',
    '--directory',
    '-z',
    '--',
    ...DEPENDENCY_STORE_PATHS,
  ])
    .split('\0')
    .filter(Boolean);
  for (const candidate of [
    join(identity.contentRoot, 'node_modules'),
    join(identity.appRoot, 'node_modules'),
  ]) {
    if (pathExists(candidate)) entries.push(relative(identity.contentRoot, candidate));
  }

  const pnpRoots: string[] = [];
  let pnpRoot = identity.appRoot;
  while (true) {
    pnpRoots.push(pnpRoot);
    if (pnpRoot === identity.contentRoot) break;
    const parent = dirname(pnpRoot);
    if (parent === pnpRoot || !isContained(identity.contentRoot, parent)) break;
    pnpRoot = parent;
  }
  const pnpLoaders = [...new Set(pnpRoots)].flatMap((root) =>
    ['.pnp.js', '.pnp.cjs', '.pnp.loader.mjs'].map((entry) => join(root, entry)).filter(pathExists),
  );
  if (pnpLoaders.length > 0) {
    throw new Error(
      'STRICT_PROOF_UNVERIFIED_DEPENDENCY_LAYOUT: Plug’n’Play dependency resolution is unsupported',
    );
  }

  let ancestor = dirname(identity.contentRoot);
  while (true) {
    if (pathExists(join(ancestor, 'node_modules'))) {
      throw new Error(
        'STRICT_PROOF_UNVERIFIED_DEPENDENCY_LAYOUT: ancestor node_modules resolves outside the content root',
      );
    }
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }

  const roots = [...new Set(entries.map((entry) => resolve(identity.contentRoot, entry)))].sort();
  for (const root of roots) {
    assertContained(identity.contentRoot, root, 'STRICT_PROOF_DEPENDENCY_PATH_ESCAPE');
  }
  return roots.filter(
    (candidate) => !roots.some((parent) => parent !== candidate && isContained(parent, candidate)),
  );
}

function updateDependencyStores(
  hash: ReturnType<typeof createHash>,
  identity: GitSourceIdentity,
  git: (root: string, args: readonly string[]) => string,
  pathExists: (path: string) => boolean,
  runtimeInputs: readonly string[],
): void {
  const roots = dependencyStoreRoots(identity, git, pathExists);
  const state: DependencyHashState = {
    entries: 0,
    totalBytes: 0,
    visitedDirectories: new Set(),
  };
  updateFramed(hash, 'dependency-stores-v1');
  for (const root of [...new Set([...roots, ...runtimeInputs])].sort()) {
    if (!pathExists(root)) continue;
    updateDependencyPath(hash, root, relative(identity.contentRoot, root), state);
  }
}

function defaultGit(root: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 5_000,
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
}

function isDefinitiveNonGitError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const stderr =
    'stderr' in error && typeof error.stderr === 'string'
      ? error.stderr
      : 'stderr' in error && Buffer.isBuffer(error.stderr)
        ? error.stderr.toString('utf8')
        : '';
  return `${error.message}\n${stderr}`.toLowerCase().includes('not a git repository');
}

function assertContained(root: string, candidate: string, code: string): void {
  const child = relative(root, candidate);
  if (
    child === '..' ||
    child.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
    isAbsolute(child)
  ) {
    throw new Error(`${code}: path is outside the declared content root`);
  }
}

function resolveDeclaredIdentity(
  appRoot: string,
  dependencies: SourceIdentityDependencies,
  canonicalize: (path: string) => string,
): DeclaredSourceIdentity {
  if (!dependencies.declaredRoot || !dependencies.declaredManifests?.length) {
    throw new Error(
      'NON_GIT_MANIFEST_REQUIRED: non-Git authority needs an explicit root and manifest list',
    );
  }
  const contentRoot = canonicalize(resolve(dependencies.declaredRoot));
  assertContained(contentRoot, appRoot, 'NON_GIT_ROOT_MISMATCH');
  const manifestParts: (string | Buffer)[] = [];
  for (const entry of [...dependencies.declaredManifests].sort()) {
    const manifest = canonicalize(resolve(contentRoot, entry));
    assertContained(contentRoot, manifest, 'NON_GIT_MANIFEST_OUTSIDE_ROOT');
    manifestParts.push(relative(contentRoot, manifest), readFileSync(manifest));
  }
  const manifestDigest = digest(manifestParts);
  const appRelative = relative(contentRoot, appRoot) || '.';
  return {
    kind: 'declared-root',
    contentRoot,
    appRoot,
    sourceKey: digest(['declared-source', contentRoot, manifestDigest]),
    worktreeKey: digest(['declared-root', contentRoot]),
    appRootKey: digest(['declared-app', appRelative]),
    manifestDigest,
    declaredManifests: [...dependencies.declaredManifests],
  };
}

export function resolveSourceIdentity(
  inputRoot: string,
  dependencies: SourceIdentityDependencies = {},
): SourceIdentity {
  const canonicalize = dependencies.canonicalize ?? realpathSync;
  const appRoot = canonicalize(resolve(inputRoot));
  const git = dependencies.git ?? defaultGit;

  try {
    const contentRoot = canonicalize(git(appRoot, ['rev-parse', '--show-toplevel']));
    assertContained(contentRoot, appRoot, 'APP_ROOT_OUTSIDE_WORKTREE');
    const commonRaw = git(appRoot, ['rev-parse', '--git-common-dir']);
    const commonDirectory = canonicalize(
      isAbsolute(commonRaw) ? commonRaw : join(appRoot, commonRaw),
    );
    const head = git(appRoot, ['rev-parse', 'HEAD']);
    const appRelative = relative(contentRoot, appRoot) || '.';
    return {
      kind: 'git',
      contentRoot,
      appRoot,
      sourceKey: digest(['git-source', commonDirectory]),
      worktreeKey: digest(['git-worktree', contentRoot]),
      appRootKey: digest(['git-app', appRelative]),
      head,
    };
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.startsWith('APP_ROOT_OUTSIDE_WORKTREE') ||
        error.message.startsWith('NON_GIT_'))
    ) {
      throw error;
    }
    if (!isDefinitiveNonGitError(error)) throw error;
    return resolveDeclaredIdentity(appRoot, dependencies, canonicalize);
  }
}

export function strictProofSourceIdentity(
  identity: SourceIdentity,
  dependencies: Pick<
    SourceIdentityDependencies,
    'git' | 'exists' | 'metroRuntimePolicy' | 'readMetroEvidenceHead'
  > = {},
): {
  kind: 'git-strict-proof';
  sourceKey: string;
  worktreeKey: string;
  appRootKey: string;
  head: string;
  dirtyDigest: string;
} {
  if (identity.kind !== 'git') {
    throw new Error('STRICT_PROOF_GIT_REQUIRED: accepted strict proof requires a Git worktree');
  }
  const git = dependencies.git ?? defaultGit;
  const pathExists = dependencies.exists ?? existsSync;
  assertFinalMetroIntegration(identity);
  const evidenceHeadReader = dependencies.readMetroEvidenceHead ?? readMetroEvidenceHead;
  const runtimeInputs = metroRuntimeInputs(
    identity,
    dependencies.metroRuntimePolicy,
    evidenceHeadReader,
  );
  const head = git(identity.contentRoot, ['rev-parse', 'HEAD']);
  const diff = git(identity.contentRoot, ['diff', '--binary', '--no-ext-diff', head, '--']);
  const untracked = git(identity.contentRoot, ['ls-files', '--others', '--exclude-standard', '-z'])
    .split('\0')
    .filter(Boolean)
    .sort();
  const ignored = git(identity.contentRoot, [
    'ls-files',
    '--others',
    '--ignored',
    '--exclude-standard',
    '-z',
    '--',
    ...IGNORED_RUNTIME_INPUT_PATHS,
  ])
    .split('\0')
    .filter(Boolean)
    .sort();
  const gitlinks = git(identity.contentRoot, ['ls-files', '--stage', '-z'])
    .split('\0')
    .flatMap((entry) => {
      const match = /^160000 [0-9a-f]+ \d+\t(.+)$/i.exec(entry);
      return match?.[1] ? [match[1]] : [];
    });
  for (const entry of gitlinks) {
    const submodule = resolve(identity.contentRoot, entry);
    assertContained(identity.contentRoot, submodule, 'STRICT_PROOF_PATH_ESCAPE');
    const status = git(submodule, [
      'status',
      '--porcelain=v1',
      '--untracked-files=all',
      '--ignore-submodules=none',
    ]);
    if (status) {
      throw new Error(
        `STRICT_PROOF_DIRTY_SUBMODULE: ${entry} contains source changes outside the parent digest`,
      );
    }
  }
  const dirtyHash = createHash('sha256');
  updateFramed(dirtyHash, 'git-dirty-v3');
  updateFramed(dirtyHash, diff);
  for (const semantics of runtimeInputs.semantics) {
    updateFramed(dirtyHash, 'runtime-semantics');
    updateFramed(dirtyHash, semantics);
  }
  updateDependencyStores(dirtyHash, identity, git, pathExists, runtimeInputs.paths);
  const sourceEntries = [
    ...untracked.map((entry) => ['untracked', entry] as const),
    ...ignored.map((entry) => ['ignored-runtime', entry] as const),
  ];
  if (sourceEntries.length > MAX_STRICT_PROOF_FILES) {
    throw new Error('STRICT_PROOF_RUNTIME_INPUT_LIMIT: too many untracked runtime inputs');
  }
  let totalBytes = 0;
  for (const [classification, entry] of [...sourceEntries]) {
    const file = resolve(identity.contentRoot, entry);
    assertContained(identity.contentRoot, file, 'STRICT_PROOF_PATH_ESCAPE');
    const stat = lstatSync(file);
    updateFramed(dirtyHash, classification);
    updateFramed(dirtyHash, entry);
    if (stat.isFile()) {
      if (stat.size > MAX_STRICT_PROOF_FILE_BYTES) {
        throw new Error(`STRICT_PROOF_RUNTIME_INPUT_LIMIT: ${entry} exceeds the per-file limit`);
      }
      totalBytes += stat.size;
      if (totalBytes > MAX_STRICT_PROOF_TOTAL_BYTES) {
        throw new Error('STRICT_PROOF_RUNTIME_INPUT_LIMIT: runtime inputs exceed the total limit');
      }
      updateFramed(dirtyHash, 'file');
      updateFramedFile(dirtyHash, file, stat.size);
      continue;
    }
    if (stat.isSymbolicLink()) {
      const target = realpathSync(file);
      assertContained(identity.contentRoot, target, 'STRICT_PROOF_PATH_ESCAPE');
      const link = readlinkSync(file);
      const targetStat = lstatSync(target);
      if (!targetStat.isFile()) {
        throw new Error(
          'STRICT_PROOF_UNSUPPORTED_FILE: untracked symlink target is not a regular file',
        );
      }
      if (targetStat.size > MAX_STRICT_PROOF_FILE_BYTES) {
        throw new Error(`STRICT_PROOF_RUNTIME_INPUT_LIMIT: ${entry} exceeds the per-file limit`);
      }
      totalBytes += Buffer.byteLength(link) + targetStat.size;
      if (totalBytes > MAX_STRICT_PROOF_TOTAL_BYTES) {
        throw new Error('STRICT_PROOF_RUNTIME_INPUT_LIMIT: runtime inputs exceed the total limit');
      }
      updateFramed(dirtyHash, 'symlink');
      updateFramed(dirtyHash, link);
      updateFramedFile(dirtyHash, target, targetStat.size);
      continue;
    }
    throw new Error(
      'STRICT_PROOF_UNSUPPORTED_FILE: untracked source is neither a regular file nor a symlink',
    );
  }
  const runtimeInputsAfter = metroRuntimeInputs(
    identity,
    dependencies.metroRuntimePolicy,
    evidenceHeadReader,
  );
  if (JSON.stringify(runtimeInputsAfter) !== JSON.stringify(runtimeInputs)) {
    throw new Error('STRICT_PROOF_SOURCE_READ_FAILED: Metro runtime inputs changed while hashing');
  }
  return {
    kind: 'git-strict-proof',
    sourceKey: identity.sourceKey,
    worktreeKey: identity.worktreeKey,
    appRootKey: identity.appRootKey,
    head,
    dirtyDigest: dirtyHash.digest('hex'),
  };
}
