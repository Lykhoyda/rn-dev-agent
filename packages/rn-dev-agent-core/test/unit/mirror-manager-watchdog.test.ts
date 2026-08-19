// GH #791: a mirror pipeline that never produces a frame must become a typed,
// bounded error — never an indefinitely open frameless multipart stream that a
// browser renders as a blank pane with a spinner while the page claims "live".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { MirrorManager, type MirrorStatus } from '../../dist/observability/mirror/manager.js';
import type { MirrorSource, MirrorFrameSink } from '../../dist/observability/mirror/sources.js';

const jpeg = (fill: number): Buffer =>
  Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(4, fill), Buffer.from([0xff, 0xd9])]);

interface FakeClient {
  chunks: Buffer[];
  ended: boolean;
  status: number;
  writeHead(s: number, h: Record<string, string>): void;
  write(b: Buffer | string): boolean;
  end(): void;
  on(e: 'close' | 'drain', cb: () => void): void;
}

function fakeClient(): FakeClient {
  const em = new EventEmitter();
  const c: FakeClient = {
    chunks: [],
    ended: false,
    status: 0,
    writeHead(s) {
      c.status = s;
    },
    write(b) {
      c.chunks.push(Buffer.from(b));
      return true;
    },
    end() {
      c.ended = true;
    },
    on: (e, cb) => void em.on(e, cb),
  };
  return c;
}

interface FakeSource extends MirrorSource {
  frame(f: Buffer): void;
  restart(): void;
  exit(e?: { reason: string }): void;
  started: boolean;
}

interface StopTracking {
  stops: number;
}

function fakeSource(): FakeSource & StopTracking {
  let sink: MirrorFrameSink | null = null;
  const src: FakeSource & StopTracking = {
    pipeline: 'idb',
    nominalFps: 20,
    stops: 0,
    started: false,
    start(s: MirrorFrameSink) {
      sink = s;
      src.started = true;
    },
    stop() {
      src.stops += 1;
    },
    frame(f: Buffer) {
      sink?.onFrame(f);
    },
    restart() {
      sink?.onRestart?.();
    },
    exit(e?: { reason: string }) {
      sink?.onExit(e);
    },
  };
  return src;
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test('watchdog: resolveTarget that never settles becomes a bounded typed error', async () => {
  const statuses: MirrorStatus[] = [];
  const mgr = new MirrorManager({
    resolveTarget: () => new Promise(() => {}),
    createSource: async () => fakeSource(),
    pushStatus: (s) => statuses.push(s),
    graceMs: 10,
    firstFrameWatchdogMs: 150,
  });
  const c = fakeClient();
  mgr.attach(c);
  await wait(400);
  const err = statuses.find((s) => s.status === 'error');
  assert.ok(err, 'watchdog must surface a typed error status');
  assert.match(err.reason ?? '', /no mirror frame/i);
  assert.equal(c.ended, true, 'the frameless multipart stream must be closed');
  assert.equal(mgr.isStreaming(), false);
});

test('watchdog: a source that stays alive without a first frame is torn down', async () => {
  const statuses: MirrorStatus[] = [];
  const src = fakeSource();
  const mgr = new MirrorManager({
    resolveTarget: async () => ({
      ok: true,
      target: { platform: 'ios', deviceId: 'U1' },
    }),
    createSource: async () => src,
    pushStatus: (s) => statuses.push(s),
    graceMs: 10,
    firstFrameWatchdogMs: 150,
  });
  const c = fakeClient();
  mgr.attach(c);
  await wait(400);
  const err = statuses.find((s) => s.status === 'error');
  assert.ok(err, 'alive-but-frameless source must become an error');
  assert.match(err.reason ?? '', /no mirror frame/i);
  assert.equal(c.ended, true);
  assert.equal(src.stops, 1, 'the frameless capture source must be reaped, not leaked');
});

test('watchdog: empty and non-JPEG buffers are not liveness — still fails closed', async () => {
  const statuses: MirrorStatus[] = [];
  const src = fakeSource();
  const mgr = new MirrorManager({
    resolveTarget: async () => ({
      ok: true,
      target: { platform: 'ios', deviceId: 'U1' },
    }),
    createSource: async () => src,
    pushStatus: (s) => statuses.push(s),
    graceMs: 10,
    firstFrameWatchdogMs: 150,
  });
  const c = fakeClient();
  mgr.attach(c);
  for (let i = 0; i < 20 && !src.started; i++) await wait(5);
  src.frame(Buffer.alloc(0));
  src.frame(Buffer.from('not-a-jpeg'));
  await wait(400);
  assert.equal(
    statuses.some((s) => s.status === 'streaming'),
    false,
    'garbage buffers must never publish a positive streaming state',
  );
  const err = statuses.find((s) => s.status === 'error');
  assert.ok(err, 'zero real frames must fail closed');
  assert.match(err.reason ?? '', /no mirror frame/i);
  // "produced nothing" and "produced N buffers we rejected" are different
  // failures and must not present as the same generic timeout (GH #791).
  assert.match(err.reason ?? '', /2 unusable buffer/i);
  assert.match(err.hint ?? '', /cannot decode as JPEG/i);
  assert.equal(c.ended, true);
});

// GH #791 regression: IosIdbSource re-arms its OWN first-frame budget on every
// respawn its RestartGate allows, so a manager watchdog armed once per pipeline
// (source budget + slack) can expire mid-respawn and reap the pipeline before
// the source ever reaches the idb→simctl demotion the slack exists to protect.
test('watchdog: a source respawn re-arms the bound so demotion still runs first', async () => {
  const statuses: MirrorStatus[] = [];
  const idb = fakeSource();
  const fallback = fakeSource();
  const mgr = new MirrorManager({
    resolveTarget: async () => ({
      ok: true,
      target: { platform: 'ios', deviceId: 'U1' },
    }),
    createSource: async () => idb,
    createFallbackSource: async () => fallback,
    pushStatus: (s) => statuses.push(s),
    graceMs: 5000,
    firstFrameWatchdogMs: 150,
  });
  const c = fakeClient();
  mgr.attach(c);
  for (let i = 0; i < 20 && !idb.started; i++) await wait(5);

  // The source's child died and respawned with a fresh first-frame budget…
  await wait(100);
  idb.restart();
  // …so its own budget, not the manager's, is what must expire first: past the
  // original deadline the pipeline is still the live idb attempt.
  await wait(100);
  assert.equal(
    statuses.some((s) => s.status === 'error'),
    false,
    'the manager must not reap a source that just restarted its own budget',
  );
  assert.equal(
    fallback.started,
    false,
    'the manager preempted the respawned source instead of letting its own budget decide',
  );
  assert.equal(idb.stops, 0, 'the respawned source must not be reaped mid-attempt');

  idb.exit({ reason: 'idb video-stream produced no first frame' });
  for (let i = 0; i < 20 && !fallback.started; i++) await wait(5);
  assert.equal(fallback.started, true, 'the simctl fallback must still get its chance');
  assert.equal(c.ended, false, 'demotion preserves the live multipart client');
});

test('watchdog: endless source respawns stay bounded and end in a typed error', async () => {
  const statuses: MirrorStatus[] = [];
  const src = fakeSource();
  const mgr = new MirrorManager({
    resolveTarget: async () => ({
      ok: true,
      target: { platform: 'ios', deviceId: 'U1' },
    }),
    createSource: async () => src,
    pushStatus: (s) => statuses.push(s),
    graceMs: 5000,
    firstFrameWatchdogMs: 150,
  });
  const c = fakeClient();
  mgr.attach(c);
  for (let i = 0; i < 20 && !src.started; i++) await wait(5);
  // A source flapping faster than its own budget would extend the bound
  // forever if every respawn re-armed it — that is the frameless stream #791
  // exists to close.
  const flap = setInterval(() => src.restart(), 40);
  await wait(1200);
  clearInterval(flap);
  const err = statuses.find((s) => s.status === 'error');
  assert.ok(err, 'an endlessly respawning frameless source must still be reaped');
  assert.match(err.reason ?? '', /no mirror frame/i);
  assert.equal(c.ended, true);
});

test('watchdog: an expired idb budget demotes instead of killing a recoverable mirror', async () => {
  const statuses: MirrorStatus[] = [];
  const idb = fakeSource();
  const fallback = fakeSource();
  const mgr = new MirrorManager({
    resolveTarget: async () => ({
      ok: true,
      target: { platform: 'ios', deviceId: 'U1' },
    }),
    createSource: async () => idb,
    createFallbackSource: async () => fallback,
    pushStatus: (s) => statuses.push(s),
    graceMs: 5000,
    firstFrameWatchdogMs: 150,
  });
  const c = fakeClient();
  mgr.attach(c);
  for (let i = 0; i < 20 && !idb.started; i++) await wait(5);
  // The source never exits on its own (idb alive but silent past every budget).
  for (let i = 0; i < 40 && !fallback.started; i++) await wait(10);
  assert.equal(fallback.started, true, 'an expired idb budget must reach the simctl fallback');
  assert.equal(idb.stops, 1, 'the silent idb source must be reaped, not leaked');
  assert.equal(c.ended, false, 'the client the demotion exists for must survive');

  // Still bounded: a fallback that is also frameless ends in a typed error.
  fallback.frame(jpeg(2));
  await wait(50);
  assert.equal(mgr.isStreaming(), true, 'the demoted pipeline mirrors once it frames');
});

test('watchdog: a frame before the deadline disarms it', async () => {
  const statuses: MirrorStatus[] = [];
  const src = fakeSource();
  const mgr = new MirrorManager({
    resolveTarget: async () => ({
      ok: true,
      target: { platform: 'ios', deviceId: 'U1' },
    }),
    createSource: async () => src,
    pushStatus: (s) => statuses.push(s),
    graceMs: 5000,
    firstFrameWatchdogMs: 150,
  });
  const c = fakeClient();
  mgr.attach(c);
  // Synchronize on the sink actually being installed instead of racing a
  // fixed sleep against the watchdog (a pre-sink frame would be dropped).
  for (let i = 0; i < 20 && !src.started; i++) await wait(5);
  assert.equal(src.started, true, 'pipeline must have started before framing');
  src.frame(jpeg(1));
  await wait(300);
  assert.equal(
    statuses.some((s) => s.status === 'error'),
    false,
    'no watchdog error after a real frame arrived',
  );
  assert.equal(mgr.isStreaming(), true);
});

test('watchdog: a resolution refusal keeps exactly one error status', async () => {
  const statuses: MirrorStatus[] = [];
  const mgr = new MirrorManager({
    resolveTarget: async () => ({ ok: false, reason: 'no device' }),
    createSource: async () => fakeSource(),
    pushStatus: (s) => statuses.push(s),
    graceMs: 10,
    firstFrameWatchdogMs: 150,
  });
  mgr.attach(fakeClient());
  await wait(450);
  assert.equal(statuses.filter((s) => s.status === 'error').length, 1);
});

test('watchdog: shutdown before the deadline never fires it', async () => {
  const statuses: MirrorStatus[] = [];
  const mgr = new MirrorManager({
    resolveTarget: () => new Promise(() => {}),
    createSource: async () => fakeSource(),
    pushStatus: (s) => statuses.push(s),
    graceMs: 10,
    firstFrameWatchdogMs: 150,
  });
  mgr.attach(fakeClient());
  await wait(10);
  mgr.shutdown();
  // Past the 150ms deadline: a leaked timer would fire inside this window.
  await wait(300);
  assert.equal(
    statuses.some((s) => s.status === 'error'),
    false,
  );
});

// GH #791 regression: an UNCODED refusal carries no typed code, so the web UI
// has no latched blocked state to freeze on — every status the manager pushes
// is fed straight back into DevicePane's retry budget. A status that a fast
// refusal immediately supersedes therefore re-arms the pane, remounts <img>,
// re-attaches, and restarts the pipeline forever.
test('uncoded refusal: one error status, no re-arm loop across client re-attaches', async () => {
  const statuses: MirrorStatus[] = [];
  let mgr: MirrorManager | null = null;
  let rearms = 0;
  const MAX_REARMS = 8;
  mgr = new MirrorManager({
    resolveTarget: async () => ({ ok: false, reason: 'no active device session' }),
    createSource: async () => fakeSource(),
    pushStatus: (s) => {
      statuses.push(s);
      // DevicePane resets `attempts` and bumps the cache-busting nonce on a
      // starting/streaming status; the resulting <img> remount re-attaches on
      // a later turn, which is what closes the loop.
      if (s.status !== 'starting' && s.status !== 'streaming') return;
      if (rearms >= MAX_REARMS) return;
      rearms += 1;
      setTimeout(() => mgr?.attach(fakeClient()), 0);
    },
    graceMs: 10,
    firstFrameWatchdogMs: 150,
  });
  mgr.attach(fakeClient());
  await wait(400);
  assert.equal(rearms, 0, 'a fast uncoded refusal must not re-arm the pane retry budget');
  assert.deepEqual(
    statuses.map((s) => s.status),
    ['error'],
    'exactly one error and nothing the client can treat as a fresh retry budget',
  );
});

test('demotion: silent to the pane, still watchdog-bounded when the fallback is frameless', async () => {
  const statuses: MirrorStatus[] = [];
  const idb = fakeSource();
  const fallback = fakeSource();
  const mgr = new MirrorManager({
    resolveTarget: async () => ({
      ok: true,
      target: { platform: 'ios', deviceId: 'U1' },
    }),
    createSource: async () => idb,
    createFallbackSource: async () => fallback,
    pushStatus: (s) => statuses.push(s),
    graceMs: 5000,
    firstFrameWatchdogMs: 150,
  });
  const c = fakeClient();
  mgr.attach(c);
  for (let i = 0; i < 20 && !idb.started; i++) await wait(5);
  const beforeDemotion = statuses.length;
  idb.exit({ reason: 'idb produced no frames' });
  for (let i = 0; i < 20 && !fallback.started; i++) await wait(5);
  assert.equal(c.ended, false, 'demotion must preserve the live multipart client');
  assert.deepEqual(
    statuses.slice(beforeDemotion),
    [],
    'any status here re-arms the pane, remounting <img> and tearing down that client',
  );
  await wait(300);
  const err = statuses.find((s) => s.status === 'error');
  assert.ok(err, 'a frameless fallback must still end in a typed error');
  assert.match(err.reason ?? '', /no mirror frame/i);
  assert.equal(fallback.stops, 1, 'the frameless fallback source must be reaped');
  assert.equal(c.ended, true);
});
