import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface BoundDirectoryWorker {
  child?: ChildProcess;
  controlPath: string;
  pid: number;
  sequence: number;
}

export interface BoundDirectory {
  descriptor?: number;
  identity: { dev: bigint; ino: bigint };
  name?: string;
  parent?: BoundDirectory;
  path: string;
  realPath: string;
  worker: BoundDirectoryWorker;
  closed: boolean;
}

export interface BoundFileSnapshot {
  contents: Buffer | null;
  mode: number;
  name: string;
}

export interface BoundFileWrite {
  expected: Buffer | null;
  expectedMode?: number;
  mode: number;
  name: string;
  replacement: Buffer | null;
}

interface BoundOperationResult {
  code?: 'CONFLICT' | 'UNSAFE';
  committed?: boolean;
  cleanupPending?: boolean;
  message?: string;
  ok: boolean;
  directoryIdentity?: { dev: string; ino: string; realPath: string };
  snapshots?: Array<{ contents: string | null; mode: number; name: string }>;
}

export interface BoundOperationDependencies {
  afterCaptureDelayMs?: number;
  afterReplacementDelayMs?: number;
  failCleanupAfterCommit?: boolean;
  recoveryDelayAfterUnlinkMs?: number;
  recoveryTimeoutMs?: number;
  timeoutMs?: number;
}

const WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));

const BOUND_DIRECTORY_WORKER = String.raw`
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

class ConflictError extends Error {}

const controlPath = process.argv[1];
const binding = JSON.parse(Buffer.from(process.argv[2], 'base64url').toString('utf8'));
process.on('disconnect', () => process.exit(0));

function wait(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function validateName(name) {
  if (
    typeof name !== 'string' ||
    name.length === 0 ||
    name === '.' ||
    name === '..' ||
    path.basename(name) !== name
  ) {
    throw new Error('invalid bound-directory filename');
  }
}

function assertBoundDirectory() {
  const current = fs.statSync('.', { bigint: true });
  if (
    !current.isDirectory() ||
    current.dev.toString() !== binding.dev ||
    current.ino.toString() !== binding.ino ||
    fs.realpathSync('.') !== binding.realPath
  ) {
    throw new Error('bound-directory identity changed');
  }
}

function readRegularFile(name) {
  validateName(name);
  let before;
  try {
    before = fs.lstatSync(name, { bigint: true });
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error('bound-directory input is not a regular file');
  }
  const descriptor = fs.openSync(
    name,
    fs.constants.O_RDONLY |
      (fs.constants.O_NOFOLLOW || 0) |
      (fs.constants.O_NONBLOCK || 0),
  );
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    const after = fs.lstatSync(name, { bigint: true });
    if (
      !opened.isFile() ||
      before.dev !== opened.dev ||
      before.ino !== opened.ino ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino
    ) {
      throw new Error('bound-directory input changed while opening');
    }
    return {
      contents: fs.readFileSync(descriptor).toString('base64'),
      dev: opened.dev.toString(),
      ino: opened.ino.toString(),
      mode: Number(opened.mode & 0o777n),
      name,
    };
  } finally {
    fs.closeSync(descriptor);
  }
}

function sameContentsAndMode(snapshot, encoded, mode) {
  return (
    snapshot !== null &&
    encoded !== null &&
    (mode === undefined || process.platform === 'win32' || snapshot.mode === mode) &&
    Buffer.from(encoded, 'base64').equals(Buffer.from(snapshot.contents, 'base64'))
  );
}

function sameIdentity(left, right) {
  return (
    left !== null &&
    right !== null &&
    left.dev === right.dev &&
    left.ino === right.ino
  );
}

function removeOptional(name) {
  try {
    fs.unlinkSync(name);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function writeJournal(name, value, exclusive) {
  validateName(name);
  const contents = JSON.stringify(value);
  if (exclusive) {
    fs.writeFileSync(name, contents, { flag: 'wx', mode: 0o600, flush: true });
    return;
  }
  const temporary = name + '.next';
  removeOptional(temporary);
  fs.writeFileSync(temporary, contents, { flag: 'wx', mode: 0o600, flush: true });
  fs.renameSync(temporary, name);
}

function readJournal(name) {
  validateName(name);
  try {
    const snapshot = readRegularFile(name);
    return snapshot === null
      ? null
      : JSON.parse(Buffer.from(snapshot.contents, 'base64').toString('utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function validateWrite(write) {
  validateName(write.name);
  validateName(write.temporary);
  validateName(write.captured);
}

function prepareReplacement(write) {
  if (write.replacement === null) return;
  fs.writeFileSync(write.temporary, Buffer.from(write.replacement, 'base64'), {
    flag: 'wx',
    mode: write.mode,
  });
  fs.chmodSync(write.temporary, write.mode);
}

function applyWrite(write) {
  validateWrite(write);
  prepareReplacement(write);
  if (write.expected === null) {
    if (readRegularFile(write.name) !== null) {
      throw new ConflictError('bound-directory input changed before commit');
    }
  } else {
    try {
      fs.renameSync(write.name, write.captured);
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new ConflictError('bound-directory input changed before commit');
      }
      throw error;
    }
    if (write.afterCaptureDelayMs > 0) wait(write.afterCaptureDelayMs);
    const observed = readRegularFile(write.captured);
    if (!sameContentsAndMode(observed, write.expected, write.expectedMode)) {
      throw new ConflictError('bound-directory input changed before commit');
    }
  }
  if (write.replacement !== null) {
    try {
      fs.linkSync(write.temporary, write.name);
    } catch (error) {
      if (error.code === 'EEXIST') {
        throw new ConflictError('bound-directory input changed before commit');
      }
      throw error;
    }
  }
  if (write.afterReplacementDelayMs > 0) wait(write.afterReplacementDelayMs);
}

function cleanupArtifacts(writes) {
  for (const write of writes) {
    removeOptional(write.temporary);
    removeOptional(write.captured);
  }
}

function cleanupJournal(name) {
  removeOptional(name + '.next');
  removeOptional(name);
}

function rollbackOwnedWrites(writes, recoveryDelayAfterUnlinkMs) {
  for (const write of [...writes].reverse()) {
    validateWrite(write);
    const captured = readRegularFile(write.captured);
    const temporary = readRegularFile(write.temporary);
    const target = readRegularFile(write.name);
    if (captured !== null) {
      if (target === null) {
        fs.linkSync(write.captured, write.name);
      } else if (!sameIdentity(target, captured)) {
        if (!sameIdentity(target, temporary)) {
          throw new ConflictError('bound-directory input changed during recovery');
        }
        fs.unlinkSync(write.name);
        if (recoveryDelayAfterUnlinkMs > 0) wait(recoveryDelayAfterUnlinkMs);
        fs.linkSync(write.captured, write.name);
      }
      removeOptional(write.captured);
      removeOptional(write.temporary);
      continue;
    }
    if (write.expected === null && sameIdentity(target, temporary)) {
      fs.unlinkSync(write.name);
    }
    removeOptional(write.temporary);
  }
}

function allReplacementsPresent(writes) {
  return writes.every((write) => {
    const target = readRegularFile(write.name);
    return write.replacement === null
      ? target === null
      : sameContentsAndMode(target, write.replacement, write.mode);
  });
}

function recoverTransaction(journalName, requestedWrites, recoveryDelayAfterUnlinkMs = 0) {
  const journal = readJournal(journalName);
  if (journal === null) {
    return { committed: allReplacementsPresent(requestedWrites) };
  }
  if (
    journal.version !== 1 ||
    journal.name !== journalName ||
    JSON.stringify(journal.writes) !== JSON.stringify(requestedWrites)
  ) {
    throw new Error('bound-directory transaction journal is invalid');
  }
  if (journal.state === 'committed') {
    cleanupArtifacts(journal.writes);
    cleanupJournal(journalName);
    return { committed: true };
  }
  if (journal.state !== 'applying') {
    throw new Error('bound-directory transaction state is invalid');
  }
  rollbackOwnedWrites(journal.writes, recoveryDelayAfterUnlinkMs);
  cleanupJournal(journalName);
  return { committed: false };
}

function applyBatch(request) {
  const journal = {
    version: 1,
    name: request.journal,
    state: 'applying',
    writes: request.writes,
  };
  writeJournal(request.journal, journal, true);
  try {
    for (const write of request.writes) applyWrite(write);
    journal.state = 'committed';
    writeJournal(request.journal, journal, false);
    try {
      if (request.failCleanupAfterCommit) {
        throw new Error('bound-directory cleanup unavailable');
      }
      cleanupArtifacts(request.writes);
      return { committed: true };
    } catch {
      return { cleanupPending: true, committed: true };
    }
  } catch (error) {
    try {
      recoverTransaction(request.journal, request.writes);
    } catch (recoveryError) {
      throw new AggregateError([error, recoveryError]);
    }
    throw error;
  }
}

function spawnChildWorker(request, directory) {
  const childBinding = Buffer.from(
    JSON.stringify({
      dev: directory.dev.toString(),
      ino: directory.ino.toString(),
      realPath: fs.realpathSync(request.name),
    }),
  ).toString('base64url');
  const child = childProcess.spawn(
    process.execPath,
    [...process.execArgv, request.controlPath, childBinding],
    {
      cwd: request.name,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    },
  );
  child.on('error', () => {});
  child.channel?.unref();
  child.unref();
}

function execute(request) {
  assertBoundDirectory();
  if (request.operation === 'directory') {
    validateName(request.name);
    if (request.create) {
      try {
        fs.mkdirSync(request.name, { mode: request.mode });
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    }
    const directory = fs.lstatSync(request.name, { bigint: true });
    if (!directory.isDirectory() || directory.isSymbolicLink()) {
      throw new Error('bound-directory child is not a directory');
    }
    spawnChildWorker(request, directory);
    return {
      directoryIdentity: {
        dev: directory.dev.toString(),
        ino: directory.ino.toString(),
        realPath: fs.realpathSync(request.name),
      },
    };
  }
  if (request.operation === 'read') {
    return {
      snapshots: request.names.map((name) => {
        const snapshot = readRegularFile(name);
        return snapshot ?? { contents: null, mode: 0o600, name };
      }),
    };
  }
  if (request.operation === 'cas') {
    return applyBatch(request);
  }
  if (request.operation === 'recover') {
    return recoverTransaction(
      request.journal,
      request.writes,
      request.recoveryDelayAfterUnlinkMs,
    );
  }
  if (request.operation === 'identity') return {};
  throw new Error('invalid bound-directory operation');
}

function respond(requestPath, responsePath) {
  let response;
  let request;
  try {
    request = JSON.parse(fs.readFileSync(requestPath, 'utf8'));
    response = { ok: true, ...execute(request) };
  } catch (error) {
    const conflict =
      error instanceof ConflictError ||
      (error instanceof AggregateError &&
        error.errors.some((entry) => entry instanceof ConflictError));
    response = {
      ok: false,
      code: conflict ? 'CONFLICT' : 'UNSAFE',
      message: error instanceof Error ? error.message : String(error),
    };
  }
  const temporary = responsePath + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(response), { flag: 'wx', mode: 0o600 });
  fs.renameSync(temporary, responsePath);
  if (request?.operation === 'cas' && response.ok && !response.cleanupPending) {
    cleanupJournal(request.journal);
  }
  removeOptional(requestPath);
}

async function run() {
  assertBoundDirectory();
  fs.writeFileSync(
    path.join(controlPath, 'ready'),
    JSON.stringify({ ok: true, pid: process.pid }),
    {
      flag: 'wx',
      mode: 0o600,
    },
  );
  while (!fs.existsSync(path.join(controlPath, 'stop'))) {
    for (const entry of fs.readdirSync(controlPath)) {
      if (!entry.endsWith('.request')) continue;
      const requestPath = path.join(controlPath, entry);
      const responsePath = path.join(controlPath, entry.replace(/\.request$/, '.response'));
      respond(requestPath, responsePath);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

run().catch((error) => {
  try {
    fs.writeFileSync(
      path.join(controlPath, 'ready'),
      JSON.stringify({
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      }),
      { flag: 'wx', mode: 0o600 },
    );
  } catch {}
  process.exitCode = 1;
});
`;

function sameIdentity(
  left: { dev: bigint; ino: bigint },
  right: { dev: bigint; ino: bigint },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function waitForFile(path: string, timeoutMs: number): boolean {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    Atomics.wait(WAIT_BUFFER, 0, 0, 5);
  }
  return existsSync(path);
}

function stopWorker(worker: BoundDirectoryWorker, signal: NodeJS.Signals = 'SIGTERM'): void {
  try {
    writeFileSync(join(worker.controlPath, 'stop'), '', { flag: 'wx', mode: 0o600 });
  } catch {}
  try {
    process.kill(worker.pid, signal);
  } catch {}
  rmSync(worker.controlPath, { force: true, recursive: true });
}

function bindWorker(controlPath: string, child?: ChildProcess): BoundDirectoryWorker {
  const readyPath = join(controlPath, 'ready');
  if (!waitForFile(readyPath, 5_000)) {
    child?.kill('SIGKILL');
    rmSync(controlPath, { force: true, recursive: true });
    throw new Error('SESSION_INTEGRATION_PATH_UNSAFE: bound-directory worker unavailable');
  }
  let ready: { ok?: unknown; pid?: unknown };
  try {
    ready = JSON.parse(readFileSync(readyPath, 'utf8')) as { ok?: unknown; pid?: unknown };
  } catch {
    child?.kill('SIGKILL');
    rmSync(controlPath, { force: true, recursive: true });
    throw new Error('SESSION_INTEGRATION_PATH_UNSAFE: bound-directory worker unavailable');
  }
  if (
    ready.ok !== true ||
    typeof ready.pid !== 'number' ||
    !Number.isSafeInteger(ready.pid) ||
    ready.pid <= 0 ||
    (child?.pid !== undefined && child.pid !== ready.pid)
  ) {
    child?.kill('SIGKILL');
    rmSync(controlPath, { force: true, recursive: true });
    throw new Error('SESSION_INTEGRATION_PATH_UNSAFE: bound-directory worker rejected path');
  }
  return { child, controlPath, pid: ready.pid, sequence: 0 };
}

function startWorker(
  path: string,
  identity: { dev: bigint; ino: bigint },
  realPath: string,
): BoundDirectoryWorker {
  const controlPath = mkdtempSync(join(tmpdir(), 'rn-bound-directory-'));
  const binding = Buffer.from(
    JSON.stringify({
      dev: identity.dev.toString(),
      ino: identity.ino.toString(),
      realPath,
    }),
  ).toString('base64url');
  const child = spawn(process.execPath, ['-e', BOUND_DIRECTORY_WORKER, controlPath, binding], {
    cwd: path,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  child.on('error', () => {});
  child.channel?.unref();
  child.unref();
  return bindWorker(controlPath, child);
}

function startSubdirectoryWorker(
  parent: BoundDirectory,
  name: string,
  expectedIdentity: { dev: bigint; ino: bigint },
  expectedRealPath: string,
): BoundDirectoryWorker {
  const controlPath = mkdtempSync(join(tmpdir(), 'rn-bound-directory-'));
  let worker: BoundDirectoryWorker | undefined;
  try {
    const result = runBoundOperation(parent, {
      operation: 'directory',
      controlPath,
      name,
      create: false,
      mode: 0o700,
    });
    worker = bindWorker(controlPath);
    if (
      !result.directoryIdentity ||
      BigInt(result.directoryIdentity.dev) !== expectedIdentity.dev ||
      BigInt(result.directoryIdentity.ino) !== expectedIdentity.ino ||
      result.directoryIdentity.realPath !== expectedRealPath
    ) {
      throw new Error('SESSION_INTEGRATION_PATH_UNSAFE: bound-directory child identity changed');
    }
    return worker;
  } catch (error) {
    if (worker) stopWorker(worker, 'SIGKILL');
    else rmSync(controlPath, { force: true, recursive: true });
    throw error;
  }
}

function restartWorker(directory: BoundDirectory): void {
  stopWorker(directory.worker, 'SIGKILL');
  if (directory.parent && directory.name) {
    directory.worker = startSubdirectoryWorker(
      directory.parent,
      directory.name,
      directory.identity,
      directory.realPath,
    );
    return;
  }
  directory.worker = startWorker(directory.path, directory.identity, directory.realPath);
}

function sendOperation(
  directory: BoundDirectory,
  request: Record<string, unknown>,
  timeoutMs: number,
): BoundOperationResult {
  const sequence = ++directory.worker.sequence;
  const prefix = String(sequence).padStart(8, '0');
  const pendingPath = join(directory.worker.controlPath, `${prefix}.pending`);
  const requestPath = join(directory.worker.controlPath, `${prefix}.request`);
  const responsePath = join(directory.worker.controlPath, `${prefix}.response`);
  writeFileSync(pendingPath, JSON.stringify(request), { flag: 'wx', mode: 0o600 });
  renameSync(pendingPath, requestPath);
  if (!waitForFile(responsePath, timeoutMs)) {
    throw new Error('SESSION_INTEGRATION_WORKER_TIMEOUT');
  }
  let result: BoundOperationResult;
  try {
    result = JSON.parse(readFileSync(responsePath, 'utf8')) as BoundOperationResult;
  } catch {
    throw new Error(
      'SESSION_INTEGRATION_PATH_UNSAFE: bound-directory operation returned invalid output',
    );
  } finally {
    rmSync(responsePath, { force: true });
  }
  return result;
}

function throwOperationFailure(result: BoundOperationResult): never {
  const prefix =
    result.code === 'CONFLICT' ? 'SESSION_INTEGRATION_CONFLICT' : 'SESSION_INTEGRATION_PATH_UNSAFE';
  throw new Error(`${prefix}: ${result.message ?? 'bound-directory operation failed'}`);
}

function runBoundOperation(
  directory: BoundDirectory,
  request: Record<string, unknown>,
  dependencies: BoundOperationDependencies = {},
): BoundOperationResult {
  if (directory.closed) {
    throw new Error('SESSION_INTEGRATION_PATH_UNSAFE: bound directory is closed');
  }
  if (directory.descriptor !== undefined) {
    const retained = fstatSync(directory.descriptor, { bigint: true });
    if (
      !retained.isDirectory() ||
      retained.dev !== directory.identity.dev ||
      retained.ino !== directory.identity.ino
    ) {
      throw new Error('SESSION_INTEGRATION_PATH_UNSAFE: retained directory identity changed');
    }
  }
  let current;
  let currentRealPath;
  try {
    current = lstatSync(directory.path, { bigint: true });
    currentRealPath = realpathSync(directory.path);
  } catch {
    throw new Error('SESSION_INTEGRATION_PATH_UNSAFE: bound directory path is unavailable');
  }
  if (
    !current.isDirectory() ||
    current.isSymbolicLink() ||
    !sameIdentity(current, directory.identity) ||
    currentRealPath !== directory.realPath
  ) {
    throw new Error('SESSION_INTEGRATION_PATH_UNSAFE: bound directory path changed');
  }
  try {
    const result = sendOperation(directory, request, dependencies.timeoutMs ?? 5_000);
    if (!result.ok) throwOperationFailure(result);
    if (request.operation === 'cas' && result.cleanupPending) {
      try {
        sendOperation(
          directory,
          {
            operation: 'recover',
            journal: request.journal,
            writes: request.writes,
          },
          dependencies.recoveryTimeoutMs ?? 5_000,
        );
      } catch {}
    }
    return result;
  } catch (error) {
    if (
      request.operation !== 'cas' ||
      !(error instanceof Error) ||
      error.message !== 'SESSION_INTEGRATION_WORKER_TIMEOUT'
    ) {
      throw error;
    }
    restartWorker(directory);
    let recovery: BoundOperationResult | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        recovery = sendOperation(
          directory,
          {
            operation: 'recover',
            journal: request.journal,
            writes: request.writes,
            recoveryDelayAfterUnlinkMs: dependencies.recoveryDelayAfterUnlinkMs ?? 0,
          },
          dependencies.recoveryTimeoutMs ?? 5_000,
        );
        if (!recovery.ok) throwOperationFailure(recovery);
        break;
      } catch (recoveryError) {
        if (
          !(recoveryError instanceof Error) ||
          recoveryError.message !== 'SESSION_INTEGRATION_WORKER_TIMEOUT'
        ) {
          throw recoveryError;
        }
        restartWorker(directory);
      }
    }
    if (!recovery) {
      throw new Error('SESSION_INTEGRATION_PATH_UNSAFE: bound-directory recovery failed');
    }
    if (recovery.committed) return recovery;
    throw new Error('SESSION_INTEGRATION_PATH_UNSAFE: bound-directory operation unavailable');
  }
}

function openValidatedDirectory(
  path: string,
  expected?: { identity: { dev: bigint; ino: bigint }; realPath: string },
): BoundDirectory {
  let descriptor: number | undefined;
  let worker: BoundDirectoryWorker | undefined;
  try {
    const before = lstatSync(path, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink()) {
      throw new Error('SESSION_INTEGRATION_PATH_UNSAFE: integration ancestor is not a directory');
    }
    descriptor = openSync(
      path,
      constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
    );
    const opened = fstatSync(descriptor, { bigint: true });
    const after = lstatSync(path, { bigint: true });
    const realPath = realpathSync(path);
    if (
      !opened.isDirectory() ||
      !sameIdentity(before, opened) ||
      !sameIdentity(after, opened) ||
      (expected !== undefined &&
        (!sameIdentity(expected.identity, opened) || expected.realPath !== realPath))
    ) {
      throw new Error(
        'SESSION_INTEGRATION_PATH_UNSAFE: integration ancestor changed while opening',
      );
    }
    const identity = { dev: opened.dev, ino: opened.ino };
    worker = startWorker(path, identity, realPath);
    return {
      descriptor,
      identity,
      path,
      realPath,
      worker,
      closed: false,
    };
  } catch (error) {
    if (worker !== undefined) stopWorker(worker, 'SIGKILL');
    if (descriptor !== undefined) closeSync(descriptor);
    if (error instanceof Error && error.message.includes('SESSION_INTEGRATION_PATH_UNSAFE')) {
      throw error;
    }
    throw new Error('SESSION_INTEGRATION_PATH_UNSAFE: integration ancestor is unavailable');
  }
}

export function openBoundDirectory(path: string): BoundDirectory {
  return openValidatedDirectory(path);
}

export function closeBoundDirectory(directory: BoundDirectory): void {
  if (directory.closed) return;
  directory.closed = true;
  stopWorker(directory.worker);
  if (directory.descriptor !== undefined) closeSync(directory.descriptor);
}

export function assertBoundDirectoryCurrent(directory: BoundDirectory): void {
  runBoundOperation(directory, { operation: 'identity' });
}

export function openBoundSubdirectory(
  parent: BoundDirectory,
  name: string,
  options: { afterChildBind?: () => void; create?: boolean; mode?: number } = {},
): BoundDirectory {
  const controlPath = mkdtempSync(join(tmpdir(), 'rn-bound-directory-'));
  let worker: BoundDirectoryWorker | undefined;
  try {
    const result = runBoundOperation(parent, {
      operation: 'directory',
      controlPath,
      name,
      create: options.create ?? false,
      mode: options.mode ?? 0o700,
    });
    worker = bindWorker(controlPath);
    options.afterChildBind?.();
    if (!result.directoryIdentity) {
      throw new Error(
        'SESSION_INTEGRATION_PATH_UNSAFE: bound-directory traversal returned invalid output',
      );
    }
    const directory: BoundDirectory = {
      identity: {
        dev: BigInt(result.directoryIdentity.dev),
        ino: BigInt(result.directoryIdentity.ino),
      },
      name,
      parent,
      path: join(parent.path, name),
      realPath: result.directoryIdentity.realPath,
      worker,
      closed: false,
    };
    assertBoundDirectoryCurrent(parent);
    assertBoundDirectoryCurrent(directory);
    return directory;
  } catch (error) {
    if (worker) stopWorker(worker, 'SIGKILL');
    else rmSync(controlPath, { force: true, recursive: true });
    throw error;
  }
}

export function readBoundDirectoryFiles(
  directory: BoundDirectory,
  names: readonly string[],
): BoundFileSnapshot[] {
  const result = runBoundOperation(directory, { operation: 'read', names });
  if (!result.snapshots || result.snapshots.length !== names.length) {
    throw new Error(
      'SESSION_INTEGRATION_PATH_UNSAFE: bound-directory read returned invalid output',
    );
  }
  return result.snapshots.map((snapshot) => ({
    contents: snapshot.contents === null ? null : Buffer.from(snapshot.contents, 'base64'),
    mode: snapshot.mode,
    name: snapshot.name,
  }));
}

export function casBoundDirectoryFiles(
  directory: BoundDirectory,
  writes: readonly BoundFileWrite[],
  dependencies: BoundOperationDependencies = {},
): void {
  const transactionId = randomUUID();
  runBoundOperation(
    directory,
    {
      operation: 'cas',
      journal: `.rn-bound-${transactionId}.journal`,
      writes: writes.map((write, index) => ({
        expected: write.expected?.toString('base64') ?? null,
        expectedMode: write.expectedMode,
        mode: write.mode,
        name: write.name,
        replacement: write.replacement?.toString('base64') ?? null,
        temporary: `.rn-bound-${transactionId}-${index}.tmp`,
        captured: `.rn-bound-${transactionId}-${index}.captured`,
        afterCaptureDelayMs: dependencies.afterCaptureDelayMs ?? 0,
        afterReplacementDelayMs: dependencies.afterReplacementDelayMs ?? 0,
      })),
      failCleanupAfterCommit: dependencies.failCleanupAfterCommit ?? false,
    },
    dependencies,
  );
}

export function writeBoundDirectoryFile(
  directory: BoundDirectory,
  name: string,
  contents: Buffer,
  mode: number,
  dependencies: { beforeCommit?: () => void } = {},
): void {
  const [snapshot] = readBoundDirectoryFiles(directory, [name]);
  dependencies.beforeCommit?.();
  casBoundDirectoryFiles(directory, [
    {
      expected: snapshot!.contents,
      expectedMode: snapshot!.mode,
      mode,
      name,
      replacement: contents,
    },
  ]);
}
