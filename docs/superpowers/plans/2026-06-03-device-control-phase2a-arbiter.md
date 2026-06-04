# Device Control Phase 2a — DeviceSessionArbiter (plane serialization) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serialize the three device-control planes within one bridge process — `flow` (Maestro) is exclusive; `introspection` (CDP reads) and `interaction` (`device_*`) coexist — so a CDP read or a tap can never interleave with a running Maestro flow; conflicts refuse fast with `BUSY_FLOW_ACTIVE`.

**Architecture:** A new in-memory singleton `DeviceSessionArbiter` (`lifecycle/device-arbiter.ts`) tracks a single `flowLeaseHeldBy` op-id + a set of in-flight op-ids. A pure `arbiterWrap(name, handler, arbiter)` wraps each MCP handler at the existing `trackedTool` chokepoint (`index.ts`), acquiring the tool's plane before the handler and releasing after. Plane membership is a static `TOOL_PLANES` map. Composite tools (`cdp_run_action`, `proof_step`, `device_batch`) call underlying handler *functions*, not wrapped MCP tools, so they never re-enter the wrapper — one external call = exactly one lease, no nesting/self-conflict. `maestro_run` additionally parks the L2 fast-runner (`stopFastRunner`) for the flow's duration and marks CDP stale afterward so the next read reconnects.

**Tech Stack:** Node.js ≥22 (ESM), TypeScript, `node --test` (tests in `scripts/cdp-bridge/test/unit/`, run after `npm run build`, import compiled JS from `../../dist/`). Arbiter is a pure in-memory state machine — fully hermetic, no fs/process/device.

**Branch:** stack on Phase 1.5 — create `feat/202-phase2a-arbiter` from `feat/202-phase1.5-device-lock` (PR #213's branch).

**Spec:** `docs/superpowers/specs/2026-06-01-device-control-arbiter-design.md` §5 (Phase 2). **Scope note:** this plan is Phase **2a** — the arbiter + plane serialization. The bounded `recoverWedge()` + `cdp_status` wedge-recovery wiring (spec §5.1 `recoverWedge`, §5.2 `cdp_status` hook) is **Phase 2b**, a separate follow-on plan (it is live-device and the spec's foreground-diagnosis needs refinement). The in-memory lease must NOT persist (persisting recreates the #202 root-cause orphaned-lock bug — spec §5.1).

**Repo rules (carry over):** stage ONLY each task's files with explicit `git add` (never `-A`); `dist/` is TRACKED — stage rebuilt outputs; commits signed (1Password — STOP+BLOCKED on a socket error); trailer `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`; explicit type imports; no unnecessary comments. Working dir `scripts/cdp-bridge/` unless stated.

---

## Task 0: Branch + baseline

- [ ] **Step 1:** From repo root: `git checkout feat/202-phase1.5-device-lock && git checkout -b feat/202-phase2a-arbiter && git branch --show-current` → expect `feat/202-phase2a-arbiter`.
- [ ] **Step 2:** `cd scripts/cdp-bridge && npm run build && npm test 2>&1 | tail -6` → build clean; suite green (1624 pass after Phase 1.5). If a transient real-timer flake trips it, re-run once. If genuinely red, STOP and report.

---

## Task 1: `device-arbiter.ts` — the arbiter, plane map, and wrapper

**Files:**
- Create: `scripts/cdp-bridge/src/lifecycle/device-arbiter.ts`
- Test: `scripts/cdp-bridge/test/unit/gh-202-device-arbiter.test.js`

- [ ] **Step 1: Write the failing test.** Create `test/unit/gh-202-device-arbiter.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DeviceSessionArbiter, planeForTool, arbiterWrap,
} from '../../dist/lifecycle/device-arbiter.js';

test('GH#202 introspection + interaction coexist (shared)', () => {
  const a = new DeviceSessionArbiter();
  const r1 = a.tryAcquire('introspection', 'cdp_store_state');
  const r2 = a.tryAcquire('interaction', 'device_press');
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  a.release(r1.lease); a.release(r2.lease);
});

test('GH#202 flow is exclusive: refused while any op is active, and names the blocker', () => {
  const a = new DeviceSessionArbiter();
  const r1 = a.tryAcquire('interaction', 'device_press');
  const rf = a.tryAcquire('flow', 'maestro_run');
  assert.equal(rf.ok, false);
  assert.equal(rf.code, 'BUSY_FLOW_ACTIVE');
  assert.equal(rf.holder.tool, 'device_press'); // holder names the blocking op, not null
  assert.equal(rf.holder.plane, 'interaction');
  a.release(r1.lease);
  assert.equal(a.tryAcquire('flow', 'maestro_run').ok, true); // op released → flow can start
});

test('GH#202 reads/taps refused while a flow lease is held; holder is the flow', () => {
  const a = new DeviceSessionArbiter();
  const rf = a.tryAcquire('flow', 'maestro_run');
  assert.equal(rf.ok, true);
  const ri = a.tryAcquire('introspection', 'cdp_store_state');
  const rx = a.tryAcquire('interaction', 'device_press');
  assert.equal(ri.ok, false); assert.equal(ri.code, 'BUSY_FLOW_ACTIVE');
  assert.equal(rx.ok, false);
  assert.equal(ri.holder.opId, rf.lease.opId);
  assert.equal(ri.holder.tool, 'maestro_run');
  a.release(rf.lease);
  assert.equal(a.tryAcquire('introspection', 'cdp_store_state').ok, true); // freed
});

test('GH#202 release is idempotent and only frees its own op', () => {
  const a = new DeviceSessionArbiter();
  const r1 = a.tryAcquire('interaction', 'device_press');
  a.release(r1.lease);
  a.release(r1.lease); // double release → no throw, no underflow
  assert.equal(a.tryAcquire('flow', 'maestro_run').ok, true);
});

test('GH#202 reset() clears a leaked lease so flows can run again', () => {
  const a = new DeviceSessionArbiter();
  a.tryAcquire('flow', 'maestro_run'); // acquire then "leak" (never release)
  assert.equal(a.tryAcquire('flow', 'maestro_run').ok, false); // wedged
  const r = a.reset('test');
  assert.equal(r.hadFlow, true);
  assert.ok(r.clearedOps >= 1);
  assert.equal(a.tryAcquire('flow', 'maestro_run').ok, true); // recovered
});

test('GH#202 planeForTool: flow incl. auto-login/reload/restart; mutating CDP = interaction', () => {
  assert.equal(planeForTool('maestro_run'), 'flow');
  assert.equal(planeForTool('cdp_run_action'), 'flow');
  assert.equal(planeForTool('cdp_auto_login'), 'flow');   // runs a Maestro subflow
  assert.equal(planeForTool('cdp_reload'), 'flow');        // relaunches the app
  assert.equal(planeForTool('cdp_restart'), 'flow');       // relaunches the app
  assert.equal(planeForTool('device_press'), 'interaction');
  assert.equal(planeForTool('cdp_navigate'), 'interaction'); // mutates app state
  assert.equal(planeForTool('cdp_dispatch'), 'interaction'); // mutates store
  assert.equal(planeForTool('cdp_store_state'), 'introspection');
  assert.equal(planeForTool('cdp_status'), null);   // diagnostic + reset valve — always allowed
  assert.equal(planeForTool('cdp_connect'), null);  // connection mgmt
  assert.equal(planeForTool('device_list'), null);  // session-less
});

test('GH#202 arbiterWrap refuses with a TOP-LEVEL code while a flow runs, then frees it', async () => {
  const a = new DeviceSessionArbiter();
  let releaseFlow;
  const flowGate = new Promise((res) => { releaseFlow = res; });
  const flow = arbiterWrap('maestro_run', async () => { await flowGate; return { ok: true }; }, a);
  const tap = arbiterWrap('device_press', async () => ({ ok: true, _t: 'tap-done' }), a);

  const flowP = flow({});                 // acquires flow, awaits the gate
  await Promise.resolve();                // let flow acquire before tap tries
  const refused = await tap({});          // refused while flow holds
  // The refusal must carry BUSY_FLOW_ACTIVE as a TOP-LEVEL envelope code (not
  // buried in meta — the bug the original plan's substring match hid).
  const env = JSON.parse(refused.content[0].text);
  assert.equal(env.code, 'BUSY_FLOW_ACTIVE');

  releaseFlow();
  await flowP;
  const tap2 = await tap({});             // flow released → tap allowed
  assert.equal(tap2._t, 'tap-done');
});

test('GH#202 arbiterWrap passes through unarbitrated tools untouched (even mid-flow)', async () => {
  const a = new DeviceSessionArbiter();
  const status = arbiterWrap('cdp_status', async () => ({ _t: 'status' }), a);
  const rf = a.tryAcquire('flow', 'maestro_run');
  assert.equal((await status({}))._t, 'status');
  a.release(rf.lease);
});
```
(Step-2/Step-4 note: this is **9 tests**. If the `failResult` envelope shape differs from `result.content[0].text` JSON, read `utils.ts` and adapt the parse in the one assertion — the goal is to assert the code is top-level, not in `meta`.)

- [ ] **Step 2: Run → fail.** `npm run build && node --test test/unit/gh-202-device-arbiter.test.js` → FAIL (module missing).

- [ ] **Step 3: Implement.** Create `src/lifecycle/device-arbiter.ts`:
```ts
import { failResult } from '../utils.js';
import type { ToolResult } from '../utils.js';

export type Plane = 'introspection' | 'interaction' | 'flow';

export interface Lease { plane: Plane; opId: number }
export interface Holder { plane: Plane; tool: string; opId: number }
export interface AcquireOk { ok: true; lease: Lease }
export interface AcquireBusy { ok: false; code: 'BUSY_FLOW_ACTIVE'; holder: Holder | null }
export type AcquireResult = AcquireOk | AcquireBusy;

interface OpInfo { plane: Plane; tool: string; startedAtMs: number }

/**
 * GH#202 Phase 2a: in-memory serialization of the three device-control planes
 * for ONE bridge process. `flow` (Maestro) is exclusive — it cannot start while
 * any op is in flight, and no op can start while it is held. `introspection`
 * (CDP reads) and `interaction` (device_*) are shared and coexist. Refuse-fast,
 * never queue. MUST stay in-memory: persisting a lease recreates the #202
 * orphaned-lock bug. A leaked op-id would wedge all flows forever, so `reset()`
 * is the escape hatch (exposed via the unarbitrated cdp_status resetArbiter).
 */
export class DeviceSessionArbiter {
  private flowLeaseHeldBy: number | null = null;
  private readonly ops = new Map<number, OpInfo>();
  private nextOpId = 1;
  private readonly now: () => number;

  constructor(now: () => number = Date.now) { this.now = now; }

  tryAcquire(plane: Plane, tool: string): AcquireResult {
    if (plane === 'flow') {
      if (this.flowLeaseHeldBy !== null || this.ops.size > 0) {
        return { ok: false, code: 'BUSY_FLOW_ACTIVE', holder: this.describeBlocker() };
      }
      return this.grant(plane, tool, true);
    }
    if (this.flowLeaseHeldBy !== null) {
      return { ok: false, code: 'BUSY_FLOW_ACTIVE', holder: this.describeBlocker() };
    }
    return this.grant(plane, tool, false);
  }

  private grant(plane: Plane, tool: string, isFlow: boolean): AcquireOk {
    const opId = this.nextOpId++;
    this.ops.set(opId, { plane, tool, startedAtMs: this.now() });
    if (isFlow) this.flowLeaseHeldBy = opId;
    return { ok: true, lease: { plane, opId } };
  }

  // Who is blocking? Prefer the flow holder; else the OLDEST active op, so a
  // refused flow knows WHICH read/tap to wait on (holder is no longer null).
  private describeBlocker(): Holder | null {
    const id = this.flowLeaseHeldBy ?? this.oldestOpId();
    if (id === null) return null;
    const info = this.ops.get(id);
    return info ? { plane: info.plane, tool: info.tool, opId: id } : null;
  }

  private oldestOpId(): number | null {
    let oldest: number | null = null;
    let oldestAt = Infinity;
    for (const [id, info] of this.ops) {
      if (info.startedAtMs < oldestAt) { oldestAt = info.startedAtMs; oldest = id; }
    }
    return oldest;
  }

  release(lease: Lease): void {
    this.ops.delete(lease.opId);
    if (this.flowLeaseHeldBy === lease.opId) this.flowLeaseHeldBy = null;
  }

  /**
   * Clear ALL leases — the escape hatch for a leaked op-id (a hung handler whose
   * `finally` never ran). Exposed through the unarbitrated cdp_status
   * resetArbiter=true so it works even when a leaked FLOW lease would refuse
   * device_snapshot (which is itself the interaction plane).
   */
  reset(reason: string): { clearedOps: number; hadFlow: boolean; reason: string } {
    const clearedOps = this.ops.size;
    const hadFlow = this.flowLeaseHeldBy !== null;
    this.ops.clear();
    this.flowLeaseHeldBy = null;
    return { clearedOps, hadFlow, reason };
  }

  get snapshot(): { flowLeaseHeldBy: number | null; activeOps: number; ops: Array<{ opId: number; plane: Plane; tool: string }> } {
    return {
      flowLeaseHeldBy: this.flowLeaseHeldBy,
      activeOps: this.ops.size,
      ops: [...this.ops.entries()].map(([opId, i]) => ({ opId, plane: i.plane, tool: i.tool })),
    };
  }
}

/** The process-wide arbiter. One bridge = one simulator session = one arbiter. */
export const arbiter = new DeviceSessionArbiter();

// --- Plane classification ---------------------------------------------------
// flow: tools that drive the whole device via Maestro OR relaunch the app —
// exclusive, because either yanks the device out from under everything else.
// (#202 plan review: cdp_auto_login runs a Maestro subflow; cdp_reload/restart
// relaunch the app — none may interleave with a running flow.)
const FLOW_TOOLS = new Set<string>([
  'maestro_run', 'maestro_test_all', 'cdp_run_action', 'cdp_auto_login',
  'cdp_reload', 'cdp_restart',
]);
// interaction: anything that mutates device/app state — gestures AND
// state-mutating CDP calls (navigate/dispatch/set_shared_value/mmkv write).
// (#202 plan review: these were mislabeled "introspection" — they are writes.)
const INTERACTION_TOOLS = new Set<string>([
  'device_screenshot', 'device_snapshot', 'device_find', 'device_press', 'device_fill',
  'device_swipe', 'device_back', 'device_longpress', 'device_scroll', 'device_scrollintoview',
  'device_pinch', 'device_permission', 'device_reset_state', 'device_deeplink',
  'device_accept_system_dialog', 'device_dismiss_system_dialog', 'device_record',
  'device_pick_value', 'device_pick_date', 'device_focus_next', 'device_batch',
  'cdp_interact', 'cdp_repair_action', 'cross_platform_verify', 'proof_step',
  'cdp_navigate', 'cdp_dispatch', 'cdp_set_shared_value', 'cdp_mmkv',
]);
// introspection: genuinely read-only CDP/state queries.
const INTROSPECTION_TOOLS = new Set<string>([
  'cdp_evaluate', 'cdp_component_tree', 'cdp_component_state', 'cdp_diagnostic_renderers',
  'cdp_navigation_state', 'cdp_nav_graph', 'cdp_store_state',
  'cdp_network_log', 'cdp_network_body', 'cdp_wait_for_network', 'cdp_console_log',
  'cdp_error_log', 'cdp_native_errors', 'cdp_metro_events', 'cdp_heap_usage', 'cdp_cpu_profile',
  'cdp_object_inspect', 'cdp_exception_breakpoint',
  'collect_logs', 'expect_redux', 'expect_route', 'expect_visible_by_testid', 'expect_text',
]);
// Everything else is UNARBITRATED (null): cdp_status (the health check + the
// reset escape hatch), cdp_connect/disconnect/targets, device_list (session-less),
// cdp_record_test_*, dev settings/devtools. These must work even mid-flow.

export function planeForTool(name: string): Plane | null {
  if (FLOW_TOOLS.has(name)) return 'flow';
  if (INTERACTION_TOOLS.has(name)) return 'interaction';
  if (INTROSPECTION_TOOLS.has(name)) return 'introspection';
  return null;
}

/**
 * Wrap an MCP handler so it acquires its plane before running and releases
 * after. A refused acquire returns a ToolResult (never throws). Unarbitrated
 * tools (planeForTool → null) are returned unwrapped. Only EXTERNAL MCP calls
 * pass through here; composite tools call underlying handler functions, so a
 * flow tool's internal device/CDP work never re-enters this wrapper.
 */
export function arbiterWrap(
  name: string,
  handler: (...args: unknown[]) => Promise<ToolResult>,
  inst: DeviceSessionArbiter = arbiter,
): (...args: unknown[]) => Promise<ToolResult> {
  const plane = planeForTool(name);
  if (plane === null) return handler;
  return async (...args: unknown[]): Promise<ToolResult> => {
    const res = inst.tryAcquire(plane, name);
    if (!res.ok) {
      const who = res.holder ? `${res.holder.tool} (${res.holder.plane})` : 'a Maestro flow';
      // failResult(message, code, meta): a STRING 2nd arg becomes the top-level
      // envelope.code (utils.ts) — an object would wrongly land in meta.
      return failResult(
        `Refusing ${name}: blocked by ${who} on this device — reads and taps can't interleave ` +
        `with a running Maestro flow. Retry after it completes; if it appears stuck, ` +
        `run cdp_status({ resetArbiter: true }).`,
        res.code,
        { holder: res.holder, conflict: true },
      );
    }
    try {
      return await handler(...args);
    } finally {
      inst.release(res.lease);
    }
  };
}
```

- [ ] **Step 4: Run → pass.** `npm run build && node --test test/unit/gh-202-device-arbiter.test.js` → PASS (9 tests).

- [ ] **Step 5: Commit.**
```bash
git add src/lifecycle/device-arbiter.ts test/unit/gh-202-device-arbiter.test.js dist/lifecycle/device-arbiter.js
git commit -m "feat(arbiter): in-memory plane serialization (flow-exclusive, refuse-fast) (#202 Phase 2a)"
```

---

## Task 2: Wire `arbiterWrap` into the tool chokepoint

**Files:**
- Modify: `scripts/cdp-bridge/src/index.ts` (the `trackedTool` function, ~lines 148-150)
- Test: `scripts/cdp-bridge/test/unit/gh-202-arbiter-wiring.test.js`

- [ ] **Step 1: Write the failing wiring test.** Create `test/unit/gh-202-arbiter-wiring.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const indexSrc = readFileSync(resolve(__dirname, '../../src/index.ts'), 'utf8');

test('GH#202 trackedTool composes arbiterWrap inside instrumentTool', () => {
  assert.match(indexSrc, /import\s*\{[^}]*arbiterWrap[^}]*\}\s*from\s*'\.\/lifecycle\/device-arbiter\.js'/);
  // arbiterWrap(name, handler) is composed before instrumentTool sees the handler
  assert.match(indexSrc, /instrumentTool\(\s*name\s*,\s*arbiterWrap\(\s*name\s*,/);
});
```

- [ ] **Step 2: Run → fail.** `npm run build && node --test test/unit/gh-202-arbiter-wiring.test.js` → FAIL.

- [ ] **Step 3: Wire it.** In `src/index.ts`, add the import near the other lifecycle imports:
```ts
import { arbiterWrap } from './lifecycle/device-arbiter.js';
```
Then read the current `trackedTool` (the explorer reports it at ~lines 148-150):
```ts
function trackedTool(name: string, desc: string, schema: any, handler: any): void {
  const wrapped = instrumentTool(name, handler as (...args: unknown[]) => Promise<unknown>);
  server.tool(name, desc, schema, wrapped as typeof handler);
}
```
Change the middle line to compose `arbiterWrap` INSIDE `instrumentTool` (so the arbiter lease is held only for the handler's own execution, and a refusal is recorded by instrumentation like any other result):
```ts
function trackedTool(name: string, desc: string, schema: any, handler: any): void {
  const arbitrated = arbiterWrap(name, handler as (...args: unknown[]) => Promise<import('./utils.js').ToolResult>);
  const wrapped = instrumentTool(name, arbitrated as (...args: unknown[]) => Promise<unknown>);
  server.tool(name, desc, schema, wrapped as typeof handler);
}
```
(Confirm `instrumentTool`'s signature in `src/observability/instrumentation.ts` matches `(name, handler) => wrappedHandler`; adapt the casts to compile cleanly if it differs. Do NOT change instrumentTool itself.)

- [ ] **Step 4: Run → pass + full build.** `npm run build && node --test test/unit/gh-202-arbiter-wiring.test.js` → PASS. Then `npm test 2>&1 | tail -6` → full suite green (no regression — every existing tool now passes through `arbiterWrap`, but with no flow ever held in unit tests, all acquires succeed and release).

- [ ] **Step 5: Commit.**
```bash
git add src/index.ts test/unit/gh-202-arbiter-wiring.test.js dist/index.js
git commit -m "feat(arbiter): serialize every MCP tool through the arbiter at trackedTool (#202 Phase 2a)"
```

---

## Task 2b: `cdp_status` reset valve + keep refusals out of FAIL telemetry

The arbiter's only unrecoverable failure is a leaked op-id (a hung handler whose `finally` never ran), which refuses all flows forever. `cdp_status` is unarbitrated, so it's the escape hatch even when a leaked *flow* lease would block `device_snapshot`. Also: a `BUSY_FLOW_ACTIVE` refusal is expected contention, not a tool failure — keep it out of the FAIL telemetry.

**Files:**
- Modify: `scripts/cdp-bridge/src/tools/status.ts` (a `resetArbiter` branch) + `scripts/cdp-bridge/src/index.ts` (cdp_status schema)
- Modify: `scripts/cdp-bridge/src/observability/instrumentation.ts` (classifyResult guard)
- Test: `scripts/cdp-bridge/test/unit/gh-202-arbiter-reset-valve.test.js`

- [ ] **Step 1: Read** `src/tools/status.ts` (the `createStatusHandler(...)` factory + its args type + the early part of the handler) and `src/observability/instrumentation.ts` (`classifyResult` — note how it decides FAIL: per the plan review it returns `'FAIL'` for `{ok:false}`/`isError`).

- [ ] **Step 2: Write the failing test.** Create `test/unit/gh-202-arbiter-reset-valve.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const statusSrc = readFileSync(resolve(__dirname, '../../src/tools/status.ts'), 'utf8');
const indexSrc = readFileSync(resolve(__dirname, '../../src/index.ts'), 'utf8');
const instrSrc = readFileSync(resolve(__dirname, '../../src/observability/instrumentation.ts'), 'utf8');

test('GH#202 cdp_status exposes the arbiter reset escape hatch', () => {
  assert.match(statusSrc, /resetArbiter/);
  assert.match(statusSrc, /arbiter\.reset\(/);
  assert.match(indexSrc, /resetArbiter:\s*z\.boolean\(\)\.optional\(\)/);
});

test('GH#202 a BUSY_FLOW_ACTIVE refusal is not classified as a hard FAIL', () => {
  assert.match(instrSrc, /BUSY_FLOW_ACTIVE/);
});
```

- [ ] **Step 3: Add the reset branch to `cdp_status`.** In `src/tools/status.ts`, import the arbiter:
```ts
import { arbiter } from '../lifecycle/device-arbiter.js';
```
Add `resetArbiter?: boolean` to the handler's args type, and at the TOP of the handler (before the CDP work), handle it:
```ts
    if (args?.resetArbiter) {
      const cleared = arbiter.reset('manual via cdp_status');
      // Still build + return the normal status, but annotate what we cleared.
      const status = await buildStatusResult(client);
      return okResult({ ...status, arbiterReset: cleared });
    }
```
(Adapt to the actual return helper used in this file — `okResult`/`warnResult`. If `buildStatusResult` needs a connected client and there is none, return `okResult({ arbiterReset: cleared })` alone. Read the file and pick the cleanest fit.)

- [ ] **Step 4: Add the schema field.** In `src/index.ts`, on the `cdp_status` registration, add:
```ts
    resetArbiter: z.boolean().optional().describe('Clear a wedged in-memory device arbiter (a leaked plane lease that is refusing all flows). Escape hatch — cdp_status is unarbitrated so it always runs.'),
```

- [ ] **Step 5: Guard the telemetry classifier.** In `src/observability/instrumentation.ts`, in `classifyResult` (or wherever an `{ok:false}`/`isError` result is mapped to `'FAIL'`), add an early guard: if the result envelope carries `code === 'BUSY_FLOW_ACTIVE'`, return the non-failure bucket this file already uses for expected/soft outcomes (e.g. `'WARN'` or `'OK'` — match the existing enum; do NOT invent a new status unless the file already supports one). Read how `classifyResult` accesses the result (it may parse `content[0].text` or read `isError`); thread the code check through the same accessor. **If the code is genuinely not reachable at classify time, leave a one-line comment and treat it as a documented follow-up** — the `failResult` top-level-code fix (Task 1) is the load-bearing correctness change; the telemetry bucket is polish.

- [ ] **Step 6: Build + run.** `npm run build && node --test test/unit/gh-202-arbiter-reset-valve.test.js` → PASS (2). Then `npm test 2>&1 | tail -6` → full suite green.

- [ ] **Step 7: Commit.**
```bash
git add src/tools/status.ts src/index.ts src/observability/instrumentation.ts test/unit/gh-202-arbiter-reset-valve.test.js \
        dist/tools/status.js dist/index.js dist/observability/instrumentation.js
git commit -m "feat(arbiter): cdp_status resetArbiter escape hatch + keep BUSY refusals out of FAIL telemetry (#202 Phase 2a)"
```
(Stage only the `dist/` outputs that actually changed — `git status --short dist`.)

---

## Task 3: `maestro_run` (and every flow tool that shells out) parks L2 + marks CDP stale

A Maestro flow drives the whole device via WDA; the in-tree L2 fast-runner must be parked for its duration, and CDP must reconnect afterward (the flow may relaunch the app). The flow *lease* is already taken by the wrapper (Task 2); this adds the flow-specific side effects. **Three** flow tools shell out to maestro-runner with their OWN `execFile` dispatch and ALL need parking (#202 plan review): `maestro_run`, `maestro_test_all` (`maestro-test-all.ts`), and `cdp_auto_login` (`auto-login.ts`). `runFlowParked` is defined once in `maestro-run.ts` and reused by the other two.

**Files:**
- Modify: `scripts/cdp-bridge/src/tools/maestro-run.ts` (define + export `runFlowParked`; wrap its dispatch)
- Modify: `scripts/cdp-bridge/src/tools/maestro-test-all.ts` (import + wrap its `execFile` dispatch)
- Modify: `scripts/cdp-bridge/src/tools/auto-login.ts` (import + wrap its maestro `execFile` dispatch)
- Test: `scripts/cdp-bridge/test/unit/gh-202-maestro-flow-parks-l2.test.js`

- [ ] **Step 1: Read** `src/tools/maestro-run.ts` — confirm the handler factory `createMaestroRunHandler()` and the `execFile(dispatch.binPath, finalArgs, ...)` dispatch site (the explorer reports ~line 161). Note whether `stopFastRunner` / `markCdpStale` are already imported (they are imported in `repair-action.ts`; likely NOT in `maestro-run.ts`).

- [ ] **Step 2: Write the failing test.** Because the handler shells out to maestro-runner (needs a device), test the EXTRACTED side-effect helper rather than the whole handler. Create `test/unit/gh-202-maestro-flow-parks-l2.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runFlowParked } from '../../dist/tools/maestro-run.js';

test('GH#202 runFlowParked: parks L2 before the flow and marks CDP stale after (success)', async () => {
  const calls = [];
  const out = await runFlowParked(
    async () => { calls.push('flow'); return 'RESULT'; },
    { stopFastRunner: () => calls.push('stop'), markCdpStale: () => calls.push('stale') },
  );
  assert.equal(out, 'RESULT');
  assert.deepEqual(calls, ['stop', 'flow', 'stale']); // park → run → stale
});

test('GH#202 runFlowParked: still marks CDP stale when the flow throws', async () => {
  const calls = [];
  await assert.rejects(
    runFlowParked(
      async () => { calls.push('flow'); throw new Error('boom'); },
      { stopFastRunner: () => calls.push('stop'), markCdpStale: () => calls.push('stale') },
    ),
    /boom/,
  );
  assert.deepEqual(calls, ['stop', 'flow', 'stale']); // stale runs in finally
});
```

- [ ] **Step 3: Run → fail.** `npm run build && node --test test/unit/gh-202-maestro-flow-parks-l2.test.js` → FAIL (`runFlowParked` not exported).

- [ ] **Step 4: Implement.** In `src/tools/maestro-run.ts`, add imports:
```ts
import { stopFastRunner as defaultStopFastRunner } from '../runners/rn-fast-runner-client.js';
import { markCdpStale as defaultMarkCdpStale } from '../cdp/recovery.js';
```
Add the exported helper near the top of the module (after imports):
```ts
export interface FlowParkDeps {
  stopFastRunner?: () => void;
  markCdpStale?: () => void;
}

/**
 * GH#202 Phase 2a: run a Maestro flow with L2 parked. The fast-runner (XCTest)
 * would fight maestro-runner (WDA) for the device, so stop it first; mark CDP
 * stale afterward (always — even on failure) so the next read reconnects to the
 * post-flow app state. The fast-runner lazily restarts on the next device_* call.
 */
export async function runFlowParked<T>(run: () => Promise<T>, deps: FlowParkDeps = {}): Promise<T> {
  const stop = deps.stopFastRunner ?? defaultStopFastRunner;
  const stale = deps.markCdpStale ?? defaultMarkCdpStale;
  stop();
  try {
    return await run();
  } finally {
    stale();
  }
}
```
Then wrap ONLY the maestro-runner `execFile` dispatch in the handler with `runFlowParked`. The current dispatch block is roughly:
```ts
      const { stdout, stderr } = await execFile(dispatch.binPath, finalArgs, { timeout, encoding: 'utf8' });
```
Change it to:
```ts
      const { stdout, stderr } = await runFlowParked(() =>
        execFile(dispatch.binPath, finalArgs, { timeout, encoding: 'utf8' }),
      );
```
(Keep the surrounding success/timeout/catch logic untouched — `runFlowParked` just brackets the `execFile` await. Read the exact lines first; the `execFile` may be inside a `try` whose `catch` reads `err.stdout/stderr` — preserve that; `runFlowParked` rethrows so the catch still fires, and `markCdpStale` runs in its `finally` either way.)

- [ ] **Step 5: Wrap the OTHER two flow tools.** Read `src/tools/maestro-test-all.ts` and `src/tools/auto-login.ts`, find each one's maestro-runner `execFile` dispatch (the explorer reports `maestro-test-all.ts:130` and `auto-login.ts:221`), import the shared helper:
```ts
import { runFlowParked } from './maestro-run.js';
```
and bracket each dispatch the same way — `await runFlowParked(() => execFile(<bin>, <args>, <opts>))` — preserving the surrounding success/catch logic exactly. (If `maestro-test-all` runs MANY flows in a loop, wrap the loop body's per-flow `execFile`, not the whole loop, OR park once before the loop + mark stale once after — pick whichever matches the file's structure and note which you did. The invariant: L2 is parked while any maestro-runner subprocess is executing, and CDP is marked stale after.)

- [ ] **Step 6: Run → pass + regression.** `npm run build && node --test test/unit/gh-202-maestro-flow-parks-l2.test.js test/unit/maestro-run*.test.js test/unit/maestro-test-all*.test.js test/unit/gh-201-*.test.js` → PASS (the #201 + maestro-test-all tests must still pass).

- [ ] **Step 7: Commit.**
```bash
git add src/tools/maestro-run.ts src/tools/maestro-test-all.ts src/tools/auto-login.ts \
        test/unit/gh-202-maestro-flow-parks-l2.test.js
git status --short dist   # stage exactly the rebuilt outputs:
git add dist/tools/maestro-run.js dist/tools/maestro-test-all.js dist/tools/auto-login.js
git commit -m "feat(maestro): park L2 + mark CDP stale around every flow-tool dispatch (#202 Phase 2a)"
```

---

## Task 4: Docs + changeset + full-suite green

**Files:**
- Modify: `CLAUDE.md` (Architecture — describe the arbiter)
- Create: `.changeset/device-arbiter-202-phase2a.md`

- [ ] **Step 1:** In `CLAUDE.md`, near the device-control architecture (after the Phase 1.5 UDID-lock paragraph), add:
```
Since #202 Phase 2a, a process-wide in-memory `DeviceSessionArbiter` (`lifecycle/device-arbiter.ts`) serializes the three planes per MCP call: `flow` (Maestro) is exclusive, `introspection` (CDP reads) + `interaction` (`device_*`) coexist. Every tool passes through `arbiterWrap` at `trackedTool`; a read/tap issued while a Maestro flow runs refuses fast with `BUSY_FLOW_ACTIVE`. Diagnostics (`cdp_status`), connection management, and session-less tools are unarbitrated so they always work — even mid-flow. The lease is in-memory only (persisting it would recreate the #202 orphaned-lock bug). Composite tools call underlying handler functions, not wrapped MCP tools, so one external call takes exactly one lease.
```

- [ ] **Step 2:** Create `.changeset/device-arbiter-202-phase2a.md`:
```markdown
---
"rn-dev-agent-plugin": minor
---

#202 Phase 2a: a process-wide in-memory `DeviceSessionArbiter` now serializes the three device-control planes — `flow` (Maestro) is exclusive; `introspection` (CDP reads) and `interaction` (`device_*`) coexist. A read or tap issued while a Maestro flow is running refuses fast with `BUSY_FLOW_ACTIVE` instead of interleaving with it. `maestro_run` parks the in-tree fast-runner for the flow's duration and marks CDP stale afterward so the next read reconnects. Diagnostics (`cdp_status`), connection management, and session-less tools stay unarbitrated and always work.
```

- [ ] **Step 3:** `cd scripts/cdp-bridge && npm test 2>&1 | tail -8` → full suite green (~1624 + ~11 new = ~1635). Report the tally.

- [ ] **Step 4:** Commit (from repo root):
```bash
git add CLAUDE.md .changeset/device-arbiter-202-phase2a.md
git commit -m "docs(202): document the DeviceSessionArbiter + changeset (Phase 2a)"
```

---

## Self-Review (completed by plan author)

**Spec coverage (spec §5, Phase 2a portion):**
- In-memory singleton, `flowLeaseHeldBy` + `activeOps` → Task 1 (`DeviceSessionArbiter`). ✅
- `tryAcquire(plane)` refuse-fast; introspection+interaction shared, flow exclusive → Task 1 + tests. ✅
- `BUSY_FLOW_ACTIVE` on read/tap during flow → Task 1 (`arbiterWrap`) + Task 2 (wiring). ✅
- `device_*`→interaction, `cdp_*` reads→introspection, `maestro_run`/etc.→flow → Task 1 `TOOL_PLANES`. ✅
- `maestro_run` parks L2 + marks CDP stale → Task 3. ✅
- Lease stays in-memory (no persistence) → Task 1 (no fs). ✅

**Explicitly DEFERRED to Phase 2b (separate plan):** `recoverWedge()` (bounded 1/call, 3/session, reset on open; foreground re-launch + reconnect + runner-health), and the `cdp_status` isPaused → `recoverWedge` hook. The spec's "diagnose foreground via launchctl list" needs refinement (launchctl lists running, not frontmost apps) — 2b will resolve the pragmatic recovery (unconditional re-foreground + runner-health tri-state) and should get its own multi-LLM plan review.

**Placeholder scan:** none. **Type consistency:** `Plane`, `Lease`, `AcquireResult` (`{ok:true,lease}` / `{ok:false,code,holder}`), `DeviceSessionArbiter.tryAcquire/release/snapshot`, `planeForTool(name): Plane|null`, `arbiterWrap(name, handler, inst?)`, `runFlowParked(run, deps?)` are used identically across tasks/tests. ✅

**Key design decisions (worth logging in DECISIONS.md):**
- **Wrapper at `trackedTool`, composed INSIDE `instrumentTool`** — one chokepoint covers all 76 tools incl. future ones; composite tools bypass it (they call handler fns), so no nesting/self-conflict.
- **Refuse-fast, no queue** — a queued device command is stale by the time it runs; the agent retries.
- **`cdp_status` + connection/session-less tools UNARBITRATED** — the health check must work mid-flow; blocking it would hide exactly the state the user needs when a flow looks stuck.
- **Flow exclusivity = `ops.size === 0` AND no flow lease** — a flow waits for in-flight reads/taps to drain (refuse-fast: it returns BUSY and the caller retries once they finish), and vice-versa.

**Amendments applied from the multi-LLM plan review (Gemini + Codex + Claude, 2026-06-03) — source-verified before implementation:**
- **[blocker] leaked-lease permanent wedge** → `reset()` exposed via the unarbitrated `cdp_status({ resetArbiter: true })` (Task 1 + Task 2b). The one in-memory analogue of the #202 orphaned-lock bug, now with its own cure.
- **[blocker] `cdp_auto_login` flow hole** → moved to `FLOW_TOOLS` + parked in Task 3.
- **[blocker] `cdp_reload`/`cdp_restart` unarbitrated mid-flow** → moved to `FLOW_TOOLS` (refused during a flow; leaked-lease recovery goes through the `cdp_status` valve, not restart).
- **[blocker] Task 3 incomplete** → now wraps `maestro_test_all` + `cdp_auto_login` execs, not just `maestro_run`.
- **[blocker] `failResult` signature** → `failResult(msg, res.code, { holder })` so `BUSY_FLOW_ACTIVE` is a top-level `code`; the test now parses the envelope (the old substring match hid the bug).
- **[should-fix] richer holder** → `Map<opId,{plane,tool,startedAt}>` so a refused flow names the blocking op (was `null` for non-flow blockers); enables `reset()` + `snapshot()` diagnostics.
- **[should-fix] telemetry** → `classifyResult` guard so a `BUSY_FLOW_ACTIVE` refusal isn't logged as a hard tool FAIL (Task 2b Step 5; documented-follow-up fallback if the code isn't reachable at classify time).
- **[naming] mutating CDP tools** → `cdp_navigate`/`cdp_dispatch`/`cdp_set_shared_value`/`cdp_mmkv` moved from `introspection` to `interaction` (they are writes; behavior unchanged since both planes are shared, but the taxonomy is now honest).

**Documented gaps / Phase-2 follow-ups (NOT in 2a scope):**
- **`device_batch` background-promise** (Codex, unverified): confirm `device-batch.ts:290` — if a step timeout returns while `executeStep()` keeps running, the lease releases while device work continues, breaking one-call-one-lease. The Task 2 implementer should verify; if real, `device_batch` must await its background work (its own fix).
- **`cdp_status` is not purely read-only** — it calls `handleDevClientPicker()` (device interaction). When a flow lease is held, the `resetArbiter`/health path should skip picker-dismiss side-effects and only report. Follow-up.
- **session-less cross-process gap** — `maestro_run` with an explicit `platform` and no locked device session sits outside Phase 1.5's UDID lock. Follow-up: require a locked session for flow tools, or document.
- **`cdp_restart` action-awareness** — a name-only wrapper can't make `hardReset=true` flow-exclusive but a soft reset shared; 2a blanket-classifies both as `flow`. An args-aware arbiter is a Phase-2 follow-up.
- **`recoverWedge` + `cdp_status` wedge hook** — Phase 2b (separate plan).
