import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync, } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeProcessBirth } from './process-birth.js';
const WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));
const BOUND_DIRECTORY_WORKER = String.raw `
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

class ConflictError extends Error {}

const controlPath = process.argv[1];
const binding = JSON.parse(Buffer.from(process.argv[2], 'base64url').toString('utf8'));
const childWorkers = new Map();
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
  for (const ancestor of binding.ancestors) {
    const publicPath = fs.lstatSync(ancestor.publicPath, { bigint: true });
    if (
      !publicPath.isDirectory() ||
      publicPath.isSymbolicLink() ||
      publicPath.dev.toString() !== ancestor.dev ||
      publicPath.ino.toString() !== ancestor.ino ||
      fs.realpathSync(ancestor.publicPath) !== ancestor.realPath
    ) {
      throw new Error('bound-directory ancestor changed');
    }
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
    (mode === undefined ||
      (process.platform === 'win32'
        ? ((snapshot.mode & 0o222) !== 0) === ((mode & 0o222) !== 0)
        : snapshot.mode === mode)) &&
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
  const existing = childWorkers.get(request.childId);
  if (existing) {
    existing.kill('SIGKILL');
    childWorkers.delete(request.childId);
  }
  const childBinding = Buffer.from(
    JSON.stringify({
      dev: directory.dev.toString(),
      ino: directory.ino.toString(),
      ancestors: [
        ...binding.ancestors,
        {
          dev: directory.dev.toString(),
          ino: directory.ino.toString(),
          publicPath: request.publicPath,
          realPath: directory.realPath,
        },
      ],
      publicPath: request.publicPath,
      realPath: directory.realPath,
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
  child.on('exit', () => {
    if (childWorkers.get(request.childId) === child) {
      childWorkers.delete(request.childId);
    }
  });
  child.channel?.unref();
  child.unref();
  childWorkers.set(request.childId, child);
}

function stopChildWorker(request) {
  const child = childWorkers.get(request.childId);
  if (!child) return {};
  try {
    fs.writeFileSync(path.join(request.controlPath, 'stop'), '', {
      flag: 'wx',
      mode: 0o600,
    });
  } catch {}
  child.kill(request.signal);
  childWorkers.delete(request.childId);
  return {};
}

function execute(request) {
  if (request.operation === 'child-stop') {
    return stopChildWorker(request);
  }
  assertBoundDirectory();
  if (request.operation === 'directory') {
    validateName(request.childId);
    validateName(request.name);
    if (request.create) {
      try {
        fs.mkdirSync(request.name, { mode: request.mode });
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    }
    let before;
    try {
      before = fs.lstatSync(request.name, { bigint: true });
    } catch (error) {
      if (request.optional && error.code === 'ENOENT') {
        return { directoryMissing: true };
      }
      throw error;
    }
    if (!before.isDirectory() || before.isSymbolicLink()) {
      throw new Error('bound-directory child is not a directory');
    }
    const realPath = fs.realpathSync(request.name);
    if (realPath !== path.join(binding.realPath, request.name)) {
      throw new Error('bound-directory child escaped retained parent');
    }
    const after = fs.lstatSync(request.name, { bigint: true });
    if (
      !after.isDirectory() ||
      after.isSymbolicLink() ||
      before.dev !== after.dev ||
      before.ino !== after.ino
    ) {
      throw new Error('bound-directory child changed while binding');
    }
    const directory = { dev: after.dev, ino: after.ino, realPath };
    spawnChildWorker(request, directory);
    return {
      directoryIdentity: {
        dev: directory.dev.toString(),
        ino: directory.ino.toString(),
        realPath,
      },
    };
  }
  if (request.operation === 'child-identity') {
    const child = childWorkers.get(request.childId);
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      throw new Error('bound-directory child worker is unavailable');
    }
    return {};
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
    if (request.cleanupRecoveryDelayMs) wait(request.cleanupRecoveryDelayMs);
    if (request.failCleanupRecovery) {
      throw new Error('bound-directory cleanup recovery unavailable');
    }
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
function workerProcessStopped(worker) {
    const probe = probeProcessBirth(worker.pid);
    if (probe.status === 'absent' ||
        (probe.status === 'present' && probe.birth.token !== worker.birth.token)) {
        return true;
    }
    if (probe.status !== 'present')
        return false;
    try {
        if (process.platform === 'linux') {
            const stat = readFileSync(`/proc/${worker.pid}/stat`, 'utf8');
            const commandEnd = stat.lastIndexOf(')');
            const state = commandEnd >= 0
                ? stat
                    .slice(commandEnd + 1)
                    .trim()
                    .split(/\s+/, 1)[0]
                : '';
            return state === 'Z' || state === 'X';
        }
        if (process.platform === 'darwin') {
            const state = execFileSync('/bin/ps', ['-o', 'stat=', '-p', String(worker.pid)], {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore'],
                timeout: 2_000,
            }).trim();
            return state.startsWith('Z');
        }
    }
    catch {
        return false;
    }
    return false;
}
function waitForWorkerExit(worker, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (workerProcessStopped(worker))
            return true;
        Atomics.wait(WAIT_BUFFER, 0, 0, 10);
    }
    return workerProcessStopped(worker);
}
function signalWorker(worker, signal) {
    if (workerProcessStopped(worker))
        return false;
    const probe = probeProcessBirth(worker.pid);
    if (probe.status === 'absent')
        return false;
    if (probe.status === 'present' && probe.birth.token !== worker.birth.token)
        return false;
    if (probe.status !== 'present') {
        throw new Error('SESSION_INTEGRATION_PATH_UNSAFE: bound-directory worker identity is inconclusive');
    }
    process.kill(worker.pid, signal);
    return true;
}
function stopWorker(worker, signal = 'SIGTERM') {
    try {
        writeFileSync(join(worker.controlPath, 'stop'), '', { flag: 'wx', mode: 0o600 });
    }
    catch { }
    const signaled = signalWorker(worker, signal);
    if (signaled && !waitForWorkerExit(worker, 5_000)) {
        if (signal !== 'SIGKILL') {
            signalWorker(worker, 'SIGKILL');
        }
        if (!waitForWorkerExit(worker, 5_000)) {
            throw new Error('SESSION_INTEGRATION_PATH_UNSAFE: bound-directory worker exit was not confirmed');
        }
    }
    rmSync(worker.controlPath, { force: true, recursive: true });
}
function bindWorker(controlPath, child, owner, childId) {
    const readyPath = join(controlPath, 'ready');
    if (!waitForFile(readyPath, 5_000)) {
        child?.kill('SIGKILL');
        rmSync(controlPath, { force: true, recursive: true });
        throw new Error('SESSION_INTEGRATION_PATH_UNSAFE: bound-directory worker unavailable');
    }
    let ready;
    try {
        ready = JSON.parse(readFileSync(readyPath, 'utf8'));
    }
    catch {
        child?.kill('SIGKILL');
        rmSync(controlPath, { force: true, recursive: true });
        throw new Error('SESSION_INTEGRATION_PATH_UNSAFE: bound-directory worker unavailable');
    }
    if (ready.ok !== true ||
        typeof ready.pid !== 'number' ||
        !Number.isSafeInteger(ready.pid) ||
        ready.pid <= 0 ||
        (child?.pid !== undefined && child.pid !== ready.pid)) {
        child?.kill('SIGKILL');
        rmSync(controlPath, { force: true, recursive: true });
        throw new Error('SESSION_INTEGRATION_PATH_UNSAFE: bound-directory worker rejected path');
    }
    const birthProbe = probeProcessBirth(ready.pid);
    if (birthProbe.status !== 'present') {
        child?.kill('SIGKILL');
        throw new Error('SESSION_INTEGRATION_PATH_UNSAFE: bound-directory worker identity is unavailable');
    }
    return {
        birth: birthProbe.birth,
        child,
        childId,
        controlPath,
        owner,
        pid: ready.pid,
        sequence: 0,
    };
}
function startWorker(path, identity, realPath) {
    const controlPath = mkdtempSync(join(tmpdir(), 'rn-bound-directory-'));
    const binding = Buffer.from(JSON.stringify({
        dev: identity.dev.toString(),
        ino: identity.ino.toString(),
        ancestors: [
            {
                dev: identity.dev.toString(),
                ino: identity.ino.toString(),
                publicPath: path,
                realPath,
            },
        ],
        publicPath: path,
        realPath,
    })).toString('base64url');
    const child = spawn(process.execPath, ['-e', BOUND_DIRECTORY_WORKER, controlPath, binding], {
        cwd: path,
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    child.on('error', () => { });
    child.channel?.unref();
    child.unref();
    return bindWorker(controlPath, child);
}
function startSubdirectoryWorker(parent, name, expectedIdentity, expectedRealPath) {
    const controlPath = mkdtempSync(join(tmpdir(), 'rn-bound-directory-'));
    const childId = randomUUID();
    let worker;
    try {
        const result = runBoundOperation(parent, {
            operation: 'directory',
            childId,
            controlPath,
            name,
            publicPath: join(parent.path, name),
            create: false,
            mode: 0o700,
        });
        worker = bindWorker(controlPath, undefined, parent, childId);
        if (!result.directoryIdentity ||
            BigInt(result.directoryIdentity.dev) !== expectedIdentity.dev ||
            BigInt(result.directoryIdentity.ino) !== expectedIdentity.ino ||
            result.directoryIdentity.realPath !== expectedRealPath) {
            throw new Error('SESSION_INTEGRATION_PATH_UNSAFE: bound-directory child identity changed');
        }
        return worker;
    }
    catch (error) {
        if (worker)
            stopWorker(worker, 'SIGKILL');
        else {
            try {
                sendOperation(parent, {
                    operation: 'child-stop',
                    childId,
                    controlPath,
                    signal: 'SIGKILL',
                }, 5_000);
            }
            catch { }
            rmSync(controlPath, { force: true, recursive: true });
        }
        throw error;
    }
}
function restartWorker(directory) {
    const descendants = [...directory.children];
    stopDescendantWorkers(directory);
    stopWorker(directory.worker, 'SIGKILL');
    if (directory.parent && directory.name) {
        directory.worker = startSubdirectoryWorker(directory.parent, directory.name, directory.identity, directory.realPath);
    }
    else {
        directory.worker = startWorker(directory.path, directory.identity, directory.realPath);
    }
    for (const descendant of descendants) {
        rmSync(descendant.worker.controlPath, { force: true, recursive: true });
        descendant.worker = startSubdirectoryWorker(directory, descendant.name, descendant.identity, descendant.realPath);
        rebindDescendants(descendant);
    }
}
function stopDescendantWorkers(directory) {
    for (const descendant of directory.children) {
        stopDescendantWorkers(descendant);
        stopWorker(descendant.worker, 'SIGKILL');
    }
}
function rebindDescendants(directory) {
    for (const descendant of directory.children) {
        rmSync(descendant.worker.controlPath, { force: true, recursive: true });
        descendant.worker = startSubdirectoryWorker(directory, descendant.name, descendant.identity, descendant.realPath);
        rebindDescendants(descendant);
    }
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
    if (directory.descriptor !== undefined) {
        const retained = fstatSync(directory.descriptor, { bigint: true });
        if (!retained.isDirectory() ||
            retained.dev !== directory.identity.dev ||
            retained.ino !== directory.identity.ino) {
            throw new Error('SESSION_INTEGRATION_PATH_UNSAFE: retained directory identity changed');
        }
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
        if (request.operation === 'cas' && result.cleanupPending) {
            try {
                const cleanup = sendOperation(directory, {
                    operation: 'recover',
                    failCleanupRecovery: dependencies.failCleanupRecovery ?? false,
                    cleanupRecoveryDelayMs: dependencies.cleanupRecoveryDelayMs ?? 0,
                    journal: request.journal,
                    writes: request.writes,
                }, dependencies.recoveryTimeoutMs ?? 5_000);
                if (!cleanup.ok)
                    throwOperationFailure(cleanup);
                if (!cleanup.committed) {
                    throw new Error('SESSION_INTEGRATION_PATH_UNSAFE: committed bound-directory cleanup was not preserved');
                }
                return { ...result, cleanupPending: false };
            }
            catch (cleanupError) {
                if (cleanupError instanceof Error &&
                    cleanupError.message === 'SESSION_INTEGRATION_WORKER_TIMEOUT') {
                    restartWorker(directory);
                    const cleanup = sendOperation(directory, {
                        operation: 'recover',
                        failCleanupRecovery: dependencies.failCleanupRecovery ?? false,
                        journal: request.journal,
                        writes: request.writes,
                    }, dependencies.recoveryTimeoutMs ?? 5_000);
                    if (!cleanup.ok)
                        throwOperationFailure(cleanup);
                    if (!cleanup.committed) {
                        throw new Error('SESSION_INTEGRATION_PATH_UNSAFE: committed bound-directory cleanup was not preserved');
                    }
                    return { ...result, cleanupPending: false };
                }
                return {
                    ...result,
                    cleanupError: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
                };
            }
        }
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
            children: new Set(),
            descriptor,
            identity,
            path,
            pendingCleanups: new Map(),
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
    const cleanupErrors = [];
    for (const transactionId of directory.pendingCleanups.keys()) {
        try {
            retryBoundDirectoryCleanup(directory, { transactionId });
        }
        catch (error) {
            cleanupErrors.push(new Error(`bound-directory cleanup ${transactionId} failed: ${error instanceof Error ? error.message : String(error)}`));
        }
    }
    directory.closed = true;
    try {
        stopWorker(directory.worker);
    }
    catch (error) {
        cleanupErrors.push(error instanceof Error ? error : new Error(`bound-directory close failed: ${String(error)}`));
    }
    directory.parent?.children.delete(directory);
    if (directory.descriptor !== undefined)
        closeSync(directory.descriptor);
    if (cleanupErrors.length > 0) {
        throw new AggregateError(cleanupErrors, 'bound-directory cleanup failed');
    }
}
export function assertBoundDirectoryCurrent(directory) {
    runBoundOperation(directory, { operation: 'identity' });
}
function openBoundSubdirectoryInternal(parent, name, options = {}) {
    const controlPath = mkdtempSync(join(tmpdir(), 'rn-bound-directory-'));
    const childId = randomUUID();
    let worker;
    try {
        const result = runBoundOperation(parent, {
            operation: 'directory',
            childId,
            controlPath,
            name,
            publicPath: join(parent.path, name),
            create: options.create ?? false,
            mode: options.mode ?? 0o700,
            optional: options.optional ?? false,
        });
        if (result.directoryMissing) {
            rmSync(controlPath, { force: true, recursive: true });
            return null;
        }
        worker = bindWorker(controlPath, undefined, parent, childId);
        options.afterChildBind?.();
        if (!result.directoryIdentity) {
            throw new Error('SESSION_INTEGRATION_PATH_UNSAFE: bound-directory traversal returned invalid output');
        }
        const directory = {
            children: new Set(),
            identity: {
                dev: BigInt(result.directoryIdentity.dev),
                ino: BigInt(result.directoryIdentity.ino),
            },
            name,
            parent,
            path: join(parent.path, name),
            pendingCleanups: new Map(),
            realPath: result.directoryIdentity.realPath,
            worker,
            closed: false,
        };
        runBoundOperation(parent, { operation: 'child-identity', childId });
        parent.children.add(directory);
        return directory;
    }
    catch (error) {
        if (worker)
            stopWorker(worker, 'SIGKILL');
        else {
            try {
                sendOperation(parent, {
                    operation: 'child-stop',
                    childId,
                    controlPath,
                    signal: 'SIGKILL',
                }, 5_000);
            }
            catch { }
            rmSync(controlPath, { force: true, recursive: true });
        }
        throw error;
    }
}
export function openBoundSubdirectory(parent, name, options = {}) {
    return openBoundSubdirectoryInternal(parent, name, options);
}
export function openOptionalBoundSubdirectory(parent, name) {
    return openBoundSubdirectoryInternal(parent, name, { optional: true });
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
    const journal = `.rn-bound-${transactionId}.journal`;
    const serializedWrites = writes.map((write, index) => ({
        expected: write.expected?.toString('base64') ?? null,
        expectedMode: write.expectedMode,
        mode: write.mode,
        name: write.name,
        replacement: write.replacement?.toString('base64') ?? null,
        temporary: `.rn-bound-${transactionId}-${index}.tmp`,
        captured: `.rn-bound-${transactionId}-${index}.captured`,
        afterCaptureDelayMs: dependencies.afterCaptureDelayMs ?? 0,
        afterReplacementDelayMs: dependencies.afterReplacementDelayMs ?? 0,
    }));
    const result = runBoundOperation(directory, {
        operation: 'cas',
        journal,
        writes: serializedWrites,
        failCleanupAfterCommit: dependencies.failCleanupAfterCommit ?? false,
    }, dependencies);
    if (!result.committed) {
        throw new Error('SESSION_INTEGRATION_PATH_UNSAFE: bound-directory commit was not confirmed');
    }
    if (result.cleanupPending) {
        directory.pendingCleanups.set(transactionId, {
            journal,
            writes: serializedWrites,
        });
    }
    else {
        directory.pendingCleanups.delete(transactionId);
    }
    return {
        committed: true,
        cleanupPending: result.cleanupPending ?? false,
        ...(result.cleanupPending ? { cleanupObligation: { transactionId } } : {}),
        ...(result.cleanupError ? { cleanupError: result.cleanupError } : {}),
    };
}
export function retryBoundDirectoryCleanup(directory, obligation, dependencies = {}) {
    const transaction = directory.pendingCleanups.get(obligation.transactionId);
    if (!transaction) {
        throw new Error('SESSION_INTEGRATION_PATH_UNSAFE: bound-directory cleanup obligation is unavailable');
    }
    const request = {
        operation: 'recover',
        journal: transaction.journal,
        writes: transaction.writes,
    };
    let result;
    try {
        result = runBoundOperation(directory, request, dependencies);
    }
    catch (error) {
        if (!(error instanceof Error) || error.message !== 'SESSION_INTEGRATION_WORKER_TIMEOUT') {
            throw error;
        }
        restartWorker(directory);
        result = runBoundOperation(directory, request, {
            ...dependencies,
            cleanupRecoveryDelayMs: 0,
        });
    }
    if (!result.committed) {
        throw new Error('SESSION_INTEGRATION_PATH_UNSAFE: committed bound-directory cleanup was not preserved');
    }
    directory.pendingCleanups.delete(obligation.transactionId);
}
export function writeBoundDirectoryFile(directory, name, contents, mode, dependencies = {}) {
    const [snapshot] = readBoundDirectoryFiles(directory, [name]);
    dependencies.beforeCommit?.();
    const result = casBoundDirectoryFiles(directory, [
        {
            expected: snapshot.contents,
            expectedMode: snapshot.mode,
            mode,
            name,
            replacement: contents,
        },
    ]);
    if (result.cleanupPending) {
        throw new Error(`SESSION_INTEGRATION_PATH_UNSAFE: committed cleanup remains pending: ${result.cleanupObligation?.transactionId ?? 'unknown transaction'}: ${result.cleanupError ?? 'cleanup unavailable'}`);
    }
    return result;
}
