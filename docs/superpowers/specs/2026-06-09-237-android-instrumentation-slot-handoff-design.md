# Design — #237: Android instrumentation-slot handoff (L2 interaction → L3 flow)

- **Issue:** GH #237 (`kano:must-be`, `effort:m`). Android analog of the iOS `ensureSingleRunner` / `RN_DEVICE_KILL_LEGACY` work (#202 Phase 1).
- **Date:** 2026-06-09
- **Status:** Approved design (brainstorming) → pending implementation plan
- **Refs:** #202 Phase 2a (`runFlowParked` / L2-park-for-flow precedent), #202 Phase 1 (`ensure-single-runner.ts`), #210 (one-coherent-path / self-heal precedent), #165 (in-tree `rn-android-runner`), three-layer device-control contract (CLAUDE.md), D-arbiter (`device-arbiter.ts`).
- **Reviewed by:** Antigravity (`agy` CLI 1.0.6) + an independent source-verified review — both verdicts **APPROVE-WITH-CHANGES**, strongly convergent. Amendments folded in (see §9).

---

## 1. Problem

On Android, after any `device_*` call, `maestro_run` fails:

```
failed to create driver: start UIAutomator2: UIAutomator2 server not ready after 30s
```

**Root cause.** Android permits **one active `UiAutomation` connection at a time.** Our L2 interaction runner holds it, then maestro-runner (L3) cannot bind its own UIAutomator2 server. Two distinct slot-holders exist:

1. **The in-tree `rn-android-runner`** (shipped #165, default-on via `RN_ANDROID_RUNNER !== '0'`) — started via `adb shell am instrument` of `dev.lykhoyda.rndevagent.androidrunner.test` (`rn-android-runner-client.ts:18,150`). This is the modern default holder.
2. **The legacy `agent-device` daemon** — holds its own UIAutomator2 connection. Still reached for Android verbs NOT served by the in-tree runner (`device_deeplink`, `device_permission`, `device_reset_state` — `agent-device-wrapper.ts:760-788`), and for **all** interaction when a user sets `RN_ANDROID_RUNNER=0`. Host-side, so it survives `adb reboot` (the issue's "survives reboot" observation).

**The defect.** `runFlowParked()` (`maestro-run.ts:34-43`) — the wrapper all three flow tools execute inside — **parks only the iOS runner** (`stopFastRunner()`). It has no Android counterpart, even though `stopAndroidRunner()` exists (`rn-android-runner-client.ts:222`) but **is never called outside its own file**. So on Android, the L2 slot-holder is never released before an L3 flow.

**Why the obvious workaround is wrong.** The reporter's `pkill -f agent-device` freed the slot but **also killed the MCP server** — a broad pattern-kill matches too much. The fix must release the slot *surgically* (specific packages/PIDs, never `pkill`).

### Key correctness finding (both reviewers, independently)

`stopAndroidRunner()`'s `runnerProcess?.kill('SIGTERM')` (`rn-android-runner-client.ts:224`) kills only the **host-side** `adb shell am instrument` child. Because `am instrument` is launched by Android's `system_server` (ActivityManager), the **device-side** instrumentation process keeps running and keeps holding the `UiAutomation` slot after the local adb pipe is severed. **`adb shell am force-stop <pkg>` is the decisive slot-release**, not the SIGTERM. This reframes the fix: force-stop is the primary mechanism, the host-side `stopAndroidRunner()` is the secondary (process-handle cleanup + adb-forward removal).

---

## 2. Scope & decision

**Release BOTH slot-holders on the L2→L3 handoff**, surgically:

- **Our own runner** — always (it is *our* resource; never gated).
- **Legacy `agent-device` daemon** — gated, because it may belong to another project (see §4).

**In scope:** per-flow slot release inside `runFlowParked` for all three flow tools (`maestro_run`, `maestro_test_all`, `cdp_auto_login`), plus `cdp_run_action` which composes `maestro_run`.

**Out of scope (this PR):**
- Session-open Android cleanup (the "survives-reboot" stale daemon at `device_snapshot action=open`) — possible follow-up; the per-flow park is where the L2→L3 conflict actually lives.
- The issue's *secondary* observations: `maestro_run` `repeat`-command allowlist; multi-device CDP routing (#60); MCP-server self-disconnects.
- iOS behavior — untouched.

---

## 3. Architecture

### New module: `src/runners/release-android-slot.ts`

The Android analog of `ensure-single-runner.ts`: a pure-core orchestrator with dependency-injected `deps` for unit testing (no device required in unit tests).

```ts
export interface ReleaseAndroidSlotResult {
  stoppedOwnRunner: boolean;
  forceStoppedPackages: string[];
  killedDaemonPids: number[];
  removedFiles: string[];
  warnings: string[];
  meta: { timings_ms: Record<string, number> };
}

export interface ReleaseAndroidSlotDeps {
  stopOwnRunner: (deviceId?: string) => Promise<void>;   // ← stopAndroidRunner
  adbForceStop: (pkg: string, serial: string[]) => Promise<void>;
  readDaemonPid: () => number | null;
  isAlive: (pid: number) => boolean;
  isSelfOrAncestor: (pid: number) => boolean;            // ← self-kill guard
  kill: (pid: number, sig: NodeJS.Signals) => void;
  fileExists: (p: string) => boolean;
  removeFile: (p: string) => void;
  delay: (ms: number) => Promise<void>;
  adbSerial: () => string[];                             // ← getAdbSerial
  killLegacy: () => boolean;                             // ← RN_DEVICE_KILL_LEGACY !== '0'
}

export async function releaseAndroidInteractionSlot(
  opts: { deviceId?: string },
  deps: ReleaseAndroidSlotDeps = defaultDeps(),
): Promise<ReleaseAndroidSlotResult>;
```

**Owned identifiers** (force-stop targets — OUR packages only):
- `dev.lykhoyda.rndevagent.androidrunner.test` (the instrumentation/test package)
- `dev.lykhoyda.rndevagent.androidrunner` (the runner app package)

### Modified: `runFlowParked`

```ts
// before:  runFlowParked<T>(run, deps)
// after:   runFlowParked<T>(run, opts: { platform?: 'ios' | 'android'; deviceId?: string } = {}, deps)
```

On `opts.platform === 'android'`, `await releaseAndroidInteractionSlot({ deviceId: opts.deviceId })` **before** `run()`. iOS path unchanged (`stopFastRunner()`). `markCdpStale()` still runs in `finally` for both platforms.

### Call sites (all already resolve `platform`; pass `deviceId` from the active session)
- `maestro-run.ts:193` — `platform` in scope (line 103).
- `maestro-test-all.ts:143` — `platform` in scope (line 66).
- `auto-login.ts:223` — `platform` in scope (line 130).

---

## 4. Release algorithm

Sequential, each step **best-effort** (failures push to `warnings[]`, never throw — a flow must not fail because cleanup hiccuped). All `adb`/process operations carry a **hard ~5s timeout** so a hung adb daemon can't block the MCP server.

| Step | Action | Gated by `RN_DEVICE_KILL_LEGACY`? | Why |
|---|---|---|---|
| **1. Our runner** | `stopAndroidRunner(deviceId)` — kill our `am instrument` handle + `adb forward --remove` | **No** — always | Our resource; secondary cleanup (the host handle + port) |
| **2. Our instrumentation** | `adb shell am force-stop` of **both** owned packages, scoped via `getAdbSerial()` | **No** — always | **The decisive slot-release** (device-side process the SIGTERM left alive) |
| **3. Legacy daemon** | Read PID from `~/.agent-device/daemon.json`; if alive **AND not self/ancestor** → SIGTERM → grace → SIGKILL; clear orphaned `daemon.{json,lock}` | **Yes** | May belong to another project; mirrors the iOS gate |

**Flag rationale (synthesis of the two reviews).** Reuse the existing `RN_DEVICE_KILL_LEGACY` flag (one mental model; the daemon-file path is genuinely shared with iOS), **but gate ONLY step 3 behind it.** Steps 1 & 2 are unconditionally safe (they touch only *our* runner/instrumentation) and *are* the core #237 fix — so `RN_DEVICE_KILL_LEGACY=0` disables the legacy-daemon cleanup without ever breaking the primary fix.

**Foreign runners are NOT force-stopped.** Force-stopping a *competing* tool's UIAutomator2 package (a foreign maestro-mcp, Appium) is the same overreach that killed the MCP server. Foreign competitors keep the existing detect-and-warn path (`detectAndroidExternalRunner` → `ANDROID_UIAUTOMATOR_COMPETITOR`); we never kill what we don't own.

**Idempotency requirement.** `releaseAndroidInteractionSlot` MUST be safe to call when the runner is already stopped / the daemon is already gone (no throw, no error result). This is load-bearing for the auto-repair re-entrancy path (§6).

---

## 5. Self-heal after the flow

No explicit Android restart. `runAndroid()` calls `startAndroidRunner()` at the top of **every** command (`rn-android-runner-client.ts:293`), idempotent via `isAndroidRunnerAvailable() && shouldReuseAndroidRunner()` — so the next `device_*` cold-starts a fresh runner. Mirrors iOS's lazy fast-runner restart. `markCdpStale()` (already in `finally`) forces the next CDP read to reconnect to post-flow state.

---

## 6. Failure handling & edge cases

- **iOS untouched** — `platform !== 'android'` keeps the exact current path; no Android module imported on the iOS branch.
- **No emulator / adb missing** — every step degrades to a warning; the flow still proceeds (maestro's own error stays authoritative).
- **`RN_DEVICE_KILL_LEGACY=0`** — skips step 3 only; steps 1 & 2 still run (the core fix).
- **Self-kill guard** — never SIGTERM/SIGKILL `process.pid` or an ancestor (`isSelfOrAncestor`). The specific defense against the reporter's "it dropped the MCP server" — a stale, OS-recycled PID in `daemon.json` could otherwise match our own tree.
- **Auto-repair re-entrancy** (`run-action.ts`): inside `cdp_run_action`, an auto-repair snapshot restarts the runner, then `maestro_run` fires again → `runFlowParked` re-runs the release. Safe because the exclusive `flow` arbiter lease is held continuously across the whole sequence (see §7), and the release is idempotent (§4).
- **Hard adb timeout** — a disconnected emulator / hanging adb server cannot block the MCP server.

---

## 7. Concurrency — why no re-acquire race

`arbiterWrap` (`device-arbiter.ts:155`) acquires the **exclusive `flow` lease** before any flow handler runs; the arbiter refuses `flow` while any op is in flight and refuses `interaction` while the flow lease is held (`device-arbiter.ts:31-49`). Therefore `releaseAndroidInteractionSlot` runs **inside** the held flow lease — no concurrent `device_*` can re-grab the slot between our release and maestro's bind. **This is load-bearing: the release MUST stay inside `runFlowParked` (where the lease is held); do not move it earlier/outer.** The new module documents this. (The only residual re-bind risk is a *foreign* process, which §4 deliberately does not fight.)

The arbiter itself stays **pure in-memory** — no device I/O is added to it (CLAUDE.md: persisting/side-effecting a lease recreates the #202 orphaned-lock bug). All side effects live in the new module, invoked from `runFlowParked`.

---

## 8. Testing strategy (TDD)

**Unit (DI, no device):**
- `releaseAndroidInteractionSlot` orchestration order: step 1 → 2 → 3; asserts both owned packages are force-stopped; asserts step 3 skipped when `killLegacy()` is false while 1 & 2 still run.
- Self-kill guard: daemon PID == self/ancestor → NOT killed (warning emitted).
- Idempotency: stub `stopOwnRunner` resolving when nothing is running → no throw, clean result.
- `runFlowParked` branch dispatch: release fn called on `android`, NOT on `ios`; `stopFastRunner` still called on `ios`; `markCdpStale` runs even when `run()` throws (both platforms).
- Existing `gh-202-maestro-flow-parks-l2.test.js` updated for the new `runFlowParked(run, opts, deps)` signature.

**Live emulator (workflow step 5) — a gate, not a nice-to-have:**
- Booted Pixel emulator: `device_snapshot` (starts our runner) → `maestro_run` → assert UIAutomator2 binds and the flow passes.
- **Decisive-step experiment:** prove the slot is free after **step 2 alone** (force-stop) vs **step 1 alone** (SIGTERM) — confirms force-stop is the lever both reviews predict, and that the device-side instrumentation indeed survives the SIGTERM.
- Repeat with `RN_ANDROID_RUNNER=0` + a live legacy daemon to exercise step 3.

---

## 9. Amendments folded in from the multi-LLM review (Antigravity + source-verified)

1. **Force-stop is the decisive mechanism** (device-side instrumentation survives the host SIGTERM) — promoted step 2 from belt-and-suspenders to primary; live test gates it.
2. **Force-stop OUR OWN packages only** — both `…androidrunner.test` and `…androidrunner`; foreign competitors keep the warn-only path.
3. **`runFlowParked` signature** → `(run, { platform, deviceId }, deps)`.
4. **Hard ~5s timeout** on all `adb` calls in the release path.
5. **Keep step 3** (legacy daemon kill) — Antigravity evidence: `device_deeplink`/`permission`/`reset_state` + `RN_ANDROID_RUNNER=0` route to the legacy daemon (`agent-device-wrapper.ts:760-788`).
6. **Reuse `RN_DEVICE_KILL_LEGACY`, gate only step 3 behind it** — steps 1 & 2 always run.
7. **Idempotency** of `releaseAndroidInteractionSlot` (auto-repair re-entrancy) — explicit requirement + unit test.
