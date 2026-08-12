import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { MirrorManager, MIRROR_BOUNDARY } from '../../dist/observability/mirror/manager.js';

const jpeg = (fill) =>
  Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(4, fill), Buffer.from([0xff, 0xd9])]);

function fakeClient({ writeOk = true, closeOnEnd = false } = {}) {
  const em = new EventEmitter();
  const c = {
    chunks: [],
    ended: false,
    status: 0,
    headers: null,
    writeOk,
    writeHead(s, h) {
      c.status = s;
      c.headers = h;
    },
    write(b) {
      c.chunks.push(Buffer.from(b));
      return c.writeOk;
    },
    end() {
      c.ended = true;
      // Real sockets emit 'close' asynchronously after end() — opt in to
      // reproduce that for teardown-race regression tests.
      if (closeOnEnd) setImmediate(() => em.emit('close'));
    },
    on: (e, cb) => em.on(e, cb),
    emit: (e) => em.emit(e),
  };
  return c;
}

function fakeSource() {
  let sink = null;
  return {
    pipeline: 'idb',
    nominalFps: 20,
    stopped: false,
    start(s) {
      sink = s;
    },
    stop() {
      this.stopped = true;
    },
    frame(f) {
      sink?.onFrame(f);
    },
    exit(e) {
      sink?.onExit(e);
    },
  };
}

function build({ resolution, source, graceMs = 15 } = {}) {
  const statuses = [];
  const src = source ?? fakeSource();
  const mgr = new MirrorManager({
    resolveTarget: async () =>
      resolution ?? { ok: true, target: { platform: 'ios', deviceId: 'U1' } },
    createSource: async () => src,
    pushStatus: (s) => statuses.push(s),
    graceMs,
  });
  return { mgr, src, statuses };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

test('attach → starting status, multipart headers, streaming after first frame', async () => {
  const { mgr, src, statuses } = build();
  const c = fakeClient();
  mgr.attach(c);
  await tick();
  assert.equal(c.status, 200);
  assert.match(c.headers['Content-Type'], /multipart\/x-mixed-replace/);
  assert.match(c.headers['Content-Type'], new RegExp(MIRROR_BOUNDARY));
  assert.equal(statuses[0].status, 'starting');
  src.frame(jpeg(1));
  assert.equal(statuses[1].status, 'streaming');
  assert.equal(statuses[1].pipeline, 'idb');
  assert.equal(mgr.isStreaming(), true);
  const all = Buffer.concat(c.chunks).toString('latin1');
  assert.match(all, /--rnmirror\r\nContent-Type: image\/jpeg\r\nContent-Length: \d+\r\n\r\n/);
});

test('second client gets latest frame immediately on attach', async () => {
  const { mgr, src } = build();
  const a = fakeClient();
  mgr.attach(a);
  await tick();
  src.frame(jpeg(3));
  const b = fakeClient();
  mgr.attach(b);
  await tick();
  assert.ok(Buffer.concat(b.chunks).includes(jpeg(3)), 'late joiner sees current screen');
});

test('backpressured client skips frames until drain, others unaffected', async () => {
  const { mgr, src } = build();
  const slow = fakeClient({ writeOk: false });
  const fast = fakeClient();
  mgr.attach(slow);
  mgr.attach(fast);
  await tick();
  src.frame(jpeg(1)); // slow: written, returns false → not ready
  const slowWrites = slow.chunks.length;
  src.frame(jpeg(2)); // slow skipped
  assert.equal(slow.chunks.length, slowWrites);
  assert.ok(Buffer.concat(fast.chunks).includes(jpeg(2)));
  slow.writeOk = true;
  slow.emit('drain');
  src.frame(jpeg(4));
  assert.ok(Buffer.concat(slow.chunks).includes(jpeg(4)), 'resumes after drain');
});

test('last client close → grace stop → idle status; re-attach within grace keeps pipeline', async () => {
  const { mgr, src, statuses } = build({ graceMs: 30 });
  const a = fakeClient();
  mgr.attach(a);
  await tick();
  src.frame(jpeg(1));
  a.emit('close');
  // Re-attach inside the grace window: pipeline must survive.
  const b = fakeClient();
  mgr.attach(b);
  await new Promise((r) => setTimeout(r, 45));
  assert.equal(src.stopped, false, 're-attach cancelled the grace stop');
  b.emit('close');
  await new Promise((r) => setTimeout(r, 45));
  assert.equal(src.stopped, true);
  assert.equal(statuses.at(-1).status, 'idle');
  assert.equal(mgr.isStreaming(), false);
});

test('resolution failure → error status with reason, clients ended, no source created', async () => {
  const { mgr, statuses } = build({
    resolution: { ok: false, reason: 'no booted simulator', hint: 'boot one' },
  });
  const c = fakeClient();
  mgr.attach(c);
  await tick();
  const err = statuses.find((s) => s.status === 'error');
  assert.match(err.reason, /no booted/);
  assert.equal(err.hint, 'boot one');
  assert.equal(c.ended, true);
});

test('idb exit before first frame demotes to simctl; clients stay attached', async () => {
  const events = [];
  const idb = fakeSource();
  const origStop = idb.stop.bind(idb);
  idb.stop = function stop() {
    events.push('idb.stop');
    origStop();
  };
  const simctl = fakeSource();
  simctl.pipeline = 'simctl';
  simctl.nominalFps = 6;
  simctl.degradedHint = 'using simctl screenshot loop';
  const origStart = simctl.start.bind(simctl);
  simctl.start = function start(s) {
    events.push('simctl.start');
    origStart(s);
  };
  let fallbackCalls = 0;
  const statuses = [];
  const mgr = new MirrorManager({
    resolveTarget: async () => ({ ok: true, target: { platform: 'ios', deviceId: 'U1' } }),
    createSource: async () => idb,
    createFallbackSource: async (target, cause) => {
      events.push('fallback.create');
      fallbackCalls++;
      assert.equal(target.deviceId, 'U1');
      assert.equal(target.platform, 'ios');
      assert.equal(cause?.reason, 'idb video-stream produced no first frame');
      return simctl;
    },
    pushStatus: (s) => statuses.push(s),
    graceMs: 15,
  });
  const c = fakeClient();
  mgr.attach(c);
  await tick();
  assert.equal(idb.stopped, false);
  idb.exit({ reason: 'idb video-stream produced no first frame' });
  await tick();
  assert.deepEqual(events, ['idb.stop', 'fallback.create', 'simctl.start']);
  assert.equal(fallbackCalls, 1);
  assert.equal(c.ended, false, 'demotion must not tear the 200 multipart client');
  assert.equal(
    statuses.find((s) => s.status === 'error'),
    undefined,
    'successful demotion is not a terminal error',
  );
  // Stale idb callbacks after replacement must not double-write or re-exit.
  idb.frame(jpeg(1));
  idb.exit({ reason: 'stale idb exit' });
  await tick();
  assert.equal(c.ended, false);
  assert.equal(
    statuses.find((s) => s.status === 'error'),
    undefined,
  );
  simctl.frame(jpeg(9));
  assert.equal(statuses.at(-1).status, 'streaming');
  assert.equal(statuses.at(-1).pipeline, 'simctl');
  assert.ok(Buffer.concat(c.chunks).includes(jpeg(9)));
  assert.equal(
    Buffer.concat(c.chunks).includes(jpeg(1)),
    false,
    'stale idb frame must not be broadcast after demotion',
  );
});

test('healthy idb first frame does not create a fallback source', async () => {
  const idb = fakeSource();
  let fallbackCalls = 0;
  const statuses = [];
  const mgr = new MirrorManager({
    resolveTarget: async () => ({ ok: true, target: { platform: 'ios', deviceId: 'U1' } }),
    createSource: async () => idb,
    createFallbackSource: async () => {
      fallbackCalls++;
      return fakeSource();
    },
    pushStatus: (s) => statuses.push(s),
    graceMs: 15,
  });
  const c = fakeClient();
  mgr.attach(c);
  await tick();
  idb.frame(jpeg(1));
  await tick();
  assert.equal(fallbackCalls, 0);
  assert.equal(statuses.at(-1).status, 'streaming');
  assert.equal(statuses.at(-1).pipeline, 'idb');
  assert.equal(mgr.isStreaming(), true);
});

test('idb exit without fallback source → typed error, clients ended', async () => {
  const { mgr, src, statuses } = build();
  const c = fakeClient();
  mgr.attach(c);
  await tick();
  src.exit({ reason: 'idb video-stream produced no first frame' });
  assert.equal(statuses.at(-1).status, 'error');
  assert.match(statuses.at(-1).reason, /no first frame/);
  assert.equal(c.ended, true);
  assert.equal(mgr.isStreaming(), false);
});

test('fallback source is used once; its exit is terminal and does not respawn idb', async () => {
  const idb = fakeSource();
  const simctl = fakeSource();
  simctl.pipeline = 'simctl';
  let createCalls = 0;
  let fallbackCalls = 0;
  const statuses = [];
  const mgr = new MirrorManager({
    resolveTarget: async () => ({ ok: true, target: { platform: 'ios', deviceId: 'U1' } }),
    createSource: async () => {
      createCalls++;
      return idb;
    },
    createFallbackSource: async () => {
      fallbackCalls++;
      return simctl;
    },
    pushStatus: (s) => statuses.push(s),
    graceMs: 15,
  });
  const c = fakeClient();
  mgr.attach(c);
  await tick();
  idb.exit({ reason: 'idb video-stream produced no first frame' });
  await tick();
  simctl.exit({ reason: 'simctl screenshot failing' });
  await tick();
  assert.equal(createCalls, 1, 'must not re-enter createSource (would re-select idb)');
  assert.equal(fallbackCalls, 1, 'must not demote twice');
  assert.equal(statuses.at(-1).status, 'error');
  assert.equal(c.ended, true);
  assert.equal(idb.stopped, true);
  assert.equal(simctl.stopped, true);
});

test('stale idb frames during pending fallback are ignored', async () => {
  const idb = fakeSource();
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const simctl = fakeSource();
  simctl.pipeline = 'simctl';
  const statuses = [];
  const mgr = new MirrorManager({
    resolveTarget: async () => ({ ok: true, target: { platform: 'ios', deviceId: 'U1' } }),
    createSource: async () => idb,
    createFallbackSource: async () => {
      await pending;
      return simctl;
    },
    pushStatus: (s) => statuses.push(s),
    graceMs: 15,
  });
  const c = fakeClient();
  mgr.attach(c);
  await tick();
  idb.exit({ reason: 'idb video-stream produced no first frame' });
  await tick();
  idb.frame(jpeg(3));
  idb.exit({ reason: 'stale' });
  assert.equal(c.ended, false);
  assert.equal(Buffer.concat(c.chunks).includes(jpeg(3)), false);
  release(undefined);
  await tick();
  simctl.frame(jpeg(4));
  assert.ok(Buffer.concat(c.chunks).includes(jpeg(4)));
  assert.equal(statuses.at(-1).pipeline, 'simctl');
});

test('last-client close during pending fallback stops the late simctl source', async () => {
  const idb = fakeSource();
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const simctl = fakeSource();
  simctl.pipeline = 'simctl';
  const mgr = new MirrorManager({
    resolveTarget: async () => ({ ok: true, target: { platform: 'ios', deviceId: 'U1' } }),
    createSource: async () => idb,
    createFallbackSource: async () => {
      await pending;
      return simctl;
    },
    pushStatus: () => {},
    graceMs: 15,
  });
  const c = fakeClient();
  mgr.attach(c);
  await tick();
  idb.exit({ reason: 'idb video-stream produced no first frame' });
  await tick();
  c.emit('close');
  await new Promise((r) => setTimeout(r, 30));
  release(undefined);
  await tick();
  assert.equal(simctl.stopped, true, 'late fallback must not leak after client cancel');
});

test('shutdown during in-flight fallback stops the replacement and does not leak it', async () => {
  const idb = fakeSource();
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const simctl = fakeSource();
  simctl.pipeline = 'simctl';
  const statuses = [];
  const mgr = new MirrorManager({
    resolveTarget: async () => ({ ok: true, target: { platform: 'ios', deviceId: 'U1' } }),
    createSource: async () => idb,
    createFallbackSource: async () => {
      await pending;
      return simctl;
    },
    pushStatus: (s) => statuses.push(s),
    graceMs: 15,
  });
  const c = fakeClient();
  mgr.attach(c);
  await tick();
  idb.exit({ reason: 'idb video-stream produced no first frame' });
  await tick();
  mgr.shutdown();
  release(undefined);
  await tick();
  assert.equal(simctl.stopped, true, 'superseded fallback must be stopped');
  assert.equal(c.ended, true);
  assert.equal(
    statuses.find((s) => s.status === 'streaming'),
    undefined,
  );
});

test('android screenrecord exit does not invoke iOS simctl demotion', async () => {
  const src = fakeSource();
  src.pipeline = 'screenrecord';
  let fallbackCalls = 0;
  const statuses = [];
  const mgr = new MirrorManager({
    resolveTarget: async () => ({
      ok: true,
      target: { platform: 'android', deviceId: 'emulator-5554' },
    }),
    createSource: async () => src,
    createFallbackSource: async () => {
      fallbackCalls++;
      return fakeSource();
    },
    pushStatus: (s) => statuses.push(s),
    graceMs: 15,
  });
  const c = fakeClient();
  mgr.attach(c);
  await tick();
  src.exit({ reason: 'screen capture pipeline keeps exiting' });
  await tick();
  assert.equal(fallbackCalls, 0);
  assert.equal(statuses.at(-1).status, 'error');
  assert.equal(c.ended, true);
});

test('source exit → error status, clients ended, next attach retries fresh', async () => {
  const { mgr, src, statuses } = build();
  const c = fakeClient();
  mgr.attach(c);
  await tick();
  src.frame(jpeg(1));
  src.exit({ reason: 'ffmpeg missing', hint: 'install ffmpeg' });
  assert.equal(statuses.at(-1).status, 'error');
  assert.equal(c.ended, true);
  assert.equal(mgr.isStreaming(), false);
  const c2 = fakeClient();
  mgr.attach(c2);
  await tick();
  assert.equal(statuses.at(-1).status, 'starting', 'new attach cycle retries');
});

test('shutdown ends clients and stays reusable', async () => {
  const { mgr, src } = build();
  const c = fakeClient();
  mgr.attach(c);
  await tick();
  mgr.shutdown();
  assert.equal(c.ended, true);
  assert.equal(src.stopped, true);
  const c2 = fakeClient();
  mgr.attach(c2);
  await tick();
  assert.equal(c2.status, 200, 'manager usable after shutdown (observe restart)');
});

test('createSource rejection → error status, clients ended, next attach retries', async () => {
  const statuses = [];
  let calls = 0;
  const mgr = new MirrorManager({
    resolveTarget: async () => ({ ok: true, target: { platform: 'ios', deviceId: 'U1' } }),
    createSource: async () => {
      calls++;
      if (calls === 1) throw new Error('spawn exploded');
      return fakeSource();
    },
    pushStatus: (s) => statuses.push(s),
    graceMs: 15,
  });
  const c = fakeClient();
  mgr.attach(c);
  await tick();
  const err = statuses.find((s) => s.status === 'error');
  assert.ok(err, 'error status pushed');
  assert.match(err.reason, /spawn exploded/);
  assert.equal(c.ended, true);
  assert.equal(mgr.isStreaming(), false);
  const c2 = fakeClient();
  mgr.attach(c2);
  await tick();
  assert.equal(calls, 2, 'second attach retried createSource');
});

test('one client whose write throws does not break broadcast to others', async () => {
  const { mgr, src } = build();
  const bad = fakeClient();
  bad.write = () => {
    throw new Error('destroyed');
  };
  const good = fakeClient();
  mgr.attach(bad);
  mgr.attach(good);
  await tick();
  src.frame(jpeg(1));
  assert.ok(Buffer.concat(good.chunks).includes(jpeg(1)), 'good client still served');
  src.frame(jpeg(2));
  assert.ok(Buffer.concat(good.chunks).includes(jpeg(2)));
});

test('socket close after error teardown does not flap the status back to idle', async () => {
  // Regression: endAllClients() on error → real socket 'close' fires a tick
  // later → close handler used to scheduleGrace() unconditionally → grace
  // callback pushed 'idle' over the error, and the frontend re-attached in a
  // perpetual retry loop.
  const { mgr, statuses } = build({
    resolution: { ok: false, reason: 'no booted simulator' },
    graceMs: 20,
  });
  const c = fakeClient({ closeOnEnd: true });
  mgr.attach(c);
  await new Promise((r) => setTimeout(r, 60));
  const errIdx = statuses.findIndex((s) => s.status === 'error');
  assert.ok(errIdx >= 0, 'error status pushed');
  assert.equal(
    statuses.slice(errIdx + 1).find((s) => s.status === 'idle'),
    undefined,
    'no idle status after error',
  );
  assert.equal(mgr.isStreaming(), false);
});

test('grace timer pending when source errors → no idle status revives the error', async () => {
  // Client leaves first (grace scheduled while streaming), then the source
  // dies before the grace fires — the callback must not overwrite 'error'.
  const { mgr, src, statuses } = build({ graceMs: 20 });
  const c = fakeClient();
  mgr.attach(c);
  await tick();
  src.frame(jpeg(1));
  c.emit('close');
  src.exit({ reason: 'capture died' });
  await new Promise((r) => setTimeout(r, 60));
  const errIdx = statuses.findIndex((s) => s.status === 'error');
  assert.ok(errIdx >= 0, 'error status pushed');
  assert.equal(
    statuses.slice(errIdx + 1).find((s) => s.status === 'idle'),
    undefined,
    'grace callback must not push idle over an error state',
  );
  assert.equal(mgr.isStreaming(), false);
});

test('sole client dropped on attach-write throw → grace stop still fires', async () => {
  const { mgr, src } = build({ graceMs: 20 });
  const a = fakeClient();
  mgr.attach(a);
  await tick();
  src.frame(jpeg(1)); // streaming, latest frame cached
  a.emit('close'); // last client leaves → grace pending
  const b = fakeClient();
  b.write = () => {
    throw new Error('destroyed');
  }; // immediate-write throw on attach
  mgr.attach(b); // cancels grace, then drops b on the throw
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(src.stopped, true, 'pipeline reaped despite dropped reconnect');
});

test('broadcast write-throw dropping the last client → grace stop still fires', async () => {
  const { mgr, src } = build({ graceMs: 20 });
  const a = fakeClient();
  mgr.attach(a);
  await tick();
  src.frame(jpeg(1));
  a.write = () => {
    throw new Error('destroyed');
  };
  src.frame(jpeg(2)); // broadcast drops a → zero clients
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(src.stopped, true, 'pipeline reaped after broadcast drop');
});

test('a client whose end() throws does not prevent ending the others', async () => {
  const { mgr, statuses } = build({
    resolution: { ok: false, reason: 'nope' },
  });
  const bad = fakeClient();
  bad.end = () => {
    throw new Error('already destroyed');
  };
  const good = fakeClient();
  mgr.attach(bad);
  mgr.attach(good);
  await tick();
  assert.equal(good.ended, true, 'good client ended despite bad sibling');
  assert.equal(statuses.find((s) => s.status === 'error').reason, 'nope');
});
