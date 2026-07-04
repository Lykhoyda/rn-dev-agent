# Observe UI Live Device Mirroring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Continuous Maestro-style MJPEG mirroring of the simulator/emulator screen in the observe web UI, replacing the frozen-between-tool-calls screenshot.

**Architecture:** Child-process capture sources (idb / simctl loop on iOS, adb screenrecord→ffmpeg on Android) feed a JPEG frame extractor; a refcounted `MirrorManager` broadcasts the newest frame to `<img>` clients over a new `GET /api/device/mirror` `multipart/x-mixed-replace` route on the existing observe server. Mirror status rides the existing recorder SSE stream as `{type:'mirror'}` events.

**Tech Stack:** Node 22 ESM TypeScript (`scripts/cdp-bridge`, compiled to committed `dist/`), `node --test` unit tests against `dist/`, React SPA built by Vite into committed `dist/observability/web-dist/index.html`.

**Spec:** `docs/superpowers/specs/2026-07-04-observe-live-mirror-design.md`

## Global Constraints

- Node `>=22`, `"type": "module"` — all intra-package imports use `.js` extensions.
- Tests are `node --test` files in `scripts/cdp-bridge/test/unit/` importing from `../../dist/...` — **you must `npm run build` (tsc) before tests run; `npm test` does this automatically.**
- `dist/` is git-tracked: every commit that changes `src/` must include the rebuilt `dist/` files.
- The SPA bundle `scripts/cdp-bridge/dist/observability/web-dist/index.html` is git-tracked; CI (`scripts/check-web-bundle.sh`) fails if it doesn't match a fresh `npm run build:web`.
- Use explicit type imports (`import type { X }`) — user rule + repo convention.
- No child process may use a shell — `spawn`/`execFile` with argv arrays only (repo security convention).
- Every failure must degrade to today's behavior (GH #206 event-driven screenshot), never below it.
- Config precedence for all observe settings: env > `.rn-agent/config.json` > default (see `resolveObservePort`).
- CI requires a changeset; package name must be exactly `rn-dev-agent-cdp` (and `rn-dev-agent-plugin` if plugin files change).
- Run commands from `scripts/cdp-bridge/` unless a path says otherwise.

---

### Task 1: JPEG frame extractor

**Files:**
- Create: `scripts/cdp-bridge/src/observability/mirror/jpeg-stream.ts`
- Test: `scripts/cdp-bridge/test/unit/mirror-jpeg-stream.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `class JpegFrameExtractor { push(chunk: Buffer): Buffer[] }` and `const MAX_FRAME_BYTES = 8_000_000`. Later tasks feed child-process stdout chunks in and broadcast the returned complete JPEG frames.

- [ ] **Step 1: Write the failing test**

```js
// scripts/cdp-bridge/test/unit/mirror-jpeg-stream.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JpegFrameExtractor, MAX_FRAME_BYTES } from '../../dist/observability/mirror/jpeg-stream.js';

const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);
const jpeg = (fill, size = 16) =>
  Buffer.concat([SOI, Buffer.alloc(size, fill), EOI]);

test('extracts a single complete frame from one chunk', () => {
  const x = new JpegFrameExtractor();
  const f = jpeg(1);
  const frames = x.push(f);
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0], f);
});

test('extracts back-to-back frames from one chunk', () => {
  const x = new JpegFrameExtractor();
  const a = jpeg(1);
  const b = jpeg(2);
  const frames = x.push(Buffer.concat([a, b]));
  assert.equal(frames.length, 2);
  assert.deepEqual(frames[0], a);
  assert.deepEqual(frames[1], b);
});

test('reassembles a frame split across chunks, including EOI split at the boundary', () => {
  const x = new JpegFrameExtractor();
  const f = jpeg(3, 64);
  // Split so the FF of the EOI ends chunk 1 and D9 starts chunk 2.
  const cut = f.length - 1;
  assert.deepEqual(x.push(f.subarray(0, cut)), []);
  const frames = x.push(f.subarray(cut));
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0], f);
});

test('discards garbage before SOI (multipart headers, ffmpeg noise)', () => {
  const x = new JpegFrameExtractor();
  const f = jpeg(4);
  const frames = x.push(Buffer.concat([Buffer.from('--boundary\r\nContent-Type: image/jpeg\r\n\r\n'), f]));
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0], f);
});

test('resets accumulator when a frame exceeds MAX_FRAME_BYTES without EOI', () => {
  const x = new JpegFrameExtractor();
  const oversized = Buffer.concat([SOI, Buffer.alloc(MAX_FRAME_BYTES, 0)]);
  assert.deepEqual(x.push(oversized), []);
  // After the reset a fresh well-formed frame must still come through.
  const f = jpeg(5);
  const frames = x.push(f);
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0], f);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd scripts/cdp-bridge && npm run build 2>&1 | tail -5; node --test test/unit/mirror-jpeg-stream.test.js`
Expected: FAIL — `Cannot find module .../dist/observability/mirror/jpeg-stream.js`

- [ ] **Step 3: Write the implementation**

```ts
// scripts/cdp-bridge/src/observability/mirror/jpeg-stream.ts
/**
 * Incremental JPEG frame extraction from a byte stream (idb mjpeg stdout,
 * ffmpeg -f mjpeg stdout). Frames are delimited by SOI (FF D8) / EOI (FF D9).
 * Safe here because neither producer embeds EXIF thumbnails (which would
 * contain a nested EOI) — see spec 2026-07-04-observe-live-mirror-design.
 */
export const MAX_FRAME_BYTES = 8_000_000;

const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);

export class JpegFrameExtractor {
  private acc: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): Buffer[] {
    this.acc = this.acc.length === 0 ? chunk : Buffer.concat([this.acc, chunk]);
    const frames: Buffer[] = [];
    for (;;) {
      const soi = this.acc.indexOf(SOI);
      if (soi === -1) {
        // No frame start in sight — nothing before SOI is ever useful.
        this.acc = Buffer.alloc(0);
        break;
      }
      if (soi > 0) this.acc = this.acc.subarray(soi);
      const eoi = this.acc.indexOf(EOI, SOI.length);
      if (eoi === -1) {
        if (this.acc.length > MAX_FRAME_BYTES) this.acc = Buffer.alloc(0);
        break;
      }
      frames.push(this.acc.subarray(0, eoi + EOI.length));
      this.acc = this.acc.subarray(eoi + EOI.length);
    }
    return frames;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/mirror-jpeg-stream.test.js`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add scripts/cdp-bridge/src/observability/mirror/jpeg-stream.ts scripts/cdp-bridge/test/unit/mirror-jpeg-stream.test.js scripts/cdp-bridge/dist
git commit -m "feat(observe-mirror): JPEG frame extractor for mjpeg byte streams"
```

---

### Task 2: Mirror config resolution

**Files:**
- Modify: `scripts/cdp-bridge/src/project-config.ts` (extend `RnAgentConfig.observe`, add resolver — follow the `resolveObservePort` pattern at `project-config.ts:183`)
- Test: `scripts/cdp-bridge/test/unit/mirror-config.test.js`

**Interfaces:**
- Consumes: existing `RnAgentConfig`, `readRnAgentConfig` (both already in `project-config.ts`).
- Produces:
  - `RnAgentConfig.observe` gains `mirror?: { enabled?: boolean; fps?: number }`.
  - `export const DEFAULT_MIRROR_FPS = 20;`
  - `export interface MirrorConfigResolution { enabled: boolean; fps: number; source: 'env' | 'config' | 'default' }`
  - `export function resolveMirrorConfig(deps?: { env?: string; readConfig?: () => RnAgentConfig | null }): MirrorConfigResolution` — env is `RN_AGENT_OBSERVE_MIRROR` (`'0'`/`'false'` disable, `'1'`/`'true'` enable); fps comes from config only, clamped to 5–30, default 20.

- [ ] **Step 1: Write the failing test**

```js
// scripts/cdp-bridge/test/unit/mirror-config.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveMirrorConfig, DEFAULT_MIRROR_FPS } from '../../dist/project-config.js';

test('default: enabled, fps 20', () => {
  assert.deepEqual(resolveMirrorConfig({ env: undefined, readConfig: () => null }), {
    enabled: true,
    fps: DEFAULT_MIRROR_FPS,
    source: 'default',
  });
});

test('env "0"/"false" disables even when config enables', () => {
  const readConfig = () => ({ observe: { mirror: { enabled: true } } });
  for (const env of ['0', 'false']) {
    assert.equal(resolveMirrorConfig({ env, readConfig }).enabled, false);
    assert.equal(resolveMirrorConfig({ env, readConfig }).source, 'env');
  }
});

test('env "1"/"true" enables over config false', () => {
  const readConfig = () => ({ observe: { mirror: { enabled: false } } });
  for (const env of ['1', 'true']) {
    assert.equal(resolveMirrorConfig({ env, readConfig }).enabled, true);
  }
});

test('config enabled:false respected when env unset', () => {
  const r = resolveMirrorConfig({
    env: undefined,
    readConfig: () => ({ observe: { mirror: { enabled: false } } }),
  });
  assert.deepEqual({ enabled: r.enabled, source: r.source }, { enabled: false, source: 'config' });
});

test('fps: config value used, clamped to 5..30, junk → default', () => {
  const mk = (fps) => resolveMirrorConfig({ env: undefined, readConfig: () => ({ observe: { mirror: { fps } } }) }).fps;
  assert.equal(mk(12), 12);
  assert.equal(mk(1), 5);
  assert.equal(mk(120), 30);
  assert.equal(mk('fast'), DEFAULT_MIRROR_FPS);
  assert.equal(mk(undefined), DEFAULT_MIRROR_FPS);
});

test('config read errors fail open (enabled, defaults)', () => {
  const r = resolveMirrorConfig({ env: undefined, readConfig: () => { throw new Error('boom'); } });
  assert.deepEqual(r, { enabled: true, fps: DEFAULT_MIRROR_FPS, source: 'default' });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/mirror-config.test.js`
Expected: FAIL — build error or `resolveMirrorConfig is not a function`

- [ ] **Step 3: Implement in `project-config.ts`**

Extend the `RnAgentConfig` interface field (currently `observe?: { autoStart?: boolean; port?: number }` at `project-config.ts:96`):

```ts
  observe?: { autoStart?: boolean; port?: number; mirror?: { enabled?: boolean; fps?: number } };
```

Append (near `resolveObservePort`):

```ts
export const DEFAULT_MIRROR_FPS = 20;
const MIRROR_FPS_MIN = 5;
const MIRROR_FPS_MAX = 30;

export interface MirrorConfigResolution {
  enabled: boolean;
  fps: number;
  source: 'env' | 'config' | 'default';
}

/** Spec 2026-07-04 (observe live mirror): env > config > default; errors fail open. */
export function resolveMirrorConfig(
  deps: { env?: string; readConfig?: () => RnAgentConfig | null } = {},
): MirrorConfigResolution {
  const envRaw = 'env' in deps ? deps.env : process.env.RN_AGENT_OBSERVE_MIRROR;
  let cfg: RnAgentConfig | null = null;
  try {
    cfg = (deps.readConfig ?? readRnAgentConfig)();
  } catch {
    cfg = null;
  }
  const rawFps = cfg?.observe?.mirror?.fps;
  const fps =
    typeof rawFps === 'number' && Number.isFinite(rawFps)
      ? Math.min(MIRROR_FPS_MAX, Math.max(MIRROR_FPS_MIN, Math.round(rawFps)))
      : DEFAULT_MIRROR_FPS;
  if (envRaw === '0' || envRaw === 'false') return { enabled: false, fps, source: 'env' };
  if (envRaw === '1' || envRaw === 'true') return { enabled: true, fps, source: 'env' };
  const cfgEnabled = cfg?.observe?.mirror?.enabled;
  if (typeof cfgEnabled === 'boolean') return { enabled: cfgEnabled, fps, source: 'config' };
  return { enabled: true, fps, source: 'default' };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/mirror-config.test.js`
Expected: PASS (6 tests)

- [ ] **Step 5: Run the full existing config suite for regressions**

Run: `cd scripts/cdp-bridge && node --test test/unit/observe-config.test.js`
Expected: PASS (no existing behavior changed)

- [ ] **Step 6: Commit**

```bash
git add scripts/cdp-bridge/src/project-config.ts scripts/cdp-bridge/test/unit/mirror-config.test.js scripts/cdp-bridge/dist
git commit -m "feat(observe-mirror): resolveMirrorConfig — observe.mirror.{enabled,fps} with env override"
```

---

### Task 3: Capture sources (idb, simctl loop, screenrecord→ffmpeg)

**Files:**
- Create: `scripts/cdp-bridge/src/observability/mirror/sources.ts`
- Test: `scripts/cdp-bridge/test/unit/mirror-sources.test.js`

**Interfaces:**
- Consumes: `JpegFrameExtractor` from `./jpeg-stream.js` (Task 1).
- Produces (Task 4 and 6 rely on these exact names):

```ts
export interface MirrorFrameSink {
  onFrame(frame: Buffer): void;
  /** Terminal for this attach cycle. err absent = deliberate stop. */
  onExit(err?: { reason: string; hint?: string }): void;
}
export interface MirrorSource {
  readonly pipeline: 'idb' | 'simctl' | 'screenrecord';
  readonly nominalFps: number;
  start(sink: MirrorFrameSink): void;
  stop(): void;
}
export class RestartGate {
  constructor(limit?: number, windowMs?: number, now?: () => number); // 3, 10_000, Date.now
  /** Records one exit; true = caller may restart, false = give up. */
  record(): boolean;
}
export class IosIdbSource implements MirrorSource {
  constructor(udid: string, fps: number, opts?: SourceOpts);
}
export class IosSimctlLoopSource implements MirrorSource {
  constructor(udid: string, opts?: LoopOpts);
}
export class AndroidScreenrecordSource implements MirrorSource {
  constructor(serial: string, opts?: SourceOpts);
}
export interface SourceOpts { spawnFn?: SpawnFn; now?: () => number; restartDelayMs?: number }
export interface LoopOpts { execJpeg?: (cmd: string, args: string[]) => Promise<Buffer>; now?: () => number; idleDelayMs?: number }
export type SpawnFn = (cmd: string, args: string[]) => SpawnedLike;
export interface SpawnedLike {
  stdout: NodeJS.ReadableStream;
  stdin?: NodeJS.WritableStream;
  stderr?: NodeJS.ReadableStream;
  on(event: 'close' | 'error', cb: (arg?: unknown) => void): void;
  kill(): void;
}
export function detectIdb(execFileFn?: typeof execFile): Promise<boolean>;
export async function createMirrorSource(target: { platform: 'ios' | 'android'; deviceId: string }, fps: number): Promise<MirrorSource>;
```

Commands (argv arrays, never a shell):
- idb: `idb` + `['video-stream', '--udid', udid, '--fps', String(fps), '--format', 'mjpeg', '--compression-quality', '0.7']`
- simctl loop: `xcrun` + `['simctl', 'io', udid, 'screenshot', '--type=jpeg', '-']` (sequential; next capture starts when previous resolves; `idleDelayMs` floor 25 ms between captures)
- android: `adb` + `['-s', serial, 'exec-out', 'screenrecord', '--output-format=h264', '--time-limit=179', '-']`, its stdout piped into `ffmpeg` + `['-loglevel', 'error', '-fflags', 'nobuffer', '-f', 'h264', '-i', 'pipe:0', '-q:v', '7', '-f', 'mjpeg', 'pipe:1']`

Behavior rules (all three sources):
- After `stop()`, never call `sink.onFrame`/`sink.onExit` (guard flag).
- Process exit → `RestartGate.record()`: `true` → respawn after `restartDelayMs` (default 300, tests pass 0); `false` → `sink.onExit({ reason })`.
- ffmpeg/idb spawn `error` event with `code === 'ENOENT'` → immediate `sink.onExit` with an install hint (`'ffmpeg not found — run scripts/ensure-ffmpeg.sh or brew install ffmpeg'` / `'idb not found'`), no restart.
- simctl loop: a successful capture emits one frame; a failed capture counts via `RestartGate` (3 fails in 10 s → `onExit({ reason: 'simctl screenshot failing' })`), with a 500 ms pause after each failure.
- `IosSimctlLoopSource.nominalFps = 6`, hint constant `'install idb for smoother mirroring (brew install idb-companion && pipx install fb-idb)'` exported as `SIMCTL_HINT` — the manager attaches it to status.
- `AndroidScreenrecordSource.nominalFps = 25`, `IosIdbSource.nominalFps = fps` (constructor arg).
- `createMirrorSource`: android → `AndroidScreenrecordSource`; ios → `await detectIdb()` ? `IosIdbSource` : `IosSimctlLoopSource`. `detectIdb` = `execFile('which', ['idb'])` resolves true on exit 0, false otherwise.

- [ ] **Step 1: Write the failing tests**

```js
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

test('SIMCTL_HINT names idb', () => {
  assert.match(SIMCTL_HINT, /idb/);
});
```

Note: `IosSimctlLoopSource` needs one extra `LoopOpts` field the interface block above omits for brevity — `failurePauseMs?: number` (default 500, tests pass 0).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd scripts/cdp-bridge && npm run build; node --test test/unit/mirror-sources.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `sources.ts`**

Implementation skeleton (fill method bodies exactly as behavior rules above; ~230 lines):

```ts
// scripts/cdp-bridge/src/observability/mirror/sources.ts
import { spawn, execFile } from 'node:child_process';
import { JpegFrameExtractor } from './jpeg-stream.js';

// [paste the exact exported interfaces/types from the Interfaces block]

export const SIMCTL_HINT =
  'install idb for smoother mirroring (brew install idb-companion && pipx install fb-idb)';

export class RestartGate {
  private exits: number[] = [];
  constructor(
    private readonly limit = 3,
    private readonly windowMs = 10_000,
    private readonly now: () => number = Date.now,
  ) {}
  record(): boolean {
    const t = this.now();
    this.exits = this.exits.filter((e) => t - e < this.windowMs);
    this.exits.push(t);
    return this.exits.length < this.limit;
  }
}

const defaultSpawn: SpawnFn = (cmd, args) =>
  spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] }) as unknown as SpawnedLike;

export async function detectIdb(execFileFn: typeof execFile = execFile): Promise<boolean> {
  return new Promise((resolve) => {
    execFileFn('which', ['idb'], { timeout: 3000 }, (err) => resolve(!err));
  });
}
```

`IosIdbSource.start(sink)`: set `active = true`, spawn, `proc.stdout.on('data', chunk => extractor.push(chunk).forEach(f => active && sink.onFrame(f)))`; `proc.on('error', err)` → if ENOENT and active → `sink.onExit({ reason: 'idb not found', hint: 'idb not found — brew install idb-companion && pipx install fb-idb' })`, `active = false`; `proc.on('close')` → if active: `gate.record()` ? `setTimeout(respawn, restartDelayMs)` : `sink.onExit({ reason: 'idb video-stream keeps exiting' })`. `stop()`: `active = false; proc?.kill()`.

`IosSimctlLoopSource.start(sink)`: async loop — `while (active) { try { const buf = await execJpeg('xcrun', [...]); if (!active) break; sink.onFrame(buf); await sleep(idleDelayMs); } catch { if (!gate.record()) { if (active) sink.onExit({ reason: 'simctl screenshot failing', hint: SIMCTL_HINT }); active = false; break; } await sleep(failurePauseMs); } }`. Default `execJpeg` uses `execFile` with `{ encoding: 'buffer', maxBuffer: 16 * 1024 * 1024, timeout: 10_000 }` and resolves `stdout` as `Buffer`. Defaults: `idleDelayMs = 25`, `failurePauseMs = 500`.

`AndroidScreenrecordSource.start(sink)`: `spawnCycle()` spawns adb then ffmpeg, `adb.stdout.pipe(ffmpeg.stdin)` (guard: only if `ffmpeg.stdin`), frames from `ffmpeg.stdout` through a **fresh** `JpegFrameExtractor` per cycle; ENOENT on either proc's `'error'` → hint (`ffmpeg` hint text for ffmpeg, plain reason for adb), `active = false`, kill both; either proc `'close'` while active → kill the sibling, `gate.record()` ? schedule `spawnCycle` after `restartDelayMs` : `sink.onExit({ reason: 'screen capture pipeline keeps exiting' })`. `stop()` kills both. Guard against double-handling one cycle's two close events (a `cycleDone` flag per cycle).

`createMirrorSource`: as specified in the Interfaces block.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/mirror-sources.test.js`
Expected: PASS (11 tests)

- [ ] **Step 5: Commit**

```bash
git add scripts/cdp-bridge/src/observability/mirror/sources.ts scripts/cdp-bridge/test/unit/mirror-sources.test.js scripts/cdp-bridge/dist
git commit -m "feat(observe-mirror): capture sources — idb, simctl loop, screenrecord+ffmpeg with restart gate"
```

---

### Task 4: MirrorManager — refcount lifecycle, multipart broadcast, status events

**Files:**
- Create: `scripts/cdp-bridge/src/observability/mirror/manager.ts`
- Create: `scripts/cdp-bridge/src/observability/mirror/target.ts`
- Test: `scripts/cdp-bridge/test/unit/mirror-manager.test.js`
- Test: `scripts/cdp-bridge/test/unit/mirror-target.test.js`

**Interfaces:**
- Consumes: `MirrorSource`, `MirrorFrameSink` from `./sources.js` (Task 3).
- Produces (Tasks 5–6 rely on these exact names):

```ts
// target.ts
export interface MirrorTarget { platform: 'ios' | 'android'; deviceId: string }
export type MirrorTargetResolution =
  | { ok: true; target: MirrorTarget }
  | { ok: false; reason: string; hint?: string };
export interface MirrorTargetDeps {
  getPlatform(): 'ios' | 'android' | null;          // session platform, else CDP target platform
  getSessionDeviceId(): string | undefined;          // active session's bound device
  resolveIosUdid(): Promise<string | undefined>;     // single-booted-else-undefined (GH #422 policy)
  listAndroidSerials(): Promise<string[]>;           // connected 'device'-state serials
}
export function buildMirrorTargetResolver(deps: MirrorTargetDeps): () => Promise<MirrorTargetResolution>;

// manager.ts
export interface MirrorStatus {
  type: 'mirror';
  status: 'starting' | 'streaming' | 'error' | 'idle';
  platform?: string;
  deviceId?: string;
  pipeline?: string;
  fps?: number;
  hint?: string;
  reason?: string;
}
export interface MirrorClient {
  writeHead(status: number, headers: Record<string, string>): void;
  write(chunk: Buffer | string): boolean;
  end(): void;
  on(event: 'close' | 'drain', cb: () => void): void;
}
export interface MirrorManagerDeps {
  resolveTarget(): Promise<MirrorTargetResolution>;
  createSource(target: MirrorTarget): Promise<MirrorSource>;
  pushStatus(s: MirrorStatus): void;
  graceMs?: number; // default 5000
}
export class MirrorManager {
  constructor(deps: MirrorManagerDeps);
  attach(client: MirrorClient): void;
  isStreaming(): boolean;   // true once ≥1 frame received this cycle and pipeline alive
  shutdown(): void;         // ends clients + stops source; manager stays reusable
}
export const MIRROR_BOUNDARY = 'rnmirror';
```

Resolution rules (`buildMirrorTargetResolver`):
1. `getPlatform()` null → `{ ok: false, reason: 'no active device session — run cdp_status or a device_* tool first' }`.
2. Session device id present → use it.
3. iOS: `resolveIosUdid()` undefined → `{ ok: false, reason: 'no single booted iOS simulator — boot exactly one or start a session with a deviceId' }`.
4. Android: exactly one serial → use it; zero → `no Android device connected`; several → `multiple Android devices — start a session with a deviceId` (mirrors GH #422 ambiguity refusal).

Manager behavior:
- `attach`: register client, `writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=rnmirror', 'Cache-Control': 'no-store', Connection: 'keep-alive' })`, write latest frame immediately if one exists, cancel any pending grace timer. If no pipeline running → start one (single-flight: concurrent attaches share the start).
- Pipeline start: push `{status:'starting', platform, deviceId}` after successful resolution; resolution failure → push `{status:'error', reason, hint?}` and `end()` all clients (no processes were spawned — cheap). First `onFrame` → push `{status:'streaming', platform, deviceId, pipeline, fps: source.nominalFps, hint?}` (hint = `SIMCTL_HINT` when pipeline is `'simctl'` — thread it via source `pipeline` check in manager or a `hint` field; simplest: manager imports `SIMCTL_HINT` and attaches it when `source.pipeline === 'simctl'`).
- Frame broadcast: multipart part per frame —
  `Buffer.concat([Buffer.from('--rnmirror\r\nContent-Type: image/jpeg\r\nContent-Length: ' + f.length + '\r\n\r\n'), f, Buffer.from('\r\n')])`.
  Per-client `ready` flag: `write()` returning false → `ready = false`, skip this client until its `'drain'` fires. Newest frame always wins; no queueing.
- Client `'close'` → deregister; when count hits 0 → grace timer (`graceMs`); on expiry → `source.stop()`, push `{status:'idle'}`, clear latest frame.
- `source.onExit(err)` → push `{status:'error', reason: err?.reason ?? 'capture stopped', hint: err?.hint}`, `end()` all clients, clear pipeline (next attach retries fresh).
- `shutdown()` → stop source (if any), end all clients, clear grace timer, push nothing (server is going down; SSE gets its own shutdown sentinel). Manager must remain usable afterwards (observe `restart` reuses it).
- `isStreaming()` → `status === 'streaming'` internally.

- [ ] **Step 1: Write the failing tests**

```js
// scripts/cdp-bridge/test/unit/mirror-target.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMirrorTargetResolver } from '../../dist/observability/mirror/target.js';

const base = {
  getPlatform: () => 'ios',
  getSessionDeviceId: () => undefined,
  resolveIosUdid: async () => 'UDID-1',
  listAndroidSerials: async () => ['emulator-5554'],
};

test('no platform → error mentioning session', async () => {
  const r = await buildMirrorTargetResolver({ ...base, getPlatform: () => null })();
  assert.equal(r.ok, false);
  assert.match(r.reason, /session/i);
});

test('session deviceId wins without probing', async () => {
  const r = await buildMirrorTargetResolver({
    ...base,
    getSessionDeviceId: () => 'SESSION-UDID',
    resolveIosUdid: async () => {
      throw new Error('must not probe');
    },
  })();
  assert.deepEqual(r, { ok: true, target: { platform: 'ios', deviceId: 'SESSION-UDID' } });
});

test('ios: single booted sim resolves; ambiguous → refusal', async () => {
  assert.equal((await buildMirrorTargetResolver(base)()).ok, true);
  const amb = await buildMirrorTargetResolver({ ...base, resolveIosUdid: async () => undefined })();
  assert.equal(amb.ok, false);
});

test('android: exactly one serial ok; zero and many refuse', async () => {
  const android = { ...base, getPlatform: () => 'android' };
  const one = await buildMirrorTargetResolver(android)();
  assert.deepEqual(one, { ok: true, target: { platform: 'android', deviceId: 'emulator-5554' } });
  const none = await buildMirrorTargetResolver({ ...android, listAndroidSerials: async () => [] })();
  assert.equal(none.ok, false);
  const many = await buildMirrorTargetResolver({
    ...android,
    listAndroidSerials: async () => ['a', 'b'],
  })();
  assert.equal(many.ok, false);
  assert.match(many.reason, /multiple/i);
});
```

```js
// scripts/cdp-bridge/test/unit/mirror-manager.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { MirrorManager, MIRROR_BOUNDARY } from '../../dist/observability/mirror/manager.js';

const jpeg = (fill) =>
  Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(4, fill), Buffer.from([0xff, 0xd9])]);

function fakeClient({ writeOk = true } = {}) {
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd scripts/cdp-bridge && npm run build; node --test test/unit/mirror-manager.test.js test/unit/mirror-target.test.js`
Expected: FAIL — modules not found

- [ ] **Step 3: Implement `target.ts` and `manager.ts` per the interface + behavior blocks above**

`target.ts` is ~40 lines of the four resolution rules. `manager.ts` (~150 lines) implements the manager behavior list; key internals: `clients: Set<{ c: MirrorClient; ready: boolean }>`, `state: 'idle'|'starting'|'streaming'|'error'`, `latest: Buffer | null`, `graceTimer`, single-flight `startingPromise`. Import `SIMCTL_HINT` from `./sources.js`; attach it to the streaming status when `source.pipeline === 'simctl'`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/mirror-manager.test.js test/unit/mirror-target.test.js`
Expected: PASS (11 tests)

- [ ] **Step 5: Commit**

```bash
git add scripts/cdp-bridge/src/observability/mirror scripts/cdp-bridge/test/unit/mirror-manager.test.js scripts/cdp-bridge/test/unit/mirror-target.test.js scripts/cdp-bridge/dist
git commit -m "feat(observe-mirror): MirrorManager refcounted multipart broadcast + session-bound target resolver"
```

---

### Task 5: Server route `/api/device/mirror`

**Files:**
- Modify: `scripts/cdp-bridge/src/observability/server.ts` (constructor at `:23-30`, `handle()` at `:80-96`, `stop()` at `:54-74`)
- Test: `scripts/cdp-bridge/test/unit/mirror-route.test.js`

**Interfaces:**
- Consumes: `MirrorManager` (Task 4) — only `attach(client)` and `shutdown()`.
- Produces: `ObservabilityServer` constructor gains a third optional arg `mirror?: MirrorManager`; route `GET /api/device/mirror` (query string allowed — the frontend appends a cache-busting nonce).

- [ ] **Step 1: Write the failing test**

```js
// scripts/cdp-bridge/test/unit/mirror-route.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { ObservabilityServer } from '../../dist/observability/server.js';
import { Recorder } from '../../dist/observability/recorder.js';

function get(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path }, (res) => resolve({ res, req }));
    req.on('error', reject);
  });
}

test('GET /api/device/mirror attaches to the manager and streams headers', async () => {
  const attached = [];
  const fakeMirror = {
    attach: (client) => {
      attached.push(client);
      client.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=rnmirror' });
      client.write('--rnmirror\r\n');
    },
    shutdown: () => {},
  };
  const server = new ObservabilityServer(new Recorder(), undefined, fakeMirror);
  const { port } = await server.start(0);
  const { res, req } = await get(port, '/api/device/mirror?t=123');
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /multipart\/x-mixed-replace/);
  assert.equal(attached.length, 1);
  req.destroy();
  await server.stop();
});

test('GET /api/device/mirror without a manager → 404', async () => {
  const server = new ObservabilityServer(new Recorder());
  const { port } = await server.start(0);
  const { res, req } = await get(port, '/api/device/mirror');
  assert.equal(res.statusCode, 404);
  req.destroy();
  await server.stop();
});

test('server.stop() calls mirror.shutdown()', async () => {
  let shutdowns = 0;
  const fakeMirror = { attach: () => {}, shutdown: () => shutdowns++ };
  const server = new ObservabilityServer(new Recorder(), undefined, fakeMirror);
  await server.start(0);
  await server.stop();
  assert.equal(shutdowns, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd scripts/cdp-bridge && npm run build; node --test test/unit/mirror-route.test.js`
Expected: FAIL — 404 on the mirror route / shutdown never called

- [ ] **Step 3: Implement in `server.ts`**

Constructor (add third param; import the type):

```ts
import type { MirrorManager } from './mirror/manager.js';
// ...
  constructor(
    private readonly recorder: Recorder,
    private readonly e2e?: E2eServerDeps,
    private readonly mirror?: MirrorManager,
  ) {}
```

In `handle()` (after the `live-screenshot` line, before the e2e routes):

```ts
    if (url.startsWith('/api/device/mirror')) return this.mirrorStream(res);
```

New method:

```ts
  private mirrorStream(res: ServerResponse): void {
    if (!this.mirror) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.socket?.setTimeout(0);
    this.mirror.attach(res);
  }
```

In `stop()`, before ending SSE streams:

```ts
    this.mirror?.shutdown();
```

(`ServerResponse` structurally satisfies `MirrorClient` — `writeHead`/`write`/`end`/`on('close'|'drain')`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/mirror-route.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: Run the full unit suite for regressions**

Run: `cd scripts/cdp-bridge && npm test`
Expected: PASS — all existing tests still green

- [ ] **Step 6: Commit**

```bash
git add scripts/cdp-bridge/src/observability/server.ts scripts/cdp-bridge/test/unit/mirror-route.test.js scripts/cdp-bridge/dist
git commit -m "feat(observe-mirror): GET /api/device/mirror multipart route + shutdown wiring"
```

---

### Task 6: Bridge wiring — observe.ts, index.ts, live-capture short-circuit

**Files:**
- Modify: `scripts/cdp-bridge/src/observability/live-device.ts` (add `isMirrorActive` to `LiveCaptureDeps` at `:93-105`, `runCapture` at `:138-158`, `BuildLiveDepsInput`/`buildLiveDeps` at `:160-197`)
- Modify: `scripts/cdp-bridge/src/tools/observe.ts` (add `setObserveMirror`, pass to constructor at `:47`)
- Modify: `scripts/cdp-bridge/src/index.ts` (build + register the manager next to the `liveDeps` block at `:259-289`)
- Test: `scripts/cdp-bridge/test/unit/mirror-live-shortcircuit.test.js`

**Interfaces:**
- Consumes: `MirrorManager`, `buildMirrorTargetResolver`, `createMirrorSource`, `resolveMirrorConfig`, `resolveIosUdid` (from `tools/device-screenshot-raw.js`), `parseAllAdbDevices` (from `tools/device-record.js`), `recorder.push` (exists at `recorder.ts:102`).
- Produces:
  - `LiveCaptureDeps.isMirrorActive?: () => boolean` and `BuildLiveDepsInput.isMirrorActive?: () => boolean` (threaded through `buildLiveDeps`).
  - `export function setObserveMirror(m: MirrorManager): void` in `observe.ts`.

- [ ] **Step 1: Write the failing test**

```js
// scripts/cdp-bridge/test/unit/mirror-live-shortcircuit.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  maybeCaptureLiveFrame,
  _resetLiveCaptureForTest,
} from '../../dist/observability/live-device.js';

function deps({ mirrorActive }) {
  const calls = { screenshot: 0, route: 0, pushed: [] };
  return {
    calls,
    deps: {
      hasObservers: () => true,
      isFlowActive: () => false,
      getPlatform: () => 'ios',
      captureScreenshot: async (_p, path) => {
        calls.screenshot++;
        return { ok: true, path };
      },
      readRoute: async () => {
        calls.route++;
        return '/home';
      },
      readShotFile: () => ({ buf: Buffer.from('x'), contentType: 'image/jpeg' }),
      pushLive: (f) => calls.pushed.push(f),
      tmpPath: () => '/tmp/x.jpg',
      isMirrorActive: () => mirrorActive,
    },
  };
}

test('mirror streaming → screenshot skipped, route still read and pushed', async () => {
  _resetLiveCaptureForTest();
  const { calls, deps: d } = deps({ mirrorActive: true });
  await maybeCaptureLiveFrame(d);
  assert.equal(calls.screenshot, 0, 'redundant screenshot skipped while mirroring');
  assert.equal(calls.route, 1);
  assert.deepEqual(calls.pushed, [{ route: '/home' }]);
});

test('mirror not streaming → screenshot captured as before', async () => {
  _resetLiveCaptureForTest();
  const { calls, deps: d } = deps({ mirrorActive: false });
  await maybeCaptureLiveFrame(d);
  assert.equal(calls.screenshot, 1);
  assert.equal(calls.pushed.length, 1);
  assert.ok(calls.pushed[0].shot);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd scripts/cdp-bridge && npm run build; node --test test/unit/mirror-live-shortcircuit.test.js`
Expected: FAIL — first test sees `calls.screenshot === 1`

- [ ] **Step 3: Implement the short-circuit in `live-device.ts`**

Add to `LiveCaptureDeps`:

```ts
  /** GH #206 + mirror spec: while the MJPEG mirror is streaming, the per-tool
   * screenshot is redundant — the browser already sees live pixels. */
  isMirrorActive?: () => boolean;
```

In `runCapture`, wrap the screenshot block (route block unchanged):

```ts
  if (!deps.isMirrorActive?.()) {
    try {
      const shot = await deps.captureScreenshot(platform, deps.tmpPath());
      if (shot.ok) {
        const bytes = deps.readShotFile(shot.path);
        if (bytes) frame.shot = bytes;
      }
    } catch {
      /* screenshot best-effort */
    }
  }
```

Add `isMirrorActive?: () => boolean;` to `BuildLiveDepsInput` and pass it through in `buildLiveDeps`: `isMirrorActive: input.isMirrorActive,`.

- [ ] **Step 4: Add `setObserveMirror` to `observe.ts`**

```ts
import type { MirrorManager } from '../observability/mirror/manager.js';

let mirrorManager: MirrorManager | undefined;

export function setObserveMirror(m: MirrorManager): void {
  mirrorManager = m;
}
```

And in `startObserveServer` change the construction line to:

```ts
    if (!server) server = new ObservabilityServer(recorder, e2eDeps, mirrorManager);
```

- [ ] **Step 5: Wire the real manager in `index.ts`**

Add imports (near the existing observability imports):

```ts
import { MirrorManager } from './observability/mirror/manager.js';
import { buildMirrorTargetResolver } from './observability/mirror/target.js';
import { createMirrorSource } from './observability/mirror/sources.js';
import { resolveMirrorConfig } from './project-config.js';
import { resolveIosUdid } from './tools/device-screenshot-raw.js';
import { parseAllAdbDevices } from './tools/device-record.js';
```

(`setObserveMirror` joins the existing `observe.js` import at `index.ts:121`; `execFile`/`promisify` are already imported in `index.ts` — verify, otherwise add.)

Directly below the `liveDeps` block (`index.ts:289`):

```ts
const mirrorCfg = resolveMirrorConfig();
const mirrorManager = mirrorCfg.enabled
  ? new MirrorManager({
      resolveTarget: buildMirrorTargetResolver({
        getPlatform: () => {
          const p = getActiveSession()?.platform ?? getClient().connectedTarget?.platform;
          return p === 'ios' || p === 'android' ? p : null;
        },
        getSessionDeviceId: () => getActiveSession()?.deviceId ?? undefined,
        resolveIosUdid: () => resolveIosUdid(),
        listAndroidSerials: async () => {
          try {
            const { stdout } = await execFileAsync('adb', ['devices'], {
              timeout: 5000,
              maxBuffer: 1024 * 1024,
            });
            return parseAllAdbDevices(stdout)
              .filter((d) => d.state === 'device')
              .map((d) => d.serial);
          } catch {
            return [];
          }
        },
      }),
      createSource: (t) => createMirrorSource(t, mirrorCfg.fps),
      pushStatus: (s) => recorder.push(s),
    })
  : undefined;
if (mirrorManager) setObserveMirror(mirrorManager);
```

And extend the `buildLiveDeps({...})` input with:

```ts
  isMirrorActive: () => mirrorManager?.isStreaming() ?? false,
```

Note: `mirrorManager` must be declared before the `liveDeps` block if `buildLiveDeps` references it — either move the mirror block above `liveDeps`, or (simpler, since the arrow defers evaluation) keep declaration order as-is only if `mirrorManager` is a `const` declared earlier. **Declare the mirror block above the `liveDeps` block** to avoid TDZ risk.

If `index.ts` has no `execFileAsync`, add at top: `const execFileAsync = promisify(execFile);` with `import { execFile } from 'node:child_process'; import { promisify } from 'node:util';`.

- [ ] **Step 6: Run tests + full suite**

Run: `cd scripts/cdp-bridge && npm test`
Expected: PASS — new short-circuit tests + all existing (especially `test/unit/*live*` and `observe-*` suites)

- [ ] **Step 7: Commit**

```bash
git add scripts/cdp-bridge/src scripts/cdp-bridge/test/unit/mirror-live-shortcircuit.test.js scripts/cdp-bridge/dist
git commit -m "feat(observe-mirror): wire MirrorManager into bridge + skip redundant live screenshots while streaming"
```

---

### Task 7: Frontend — DevicePane mirror rendering + SSE mirror state

**Files:**
- Modify: `scripts/cdp-bridge/src/observability/web/src/types.ts` (add `MirrorState`)
- Modify: `scripts/cdp-bridge/src/observability/web/src/hooks/useEventStream.ts`
- Modify: `scripts/cdp-bridge/src/observability/web/src/components/DevicePane.tsx`
- Modify: `scripts/cdp-bridge/src/observability/web/src/main.tsx` (pass `mirror` prop, `main.tsx:89-93`)
- Modify: `scripts/cdp-bridge/src/observability/web/src/theme.ts` (one hint style)
- Rebuild: `scripts/cdp-bridge/dist/observability/web-dist/index.html` (committed bundle)

**Interfaces:**
- Consumes: SSE `{type:'mirror', ...MirrorStatus}` events (Task 4 shape), `GET /api/device/mirror` (Task 5).
- Produces: `MirrorState` type; `useEventStream()` return gains `mirror: MirrorState | null`; `DevicePane` props gain `mirror: MirrorState | null`.

The web app has no JS test harness (validated by the CI bundle-freshness job + manual verification); steps here are implement → typecheck via vite build → manual verify in Task 8.

- [ ] **Step 1: Add the type (`types.ts`)**

```ts
export interface MirrorState {
  status: 'starting' | 'streaming' | 'error' | 'idle';
  pipeline?: string;
  fps?: number;
  hint?: string;
  reason?: string;
}
```

- [ ] **Step 2: Extend `useEventStream.ts`**

Add state + interface field + SSE branch (pattern-match the existing `live` branch at `useEventStream.ts:57-62`):

```ts
// in EventStream interface:
  mirror: MirrorState | null;

// state:
  const [mirror, setMirror] = useState<MirrorState | null>(null);

// in onmessage, after the 'live' branch:
      if (type === 'mirror') {
        const p = parsed as { status?: MirrorState['status'] } & Partial<MirrorState>;
        if (p.status) {
          setMirror({
            status: p.status,
            pipeline: p.pipeline,
            fps: p.fps,
            hint: p.hint,
            reason: p.reason,
          });
        }
        return;
      }

// in the 'shutdown' branch add:
        setMirror(null);

// return value gains `mirror`.
```

Import `MirrorState` with `import type`.

- [ ] **Step 3: Rewrite `DevicePane.tsx`**

```tsx
import { useEffect, useState, type JSX } from 'react';
import type { MirrorState } from '../types';

interface DevicePaneProps {
  mirror: MirrorState | null;
  liveShotSeq: number | null;
  /** seq of the latest device_screenshot event, used before any live frame exists. */
  fallbackSeq: number | null;
  route: string | null;
}

const MAX_MIRROR_RETRIES = 3;

export function DevicePane({ mirror, liveShotSeq, fallbackSeq, route }: DevicePaneProps): JSX.Element {
  // Nonce busts the browser's connection cache on retry; attempts cap avoids
  // hammering a dead endpoint (mirror disabled / persistent capture error).
  const [nonce, setNonce] = useState(1);
  const [attempts, setAttempts] = useState(0);

  // A fresh starting/streaming status is the server telling us the pipeline is
  // (re)alive — re-arm the <img> retry budget.
  useEffect(() => {
    if (mirror?.status === 'starting' || mirror?.status === 'streaming') {
      setAttempts(0);
      setNonce((n) => n + 1);
    }
  }, [mirror?.status]);

  const mirrorBroken = mirror?.status === 'error' || attempts >= MAX_MIRROR_RETRIES;
  const useMirror = !mirrorBroken;

  const fallbackSrc =
    liveShotSeq != null
      ? `/api/live-screenshot/${liveShotSeq}`
      : fallbackSeq != null
        ? `/api/screenshot/${fallbackSeq}`
        : null;

  const onMirrorError = (): void => {
    setAttempts((a) => a + 1);
    if (attempts + 1 < MAX_MIRROR_RETRIES) {
      setTimeout(() => setNonce((n) => n + 1), 2000);
    }
  };

  const statusLine =
    mirror?.status === 'streaming'
      ? `mirror: ${mirror.pipeline}${mirror.fps ? ` ~${mirror.fps}fps` : ''}`
      : mirror?.status === 'error'
        ? `mirror off: ${mirror.reason ?? 'error'}`
        : null;

  return (
    <div className="pane center">
      <div className="pane-head">
        Device
        {route && <span className="route-chip">{route}</span>}
      </div>
      <div className="screen">
        {useMirror ? (
          <div className="device-frame">
            <img
              src={`/api/device/mirror?t=${nonce}`}
              alt="live device mirror"
              onError={onMirrorError}
            />
          </div>
        ) : fallbackSrc ? (
          <div className="device-frame">
            <img src={fallbackSrc} alt="device screenshot" />
          </div>
        ) : (
          <div className="empty empty-guide">
            <div className="empty-title">No screenshot yet</div>
            <div>The screen appears here automatically after the agent interacts with the app.</div>
            <div>Nothing showing? Check the connection with cdp_status.</div>
          </div>
        )}
        {(statusLine || mirror?.hint) && (
          <div className="mirror-status">
            {statusLine}
            {mirror?.hint ? <span className="mirror-hint"> — {mirror.hint}</span> : null}
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Pass the prop in `main.tsx` and add styles**

`main.tsx`: destructure `mirror` from `useEventStream()` and pass `mirror={mirror}` to `<DevicePane …>`.

`theme.ts` (append near `.liveroute`):

```ts
.mirror-status { color: #565f89; font-size: 11px; margin-top: 6px; text-align: center; }
.mirror-hint { color: #e0af68; }
```

- [ ] **Step 5: Rebuild the committed bundle and verify freshness**

Run: `cd scripts/cdp-bridge && npm run build:web && cd ../.. && bash scripts/check-web-bundle.sh`
Expected: `web bundle fresh`

- [ ] **Step 6: Commit**

```bash
git add scripts/cdp-bridge/src/observability/web scripts/cdp-bridge/dist/observability/web-dist
git commit -m "feat(observe-mirror): DevicePane live mirror <img> with retry budget + SSE mirror status"
```

---

### Task 8: Integration test, changeset, docs touch-up, manual verification

**Files:**
- Create: `scripts/cdp-bridge/test/integration/observe-mirror.test.js`
- Create: `.changeset/observe-live-mirror.md`
- Modify: `commands/observe.md` (one line: mention the live mirror)

**Interfaces:**
- Consumes: everything above; no new exports.

- [ ] **Step 1: Write the integration test**

```js
// scripts/cdp-bridge/test/integration/observe-mirror.test.js
// End-to-end over real HTTP: ObservabilityServer + real MirrorManager + fake
// source. Two clients must both receive well-formed multipart JPEG parts;
// closing one must not stall the other.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { ObservabilityServer } from '../../dist/observability/server.js';
import { Recorder } from '../../dist/observability/recorder.js';
import { MirrorManager } from '../../dist/observability/mirror/manager.js';

const jpeg = (fill) =>
  Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(64, fill), Buffer.from([0xff, 0xd9])]);

test('two mirror clients stream frames over real HTTP', async () => {
  let sink = null;
  const source = {
    pipeline: 'idb',
    nominalFps: 20,
    start(s) {
      sink = s;
    },
    stop() {
      sink = null;
    },
  };
  const mirror = new MirrorManager({
    resolveTarget: async () => ({ ok: true, target: { platform: 'ios', deviceId: 'U' } }),
    createSource: async () => source,
    pushStatus: () => {},
    graceMs: 50,
  });
  const server = new ObservabilityServer(new Recorder(), undefined, mirror);
  const { port } = await server.start(0);

  const connect = () =>
    new Promise((resolve, reject) => {
      const chunks = [];
      const req = http.get({ host: '127.0.0.1', port, path: '/api/device/mirror' }, (res) => {
        assert.equal(res.statusCode, 200);
        res.on('data', (c) => chunks.push(c));
        resolve({ req, res, chunks });
      });
      req.on('error', reject);
    });

  const a = await connect();
  const b = await connect();
  // Wait for the async pipeline start to reach the fake source.
  for (let i = 0; i < 50 && !sink; i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(sink, 'source started');

  sink.onFrame(jpeg(1));
  sink.onFrame(jpeg(2));
  await new Promise((r) => setTimeout(r, 100));

  for (const { chunks } of [a, b]) {
    const body = Buffer.concat(chunks).toString('latin1');
    const parts = body.split('--rnmirror').filter((p) => p.includes('Content-Type: image/jpeg'));
    assert.ok(parts.length >= 2, `client saw ${parts.length} frames`);
  }

  a.req.destroy();
  sink.onFrame(jpeg(3));
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(
    Buffer.concat(b.chunks).includes(jpeg(3)),
    'surviving client still receives after peer disconnect',
  );

  b.req.destroy();
  await server.stop();
});
```

- [ ] **Step 2: Run it**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/integration/observe-mirror.test.js`
Expected: PASS

- [ ] **Step 3: Update `commands/observe.md` wording**

In the empty-argument bullet, change "watch the live tool-call timeline, device screenshot, and app state" to "watch the live tool-call timeline, live device mirror, and app state".

- [ ] **Step 4: Add the changeset**

```md
<!-- .changeset/observe-live-mirror.md -->
---
"rn-dev-agent-cdp": minor
"rn-dev-agent-plugin": patch
---

Observe UI: continuous live mirroring of the simulator/emulator screen (Maestro-style MJPEG). New `GET /api/device/mirror` stream — idb (20–30fps) or simctl loop (~6fps) on iOS, adb screenrecord+ffmpeg on Android emulators and physical devices. Zero capture cost with no tab open; per-tool-call screenshots are skipped while the mirror streams. Config: `observe.mirror.enabled` / `observe.mirror.fps`, env `RN_AGENT_OBSERVE_MIRROR=0` to disable.
```

- [ ] **Step 5: Full suite + lint + bundle check**

Run: `cd scripts/cdp-bridge && npm run test:all && cd ../.. && npm run lint && npm run format:check && bash scripts/check-web-bundle.sh && bash scripts/validate-changeset-names.sh`
Expected: all PASS. Fix any oxlint/oxfmt findings (`npm run lint:fix` / `npm run format`).

- [ ] **Step 6: Manual verification on real devices (this machine has a booted iPhone 16 Pro sim)**

1. `cd scripts/cdp-bridge && npm run build`, then start a session in the test RN app project so the bridge + observe server run, or run the observe tool directly.
2. Open the observe URL. Expected: DevicePane shows the simulator screen updating continuously (~6 fps simctl path on this machine — idb not installed) **without any agent tool calls**; status line reads `mirror: simctl ~6fps — install idb…`.
3. Interact with the simulator by hand (scroll, open apps) — mirror follows.
4. If idb is available (or after installing): status line shows `mirror: idb ~20fps`, motion is smooth; **verify the exact `idb video-stream` flags** (`idb video-stream --help`) and correct `sources.ts` if `--compression-quality`/`--fps` differ, updating the Task 3 arg assertions to match.
5. Android emulator booted: mirror streams at video rate; after ~3 min confirm the 179 s restart hiccup is a blip, not a hang.
6. Close all observe tabs; within ~10 s `ps aux | grep -E 'video-stream|screenrecord|ffmpeg.*mjpeg' | grep -v grep` shows no capture processes.
7. Stop the sim (`xcrun simctl shutdown all`) with a tab open: DevicePane falls back to the last screenshot + `mirror off: …` reason.

- [ ] **Step 7: Commit**

```bash
git add scripts/cdp-bridge/test/integration/observe-mirror.test.js .changeset/observe-live-mirror.md commands/observe.md scripts/cdp-bridge/dist
git commit -m "test(observe-mirror): e2e multipart stream test + changeset + observe command doc"
```

---

## Plan Self-Review (completed)

- **Spec coverage:** frame parser → T1; config → T2; three sources + restart/backoff + hints → T3; refcount/grace/broadcast/backpressure/status/target-ambiguity → T4; route + guard (inherited: `guard()` runs before all routes in `handle()`) + shutdown → T5; GH #206 short-circuit + session-bound resolution wiring → T6; DevicePane `<img>`/fallback/hint/retry → T7; integration + manual (incl. idle teardown, idb flag verification) → T8. Physical-iOS/input/Windows are out of scope per spec — no tasks, correct.
- **Placeholder scan:** the only deferred detail is idb's exact flag names, resolved by an explicit manual-verification step (T8.6) with instructions to update T3 assertions — acceptable per spec ("confirmed at implementation time").
- **Type consistency:** `MirrorClient` structural match with `ServerResponse` (T4↔T5); `MirrorStatus` field names match the frontend `MirrorState` and SSE branch (T4↔T7); `isMirrorActive` name identical in `LiveCaptureDeps`, `BuildLiveDepsInput`, and index.ts wiring (T6); `SIMCTL_HINT` exported (T3) and imported by manager (T4).
