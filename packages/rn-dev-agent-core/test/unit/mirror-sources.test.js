// packages/rn-dev-agent-core/test/unit/mirror-sources.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import {
  RestartGate,
  IosIdbSource,
  IosSimctlLoopSource,
  AndroidScreenrecordSource,
  SIMCTL_HINT,
  SIMCTL_BROKEN_IDB_HINT,
  IDB_INSTALL_COMMAND,
  detectIdb,
  probeIdbClient,
  idbDemotionHint,
  IDB_NO_FIRST_FRAME_REASON,
  IDB_MALFORMED_FRAME_REASON,
  IDB_STREAM_UNHEALTHY_HINT,
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

test('IosIdbSource: alive process with no first frame → typed onExit and killed child', async () => {
  const spawned = [];
  const src = new IosIdbSource('UDID-1', 20, {
    spawnFn: () => {
      const p = fakeProc();
      p.kill = () => {
        p.killed = true;
        setImmediate(() => p.emit('close', 1));
      };
      spawned.push(p);
      return p;
    },
    restartDelayMs: 0,
    firstFrameTimeoutMs: 20,
  });
  const rec = sinkRecorder();
  src.start(rec.sink);
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(rec.getExit(), 'alive/no-frame must not hang forever');
  assert.match(rec.getExit().reason, /no first frame/i);
  assert.equal(spawned[0].killed, true, 'timed-out idb child must be reaped');
  assert.equal(spawned.length, 1, 'timeout must not RestartGate-respawn');
  assert.equal(rec.frames.length, 0);
});

test('IosIdbSource: garbage stdout does not count as a first frame', async () => {
  const spawned = [];
  const src = new IosIdbSource('UDID-1', 20, {
    spawnFn: () => {
      const p = fakeProc();
      spawned.push(p);
      return p;
    },
    restartDelayMs: 0,
    firstFrameTimeoutMs: 20,
  });
  const rec = sinkRecorder();
  src.start(rec.sink);
  spawned[0].stdout.write(Buffer.from('not-a-jpeg'));
  spawned[0].stdout.write(Buffer.from([0xff, 0xd8, 0x00, 0x01]));
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(rec.getExit(), 'unterminated JPEG must still time out');
  assert.match(rec.getExit().reason, /no first frame/i);
  assert.equal(rec.frames.length, 0);
  src.stop();
});

test('IosIdbSource: successful first frame cancels the no-frame timer', async () => {
  const spawned = [];
  const src = new IosIdbSource('UDID-1', 20, {
    spawnFn: () => {
      const p = fakeProc();
      spawned.push(p);
      return p;
    },
    restartDelayMs: 0,
    firstFrameTimeoutMs: 40,
  });
  const rec = sinkRecorder();
  src.start(rec.sink);
  spawned[0].stdout.write(jpeg(1));
  await new Promise((r) => setTimeout(r, 70));
  assert.equal(rec.frames.length, 1);
  assert.equal(rec.getExit(), null, 'healthy first frame must not fail the source');
  assert.equal(spawned[0].killed, false);
  src.stop();
});

test('IosIdbSource: oversized malformed stream before first frame → typed onExit and killed child', async () => {
  const spawned = [];
  const src = new IosIdbSource('UDID-1', 20, {
    spawnFn: () => {
      const p = fakeProc();
      spawned.push(p);
      return p;
    },
    restartDelayMs: 0,
    firstFrameTimeoutMs: 5_000,
  });
  const rec = sinkRecorder();
  src.start(rec.sink);
  spawned[0].stdout.write(Buffer.concat([SOI, Buffer.alloc(8_000_000, 0)]));
  await tick();
  assert.ok(rec.getExit(), 'malformed first frame must fail bounded');
  assert.match(rec.getExit().reason, /malformed/i);
  assert.equal(spawned[0].killed, true);
  assert.equal(rec.frames.length, 0);
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
      assert.deepEqual(args.slice(0, 5), ['simctl', 'io', 'UDID-9', 'screenshot', '--type=jpeg']);
      assert.match(args[5], /\.jpg$/);
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

test('IosSimctlLoopSource: passes the injectable tmpPath as the capture target', async () => {
  const seen = [];
  const src = new IosSimctlLoopSource('U', {
    tmpPath: () => '/tmp/fake-mirror.jpg',
    execJpeg: async (_cmd, args) => {
      seen.push(args[args.length - 1]);
      src.stop();
      return jpeg(1);
    },
    idleDelayMs: 0,
  });
  const { sink } = sinkRecorder();
  src.start(sink);
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(seen, ['/tmp/fake-mirror.jpg']);
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

test('IosIdbSource: stderr is drained (flowing) so the child can never block on it', () => {
  const spawned = [];
  const src = new IosIdbSource('U', 20, {
    spawnFn: (cmd, args) => {
      const p = fakeProc();
      spawned.push({ cmd, args, p });
      return p;
    },
    restartDelayMs: 0,
  });
  const { sink } = sinkRecorder();
  src.start(sink);
  assert.equal(spawned[0].p.stderr.readableFlowing, true, 'idb stderr resumed');
  src.stop();
});

test('AndroidScreenrecordSource: both adb and ffmpeg stderr are drained (flowing)', () => {
  const spawned = [];
  const src = new AndroidScreenrecordSource('emulator-5554', {
    spawnFn: (cmd, args) => {
      const p = fakeProc();
      spawned.push({ cmd, args, p });
      return p;
    },
    restartDelayMs: 0,
  });
  const { sink } = sinkRecorder();
  src.start(sink);
  assert.equal(spawned[0].p.stderr.readableFlowing, true, 'adb stderr resumed');
  assert.equal(spawned[1].p.stderr.readableFlowing, true, 'ffmpeg stderr resumed');
  src.stop();
});

test('IosSimctlLoopSource: stop() aborts the in-flight capture', async () => {
  let signal = null;
  const src = new IosSimctlLoopSource('U', {
    execJpeg: (_cmd, _args, sig) =>
      new Promise((resolve, reject) => {
        signal = sig;
        sig.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }),
    idleDelayMs: 0,
    failurePauseMs: 0,
  });
  const rec = sinkRecorder();
  src.start(rec.sink);
  await tick();
  assert.ok(signal, 'capture received an AbortSignal');
  src.stop();
  await tick();
  assert.equal(signal.aborted, true, 'in-flight child killed on stop');
  assert.equal(rec.frames.length, 0);
  assert.equal(rec.getExit(), null, 'abort is not reported as a failure');
});

test('SIMCTL_HINT names idb', () => {
  assert.match(SIMCTL_HINT, /idb/);
});

// B269/B263: detectIdb must probe a real invocation (a broken client on PATH
// selects the doomed idb tier and kills the mirror), not PATH presence.
test('detectIdb: probes `idb --help` and resolves true on exit 0', async () => {
  const calls = [];
  const ok = await detectIdb((cmd, args, opts, cb) => {
    calls.push({ cmd, args });
    cb(null);
  });
  assert.equal(ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'idb');
  assert.deepEqual(calls[0].args, ['--help']);
});

test('detectIdb: broken client (non-zero exit) resolves false -> simctl tier', async () => {
  const ok = await detectIdb((_cmd, _args, _opts, cb) => {
    cb(Object.assign(new Error('RuntimeError: no current event loop'), { code: 1 }));
  });
  assert.equal(ok, false);
});

test('detectIdb: missing client (ENOENT) resolves false', async () => {
  const ok = await detectIdb((_cmd, _args, _opts, cb) => {
    cb(Object.assign(new Error('spawn idb ENOENT'), { code: 'ENOENT' }));
  });
  assert.equal(ok, false);
});

// GH#578: the three client states must stay distinct. Collapsing
// present-but-broken into absent is what produced the non-converging
// "install idb" loop, and the printed command must never be the unpinned
// `pipx install fb-idb` that reinstalls the crashing combination.
test('probeIdbClient: exit 0 -> ready', async () => {
  const state = await probeIdbClient((_cmd, _args, _opts, cb) => cb(null));
  assert.equal(state, 'ready');
});

test('probeIdbClient: ENOENT -> absent', async () => {
  const state = await probeIdbClient((_cmd, _args, _opts, cb) =>
    cb(Object.assign(new Error('spawn idb ENOENT'), { code: 'ENOENT' })),
  );
  assert.equal(state, 'absent');
});

test('probeIdbClient: crash on invocation -> broken, distinct from absent', async () => {
  const state = await probeIdbClient((_cmd, _args, _opts, cb) =>
    cb(Object.assign(new Error('RuntimeError: There is no current event loop'), { code: 1 })),
  );
  assert.equal(state, 'broken');
});

test('idb install command pins the interpreter (never bare `pipx install fb-idb`)', () => {
  assert.match(IDB_INSTALL_COMMAND, /pipx install --python python3\.13 --force fb-idb/);
  // GH#578: a python3.14-only machine must not be handed `pipx: No such python`.
  assert.match(IDB_INSTALL_COMMAND, /^brew install python@3\.13 &&/);
  for (const hint of [SIMCTL_HINT, SIMCTL_BROKEN_IDB_HINT, IDB_INSTALL_COMMAND]) {
    assert.doesNotMatch(hint, /pipx install fb-idb/);
  }
});

test('SIMCTL_BROKEN_IDB_HINT names the incompatibility, not a missing install', () => {
  assert.match(SIMCTL_BROKEN_IDB_HINT, /installed/);
  assert.match(SIMCTL_BROKEN_IDB_HINT, /Python 3\.14/);
  assert.match(SIMCTL_BROKEN_IDB_HINT, /asyncio\.get_event_loop/);
  assert.doesNotMatch(SIMCTL_BROKEN_IDB_HINT, /install idb for smoother mirroring/);
});

test('simctl fallback carries the broken-client hint when idb crashes', () => {
  const broken = new IosSimctlLoopSource('UDID', { degradedHint: SIMCTL_BROKEN_IDB_HINT });
  assert.equal(broken.degradedHint, SIMCTL_BROKEN_IDB_HINT);
  assert.equal(new IosSimctlLoopSource('UDID').degradedHint, SIMCTL_HINT);
});

// The TS constant duplicates the shell's no-interpreter install command by
// design (no runtime probing in the core package), so guard the duplication
// rather than building machinery to keep the two in sync.
test('IDB_INSTALL_COMMAND matches the command ensure-idb.sh produces', () => {
  const shell = readFileSync(new URL('../../../../scripts/ensure-idb.sh', import.meta.url), 'utf8');
  assert.ok(
    shell.includes(IDB_INSTALL_COMMAND),
    'ensure-idb.sh no longer emits the exact IDB_INSTALL_COMMAND string — they have drifted',
  );
});

test('idbDemotionHint keeps the demotion cause truthful', () => {
  assert.equal(
    idbDemotionHint({ reason: IDB_NO_FIRST_FRAME_REASON, hint: IDB_STREAM_UNHEALTHY_HINT }),
    IDB_STREAM_UNHEALTHY_HINT,
  );
  assert.equal(
    idbDemotionHint({ reason: IDB_MALFORMED_FRAME_REASON }),
    `${IDB_MALFORMED_FRAME_REASON} — using simctl screenshot loop`,
  );
  assert.equal(
    idbDemotionHint({ reason: 'idb video-stream keeps exiting' }),
    'idb video-stream keeps exiting — using simctl screenshot loop',
  );
  assert.equal(idbDemotionHint(), IDB_STREAM_UNHEALTHY_HINT);
});
