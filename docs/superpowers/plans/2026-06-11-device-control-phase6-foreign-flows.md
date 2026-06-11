# Device Control Phase 6 — Canonical Maestro Surface + Arbiter-Aware Foreign Flows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A detected foreign Maestro session becomes an arbiter input — local L2/L3 tools refuse fast with `BUSY_FOREIGN_FLOW` instead of triggering the ~44 s leak-recovery cascade (#186) — and the plugin's `maestro_run` is declared the canonical Maestro surface after live-gating the two historical escape hatches (#201 `--app-file`, #188 `runFlow`) closed.

**Architecture:** A new `ForeignFlowGate` (TTL-cached async wrapper over the existing `detectIosExternalRunner`, fail-open, sync `lastActive` for handlers) plugs into `arbiterWrap` — the single choke point every arbitrated tool already passes through. Only `interaction` + `flow` planes consult it (L1 introspection stays free by contract); `device_screenshot` keeps its OS-level simctl fallback mid-foreign-flow by OR-ing `foreignFlowGate.lastActive` into its existing `flowActive` routing. The udid comes from the active device session via a setter-injected provider (avoids a device-session ↔ arbiter import cycle). `RN_IOS_FOREIGN_WARN=0` disables both the Phase 3 warning and the new refusal.

**Tech Stack:** TypeScript (Node >= 22, ESM), `node --test` against `dist/`, live gates on the booted simulator, changesets.

**Spec:** `docs/superpowers/specs/2026-06-10-device-control-phase4-6-rethink-design.md` §3.
**Branch:** `feat/202-phase6-foreign-flows` off `origin/main` (local `main` is owned by another worktree — `git checkout -b feat/202-phase6-foreign-flows origin/main`).

**Workflow reminder (repo standard):** run the multi-LLM plan review (`/brainstorm` with this plan + `device-arbiter.ts` + `external-runner-detect.ts`) BEFORE Task 1; amend with findings. TDD per task; small signed commits; changeset; live gates before PR.

---

## Verified current state (read before estimating)

- `DeviceSessionArbiter` + `arbiterWrap` live in `scripts/cdp-bridge/src/lifecycle/device-arbiter.ts`. `arbiterWrap(name, handler, inst)` returns the handler unwrapped for unarbitrated tools, refuses `BUSY_FLOW_ACTIVE` otherwise, and has a `FLOW_FALLBACK_TOOLS` unleased path (`device_screenshot`). Plane sets: `FLOW_TOOLS` (incl. `cdp_reload`/`cdp_restart`), `INTERACTION_TOOLS`, `INTROSPECTION_TOOLS`.
- `detectIosExternalRunner(execFileImpl?, udid?)` in `src/runners/external-runner-detect.ts` returns `IosExternalRunnerWarning | null`; ~2 s `ps` scan; UDID scoping essential (idle maestro-mcp has no UDID). Existing call sites: `status.ts:69`, `device-session.ts:332` (both informational).
- `device_screenshot` routes via `chooseScreenshotPath({ flowActive: arbiter.flowActive, platform })` in `src/tools/device-list.ts:247`.
- **#201 is already implemented**: `maestro-run.ts:190` resolves `--app-file` via `resolveAppFileForClearState`; `runFlow` is already in the validator allowlist (`src/domain/maestro-validator.ts:121`, GH #186/#188). Phase 6(a) is *verification + closing #201*, not implementation.
- `getActiveSession()` from `src/tools/device-session.ts` exposes `{ platform, deviceId }`.

## File map

| File | Action | Responsibility |
|---|---|---|
| `scripts/cdp-bridge/src/lifecycle/foreign-flow-gate.ts` | Create | `ForeignFlowGate` (TTL cache, fail-open, `lastActive`), singleton, udid-provider setter, enable-knob logic |
| `scripts/cdp-bridge/src/lifecycle/device-arbiter.ts` | Modify | foreign check in `arbiterWrap` for interaction/flow planes; `BUSY_FOREIGN_FLOW` refusal |
| `scripts/cdp-bridge/src/tools/device-list.ts` (~line 247) | Modify | screenshot routing ORs `foreignFlowGate.lastActive` |
| `scripts/cdp-bridge/src/index.ts` | Modify | register the udid provider (one line after imports wiring) |
| `scripts/cdp-bridge/test/unit/gh-186-foreign-flow-gate.test.js` | Create | gate unit tests |
| `scripts/cdp-bridge/test/unit/gh-186-arbiter-foreign.test.js` | Create | arbiterWrap foreign-refusal tests |
| `scripts/cdp-bridge/eval/gate-186-escape-hatches.mjs` + `eval/gate-186-foreign-refusal.mjs` | Create (gitignored) | live gates |
| `CLAUDE.md`, `docs-site/.../guides/maestro-interop.mdx`, `docs-site/.../architecture.mdx` | Modify | canonical surface + BUSY_FOREIGN_FLOW + knob semantics |
| `.changeset/phase6-foreign-flows.md` | Create | release note |

Engineer notes: unit tests import from `dist/` (`npm run build` first; `npm test` = build + unit). House rules: explicit type imports, comments only for constraints, fail-open on infra errors, `meta.timings_ms` on new steps.

---

### Task 1: `ForeignFlowGate` — TTL-cached, fail-open detection wrapper

**Files:**
- Create: `scripts/cdp-bridge/src/lifecycle/foreign-flow-gate.ts`
- Test: `scripts/cdp-bridge/test/unit/gh-186-foreign-flow-gate.test.js`

- [ ] **Step 1: Write the failing tests**

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ForeignFlowGate } from '../../dist/lifecycle/foreign-flow-gate.js';

const WARNING = { platform: 'ios', code: 'IOS_XCUITEST_COMPETITOR', message: 'foreign maestro', processLines: ['1 maestro-driver'] };

test('GH#186 gate: detection result is cached within the TTL (one scan per window)', async () => {
  let t = 0; let scans = 0;
  const gate = new ForeignFlowGate({ detect: async () => { scans += 1; return WARNING; }, ttlMs: 5000, now: () => t });
  const r1 = await gate.check('UDID-A');
  assert.equal(r1.active, true);
  assert.equal(r1.fromCache, false);
  t += 4000;
  const r2 = await gate.check('UDID-A');
  assert.equal(r2.active, true);
  assert.equal(r2.fromCache, true);
  assert.equal(scans, 1);
  t += 2000;                                            // 6000 > ttl → rescan
  await gate.check('UDID-A');
  assert.equal(scans, 2);
});

test('GH#186 gate: a different udid busts the cache', async () => {
  let scans = 0;
  const gate = new ForeignFlowGate({ detect: async () => { scans += 1; return null; }, ttlMs: 5000, now: () => 0 });
  await gate.check('UDID-A');
  await gate.check('UDID-B');
  assert.equal(scans, 2);
});

test('GH#186 gate: detector error fails OPEN (active=false), error never escapes', async () => {
  const gate = new ForeignFlowGate({ detect: async () => { throw new Error('ps timeout'); }, ttlMs: 5000, now: () => 0 });
  const r = await gate.check('UDID-A');
  assert.equal(r.active, false);
  assert.equal(gate.lastActive, false);
});

test('GH#186 gate: lastActive is a sync mirror of the latest check (for handler routing)', async () => {
  let result = WARNING;
  let t = 0;
  const gate = new ForeignFlowGate({ detect: async () => result, ttlMs: 5000, now: () => t });
  assert.equal(gate.lastActive, false, 'never checked → false');
  await gate.check('UDID-A');
  assert.equal(gate.lastActive, true);
  result = null;
  t += 6000;
  await gate.check('UDID-A');
  assert.equal(gate.lastActive, false);
});

test('GH#186 gate: scanMs is reported for fresh scans', async () => {
  let t = 0;
  const gate = new ForeignFlowGate({ detect: async () => { t += 17; return null; }, ttlMs: 5000, now: () => t });
  const r = await gate.check('UDID-A');
  assert.equal(r.scanMs, 17);
});

test('GH#186 gate: concurrent checks share one in-flight scan (no thundering herd)', async () => {
  let scans = 0;
  let release;
  const gate = new ForeignFlowGate({
    detect: () => { scans += 1; return new Promise((r) => { release = () => r(null); }); },
    ttlMs: 5000,
    now: () => 0,
  });
  const p1 = gate.check('UDID-A');
  const p2 = gate.check('UDID-A');
  release();
  await Promise.all([p1, p2]);
  assert.equal(scans, 1);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/gh-186-foreign-flow-gate.test.js`
Expected: FAIL — missing module `dist/lifecycle/foreign-flow-gate.js`

- [ ] **Step 3: Implement** — create `src/lifecycle/foreign-flow-gate.ts`:

```typescript
import { detectIosExternalRunner } from '../runners/external-runner-detect.js';
import type { IosExternalRunnerWarning } from '../runners/external-runner-detect.js';

export interface ForeignCheckResult {
  active: boolean;
  warning: IosExternalRunnerWarning | null;
  fromCache: boolean;
  scanMs: number;
}

interface ForeignFlowGateDeps {
  detect?: (udid: string) => Promise<IosExternalRunnerWarning | null>;
  ttlMs?: number;
  now?: () => number;
}

/**
 * GH#186 / #202 Phase 6: TTL-cached wrapper over detectIosExternalRunner so
 * the per-call arbiter check costs one `ps` scan per window, not per tool
 * call. Fail-open by contract: a detector error reads as "no foreign flow" —
 * the gate must never block a session on infra trouble. `lastActive` is a
 * sync mirror for handlers that route by it (device_screenshot's simctl
 * fallback), same pattern as arbiter.flowActive.
 */
export class ForeignFlowGate {
  private readonly detect: (udid: string) => Promise<IosExternalRunnerWarning | null>;
  private readonly ttlMs: number;
  private readonly now: () => number;

  private cachedAt = -Infinity;
  private cachedUdid: string | null = null;
  private cached: IosExternalRunnerWarning | null = null;
  private inFlight: Promise<ForeignCheckResult> | null = null;
  private _lastActive = false;

  constructor(deps: ForeignFlowGateDeps = {}) {
    this.detect = deps.detect ?? ((udid) => detectIosExternalRunner(undefined, udid));
    this.ttlMs = deps.ttlMs ?? 5_000;
    this.now = deps.now ?? Date.now;
  }

  get lastActive(): boolean {
    return this._lastActive;
  }

  async check(udid: string): Promise<ForeignCheckResult> {
    const t = this.now();
    if (this.cachedUdid === udid && t - this.cachedAt < this.ttlMs) {
      return { active: this.cached !== null, warning: this.cached, fromCache: true, scanMs: 0 };
    }
    if (this.inFlight) return this.inFlight;
    this.inFlight = (async (): Promise<ForeignCheckResult> => {
      const started = this.now();
      let warning: IosExternalRunnerWarning | null = null;
      try {
        warning = await this.detect(udid);
      } catch {
        warning = null;
      }
      this.cached = warning;
      this.cachedUdid = udid;
      this.cachedAt = this.now();
      this._lastActive = warning !== null;
      return { active: warning !== null, warning, fromCache: false, scanMs: this.now() - started };
    })();
    try {
      return await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }
}

export const foreignFlowGate = new ForeignFlowGate();

/** udid provider, registered from index.ts — a direct getActiveSession import
 * here would create a device-session ↔ arbiter module cycle. Returns the
 * active iOS session's udid, or null when there is no iOS session (the gate
 * is iOS-only; unscoped detection false-positives on idle maestro-mcp). */
let udidProvider: () => string | null = () => null;

export function setForeignGateUdidProvider(fn: () => string | null): void {
  udidProvider = fn;
}

export function foreignGateUdid(): string | null {
  return udidProvider();
}

export function foreignGateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.RN_IOS_FOREIGN_WARN !== '0';
}
```

- [ ] **Step 4: Run to verify pass** — same command, expect PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/cdp-bridge/src/lifecycle/foreign-flow-gate.ts scripts/cdp-bridge/test/unit/gh-186-foreign-flow-gate.test.js
git commit -m "feat(#186): ForeignFlowGate — TTL-cached fail-open foreign-maestro detection"
```

---

### Task 2: Foreign-aware `arbiterWrap` — `BUSY_FOREIGN_FLOW` fast refusal

**Files:**
- Modify: `scripts/cdp-bridge/src/lifecycle/device-arbiter.ts`
- Modify: `scripts/cdp-bridge/src/index.ts` (provider registration)
- Test: `scripts/cdp-bridge/test/unit/gh-186-arbiter-foreign.test.js`

- [ ] **Step 1: Write the failing tests**

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { DeviceSessionArbiter, arbiterWrap } from '../../dist/lifecycle/device-arbiter.js';
import { ForeignFlowGate } from '../../dist/lifecycle/foreign-flow-gate.js';

const WARNING = { platform: 'ios', code: 'IOS_XCUITEST_COMPETITOR', message: 'foreign maestro flow on this simulator', processLines: ['77 maestro-driver-iosUITests-Runner'] };
const okHandler = async () => ({ content: [{ type: 'text', text: '{"ok":true}' }] });

function foreignOpts(over = {}) {
  return {
    gate: new ForeignFlowGate({ detect: async () => WARNING, ttlMs: 5000, now: () => 0 }),
    getUdid: () => 'UDID-A',
    enabled: () => true,
    ...over,
  };
}

test('GH#186 arbiter: interaction tool refuses BUSY_FOREIGN_FLOW when a foreign flow is live', async () => {
  const inst = new DeviceSessionArbiter();
  const wrapped = arbiterWrap('device_press', okHandler, inst, foreignOpts());
  const res = await wrapped({});
  const body = JSON.parse(res.content[0].text);
  assert.equal(body.ok, false);
  assert.equal(body.code, 'BUSY_FOREIGN_FLOW');
  assert.match(body.error, /foreign/i);
  assert.match(body.error, /cdp_component_tree|introspection|L1/i, 'message points at the safe L1 alternatives');
  assert.match(body.error, /RN_IOS_FOREIGN_WARN/, 'message names the opt-out');
  assert.equal(inst.snapshot.activeOps, 0, 'no lease was taken');
});

test('GH#186 arbiter: flow tool (maestro_run) refuses the same way', async () => {
  const inst = new DeviceSessionArbiter();
  const wrapped = arbiterWrap('maestro_run', okHandler, inst, foreignOpts());
  const body = JSON.parse((await wrapped({})).content[0].text);
  assert.equal(body.code, 'BUSY_FOREIGN_FLOW');
});

test('GH#186 arbiter: introspection (L1) tools NEVER consult the gate', async () => {
  let scans = 0;
  const gate = new ForeignFlowGate({ detect: async () => { scans += 1; return WARNING; }, ttlMs: 5000, now: () => 0 });
  const inst = new DeviceSessionArbiter();
  const wrapped = arbiterWrap('cdp_store_state', okHandler, inst, foreignOpts({ gate }));
  const body = JSON.parse((await wrapped({})).content[0].text);
  assert.equal(body.ok, true);
  assert.equal(scans, 0);
});

test('GH#186 arbiter: no iOS session (getUdid null) skips detection entirely', async () => {
  let scans = 0;
  const gate = new ForeignFlowGate({ detect: async () => { scans += 1; return WARNING; }, ttlMs: 5000, now: () => 0 });
  const inst = new DeviceSessionArbiter();
  const wrapped = arbiterWrap('device_press', okHandler, inst, foreignOpts({ gate, getUdid: () => null }));
  const body = JSON.parse((await wrapped({})).content[0].text);
  assert.equal(body.ok, true);
  assert.equal(scans, 0);
});

test('GH#186 arbiter: RN_IOS_FOREIGN_WARN=0 disables the refusal', async () => {
  const inst = new DeviceSessionArbiter();
  const wrapped = arbiterWrap('device_press', okHandler, inst, foreignOpts({ enabled: () => false }));
  const body = JSON.parse((await wrapped({})).content[0].text);
  assert.equal(body.ok, true);
});

test('GH#186 arbiter: our OWN flow lease skips the foreign check (a detected driver is then our own L3 run)', async () => {
  let scans = 0;
  const gate = new ForeignFlowGate({ detect: async () => { scans += 1; return WARNING; }, ttlMs: 5000, now: () => 0 });
  const inst = new DeviceSessionArbiter();
  const flowLease = inst.tryAcquire('flow', 'maestro_run');
  assert.equal(flowLease.ok, true);
  const wrapped = arbiterWrap('device_press', okHandler, inst, foreignOpts({ gate }));
  const body = JSON.parse((await wrapped({})).content[0].text);
  assert.equal(body.code, 'BUSY_FLOW_ACTIVE', 'local-flow refusal wins, no foreign scan');
  assert.equal(scans, 0);
});

test('GH#186 arbiter: no foreign flow → normal lease + handler runs', async () => {
  const gate = new ForeignFlowGate({ detect: async () => null, ttlMs: 5000, now: () => 0 });
  const inst = new DeviceSessionArbiter();
  const wrapped = arbiterWrap('device_press', okHandler, inst, foreignOpts({ gate }));
  const body = JSON.parse((await wrapped({})).content[0].text);
  assert.equal(body.ok, true);
  assert.equal(inst.snapshot.activeOps, 0, 'lease released after the handler');
});

test('GH#186 arbiter: refusal extras carry the warning detail + scan timing', async () => {
  const inst = new DeviceSessionArbiter();
  const wrapped = arbiterWrap('device_press', okHandler, inst, foreignOpts());
  const body = JSON.parse((await wrapped({})).content[0].text);
  assert.equal(body.foreignRunner.code, 'IOS_XCUITEST_COMPETITOR');
  assert.ok('foreignScan' in (body.meta?.timings_ms ?? {}), 'meta.timings_ms.foreignScan present');
});

// index.ts wiring pin (repo pattern: source-text assertion, cf. gh-202-kill-legacy-wiring)
const indexSrc = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../src/index.ts'), 'utf8');

test('GH#186 index.ts registers the foreign-gate udid provider from the active session', () => {
  assert.match(indexSrc, /setForeignGateUdidProvider\(/);
});
```

- [ ] **Step 2: Run to verify failure** — `npm run build && node --test test/unit/gh-186-arbiter-foreign.test.js` → FAIL (`arbiterWrap` takes no 4th argument; missing exports).

- [ ] **Step 3: Implement** in `src/lifecycle/device-arbiter.ts`:

(a) Add imports:

```typescript
import { foreignFlowGate, foreignGateUdid, foreignGateEnabled } from './foreign-flow-gate.js';
import type { ForeignFlowGate } from './foreign-flow-gate.js';
import type { IosExternalRunnerWarning } from '../runners/external-runner-detect.js';
```

(b) Add the refusal builder + options interface (below `FLOW_FALLBACK_TOOLS`):

```typescript
export interface ForeignGateOpts {
  gate?: ForeignFlowGate;
  getUdid?: () => string | null;
  enabled?: () => boolean;
}

function foreignRefusal(name: string, warning: IosExternalRunnerWarning, scanMs: number): ToolResult {
  return failResult(
    `Refusing ${name}: a FOREIGN Maestro/XCUITest session is driving this simulator ` +
    `(${warning.processLines[0] ?? 'detected via ps'}). L1 introspection stays safe — use ` +
    `cdp_component_tree / cdp_store_state / cdp_navigation_state for reads, and device_screenshot ` +
    `for pixels (simctl fallback). Retry taps/flows after the foreign run completes. ` +
    `Opt out of this guard with RN_IOS_FOREIGN_WARN=0.`,
    'BUSY_FOREIGN_FLOW',
    { foreignRunner: warning, conflict: true, meta: { timings_ms: { foreignScan: scanMs } } },
  );
}
```

(c) Extend `arbiterWrap` — full replacement of the function (the new 4th parameter defaults preserve every existing call site):

```typescript
export function arbiterWrap(
  name: string,
  handler: (...args: unknown[]) => Promise<ToolResult>,
  inst: DeviceSessionArbiter = arbiter,
  foreign: ForeignGateOpts = {},
): (...args: unknown[]) => Promise<ToolResult> {
  const plane = planeForTool(name);
  if (plane === null) return handler;
  const gate = foreign.gate ?? foreignFlowGate;
  const getUdid = foreign.getUdid ?? foreignGateUdid;
  const enabled = foreign.enabled ?? foreignGateEnabled;
  return async (...args: unknown[]): Promise<ToolResult> => {
    // GH#186 Phase 6: a foreign Maestro session is an external flow-plane
    // holder. Checked for interaction/flow planes only (L1 reads never
    // conflict — the three-layer contract), only with an iOS session (an
    // unscoped scan false-positives on idle maestro-mcp), and only when no
    // LOCAL flow lease exists (a detected driver is then our own L3 run —
    // the plain BUSY_FLOW_ACTIVE refusal below already covers contenders).
    if (plane !== 'introspection' && !inst.flowActive && enabled()) {
      const udid = getUdid();
      if (udid !== null) {
        const check = await gate.check(udid);
        if (check.active && check.warning) {
          if (FLOW_FALLBACK_TOOLS.has(name)) {
            // Same OS-level fallback contract as a local flow: pixels stay
            // available via simctl (the handler routes by gate.lastActive).
            return await handler(...args);
          }
          return foreignRefusal(name, check.warning, check.scanMs);
        }
      }
    }
    const res = inst.tryAcquire(plane, name);
    if (!res.ok) {
      if (FLOW_FALLBACK_TOOLS.has(name) && inst.flowActive) {
        return await handler(...args);
      }
      const who = res.holder ? `${res.holder.tool} (${res.holder.plane})` : 'a Maestro flow';
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

NOTE the ordering deliberately checks `inst.flowActive` BEFORE scanning: with our own flow lease held, contenders get the existing `BUSY_FLOW_ACTIVE` from `tryAcquire` (test 6 above pins this — the gate is never consulted).

(d) In `src/index.ts`, next to the other lifecycle wiring (after the imports; before `main()`), register the provider:

```typescript
import { setForeignGateUdidProvider } from './lifecycle/foreign-flow-gate.js';
import { getActiveSession } from './tools/device-session.js';

setForeignGateUdidProvider(() => {
  const s = getActiveSession();
  return s?.platform === 'ios' && s.deviceId ? s.deviceId : null;
});
```

(`getActiveSession` is already imported in index.ts — check before adding a duplicate import; merge into the existing import statement if present.)

- [ ] **Step 4: Run** — targeted file PASS (9 tests), then `npm test` → all green. If any pre-existing arbiter test breaks: the 4th parameter is optional and defaults to module singletons whose `getUdid` returns null until a session opens, so existing tests (no session) skip the gate — they should pass unchanged. Investigate any failure rather than papering over it.

- [ ] **Step 5: Commit**

```bash
git add scripts/cdp-bridge/src/lifecycle/device-arbiter.ts scripts/cdp-bridge/src/index.ts scripts/cdp-bridge/test/unit/gh-186-arbiter-foreign.test.js
git commit -m "feat(#186): BUSY_FOREIGN_FLOW — foreign maestro session refuses L2/L3 fast at the arbiter"
```

---

### Task 3: `device_screenshot` simctl fallback mid-foreign-flow

**Files:**
- Modify: `scripts/cdp-bridge/src/tools/device-list.ts` (~line 247)
- Test: `scripts/cdp-bridge/test/unit/gh-186-arbiter-foreign.test.js` (append)

- [ ] **Step 1: Write the failing test** — append:

```javascript
test('GH#186 screenshot routing treats a foreign flow like a local one (simctl path)', () => {
  const srcPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/tools/device-list.ts');
  const listSrc = readFileSync(srcPath, 'utf8');
  assert.match(listSrc, /flowActive:\s*arbiter\.flowActive\s*\|\|\s*foreignFlowGate\.lastActive/);
});
```

(`chooseScreenshotPath` itself is already unit-tested for `flowActive: true` → `'simctl'` in `gh-210-arbiter-screenshot.test.js`; this pins the OR-wiring. Run to see it FAIL.)

- [ ] **Step 2: Implement** — in `src/tools/device-list.ts`, add the import and change line ~247:

```typescript
import { foreignFlowGate } from '../lifecycle/foreign-flow-gate.js';
```

```typescript
  const route = chooseScreenshotPath({ flowActive: arbiter.flowActive || foreignFlowGate.lastActive, platform: args.platform ?? null });
```

(If other `arbiter.flowActive` consultations exist in the same handler — e.g. the `{ flowActive: true }` extras at line ~255 — leave them; only the ROUTING input changes.)

- [ ] **Step 3: Run** — targeted test PASS; `npm test` all green.

- [ ] **Step 4: Commit**

```bash
git add scripts/cdp-bridge/src/tools/device-list.ts scripts/cdp-bridge/test/unit/gh-186-arbiter-foreign.test.js
git commit -m "feat(#186): screenshot keeps its simctl fallback during a foreign flow"
```

---

### Task 4: Live gate (a) — verify the two escape hatches are closed, then close #201

**Files:**
- Create: `scripts/cdp-bridge/eval/gate-186-escape-hatches.mjs` (gitignored, local-only)

Preconditions: booted simulator with the workspace test-app installed, Metro running from the workspace, app attached (deep-link via `xcrun simctl openurl <udid> "com.rndevagent.testapp://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081"` if the dev-launcher shows).

- [ ] **Step 1: Write the gate** — drives the REAL MCP server (supervisor entry) over stdio JSON-RPC:

```javascript
#!/usr/bin/env node
// Live gate for #186(a): the two historical reasons to LEAVE the plugin's
// maestro surface are closed — (1) clearState on iOS auto-resolves --app-file
// (#201, shipped in #205); (2) saved actions using runFlow replay through
// cdp_run_action (#188 allowlist). PASS = both run through plugin tools with
// no raw-CLI escape.
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const sup = spawn(process.execPath, [new URL('../dist/supervisor.js', import.meta.url).pathname, '--no-lock'], { stdio: ['pipe', 'pipe', 'inherit'] });
let buf = ''; const waiters = [];
sup.stdout.on('data', (c) => {
  buf += c.toString('utf8');
  const parts = buf.split('\n'); buf = parts.pop() ?? '';
  for (const p of parts) if (p.length) waiters.shift()?.(JSON.parse(p));
});
const nextMsg = (ms = 240_000) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('timeout')), ms);
  waiters.push((m) => { clearTimeout(t); res(m); });
});
let id = 0;
const call = async (name, args = {}) => {
  sup.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }) + '\n');
  const m = await nextMsg();
  return JSON.parse(m.result?.content?.[0]?.text ?? '{}');
};
sup.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'gate186a', version: '0' } } }) + '\n');
await nextMsg();
sup.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

const udid = execFileSync('xcrun', ['simctl', 'list', 'devices', 'booted', '-j'], { encoding: 'utf8' }).match(/"udid"\s*:\s*"([A-F0-9-]+)"/)?.[1];
if (!udid) { console.error('GATE FAIL: no booted simulator'); process.exit(1); }

// (1) clearState flow through maestro_run — iOS requires --app-file (#201)
const tmp = mkdtempSync(join(tmpdir(), 'gate186-'));
const clearFlow = join(tmp, 'clearstate.yaml');
writeFileSync(clearFlow, `appId: com.rndevagent.testapp\n---\n- clearState\n- launchApp\n`);
const r1 = await call('maestro_run', { flowFile: clearFlow, platform: 'ios' });
if (r1.ok !== true) { console.error(`GATE FAIL (#201): clearState flow failed: ${JSON.stringify(r1).slice(0, 300)}`); process.exit(1); }
console.log('PASS #201: clearState flow ran via maestro_run (auto --app-file)');

// (2) runFlow-bearing flow through the SAME validator cdp_run_action uses
const runFlowFlow = join(tmp, 'runflow.yaml');
writeFileSync(runFlowFlow, `appId: com.rndevagent.testapp\n---\n- launchApp\n- runFlow:\n    when:\n      visible: "Definitely Not Present 12345"\n    commands:\n      - back\n`);
const r2 = await call('maestro_run', { flowFile: runFlowFlow, platform: 'ios' });
if (r2.ok !== true) { console.error(`GATE FAIL (#188): runFlow flow failed: ${JSON.stringify(r2).slice(0, 300)}`); process.exit(1); }
console.log('PASS #188: runFlow conditional ran through the plugin validator');

rmSync(tmp, { recursive: true, force: true });
console.log('GATE PASS: both escape hatches closed — plugin surface is sufficient');
sup.kill('SIGTERM');
```

- [ ] **Step 2: Run** — `cd scripts/cdp-bridge && npm run build && node eval/gate-186-escape-hatches.mjs` → `GATE PASS`. If `cdp_run_action`-specific behavior is in doubt, note both paths share `maestro-validator.ts` — the validator is the gate #186 reported; record that in the PR body.

- [ ] **Step 3: Close #201** with the gate transcript:

```bash
gh issue close 201 --repo Lykhoyda/rn-dev-agent --comment "Verified closed by the Phase 6 live gate: a clearState:true iOS flow runs end-to-end through maestro_run with --app-file auto-resolved (shipped in #205, resolve-ios-app-file.ts). Gate transcript in PR (Phase 6). No raw-CLI escape needed."
```

Nothing to commit (eval/ is gitignored); paste the transcript into the PR body at Task 7.

---

### Task 5: Live gate (b) — foreign-flow refusal end-to-end

**Files:**
- Create: `scripts/cdp-bridge/eval/gate-186-foreign-refusal.mjs` (gitignored, local-only)

- [ ] **Step 1: Write the gate.** Deterministic foreign-process trick: the detector matches `/maestro|WebDriverAgent/i` + udid in `ps` command lines — a sleeping script whose PATH contains both tokens satisfies it without running real Maestro:

```javascript
#!/usr/bin/env node
// Live gate for #186(b): with a (simulated) foreign maestro session bound to
// the booted simulator's UDID, L2/L3 refuse fast with BUSY_FOREIGN_FLOW,
// L1 reads keep working, device_screenshot serves pixels via simctl.
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const udid = execFileSync('xcrun', ['simctl', 'list', 'devices', 'booted', '-j'], { encoding: 'utf8' }).match(/"udid"\s*:\s*"([A-F0-9-]+)"/)?.[1];
if (!udid) { console.error('GATE FAIL: no booted simulator'); process.exit(1); }

// Plant the fake foreign runner: argv carries "maestro-driver-iosUITests-Runner" AND the UDID.
const dir = join(tmpdir(), `maestro-driver-iosUITests-Runner-${udid}`);
mkdirSync(dir, { recursive: true });
const script = join(dir, 'maestro-driver-iosUITests-Runner.sh');
writeFileSync(script, '#!/bin/sh\nsleep 300\n');
chmodSync(script, 0o755);
const foreign = spawn(script, [], { stdio: 'ignore' });
console.log(`planted fake foreign runner pid ${foreign.pid} (argv contains maestro token + ${udid})`);

const sup = spawn(process.execPath, [new URL('../dist/supervisor.js', import.meta.url).pathname, '--no-lock'], { stdio: ['pipe', 'pipe', 'inherit'] });
let buf = ''; const waiters = [];
sup.stdout.on('data', (c) => {
  buf += c.toString('utf8');
  const parts = buf.split('\n'); buf = parts.pop() ?? '';
  for (const p of parts) if (p.length) waiters.shift()?.(JSON.parse(p));
});
const nextMsg = (ms = 180_000) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('timeout')), ms);
  waiters.push((m) => { clearTimeout(t); res(m); });
});
let id = 0;
const call = async (name, args = {}) => {
  sup.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }) + '\n');
  return JSON.parse((await nextMsg()).result?.content?.[0]?.text ?? '{}');
};
const cleanup = () => { foreign.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }); sup.kill('SIGTERM'); };

sup.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'gate186b', version: '0' } } }) + '\n');
await nextMsg();
sup.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

// open an iOS device session so the gate has a udid
const open = await call('device_snapshot', { action: 'open', appId: 'com.rndevagent.testapp', platform: 'ios' });
if (open.ok !== true) { console.error(`GATE FAIL: device-open failed: ${JSON.stringify(open).slice(0, 200)}`); cleanup(); process.exit(1); }

// L2 must refuse fast
const t0 = Date.now();
const press = await call('device_press', { ref: '@nonexistent' });
const refuseMs = Date.now() - t0;
if (press.code !== 'BUSY_FOREIGN_FLOW') { console.error(`GATE FAIL: device_press returned ${press.code ?? 'ok'} — expected BUSY_FOREIGN_FLOW`); cleanup(); process.exit(1); }
console.log(`PASS: device_press refused BUSY_FOREIGN_FLOW in ${refuseMs}ms (vs the ~44s cascade in #186)`);

// L1 stays free
const tree = await call('cdp_component_tree', { testID: 'whatever', maxDepth: 1 });
if (tree.code === 'BUSY_FOREIGN_FLOW') { console.error('GATE FAIL: L1 read was blocked'); cleanup(); process.exit(1); }
console.log('PASS: cdp_component_tree (L1) unaffected');

// screenshot serves pixels via simctl
const shot = await call('device_screenshot', {});
if (shot.ok !== true) { console.error(`GATE FAIL: screenshot failed mid-foreign-flow: ${JSON.stringify(shot).slice(0, 200)}`); cleanup(); process.exit(1); }
console.log('PASS: device_screenshot served via simctl fallback');

// kill the foreign runner → after the TTL the next tap goes through
foreign.kill('SIGKILL');
await new Promise((r) => setTimeout(r, 6000));          // > 5s TTL
const press2 = await call('device_press', { text: 'Home', exact: false });
if (press2.code === 'BUSY_FOREIGN_FLOW') { console.error('GATE FAIL: refusal did not clear after the foreign runner died'); cleanup(); process.exit(1); }
console.log('PASS: refusal cleared within one TTL window after the foreign session ended');

cleanup();
console.log('GATE PASS: foreign-flow arbitration end-to-end');
```

- [ ] **Step 2: Run** — `node eval/gate-186-foreign-refusal.mjs` → `GATE PASS`. Record the transcript (especially the refusal latency vs #186's ~44 s) for the PR body.

---

### Task 6: Docs + changeset — declare the canonical surface

**Files:**
- Modify: `CLAUDE.md` (three-layer contract section + troubleshooting)
- Modify: `docs-site/src/content/docs/guides/maestro-interop.mdx`, `docs-site/src/content/docs/architecture.mdx`
- Create: `.changeset/phase6-foreign-flows.md`

- [ ] **Step 1: CLAUDE.md** — in the "Three-layer device-control contract" section, replace the **Coexistence rule** paragraph with:

```markdown
**Coexistence rule:** L1 reads never conflict with a foreign runner; L2 re-attaches rather than evicts; L3 owns the device. Since #202 Phase 6 (#186), a detected foreign Maestro session is an **arbiter input**, not just a warning: while it is live (UDID-scoped, 5 s-TTL `ps` scan, fail-open), local L2 `device_*` and L3 flow tools refuse fast with `BUSY_FOREIGN_FLOW` — instead of the ~44 s runner-leak cascade — while L1 reads stay free and `device_screenshot` serves pixels via its simctl fallback. The plugin's `maestro_run` is the **canonical** Maestro surface (it participates in the arbiter, parks the L2 runner, marks CDP stale, auto-repairs actions); the standalone maestro-mcp coexists for ad-hoc use and is refused against rather than collided with mid-flow. `RN_IOS_FOREIGN_WARN=0` disables BOTH the device-open warning and the refusal (one knob; name kept for back-compat).
```

- [ ] **Step 2: CLAUDE.md troubleshooting** — add after the Phase 5 row:

```markdown
- **`BUSY_FOREIGN_FLOW` on device_*/maestro_run** → A foreign Maestro/XCUITest session (e.g. standalone maestro-mcp) is driving the same simulator. By design (#186): wait for it to finish (the guard clears within ~5 s of the foreign run ending), use L1 reads (`cdp_component_tree`, `cdp_store_state`) and `device_screenshot` meanwhile, or disable the guard with `RN_IOS_FOREIGN_WARN=0`.
```

- [ ] **Step 3: docs-site** — `guides/maestro-interop.mdx`: update the "what happens on collision" guidance to describe the fast refusal (was: reactive reacquire only) and declare `maestro_run` canonical; `architecture.mdx`: extend the three-layer contract paragraph with the same coexistence-rule sentence. Match each page's existing voice; keep it to one short paragraph per page.

- [ ] **Step 4: Changeset** — `.changeset/phase6-foreign-flows.md`:

```markdown
---
"rn-dev-agent-cdp": minor
"rn-dev-agent-plugin": minor
---

#202 Phase 6 / #186 — foreign Maestro sessions become arbiter refusals; plugin maestro_run is the canonical surface.

While a foreign Maestro/XCUITest session drives the target simulator (UDID-scoped detection, 5 s TTL, fail-open), local `device_*` and flow tools refuse fast with `BUSY_FOREIGN_FLOW` — pointing at the safe L1 reads — instead of colliding into the ~44 s runner-leak cascade. L1 introspection stays free; `device_screenshot` serves pixels via its simctl fallback. The two historical reasons to leave the plugin surface (iOS `clearState` `--app-file`, `runFlow` actions) are live-gate-verified closed; #201 closed. `RN_IOS_FOREIGN_WARN=0` disables both the warning and the refusal.
```

- [ ] **Step 5: Build docs-site** — `cd docs-site && npm run build` → success.

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md docs-site/src/content/docs/guides/maestro-interop.mdx docs-site/src/content/docs/architecture.mdx .changeset/phase6-foreign-flows.md
git commit -m "docs(#186): canonical maestro surface + BUSY_FOREIGN_FLOW coexistence rule"
```

---

### Task 7: Full verification + dist + finish the branch

- [ ] **Step 1: Full suite + dist** — `cd scripts/cdp-bridge && npm run test:all` (expect ~1970+ green). Stage the rebuilt tracked dist:

```bash
git add scripts/cdp-bridge/dist
git commit -m "chore(#186): rebuilt dist"
```

- [ ] **Step 2: Push + PR**

```bash
git push -u origin feat/202-phase6-foreign-flows
gh pr create --title "feat(#186): Phase 6 — foreign-flow arbitration + canonical Maestro surface" --body "<summary + spec §3 link + both gate transcripts + refusal-latency number. Closes #186. Final phase of #202.>"
```

- [ ] **Step 3: Multi-review + CI + merge per repo workflow.** Run the available reviewers on the diff; wait for ALL checks; read and address every root review thread (reply with fix SHAs); merge. Then:
  - comment on **#202**: Phase 6 shipped — all three fronts done — and **close #202**;
  - close **#186** via the PR (Closes #186 in body);
  - workspace docs: D-entry (foreign flow = arbiter input; TTL/fail-open/knob semantics), ROADMAP narrative; commit+push.

---

## Self-review notes (done at authoring time)

- **Spec §3 coverage:** (a) escape-hatch verify + close #201 → Task 4 (both already implemented — verified against `maestro-run.ts:190` and `maestro-validator.ts:121`; the plan gates them live rather than re-building). (b) foreign flow = external flow-plane holder → Tasks 1–3 (refusal for L2+L3 with L1 free: plane check `!== 'introspection'`; TTL cache ~5 s: Task 1; `meta.timings_ms.foreignScan`: refusal extras; knob `RN_IOS_FOREIGN_WARN=0` disabling both: `foreignGateEnabled` + docs; fail-open: gate catch + getUdid-null skip; screenshot simctl fallback: Task 3 + FLOW_FALLBACK_TOOLS branch in Task 2). (c) docs canonical declaration → Task 6. Non-goals honored: no cross-process lease handshake with maestro-mcp; #211/#240 untouched.
- **Type consistency:** `ForeignFlowGate.check(udid): Promise<ForeignCheckResult>` (Task 1) consumed in Task 2; `ForeignGateOpts {gate,getUdid,enabled}` matches the test helper `foreignOpts`; `foreignFlowGate.lastActive` (Task 1) consumed in Task 3; `setForeignGateUdidProvider` (Task 1) pinned by the Task 2 wiring test.
- **Known design points (reviewers: weigh in):** (1) the foreign check makes formerly-sync-refusing wrapped handlers await one cached read per call — cost is a Map/els lookup within TTL, one ~10–20 ms `ps` per 5 s window otherwise; (2) `cdp_reload`/`cdp_restart` are FLOW_TOOLS and therefore also refuse during a foreign flow — intentional (relaunching the app yanks it out from under the foreign run), but worth a reviewer sanity-check; (3) the Task 5 fake-foreign-runner trick (script path carrying the maestro token + UDID) tests the detector's real `ps` matching without Java/WDA — the REAL-maestro variant was already validated in Phase 3's live detector test; (4) `inFlight` dedup in the gate ignores udid changes mid-flight (two different udids racing share one scan) — acceptable: single-simulator sessions are the norm and the next check rescans.
