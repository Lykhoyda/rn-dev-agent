import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync, } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getBoundDirectoryJournalKey } from './state-root.js';
const WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));
const BOUND_DIRECTORY_LIFECYCLE_MONITOR = String.raw `
const fs = require('node:fs');
const path = require('node:path');

const controlPath = process.argv[1];
const lifecycleCapability = process.argv[2];
const transactionLock = '.rn-bound-transaction.lock';
process.on('disconnect', () => {
  try {
    fs.writeFileSync(path.join(controlPath, 'stopped'), '', { flag: 'wx', mode: 0o600 });
  } catch {}
  try {
    const lock = JSON.parse(fs.readFileSync(transactionLock, 'utf8'));
    if (lock.owner === lifecycleCapability) fs.unlinkSync(transactionLock);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      try {
        fs.writeFileSync(path.join(controlPath, 'lock-retained'), '', {
          flag: 'wx',
          mode: 0o600,
        });
      } catch {}
    }
  }
  process.exit(0);
});
fs.writeFileSync(path.join(controlPath, 'monitor-ready'), '', { flag: 'wx', mode: 0o600 });
`;
const BOUND_DIRECTORY_TERMINATION_WATCHDOG = String.raw `
const fs = require('node:fs');
const path = require('node:path');
const { workerData } = require('node:worker_threads');

function poll() {
  try {
    const request = JSON.parse(
      fs.readFileSync(path.join(workerData.controlPath, 'terminate'), 'utf8'),
    );
    if (
      request.lifecycleCapability === workerData.lifecycleCapability &&
      (request.signal === 'SIGTERM' || request.signal === 'SIGKILL')
    ) {
      process.kill(process.pid, request.signal);
      return;
    }
  } catch {}
  setTimeout(poll, 5);
}

poll();
`;
const BOUND_DIRECTORY_ANCESTRY_MONITOR = String.raw `
const fs = require('node:fs');
const path = require('node:path');
const { workerData } = require('node:worker_threads');

const state = new Int32Array(workerData.stateBuffer);
const watchers = [];

function fail() {
  Atomics.store(state, 2, 1);
  Atomics.add(state, 1, 1);
  Atomics.notify(state, 1);
}

try {
  for (const ancestor of workerData.ancestors) {
    const watchedName = path.basename(ancestor.publicPath);
    const watcher = fs.watch(path.dirname(ancestor.publicPath), (eventType, filename) => {
      if (eventType === 'rename' && (filename === null || String(filename) === watchedName)) {
        Atomics.add(state, 1, 1);
        Atomics.notify(state, 1);
      }
    });
    watcher.on('error', fail);
    watchers.push(watcher);
  }
  Atomics.store(state, 0, 1);
  Atomics.notify(state, 0);
} catch {
  fail();
  Atomics.store(state, 0, -1);
  Atomics.notify(state, 0);
}
`;
const BOUND_DIRECTORY_WORKER = String.raw `
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Worker } = require('node:worker_threads');

class ConflictError extends Error {}
class AncestryError extends Error {}

const controlPath = process.argv[1];
const binding = JSON.parse(Buffer.from(process.argv[2], 'base64url').toString('utf8'));
const childWorkers = new Map();
const transactionLock = '.rn-bound-transaction.lock';
process.on('disconnect', () => process.exit(0));
process.channel?.unref();

const lifecycleMonitor = childProcess.spawn(
  process.execPath,
  [
    '-e',
    ${JSON.stringify(BOUND_DIRECTORY_LIFECYCLE_MONITOR)},
    controlPath,
    binding.lifecycleCapability,
  ],
  { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
);
lifecycleMonitor.on('error', () => {});
lifecycleMonitor.on('exit', () => process.exit(1));
lifecycleMonitor.channel?.unref();
lifecycleMonitor.unref();
const terminationWatchdog = new Worker(${JSON.stringify(BOUND_DIRECTORY_TERMINATION_WATCHDOG)}, {
  eval: true,
  workerData: {
    controlPath,
    lifecycleCapability: binding.lifecycleCapability,
  },
});
terminationWatchdog.on('error', () => process.exit(1));
terminationWatchdog.unref();
const agentAncestorIndex = binding.ancestors.findIndex(
  (ancestor) => path.basename(ancestor.publicPath) === '.rn-agent',
);
const monitoredAncestors =
  agentAncestorIndex === -1
    ? []
    : [binding.ancestors[agentAncestorIndex]];
const ancestryState = new Int32Array(new SharedArrayBuffer(12));
if (monitoredAncestors.length > 0) {
  const ancestryMonitor = new Worker(${JSON.stringify(BOUND_DIRECTORY_ANCESTRY_MONITOR)}, {
    eval: true,
    workerData: {
      ancestors: monitoredAncestors,
      stateBuffer: ancestryState.buffer,
    },
  });
  ancestryMonitor.on('error', () => {
    Atomics.store(ancestryState, 2, 1);
    Atomics.add(ancestryState, 1, 1);
  });
  ancestryMonitor.unref();
  if (
    Atomics.wait(ancestryState, 0, 0, 5_000) === 'timed-out' ||
    Atomics.load(ancestryState, 0) !== 1
  ) {
    process.exit(1);
  }
}

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

function assertBoundDirectory(expectedGuard, settle = false) {
  if (settle && monitoredAncestors.length > 0) wait(5);
  if (Atomics.load(ancestryState, 2) !== 0) {
    throw new AncestryError('bound-directory ancestry monitor failed');
  }
  const guardBefore = Atomics.load(ancestryState, 1);
  const current = fs.statSync('.', { bigint: true });
  if (
    !current.isDirectory() ||
    current.dev.toString() !== binding.dev ||
    current.ino.toString() !== binding.ino ||
    fs.realpathSync('.') !== binding.realPath
  ) {
    throw new AncestryError('bound-directory identity changed');
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
      throw new AncestryError('bound-directory ancestor changed');
    }
  }
  const guardAfter = Atomics.load(ancestryState, 1);
  if (guardBefore !== guardAfter || (expectedGuard !== undefined && guardAfter !== expectedGuard)) {
    throw new AncestryError('bound-directory ancestor changed during operation');
  }
  return guardAfter;
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

function signedPayload(value) {
  const { signature, ...payload } = value;
  return JSON.stringify(payload);
}

function sign(value) {
  return crypto
    .createHmac('sha256', Buffer.from(binding.journalKey, 'base64url'))
    .update(signedPayload(value))
    .digest('hex');
}

function authenticate(value) {
  if (!value || typeof value.signature !== 'string') return false;
  const expected = Buffer.from(sign(value), 'hex');
  const actual = Buffer.from(value.signature, 'hex');
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function readTransactionLock() {
  try {
    return JSON.parse(fs.readFileSync(transactionLock, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function validateTransactionLock(lock) {
  return (
    lock !== null &&
    lock.version === 1 &&
    typeof lock.controlPath === 'string' &&
    typeof lock.owner === 'string' &&
    authenticate(lock)
  );
}

function publishTransactionLock(lock) {
  const temporary = transactionLock + '.' + binding.lifecycleCapability + '.initial';
  removeOptional(temporary);
  fs.writeFileSync(temporary, JSON.stringify(lock), {
    flag: 'wx',
    mode: 0o600,
    flush: true,
  });
  try {
    fs.linkSync(temporary, transactionLock);
  } finally {
    removeOptional(temporary);
  }
}

function acquireTransactionLock() {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const lock = {
      controlPath,
      owner: binding.lifecycleCapability,
      version: 1,
    };
    lock.signature = sign(lock);
    try {
      publishTransactionLock(lock);
      return;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let existing;
      try {
        existing = readTransactionLock();
      } catch {
        throw new Error('bound-directory transaction lock is invalid');
      }
      if (!validateTransactionLock(existing)) {
        throw new Error('bound-directory transaction lock is invalid');
      }
      if (!fs.existsSync(path.join(existing.controlPath, 'stopped'))) {
        throw new Error('bound-directory transaction is active');
      }
      fs.unlinkSync(transactionLock);
      fs.rmSync(existing.controlPath, { force: true, recursive: true });
    }
  }
  throw new Error('bound-directory transaction lock is unavailable');
}

function ensureTransactionLock() {
  const lock = readTransactionLock();
  if (
    validateTransactionLock(lock) &&
    lock.owner === binding.lifecycleCapability
  ) {
    return;
  }
  acquireTransactionLock();
}

function releaseTransactionLock() {
  const lock = readTransactionLock();
  if (lock === null) return;
  if (
    !validateTransactionLock(lock) ||
    lock.owner !== binding.lifecycleCapability ||
    typeof lock.owner !== 'string'
  ) {
    throw new Error('bound-directory transaction lock is invalid');
  }
  fs.unlinkSync(transactionLock);
}

function writeJournal(name, value, exclusive) {
  validateName(name);
  value.signature = sign(value);
  const contents = JSON.stringify(value);
  if (exclusive) {
    const temporary = name + '.initial';
    removeOptional(temporary);
    fs.writeFileSync(temporary, contents, { flag: 'wx', mode: 0o600, flush: true });
    try {
      fs.linkSync(temporary, name);
    } finally {
      removeOptional(temporary);
    }
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

function recoverTransaction(
  journalName,
  requestedWrites,
  recoveryDelayAfterUnlinkMs = 0,
  releaseLock = true,
  ancestryGuard,
) {
  const journal = readJournal(journalName);
  if (journal === null) {
    const committed = allReplacementsPresent(requestedWrites);
    assertBoundDirectory(ancestryGuard, true);
    if (releaseLock) releaseTransactionLock();
    return { committed };
  }
  if (
    journal.version !== 1 ||
    journal.name !== journalName ||
    !authenticate(journal) ||
    JSON.stringify(journal.writes) !== JSON.stringify(requestedWrites)
  ) {
    throw new Error('bound-directory transaction journal is invalid');
  }
  if (journal.state === 'committed') {
    cleanupArtifacts(journal.writes);
    assertBoundDirectory(ancestryGuard, true);
    cleanupJournal(journalName);
    if (releaseLock) releaseTransactionLock();
    return { committed: true };
  }
  if (journal.state !== 'applying') {
    throw new Error('bound-directory transaction state is invalid');
  }
  rollbackOwnedWrites(journal.writes, recoveryDelayAfterUnlinkMs);
  assertBoundDirectory(ancestryGuard, true);
  cleanupJournal(journalName);
  if (releaseLock) releaseTransactionLock();
  return { committed: false };
}

function transactionJournalNames() {
  return fs
    .readdirSync('.')
    .filter((name) => /^\.rn-bound-([0-9a-f-]{36})\.journal$/.test(name));
}

function inspectTransactions() {
  const invalidJournals = [];
  const transactions = transactionJournalNames()
      .map((journalName) => {
      let journal;
      try {
        journal = readJournal(journalName);
      } catch {
        invalidJournals.push(journalName);
        return null;
      }
      if (
        journal === null ||
        journal.version !== 1 ||
        journal.name !== journalName ||
        typeof journal.owner !== 'string' ||
        !authenticate(journal) ||
        (journal.state !== 'applying' && journal.state !== 'committed') ||
        !Array.isArray(journal.writes)
      ) {
        invalidJournals.push(journalName);
        return null;
      }
      const transactionId = journalName.slice('.rn-bound-'.length, -'.journal'.length);
      if (journal.writes.length > 100) {
        throw new Error('bound-directory transaction journal is too large');
      }
      for (const [index, write] of journal.writes.entries()) {
        validateName(write.name);
        validateName(write.temporary);
        validateName(write.captured);
        if (
          write.temporary !== '.rn-bound-' + transactionId + '-' + index + '.tmp' ||
          write.captured !== '.rn-bound-' + transactionId + '-' + index + '.captured' ||
          (write.expected !== null && typeof write.expected !== 'string') ||
          (write.replacement !== null && typeof write.replacement !== 'string') ||
          !Number.isSafeInteger(write.mode) ||
          (write.expectedMode !== undefined && !Number.isSafeInteger(write.expectedMode))
        ) {
          throw new Error('bound-directory transaction journal write is invalid');
        }
      }
      return {
        journal: journalName,
        state: journal.state,
        transactionId,
        writes: journal.writes,
      };
      })
      .filter((transaction) => transaction !== null);
  if (transactions.length > 1) {
    throw new Error('bound-directory has multiple pending transactions');
  }
  return { invalidJournals, transactions };
}

function quarantineInvalidTransactions(journalNames) {
  return journalNames.map((journal) => {
    const quarantine = journal + '.invalid-' + crypto.randomUUID();
    fs.renameSync(journal, quarantine);
    return { journal, quarantine };
  });
}

function restoreQuarantinedTransactions(quarantined) {
  for (const entry of [...quarantined].reverse()) {
    fs.renameSync(entry.quarantine, entry.journal);
  }
}

function discoverTransactions(ancestryGuard) {
  if (transactionJournalNames().length === 0) {
    const lock = readTransactionLock();
    if (
      lock === null ||
      !validateTransactionLock(lock) ||
      lock.owner !== binding.lifecycleCapability
    ) {
      return [];
    }
    assertBoundDirectory(ancestryGuard, true);
    releaseTransactionLock();
    return [];
  }
  ensureTransactionLock();
  let quarantined = [];
  try {
    const inspection = inspectTransactions();
    assertBoundDirectory(ancestryGuard, true);
    quarantined = quarantineInvalidTransactions(inspection.invalidJournals);
    assertBoundDirectory(ancestryGuard, true);
    if (inspection.transactions.length === 0) releaseTransactionLock();
    return inspection.transactions;
  } catch (error) {
    if (error instanceof AncestryError) {
      try {
        const rollbackGuard = assertBoundDirectory();
        restoreQuarantinedTransactions(quarantined);
        assertBoundDirectory(rollbackGuard, true);
        releaseTransactionLock();
      } catch {}
    } else {
      try {
        releaseTransactionLock();
      } catch {}
    }
    throw error;
  }
}

function applyBatch(request, ancestryGuard) {
  acquireTransactionLock();
  const inspection = inspectTransactions();
  if (inspection.invalidJournals.length > 0) {
    releaseTransactionLock();
    throw new Error('bound-directory transaction journal is invalid');
  }
  const pending = inspection.transactions;
  if (pending.length === 1) {
    recoverTransaction(pending[0].journal, pending[0].writes, 0, false, ancestryGuard);
  } else {
    assertBoundDirectory(ancestryGuard, true);
  }
  const journal = {
    version: 1,
    name: request.journal,
    owner: binding.lifecycleCapability,
    state: 'applying',
    writes: request.writes,
  };
  try {
    writeJournal(request.journal, journal, true);
    for (const write of request.writes) applyWrite(write);
    assertBoundDirectory(ancestryGuard, true);
    journal.state = 'committed';
    writeJournal(request.journal, journal, false);
    try {
      if (request.failCleanupAfterCommit) {
        throw new Error('bound-directory cleanup unavailable');
      }
      cleanupArtifacts(request.writes);
      cleanupJournal(request.journal);
      releaseTransactionLock();
      return { committed: true };
    } catch {
      return { cleanupPending: true, committed: true };
    }
  } catch (error) {
    try {
      recoverTransaction(
        request.journal,
        request.writes,
        0,
        true,
        assertBoundDirectory(),
      );
    } catch (recoveryError) {
      throw new AggregateError([error, recoveryError]);
    }
    throw error;
  }
}

function spawnChildWorker(request, directory) {
  const existing = childWorkers.get(request.childId);
  if (existing) {
    throw new Error('bound-directory child worker already exists');
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
      lifecycleCapability: request.lifecycleCapability,
      controlPath: request.controlPath,
      journalKey: binding.journalKey,
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

function execute(request) {
  const ancestryGuard = assertBoundDirectory();
  if (request.operation === 'directory') {
    validateName(request.childId);
    validateName(request.name);
    let created = false;
    if (request.create) {
      try {
        fs.mkdirSync(request.name, { mode: request.mode });
        created = true;
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
    try {
      assertBoundDirectory(ancestryGuard, true);
    } catch (error) {
      if (created) fs.rmdirSync(request.name);
      throw error;
    }
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
    const snapshots = request.names.map((name) => {
      const snapshot = readRegularFile(name);
      return snapshot ?? { contents: null, mode: 0o600, name };
    });
    assertBoundDirectory(ancestryGuard, true);
    return { snapshots };
  }
  if (request.operation === 'cas') {
    return applyBatch(request, ancestryGuard);
  }
  if (request.operation === 'recover') {
    ensureTransactionLock();
    if (request.cleanupRecoveryDelayMs) wait(request.cleanupRecoveryDelayMs);
    if (request.failCleanupRecovery) {
      throw new Error('bound-directory cleanup recovery unavailable');
    }
    return recoverTransaction(
      request.journal,
      request.writes,
      request.recoveryDelayAfterUnlinkMs,
      true,
      ancestryGuard,
    );
  }
  if (request.operation === 'discover') {
    if (request.discoveryQuarantineDelayMs) wait(request.discoveryQuarantineDelayMs);
    return { transactions: discoverTransactions(ancestryGuard) };
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
  while (!fs.existsSync(path.join(controlPath, 'monitor-ready'))) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  fs.writeFileSync(
    path.join(controlPath, 'ready'),
    JSON.stringify({
      lifecycleCapability: binding.lifecycleCapability,
      ok: true,
      pid: process.pid,
    }),
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
function stopWorker(worker, signal = 'SIGTERM') {
    const stoppedPath = join(worker.controlPath, 'stopped');
    if (signal === 'SIGTERM') {
        try {
            writeFileSync(join(worker.controlPath, 'stop'), '', { flag: 'wx', mode: 0o600 });
        }
        catch { }
        if (waitForFile(stoppedPath, 1_000)) {
            if (!existsSync(join(worker.controlPath, 'lock-retained'))) {
                rmSync(worker.controlPath, { force: true, recursive: true });
            }
            return;
        }
    }
    try {
        writeFileSync(join(worker.controlPath, 'terminate'), JSON.stringify({
            lifecycleCapability: worker.lifecycleCapability,
            signal: 'SIGKILL',
        }), { flag: 'wx', mode: 0o600 });
    }
    catch { }
    if (!waitForFile(stoppedPath, 10_000)) {
        throw new Error('SESSION_INTEGRATION_PATH_UNSAFE: bound-directory worker exit was not confirmed');
    }
    if (!existsSync(join(worker.controlPath, 'lock-retained'))) {
        rmSync(worker.controlPath, { force: true, recursive: true });
    }
}
function bindWorker(controlPath, child, owner, childId, lifecycleCapability = '') {
    const rejectWorker = (message) => {
        if (typeof lifecycleCapability === 'string') {
            try {
                stopWorker({
                    child,
                    childId,
                    controlPath,
                    lifecycleCapability,
                    owner,
                    pid: child?.pid ?? 0,
                    sequence: 0,
                }, 'SIGKILL');
            }
            catch { }
        }
        throw new Error(message);
    };
    const readyPath = join(controlPath, 'ready');
    if (!waitForFile(readyPath, 5_000)) {
        rejectWorker('SESSION_INTEGRATION_PATH_UNSAFE: bound-directory worker unavailable');
    }
    let ready = {};
    try {
        ready = JSON.parse(readFileSync(readyPath, 'utf8'));
    }
    catch {
        rejectWorker('SESSION_INTEGRATION_PATH_UNSAFE: bound-directory worker unavailable');
    }
    const readyPid = ready.pid;
    if (ready.ok !== true ||
        lifecycleCapability.length === 0 ||
        ready.lifecycleCapability !== lifecycleCapability ||
        typeof readyPid !== 'number' ||
        !Number.isSafeInteger(readyPid) ||
        readyPid <= 0 ||
        (child?.pid !== undefined && child.pid !== readyPid)) {
        rejectWorker('SESSION_INTEGRATION_PATH_UNSAFE: bound-directory worker rejected path');
    }
    return {
        child,
        childId,
        controlPath,
        lifecycleCapability,
        owner,
        pid: readyPid,
        sequence: 0,
    };
}
function startWorker(path, identity, realPath) {
    const controlPath = mkdtempSync(join(tmpdir(), 'rn-bound-directory-'));
    const lifecycleCapability = randomUUID();
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
        lifecycleCapability,
        controlPath,
        journalKey: getBoundDirectoryJournalKey(),
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
    return bindWorker(controlPath, child, undefined, undefined, lifecycleCapability);
}
function startSubdirectoryWorker(parent, name, expectedIdentity, expectedRealPath) {
    const controlPath = mkdtempSync(join(tmpdir(), 'rn-bound-directory-'));
    const childId = randomUUID();
    const lifecycleCapability = randomUUID();
    let worker;
    let childStarted = false;
    try {
        const result = runBoundOperation(parent, {
            operation: 'directory',
            childId,
            controlPath,
            lifecycleCapability,
            name,
            publicPath: join(parent.path, name),
            create: false,
            mode: 0o700,
        });
        childStarted = true;
        worker = bindWorker(controlPath, undefined, parent, childId, lifecycleCapability);
        if (!result.directoryIdentity ||
            BigInt(result.directoryIdentity.dev) !== expectedIdentity.dev ||
            BigInt(result.directoryIdentity.ino) !== expectedIdentity.ino ||
            result.directoryIdentity.realPath !== expectedRealPath) {
            throw new Error('SESSION_INTEGRATION_PATH_UNSAFE: bound-directory child identity changed');
        }
        return worker;
    }
    catch (error) {
        try {
            if (worker)
                stopWorker(worker, 'SIGKILL');
            else if (childStarted ||
                (error instanceof Error && error.message === 'SESSION_INTEGRATION_WORKER_TIMEOUT')) {
                stopWorker({
                    childId,
                    controlPath,
                    lifecycleCapability,
                    owner: parent,
                    pid: 0,
                    sequence: 0,
                }, 'SIGKILL');
            }
            else {
                rmSync(controlPath, { force: true, recursive: true });
            }
        }
        catch (cleanupError) {
            throw new AggregateError([
                error instanceof Error ? error : new Error(String(error)),
                cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError)),
            ], 'bound-directory child cleanup failed');
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
                dependencies.beforeCleanupRecovery?.();
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
                let unresolvedCleanup = cleanupError;
                if (cleanupError instanceof Error &&
                    cleanupError.message === 'SESSION_INTEGRATION_WORKER_TIMEOUT') {
                    try {
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
                    catch (retryError) {
                        unresolvedCleanup = retryError;
                    }
                }
                return {
                    ...result,
                    cleanupPending: true,
                    cleanupError: unresolvedCleanup instanceof Error
                        ? unresolvedCleanup.message
                        : String(unresolvedCleanup),
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
function recoverDiscoveredTransactions(directory, discoveryQuarantineDelayMs = 0) {
    const result = runBoundOperation(directory, {
        operation: 'discover',
        discoveryQuarantineDelayMs,
    });
    if (!result.transactions) {
        throw new Error('SESSION_INTEGRATION_PATH_UNSAFE: bound-directory discovery returned invalid output');
    }
    for (const transaction of result.transactions) {
        if (!/^[0-9a-f-]{36}$/.test(transaction.transactionId) ||
            transaction.journal !== `.rn-bound-${transaction.transactionId}.journal` ||
            (transaction.state !== 'applying' && transaction.state !== 'committed')) {
            throw new Error('SESSION_INTEGRATION_PATH_UNSAFE: bound-directory discovery returned invalid transaction');
        }
        directory.pendingCleanups.set(transaction.transactionId, {
            journal: transaction.journal,
            knownCommitted: transaction.state === 'committed',
            writes: transaction.writes,
        });
        retryBoundDirectoryCleanup(directory, {
            transactionId: transaction.transactionId,
        });
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
        const directory = {
            children: new Set(),
            descriptor,
            identity,
            path,
            pendingCleanups: new Map(),
            realPath,
            worker,
            closed: false,
        };
        recoverDiscoveredTransactions(directory);
        return directory;
    }
    catch (error) {
        const cleanupErrors = [];
        if (worker !== undefined) {
            try {
                stopWorker(worker, 'SIGKILL');
            }
            catch (cleanupError) {
                cleanupErrors.push(cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError)));
            }
        }
        if (descriptor !== undefined) {
            try {
                closeSync(descriptor);
            }
            catch (cleanupError) {
                cleanupErrors.push(cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError)));
            }
        }
        if (cleanupErrors.length > 0) {
            throw new AggregateError([error instanceof Error ? error : new Error(String(error)), ...cleanupErrors], 'bound-directory open cleanup failed');
        }
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
    for (const child of [...directory.children]) {
        try {
            closeBoundDirectory(child);
        }
        catch (error) {
            cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
        }
    }
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
    if (directory.descriptor !== undefined) {
        try {
            closeSync(directory.descriptor);
        }
        catch (error) {
            cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
        }
    }
    if (cleanupErrors.length > 0) {
        throw new AggregateError(cleanupErrors, 'bound-directory cleanup failed');
    }
}
export function closeBoundDirectories(directories, primaryError) {
    const closeErrors = [];
    for (const directory of directories) {
        if (!directory)
            continue;
        try {
            closeBoundDirectory(directory);
        }
        catch (error) {
            closeErrors.push(error instanceof Error ? error : new Error(String(error)));
        }
    }
    if (closeErrors.length === 0)
        return;
    const errors = primaryError === undefined
        ? closeErrors
        : [
            primaryError instanceof Error ? primaryError : new Error(String(primaryError)),
            ...closeErrors,
        ];
    throw new AggregateError(errors, 'bound-directory cleanup failed');
}
export function assertBoundDirectoryCurrent(directory) {
    runBoundOperation(directory, { operation: 'identity' });
}
function openBoundSubdirectoryInternal(parent, name, options = {}) {
    const controlPath = mkdtempSync(join(tmpdir(), 'rn-bound-directory-'));
    const childId = randomUUID();
    const lifecycleCapability = randomUUID();
    let worker;
    let childStarted = false;
    try {
        const result = runBoundOperation(parent, {
            operation: 'directory',
            childId,
            controlPath,
            lifecycleCapability,
            name,
            publicPath: join(parent.path, name),
            create: options.create ?? false,
            mode: options.mode ?? 0o700,
            optional: options.optional ?? false,
        });
        childStarted = !result.directoryMissing;
        if (result.directoryMissing) {
            rmSync(controlPath, { force: true, recursive: true });
            return null;
        }
        worker = bindWorker(controlPath, undefined, parent, childId, lifecycleCapability);
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
        recoverDiscoveredTransactions(directory, options.discoveryQuarantineDelayMs);
        runBoundOperation(parent, { operation: 'child-identity', childId });
        parent.children.add(directory);
        return directory;
    }
    catch (error) {
        try {
            if (worker)
                stopWorker(worker, 'SIGKILL');
            else if (childStarted ||
                (error instanceof Error && error.message === 'SESSION_INTEGRATION_WORKER_TIMEOUT')) {
                stopWorker({
                    childId,
                    controlPath,
                    lifecycleCapability,
                    owner: parent,
                    pid: 0,
                    sequence: 0,
                }, 'SIGKILL');
            }
            else {
                rmSync(controlPath, { force: true, recursive: true });
            }
        }
        catch (cleanupError) {
            throw new AggregateError([
                error instanceof Error ? error : new Error(String(error)),
                cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError)),
            ], 'bound-directory child cleanup failed');
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
    for (const transactionId of [...directory.pendingCleanups.keys()]) {
        retryBoundDirectoryCleanup(directory, { transactionId });
    }
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
            knownCommitted: true,
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
    if (result.committed !== transaction.knownCommitted) {
        throw new Error('SESSION_INTEGRATION_PATH_UNSAFE: bound-directory recovery changed transaction outcome');
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
    return result;
}
