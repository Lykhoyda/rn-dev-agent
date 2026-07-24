import { execFileSync } from 'node:child_process';
import { closeSync, constants, fstatSync, lstatSync, openSync } from 'node:fs';
import { join } from 'node:path';

export interface BoundDirectory {
  descriptor: number;
  identity: { dev: bigint; ino: bigint };
  path: string;
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
  message?: string;
  ok: boolean;
  directoryIdentity?: { dev: string; ino: string };
  snapshots?: Array<{ contents: string | null; mode: number; name: string }>;
}

const BOUND_DIRECTORY_WORKER = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

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

function casReplace(write) {
  validateName(write.name);
  const temporary = '.' + crypto.randomUUID() + '.tmp';
  const captured = '.' + crypto.randomUUID() + '.captured';
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

function assertIdentity(expected) {
  const current = fs.statSync('.', { bigint: true });
  if (
    !current.isDirectory() ||
    current.dev.toString() !== expected.dev ||
    current.ino.toString() !== expected.ino
  ) {
    throw new Error('bound-directory identity changed');
  }
}

try {
  const request = JSON.parse(fs.readFileSync(0, 'utf8'));
  assertIdentity(request.identity);
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

function sameIdentity(
  left: { dev: bigint; ino: bigint },
  right: { dev: bigint; ino: bigint },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function runBoundOperation(
  directory: BoundDirectory,
  request: Record<string, unknown>,
): BoundOperationResult {
  const retained = fstatSync(directory.descriptor, { bigint: true });
  if (
    !retained.isDirectory() ||
    retained.dev !== directory.identity.dev ||
    retained.ino !== directory.identity.ino
  ) {
    throw new Error('SESSION_INTEGRATION_PATH_UNSAFE: retained directory identity changed');
  }
  let output: string;
  try {
    output = execFileSync(process.execPath, ['-e', BOUND_DIRECTORY_WORKER], {
      cwd: directory.path,
      encoding: 'utf8',
      input: JSON.stringify({
        ...request,
        identity: {
          dev: retained.dev.toString(),
          ino: retained.ino.toString(),
        },
      }),
      maxBuffer: 16 * 1024 * 1024,
      ...(request.operation === 'cas' ? {} : { timeout: 5_000 }),
    });
  } catch {
    throw new Error('SESSION_INTEGRATION_PATH_UNSAFE: bound-directory operation unavailable');
  }
  let result: BoundOperationResult;
  try {
    result = JSON.parse(output) as BoundOperationResult;
  } catch {
    throw new Error(
      'SESSION_INTEGRATION_PATH_UNSAFE: bound-directory operation returned invalid output',
    );
  }
  if (!result.ok) {
    const prefix =
      result.code === 'CONFLICT'
        ? 'SESSION_INTEGRATION_CONFLICT'
        : 'SESSION_INTEGRATION_PATH_UNSAFE';
    throw new Error(`${prefix}: ${result.message ?? 'bound-directory operation failed'}`);
  }
  return result;
}

export function openBoundDirectory(
  path: string,
  expectedIdentity?: { dev: bigint; ino: bigint },
): BoundDirectory {
  let descriptor: number | undefined;
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
    if (
      !opened.isDirectory() ||
      !sameIdentity(before, opened) ||
      !sameIdentity(after, opened) ||
      (expectedIdentity !== undefined && !sameIdentity(expectedIdentity, opened))
    ) {
      throw new Error(
        'SESSION_INTEGRATION_PATH_UNSAFE: integration ancestor changed while opening',
      );
    }
    return {
      descriptor,
      identity: { dev: opened.dev, ino: opened.ino },
      path,
    };
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    if (error instanceof Error && error.message.includes('SESSION_INTEGRATION_PATH_UNSAFE')) {
      throw error;
    }
    throw new Error('SESSION_INTEGRATION_PATH_UNSAFE: integration ancestor is unavailable');
  }
}

export function closeBoundDirectory(directory: BoundDirectory): void {
  closeSync(directory.descriptor);
}

export function assertBoundDirectoryCurrent(directory: BoundDirectory): void {
  const current = lstatSync(directory.path, { bigint: true });
  if (
    !current.isDirectory() ||
    current.isSymbolicLink() ||
    current.dev !== directory.identity.dev ||
    current.ino !== directory.identity.ino
  ) {
    throw new Error('SESSION_INTEGRATION_PATH_UNSAFE: integration ancestor changed');
  }
}

export function openBoundSubdirectory(
  parent: BoundDirectory,
  name: string,
  options: { create?: boolean; mode?: number } = {},
): BoundDirectory {
  const result = runBoundOperation(parent, {
    operation: 'directory',
    name,
    create: options.create ?? false,
    mode: options.mode ?? 0o700,
  });
  if (!result.directoryIdentity) {
    throw new Error(
      'SESSION_INTEGRATION_PATH_UNSAFE: bound-directory traversal returned invalid output',
    );
  }
  return openBoundDirectory(join(parent.path, name), {
    dev: BigInt(result.directoryIdentity.dev),
    ino: BigInt(result.directoryIdentity.ino),
  });
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
): void {
  runBoundOperation(directory, {
    operation: 'cas',
    writes: writes.map((write) => ({
      expected: write.expected?.toString('base64') ?? null,
      mode: write.mode,
      name: write.name,
      originalMode: write.expectedMode ?? write.mode,
      replacement: write.replacement?.toString('base64') ?? null,
    })),
  });
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
