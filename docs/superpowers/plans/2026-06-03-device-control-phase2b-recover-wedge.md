# Device Control Phase 2b — Bounded `recoverWedge` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the iOS simulator's foreground is stolen and iOS pauses the app's JS thread (CDP wedges), automatically re-foreground the target app and reconnect — bounded so the agent never burns the ~7 recovery attempts the #202 session did, and never masks a genuinely dead runner.

**Architecture:** A new `cdp/recover-wedge.ts` exports `recoverWedge(client, deps?)` — bounded (max 3/session, counter reset on `device_snapshot action=open`). It parks L2 (the fast-runner lazily restarts), unconditionally re-foregrounds the target via `simctl launch <udid> <appId>` (resumes the paused JS thread regardless of *who* stole focus — we deliberately do NOT diagnose foreground via `launchctl`, which lists running, not frontmost, apps), marks CDP stale + reconnects, then re-checks `isPaused`. It is wired into `cdp_status`'s existing `isPaused` block (where `softReconnect` alone currently fails and returns a dead-end warning).

**Tech Stack:** Node.js ≥22 (ESM), TypeScript, `node --test` (tests in `scripts/cdp-bridge/test/unit/`, compiled JS from `../../dist/`). `recoverWedge` is pure orchestration over an injectable `deps` object (mirrors `restart.ts`'s `RestartHandlerDeps` + `recovery.ts`) — fully hermetic, no real device.

**Branch:** stack on Phase 2a — create `feat/202-phase2b-recover-wedge` from `feat/202-phase2a-arbiter` (PR #215's branch).

**Spec:** `docs/superpowers/specs/2026-06-01-device-control-arbiter-design.md` §5.1 (`recoverWedge`) + §5.2 (the `cdp_status` hook). **Deliberate deviation (to be confirmed by the plan review):** the spec's "diagnose foreground via `simctl launchctl list`" is dropped — `launchctl list` enumerates *running* apps, not the *frontmost* one, so it can't reliably tell "foreground stolen" from "runner dead." Instead: unconditional re-foreground (fixes the wedge regardless of thief) + a fast-runner-health note. The runner-dead → reap+restart branch is a follow-up if needed.

**Repo rules (carry over):** stage ONLY each task's files with explicit `git add` (never `-A`); `dist/` is TRACKED — stage rebuilt outputs; commits signed (1Password — if it drops, leave STAGED + report BLOCKED, controller lands it); trailer `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`; explicit type imports; no unnecessary comments. Working dir `scripts/cdp-bridge/` unless stated.

---

## Task 0: Branch + baseline

- [ ] **Step 1:** From repo root: `git checkout feat/202-phase2a-arbiter && git checkout -b feat/202-phase2b-recover-wedge && git branch --show-current` → expect `feat/202-phase2b-recover-wedge`.
- [ ] **Step 2:** `cd scripts/cdp-bridge && npm run build && npm test 2>&1 | tail -6` → build clean; suite green (1637 after Phase 2a). Re-run once on a transient timer flake. If genuinely red, STOP.

---

## Task 1: `recover-wedge.ts` — bounded re-foreground recovery

**Files:**
- Create: `scripts/cdp-bridge/src/cdp/recover-wedge.ts`
- Test: `scripts/cdp-bridge/test/unit/gh-202-recover-wedge.test.js`

- [ ] **Step 1: Write the failing test.** Create `test/unit/gh-202-recover-wedge.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  recoverWedge, resetWedgeRecoveryCounter,
} from '../../dist/cdp/recover-wedge.js';

function baseDeps(over = {}) {
  const calls = [];
  return {
    calls,
    deps: {
      getSession: () => ({ deviceId: 'UDID-A', appId: 'com.example.app', platform: 'ios' }),
      isFlowActive: () => false,
      launchApp: async (udid, appId) => { calls.push(`launch:${udid}:${appId}`); },
      stopFastRunner: () => calls.push('stop'),
      reconnect: async () => { calls.push('reconnect'); },
      probeAlive: async () => true, // CDP live after re-foreground (overridable)
      sleep: async () => {},
      maxPerSession: 3,
      ...over,
    },
  };
}

test('GH#202 recoverWedge: re-foregrounds, reconnects, recovers (happy path + order)', async () => {
  resetWedgeRecoveryCounter();
  const { calls, deps } = baseDeps();
  const r = await recoverWedge({}, deps);
  assert.equal(r.recovered, true);
  assert.equal(r.reason, 'recovered');
  assert.equal(r.attempt, 1);
  // park L2 → re-foreground → reconnect (NO markCdpStale — would double-reconnect)
  assert.deepEqual(calls, ['stop', 'launch:UDID-A:com.example.app', 'reconnect']);
});

test('GH#202 recoverWedge: liveness probe FALSE after re-foreground → still-wedged', async () => {
  resetWedgeRecoveryCounter();
  const { deps } = baseDeps({ probeAlive: async () => false });
  const r = await recoverWedge({}, deps);
  assert.equal(r.recovered, false);
  assert.equal(r.reason, 'still-wedged');
});

test('GH#202 recoverWedge: SKIPS when a flow lease is held (no device calls, no budget burn)', async () => {
  resetWedgeRecoveryCounter();
  const { calls, deps } = baseDeps({ isFlowActive: () => true, probeAlive: async () => false });
  const r = await recoverWedge({}, deps);
  assert.equal(r.reason, 'flow-active');
  assert.equal(calls.length, 0);
  // budget NOT consumed: a later real attempt is still attempt 1
  const real = await recoverWedge({}, baseDeps({ probeAlive: async () => false }).deps);
  assert.equal(real.attempt, 1);
});

test('GH#202 recoverWedge: no session → no-session; Android → unsupported-platform; neither burns budget', async () => {
  resetWedgeRecoveryCounter();
  const noSess = await recoverWedge({}, baseDeps({ getSession: () => null }).deps);
  assert.equal(noSess.reason, 'no-session');
  const android = await recoverWedge({}, baseDeps({ getSession: () => ({ deviceId: 'X', appId: 'a', platform: 'android' }) }).deps);
  assert.equal(android.reason, 'unsupported-platform');
  // neither consumed budget
  const real = await recoverWedge({}, baseDeps({ probeAlive: async () => false }).deps);
  assert.equal(real.attempt, 1);
});

test('GH#202 recoverWedge: caps CONSECUTIVE failures; a success resets the budget', async () => {
  resetWedgeRecoveryCounter();
  const failing = baseDeps({ probeAlive: async () => false, maxPerSession: 2 }).deps;
  assert.equal((await recoverWedge({}, failing)).reason, 'still-wedged'); // attempt 1
  assert.equal((await recoverWedge({}, failing)).reason, 'still-wedged'); // attempt 2
  assert.equal((await recoverWedge({}, failing)).reason, 'budget-exhausted'); // refused
  // a SUCCESS resets the consecutive-failure count:
  const ok = await recoverWedge({}, baseDeps({ probeAlive: async () => true, maxPerSession: 2 }).deps);
  assert.equal(ok.recovered, true);
  assert.equal((await recoverWedge({}, failing)).reason, 'still-wedged'); // attempt 1 again
});

test('GH#202 recoverWedge: re-foreground throws + probe FALSE → still-wedged (no false positive)', async () => {
  resetWedgeRecoveryCounter();
  const { deps } = baseDeps({
    launchApp: async () => { throw new Error('simctl boom'); },
    probeAlive: async () => false, // a thrown launch + failed probe is NOT recovered
  });
  const r = await recoverWedge({}, deps);
  assert.equal(r.recovered, false);
  assert.equal(r.reason, 'still-wedged');
});
```

- [ ] **Step 2: Run → fail.** `npm run build && node --test test/unit/gh-202-recover-wedge.test.js` → FAIL (module missing).

- [ ] **Step 3: Implement.** Create `src/cdp/recover-wedge.ts`:
```ts
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import type { CDPClient } from '../cdp-client.js';
import { getActiveSession } from '../agent-device-wrapper.js';
import { stopFastRunner as defaultStopFastRunner } from '../runners/rn-fast-runner-client.js';
import { arbiter } from '../lifecycle/device-arbiter.js';
import { probeFreshness } from './recovery.js';

const execFile = promisify(execFileCb);
const DEFAULT_MAX_PER_SESSION = 3;
const FOREGROUND_SETTLE_MS = 800;

export type WedgeReason =
  | 'recovered'
  | 'still-wedged'
  | 'no-session'
  | 'flow-active'
  | 'unsupported-platform'
  | 'budget-exhausted';

export interface WedgeRecoveryResult {
  recovered: boolean;
  reason: WedgeReason;
  attempt: number;
}

let attempts = 0;
/** Reset the per-session recovery budget (on device_snapshot open AND on a successful recovery). */
export function resetWedgeRecoveryCounter(): void { attempts = 0; }

export interface RecoverWedgeDeps {
  getSession?: () => { deviceId?: string; appId?: string; platform?: string } | null;
  isFlowActive?: () => boolean;
  launchApp?: (udid: string, appId: string) => Promise<void>;
  stopFastRunner?: () => void;
  reconnect?: () => Promise<void>;
  /** Success criterion: real CDP liveness (NOT client.isPaused, a debugger-pause bit). */
  probeAlive?: () => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  maxPerSession?: number;
}

async function defaultLaunchApp(udid: string, appId: string): Promise<void> {
  // Bare `simctl launch` (NO --terminate-running-process): empirically foregrounds
  // an ALREADY-RUNNING backgrounded app with the SAME pid, preserving JS state —
  // which is exactly what resumes the paused JS thread (#202 plan review, verified
  // on a live simulator). terminate+launch would destroy state — that's hardReset.
  await execFile('xcrun', ['simctl', 'launch', udid, appId], { timeout: 10_000 });
}

/**
 * GH#202 Phase 2b: bounded recovery for the JS-thread-paused wedge — something
 * stole the simulator's foreground, so iOS suspended the app's JS thread and CDP
 * wedged. We do NOT diagnose the thief (simctl launchctl lists running, not
 * frontmost, apps); we unconditionally re-foreground the target, which resumes
 * its JS thread regardless. Steps: park L2 (lazily restarts) → simctl launch the
 * target → reconnect → confirm via a REAL CDP liveness probe (not the isPaused
 * debugger bit). Bounded to maxPerSession CONSECUTIVE failures (default 3);
 * resets on a successful recovery and on device_snapshot action=open. SKIPS when
 * a Maestro flow holds the arbiter's flow lease (cdp_status is unarbitrated, so
 * recovering mid-flow would yank the app out from under the flow).
 */
export async function recoverWedge(
  client: CDPClient,
  deps: RecoverWedgeDeps = {},
): Promise<WedgeRecoveryResult> {
  const max = deps.maxPerSession ?? DEFAULT_MAX_PER_SESSION;
  const isFlowActive = deps.isFlowActive ?? (() => arbiter.snapshot.flowLeaseHeldBy !== null);

  // No-op early returns — these must NOT consume the budget.
  if (isFlowActive()) {
    return { recovered: false, reason: 'flow-active', attempt: attempts };
  }
  const session = (deps.getSession ?? getActiveSession)();
  if (!session?.deviceId || !session?.appId) {
    return { recovered: false, reason: 'no-session', attempt: attempts };
  }
  if ((session.platform ?? 'ios') !== 'ios') {
    return { recovered: false, reason: 'unsupported-platform', attempt: attempts };
  }
  if (attempts >= max) {
    return { recovered: false, reason: 'budget-exhausted', attempt: attempts };
  }

  // A real, side-effecting attempt.
  attempts += 1;
  const attempt = attempts;
  const udid = session.deviceId;
  const appId = session.appId;

  const stopFastRunner = deps.stopFastRunner ?? defaultStopFastRunner;
  const launchApp = deps.launchApp ?? defaultLaunchApp;
  const reconnect = deps.reconnect ?? (() => client.softReconnect());
  const probeAlive = deps.probeAlive ?? (async () => (await probeFreshness(client)).fresh);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  stopFastRunner();
  try { await launchApp(udid, appId); } catch { /* best-effort re-foreground */ }
  await sleep(FOREGROUND_SETTLE_MS);
  try { await reconnect(); } catch { /* best-effort; the liveness probe is the verdict */ }

  if (await probeAlive()) {
    attempts = 0; // success bounds CONSECUTIVE wedges, not lifetime
    return { recovered: true, reason: 'recovered', attempt };
  }
  return { recovered: false, reason: 'still-wedged', attempt };
}
```

- [ ] **Step 4: Run → pass.** `npm run build && node --test test/unit/gh-202-recover-wedge.test.js` → PASS (6 tests).

- [ ] **Step 5: Commit.**
```bash
git add src/cdp/recover-wedge.ts test/unit/gh-202-recover-wedge.test.js dist/cdp/recover-wedge.js
git commit -m "feat(recover-wedge): bounded re-foreground recovery for the JS-paused wedge (#202 Phase 2b)"
```

---

## Task 2: Wire `recoverWedge` into `cdp_status` + reset the budget on session open

**Files:**
- Modify: `scripts/cdp-bridge/src/tools/status.ts` (the `isPaused` block, ~lines 209-223)
- Modify: `scripts/cdp-bridge/src/tools/device-session.ts` (reset the budget in the `action === 'open'` success path)
- Test: `scripts/cdp-bridge/test/unit/gh-202-recover-wedge-wiring.test.js`

- [ ] **Step 1: Write the failing wiring test (source-grep — the handler needs a live device, so recoverWedge's logic is unit-tested in Task 1; here we assert the wiring).** Create `test/unit/gh-202-recover-wedge-wiring.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const statusSrc = readFileSync(resolve(__dirname, '../../src/tools/status.ts'), 'utf8');
const sessionSrc = readFileSync(resolve(__dirname, '../../src/tools/device-session.ts'), 'utf8');

test('GH#202 cdp_status calls recoverWedge in the isPaused path', () => {
  assert.match(statusSrc, /recoverWedge\(client\)/);
  // recoverWedge runs only when still paused after softReconnect
  assert.match(statusSrc, /if\s*\(\s*status\.app\.isPaused\s*\)[\s\S]{0,400}recoverWedge\(client\)/);
});

test('GH#202 device-open resets the wedge-recovery budget', () => {
  assert.match(sessionSrc, /resetWedgeRecoveryCounter\(\)/);
});
```

- [ ] **Step 2: Run → fail.** `npm run build && node --test test/unit/gh-202-recover-wedge-wiring.test.js` → FAIL.

- [ ] **Step 3: Wire into `cdp_status`.** In `src/tools/status.ts`, add the import:
```ts
import { recoverWedge } from '../cdp/recover-wedge.js';
```
Then REPLACE the existing `isPaused` block (the one at ~lines 209-223 that does `softReconnect` and returns the two dead-end `warnResult`s) with a version that, when still paused, attempts `recoverWedge` before warning:
```ts
      if (status.app.isPaused) {
        // Auto-recovery: resume paused debugger (D306).
        try {
          await client.softReconnect();
          status.app.isPaused = client.isPaused;
          status.cdp.device = client.connectedTarget?.title ?? null;
          status.cdp.pageId = client.connectedTarget?.id ?? null;
          status.cdp.bundleId = client.connectedTarget?.description ?? null;
        } catch {
          // softReconnect failed — fall through to the wedge recovery below.
        }
        if (status.app.isPaused) {
          // GH#202 Phase 2b: the JS thread is suspended because the app lost
          // foreground. Bounded re-foreground recovery (max 3 consecutive per
          // session; SKIPPED while a Maestro flow holds the arbiter lease).
          const wedge = await recoverWedge(client);
          if (wedge.recovered) {
            status.app.isPaused = client.isPaused; // resumed
            status.cdp.device = client.connectedTarget?.title ?? null;
            status.cdp.pageId = client.connectedTarget?.id ?? null;
            status.cdp.bundleId = client.connectedTarget?.description ?? null;
          } else {
            const hint =
              wedge.reason === 'flow-active'
                ? 'A Maestro flow is running — skipped re-foreground recovery. Wait for the flow to finish, then retry.'
                : wedge.reason === 'budget-exhausted'
                  ? 'Wedge-recovery budget exhausted this session. Try cdp_restart(hardReset=true).'
                  : 'Re-foreground recovery did not clear the wedge. Try cdp_restart(hardReset=true).';
            return warnResult(status, `Debugger paused / app backgrounded. ${hint}`);
          }
        }
      }
```
(Read the exact current block first; preserve the surrounding code — this replaces ONLY the `if (status.app.isPaused) { ... }` block, leaving the `__DEV__`/`reloadCount`/B114 logic around it untouched.)

- [ ] **Step 4: Reset the budget on session open.** In `src/tools/device-session.ts`, add the import:
```ts
import { resetWedgeRecoveryCounter } from '../cdp/recover-wedge.js';
```
In the `action === 'open'` success path, add `resetWedgeRecoveryCounter();` **AFTER the Phase-1.5 device-lock acquire's conflict check** — a conflicting open returns early and tears the session down (`DEVICE_BUSY`), so it must NOT reset the budget (#202 plan review). Place it on the genuinely-succeeded path, e.g. immediately before the `ensureSingleRunner({ udid: deviceId })` block (which only runs after the lock is held):
```ts
        resetWedgeRecoveryCounter();
```
(Pure in-memory counter reset — safe, non-throwing. Read the open success path and place it after the `if (lockResult.status === 'conflict') { ...return failResult... }` early-return.)

- [ ] **Step 5: Run → pass + regression.** `npm run build && node --test test/unit/gh-202-recover-wedge-wiring.test.js test/unit/cdp-state.test.js test/unit/device-session-parsing.test.js` → PASS. Then `npm test 2>&1 | tail -6` → full suite green (~1644).

- [ ] **Step 6: Commit.**
```bash
git add src/tools/status.ts src/tools/device-session.ts test/unit/gh-202-recover-wedge-wiring.test.js
git status --short dist   # add exactly the changed dist:
git add dist/tools/status.js dist/tools/device-session.js
git commit -m "feat(status): recoverWedge in the isPaused path + reset budget on session open (#202 Phase 2b)"
```

---

## Task 3: Docs + changeset + full-suite green

**Files:**
- Modify: `CLAUDE.md` (Architecture + the Troubleshooting "JS thread paused" guidance)
- Create: `.changeset/recover-wedge-202-phase2b.md`

- [ ] **Step 1:** In `CLAUDE.md`, after the Phase 2a arbiter paragraph (search `DeviceSessionArbiter`), add:
```
Since #202 Phase 2b, `cdp_status` auto-recovers the JS-thread-paused wedge (something stole the simulator's foreground): it re-foregrounds the target app (`simctl launch <udid> <appId>`, which resumes the paused JS thread), parks the fast-runner, marks CDP stale, and reconnects — bounded to 3 attempts per session (reset on `device_snapshot action=open`). If it's still paused after that, it points you at `cdp_restart(hardReset=true)`. It does NOT diagnose *who* stole focus (`launchctl list` shows running, not frontmost, apps); unconditional re-foreground fixes the wedge regardless.
```
Also, in the Troubleshooting "JS thread paused / app backgrounded" area (search for `isPaused` or `B154`), note that `cdp_status` now attempts bounded re-foreground recovery automatically.

- [ ] **Step 2:** Create `.changeset/recover-wedge-202-phase2b.md`:
```markdown
---
"rn-dev-agent-plugin": minor
---

#202 Phase 2b: `cdp_status` now auto-recovers the JS-thread-paused wedge. When the simulator's foreground is stolen and iOS pauses the app's JS thread (CDP wedged), `cdp_status` re-foregrounds the target app (`simctl launch`), parks the fast-runner, marks CDP stale, and reconnects — bounded to 3 attempts per session (reset on `device_snapshot action=open`). This replaces the previous dead-end "Debugger is still paused" warning that left the agent to rediscover the fix over many attempts.
```

- [ ] **Step 3:** `cd scripts/cdp-bridge && npm test 2>&1 | tail -8` → full suite green (~1644). Report the tally.

- [ ] **Step 4:** Commit (from repo root):
```bash
git add CLAUDE.md .changeset/recover-wedge-202-phase2b.md
git commit -m "docs(202): document recoverWedge wedge recovery + changeset (Phase 2b)"
```

---

## Self-Review (completed by plan author)

**Spec coverage (spec §5.1 recoverWedge + §5.2 cdp_status hook):**
- Bounded (1/call by construction — each cdp_status call invokes once; max 3/session; reset on open) → Task 1 counter + Task 2 reset. ✅
- Re-foreground target + markCdpStale + reconnect → Task 1 `recoverWedge`. ✅
- `cdp_status` isPaused → recoverWedge before the wedge warning → Task 2. ✅
- Park L2 (the fast-runner) during recovery → Task 1 `stopFastRunner`. ✅

**Deliberate deviations from the spec (flagged for the plan review):**
- **No `launchctl` foreground-diagnosis** — unreliable (`launchctl list` ≠ frontmost). Unconditional re-foreground instead. Confirm this is acceptable.
- **No runner-dead → reap+restart branch** — the *wedge* (isPaused) is an app-JS-thread problem, not a runner problem; the fast-runner lazily restarts on the next `device_*` call. If interaction-after-recovery proves flaky, a runner-health reap+restart is a follow-up.

**Placeholder scan:** none. **Type consistency:** `recoverWedge(client, deps?)`, `WedgeRecoveryResult` (`{recovered, reason, attempt}`), `WedgeReason`, `resetWedgeRecoveryCounter()`, `RecoverWedgeDeps` used identically across tasks/tests. ✅

**Key design decisions (worth logging in DECISIONS.md):**
- **Unconditional re-foreground over foreground-diagnosis** — `simctl launch` resumes the paused JS thread regardless of the thief; diagnosis via `launchctl` is unreliable and adds latency.
- **Bounded 3/session, reset on open** — never burn the ~7 attempts the #202 session did; a fresh session gets a fresh budget.
- **Counter is module-level in-memory** — like Phase 2a's arbiter; a single bridge serves one device at a time.
- **recoverWedge wires into cdp_status (not a standalone tool)** — the wedge is detected where `isPaused` is already checked; recovery belongs at the detection point.

**Amendments applied from the multi-LLM plan review (Gemini + Codex + Claude, 2026-06-03) — source-verified, plus an EMPIRICAL `simctl` experiment on the live simulator:**
- **[empirical validation]** bare `simctl launch <udid> <appId>` foregrounds an already-running backgrounded app with the SAME pid (verified: Settings PID 90353 preserved; `--terminate-running-process` gave a new PID) — so the plan's bare-launch is correct and strictly better than `cdp_restart`'s terminate+launch for state preservation. Kept.
- **[blocker] mid-flow yank** → `recoverWedge` now SKIPS (returns `flow-active`) when the Phase-2a arbiter holds a flow lease (`arbiter.snapshot.flowLeaseHeldBy !== null`) — `cdp_status` is unarbitrated, so recovering mid-flow would relaunch the app out from under Maestro.
- **[blocker] double-reconnect** → dropped `markCdpStale()` (a deferred flag → redundant second reconnect on the next call); `recoverWedge` calls `client.softReconnect()` directly.
- **[blocker] counter bugs** → `attempts += 1` now runs AFTER the no-op early returns (no-session/flow-active/unsupported-platform no longer burn budget), and a **successful recovery resets the counter** so the cap bounds *consecutive* failures (a CDP-only session no longer dies after 3 lifetime wedges).
- **[blocker] wrong success signal** → recovery is now confirmed by a real `probeFreshness(client)` CDP liveness probe, NOT `client.isPaused` (which is a debugger-pause bit that auto-resumes — not OS-foreground proof). The "launch threw but recovered anyway" test is corrected to assert `still-wedged` on a failed probe.
- **[should-fix] platform gate** → Android sessions return `unsupported-platform` (simctl is iOS-only).
- **[should-fix] reset placement** → `resetWedgeRecoveryCounter()` runs after a *successful* `device_snapshot open` (past the Phase-1.5 device-lock conflict teardown), not before.

**Documented follow-ups (NOT in 2b scope):** a behavioral test around `createStatusHandler` with an injected `recoverWedge` (Task 2 keeps source-grep + the Task-1 hermetic suite); a module-scoped in-flight guard (mirroring `cdp_restart`'s `inflightRestart`) so two concurrent `cdp_status` calls can't both relaunch; structured `wedgeRecovery` telemetry in the status meta.
