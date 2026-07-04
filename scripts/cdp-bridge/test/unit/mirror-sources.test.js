// scripts/cdp-bridge/test/unit/mirror-sources.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  RestartGate,
  IosIdbSource,
  IosSimctlLoopSource,
  AndroidScreenrecordSource,
  SIMCTL_HINT,
} from '../../dist/observability/mirror/sources.js';

const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);
const jpeg = (fill) => Buffer.concat([SOI, Buffer.alloc(8, fill), EOI]);

function fakeProc() {
  const p = new EventEmitter();
  p.stdout = new PassThrough();
  p.stderr = new PassThrough();
  p.stdin = new PassThrough();
  p.killed = false;
  p.kill = () => {
    p.killed = true;
  };
  return p;
}

function sinkRecorder() {
  const frames = [];
  let exit = null;
  return {
    frames,
    getExit: () => exit,
    sink: { onFrame: (f) => frames.push(f), onExit: (e) => (exit = e ?? { reason: 'clean' }) },
  };
}

const tick = () => new Promise((r) => setImmediate(r));

test('RestartGate: allows restarts until limit exits inside the window, then gives up', () => {
  let t = 0;
  const gate = new RestartGate(3, 10_000, () => t);
  assert.equal(gate.record(), true);
  t += 1000;
  assert.equal(gate.record(), true);
  t += 1000;
  assert.equal(gate.record(), false, 'third exit within 10s window → give up');
});

test('RestartGate: exits outside the window do not accumulate', () => {
  let t = 0;
  const gate = new RestartGate(3, 10_000, () => t);
  gate.record();
  t += 11_000;
  gate.record();
  t += 11_000;
  assert.equal(gate.record(), true, 'spaced-out exits keep restarting');
});

test('IosIdbSource: spawns idb with mjpeg args and emits parsed frames', async () => {
  const spawned = [];
  const src = new IosIdbSource('UDID-1', 20, {
    spawnFn: (cmd, args) => {
      const p = fakeProc();
      spawned.push({ cmd, args, p });
      return p;
    },
    restartDelayMs: 0,
  });
  const { frames, sink } = sinkRecorder();
  src.start(sink);
  assert.equal(spawned[0].cmd, 'idb');
  assert.deepEqual(spawned[0].args.slice(0, 3), ['video-stream', '--udid', 'UDID-1']);
  assert.ok(spawned[0].args.includes('mjpeg'));
  spawned[0].p.stdout.write(jpeg(1));
  spawned[0].p.stdout.write(jpeg(2));
  await tick();
  assert.equal(frames.length, 2);
  src.stop();
  assert.equal(spawned[0].p.killed, true);
});

test('IosIdbSource: ENOENT spawn error → onExit with idb hint, no restart', async () => {
  const spawned = [];
  const src = new IosIdbSource('U', 20, {
    spawnFn: () => {
      const p = fakeProc();
      spawned.push(p);
      return p;
    },
    restartDelayMs: 0,
  });
  const rec = sinkRecorder();
  src.start(rec.sink);
  const err = new Error('spawn idb ENOENT');
  err.code = 'ENOENT';
  spawned[0].emit('error', err);
  await tick();
  assert.match(rec.getExit().reason, /idb/i);
  assert.equal(spawned.length, 1);
});

test('IosSimctlLoopSource: sequential captures, one frame per capture, honors stop', async () => {
  let calls = 0;
  const src = new IosSimctlLoopSource('UDID-9', {
    execJpeg: async (cmd, args) => {
      calls++;
      assert.equal(cmd, 'xcrun');
      assert.deepEqual(args, ['simctl', 'io', 'UDID-9', 'screenshot', '--type=jpeg', '-']);
      if (calls >= 3) src.stop();
      return jpeg(calls);
    },
    idleDelayMs: 0,
  });
  const { frames, sink } = sinkRecorder();
  src.start(sink);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(frames.length, 3, 'no captures after stop()');
});

test('IosSimctlLoopSource: 3 consecutive failures inside window → onExit', async () => {
  let t = 0;
  const src = new IosSimctlLoopSource('U', {
    execJpeg: async () => {
      throw new Error('capture failed');
    },
    now: () => t,
    idleDelayMs: 0,
    failurePauseMs: 0,
  });
  const rec = sinkRecorder();
  src.start(rec.sink);
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(rec.getExit(), 'gave up after repeated failures');
});

test('AndroidScreenrecordSource: pipes adb→ffmpeg, frames from ffmpeg stdout, clean exit restarts', async () => {
  const spawned = [];
  const src = new AndroidScreenrecordSource('emulator-5554', {
    spawnFn: (cmd, args) => {
      const p = fakeProc();
      spawned.push({ cmd, args, p });
      return p;
    },
    restartDelayMs: 0,
  });
  const { frames, sink } = sinkRecorder();
  src.start(sink);
  assert.equal(spawned[0].cmd, 'adb');
  assert.deepEqual(spawned[0].args.slice(0, 2), ['-s', 'emulator-5554']);
  assert.equal(spawned[1].cmd, 'ffmpeg');
  spawned[1].p.stdout.write(jpeg(7));
  await tick();
  assert.equal(frames.length, 1);
  // 179s time-limit cycle: adb exits 0 → both processes respawned.
  spawned[0].p.emit('close', 0);
  await tick();
  await tick();
  assert.equal(spawned.length, 4, 'adb+ffmpeg respawned after clean exit');
  src.stop();
});

test('AndroidScreenrecordSource: ffmpeg ENOENT → onExit with ffmpeg hint', async () => {
  const spawned = [];
  const src = new AndroidScreenrecordSource('emulator-5554', {
    spawnFn: (cmd) => {
      const p = fakeProc();
      spawned.push({ cmd, p });
      return p;
    },
    restartDelayMs: 0,
  });
  const rec = sinkRecorder();
  src.start(rec.sink);
  const err = new Error('spawn ffmpeg ENOENT');
  err.code = 'ENOENT';
  spawned[1].p.emit('error', err);
  await tick();
  assert.match(rec.getExit().hint ?? rec.getExit().reason, /ffmpeg/i);
});

test('AndroidScreenrecordSource: 3 rapid exits → gives up with onExit', async () => {
  let t = 0;
  const spawned = [];
  const src = new AndroidScreenrecordSource('emulator-5554', {
    spawnFn: () => {
      const p = fakeProc();
      spawned.push(p);
      return p;
    },
    now: () => t,
    restartDelayMs: 0,
  });
  const rec = sinkRecorder();
  src.start(rec.sink);
  for (let i = 0; i < 3 && !rec.getExit(); i++) {
    spawned[spawned.length - 2].emit('close', 1); // adb crash
    await tick();
    await tick();
  }
  assert.ok(rec.getExit(), 'terminal error after rapid failures');
});

test('sources never emit after stop()', async () => {
  const spawned = [];
  const src = new IosIdbSource('U', 20, {
    spawnFn: () => {
      const p = fakeProc();
      spawned.push(p);
      return p;
    },
    restartDelayMs: 0,
  });
  const rec = sinkRecorder();
  src.start(rec.sink);
  src.stop();
  spawned[0].stdout.write(jpeg(1));
  spawned[0].emit('close', 1);
  await tick();
  assert.equal(rec.frames.length, 0);
  assert.equal(rec.getExit(), null);
});

test('AndroidScreenrecordSource: ffmpeg.stdin error (EPIPE) does not throw unhandled', async () => {
  const spawned = [];
  const src = new AndroidScreenrecordSource('emulator-5554', {
    spawnFn: (cmd) => {
      const p = fakeProc();
      spawned.push({ cmd, p });
      return p;
    },
    restartDelayMs: 0,
  });
  const rec = sinkRecorder();
  src.start(rec.sink);
  const ffmpeg = spawned.find((s) => s.cmd === 'ffmpeg');
  // Emitting 'error' on a PassThrough with no listener would throw synchronously —
  // the fix must have attached a listener to ffmpeg.stdin.
  ffmpeg.p.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
  await tick();
  src.stop();
  assert.ok(true, 'no unhandled error thrown');
});

test('SIMCTL_HINT names idb', () => {
  assert.match(SIMCTL_HINT, /idb/);
});
