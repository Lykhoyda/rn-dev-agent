# Live device panels for `/observe` (GH #206) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/observe`'s device screenshot + route refresh after every state-mutating agent action, instead of only when `device_screenshot` / `cdp_navigation_state` happen to be called.

**Architecture:** A fire-and-forget hook in `index.ts`'s `trackedTool` runs after each state-mutating tool resolves; it captures a screenshot (`tryRawScreenshot`, simctl/adb) + route (`readLiveRoute`, CDP) and feeds a dedicated live slot in the recorder, which pushes a `{type:'live'}` SSE event. The web UI prefers the live channel; the timeline is untouched. Gated on connected observers, skipped during Maestro flows, opt-out via `RN_OBSERVE_LIVE=0`.

**Tech Stack:** TypeScript (Node ≥22, ESM), `node:test`, React SPA (Vite single-file bundle), CDP, simctl/adb.

**Spec:** `docs/superpowers/specs/2026-06-14-206-observe-live-device-panels-design.md`

---

## File structure

| File | Responsibility | Change |
|---|---|---|
| `src/observability/recorder.ts` | event sink + screenshot cache | **modify** — add `pushLive`, `getLiveScreenshot`, `hasSubscribers`, live slots, clear() reset |
| `src/observability/live-device.ts` | live-capture orchestration + predicate | **create** — `isStateMutating`, `maybeCaptureLiveFrame`, single-flight |
| `src/observability/server.ts` | HTTP/SSE server | **modify** — add `GET /api/live-screenshot/<seq>` |
| `src/observability/web/src/main.tsx` | SPA | **modify** — handle `{type:'live'}`, prefer live channel |
| `src/index.ts` | tool registration | **modify** — wire live-capture into `trackedTool` |
| `dist/observability/web-dist/index.html` | built SPA bundle | **rebuild** |
| `test/unit/gh-206-*.test.js` | tests | **create** |

Reused as-is (no change): `tools/device-screenshot-raw.ts` (`tryRawScreenshot`), `tools/navigation-state.ts` (`readLiveRoute`), `agent-device-wrapper.ts` (`getActiveSession`), `lifecycle/device-arbiter.ts` (`arbiter.flowActive`), `lifecycle/foreign-flow-gate.ts` (`foreignFlowGate.lastActive`), `observability/events.ts` (`classifyFamily`).

---

## Task 1: Recorder live slots (`pushLive` / `getLiveScreenshot` / `hasSubscribers`)

**Files:**
- Modify: `src/observability/recorder.ts`
- Test: `test/unit/gh-206-recorder-pushlive.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/unit/gh-206-recorder-pushlive.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Recorder } from '../../dist/observability/recorder.js';

test('pushLive stores latest frame + route and emits a {type:live} event, not a timeline event', () => {
  const rec = new Recorder();
  const got = [];
  rec.attach((ev) => got.push(ev));
  const buf = Buffer.from([0xff, 0xd8, 0xff]);

  rec.pushLive({ shot: { buf, contentType: 'image/jpeg' }, route: 'Home' });

  assert.equal(got.length, 1, 'one subscriber event');
  assert.equal(got[0].type, 'live');
  assert.equal(got[0].route, 'Home');
  assert.equal(typeof got[0].shotSeq, 'number');
  assert.equal(rec.snapshot().length, 0, 'live frames must NOT enter the timeline ring buffer');
  const live = rec.getLiveScreenshot();
  assert.deepEqual(live.buf, buf);
  assert.equal(live.contentType, 'image/jpeg');
});

test('pushLive increments shotSeq only when a shot is included; route-only push omits shotSeq', () => {
  const rec = new Recorder();
  const got = [];
  rec.attach((ev) => got.push(ev));
  rec.pushLive({ shot: { buf: Buffer.from([1]), contentType: 'image/jpeg' } });
  rec.pushLive({ route: 'Settings' });
  assert.equal(got[0].shotSeq, 1);
  assert.equal(got[1].shotSeq, undefined, 'route-only push has no new shot');
  assert.equal(got[1].route, 'Settings');
});

test('pushLive with neither shot nor route is a no-op (no event)', () => {
  const rec = new Recorder();
  const got = [];
  rec.attach((ev) => got.push(ev));
  rec.pushLive({});
  assert.equal(got.length, 0);
});

test('hasSubscribers reflects attach/detach', () => {
  const rec = new Recorder();
  assert.equal(rec.hasSubscribers(), false);
  const { detach } = rec.attach(() => {});
  assert.equal(rec.hasSubscribers(), true);
  detach();
  assert.equal(rec.hasSubscribers(), false);
});

test('clear() resets the live slot', () => {
  const rec = new Recorder();
  rec.attach(() => {});
  rec.pushLive({ shot: { buf: Buffer.from([1]), contentType: 'image/jpeg' } });
  rec.clear();
  assert.equal(rec.getLiveScreenshot(), undefined);
});

test('pushLive drops an oversized shot but still pushes the route', () => {
  const rec = new Recorder();
  const got = [];
  rec.attach((ev) => got.push(ev));
  const huge = Buffer.alloc(4_000_001); // > MAX_SHOT_BYTES
  rec.pushLive({ shot: { buf: huge, contentType: 'image/jpeg' }, route: 'Big' });
  assert.equal(rec.getLiveScreenshot(), undefined, 'oversized shot not stored');
  assert.equal(got.length, 1);
  assert.equal(got[0].shotSeq, undefined, 'no shotSeq when shot dropped');
  assert.equal(got[0].route, 'Big', 'route still delivered');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/unit/gh-206-recorder-pushlive.test.js`
Expected: FAIL — `rec.pushLive is not a function`.

- [ ] **Step 3: Implement in `recorder.ts`**

Add fields after `private readonly shotCap: number;`:

```ts
  private liveShotData: ScreenshotBytes | undefined;
  private liveSeqVal = 0;
```

Add methods (next to `getScreenshot`):

```ts
  hasSubscribers(): boolean { return this.subs.size > 0; }
  getLiveScreenshot(): ScreenshotBytes | undefined { return this.liveShotData; }
  pushLive(frame: { shot?: ScreenshotBytes; route?: string }): void {
    const ev: Record<string, unknown> = { type: 'live' };
    let changed = false;
    if (frame.shot && frame.shot.buf.length <= MAX_SHOT_BYTES) {
      this.liveShotData = frame.shot;
      ev.shotSeq = ++this.liveSeqVal;
      changed = true;
    }
    if (typeof frame.route === 'string' && frame.route.length > 0) {
      ev.route = frame.route;
      changed = true;
    }
    if (!changed) return;
    for (const fn of this.subs) {
      try { fn(ev as unknown as AgentEvent); } catch { /* per-subscriber swallow */ }
    }
  }
```

In `clear()`, after `this.shots.clear();` add:

```ts
    this.liveShotData = undefined;
    this.liveSeqVal = 0;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test test/unit/gh-206-recorder-pushlive.test.js`
Expected: PASS (6/6).

- [ ] **Step 5: Commit**

```bash
git add src/observability/recorder.ts test/unit/gh-206-recorder-pushlive.test.js dist/observability/recorder.js
git commit -m "feat(#206): recorder live slot — pushLive/getLiveScreenshot/hasSubscribers"
```

---

## Task 2: `isStateMutating` predicate (pinned to events.ts)

**Files:**
- Create: `src/observability/live-device.ts`
- Test: `test/unit/gh-206-state-mutating-predicate.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/unit/gh-206-state-mutating-predicate.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isStateMutating } from '../../dist/observability/live-device.js';

test('every INTERACTION-family tool + cdp_navigate is state-mutating', () => {
  const mutating = [
    'cdp_interact', 'device_press', 'device_fill', 'device_swipe', 'device_scroll',
    'device_longpress', 'device_pinch', 'device_back', 'device_batch',
    'device_scrollintoview', 'device_focus_next', 'device_pick_date',
    'device_pick_value', 'device_deeplink', 'cdp_navigate',
  ];
  for (const t of mutating) assert.equal(isStateMutating(t), true, `${t} should be mutating`);
});

test('read-only nav tools and introspection/lifecycle/testing are NOT state-mutating', () => {
  const readonly = [
    'cdp_navigation_state', 'cdp_nav_graph', 'cdp_component_tree', 'cdp_store_state',
    'device_screenshot', 'device_snapshot', 'cdp_status', 'maestro_run', 'observe',
  ];
  for (const t of readonly) assert.equal(isStateMutating(t), false, `${t} should NOT be mutating`);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/unit/gh-206-state-mutating-predicate.test.js`
Expected: FAIL — cannot find module `live-device.js` / `isStateMutating` undefined.

- [ ] **Step 3: Implement (start `live-device.ts`)**

```ts
// src/observability/live-device.ts
import { classifyFamily } from './events.js';

/**
 * GH #206: which tools change on-screen state and so should trigger a live
 * /observe refresh. Single source of truth, derived from events.ts families —
 * all INTERACTION-family tools plus cdp_navigate. Read-only NAVIGATION tools
 * (cdp_navigation_state, cdp_nav_graph) are excluded: reads change nothing.
 */
export function isStateMutating(tool: string): boolean {
  return classifyFamily(tool) === 'interaction' || tool === 'cdp_navigate';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test test/unit/gh-206-state-mutating-predicate.test.js`
Expected: PASS (2/2).

- [ ] **Step 5: Commit**

```bash
git add src/observability/live-device.ts test/unit/gh-206-state-mutating-predicate.test.js dist/observability/live-device.js
git commit -m "feat(#206): isStateMutating predicate pinned to events.ts families"
```

---

## Task 3: `maybeCaptureLiveFrame` (single-flight trailing-coalesce + skip conditions)

**Files:**
- Modify: `src/observability/live-device.ts`
- Test: `test/unit/gh-206-live-capture.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/unit/gh-206-live-capture.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maybeCaptureLiveFrame, _resetLiveCaptureForTest } from '../../dist/observability/live-device.js';

function baseDeps(over = {}) {
  const pushed = [];
  const deps = {
    hasObservers: () => true,
    isFlowActive: () => false,
    getSession: () => ({ platform: 'ios', udid: 'UDID' }),
    captureScreenshot: async (_p, path) => ({ ok: true, path }),
    readRoute: async () => 'Home',
    readShotFile: () => ({ buf: Buffer.from([1]), contentType: 'image/jpeg' }),
    pushLive: (f) => pushed.push(f),
    tmpPath: () => '/tmp/x.jpg',
    ...over,
  };
  return { deps, pushed };
}

test('captures shot + route and pushes once', async () => {
  _resetLiveCaptureForTest();
  const { deps, pushed } = baseDeps();
  await maybeCaptureLiveFrame(deps);
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0].route, 'Home');
  assert.ok(pushed[0].shot);
});

test('skips when no observers', async () => {
  _resetLiveCaptureForTest();
  const { deps, pushed } = baseDeps({ hasObservers: () => false });
  await maybeCaptureLiveFrame(deps);
  assert.equal(pushed.length, 0);
});

test('skips when a flow is active', async () => {
  _resetLiveCaptureForTest();
  const { deps, pushed } = baseDeps({ isFlowActive: () => true });
  await maybeCaptureLiveFrame(deps);
  assert.equal(pushed.length, 0);
});

test('skips when no device session', async () => {
  _resetLiveCaptureForTest();
  const { deps, pushed } = baseDeps({ getSession: () => null });
  await maybeCaptureLiveFrame(deps);
  assert.equal(pushed.length, 0);
});

test('route read failure (CDP down) still pushes the shot', async () => {
  _resetLiveCaptureForTest();
  const { deps, pushed } = baseDeps({ readRoute: async () => null });
  await maybeCaptureLiveFrame(deps);
  assert.equal(pushed.length, 1);
  assert.ok(pushed[0].shot);
  assert.equal(pushed[0].route, undefined);
});

test('screenshot failure still pushes the route', async () => {
  _resetLiveCaptureForTest();
  const { deps, pushed } = baseDeps({ captureScreenshot: async () => ({ ok: false }) });
  await maybeCaptureLiveFrame(deps);
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0].shot, undefined);
  assert.equal(pushed[0].route, 'Home');
});

test('errors in deps never throw out of maybeCaptureLiveFrame', async () => {
  _resetLiveCaptureForTest();
  const { deps } = baseDeps({ captureScreenshot: async () => { throw new Error('boom'); }, readRoute: async () => { throw new Error('boom2'); } });
  await maybeCaptureLiveFrame(deps); // must resolve, not reject
});

test('single-flight trailing-coalesce: one trailing capture after an in-flight burst', async () => {
  _resetLiveCaptureForTest();
  let calls = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const { deps, pushed } = baseDeps({
    captureScreenshot: async (_p, path) => { calls++; await gate; return { ok: true, path }; },
  });
  const first = maybeCaptureLiveFrame(deps); // starts, blocks on gate
  await maybeCaptureLiveFrame(deps);         // in-flight → sets pending, returns
  await maybeCaptureLiveFrame(deps);         // in-flight → pending already set, returns
  assert.equal(calls, 1, 'only the first capture has started');
  release();
  await first;
  // allow the trailing capture's microtasks to run
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls, 2, 'exactly one trailing capture ran (not zero, not three)');
  assert.equal(pushed.length, 2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/unit/gh-206-live-capture.test.js`
Expected: FAIL — `maybeCaptureLiveFrame` undefined.

- [ ] **Step 3: Implement (append to `live-device.ts`)**

```ts
export interface LiveCaptureDeps {
  hasObservers: () => boolean;
  isFlowActive: () => boolean;
  getSession: () => { platform: 'ios' | 'android'; udid: string } | null;
  captureScreenshot: (platform: 'ios' | 'android', path: string) => Promise<{ ok: true; path: string } | { ok: false }>;
  readRoute: () => Promise<string | null>;
  readShotFile: (path: string) => { buf: Buffer; contentType: string } | null;
  pushLive: (frame: { shot?: { buf: Buffer; contentType: string }; route?: string }) => void;
  tmpPath: () => string;
}

let inFlight = false;
let pending = false;

/** Test-only: reset the single-flight latches between cases. */
export function _resetLiveCaptureForTest(): void { inFlight = false; pending = false; }

export async function maybeCaptureLiveFrame(deps: LiveCaptureDeps): Promise<void> {
  try {
    if (!deps.hasObservers() || deps.isFlowActive()) return;
    if (inFlight) { pending = true; return; }
    inFlight = true;
  } catch { return; }
  try {
    await runCapture(deps);
  } finally {
    inFlight = false;
    if (pending) { pending = false; void maybeCaptureLiveFrame(deps); }
  }
}

async function runCapture(deps: LiveCaptureDeps): Promise<void> {
  const session = deps.getSession();
  if (!session) return;
  const frame: { shot?: { buf: Buffer; contentType: string }; route?: string } = {};
  try {
    const shot = await deps.captureScreenshot(session.platform, deps.tmpPath());
    if (shot.ok) {
      const bytes = deps.readShotFile(shot.path);
      if (bytes) frame.shot = bytes;
    }
  } catch { /* screenshot best-effort */ }
  try {
    const route = await deps.readRoute();
    if (route) frame.route = route;
  } catch { /* route best-effort */ }
  if (frame.shot || frame.route) deps.pushLive(frame);
}
```

Note: the `getSession()===null` skip lives in `runCapture`, AFTER the single-flight latch is taken — so the "skips when no device session" test (which calls once) sees zero pushes and the latch is released in `finally`. Verified by the test.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test test/unit/gh-206-live-capture.test.js`
Expected: PASS (8/8).

- [ ] **Step 5: Commit**

```bash
git add src/observability/live-device.ts test/unit/gh-206-live-capture.test.js dist/observability/live-device.js
git commit -m "feat(#206): maybeCaptureLiveFrame — single-flight trailing-coalesce + skip guards"
```

---

## Task 4: Server `GET /api/live-screenshot/<seq>`

**Files:**
- Modify: `src/observability/server.ts`
- Test: `test/unit/gh-206-live-screenshot-endpoint.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/unit/gh-206-live-screenshot-endpoint.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Recorder } from '../../dist/observability/recorder.js';
import { ObservabilityServer } from '../../dist/observability/server.js';

async function get(port, path) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { host: `127.0.0.1:${port}` } });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, ctype: res.headers.get('content-type'), buf };
}

test('GET /api/live-screenshot/<seq> serves current live frame; 404 when none', async () => {
  const rec = new Recorder();
  const srv = new ObservabilityServer(rec);
  const { port } = await srv.start(0);
  try {
    const miss = await get(port, '/api/live-screenshot/1');
    assert.equal(miss.status, 404, '404 before any live frame');

    rec.attach(() => {});
    rec.pushLive({ shot: { buf: Buffer.from([0xff, 0xd8, 0xff]), contentType: 'image/jpeg' } });

    // any seq in the path serves the current frame (seq is cache-bust only)
    const a = await get(port, '/api/live-screenshot/1');
    assert.equal(a.status, 200);
    assert.equal(a.ctype, 'image/jpeg');
    assert.deepEqual(a.buf, Buffer.from([0xff, 0xd8, 0xff]));
    const b = await get(port, '/api/live-screenshot/999');
    assert.equal(b.status, 200, 'stale seq still serves current frame');
  } finally {
    await srv.stop();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/unit/gh-206-live-screenshot-endpoint.test.js`
Expected: FAIL — second request returns 404 (route not handled yet).

- [ ] **Step 3: Implement in `server.ts`**

In `handle()`, after the existing `shot` block:

```ts
    if (/^\/api\/live-screenshot\/\d+$/.test(url)) return this.liveScreenshot(res);
```

Add method next to `screenshot()`:

```ts
  private liveScreenshot(res: ServerResponse): void {
    // The <seq> in the path is a cache-busting key only — always serve the
    // current live frame; 404 only when none has been captured this session.
    const shot = this.recorder.getLiveScreenshot();
    if (!shot) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': shot.contentType, 'Cache-Control': 'no-store' });
    res.end(shot.buf);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test test/unit/gh-206-live-screenshot-endpoint.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/observability/server.ts test/unit/gh-206-live-screenshot-endpoint.test.js dist/observability/server.js
git commit -m "feat(#206): /api/live-screenshot endpoint serves the current live frame"
```

---

## Task 5: Wire live capture into `trackedTool` (`index.ts`)

**Files:**
- Modify: `src/index.ts`
- Test: `test/unit/gh-206-live-deps-wiring.test.js` (pure helper extracted for testability)

Extract the deps-builder so it can be unit-tested without the MCP server.

- [ ] **Step 1: Write the failing test**

```js
// test/unit/gh-206-live-deps-wiring.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLiveDeps } from '../../dist/observability/live-device.js';

test('buildLiveDeps.getSession returns null for non-ios/android or missing udid', () => {
  const deps = buildLiveDeps({
    recorder: { hasSubscribers: () => true, pushLive: () => {} },
    isFlowActive: () => false,
    getActiveSession: () => ({ platform: 'web', deviceId: 'x' }),
    getClient: () => ({ isConnected: true }),
    captureScreenshot: async () => ({ ok: false }),
    readRoute: async () => null,
    readShotFile: () => null,
  });
  assert.equal(deps.getSession(), null);

  const deps2 = buildLiveDeps({
    recorder: { hasSubscribers: () => true, pushLive: () => {} },
    isFlowActive: () => false,
    getActiveSession: () => ({ platform: 'ios', deviceId: '' }),
    getClient: () => ({ isConnected: true }),
    captureScreenshot: async () => ({ ok: false }),
    readRoute: async () => null,
    readShotFile: () => null,
  });
  assert.equal(deps2.getSession(), null);
});

test('buildLiveDeps.getSession maps a valid ios session', () => {
  const deps = buildLiveDeps({
    recorder: { hasSubscribers: () => true, pushLive: () => {} },
    isFlowActive: () => false,
    getActiveSession: () => ({ platform: 'ios', deviceId: 'UDID-1' }),
    getClient: () => ({ isConnected: true }),
    captureScreenshot: async () => ({ ok: false }),
    readRoute: async () => null,
    readShotFile: () => null,
  });
  assert.deepEqual(deps.getSession(), { platform: 'ios', udid: 'UDID-1' });
});

test('buildLiveDeps.readRoute returns null when CDP disconnected (no eval attempted)', async () => {
  let called = false;
  const deps = buildLiveDeps({
    recorder: { hasSubscribers: () => true, pushLive: () => {} },
    isFlowActive: () => false,
    getActiveSession: () => null,
    getClient: () => ({ isConnected: false }),
    captureScreenshot: async () => ({ ok: false }),
    readRoute: async () => { called = true; return 'X'; },
    readShotFile: () => null,
  });
  assert.equal(await deps.readRoute(), null);
  assert.equal(called, false, 'must not call the route reader when disconnected');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/unit/gh-206-live-deps-wiring.test.js`
Expected: FAIL — `buildLiveDeps` undefined.

- [ ] **Step 3: Implement `buildLiveDeps` in `live-device.ts`**

```ts
import { join } from 'node:path';
import { tmpdir } from 'node:os';

interface BuildLiveDepsInput {
  recorder: { hasSubscribers: () => boolean; pushLive: LiveCaptureDeps['pushLive'] };
  isFlowActive: () => boolean;
  getActiveSession: () => { platform?: string; deviceId?: string } | null;
  getClient: () => { isConnected: boolean };
  captureScreenshot: LiveCaptureDeps['captureScreenshot'];
  readRoute: (client: unknown) => Promise<string | null>;
  readShotFile: LiveCaptureDeps['readShotFile'];
}

export function buildLiveDeps(input: BuildLiveDepsInput): LiveCaptureDeps {
  return {
    hasObservers: () => input.recorder.hasSubscribers(),
    isFlowActive: () => input.isFlowActive(),
    getSession: () => {
      const s = input.getActiveSession();
      if (!s || (s.platform !== 'ios' && s.platform !== 'android') || !s.deviceId) return null;
      return { platform: s.platform, udid: s.deviceId };
    },
    captureScreenshot: input.captureScreenshot,
    readRoute: async () => {
      const c = input.getClient();
      if (!c.isConnected) return null;
      return input.readRoute(c);
    },
    readShotFile: input.readShotFile,
    pushLive: input.recorder.pushLive,
    tmpPath: () => join(tmpdir(), `rn-observe-live-${process.pid}.jpg`),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test test/unit/gh-206-live-deps-wiring.test.js`
Expected: PASS (3/3).

- [ ] **Step 5: Wire into `index.ts` `trackedTool`**

Add imports near the other observability imports:

```ts
import { maybeCaptureLiveFrame, isStateMutating, buildLiveDeps } from './observability/live-device.js';
import { tryRawScreenshot } from './tools/device-screenshot-raw.js';
import { arbiter } from './lifecycle/device-arbiter.js';
import { foreignFlowGate } from './lifecycle/foreign-flow-gate.js';
import { readFileSync } from 'node:fs';
```

(`readLiveRoute` and `getActiveSession` are already imported.)

Add a module-scoped deps singleton + readShotFile helper after `setToolObserver(...)`:

```ts
const liveEnabled = process.env.RN_OBSERVE_LIVE !== '0';
const liveDeps = buildLiveDeps({
  recorder,
  isFlowActive: () => arbiter.flowActive || foreignFlowGate.lastActive,
  getActiveSession,
  getClient: () => getClient(),
  captureScreenshot: (platform, path) => tryRawScreenshot(platform, path),
  readRoute: (c) => readLiveRoute(c as Parameters<typeof readLiveRoute>[0]),
  readShotFile: (path) => {
    try {
      const buf = readFileSync(path);
      return { buf, contentType: path.endsWith('.png') ? 'image/png' : 'image/jpeg' };
    } catch { return null; }
  },
});
```

Replace `trackedTool` body:

```ts
function trackedTool(name: string, desc: string, schema: any, handler: any): void {
  const base = instrumentTool(name, arbiterWrap(
    name,
    handler as (...args: unknown[]) => Promise<import('./utils.js').ToolResult>,
  ) as (...args: unknown[]) => Promise<unknown>);
  const wrapped = (liveEnabled && isStateMutating(name))
    ? async (...a: unknown[]): Promise<unknown> => {
        const result = await base(...a);
        void maybeCaptureLiveFrame(liveDeps); // fire-and-forget; never blocks/throws
        return result;
      }
    : base;
  server.tool(name, desc, schema, wrapped as typeof handler);
}
```

- [ ] **Step 6: Build + full suite**

Run: `npm run build && npm test 2>&1 | grep -E "ℹ (tests|pass|fail) "`
Expected: all pass, count = prior + new tests.

- [ ] **Step 7: Commit**

```bash
git add src/observability/live-device.ts src/index.ts test/unit/gh-206-live-deps-wiring.test.js dist/observability/live-device.js dist/index.js
git commit -m "feat(#206): wire live capture into trackedTool (observer-gated, flow-aware, opt-out)"
```

---

## Task 6: Web UI live channel + bundle rebuild

**Files:**
- Modify: `src/observability/web/src/main.tsx`
- Rebuild: `dist/observability/web-dist/index.html`

- [ ] **Step 1: Add live state + SSE handling in `main.tsx`**

Add state inside `App()` next to the other `useState`s:

```ts
  const [liveShotSeq, setLiveShotSeq] = useState<number | null>(null);
  const [liveRoute, setLiveRoute] = useState<string | null>(null);
```

In `es.onmessage`, add a branch BEFORE the `if (type === 'snapshot')` block:

```ts
      if (type === 'live') {
        const p = parsed as { shotSeq?: number; route?: string };
        if (typeof p.shotSeq === 'number') setLiveShotSeq(p.shotSeq);
        if (typeof p.route === 'string') setLiveRoute(p.route);
        return;
      }
```

Replace the device `<img>` block:

```tsx
            {liveShotSeq != null ? (
              <img src={`/api/live-screenshot/${liveShotSeq}`} alt="live device screenshot" />
            ) : shotEv ? (
              <img src={`/api/screenshot/${shotEv.seq}`} alt={`screenshot seq ${shotEv.seq}`} />
            ) : (
              <div className="empty">no screenshot yet</div>
            )}
```

Change the statusbar route to prefer the live route — replace `<span className="sep">route {route ?? '—'}</span>` with:

```tsx
        <span className="sep">route {liveRoute ?? route ?? '—'}</span>
```

- [ ] **Step 2: Rebuild the bundle**

Run: `npm run build:web`
Expected: `dist/observability/web-dist/index.html` rebuilt (the `target: 'esnext'` config from the esbuild fix stays).

- [ ] **Step 3: Verify the freshness gate passes**

Run: `bash ../../scripts/check-web-bundle.sh` (from repo root: `bash scripts/check-web-bundle.sh`)
Expected: `web bundle fresh`.

- [ ] **Step 4: Commit**

```bash
git add src/observability/web/src/main.tsx dist/observability/web-dist/index.html
git commit -m "feat(#206): /observe web UI prefers the live screenshot + route channel"
```

---

## Task 7: Changeset, full verification, live device gate, finish

**Files:**
- Create: `.changeset/gh-206-observe-live-panels.md`

- [ ] **Step 1: Add changeset**

```markdown
---
"rn-dev-agent-cdp": patch
"rn-dev-agent-plugin": patch
---

`/observe` device panels now refresh live (GH #206).

The observability layer was a passive recorder of tool observations — the screenshot only updated on `device_screenshot` calls and the route only on navigation-family tools, so driving the app with `cdp_interact`/`cdp_navigate` left both panels stale. A fire-and-forget hook now captures a fresh screenshot (simctl/adb) + route (CDP nav-state) after each state-mutating tool and delivers them via a dedicated live SSE channel (no timeline pollution). Gated on a connected `/observe` tab, skipped during Maestro flows, opt-out with `RN_OBSERVE_LIVE=0`.
```

- [ ] **Step 2: Full unit suite**

Run: `npm test 2>&1 | grep -E "ℹ (tests|pass|fail) "`
Expected: 0 fail; count = baseline + ~19 new.

- [ ] **Step 3: Live device gate** (booted simulator + Metro + app attached)

Run this harness against the local dist (adapt UDID/app from `cdp_status`):

```bash
node --input-type=module -e "
const D='/Users/anton_personal/GitHub/claude-react-native-dev-plugin/scripts/cdp-bridge/dist';
const { recorder } = await import(D+'/observability/recorder.js');
const { ObservabilityServer } = await import(D+'/observability/server.js');
const { buildLiveDeps, maybeCaptureLiveFrame } = await import(D+'/observability/live-device.js');
const { tryRawScreenshot } = await import(D+'/tools/device-screenshot-raw.js');
const srv = new ObservabilityServer(recorder); const { port } = await srv.start(0);
recorder.attach(()=>{}); // simulate a connected observer
const deps = buildLiveDeps({ recorder, isFlowActive:()=>false,
  getActiveSession:()=>({platform:'ios',deviceId:process.env.UDID}),
  getClient:()=>({isConnected:false}),
  captureScreenshot:(p,path)=>tryRawScreenshot(p,path),
  readRoute:async()=>null,
  readShotFile:(path)=>{const fs=require('node:fs');try{return {buf:fs.readFileSync(path),contentType:'image/jpeg'};}catch{return null;}} });
await maybeCaptureLiveFrame(deps);
const ok = !!recorder.getLiveScreenshot();
console.log(ok ? 'PASS: live frame captured + served at /api/live-screenshot' : 'FAIL: no live frame');
await srv.stop(); process.exit(ok?0:1);
"
```
Expected: `PASS: live frame captured`. (Full UX check: run `/observe`, open the URL, drive the app via `cdp_interact`/`cdp_navigate`, confirm the screenshot + route refresh within one action and the route matches `cdp_navigation_state`.)

- [ ] **Step 4: Commit changeset**

```bash
git add .changeset/gh-206-observe-live-panels.md
git commit -m "chore(#206): changeset for /observe live device panels"
```

- [ ] **Step 5: Finish the branch**

Use `superpowers:finishing-a-development-branch` → push `feat/206-observe-live-panels`, open PR `Closes #206`, multi-LLM review (Codex + Antigravity), address findings, merge on green.

---

## Self-review

**Spec coverage:** trigger predicate (T2) ✓; screenshot+route capture (T3) ✓; separate live channel / no timeline pollution (T1 pushLive + T4 endpoint + T6 web) ✓; single-flight trailing-coalesce (T3) ✓; flow-aware + observer-gated + opt-out (T3 guards + T5 wiring) ✓; web-UI change + bundle rebuild + freshness gate (T6) ✓; tests incl. predicate-vs-events, single-flight, skip conditions, endpoint, live gate ✓.

**Placeholders:** none — every code/test step is concrete.

**Type consistency:** `LiveCaptureDeps` (T3) is the contract `buildLiveDeps` (T5) returns; `pushLive({shot?,route?})` shape consistent across recorder (T1), deps (T3/T5), web `{shotSeq?,route?}` event (T1 emit ↔ T6 consume); `getLiveScreenshot()` used by server (T4) matches recorder (T1); `isStateMutating`/`maybeCaptureLiveFrame`/`buildLiveDeps`/`_resetLiveCaptureForTest` names consistent across tasks.
