import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
const BOUND_DIRECTORY_WORKER = String.raw `
const fs = require('node:fs');
const path = require('node:path');

class ConflictError extends Error {}

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
      mode: Number(opened.mode & 0o777n),
      name,
    };
  } finally {
    fs.closeSync(descriptor);
  }
}

function exists(name) {
  try {
    fs.lstatSync(name);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function removeOptional(name) {
  try {
    fs.unlinkSync(name);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function sameContents(snapshot, expected) {
  return (
    snapshot !== null &&
    expected !== null &&
    expected.equals(Buffer.from(snapshot.contents, 'base64'))
  );
}

function casReplace(write) {
  validateName(write.name);
  validateName(write.temporary);
  validateName(write.captured);
  const temporary = write.temporary;
  const captured = write.captured;
  const expected =
    write.expected === null ? null : Buffer.from(write.expected, 'base64');
  const replacement =
    write.replacement === null ? null : Buffer.from(write.replacement, 'base64');
  if (replacement !== null) {
    fs.writeFileSync(temporary, replacement, { flag: 'wx', mode: write.mode });
    fs.chmodSync(temporary, write.mode);
  }
  try {
    if (expected === null) {
      if (readRegularFile(write.name) !== null) {
        throw new ConflictError('bound-directory input changed before commit');
      }
    } else {
      try {
        fs.renameSync(write.name, captured);
      } catch (error) {
        if (error.code === 'ENOENT') {
          throw new ConflictError('bound-directory input changed before commit');
        }
        throw error;
      }
      if (write.afterCaptureDelayMs > 0) {
        Atomics.wait(
          new Int32Array(new SharedArrayBuffer(4)),
          0,
          0,
          write.afterCaptureDelayMs,
        );
      }
      const observed = readRegularFile(captured);
      if (
        observed === null ||
        !expected.equals(Buffer.from(observed.contents, 'base64'))
      ) {
        fs.linkSync(captured, write.name);
        throw new ConflictError('bound-directory input changed before commit');
      }
    }
    if (replacement !== null) {
      try {
        fs.linkSync(temporary, write.name);
      } catch (error) {
        if (error.code === 'EEXIST') {
          throw new ConflictError('bound-directory input changed before commit');
        }
        throw error;
      }
    }
    if (expected !== null) removeOptional(captured);
  } finally {
    removeOptional(temporary);
    if (exists(captured)) {
      if (!exists(write.name)) fs.linkSync(captured, write.name);
      removeOptional(captured);
    }
  }
}

function restoreExpected(write) {
  validateName(write.name);
  validateName(write.temporary);
  validateName(write.captured);
  validateName(write.rollbackTemporary);
  validateName(write.rollbackCaptured);
  const expected =
    write.expected === null ? null : Buffer.from(write.expected, 'base64');
  const replacement =
    write.replacement === null ? null : Buffer.from(write.replacement, 'base64');
  const target = readRegularFile(write.name);
  const captured = readRegularFile(write.captured);
  if (
    (expected === null && target === null) ||
    sameContents(target, expected)
  ) {
    removeOptional(write.temporary);
    removeOptional(write.captured);
    removeOptional(write.rollbackTemporary);
    removeOptional(write.rollbackCaptured);
    return;
  }
  if (target === null && sameContents(captured, expected)) {
    fs.linkSync(write.captured, write.name);
    removeOptional(write.temporary);
    removeOptional(write.captured);
    removeOptional(write.rollbackTemporary);
    removeOptional(write.rollbackCaptured);
    return;
  }
  if (target !== null && !sameContents(target, replacement)) {
    throw new ConflictError('bound-directory input changed during recovery');
  }
  casReplace({
    expected: target === null ? null : write.replacement,
    mode: write.originalMode,
    name: write.name,
    replacement: write.expected,
    temporary: write.rollbackTemporary,
    captured: write.rollbackCaptured,
    afterCaptureDelayMs: 0,
  });
  removeOptional(write.temporary);
  removeOptional(write.captured);
}

function applyBatch(writes) {
  const applied = [];
  try {
    for (const write of writes) {
      casReplace(write);
      applied.push(write);
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const write of applied.reverse()) {
      try {
        casReplace({
          expected: write.replacement,
          mode: write.originalMode,
          name: write.name,
          replacement: write.expected,
          temporary: write.rollbackTemporary,
          captured: write.rollbackCaptured,
          afterCaptureDelayMs: 0,
        });
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError([error, ...rollbackErrors]);
    }
    throw error;
  }
}

function enterBoundDirectory(binding) {
  const current = fs.statSync('.', { bigint: true });
  if (
    !current.isDirectory() ||
    current.dev.toString() !== binding.rootIdentity.dev ||
    current.ino.toString() !== binding.rootIdentity.ino ||
    fs.realpathSync('.') !== binding.rootRealPath
  ) {
    throw new Error('bound-directory identity changed');
  }
  for (const segment of binding.segments) {
    validateName(segment);
    const child = fs.lstatSync(segment, { bigint: true });
    if (!child.isDirectory() || child.isSymbolicLink()) {
      throw new Error('bound-directory child is not a directory');
    }
    process.chdir(segment);
  }
  const bound = fs.statSync('.', { bigint: true });
  if (
    !bound.isDirectory() ||
    bound.dev.toString() !== binding.identity.dev ||
    bound.ino.toString() !== binding.identity.ino
  ) {
    throw new Error('bound-directory child identity changed');
  }
}

try {
  const request = JSON.parse(fs.readFileSync(0, 'utf8'));
  enterBoundDirectory(request.binding);
  let directoryIdentity;
  let snapshots;
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
    directoryIdentity = {
      dev: directory.dev.toString(),
      ino: directory.ino.toString(),
    };
  } else if (request.operation === 'read') {
    snapshots = request.names.map((name) => {
      const snapshot = readRegularFile(name);
      return snapshot ?? { contents: null, mode: 0o600, name };
    });
  } else if (request.operation === 'cas') {
    applyBatch(request.writes);
  } else if (request.operation === 'recover') {
    for (const write of [...request.writes].reverse()) restoreExpected(write);
  } else if (request.operation === 'identity') {
  } else {
    throw new Error('invalid bound-directory operation');
  }
  process.stdout.write(JSON.stringify({ ok: true, directoryIdentity, snapshots }));
} catch (error) {
  const conflict =
    error instanceof ConflictError ||
    (error instanceof AggregateError &&
      error.errors.some((entry) => entry instanceof ConflictError));
  process.stdout.write(
    JSON.stringify({
      ok: false,
      code: conflict ? 'CONFLICT' : 'UNSAFE',
      message: error instanceof Error ? error.message : String(error),
    }),
  );
}
`;
function sameIdentity(left, right) {
    return left.dev === right.dev && left.ino === right.ino;
}
function runBoundOperation(directory, request, dependencies = {}) {
    if (directory.closed) {
        throw new Error('SESSION_INTEGRATION_PATH_UNSAFE: bound directory is closed');
    }
    const retained = fstatSync(directory.root.descriptor, { bigint: true });
    if (!retained.isDirectory() ||
        retained.dev !== directory.root.identity.dev ||
        retained.ino !== directory.root.identity.ino) {
        throw new Error('SESSION_INTEGRATION_PATH_UNSAFE: retained directory identity changed');
    }
    const binding = {
        rootIdentity: {
            dev: retained.dev.toString(),
            ino: retained.ino.toString(),
        },
        rootRealPath: directory.root.realPath,
        segments: directory.segments,
        identity: {
            dev: directory.identity.dev.toString(),
            ino: directory.identity.ino.toString(),
        },
    };
    const input = JSON.stringify({ ...request, binding });
    let output;
    try {
        output = execFileSync(process.execPath, ['-e', BOUND_DIRECTORY_WORKER], {
            cwd: directory.root.path,
            encoding: 'utf8',
            input,
            maxBuffer: 16 * 1024 * 1024,
            timeout: dependencies.timeoutMs ?? 5_000,
        });
    }
    catch {
        let recoveryFailed = false;
        if (request.operation === 'cas') {
            try {
                const recoveryOutput = execFileSync(process.execPath, ['-e', BOUND_DIRECTORY_WORKER], {
                    cwd: directory.root.path,
                    encoding: 'utf8',
                    input: JSON.stringify({
                        operation: 'recover',
                        writes: request.writes,
                        binding,
                    }),
                    maxBuffer: 16 * 1024 * 1024,
                    timeout: 5_000,
                });
                const recovery = JSON.parse(recoveryOutput);
                recoveryFailed = !recovery.ok;
            }
            catch {
                recoveryFailed = true;
            }
        }
        throw new Error(recoveryFailed
            ? 'SESSION_INTEGRATION_PATH_UNSAFE: bound-directory recovery failed'
            : 'SESSION_INTEGRATION_PATH_UNSAFE: bound-directory operation unavailable');
    }
    let result;
    try {
        result = JSON.parse(output);
    }
    catch {
        throw new Error('SESSION_INTEGRATION_PATH_UNSAFE: bound-directory operation returned invalid output');
    }
    if (!result.ok) {
        const prefix = result.code === 'CONFLICT'
            ? 'SESSION_INTEGRATION_CONFLICT'
            : 'SESSION_INTEGRATION_PATH_UNSAFE';
        throw new Error(`${prefix}: ${result.message ?? 'bound-directory operation failed'}`);
    }
    return result;
}
export function openBoundDirectory(path) {
    let descriptor;
    try {
        const before = lstatSync(path, { bigint: true });
        if (!before.isDirectory() || before.isSymbolicLink()) {
            throw new Error('SESSION_INTEGRATION_PATH_UNSAFE: integration ancestor is not a directory');
        }
        descriptor = openSync(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
        const opened = fstatSync(descriptor, { bigint: true });
        const after = lstatSync(path, { bigint: true });
        const realPath = realpathSync(path);
        if (!opened.isDirectory() || !sameIdentity(before, opened) || !sameIdentity(after, opened)) {
            throw new Error('SESSION_INTEGRATION_PATH_UNSAFE: integration ancestor changed while opening');
        }
        const root = {
            descriptor,
            identity: { dev: opened.dev, ino: opened.ino },
            path,
            realPath,
            references: 1,
        };
        return {
            descriptor,
            identity: root.identity,
            path,
            root,
            segments: [],
            closed: false,
        };
    }
    catch (error) {
        if (descriptor !== undefined)
            closeSync(descriptor);
        if (error instanceof Error && error.message.includes('SESSION_INTEGRATION_PATH_UNSAFE')) {
            throw error;
        }
        throw new Error('SESSION_INTEGRATION_PATH_UNSAFE: integration ancestor is unavailable');
    }
}
export function closeBoundDirectory(directory) {
    if (directory.closed)
        return;
    directory.closed = true;
    directory.root.references -= 1;
    if (directory.root.references === 0)
        closeSync(directory.root.descriptor);
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
    parent.root.references += 1;
    return {
        descriptor: parent.root.descriptor,
        identity: {
            dev: BigInt(result.directoryIdentity.dev),
            ino: BigInt(result.directoryIdentity.ino),
        },
        path: join(parent.path, name),
        root: parent.root,
        segments: [...parent.segments, name],
        closed: false,
    };
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
        writes: writes.map((write, index) => ({
            expected: write.expected?.toString('base64') ?? null,
            mode: write.mode,
            name: write.name,
            originalMode: write.expectedMode ?? write.mode,
            replacement: write.replacement?.toString('base64') ?? null,
            temporary: `.${transactionId}-${index}.tmp`,
            captured: `.${transactionId}-${index}.captured`,
            rollbackTemporary: `.${transactionId}-${index}.rollback.tmp`,
            rollbackCaptured: `.${transactionId}-${index}.rollback.captured`,
            afterCaptureDelayMs: dependencies.afterCaptureDelayMs ?? 0,
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
