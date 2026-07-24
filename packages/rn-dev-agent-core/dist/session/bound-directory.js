import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync, } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));
const BOUND_DIRECTORY_WORKER = String.raw `
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
    snapshot.mode === mode &&
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
    cleanupArtifacts(request.writes);
  } catch (error) {
    try {
      recoverTransaction(request.journal, request.writes);
    } catch (recoveryError) {
      throw new AggregateError([error, recoveryError]);
    }
    throw error;
  }
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
    applyBatch(request);
    return {};
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
  if (request?.operation === 'cas' && response.ok) {
    cleanupJournal(request.journal);
  }
  removeOptional(requestPath);
}

try {
  assertBoundDirectory();
  fs.writeFileSync(path.join(controlPath, 'ready'), JSON.stringify({ ok: true }), {
    flag: 'wx',
    mode: 0o600,
  });
  while (!fs.existsSync(path.join(controlPath, 'stop'))) {
    for (const entry of fs.readdirSync(controlPath)) {
      if (!entry.endsWith('.request')) continue;
      const requestPath = path.join(controlPath, entry);
      const responsePath = path.join(controlPath, entry.replace(/\.request$/, '.response'));
      respond(requestPath, responsePath);
    }
    wait(5);
  }
} catch (error) {
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
}
`;
function sameIdentity(left, right) {
    return left.dev === right.dev && left.ino === right.ino;
}
function waitForFile(path, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (existsSync(path))
            return true;
        Atomics.wait(WAIT_BUFFER, 0, 0, 5);
    }
    return existsSync(path);
}
function stopWorker(worker, signal = 'SIGTERM') {
    try {
        writeFileSync(join(worker.controlPath, 'stop'), '', { flag: 'wx', mode: 0o600 });
    }
    catch { }
    worker.child.kill(signal);
    rmSync(worker.controlPath, { force: true, recursive: true });
}
function startWorker(path, identity, realPath) {
    const controlPath = mkdtempSync(join(tmpdir(), 'rn-bound-directory-'));
    const binding = Buffer.from(JSON.stringify({
        dev: identity.dev.toString(),
        ino: identity.ino.toString(),
        realPath,
    })).toString('base64url');
    const child = spawn(process.execPath, ['-e', BOUND_DIRECTORY_WORKER, controlPath, binding], {
        cwd: path,
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    child.on('error', () => { });
    child.channel?.unref();
    child.unref();
    const worker = { child, controlPath, sequence: 0 };
    const readyPath = join(controlPath, 'ready');
    if (!waitForFile(readyPath, 5_000)) {
        stopWorker(worker, 'SIGKILL');
        throw new Error('SESSION_INTEGRATION_PATH_UNSAFE: bound-directory worker unavailable');
    }
    let ready;
    try {
        ready = JSON.parse(readFileSync(readyPath, 'utf8'));
    }
    catch {
        stopWorker(worker, 'SIGKILL');
        throw new Error('SESSION_INTEGRATION_PATH_UNSAFE: bound-directory worker unavailable');
    }
    if (ready.ok !== true) {
        stopWorker(worker, 'SIGKILL');
        throw new Error('SESSION_INTEGRATION_PATH_UNSAFE: bound-directory worker rejected path');
    }
    return worker;
}
function restartWorker(directory) {
    stopWorker(directory.worker, 'SIGKILL');
    directory.worker = startWorker(directory.path, directory.identity, directory.realPath);
}
function sendOperation(directory, request, timeoutMs) {
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
    let result;
    try {
        result = JSON.parse(readFileSync(responsePath, 'utf8'));
    }
    catch {
        throw new Error('SESSION_INTEGRATION_PATH_UNSAFE: bound-directory operation returned invalid output');
    }
    finally {
        rmSync(responsePath, { force: true });
    }
    return result;
}
function throwOperationFailure(result) {
    const prefix = result.code === 'CONFLICT' ? 'SESSION_INTEGRATION_CONFLICT' : 'SESSION_INTEGRATION_PATH_UNSAFE';
    throw new Error(`${prefix}: ${result.message ?? 'bound-directory operation failed'}`);
}
function runBoundOperation(directory, request, dependencies = {}) {
    if (directory.closed) {
        throw new Error('SESSION_INTEGRATION_PATH_UNSAFE: bound directory is closed');
    }
    const retained = fstatSync(directory.descriptor, { bigint: true });
    if (!retained.isDirectory() ||
        retained.dev !== directory.identity.dev ||
        retained.ino !== directory.identity.ino) {
        throw new Error('SESSION_INTEGRATION_PATH_UNSAFE: retained directory identity changed');
    }
    let current;
    let currentRealPath;
    try {
        current = lstatSync(directory.path, { bigint: true });
        currentRealPath = realpathSync(directory.path);
    }
    catch {
        throw new Error('SESSION_INTEGRATION_PATH_UNSAFE: bound directory path is unavailable');
    }
    if (!current.isDirectory() ||
        current.isSymbolicLink() ||
        !sameIdentity(current, directory.identity) ||
        currentRealPath !== directory.realPath) {
        throw new Error('SESSION_INTEGRATION_PATH_UNSAFE: bound directory path changed');
    }
    try {
        const result = sendOperation(directory, request, dependencies.timeoutMs ?? 5_000);
        if (!result.ok)
            throwOperationFailure(result);
        return result;
    }
    catch (error) {
        if (request.operation !== 'cas' ||
            !(error instanceof Error) ||
            error.message !== 'SESSION_INTEGRATION_WORKER_TIMEOUT') {
            throw error;
        }
        restartWorker(directory);
        let recovery;
        for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
                recovery = sendOperation(directory, {
                    operation: 'recover',
                    journal: request.journal,
                    writes: request.writes,
                    recoveryDelayAfterUnlinkMs: dependencies.recoveryDelayAfterUnlinkMs ?? 0,
                }, dependencies.recoveryTimeoutMs ?? 5_000);
                if (!recovery.ok)
                    throwOperationFailure(recovery);
                break;
            }
            catch (recoveryError) {
                if (!(recoveryError instanceof Error) ||
                    recoveryError.message !== 'SESSION_INTEGRATION_WORKER_TIMEOUT') {
                    throw recoveryError;
                }
                restartWorker(directory);
            }
        }
        if (!recovery) {
            throw new Error('SESSION_INTEGRATION_PATH_UNSAFE: bound-directory recovery failed');
        }
        if (recovery.committed)
            return recovery;
        throw new Error('SESSION_INTEGRATION_PATH_UNSAFE: bound-directory operation unavailable');
    }
}
function openValidatedDirectory(path, expected) {
    let descriptor;
    let worker;
    try {
        const before = lstatSync(path, { bigint: true });
        if (!before.isDirectory() || before.isSymbolicLink()) {
            throw new Error('SESSION_INTEGRATION_PATH_UNSAFE: integration ancestor is not a directory');
        }
        descriptor = openSync(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
        const opened = fstatSync(descriptor, { bigint: true });
        const after = lstatSync(path, { bigint: true });
        const realPath = realpathSync(path);
        if (!opened.isDirectory() ||
            !sameIdentity(before, opened) ||
            !sameIdentity(after, opened) ||
            (expected !== undefined &&
                (!sameIdentity(expected.identity, opened) || expected.realPath !== realPath))) {
            throw new Error('SESSION_INTEGRATION_PATH_UNSAFE: integration ancestor changed while opening');
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
    }
    catch (error) {
        if (worker !== undefined)
            stopWorker(worker, 'SIGKILL');
        if (descriptor !== undefined)
            closeSync(descriptor);
        if (error instanceof Error && error.message.includes('SESSION_INTEGRATION_PATH_UNSAFE')) {
            throw error;
        }
        throw new Error('SESSION_INTEGRATION_PATH_UNSAFE: integration ancestor is unavailable');
    }
}
export function openBoundDirectory(path) {
    return openValidatedDirectory(path);
}
export function closeBoundDirectory(directory) {
    if (directory.closed)
        return;
    directory.closed = true;
    stopWorker(directory.worker);
    closeSync(directory.descriptor);
}
export function assertBoundDirectoryCurrent(directory) {
    runBoundOperation(directory, { operation: 'identity' });
}
export function openBoundSubdirectory(parent, name, options = {}) {
    const result = runBoundOperation(parent, {
        operation: 'directory',
        name,
        create: options.create ?? false,
        mode: options.mode ?? 0o700,
    });
    if (!result.directoryIdentity) {
        throw new Error('SESSION_INTEGRATION_PATH_UNSAFE: bound-directory traversal returned invalid output');
    }
    return openValidatedDirectory(join(parent.path, name), {
        identity: {
            dev: BigInt(result.directoryIdentity.dev),
            ino: BigInt(result.directoryIdentity.ino),
        },
        realPath: result.directoryIdentity.realPath,
    });
}
export function readBoundDirectoryFiles(directory, names) {
    const result = runBoundOperation(directory, { operation: 'read', names });
    if (!result.snapshots || result.snapshots.length !== names.length) {
        throw new Error('SESSION_INTEGRATION_PATH_UNSAFE: bound-directory read returned invalid output');
    }
    return result.snapshots.map((snapshot) => ({
        contents: snapshot.contents === null ? null : Buffer.from(snapshot.contents, 'base64'),
        mode: snapshot.mode,
        name: snapshot.name,
    }));
}
export function casBoundDirectoryFiles(directory, writes, dependencies = {}) {
    const transactionId = randomUUID();
    runBoundOperation(directory, {
        operation: 'cas',
        journal: `.rn-bound-${transactionId}.journal`,
        writes: writes.map((write, index) => ({
            expected: write.expected?.toString('base64') ?? null,
            expectedMode: write.expectedMode ?? write.mode,
            mode: write.mode,
            name: write.name,
            replacement: write.replacement?.toString('base64') ?? null,
            temporary: `.rn-bound-${transactionId}-${index}.tmp`,
            captured: `.rn-bound-${transactionId}-${index}.captured`,
            afterCaptureDelayMs: dependencies.afterCaptureDelayMs ?? 0,
            afterReplacementDelayMs: dependencies.afterReplacementDelayMs ?? 0,
        })),
    }, dependencies);
}
export function writeBoundDirectoryFile(directory, name, contents, mode, dependencies = {}) {
    const [snapshot] = readBoundDirectoryFiles(directory, [name]);
    dependencies.beforeCommit?.();
    casBoundDirectoryFiles(directory, [
        {
            expected: snapshot.contents,
            expectedMode: snapshot.mode,
            mode,
            name,
            replacement: contents,
        },
    ]);
}
