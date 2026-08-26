import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import {
  SQLITE_RELAUNCH_SIGNALS,
  awaitChildErrorOrExit,
  completeSqliteRelaunch,
  type ChildErrorOrExitHandle,
  type SqliteRelaunchIo,
} from '../../dist/lifecycle/child-error-or-exit.js';

function spawnErrno(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

function fakeChild(
  kill: (signal?: NodeJS.Signals) => boolean = () => true,
): EventEmitter & ChildErrorOrExitHandle {
  const child = new EventEmitter() as EventEmitter & ChildErrorOrExitHandle;
  child.kill = kill;
  return child;
}

function recordingIo() {
  const writes: string[] = [];
  const exits: number[] = [];
  const selfKills: NodeJS.Signals[] = [];
  const removed: NodeJS.Signals[] = [];
  const signalHandlers = new Map<NodeJS.Signals, Array<() => void>>();
  const io: SqliteRelaunchIo = {
    writeErrorLine: (line) => {
      writes.push(line);
    },
    exit: (code) => {
      exits.push(code);
    },
    killSelf: (signal) => {
      selfKills.push(signal);
    },
    removeSignalListeners: (signal) => {
      removed.push(signal);
    },
    onSignal: (signal, handler) => {
      const list = signalHandlers.get(signal) ?? [];
      list.push(handler);
      signalHandlers.set(signal, list);
    },
  };
  return { io, writes, exits, selfKills, removed, signalHandlers };
}

async function settleOrFail<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} left a pending promise`)), 200),
    ),
  ]);
}

async function collectUncaught(run: () => Promise<void>): Promise<Error[]> {
  const uncaught: Error[] = [];
  const onUncaught = (error: Error) => {
    uncaught.push(error);
  };
  process.on('uncaughtException', onUncaught);
  try {
    await run();
    return uncaught;
  } finally {
    process.off('uncaughtException', onUncaught);
  }
}

test('awaitChildErrorOrExit settles once on error-only EAGAIN', async () => {
  const child = fakeChild();
  const pending = awaitChildErrorOrExit(child);
  queueMicrotask(() => child.emit('error', spawnErrno('EAGAIN', 'spawn EAGAIN')));
  const outcome = await settleOrFail(pending, 'error-only EAGAIN');
  assert.equal(outcome.error?.message, 'spawn EAGAIN');
  assert.equal((outcome.error as (Error & { code?: string }) | null)?.code, 'EAGAIN');
  assert.equal(outcome.code, null);
  assert.equal(outcome.signal, null);
  child.emit('exit', 0, null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(outcome.error?.message, 'spawn EAGAIN');
});

test('awaitChildErrorOrExit settles once on exit', async () => {
  const child = fakeChild();
  const pending = awaitChildErrorOrExit(child);
  queueMicrotask(() => child.emit('exit', 7, null));
  const outcome = await settleOrFail(pending, 'exit-only');
  assert.equal(outcome.code, 7);
  assert.equal(outcome.signal, null);
  assert.equal(outcome.error, null);
});

test('awaitChildErrorOrExit settles once when error is followed by exit', async () => {
  const child = fakeChild();
  const pending = awaitChildErrorOrExit(child);
  let settleCount = 0;
  const counted = pending.then((outcome) => {
    settleCount += 1;
    return outcome;
  });
  queueMicrotask(() => {
    child.emit('error', spawnErrno('EAGAIN', 'spawn EAGAIN'));
    child.emit('exit', 1, null);
  });
  const outcome = await settleOrFail(counted, 'error-plus-exit');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settleCount, 1);
  assert.equal(outcome.error?.message, 'spawn EAGAIN');
  assert.equal(outcome.code, null);
});

test('sqlite relaunch spawn failure emits one diagnostic, exits non-zero, and leaves no uncaught error', async () => {
  const child = fakeChild();
  const rec = recordingIo();
  const uncaught = await collectUncaught(async () => {
    const pending = completeSqliteRelaunch(child, rec.io);
    queueMicrotask(() => child.emit('error', spawnErrno('EAGAIN', 'spawn EAGAIN')));
    await settleOrFail(pending, 'sqlite relaunch EAGAIN');
  });
  assert.deepEqual(uncaught, []);
  assert.deepEqual(rec.exits, [1]);
  assert.equal(rec.writes.length, 1);
  assert.equal(rec.writes[0], 'rn-bridge-supervisor: sqlite relaunch spawn failed: spawn EAGAIN');
  child.emit('exit', 0, null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(rec.exits, [1]);
  assert.equal(rec.writes.length, 1);
});

test('sqlite relaunch error-plus-exit still exits once with one diagnostic', async () => {
  const child = fakeChild();
  const rec = recordingIo();
  const pending = completeSqliteRelaunch(child, rec.io);
  queueMicrotask(() => {
    child.emit('error', spawnErrno('ENOENT', 'spawn ENOENT'));
    child.emit('exit', 1, null);
  });
  await settleOrFail(pending, 'sqlite relaunch error-plus-exit');
  assert.deepEqual(rec.exits, [1]);
  assert.deepEqual(rec.writes, [
    'rn-bridge-supervisor: sqlite relaunch spawn failed: spawn ENOENT',
  ]);
});

test('sqlite relaunch successful exit code is unchanged', async () => {
  const child = fakeChild();
  const rec = recordingIo();
  const pending = completeSqliteRelaunch(child, rec.io);
  queueMicrotask(() => child.emit('exit', 0, null));
  await settleOrFail(pending, 'sqlite relaunch exit 0');
  assert.deepEqual(rec.exits, [0]);
  assert.deepEqual(rec.writes, []);
  assert.deepEqual(rec.selfKills, []);
});

test('sqlite relaunch successful signal propagation is unchanged', async () => {
  const child = fakeChild();
  const rec = recordingIo();
  const pending = completeSqliteRelaunch(child, rec.io);
  queueMicrotask(() => child.emit('exit', null, 'SIGTERM'));
  await settleOrFail(pending, 'sqlite relaunch SIGTERM');
  assert.deepEqual(rec.removed, ['SIGTERM']);
  assert.deepEqual(rec.selfKills, ['SIGTERM']);
  assert.deepEqual(rec.exits, [1]);
  assert.deepEqual(rec.writes, []);
});

test('signal forwarding is safe when the child is already gone', async () => {
  const child = fakeChild(() => {
    throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
  });
  const rec = recordingIo();
  const pending = completeSqliteRelaunch(child, rec.io);
  for (const signal of SQLITE_RELAUNCH_SIGNALS) {
    const handlers = rec.signalHandlers.get(signal) ?? [];
    assert.equal(handlers.length, 1, `${signal} must be forwarded`);
    assert.doesNotThrow(() => handlers[0]?.());
  }
  queueMicrotask(() => child.emit('exit', 0, null));
  await settleOrFail(pending, 'sqlite relaunch after dead-child signals');
  assert.deepEqual(rec.exits, [0]);
});
