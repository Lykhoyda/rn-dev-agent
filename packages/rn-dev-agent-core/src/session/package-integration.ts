import { createBuildLaunchPlan } from './build-adapter.js';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const ADAPTER = '.rn-agent/integration/rn-session-adapter.cjs';
const METRO_ADAPTER = '.rn-agent/integration/rn-session-metro.cjs';
const AUTHORITY_MODULE = '.rn-agent/integration/authority-marker.js';
const METRO_START = '// rn-dev-agent session integration: begin';
const METRO_END = '// rn-dev-agent session integration: end';
const SENTINELS = {
  ios: `node ${ADAPTER} ios`,
  android: `node ${ADAPTER} android`,
} as const;

interface PackageJson {
  scripts?: Record<string, string>;
  [key: string]: unknown;
}

export interface PackageIntegrationManifest {
  version: 1;
  adapter: string;
  sessionCli?: string;
  originalScripts: {
    ios: string[];
    android: string[];
  };
  metroConfig?: string;
}

export function renderMetroIntegrationAdapter(): string {
  return `'use strict';
const path = require('node:path');
module.exports = function withRnDevAgentAuthority(config) {
  if (config && typeof config.then === 'function') {
    return config.then(withRnDevAgentAuthority);
  }
  const current = config || {};
  const serializer = current.serializer || {};
  const original = serializer.getModulesRunBeforeMainModule;
  const marker = path.join(process.cwd(), ${JSON.stringify(AUTHORITY_MODULE)});
  return {
    ...current,
    serializer: {
      ...serializer,
      getModulesRunBeforeMainModule(entryFile) {
        return [marker, ...(typeof original === 'function' ? original(entryFile) : [])];
      },
    },
  };
};
`;
}

export function previewMetroIntegration(source: string): string {
  const hasStart = source.includes(METRO_START);
  const hasEnd = source.includes(METRO_END);
  if (hasStart !== hasEnd) {
    throw new Error('SESSION_INTEGRATION_PATH_UNSAFE: Metro integration sentinel is corrupt');
  }
  if (hasStart) return source;
  return `${source.trimEnd()}

${METRO_START}
module.exports = require('./${METRO_ADAPTER}')(module.exports);
${METRO_END}
`;
}

export function restoreMetroIntegration(source: string): string {
  const start = source.indexOf(METRO_START);
  const end = source.indexOf(METRO_END);
  if (start < 0 && end < 0) return source;
  if (
    start < 0 ||
    end < start ||
    source.indexOf(METRO_START, start + METRO_START.length) >= 0 ||
    source.indexOf(METRO_END, end + METRO_END.length) >= 0
  ) {
    throw new Error('SESSION_INTEGRATION_PATH_UNSAFE: Metro integration sentinel is corrupt');
  }
  const blockEnd = end + METRO_END.length;
  const prefix = source.slice(0, start).trimEnd();
  const suffix = source.slice(blockEnd).replace(/^(?:\r?\n)+/, '');
  return suffix ? `${prefix}\n${suffix}` : `${prefix}\n`;
}

interface PackageIntegrationPreview {
  packageJson: PackageJson;
  manifest: PackageIntegrationManifest;
}

function parseSupportedScript(script: string, platform: 'ios' | 'android'): string[] {
  if (/[;&|`$<>()\\'"]/.test(script)) {
    throw new Error('SESSION_BUILD_COMMAND_UNSUPPORTED: shell syntax cannot be wrapped safely');
  }
  const command = script.trim().split(/\s+/).filter(Boolean);
  createBuildLaunchPlan({
    platform,
    command,
    session: {
      platform,
      deviceId: 'preview-device',
      metroPort: 8081,
      sessionId: 'preview-session',
    },
  });
  return command;
}

export function previewPackageIntegration(
  packageJson: PackageJson,
  existing?: PackageIntegrationManifest,
  sessionCli?: string,
): PackageIntegrationPreview {
  if (
    existing &&
    packageJson.scripts?.ios === SENTINELS.ios &&
    packageJson.scripts?.android === SENTINELS.android
  ) {
    return {
      packageJson,
      manifest: sessionCli ? { ...existing, sessionCli: resolve(sessionCli) } : existing,
    };
  }

  const ios = packageJson.scripts?.ios;
  const android = packageJson.scripts?.android;
  if (typeof ios !== 'string' || typeof android !== 'string') {
    throw new Error('SESSION_BUILD_COMMAND_UNSUPPORTED: ios and android scripts are required');
  }

  const manifest: PackageIntegrationManifest = {
    version: 1,
    adapter: ADAPTER,
    ...(sessionCli ? { sessionCli: resolve(sessionCli) } : {}),
    originalScripts: {
      ios: parseSupportedScript(ios, 'ios'),
      android: parseSupportedScript(android, 'android'),
    },
  };
  return {
    packageJson: {
      ...packageJson,
      scripts: { ...packageJson.scripts, ...SENTINELS },
    },
    manifest,
  };
}

export function restorePackageIntegration(
  packageJson: PackageJson,
  manifest: PackageIntegrationManifest,
): PackageJson {
  return {
    ...packageJson,
    scripts: {
      ...packageJson.scripts,
      ios: manifest.originalScripts.ios.join(' '),
      android: manifest.originalScripts.android.join(' '),
    },
  };
}

export function renderProjectAdapter(): string {
  return String.raw`#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const platform = process.argv[2];
if (platform !== 'ios' && platform !== 'android') {
  process.stderr.write('SESSION_BUILD_COMMAND_UNSUPPORTED: expected ios or android\n');
  process.exit(2);
}
const manifestPath = path.join(process.cwd(), '.rn-agent', 'integration', 'rn-session-integration.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const original = manifest.originalScripts && manifest.originalScripts[platform];
if (!Array.isArray(original) || original.length === 0 || original.some((part) => typeof part !== 'string')) {
  process.stderr.write('SESSION_BUILD_COMMAND_UNSUPPORTED: integration manifest is invalid\n');
  process.exit(2);
}
const command = [...original, ...process.argv.slice(3)];
const rawSession = process.env.RN_DEV_AGENT_SESSION_BUILD_JSON;
let session = null;
let sessionCli = null;
if (rawSession) {
  try {
    session = JSON.parse(rawSession);
  } catch {
    process.stderr.write('SESSION_BUILD_IDENTITY_CONFLICT: session binding is invalid\n');
    process.exit(2);
  }
}
if (!session && typeof manifest.sessionCli === 'string' && fs.existsSync(manifest.sessionCli)) {
  sessionCli = manifest.sessionCli;
  const [major, minor] = process.versions.node.split('.').map(Number);
  const sqliteFlag = (major === 22 && minor >= 5) || (major === 23 && minor < 6)
    ? ['--experimental-sqlite']
    : [];
  let probe = spawnSync(process.execPath, [...sqliteFlag, manifest.sessionCli, 'prepare-build', platform], {
    cwd: process.cwd(),
    env: process.env,
    encoding: 'utf8',
  });
  if (probe.status !== 0 && String(probe.stderr).includes('live Metro binding')) {
    const metro = spawnSync(process.execPath, [...sqliteFlag, manifest.sessionCli, 'ensure-metro'], {
      cwd: process.cwd(),
      env: process.env,
      encoding: 'utf8',
    });
    if (metro.status !== 0) {
      process.stderr.write(String(metro.stderr) || 'METRO_START_UNAVAILABLE: managed Metro failed\n');
      process.exit(2);
    }
    probe = spawnSync(process.execPath, [...sqliteFlag, manifest.sessionCli, 'prepare-build', platform], {
      cwd: process.cwd(),
      env: process.env,
      encoding: 'utf8',
    });
  }
  if (probe.status === 0) {
    try {
      session = JSON.parse(probe.stdout);
    } catch {
      process.stderr.write('SESSION_BUILD_IDENTITY_CONFLICT: rn-session returned invalid JSON\n');
      process.exit(2);
    }
  } else if (!String(probe.stderr).includes('no live session matches this canonical worktree')) {
    process.stderr.write(String(probe.stderr) || 'SESSION_AUTHORITY_REQUIRED: rn-session lookup failed\n');
    process.exit(2);
  }
}
if (session && !sessionCli && typeof manifest.sessionCli === 'string' && fs.existsSync(manifest.sessionCli)) {
  sessionCli = manifest.sessionCli;
}

function ensureValue(flag, value) {
  const index = command.indexOf(flag);
  if (index >= 0) {
    if (command[index + 1] !== value) {
      process.stderr.write('SESSION_BUILD_IDENTITY_CONFLICT: ' + flag + ' contradicts the active session\n');
      process.exit(2);
    }
    return;
  }
  command.push(flag, value);
}
function ensureFlag(flag) {
  if (!command.includes(flag)) command.push(flag);
}

if (session) {
  if (session.platform !== platform || typeof session.deviceId !== 'string' || typeof session.appId !== 'string' || !Number.isInteger(session.metroPort) || typeof session.sessionId !== 'string' || typeof session.buildToken !== 'string') {
    process.stderr.write('SESSION_BUILD_IDENTITY_CONFLICT: session binding is incomplete\n');
    process.exit(2);
  }
  if (!sessionCli) {
    process.stderr.write('SESSION_AUTHORITY_REQUIRED: session build completion requires the package-local rn-session CLI\n');
    process.exit(2);
  }
  const offset = command[0] === 'npx' ? 1 : 0;
  const executable = command[offset];
  const subcommand = command[offset + 1];
  if (executable === 'expo' && subcommand === 'run:' + platform) {
    ensureValue('--device', session.deviceId);
    ensureValue('--port', String(session.metroPort));
    ensureFlag('--no-bundler');
  } else if (executable === 'react-native' && platform === 'ios' && subcommand === 'run-ios') {
    ensureValue('--udid', session.deviceId);
    ensureValue('--port', String(session.metroPort));
    ensureFlag('--no-packager');
  } else if (executable === 'react-native' && platform === 'android' && subcommand === 'run-android') {
    ensureValue('--deviceId', session.deviceId);
    ensureValue('--port', String(session.metroPort));
    ensureFlag('--no-packager');
  } else {
    process.stderr.write('SESSION_BUILD_COMMAND_UNSUPPORTED: command shape is not recognized\n');
    process.exit(2);
  }
}

const child = spawnSync(command[0], command.slice(1), {
  cwd: process.cwd(),
  env: session ? {
    ...process.env,
    RCT_METRO_PORT: String(session.metroPort),
    RN_DEV_AGENT_SESSION_ID: session.sessionId,
  } : process.env,
  stdio: 'inherit',
});
if (child.error) {
  process.stderr.write('rn-session-adapter: ' + child.error.message + '\n');
  process.exit(1);
}
if (child.status !== 0) process.exit(child.status === null ? 1 : child.status);
if (session) {
  const [major, minor] = process.versions.node.split('.').map(Number);
  const sqliteFlag = (major === 22 && minor >= 5) || (major === 23 && minor < 6)
    ? ['--experimental-sqlite']
    : [];
  const complete = spawnSync(process.execPath, [...sqliteFlag, sessionCli, 'complete-build', platform, session.buildToken], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      RN_DEV_AGENT_SESSION_ID: session.sessionId,
    },
    encoding: 'utf8',
  });
  if (complete.status !== 0) {
    process.stderr.write(String(complete.stderr) || 'APP_INSTALL_IDENTITY_CHANGED: build receipt could not be recorded\n');
    process.exit(2);
  }
  process.stdout.write(String(complete.stdout));
}
process.exit(0);
`;
}

interface FileSnapshot {
  path: string;
  contents: Buffer | null;
  mode: number;
}

interface BoundDirectory {
  descriptor: number;
  path: string;
  publicPath: string;
  identity: { dev: bigint; ino: bigint };
}

interface DescriptorFileSnapshot extends FileSnapshot {
  name: string;
}

interface DescriptorOperationResult {
  ok: boolean;
  code?: 'CONFLICT' | 'UNSAFE';
  message?: string;
  contents?: string | null;
  mode?: number;
}

const DESCRIPTOR_OPERATION = String.raw`
import base64
import json
import os
import stat
import sys
import uuid

class ConflictError(Exception):
    pass

request = json.load(sys.stdin)
directory_flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)

def validate_name(name):
    if not isinstance(name, str) or not name or os.path.basename(name) != name:
        raise ValueError("invalid integration filename")

def open_integration(create):
    if create:
        try:
            os.mkdir("integration", 0o700, dir_fd=3)
        except FileExistsError:
            pass
    return os.open("integration", directory_flags, dir_fd=3)

def read_file(directory, name):
    validate_name(name)
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    try:
        descriptor = os.open(name, flags, dir_fd=directory)
    except FileNotFoundError:
        return None
    try:
        identity = os.fstat(descriptor)
        if not stat.S_ISREG(identity.st_mode):
            raise ValueError("integration input is not a regular file")
        chunks = []
        while True:
            chunk = os.read(descriptor, 1024 * 1024)
            if not chunk:
                break
            chunks.append(chunk)
        return {
            "contents": base64.b64encode(b"".join(chunks)).decode("ascii"),
            "mode": stat.S_IMODE(identity.st_mode),
        }
    finally:
        os.close(descriptor)

def exists(directory, name):
    try:
        os.stat(name, dir_fd=directory, follow_symlinks=False)
        return True
    except FileNotFoundError:
        return False

def unlink_optional(directory, name):
    try:
        os.unlink(name, dir_fd=directory)
    except FileNotFoundError:
        pass

def cas(directory, name, expected, replacement, mode):
    validate_name(name)
    temporary = "." + str(uuid.uuid4()) + ".tmp"
    captured = "." + str(uuid.uuid4()) + ".captured"
    replacement_bytes = None if replacement is None else base64.b64decode(replacement)
    expected_bytes = None if expected is None else base64.b64decode(expected)
    if replacement_bytes is not None:
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(temporary, flags, mode, dir_fd=directory)
        try:
            view = memoryview(replacement_bytes)
            while view:
                written = os.write(descriptor, view)
                view = view[written:]
            os.fchmod(descriptor, mode)
        finally:
            os.close(descriptor)
    try:
        if expected_bytes is None:
            if read_file(directory, name) is not None:
                raise ConflictError("integration input changed before commit")
        else:
            try:
                os.rename(name, captured, src_dir_fd=directory, dst_dir_fd=directory)
            except FileNotFoundError as error:
                raise ConflictError("integration input changed before commit") from error
            observed = read_file(directory, captured)
            if observed is None or base64.b64decode(observed["contents"]) != expected_bytes:
                os.link(
                    captured,
                    name,
                    src_dir_fd=directory,
                    dst_dir_fd=directory,
                    follow_symlinks=False,
                )
                raise ConflictError("integration input changed before commit")
        if replacement_bytes is not None:
            try:
                os.link(
                    temporary,
                    name,
                    src_dir_fd=directory,
                    dst_dir_fd=directory,
                    follow_symlinks=False,
                )
            except FileExistsError as error:
                raise ConflictError("integration input changed before commit") from error
        if expected_bytes is not None:
            unlink_optional(directory, captured)
    finally:
        unlink_optional(directory, temporary)
        if exists(directory, captured):
            if not exists(directory, name):
                os.link(
                    captured,
                    name,
                    src_dir_fd=directory,
                    dst_dir_fd=directory,
                    follow_symlinks=False,
                )
            unlink_optional(directory, captured)

try:
    operation = request.get("operation")
    directory = open_integration(operation == "ensure")
    try:
        if operation == "ensure":
            result = {"ok": True}
        elif operation == "read":
            snapshot = read_file(directory, request.get("name"))
            result = {
                "ok": True,
                "contents": None if snapshot is None else snapshot["contents"],
                "mode": 0o600 if snapshot is None else snapshot["mode"],
            }
        elif operation == "cas":
            cas(
                directory,
                request.get("name"),
                request.get("expected"),
                request.get("replacement"),
                request.get("mode"),
            )
            result = {"ok": True}
        else:
            raise ValueError("invalid descriptor operation")
    finally:
        os.close(directory)
except ConflictError as error:
    result = {"ok": False, "code": "CONFLICT", "message": str(error)}
except Exception as error:
    result = {"ok": False, "code": "UNSAFE", "message": str(error)}

json.dump(result, sys.stdout)
`;

function runDescriptorOperation(
  directory: BoundDirectory,
  request: Record<string, unknown>,
): DescriptorOperationResult {
  if (process.platform === 'win32') {
    throw new Error(
      'SESSION_INTEGRATION_PATH_UNSAFE: descriptor-relative integration is unavailable',
    );
  }
  let output: string;
  try {
    output = execFileSync('python3', ['-c', DESCRIPTOR_OPERATION], {
      encoding: 'utf8',
      input: JSON.stringify(request),
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe', directory.descriptor],
      timeout: 5_000,
    });
  } catch {
    throw new Error(
      'SESSION_INTEGRATION_PATH_UNSAFE: descriptor-relative integration is unavailable',
    );
  }
  let result: DescriptorOperationResult;
  try {
    result = JSON.parse(output) as DescriptorOperationResult;
  } catch {
    throw new Error(
      'SESSION_INTEGRATION_PATH_UNSAFE: descriptor-relative integration returned invalid output',
    );
  }
  if (!result.ok) {
    const prefix =
      result.code === 'CONFLICT'
        ? 'SESSION_INTEGRATION_CONFLICT'
        : 'SESSION_INTEGRATION_PATH_UNSAFE';
    throw new Error(`${prefix}: ${result.message ?? 'descriptor-relative integration failed'}`);
  }
  return result;
}

function openBoundDirectory(path: string, publicPath = path): BoundDirectory {
  const before = lstatSync(path, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new Error('SESSION_INTEGRATION_PATH_UNSAFE: integration ancestor is not a directory');
  }
  const descriptor = openSync(
    path,
    constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
  );
  const opened = fstatSync(descriptor, { bigint: true });
  const after = lstatSync(path, { bigint: true });
  if (
    !opened.isDirectory() ||
    before.dev !== opened.dev ||
    before.ino !== opened.ino ||
    after.dev !== opened.dev ||
    after.ino !== opened.ino
  ) {
    closeSync(descriptor);
    throw new Error('SESSION_INTEGRATION_PATH_UNSAFE: integration ancestor changed while opening');
  }
  return {
    descriptor,
    path,
    publicPath,
    identity: { dev: opened.dev, ino: opened.ino },
  };
}

function assertBoundDirectoryCurrent(bound: BoundDirectory): void {
  const current = lstatSync(bound.publicPath, { bigint: true });
  if (
    !current.isDirectory() ||
    current.isSymbolicLink() ||
    current.dev !== bound.identity.dev ||
    current.ino !== bound.identity.ino
  ) {
    throw new Error('SESSION_INTEGRATION_PATH_UNSAFE: integration ancestor changed');
  }
}

function snapshotFiles(root: string, paths: readonly string[]): FileSnapshot[] {
  return paths.map((path) => {
    const contents = readOptionalRegularFile(root, path);
    return {
      path,
      contents: contents === undefined ? null : Buffer.from(contents),
      mode: contents === undefined ? 0o600 : statSync(path).mode & 0o777,
    };
  });
}

function casReplace(
  root: string,
  snapshot: FileSnapshot,
  expected: Buffer | null,
  next: Buffer | null,
  mode: number,
): void {
  const temporary = join(dirname(snapshot.path), `.${randomUUID()}.tmp`);
  const captured = join(dirname(snapshot.path), `.${randomUUID()}.captured`);
  if (next) {
    writeFileSync(temporary, next, { flag: 'wx', mode });
    chmodSync(temporary, mode);
  }
  try {
    if (expected === null) {
      if (readOptionalRegularFile(root, snapshot.path) !== undefined) {
        throw new Error('SESSION_INTEGRATION_CONFLICT: integration input changed before commit');
      }
    } else {
      renameSync(snapshot.path, captured);
      const observed = readRegularFile(root, captured);
      if (!expected.equals(Buffer.from(observed))) {
        linkSync(captured, snapshot.path);
        throw new Error('SESSION_INTEGRATION_CONFLICT: integration input changed before commit');
      }
    }
    if (next) {
      linkSync(temporary, snapshot.path);
    }
    if (expected !== null) rmSync(captured, { force: true });
  } finally {
    rmSync(temporary, { force: true });
    if (existsSync(captured)) {
      if (!existsSync(snapshot.path)) linkSync(captured, snapshot.path);
      rmSync(captured, { force: true });
    }
  }
}

function snapshotIntegrationFiles(
  directory: BoundDirectory,
  integrationPath: string,
  names: readonly string[],
): DescriptorFileSnapshot[] {
  return names.map((name) => {
    const result = runDescriptorOperation(directory, { operation: 'read', name });
    return {
      name,
      path: join(integrationPath, name),
      contents: result.contents === null ? null : Buffer.from(result.contents!, 'base64'),
      mode: result.mode ?? 0o600,
    };
  });
}

function casReplaceIntegration(
  directory: BoundDirectory,
  snapshot: DescriptorFileSnapshot,
  expected: Buffer | null,
  next: Buffer | null,
  mode: number,
): void {
  runDescriptorOperation(directory, {
    operation: 'cas',
    name: snapshot.name,
    expected: expected?.toString('base64') ?? null,
    replacement: next?.toString('base64') ?? null,
    mode,
  });
}

export function assertNoSymlinkPath(root: string, candidate: string): void {
  const child = relative(root, candidate);
  if (child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error('SESSION_INTEGRATION_PATH_UNSAFE: integration path escapes the app root');
  }
  let current = root;
  for (const component of [root, ...child.split(sep).filter(Boolean)]) {
    current = component === root ? root : join(current, component);
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw new Error('SESSION_INTEGRATION_PATH_UNSAFE: integration path is symlinked');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw error;
    }
  }
}

function regularFileIdentity(
  root: string,
  candidate: string,
): {
  dev: bigint;
  ino: bigint;
} {
  assertNoSymlinkPath(root, candidate);
  const identity = lstatSync(candidate, { bigint: true });
  if (!identity.isFile()) {
    throw new Error('SESSION_INTEGRATION_PATH_UNSAFE: integration input is not a regular file');
  }
  return { dev: identity.dev, ino: identity.ino };
}

function readRegularFile(root: string, candidate: string): string {
  const before = regularFileIdentity(root, candidate);
  const descriptor = openSync(
    candidate,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    const after = regularFileIdentity(root, candidate);
    if (
      !opened.isFile() ||
      before.dev !== opened.dev ||
      before.ino !== opened.ino ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino
    ) {
      throw new Error('SESSION_INTEGRATION_PATH_UNSAFE: integration input changed while opening');
    }
    return readFileSync(descriptor, 'utf8');
  } finally {
    closeSync(descriptor);
  }
}

function readOptionalRegularFile(
  root: string,
  candidate: string,
): string | undefined {
  try {
    return readRegularFile(root, candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export function readRegularFileNoFollow(root: string, candidate: string): string {
  return readRegularFile(root, candidate);
}

export function readOptionalRegularFileNoFollow(
  root: string,
  candidate: string,
): string | undefined {
  return readOptionalRegularFile(root, candidate);
}

function openIntegrationDirectories(appRoot: string): {
  agent: BoundDirectory;
  integrationPath: string;
} {
  const agentRoot = join(appRoot, '.rn-agent');
  try {
    mkdirSync(agentRoot, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const agent = openBoundDirectory(agentRoot);
  const integrationPath = join(agentRoot, 'integration');
  try {
    runDescriptorOperation(agent, { operation: 'ensure' });
    return { agent, integrationPath };
  } catch (error) {
    closeSync(agent.descriptor);
    throw error;
  }
}

interface PackageIntegrationDependencies {
  beforeCommit?: () => void;
  afterWrite?: (path: string) => void;
}

interface AppliedWrite {
  root: string;
  snapshot: FileSnapshot;
  written: Buffer | null;
  directory?: BoundDirectory;
}

function rollbackWrites(writes: readonly AppliedWrite[]): Error[] {
  const errors: Error[] = [];
  for (const write of [...writes].reverse()) {
    try {
      if (write.directory) {
        casReplaceIntegration(
          write.directory,
          write.snapshot as DescriptorFileSnapshot,
          write.written,
          write.snapshot.contents,
          write.snapshot.mode,
        );
      } else {
        casReplace(
          write.root,
          write.snapshot,
          write.written,
          write.snapshot.contents,
          write.snapshot.mode,
        );
      }
    } catch (error) {
      errors.push(error instanceof Error ? error : new Error(String(error)));
    }
  }
  return errors;
}

export function applyPackageIntegration(
  input: {
    appRoot: string;
    sessionCli: string;
  },
  dependencies: PackageIntegrationDependencies = {},
): PackageIntegrationPreview {
  const appRoot = resolve(input.appRoot);
  const packagePath = join(appRoot, 'package.json');
  let metroConfigPath: string | undefined;
  for (const path of ['metro.config.js', 'metro.config.cjs'].map((name) => join(appRoot, name))) {
    if (readOptionalRegularFileNoFollow(appRoot, path) !== undefined) {
      metroConfigPath = path;
      break;
    }
  }
  if (!metroConfigPath) {
    throw new Error(
      'BUNDLE_HANDSHAKE_UNAVAILABLE: metro.config.js or metro.config.cjs is required',
    );
  }
  const directories = openIntegrationDirectories(appRoot);
  const generatedNames = [
    'rn-session-integration.json',
    'rn-session-adapter.cjs',
    'rn-session-metro.cjs',
    'authority-marker.js',
  ] as const;
  const applied: AppliedWrite[] = [];
  try {
    const [packageSnapshot, metroSnapshot] = snapshotFiles(appRoot, [packagePath, metroConfigPath]);
    const generated = snapshotIntegrationFiles(
      directories.agent,
      directories.integrationPath,
      generatedNames,
    );
    if (!packageSnapshot?.contents || !metroSnapshot?.contents) {
      throw new Error('SESSION_INTEGRATION_CONFLICT: integration input changed before commit');
    }
    const packageJson = JSON.parse(packageSnapshot.contents.toString('utf8')) as PackageJson;
    let existing: PackageIntegrationManifest | undefined;
    if (generated[0]?.contents) {
      try {
        existing = JSON.parse(generated[0].contents.toString('utf8')) as PackageIntegrationManifest;
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
      }
    }
    const preview = previewPackageIntegration(packageJson, existing, input.sessionCli);
    const nextMetroSource = previewMetroIntegration(metroSnapshot.contents.toString('utf8'));
    preview.manifest.metroConfig = metroConfigPath.slice(appRoot.length + 1);
    dependencies.beforeCommit?.();
    const outputs: Array<{
      snapshot: DescriptorFileSnapshot;
      contents: Buffer;
      mode: number;
    }> = [
      {
        snapshot: generated[0]!,
        contents: Buffer.from(`${JSON.stringify(preview.manifest, null, 2)}\n`),
        mode: 0o600,
      },
      { snapshot: generated[1]!, contents: Buffer.from(renderProjectAdapter()), mode: 0o755 },
      {
        snapshot: generated[2]!,
        contents: Buffer.from(renderMetroIntegrationAdapter()),
        mode: 0o644,
      },
      {
        snapshot: generated[3]!,
        contents: Buffer.from(
          "globalThis.__RN_DEV_AGENT_AUTHORITY__={status:'unavailable',authorityScope:'initial-bundle',sourceFidelity:'not-proven'};\n",
        ),
        mode: 0o600,
      },
    ];
    for (const output of outputs) {
      assertBoundDirectoryCurrent(directories.agent);
      casReplaceIntegration(
        directories.agent,
        output.snapshot,
        output.snapshot.contents,
        output.contents,
        output.mode,
      );
      applied.push({
        root: directories.integrationPath,
        snapshot: output.snapshot,
        written: output.contents,
        directory: directories.agent,
      });
      dependencies.afterWrite?.(output.snapshot.path);
    }
    const metroOutput = Buffer.from(nextMetroSource);
    casReplace(appRoot, metroSnapshot, metroSnapshot.contents, metroOutput, 0o644);
    applied.push({ root: appRoot, snapshot: metroSnapshot, written: metroOutput });
    dependencies.afterWrite?.(metroConfigPath);
    const packageOutput = Buffer.from(`${JSON.stringify(preview.packageJson, null, 2)}\n`);
    casReplace(appRoot, packageSnapshot, packageSnapshot.contents, packageOutput, 0o644);
    applied.push({ root: appRoot, snapshot: packageSnapshot, written: packageOutput });
    dependencies.afterWrite?.(packagePath);
    assertBoundDirectoryCurrent(directories.agent);
    return preview;
  } catch (error) {
    const rollbackErrors = rollbackWrites(applied);
    if (rollbackErrors.length > 0) throw new AggregateError([error, ...rollbackErrors]);
    throw error;
  } finally {
    closeSync(directories.agent.descriptor);
  }
}

export function restorePackageIntegrationFiles(
  input: { appRoot: string },
  dependencies: PackageIntegrationDependencies = {},
): void {
  const appRoot = resolve(input.appRoot);
  const packagePath = join(appRoot, 'package.json');
  const directories = openIntegrationDirectories(appRoot);
  const generatedNames = [
    'rn-session-integration.json',
    'rn-session-adapter.cjs',
    'rn-session-metro.cjs',
    'authority-marker.js',
  ] as const;
  const applied: AppliedWrite[] = [];
  try {
    const generatedSnapshots = snapshotIntegrationFiles(
      directories.agent,
      directories.integrationPath,
      generatedNames,
    );
    if (!generatedSnapshots[0]?.contents) {
      throw new Error('SESSION_INTEGRATION_PATH_UNSAFE: integration manifest is missing');
    }
    const manifest = JSON.parse(
      generatedSnapshots[0].contents.toString('utf8'),
    ) as PackageIntegrationManifest;
    const metroConfig =
      manifest.metroConfig === undefined ? 'metro.config.js' : manifest.metroConfig;
    if (metroConfig !== 'metro.config.js' && metroConfig !== 'metro.config.cjs') {
      throw new Error(
        'SESSION_INTEGRATION_PATH_UNSAFE: manifest Metro config is not an expected app-root config',
      );
    }
    const metroConfigPath = join(appRoot, metroConfig);
    const [packageSnapshot, metroSnapshot] = snapshotFiles(appRoot, [packagePath, metroConfigPath]);
    if (!packageSnapshot?.contents || !metroSnapshot?.contents) {
      throw new Error('SESSION_INTEGRATION_CONFLICT: integration input changed before commit');
    }
    const packageJson = JSON.parse(packageSnapshot.contents.toString('utf8')) as PackageJson;
    const metroSource = metroSnapshot.contents.toString('utf8');
    dependencies.beforeCommit?.();
    const packageOutput = Buffer.from(
      `${JSON.stringify(restorePackageIntegration(packageJson, manifest), null, 2)}\n`,
    );
    casReplace(appRoot, packageSnapshot, packageSnapshot.contents, packageOutput, 0o644);
    applied.push({ root: appRoot, snapshot: packageSnapshot, written: packageOutput });
    dependencies.afterWrite?.(packagePath);
    const metroOutput = Buffer.from(restoreMetroIntegration(metroSource));
    casReplace(appRoot, metroSnapshot, metroSnapshot.contents, metroOutput, 0o644);
    applied.push({ root: appRoot, snapshot: metroSnapshot, written: metroOutput });
    dependencies.afterWrite?.(metroConfigPath);
    for (const snapshot of generatedSnapshots) {
      assertBoundDirectoryCurrent(directories.agent);
      casReplaceIntegration(directories.agent, snapshot, snapshot.contents, null, snapshot.mode);
      applied.push({
        root: directories.integrationPath,
        snapshot,
        written: null,
        directory: directories.agent,
      });
    }
    assertBoundDirectoryCurrent(directories.agent);
  } catch (error) {
    const rollbackErrors = rollbackWrites(applied);
    if (rollbackErrors.length > 0) throw new AggregateError([error, ...rollbackErrors]);
    throw error;
  } finally {
    closeSync(directories.agent.descriptor);
  }
}
