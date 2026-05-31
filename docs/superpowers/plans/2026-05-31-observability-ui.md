# Observability UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a v1 read-only "watch the agent live" web viewer, served in-process by the cdp-bridge MCP server.

**Architecture:** An in-process **sidecar** in `scripts/cdp-bridge/src/observability/`: an always-on in-memory **recorder** (a `RingBuffer<AgentEvent>` fed by an observer hooked into the existing `trackedTool`/`instrumentTool` dispatch, once per logical call after ghost-recovery resolves) + an **opt-in SSE server** (`node:http`, `127.0.0.1`, dynamic port, Host-header + Sec-Fetch-Site guards, read-only) that serves a **single-file React/Vite SPA** (three-pane "Layout A": timeline | device screenshot | state tabs). Deep-redact args+payload at the choke point (fail-closed, reusing `experience/redact.ts`); clip large payloads first; capture screenshot bytes at record time.

**Tech Stack:** Node ≥22, TypeScript (`tsc`), `node:http`, `node:test` (repo test runner), React 19 + Vite 6 + `vite-plugin-singlefile` (new, for `web/` only), changesets.

**Spec:** `docs/superpowers/specs/2026-05-31-observability-ui-design.md` (see §13 for the Codex+Gemini review findings folded into the tasks below).

---

## File structure (decomposition)

| File | Responsibility | New/Modify |
|---|---|---|
| `scripts/cdp-bridge/src/observability/events.ts` | `AgentEvent` type, `classifyFamily`, `summarize`, `clipThenRedact` (wraps `experience/redact.ts`), `mapObservation` | New |
| `scripts/cdp-bridge/src/observability/recorder.ts` | `Recorder` (RingBuffer + seq + subscribers + screenshot-byte capture); singleton `recorder` | New |
| `scripts/cdp-bridge/src/observability/server.ts` | `ObservabilityServer` — `node:http`, SSE, security guards, screenshot route, lifecycle | New |
| `scripts/cdp-bridge/src/observability/web/` | React/Vite SPA source (Layout A) | New |
| `scripts/cdp-bridge/src/observability/web-dist/index.html` | committed single-file SPA bundle the server serves | New (generated) |
| `scripts/cdp-bridge/src/experience/telemetry.ts` | add `setToolObserver` + `notifyObserver` at the 3 logToolCall sites | Modify |
| `scripts/cdp-bridge/src/index.ts` | register the recorder as observer; register the `observe` tool | Modify |
| `commands/observe.md` | `/rn-dev-agent:observe` slash command | New |
| `scripts/check-web-bundle.sh` + `.github/workflows/ci.yml` | CI freshness guard for the committed SPA bundle | New / Modify |
| `scripts/cdp-bridge/test/unit/observability-*.test.js` | unit tests | New |
| `.changeset/observability-ui.md` | changeset (required for src changes) | New |

**Conventions (verified):** tests are `node --test` against the **compiled `dist/`** (e.g. `import { Recorder } from '../../dist/observability/recorder.js'`), run via `npm test` (which does `npm run build` first). Tool registration is `trackedTool(name, desc, schema, handler)` (index.ts:129) → `instrumentTool` → `server.tool`. The deep redactor is `redact(data: Record<string, unknown>)`.

---

## Phase 0 — Scaffolding + changeset

### Task 0.1: Create the changeset

**Files:** Create `.changeset/observability-ui.md`

- [ ] **Step 1: Write the changeset** (so the `require-changeset` CI guard passes for the src changes)

```markdown
---
"rn-dev-agent-cdp": minor
"rn-dev-agent-plugin": minor
---

Add the read-only observability UI (D1226 "watch the agent live"): an in-process recorder + opt-in SSE server serving a React SPA (timeline | device | state). New `observe` MCP tool + `/rn-dev-agent:observe` slash command. Deep-redacted (args+payload, fail-closed), localhost-only with Host-header + Sec-Fetch-Site guards.
```

- [ ] **Step 2: Commit**

```bash
git add .changeset/observability-ui.md
git commit -m "chore(changeset): observability UI"
```

---

## Phase 1 — `events.ts` (pure: types, classify, summarize, redact)

### Task 1.1: AgentEvent type + classifyFamily

**Files:**
- Create: `scripts/cdp-bridge/src/observability/events.ts`
- Test: `scripts/cdp-bridge/test/unit/observability-events.test.js`

- [ ] **Step 1: Write the failing test**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyFamily } from '../../dist/observability/events.js';

test('classifyFamily maps tool names to families', () => {
  assert.equal(classifyFamily('device_press'), 'interaction');
  assert.equal(classifyFamily('device_fill'), 'interaction');
  assert.equal(classifyFamily('cdp_navigation_state'), 'navigation');
  assert.equal(classifyFamily('cdp_store_state'), 'introspection');
  assert.equal(classifyFamily('device_screenshot'), 'introspection');
  assert.equal(classifyFamily('cdp_status'), 'lifecycle');
  assert.equal(classifyFamily('maestro_run'), 'testing');
  assert.equal(classifyFamily('something_else'), 'other');
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npm --prefix scripts/cdp-bridge run build && node --test scripts/cdp-bridge/test/unit/observability-events.test.js`
Expected: FAIL — cannot find module `dist/observability/events.js`.

- [ ] **Step 3: Implement `events.ts` (types + classifyFamily)**

```ts
export type AgentEventFamily =
  | 'interaction' | 'introspection' | 'navigation' | 'lifecycle' | 'testing' | 'other';

export interface AgentEvent {
  seq: number;
  ts: number;
  tool: string;
  family: AgentEventFamily;
  args: Record<string, unknown>;
  ok: boolean;
  durationMs?: number;
  error?: { message: string; code?: string };
  ghost?: { attempted: boolean; outcome: string };
  summary: string;
  payload?: unknown;
  truncated?: boolean;
}

const INTERACTION = new Set([
  'device_press', 'device_fill', 'device_swipe', 'device_scroll', 'device_longpress',
  'device_pinch', 'device_back', 'device_batch', 'device_scrollintoview', 'cdp_interact',
  'device_focus_next', 'device_pick_date', 'device_pick_value', 'device_deeplink',
]);
const NAVIGATION = new Set(['cdp_navigation_state', 'cdp_nav_graph', 'cdp_navigate']);
const INTROSPECTION = new Set([
  'cdp_component_tree', 'cdp_component_state', 'cdp_store_state', 'device_snapshot',
  'device_screenshot', 'cdp_network_log', 'cdp_network_body', 'cdp_console_log',
  'cdp_error_log', 'cdp_native_errors', 'cdp_diagnostic_renderers', 'cdp_object_inspect',
  'cdp_heap_usage', 'collect_logs',
]);
const LIFECYCLE = new Set([
  'cdp_status', 'cdp_connect', 'cdp_disconnect', 'cdp_targets', 'cdp_reload',
  'cdp_restart', 'cdp_dev_settings', 'cdp_open_devtools', 'device_list', 'observe',
]);
const TESTING = new Set([
  'maestro_run', 'maestro_generate', 'maestro_test_all', 'cdp_run_action',
  'cdp_repair_action', 'proof_step', 'cross_platform_verify', 'cdp_auto_login',
  'expect_redux', 'expect_route', 'expect_visible_by_testid', 'expect_text',
]);

export function classifyFamily(tool: string): AgentEventFamily {
  if (INTERACTION.has(tool)) return 'interaction';
  if (NAVIGATION.has(tool)) return 'navigation';
  if (INTROSPECTION.has(tool)) return 'introspection';
  if (LIFECYCLE.has(tool)) return 'lifecycle';
  if (TESTING.has(tool)) return 'testing';
  return 'other';
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: same as Step 2. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/cdp-bridge/src/observability/events.ts scripts/cdp-bridge/test/unit/observability-events.test.js
git commit -m "feat(observability): AgentEvent type + classifyFamily"
```

### Task 1.2: `clipThenRedact` (clip-before-redact, fail-closed, reuse redact())

**Files:** Modify `events.ts`; Test: append to `observability-events.test.js`

- [ ] **Step 1: Write the failing test**

```js
import { clipThenRedact } from '../../dist/observability/events.js';

test('clipThenRedact deep-redacts secrets in args and payload', () => {
  const r = clipThenRedact({ password: 'hunter2supersecretvalue' }, { auth: { token: 'eyJabc.def.ghi' } });
  assert.ok(!JSON.stringify(r.args).includes('hunter2supersecretvalue'));
  assert.ok(!JSON.stringify(r.payload).includes('eyJabc.def.ghi'));
});

test('clipThenRedact clips an oversized payload and flags truncated', () => {
  const big = { blob: 'x'.repeat(40_000) };
  const r = clipThenRedact({}, big);
  assert.equal(r.truncated, true);
  assert.ok(JSON.stringify(r.payload).length < 20_000);
});

test('clipThenRedact fails closed: a throwing value yields {redacted:true}, never raw', () => {
  const circular = {}; circular.self = circular; // JSON.stringify throws
  const r = clipThenRedact({}, circular);
  assert.deepEqual(r.payload, { redacted: true });
});
```

- [ ] **Step 2: Run it, verify it fails** (`clipThenRedact` not exported).

- [ ] **Step 3: Implement `clipThenRedact` in `events.ts`**

```ts
import { redact } from '../experience/redact.js';

const PAYLOAD_CLIP_BYTES = 16_000;

function clipValue(value: unknown): { value: unknown; truncated: boolean } {
  let json: string;
  try { json = JSON.stringify(value); } catch { return { value: { redacted: true }, truncated: false }; }
  if (json === undefined) return { value, truncated: false };
  if (json.length <= PAYLOAD_CLIP_BYTES) return { value, truncated: false };
  // Clip the serialized form, then re-parse a safe stub (we don't re-parse the
  // clipped JSON — it may be invalid; we hand the redactor a clipped string).
  return { value: { _clipped: json.slice(0, PAYLOAD_CLIP_BYTES) }, truncated: true };
}

/** Deep-redact args + payload, fail-closed. Clips payload BEFORE redacting so a
 *  huge introspection result never costs a full deep-redact pass on the hot path. */
export function clipThenRedact(
  args: Record<string, unknown>,
  payload: unknown,
): { args: Record<string, unknown>; payload?: unknown; truncated?: boolean } {
  let redactedArgs: Record<string, unknown>;
  try { redactedArgs = redact(args ?? {}); } catch { redactedArgs = { redacted: true }; }

  if (payload === undefined || payload === null) return { args: redactedArgs };

  let truncated = false;
  let redactedPayload: unknown;
  try {
    const clipped = clipValue(payload);
    truncated = clipped.truncated;
    // redact() expects a Record; wrap non-records so primitives/arrays are covered.
    redactedPayload = redact({ v: clipped.value }).v;
  } catch {
    redactedPayload = { redacted: true };
  }
  return { args: redactedArgs, payload: redactedPayload, truncated: truncated || undefined };
}
```

- [ ] **Step 4: Run it, verify it passes.**

- [ ] **Step 5: Commit**

```bash
git add scripts/cdp-bridge/src/observability/events.ts scripts/cdp-bridge/test/unit/observability-events.test.js
git commit -m "feat(observability): clipThenRedact (clip-before-redact, fail-closed)"
```

### Task 1.3: `summarize` + `mapObservation`

**Files:** Modify `events.ts`; Test: append.

- [ ] **Step 1: Write the failing test**

```js
import { mapObservation } from '../../dist/observability/events.js';

test('mapObservation builds an AgentEvent with seq, family, summary, redaction, ghost', () => {
  const e = mapObservation(7, {
    tool: 'device_fill', params: { ref: 'e5', text: 'secretpassword1234567890' },
    status: 'PASS', latencyMs: 42, result: { ok: true },
    ghost: { attempted: true, outcome: 'recovered' },
  });
  assert.equal(e.seq, 7);
  assert.equal(e.tool, 'device_fill');
  assert.equal(e.family, 'interaction');
  assert.equal(e.ok, true);
  assert.equal(e.durationMs, 42);
  assert.deepEqual(e.ghost, { attempted: true, outcome: 'recovered' });
  assert.ok(typeof e.summary === 'string' && e.summary.length > 0);
});
```

- [ ] **Step 2: Run it, verify it fails.**

- [ ] **Step 3: Implement `summarize` + `mapObservation`**

```ts
export interface ToolObservation {
  tool: string;
  params: Record<string, unknown>;
  status: 'PASS' | 'FAIL' | 'ERROR';
  latencyMs: number;
  result?: unknown;
  error?: string;
  ghost?: { attempted: boolean; outcome: string };
}

function summarize(tool: string, family: AgentEventFamily, args: Record<string, unknown>, ok: boolean): string {
  const target = (args.testID ?? args.ref ?? args.text ?? args.screen ?? args.path ?? '') as string;
  const head = target ? `${tool} ${String(target).slice(0, 60)}` : tool;
  return ok ? head : `${head} ✗`;
}

export function mapObservation(seq: number, o: ToolObservation): AgentEvent {
  const family = classifyFamily(o.tool);
  const ok = o.status === 'PASS';
  const { args, payload, truncated } = clipThenRedact(o.params ?? {}, ok ? o.result : undefined);
  const ev: AgentEvent = {
    seq, ts: Date.now(), tool: o.tool, family, args, ok,
    durationMs: o.latencyMs, summary: summarize(o.tool, family, args, ok),
  };
  if (payload !== undefined) ev.payload = payload;
  if (truncated) ev.truncated = true;
  if (!ok && o.error) ev.error = { message: String(o.error).slice(0, 500) };
  if (o.ghost?.attempted) ev.ghost = o.ghost;
  return ev;
}
```

> Note: `Date.now()` is fine here (real runtime); only Workflow scripts forbid it.

- [ ] **Step 4: Run it, verify it passes.**
- [ ] **Step 5: Commit** (`feat(observability): summarize + mapObservation`).

---

## Phase 2 — `recorder.ts` (ring buffer + seq + subscribers + screenshot bytes)

### Task 2.1: Recorder core (record/snapshot/attach, seq, eviction)

**Files:**
- Create: `scripts/cdp-bridge/src/observability/recorder.ts`
- Test: `scripts/cdp-bridge/test/unit/observability-recorder.test.js`

- [ ] **Step 1: Write the failing test**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Recorder } from '../../dist/observability/recorder.js';

test('record assigns monotonic seq and snapshot returns chronological order', () => {
  const r = new Recorder(3);
  r.record({ tool: 'cdp_status', params: {}, status: 'PASS', latencyMs: 1 });
  r.record({ tool: 'device_press', params: { ref: 'e1' }, status: 'PASS', latencyMs: 2 });
  const snap = r.snapshot();
  assert.equal(snap.length, 2);
  assert.equal(snap[0].seq, 1);
  assert.equal(snap[1].seq, 2);
});

test('ring buffer evicts oldest beyond capacity', () => {
  const r = new Recorder(2);
  for (let i = 0; i < 5; i++) r.record({ tool: 'cdp_status', params: {}, status: 'PASS', latencyMs: 1 });
  const snap = r.snapshot();
  assert.equal(snap.length, 2);
  assert.equal(snap[1].seq, 5);
});

test('attach() returns a same-tick snapshot and delivers subsequent events (no gap)', () => {
  const r = new Recorder(10);
  r.record({ tool: 'cdp_status', params: {}, status: 'PASS', latencyMs: 1 });
  const got = [];
  const { snapshot, detach } = r.attach((e) => got.push(e.seq));
  assert.equal(snapshot.length, 1);
  r.record({ tool: 'device_press', params: {}, status: 'PASS', latencyMs: 1 });
  assert.deepEqual(got, [2]);
  detach();
  r.record({ tool: 'device_press', params: {}, status: 'PASS', latencyMs: 1 });
  assert.deepEqual(got, [2]); // detached — no more deliveries
});

test('record swallows errors (never throws into the caller)', () => {
  const r = new Recorder(2);
  assert.doesNotThrow(() => r.record(null)); // malformed observation
});
```

- [ ] **Step 2: Run it, verify it fails.**

- [ ] **Step 3: Implement `recorder.ts`**

```ts
import { RingBuffer } from '../ring-buffer.js';
import { mapObservation, type AgentEvent, type ToolObservation } from './events.js';

const DEFAULT_CAP = 500;

export interface ScreenshotBytes { buf: Buffer; contentType: string; }

export class Recorder {
  private buf: RingBuffer<AgentEvent>;
  private seq = 0;
  private subs = new Set<(e: AgentEvent) => void>();
  private shots = new Map<number, ScreenshotBytes>();
  private readonly shotCap: number;

  constructor(capacity: number = DEFAULT_CAP) {
    this.buf = new RingBuffer<AgentEvent>(capacity);
    this.shotCap = Math.max(8, Math.floor(capacity / 10));
  }

  record(o: ToolObservation): void {
    try {
      if (!o || typeof o !== 'object' || typeof o.tool !== 'string') return;
      const ev = mapObservation(++this.seq, o);
      this.buf.push(ev);
      this.captureScreenshot(ev, o);   // Task 2.2 (no-op until implemented)
      for (const fn of this.subs) { try { fn(ev); } catch { /* swallow per-subscriber */ } }
    } catch {
      // observability is strictly non-load-bearing — never throw into the tool path
    }
  }

  snapshot(): AgentEvent[] { return this.buf.getLast(this.buf.size); }

  /** Atomic snapshot + subscribe in one synchronous tick (no gap/duplicate race). */
  attach(fn: (e: AgentEvent) => void): { snapshot: AgentEvent[]; detach: () => void } {
    const snapshot = this.buf.getLast(this.buf.size);
    this.subs.add(fn);
    return { snapshot, detach: () => { this.subs.delete(fn); } };
  }

  getScreenshot(seq: number): ScreenshotBytes | undefined { return this.shots.get(seq); }

  clear(): void { this.buf.clear(); this.subs.clear(); this.shots.clear(); this.seq = 0; }

  protected captureScreenshot(_ev: AgentEvent, _o: ToolObservation): void { /* Task 2.2 */ }
}

export const recorder = new Recorder();
```

- [ ] **Step 4: Run it, verify it passes.**
- [ ] **Step 5: Commit** (`feat(observability): Recorder core`).

### Task 2.2: Capture screenshot bytes at record time

**Files:** Modify `recorder.ts`; Test: append to recorder test.

- [ ] **Step 1: Write the failing test** (write a temp PNG, record a screenshot event, assert bytes captured + served by seq)

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Recorder } from '../../dist/observability/recorder.js';

test('captureScreenshot reads bytes at record time and serves by seq', () => {
  const dir = mkdtempSync(join(tmpdir(), 'obs-'));
  const png = join(dir, 'shot.jpg');
  writeFileSync(png, Buffer.from([0xff, 0xd8, 0xff, 0xe0])); // JPEG magic
  const r = new Recorder(5);
  r.record({ tool: 'device_screenshot', params: {}, status: 'PASS',
    latencyMs: 5, result: { ok: true, data: { message: png } } });
  const shot = r.getScreenshot(1);
  assert.ok(shot, 'screenshot bytes captured');
  assert.equal(shot.contentType, 'image/jpeg');
  assert.ok(shot.buf.length === 4);
});

test('captureScreenshot ignores a missing/oversized/non-image file (fail-safe)', () => {
  const r = new Recorder(5);
  r.record({ tool: 'device_screenshot', params: {}, status: 'PASS',
    latencyMs: 5, result: { ok: true, data: { message: '/nonexistent/x.png' } } });
  assert.equal(r.getScreenshot(1), undefined);
});
```

- [ ] **Step 2: Run it, verify it fails.**

- [ ] **Step 3: Implement `captureScreenshot`** (replace the stub)

```ts
import { readFileSync, statSync } from 'node:fs';

const MAX_SHOT_BYTES = 4_000_000; // ~4MB cap

function screenshotPath(result: unknown): string | null {
  const data = (result as { data?: { message?: string; path?: string } })?.data;
  const p = data?.path ?? data?.message;
  return typeof p === 'string' && (p.endsWith('.jpg') || p.endsWith('.jpeg') || p.endsWith('.png')) ? p : null;
}

protected captureScreenshot(ev: AgentEvent, o: ToolObservation): void {
  if (ev.tool !== 'device_screenshot' || !ev.ok) return;
  const p = screenshotPath(o.result);
  if (!p) return;
  try {
    if (statSync(p).size > MAX_SHOT_BYTES) return;
    const buf = readFileSync(p);
    const contentType = p.endsWith('.png') ? 'image/png' : 'image/jpeg';
    this.shots.set(ev.seq, { buf, contentType });
    // bound the screenshot map (evict oldest seq)
    while (this.shots.size > this.shotCap) {
      const oldest = this.shots.keys().next().value;
      if (oldest === undefined) break;
      this.shots.delete(oldest);
    }
  } catch { /* file vanished / unreadable — fail-safe, no screenshot for this seq */ }
}
```

- [ ] **Step 4: Run it, verify it passes.**
- [ ] **Step 5: Commit** (`feat(observability): capture screenshot bytes at record time (Codex 3)`).

---

## Phase 3 — Hook the recorder into tool dispatch (telemetry observer)

### Task 3.1: `setToolObserver` in telemetry.ts (record once, post-ghost, with ghost field)

**Files:**
- Modify: `scripts/cdp-bridge/src/experience/telemetry.ts`
- Test: `scripts/cdp-bridge/test/unit/observability-observer.test.js`

- [ ] **Step 1: Write the failing test** (an instrumented FAIL→ghost-recovered call yields ONE observation with ghost.recovered)

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { instrumentTool, setToolObserver } from '../../dist/experience/telemetry.js';

test('observer fires once per logical call with resolved status', async () => {
  const seen = [];
  setToolObserver((o) => seen.push(o));
  const tool = instrumentTool('device_press', async () => ({ ok: true, content: [{ text: '{"ok":true}' }] }));
  await tool({ ref: 'e1' });
  setToolObserver(null);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].tool, 'device_press');
  assert.equal(seen[0].status, 'PASS');
});

test('observer never throws into the tool path', async () => {
  setToolObserver(() => { throw new Error('boom'); });
  const tool = instrumentTool('cdp_status', async () => ({ ok: true, content: [{ text: '{"ok":true}' }] }));
  await assert.doesNotReject(() => tool({}));
  setToolObserver(null);
});
```

- [ ] **Step 2: Run it, verify it fails** (`setToolObserver` not exported).

- [ ] **Step 3: Implement the observer in telemetry.ts**

Add near the top-level state:

```ts
export interface ToolObserverInput {
  tool: string; params: Record<string, unknown>; status: 'PASS' | 'FAIL' | 'ERROR';
  latencyMs: number; result?: unknown; error?: string;
  ghost?: { attempted: boolean; outcome: string };
}
let toolObserver: ((o: ToolObserverInput) => void) | null = null;
export function setToolObserver(fn: ((o: ToolObserverInput) => void) | null): void { toolObserver = fn; }
function notifyObserver(o: ToolObserverInput): void {
  if (!toolObserver) return;
  try { toolObserver(o); } catch { /* observability is non-load-bearing */ }
}
```

Then add a `notifyObserver(...)` call beside each existing `logToolCall(...)` site in `instrumentTool` (3 sites), passing the SAME resolved status + result/error + ghost:
- ghost-recovered PASS (after `logToolCall(... 'PASS' ...)`): `notifyObserver({ tool: toolName, params, status: 'PASS', latencyMs: totalLatency, result: ghostResult.recovered_result, ghost: { attempted: true, outcome: 'recovered' } });`
- normal log (after `logToolCall(toolName, params, status, latency, ...)`): `notifyObserver({ tool: toolName, params, status, latencyMs: latency, result, error: status === 'FAIL' ? extractErrorFromResult(result) ?? undefined : undefined });`
- thrown-error log (after `logToolCall(toolName, params, 'ERROR', latency, msg)`): `notifyObserver({ tool: toolName, params, status: 'ERROR', latencyMs: latency, error: msg });`

This guarantees **one** observation per logical call, after ghost resolution (Gemini finding 1).

- [ ] **Step 4: Run it, verify it passes.**
- [ ] **Step 5: Commit** (`feat(telemetry): tool observer hook for observability (Gemini 1)`).

### Task 3.2: Register the recorder as the observer in index.ts

**Files:** Modify `scripts/cdp-bridge/src/index.ts`

- [ ] **Step 1: Wire it (one line near startup, after imports)**

```ts
import { recorder } from './observability/recorder.js';
import { setToolObserver } from './experience/telemetry.js';
// ...after server setup:
setToolObserver((o) => recorder.record(o));
```

- [ ] **Step 2: Build + run the full suite** (`npm --prefix scripts/cdp-bridge test`) — Expected: all green, no regressions.
- [ ] **Step 3: Commit** (`feat(observability): register recorder as tool observer`).

---

## Phase 4 — `server.ts` (SSE + security + screenshot route + lifecycle)

### Task 4.1: Server skeleton — start/stop, dynamic port + EADDRINUSE fallback

**Files:**
- Create: `scripts/cdp-bridge/src/observability/server.ts`
- Test: `scripts/cdp-bridge/test/unit/observability-server.test.js`

- [ ] **Step 1: Write the failing test**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ObservabilityServer } from '../../dist/observability/server.js';
import { Recorder } from '../../dist/observability/recorder.js';

test('server starts on 127.0.0.1 and reports a url+port, then stops', async () => {
  const srv = new ObservabilityServer(new Recorder(10));
  const { url, port } = await srv.start();
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.ok(port > 0);
  await srv.stop();
});
```

- [ ] **Step 2: Run it, verify it fails.**

- [ ] **Step 3: Implement the skeleton**

```ts
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Recorder } from './recorder.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HOST = '127.0.0.1';
const __dir = dirname(fileURLToPath(import.meta.url));

export class ObservabilityServer {
  private server: Server | null = null;
  private port = 0;
  constructor(private readonly recorder: Recorder) {}

  async start(preferredPort?: number): Promise<{ url: string; port: number }> {
    if (this.server) return { url: this.url(), port: this.port };
    const server = createServer((req, res) => this.handle(req, res));
    server.requestTimeout = 0;            // SSE: don't kill long-lived requests (Codex 5)
    server.headersTimeout = 0;
    this.port = await listen(server, preferredPort ?? 0).catch(async (e) => {
      if ((e as NodeJS.ErrnoException).code === 'EADDRINUSE' && preferredPort) {
        return listen(server, 0);         // pinned-port collision → dynamic (Gemini 5)
      }
      throw e;
    });
    this.server = server;
    return { url: this.url(), port: this.port };
  }

  async stop(): Promise<void> {
    const s = this.server; this.server = null;
    if (s) await new Promise<void>((r) => s.close(() => r()));
  }

  private url(): string { return `http://${HOST}:${this.port}`; }
  private handle(req: IncomingMessage, res: ServerResponse): void { res.writeHead(404); res.end(); } // filled in 4.2+
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, HOST, () => {
      server.removeListener('error', reject);
      const addr = server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : port);
    });
  });
}
```

- [ ] **Step 4: Run it, verify it passes.**
- [ ] **Step 5: Commit** (`feat(observability): SSE server skeleton + port fallback`).

### Task 4.2: Security guard (Host-header allowlist + Sec-Fetch-Site)

**Files:** Modify `server.ts`; Test: append.

- [ ] **Step 1: Write the failing test**

```js
test('rejects a foreign Host header (DNS-rebinding) and cross-site Sec-Fetch-Site', async () => {
  const srv = new ObservabilityServer(new Recorder(10));
  const { port } = await srv.start();
  const bad = await fetch(`http://127.0.0.1:${port}/api/stream`, { headers: { Host: 'evil.example' } });
  assert.equal(bad.status, 403);
  const xsite = await fetch(`http://127.0.0.1:${port}/`, { headers: { 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(xsite.status, 403);
  await srv.stop();
});
```

- [ ] **Step 2: Run it, verify it fails.**

- [ ] **Step 3: Implement the guard, call it first in `handle()`**

```ts
private guard(req: IncomingMessage, res: ServerResponse): boolean {
  const host = (req.headers.host ?? '').toLowerCase();
  const okHost = host === `127.0.0.1:${this.port}` || host === `localhost:${this.port}`
    || host === '127.0.0.1' || host === 'localhost';
  const site = req.headers['sec-fetch-site'];
  const okSite = site === undefined || site === 'same-origin' || site === 'none';
  if (!okHost || !okSite) { res.writeHead(403); res.end('forbidden'); return false; }
  return true;
}
```
In `handle`: `if (!this.guard(req, res)) return;` before routing.

- [ ] **Step 4: Run it, verify it passes.**
- [ ] **Step 5: Commit** (`feat(observability): Host-header + Sec-Fetch-Site guard (Codex 2)`).

### Task 4.3: SSE stream (atomic snapshot+subscribe, heartbeat, backpressure prune)

**Files:** Modify `server.ts`; Test: append.

- [ ] **Step 1: Write the failing test** (connect, receive the snapshot of a pre-existing event, then a live one)

```js
test('GET /api/stream replays snapshot then streams live events', async () => {
  const rec = new Recorder(10);
  rec.record({ tool: 'cdp_status', params: {}, status: 'PASS', latencyMs: 1 });
  const srv = new ObservabilityServer(rec);
  const { port } = await srv.start();
  const res = await fetch(`http://127.0.0.1:${port}/api/stream`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let txt = '';
  // read the snapshot frame
  txt += dec.decode((await reader.read()).value);
  rec.record({ tool: 'device_press', params: {}, status: 'PASS', latencyMs: 1 });
  // read the live frame
  for (let i = 0; i < 3 && !txt.includes('device_press'); i++) txt += dec.decode((await reader.read()).value);
  assert.ok(txt.includes('cdp_status'));   // snapshot
  assert.ok(txt.includes('device_press')); // live
  await reader.cancel();
  await srv.stop();
});
```

- [ ] **Step 2: Run it, verify it fails.**

- [ ] **Step 3: Implement the SSE route** (add to `handle()` routing + a `stream()` method)

```ts
private stream(res: ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  res.flushHeaders?.();
  res.socket?.setTimeout(0);
  const write = (ev: unknown): boolean => res.write(`data: ${JSON.stringify(ev)}\n\n`);
  const { snapshot, detach } = this.recorder.attach((ev) => {
    if (!write(ev)) { detach(); res.end(); }   // backpressure: stop on false (Codex 6)
  });
  write({ type: 'snapshot', events: snapshot });
  const hb = setInterval(() => res.write(': hb\n\n'), 15_000);
  res.on('close', () => { clearInterval(hb); detach(); });
}
```
Routing in `handle()`: `if (req.url === '/api/stream') return this.stream(res);`

- [ ] **Step 4: Run it, verify it passes.**
- [ ] **Step 5: Commit** (`feat(observability): SSE stream + heartbeat + backpressure (Codex 5/6, Gemini 3)`).

### Task 4.4: Screenshot route + SPA static serve

**Files:** Modify `server.ts`; Test: append.

- [ ] **Step 1: Write the failing test** (serves bytes from the recorder buffer; never reads FS by request)

```js
test('GET /api/screenshot/:seq serves bytes from the recorder buffer only', async () => {
  const rec = new Recorder(10);
  // inject a screenshot via the documented path (write a temp jpg + record)
  const { writeFileSync, mkdtempSync } = await import('node:fs');
  const { join } = await import('node:path'); const { tmpdir } = await import('node:os');
  const p = join(mkdtempSync(join(tmpdir(), 'obs-')), 's.jpg');
  writeFileSync(p, Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
  rec.record({ tool: 'device_screenshot', params: {}, status: 'PASS', latencyMs: 1, result: { ok: true, data: { message: p } } });
  const srv = new ObservabilityServer(rec);
  const { port } = await srv.start();
  const ok = await fetch(`http://127.0.0.1:${port}/api/screenshot/1`);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'image/jpeg');
  const miss = await fetch(`http://127.0.0.1:${port}/api/screenshot/999`);
  assert.equal(miss.status, 404);
  await srv.stop();
});
```

- [ ] **Step 2: Run it, verify it fails.**

- [ ] **Step 3: Implement the screenshot + static routes**

```ts
private screenshot(seq: number, res: ServerResponse): void {
  const shot = this.recorder.getScreenshot(seq);
  if (!shot) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': shot.contentType, 'Cache-Control': 'no-store' });
  res.end(shot.buf);
}

private index(res: ServerResponse): void {
  try {
    const html = readFileSync(join(__dir, 'web-dist', 'index.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  } catch { res.writeHead(503); res.end('SPA bundle not built — run npm run build:web'); }
}
```
Routing: `/` → index; `/api/stream` → stream; `^/api/screenshot/(\d+)$` → screenshot(seq).

- [ ] **Step 4: Run it, verify it passes.**
- [ ] **Step 5: Commit** (`feat(observability): screenshot route (buffer-only) + SPA serve`).

---

## Phase 5 — `observe` MCP tool + `/rn-dev-agent:observe` slash command

### Task 5.1: `observe` tool (start/stop/status), registered via trackedTool

**Files:** Modify `index.ts` (or a new `src/tools/observe.ts` + register); Test: `observability-observe-tool.test.js`

- [ ] **Step 1: Write the failing test** (the handler returns a localhost URL on start; status reflects running)

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { observeHandler } from '../../dist/tools/observe.js';
import { recorder } from '../../dist/observability/recorder.js';

test('observe start returns a 127.0.0.1 url; status running; stop tears down', async () => {
  const start = JSON.parse((await observeHandler({ action: 'start' })).content[0].text);
  assert.equal(start.ok, true);
  assert.match(start.data.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  const status = JSON.parse((await observeHandler({ action: 'status' })).content[0].text);
  assert.equal(status.data.running, true);
  await observeHandler({ action: 'stop' });
});
```

- [ ] **Step 2: Run it, verify it fails.**

- [ ] **Step 3: Implement `src/tools/observe.ts`** (singleton server bound to the shared `recorder`; envelope via the repo's `okResult`/`failResult` helpers — match existing tools)

```ts
import { z } from 'zod';
import { recorder } from '../observability/recorder.js';
import { ObservabilityServer } from '../observability/server.js';
import { okResult, failResult } from '../types.js'; // match the repo's envelope helper location

let server: ObservabilityServer | null = null;
const PINNED = process.env.RN_AGENT_OBSERVE_PORT ? Number(process.env.RN_AGENT_OBSERVE_PORT) : undefined;

export const observeSchema = { action: z.enum(['start', 'stop', 'status']).default('status') };

export async function observeHandler(args: { action?: 'start' | 'stop' | 'status' }) {
  const action = args.action ?? 'status';
  try {
    if (action === 'start') {
      if (!server) server = new ObservabilityServer(recorder);
      const { url, port } = await server.start(PINNED);
      return okResult({ url, port, running: true, hint: `Open ${url} to watch the agent live.` });
    }
    if (action === 'stop') {
      await server?.stop(); server = null;
      return okResult({ running: false });
    }
    return okResult({ running: !!server });
  } catch (e) {
    return failResult(`observe ${action} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
```
Register in index.ts: `trackedTool('observe', 'Start/stop the read-only observability web UI...', observeSchema, observeHandler);`

- [ ] **Step 4: Run it, verify it passes.** (If `okResult/failResult` live elsewhere, grep `okResult` to find the import path and match it.)
- [ ] **Step 5: Commit** (`feat(observability): observe MCP tool`).

### Task 5.2: `/rn-dev-agent:observe` slash command

**Files:** Create `commands/observe.md`

- [ ] **Step 1: Author the command** (model frontmatter on `commands/nav-graph.md`)

```markdown
---
description: Start the read-only observability web UI and print the URL to watch the agent live.
---

Call the `observe` MCP tool with `action: "start"`. Print the returned `url` prominently and tell the user to open it in a browser to watch the live tool-call timeline, device screenshot, and app state. If it's already running, `observe status` returns the existing URL. To stop it, call `observe` with `action: "stop"`.
```

- [ ] **Step 2: Commit** (`feat(observability): /observe slash command`).

---

## Phase 6 — React/Vite SPA (Layout A) + build

> The SPA is browser code; per spec §9 it's **manual-verified** in v1 (no node --test). Keep it small and single-purpose.

### Task 6.1: Vite project + single-file bundle

**Files:** Create `src/observability/web/{package.json,vite.config.ts,index.html,src/main.tsx}`

- [ ] **Step 1: `web/package.json`** (isolated from the cdp-bridge package)

```json
{
  "name": "rn-dev-agent-observability-web",
  "private": true,
  "type": "module",
  "scripts": { "build": "vite build" },
  "dependencies": { "react": "^19.0.0", "react-dom": "^19.0.0" },
  "devDependencies": {
    "@vitejs/plugin-react": "^4.3.0", "vite": "^6.0.0",
    "vite-plugin-singlefile": "^2.0.0", "typescript": "^5.4.0"
  }
}
```

- [ ] **Step 2: `web/vite.config.ts`** (single-file output → committed bundle path)

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

export default defineConfig({
  plugins: [react(), viteSingleFile()],
  build: { outDir: '../web-dist', emptyOutDir: true, assetsInlineLimit: 100_000_000 },
});
```

- [ ] **Step 3: Add root build:web script** — modify `scripts/cdp-bridge/package.json` scripts:

```json
"build:web": "cd src/observability/web && npm install && npm run build"
```

- [ ] **Step 4: Commit** (`feat(observability): vite SPA scaffold`).

### Task 6.2: Layout A SPA (EventSource client, virtualized timeline, screen, state tabs)

**Files:** `web/src/main.tsx` (+ minimal CSS). Key behaviors:

- [ ] **Step 1: Implement** — connect `new EventSource('/api/stream')`; maintain an events array; **dedup by `seq`** (drop `seq <= maxSeq` already seen — Gemini 3); fold "latest of family" for the state panels; render three panes (timeline left / `<img src="/api/screenshot/<latestShotSeq>">` center / route+store+tree tabs right); **virtualize** the timeline list (render only the visible window — Gemini 7); on `snapshot` message, seed from `events`.

```tsx
// abbreviated — full file in repo; core data hook:
const [events, setEvents] = React.useState<AgentEvent[]>([]);
const maxSeq = React.useRef(0);
React.useEffect(() => {
  const es = new EventSource('/api/stream');
  es.onmessage = (m) => {
    const d = JSON.parse(m.data);
    const incoming = d.type === 'snapshot' ? d.events : [d];
    setEvents((prev) => {
      const next = prev.slice();
      for (const e of incoming) if (e.seq > maxSeq.current) { next.push(e); maxSeq.current = e.seq; }
      return next.slice(-500);
    });
  };
  return () => es.close();
}, []);
const latestOf = (fam) => [...events].reverse().find((e) => e.family === fam);
```

- [ ] **Step 2: Build + manual-verify** — `npm --prefix scripts/cdp-bridge run build:web`, then drive the live test app, call `observe start`, open the URL, confirm the timeline streams, the screenshot updates on `device_screenshot`, and the state tabs show route/store/tree.
- [ ] **Step 3: Commit the source + the generated `web-dist/index.html`** (`feat(observability): Layout A SPA`).

---

## Phase 7 — CI freshness guard + finalize

### Task 7.1: Bundle-freshness CI guard

**Files:** Create `scripts/check-web-bundle.sh`; Modify `.github/workflows/ci.yml`

- [ ] **Step 1: Write the guard** (rebuild web, fail if the committed bundle drifted — Gemini 4)

```bash
#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/scripts/cdp-bridge" && npm run build:web >/dev/null 2>&1
if ! git -C "$ROOT" diff --quiet -- scripts/cdp-bridge/src/observability/web-dist/index.html; then
  echo "ERROR: committed SPA bundle is stale — run 'npm run build:web' and commit web-dist/index.html"; exit 1
fi
echo "web bundle fresh"
```

- [ ] **Step 2: Add a CI job** in ci.yml (PR-only, like require-changeset):

```yaml
  web-bundle:
    name: Web bundle freshness
    runs-on: ubuntu-latest
    if: github.event_name == 'pull_request'
    steps:
      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd  # v6.0.2
      - uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e  # v6.4.0
        with: { node-version: 22 }
      - run: bash scripts/check-web-bundle.sh
```

- [ ] **Step 3: Commit** (`ci: web-bundle freshness guard (Gemini 4)`).

### Task 7.2: Docs + final verification

- [ ] **Step 1:** Add an "Observability UI" note to `CLAUDE-MD-TEMPLATE.md` (how a user opens `/rn-dev-agent:observe`) and `README`.
- [ ] **Step 2:** Run `npm --prefix scripts/cdp-bridge run test:all` — Expected: all green.
- [ ] **Step 3:** Live smoke: Metro + test app up → `observe start` → open URL → drive a multi-step flow → confirm timeline, screenshot, and state panels update; **verify no secret appears** (fill a password field, confirm it's `[REDACTED_SECRET]` in the UI).
- [ ] **Step 4:** Update workspace `DECISIONS.md` (mark D1226 observability-UI delivered) + `ROADMAP.md`. Commit.
- [ ] **Step 5:** Open the PR (squash-merge; the changeset drives the version bump).

---

## Self-review checklist (run before execution)

- **Spec coverage:** recorder ✓(P2), redaction args+payload fail-closed ✓(1.2), screenshot bytes ✓(2.2), ghost-once record ✓(3.1), SSE+atomic snapshot ✓(4.3), Host-header ✓(4.2), backpressure ✓(4.3), keep-alive ✓(4.3), port fallback ✓(4.1), observe tool+slash ✓(P5), Layout A + virtualization ✓(6.2), Vite build + CI guard ✓(6.1/7.1), changeset ✓(0.1). All §13 findings mapped.
- **Type consistency:** `AgentEvent`/`ToolObservation`/`ToolObserverInput` shapes match across events.ts ↔ recorder.ts ↔ telemetry.ts; `mapObservation(seq, observation)` signature stable; `Recorder.attach()`/`getScreenshot()` used consistently by server.ts.
- **Placeholder scan:** no TBD/"handle errors"/undefined refs — every code step is concrete. (Two impl-detail confirmations to do at execution: the `okResult/failResult` import path in 5.1, and the exact `instrumentTool` site wording in 3.1 — both grep-verifiable.)
