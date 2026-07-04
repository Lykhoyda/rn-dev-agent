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
