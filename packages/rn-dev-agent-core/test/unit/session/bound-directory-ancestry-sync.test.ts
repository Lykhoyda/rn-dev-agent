import assert from 'node:assert/strict';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { BOUND_DIRECTORY_ANCESTRY_SYNC } from '../../../dist/session/bound-directory.js';

class AncestryError extends Error {}

type Synchronizer = (captureBaseline?: boolean) => void;

function createSynchronizer(state: Int32Array, timeoutMs: number, pollMs: number): Synchronizer {
  const factory = new Function(
    `${BOUND_DIRECTORY_ANCESTRY_SYNC}\nreturn createAncestrySynchronizer;`,
  )() as (
    state: Int32Array,
    timeoutMs: number,
    pollMs: number,
    error: typeof AncestryError,
  ) => Synchronizer;
  return factory(state, timeoutMs, pollMs, AncestryError);
}

function startMonitor(state: Int32Array, script: string): Worker {
  const worker = new Worker(
    `const { workerData } = require('node:worker_threads');\nconst state = new Int32Array(workerData.stateBuffer);\n${script}`,
    { eval: true, workerData: { stateBuffer: state.buffer } },
  );
  worker.unref();
  return worker;
}

test('a monitor that keeps progressing is never fenced as wedged, however slow it is', async () => {
  const state = new Int32Array(new SharedArrayBuffer(7 * 4));
  const synchronize = createSynchronizer(state, 200, 10);
  const worker = startMonitor(
    state,
    `let ticks = 0;
     const beat = setInterval(() => {
       ticks += 1;
       Atomics.add(state, 6, 1);
       if (ticks < 60) return;
       clearInterval(beat);
       Atomics.store(state, 4, Atomics.load(state, 3));
       Atomics.notify(state, 4);
     }, 10);`,
  );
  try {
    const started = Date.now();
    synchronize();
    assert.ok(
      Date.now() - started > 400,
      'the barrier must have outlasted the wedged-monitor budget',
    );
    assert.equal(Atomics.load(state, 4), 1);
  } finally {
    await worker.terminate();
  }
});

test('a monitor that stops making progress is fenced within the budget', async () => {
  const state = new Int32Array(new SharedArrayBuffer(7 * 4));
  const synchronize = createSynchronizer(state, 200, 10);
  const worker = startMonitor(state, 'Atomics.add(state, 6, 1);');
  try {
    const started = Date.now();
    assert.throws(() => synchronize(), /ancestry monitor synchronization failed/);
    assert.ok(Date.now() - started < 5_000, 'the wedged-monitor fence must stay bounded');
  } finally {
    await worker.terminate();
  }
});

test('a monitor that reports failure is fenced as failed, not as a slow barrier', async () => {
  const state = new Int32Array(new SharedArrayBuffer(7 * 4));
  const synchronize = createSynchronizer(state, 5_000, 10);
  const worker = startMonitor(
    state,
    `setTimeout(() => {
       Atomics.store(state, 2, 1);
       Atomics.add(state, 6, 1);
       Atomics.notify(state, 4);
     }, 50);`,
  );
  try {
    assert.throws(() => synchronize(), /ancestry monitor failed/);
  } finally {
    await worker.terminate();
  }
});
