# Eradicate agent-device — Phase 2: Hard Cutover — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Remove agent-device entirely — delete the Android daemon-socket + CLI dispatch tiers, reroute EVERY residual verb (`open`/`close`/`devices`/`find`) to native (simctl/adb + in-tree runners), give the Android short-circuit an ensure-runner choke point, make any "disable" env error instead of falling back, remove the install script + its SessionStart hook, and rename `runAgentDevice` → `runNative`. **After this PR no code path spawns, installs, prompts for, or requires agent-device.**

**Architecture:** `runNative(cliArgs, {platform})` dispatches ONLY to `runIOS` (rn-fast-runner) / `runAndroid` (rn-android-runner), each ensuring its runner first; anything with no native route returns an actionable `NO_NATIVE_ROUTE` error (never agent-device). Session lifecycle is purely ours: resolve device → acquire lock → ensure runner → launch via simctl/adb → set session state (last).

**Tech Stack:** TypeScript (Node ≥22, `tsc`, `node:test`), `xcrun simctl`, `adb`.

**Spec:** `docs/superpowers/specs/2026-06-15-eradicate-agent-device-design.md` · **Builds on:** Phase 1 (PR #305) — `resolveAndroidSerial`, `parseAdbDevicesSerials`, generalized `DeviceLock`. Pre-Phase-1: `resolveBootedIosUdid` (`device-screenshot-raw.ts:83`, returns first booted only — Task 3a hardens it).

> **Amendments applied from the multi-LLM plan review (Codex + Antigravity + codex-pair, 2026-06-15):** verb census completed (`find` has 7 sites, 4 in the unlisted 13th importer `dev-client-picker.ts` incl. a tap → Task 7); Android short-circuit lacked the ensure-runner the CLI tier backstopped → Task 6 (also fixes cold `repair-action` snapshot); `setActiveSession` ran BEFORE the lock → Task 4 reorders to lock-first/session-last; `gh-202-device-lock-wiring.test.js` source-regex assertions will break → Tasks 4/5 rewrite them; `device-list.ts` has NO enumeration to "extend" (one-liner) + `parseSimctlBootedUDID` returns first-only → Task 2 writes a multi-device parser, Task 3a a multi-sim-safe iOS resolver; runner-leak recovery `['close']` closures (device-session.ts:403, device-interact.ts:149) → Task 5; `_setRunAgentDeviceForTest` is 3 seams across 8 test files + gh-110 asserts the fuse message → Task 11; `isValidBundleId(appId)` guard must survive the native Android `open` (injection class) → Task 4; install script + hook removal moved INTO this phase → Task 10; `NO_DEVICE_SESSION`→`NO_NATIVE_ROUTE` → Task 8; grep-gate broadened → Task 12.

**Per-task workflow:** edit `src/*.ts` → `cd scripts/cdp-bridge && npm run build` → `node --test test/unit/<f>.test.js`. Phase gate: `npm test`. Signed per-task commits; changeset for the user-facing removal.

---

## Verb census (verified against source 2026-06-15)
- **Native-routed already** (in `RN_FAST_RUNNER_COMMANDS` AND `RN_ANDROID_RUNNER_COMMANDS`): `snapshot`, `press`, `fill`, `type`, `back`, `keyboard`, `swipe`, `scroll`, `longpress`, `pinch`, `drag`, `screenshot`. These reach a native route post-cutover (given an ensure-runner — Task 6).
- **Residual (fall through to daemon/CLI today)** → must be rerouted: `devices` (device-list.ts:25-27) → Task 2; `open` (device-session.ts:204) + `close` (device-session.ts:249, 370, 403) → Tasks 4/5; `find` (proof-step.ts:76, device-interact.ts:327, device-batch.ts:176, dev-client-picker.ts:159/225/255/269) → Task 7.
- **Importers (13):** agent-device-wrapper, tools/{proof-step, device-batch, device-interact, repair-action, dev-client-picker, device-list, macro-asserts, device-screenshot-raw, device-session-close, device-session}, runners/rn-fast-runner-client. (`dev-client-picker` was the missing 13th.)
- **Test seams (3, keep the public name to minimize churn):** `_setRunAgentDeviceForTest` in agent-device-wrapper.ts:703 (fused), device-list.ts:17, dev-client-picker.ts:12 — exercised by 8 test files; `gh-110-test-seam-fuse.test.js` asserts the fuse error string.

---

### Task 1: Rename `runAgentDevice` → `runNative` with a transition shim
**Files:** Modify `scripts/cdp-bridge/src/agent-device-wrapper.ts`. Test: `test/unit/run-native-rename.test.js` (create).
- [ ] **Step 1 (failing test):**
```js
import { test } from 'node:test'; import assert from 'node:assert/strict';
import * as w from '../../dist/agent-device-wrapper.js';
test('runNative exported; runAgentDevice is a transition alias', () => {
  assert.equal(typeof w.runNative, 'function');
  assert.equal(w.runAgentDevice, w.runNative);
});
```
- [ ] **Step 2:** build + run → FAIL.
- [ ] **Step 3:** rename `export async function runAgentDevice` → `runNative`; add `export const runAgentDevice = runNative;`. Keep `_setRunAgentDeviceForTest` operating on the same impl. **Do NOT rename the internal fuse error-message string yet** (`gh-110-test-seam-fuse.test.js` asserts "production runAgentDevice call…" — that test churns in Task 11, not here).
- [ ] **Step 4:** build + `npm test` → all green.
- [ ] **Step 5:** commit `feat(rn-device): rename runAgentDevice → runNative (transition alias)`.

### Task 2: Native `device_list` (multi-device simctl/adb enumeration)
**Files:** Modify `scripts/cdp-bridge/src/tools/device-list.ts`. Test: `test/unit/device-list-native.test.js`.
> **Reality:** device-list.ts has NO existing simctl/adb *enumeration* — `createDeviceListHandler` is a one-liner `runAgentDeviceFn(['devices'], {skipSession:true})` (line 25-27). The simctl/adb refs in this file are screenshot-only. `parseSimctlBootedUDID` returns the FIRST booted UDID, not a list. There are no in-repo consumers of the `devices` result shape (index.ts:627 just registers it), so the output shape is free to define — but capture the current shape first for safety.
- [ ] **Step 1 (failing test):** inject exec; assert `device_list` enumerates iOS via `xcrun simctl list devices --json` (all booted) + Android via `adb devices` (parsed by `parseAdbDevicesSerials`), and NEVER calls the `['devices']` runNative path.
- [ ] **Step 2:** build + run → FAIL.
- [ ] **Step 3:** write a new `parseSimctlDevicesAll(json)` (all booted, not just first) + replace the one-line handler with native enumeration merging iOS booted + `adb devices` serials. Import `parseAdbDevicesSerials` from `../runners/rn-android-runner-client.js`. Add an injectable `exec` seam for the test (replacing the now-orphaned `runAgentDeviceFn` seam + its `_resetRunAgentDeviceForTest`). Return `{ ok: true, data: { devices: [{platform, id, name, state}] } }`.
- [ ] **Step 4:** build + targeted test + `npm test` → green (update/remove device-list's old seam tests).
- [ ] **Step 5:** commit `feat(rn-device): native device_list via simctl/adb (drop agent-device devices)`.

### Task 3a: Multi-sim-safe iOS device resolver
**Files:** Modify `scripts/cdp-bridge/src/tools/device-screenshot-raw.ts` (add a list-all resolver alongside `parseSimctlBootedUDID`). Test: `test/unit/ios-resolver-multisim.test.js`.
> **Why:** `resolveBootedIosUdid()` returns the FIRST booted sim with no ambiguity handling — Task 3's lock-first open would lock/launch the wrong sim when >1 is booted. Mirror `resolveAndroidSerial`'s contract (exactly-one-or-explicit, else undefined).
- [ ] **Step 1 (failing test):** `parseSimctlBootedAll(json)` returns ALL booted UDIDs; a new `resolveIosUdid(explicit?)` returns `explicit` → else the single booted UDID → else `undefined` (0 or >1). Feed it 0/1/2-booted JSON fixtures.
- [ ] **Step 2:** build + run → FAIL.
- [ ] **Step 3:** implement `parseSimctlBootedAll` + `resolveIosUdid(explicit?)` (keep `resolveBootedIosUdid`/`parseSimctlBootedUDID` for existing screenshot callers; the new resolver is for session-open).
- [ ] **Step 4:** build + tests + `npm test` → green.
- [ ] **Step 5:** commit `feat(rn-device): multi-sim-safe iOS device resolver (resolveIosUdid)`.

### Task 4: Native session `open` — resolve → lock → ensure-runner → launch → set-session-last
**Files:** Modify `scripts/cdp-bridge/src/tools/device-session.ts` (action==='open'). Test: rewrite the conflict-teardown regexes in `test/unit/gh-202-device-lock-wiring.test.js` + behavior test.
> **Bug being fixed:** today `setActiveSession` (line 224) runs BEFORE the lock (line 244), so a `DEVICE_BUSY` conflict leaves a stale in-memory session. New order makes the conflict path truly side-effect-free.
- [ ] **Step 1 (failing tests):** (a) source-regex: assert no `runAgentDevice(['open'`; assert `isValidBundleId(appId)` appears before any `adb`/launch; assert order `resolveIosUdid|resolveAndroidSerial … acquireDeviceLockForSession … (ensureRunner|startAndroidRunner) … setActiveSession`. (b) **Rewrite** the two existing assertions that Task 4 breaks: the `runAgentDevice(['close']) … clearActiveSession … DEVICE_BUSY` conflict-teardown regex (lines ~17-21) and the `stopAndroidRunner(lockDeviceId)` one (lines ~49-51) → assert the new lock-first shape (conflict returns DEVICE_BUSY with nothing to tear down).
- [ ] **Step 2:** build + run → FAIL.
- [ ] **Step 3:** rewrite the `open` branch:
  1. **Validate `appId` with `isValidBundleId(appId)` FIRST** (preserve the existing guard — argv injection class) before any adb/simctl/pidof.
  2. Resolve device id: iOS `resolveIosUdid(args.deviceId)`; Android `resolveAndroidSerial(args.deviceId)`. None → `failResult('No booted <platform> device (or ambiguous — pass deviceId)', 'NOT_CONNECTED')`.
  3. **Acquire `acquireDeviceLockForSession(platform, deviceId, appId)` BEFORE any side-effect** → conflict → return `DEVICE_BUSY` (no runner, no launch, no setActiveSession).
  4. Ensure runner: iOS `ensureRunnerForCommand(deviceId, appId)`; Android `startAndroidRunner(deviceId, appId)` (health-gated). Failure → release lock + actionable error.
  5. Launch/foreground: iOS `xcrun simctl launch <udid> <appId>` — **also in attachOnly mode** (a bare `simctl launch` foregrounds the running PID without relaunch, per the Phase-2b wedge note); skip only if `attachOnly && !isAppRunning`→error. Android: `attachOnly` → require `isAppRunning` (no relaunch); else `adb -s <serial> shell monkey -p <appId> -c android.intent.category.LAUNCHER 1`.
  6. **`setActiveSession({...})` LAST**, then `resetWedgeRecoveryCounter()`/`resetDetachedRecoveryCounter()`. Delete the `runAgentDevice(['open'…])` call.
- [ ] **Step 4:** build + tests + `npm test` → green.
- [ ] **Step 5:** commit `feat(rn-device): native session open — validate appId, resolve, lock-first, launch via simctl/adb`.

### Task 5: Native session `close` + migrate runner-leak recovery closures
**Files:** Modify `scripts/cdp-bridge/src/tools/device-session.ts` + `device-session-close.ts` + `device-interact.ts`. Test: update `test/unit/gh-244-close-session-gone.test.js` + the wiring test.
> **Reality:** `closeDeviceSession` ALREADY stops both runners unconditionally + releases the lock (Phase 1). The remaining agent-device coupling is the `runAgentDevice(['close'])` RPC in 3 places: the close-handler dep (device-session.ts:370), and two runner-leak *recovery* closures (device-session.ts:403, device-interact.ts:149). `['close']` is NOT in either short-circuit set → it would hit `NO_NATIVE_ROUTE` post-cutover.
- [ ] **Step 1 (failing test):** assert zero `runAgentDevice(['close'])` / `runNative(['close'])` in `src`; close handler + both recovery closures use native teardown (`stopFastRunner`/`stopAndroidRunner` + `clearActiveSession`).
- [ ] **Step 2:** build + run → FAIL.
- [ ] **Step 3:** make `closeUnderlyingSession` a no-op success (runner-stop + lock-release + state-clear already live in `closeDeviceSession`); simplify away the now-unreachable `isBenignSessionGoneError` agent-device branch. In the runner-leak recovery closures (device-session.ts:403, device-interact.ts:149/152), replace `runAgentDevice(['close'])`/`['open']` with native teardown + the Task-4 native open path (or, if recovery-reopen is agent-device-shaped legacy, gate it out per spec D-b — decide + note). `['snapshot']` recovery calls stay (native-routed).
- [ ] **Step 4:** build + tests + `npm test` → green.
- [ ] **Step 5:** commit `feat(rn-device): native session close + recovery teardown (drop agent-device close)`.

### Task 6: Android short-circuit ensure-runner (symmetric to iOS) — fixes cold-start + repair-action
**Files:** Modify `scripts/cdp-bridge/src/agent-device-wrapper.ts` (Android short-circuit ~761-767). Test: `test/unit/android-shortcircuit-ensure.test.js`.
> **Bug:** the iOS short-circuit calls `ensureRunnerForCommand` (line 748); the Android one (763-767) goes straight to `runAndroid` with no ensure. The deleted CLI tier silently backstopped a cold Android verb (and cold `repair-action` snapshot). Without this, post-cutover Android `device_*` before `action=open` (or after a runner crash) has no auto-spawn.
- [ ] **Step 1 (failing test):** with a mocked `startAndroidRunner`/health, assert the Android short-circuit ensures the runner (reuse-aware) before `runAndroid`, and surfaces an actionable error if it can't come up — including the no-active-session path (mirrors `repair-action` cold snapshot).
- [ ] **Step 2:** build + run → FAIL.
- [ ] **Step 3:** before `runAndroid(...)` in the Android short-circuit, add an ensure step: resolve serial (`activeSession?.deviceId ?? resolveAndroidSerial()`), `startAndroidRunner(serial, appId)` guarded by `shouldReuseAndroidRunner` + `waitForAndroidRunnerHealth`; on failure return `failResult(..., 'RN_ANDROID_RUNNER_DOWN')` (don't fall through).
- [ ] **Step 4:** build + tests + `npm test` → green.
- [ ] **Step 5:** commit `feat(rn-device): Android short-circuit ensures the runner (parity with iOS)`.

### Task 7: Reroute ALL `find` sites to the native snapshot orchestrator
**Files:** Modify `proof-step.ts:76`, `dev-client-picker.ts` (159/225/255/269), `device-interact.ts:327` (delete legacy fall-through), `device-batch.ts:176`. Test: extend each + the picker test.
> `find` is intentionally NOT in either short-circuit set (it's a TS orchestrator). Every literal `['find', …]` falls through to the deleted tiers. `dev-client-picker.ts:225` is `['find', target, 'click']` — a TAP, so it needs match-then-`press`, not just a read.
- [ ] **Step 1 (failing tests):** assert no `['find'` literal remains in these files; picker dismissal resolves via `fetchFindCandidates`/`findInLatestSnapshot` (+ `pressCandidate` for the click site).
- [ ] **Step 2:** build + run → FAIL.
- [ ] **Step 3:** replace read finds with the existing `device_find` orchestrator (`fetchFindCandidates(text, exact)`); replace `['find', target, 'click']` with `fetchFindCandidates` → `pressCandidate(candidate, 'click')` (both exported from device-interact.ts). Delete the dead `device-interact.ts:327` legacy fall-through (the orchestrator above it is the real path). For `device-batch.ts:176`, route through the same orchestrator. Add `dev-client-picker` to the Task-11 rename list.
- [ ] **Step 4:** build + tests + `npm test` → green (esp. the picker tests).
- [ ] **Step 5:** commit `feat(rn-device): all find sites via native snapshot orchestrator (incl. dev-client picker)`.

### Task 8: Delete the daemon-socket + CLI tiers; `runNative` native-only; `NO_NATIVE_ROUTE`
**Files:** Modify `scripts/cdp-bridge/src/agent-device-wrapper.ts`. Test: `test/unit/run-native-no-agent-device.test.js`.
- [ ] **Step 1 (failing test):** assert source has no `execFile('agent-device'`/`loadDaemonInfo`/`runViaDaemon`; `runNative` with a resolvable platform routes to runIOS/runAndroid; with NO native route for the verb returns `failResult('No native route for "<verb>" — …', 'NO_NATIVE_ROUTE')` (distinct from `NO_DEVICE_SESSION`).
- [ ] **Step 2:** build + run → FAIL.
- [ ] **Step 3:** delete `loadDaemonInfo`/`refreshDaemonInfo`/`invalidateDaemonCache`/`sendToDaemon`/`runViaDaemon` + the daemon fast-path (~780) + the entire `execFile('agent-device'…)` CLI block (~800-859) + the GH#60 `platformMismatch`/`--platform` forcing block (~770-798, **intentional removal** — native short-circuits are already platform-keyed) + now-unused `DAEMON_TIMEOUT`/`EXEC_TIMEOUT`/`AgentDeviceJson`. Final `runNative`: iOS ensure+short-circuit → runIOS; Android ensure+short-circuit (Task 6) → runAndroid; else `NO_NATIVE_ROUTE`. Keep `_setRunAgentDeviceForTest` seam.
- [ ] **Step 4:** build + `npm test` → green (no test mocks the daemon/CLI envelope — verified; if one breaks, migrate it).
- [ ] **Step 5:** commit `feat(rn-device): delete agent-device daemon + CLI tiers — runNative is native-only`.

### Task 9: "disable" env errors instead of falling back (per-site)
**Files:** Modify `agent-device-wrapper.ts:762` (dispatch gate → error). Test: `test/unit/runner-disable-errors.test.js`.
> Per-site intent: the **dispatch** gate (wrapper:762) should ERROR on `RN_ANDROID_RUNNER=0`; the **warning** gate (device-session.ts:303) stays a warning; the `usesInTreeRunner` read-gate (device-interact.ts:292) — confirm flipping it doesn't change `device_find` semantics (it shouldn't, since there's no other backend).
- [ ] **Step 1 (failing test):** `RN_ANDROID_RUNNER=0` → an Android `device_*` verb returns `failResult('In-tree Android runner is the only backend; the agent-device fallback was removed. Unset RN_ANDROID_RUNNER to use it.', 'RUNNER_DISABLED')`.
- [ ] **Step 2:** build + run → FAIL.
- [ ] **Step 3:** change the dispatch gate so an explicit `=0` errors (not falls through). Document iOS has no disable env (no fallback either).
- [ ] **Step 4:** build + tests + `npm test` → green.
- [ ] **Step 5:** commit `feat(rn-device): RN_ANDROID_RUNNER=0 errors (no agent-device fallback)`.

### Task 10: Remove the install script + its SessionStart hook
**Files:** Delete `scripts/ensure-agent-device.sh`; edit `hooks/detect-rn-project.sh` (remove the line-67 `ensure-agent-device.sh` call). Test: `test/unit/no-agent-device-install.test.js` (or a shell grep in the gate).
> codex-pair HIGH: leaving the hook means users are still PROMPTED to install agent-device after the cutover — contradicting the goal. Removing it here makes "no code path requires agent-device" true at end of this PR. (CLAUDE.md / docs-site prose reconciliation stays Phase 3.)
- [ ] **Step 1 (failing test):** assert `hooks/detect-rn-project.sh` no longer references `ensure-agent-device` and the script file is gone.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** `git rm scripts/ensure-agent-device.sh`; remove its invocation from `hooks/detect-rn-project.sh` (keep `ensure-android-ready.sh`). Leave the rn-setup SKILL.md reference for Phase 3 docs sweep, OR remove it here if trivial.
- [ ] **Step 4:** run gate → PASS; `npm test` green.
- [ ] **Step 5:** commit `feat(rn-device): remove agent-device install script + SessionStart hook`.

### Task 11: Drop the shim — finish the `runNative` rename across all importers + seams
**Files:** the 13 importers; the 3 `_setRunAgentDeviceForTest` seams; 8 test files. Test: grep-gate (Task 12).
- [ ] **Step 1:** in every importer, `runAgentDevice(`→`runNative(` and update imports; remove `export const runAgentDevice = runNative`. **Keep the public seam name `_setRunAgentDeviceForTest`** (lowest churn — 8 test files use it across 3 modules); only update the internal fuse error-message string to say "runNative" and fix the matching assertion in `gh-110-test-seam-fuse.test.js`.
- [ ] **Step 2:** build + `npm test` → green (mechanical; chase any missed call site).
- [ ] **Step 3:** commit `refactor(rn-device): finish runNative rename, drop transition shim`.

### Task 12: Broadened grep-gate + changeset
**Files:** `test/unit/no-agent-device-gate.test.js` (create). 
- [ ] **Step 1 (gate test):** grep `scripts/cdp-bridge/src` (live code) for: `agent-device` as an executable in any spawn form (`execFile(`/`execFileAsync(`/`spawn(` with `'agent-device'`), `runViaDaemon`, `loadDaemonInfo`, and the verb literals `['open'`/`['close'`/`['find'`/`['devices'` passed to `runNative`. Assert ZERO matches — **with an allowlist** for the intentional foreign-runner cleanup strings (`ensure-single-runner.ts` kills `AgentDeviceRunner` + cleans `~/.agent-device/*`, retained per spec D-b) and the sentinel detector (`isAgentDeviceRunnerSentinel`).
- [ ] **Step 2:** build + run → PASS if Tasks 2-11 complete (else a stranded ref fails CI, not runtime).
- [ ] **Step 3:** changeset:
```
---
"rn-dev-agent": minor
---
Remove the agent-device dependency entirely: delete the Android daemon-socket + CLI fallback tiers, route session open/close/list and find natively (simctl/adb + in-tree runners), give the Android runner an ensure-on-dispatch choke point, make RN_ANDROID_RUNNER=0 error instead of falling back, and drop the install script + SessionStart hook. In-tree runners (rn-fast-runner / rn-android-runner) are now the sole device backend. The foreign-AgentDeviceRunner cleanup (self-heal for old installs) is retained.
```
- [ ] **Step 4:** commit `test(rn-device): gate against agent-device refs + changeset`.

---

## Device verification (after all tasks)
On iOS sim AND Android emulator: `device_snapshot action=open` (appId validated, lock acquired before launch, DEVICE_BUSY on a 2nd bridge, session set only on success), a cold `device_*` interaction (proves the Android ensure-runner), `device_list`, dev-client picker dismissal if reachable, `action=close` (runner stopped, lock released), and **assert zero agent-device process spawns** (`ps`, no `~/.agent-device` writes; no install prompt at SessionStart). (iOS device-verify needs an iOS-18 runtime or a rebuilt rn-fast-runner for 26.5 — Phase 0 note.)

## Self-Review
- **Spec coverage:** G1 (no agent-device path/install) → T8/T10/T11/T12; G2 (residual verbs native) → T2/T4/T5/T7 + ensure T6; D-c (disable errors) → T9; D-e (lock-before-side-effects) → T4 (real reorder); D-a (rename) → T1/T11; D-b (retain foreign cleanup) → T12 allowlist.
- **Risk:** session lifecycle (T4/T5) is riskiest — isolated, behind Phase 1's lock/port hardening; lock-first + session-last ordering verified against current line numbers; appId injection guard preserved.
- **Sequencing:** shim (T1) lets T2-T10 land without churning 13 files; T11 finishes the rename once routes are native; T12 proves it. T3a precedes T4 (open needs the safe resolver). T6 precedes/with T8 (deleting the CLI tier requires the Android ensure-runner to exist first).
