---
title: Dev Client picker + tutorial modal — Coverage Status
description: What dev-client-picker.ts currently handles, what it doesn't, and which gaps are tracked for future work.
---

# Dev Client picker + tutorial modal — Coverage Status

> **Last updated:** 2026-05-29 by PR #<PR_NUM> (filled in at PR-open time)

The standalone harness suites at `test-app/harness/suites/dev-client-picker.mjs` and `test-app/harness/suites/expo-tutorial-modal.mjs` (workspace repo) reproduce the Expo Dev Client server-picker and first-launch-tutorial states and exercise the handling code paths in `scripts/cdp-bridge/src/tools/dev-client-picker.ts`. This page enumerates what currently works, what's known-broken, what got fixed in this PR, and what's deferred to future PRs.

**Verify pass (DC-Task 8), 2026-05-29, UDID 78F7D2A1 / iOS 26.4, Node v24.13.0:**

| Suite | Metro | Result | Key datum |
|---|---|---|---|
| `dev-client-picker.mjs` | DOWN | `pass:true` (exit 0) | `cdp_status` returned in **10 ms** with "Metro not found" — Metro-down path does NOT hang |
| `expo-tutorial-modal.mjs` | UP | `pass:true` (exit 0) | reproduces tutorial-eligible state (bundle loaded, 1 JS target); tutorial text CDP-invisible |
| #136 sub-2 live repro | UP + picker up | **hang reproduced** | `cdp_status` took **33,481 ms** (~33.5 s) and then returned a misleading `ok:true` |

## What works (verified by harness)

- **Picker detection (when a device session exists).** `handleDevClientPicker()` and `isDevClientPickerShowing()` (`dev-client-picker.ts:144`, `:225`) detect the picker by `device_find`-matching the literal text `Development servers` / `DEVELOPMENT SERVERS` (`PICKER_INDICATORS`, `dev-client-picker.ts:45`). `parseFirstServerEntry()` (`:120`) then selects a server row to tap via a three-tier matcher: whole-line literal IP → `host:port` port-pattern (`:76`) → first non-header/non-footer row. Unit-test-covered via the `runAgentDevice` test seam.
- **Auto-advance race handling.** `dismissPicker()` (`:169`) re-probes with `isDevClientPickerShowing()` before tapping and returns success if the single-server picker auto-advanced between detect and dispatch (`:176`), closing the ~30% Maestro "unable to find element" race from #136.
- **Metro-DOWN fast path (no hang).** With Metro down, `cdp_status` → `autoConnect` → `discover()` short-circuits at Metro discovery (`discovery.ts:314`, `DISCOVERY_TIMEOUT_MS = 1500`) and returns "Metro not found" in ~10 ms. Verified live by the picker suite (`statusMs:10`). The #136 sub-2 hang is exclusively a Metro-UP phenomenon.
- **CDP is non-perturbing to both surfaces.** `cdp_status` / `cdp_targets` / `cdp_connect` are pure Metro-WebSocket discovery + JS introspection — they never drive the device, so they never dismiss the picker or the tutorial (verified across repeated probes in both suites).

## What's broken (verified by harness)

- **#136 sub-2: `cdp_status` hangs ~33.5 s when the picker is up + Metro is up.** Reproduced live (DC-Task 8): `statusMs = 33,481`. Root cause is a chain, not a single line:
  1. The pre-`autoConnect` picker guard in `status.ts:128-132` calls `isDevClientPickerShowing()`, which is gated on `hasActiveSession()` (`dev-client-picker.ts:226`). On an MCP cold start there is no active device session, so the guard is a **no-op** and execution falls through to `autoConnect` (`status.ts:133`).
  2. With the picker up, Metro's `/json/list` still advertises **stale C++ targets** from the prior bundle session (`React Native Bridgeless [C++ connection]`, `Reanimated UI runtime [C++ connection]`, `vm:None`). These pass `filterValidTargets` because their `title`/`description` include "React Native" (`discovery.ts:44-47`), so `discover()` does NOT throw the fast "No Hermes debug target found" (`discovery.ts:332`).
  3. `connectToTarget` (`connect.ts:215`) opens the WebSocket and the `Runtime.evaluate('1+1')` pre-flight probe **passes** (the C++ connection answers even with no live JS app context), so it proceeds to `ctx.setup()` (`connect.ts:254`).
  4. **Dominant cost:** `performSetup` calls `waitForReact(evaluate, REACT_READY_TIMEOUT_MS)` (`setup.ts:67`, `REACT_READY_TIMEOUT_MS = 30_000`). The picker is blocking the bundle, so React never becomes ready and the poll loop (`setup.ts:174-192`) burns its **full 30 s** before logging `React not ready after 30000ms — helpers will be injected anyway` and continuing. ~3.5 s of discovery/connect/probe overhead on top yields the observed ~33.5 s.
  5. **Worse than slow:** the call ultimately returns `ok:true` (`status.app.dev:true`) rather than surfacing that the picker is blocking the bundle — the user gets a misleading slow "success", not an actionable message. Exposed by the Metro-UP live repro (the `dev-client-picker.mjs` suite runs Metro-DOWN by design and records `statusHung:false` honestly).
- **No MCP-exposed picker-dismiss tool.** `handleDevClientPicker()` is internal-only — invoked from `status.ts` (`:130`, `:240`), `device-reset-state.ts`, and `startup-replay.ts`, never registered as an MCP tool. An agent cannot dismiss the picker on demand; the only path is the device-session-gated, iOS-perturbing internal call. Both suites record `dismissTool:null` / `handlerToolName:null`.
- **Tutorial modal is CDP-invisible and unhandled.** The expo-dev-menu first-launch tutorial ("This is the developer menu…" + Continue) renders in expo-dev-menu's **separate native RN surface**, not the app's Hermes context. `__RN_AGENT.getTree()` and `cdp_component_tree` return only the app tree (no "developer menu"/"Continue"); `device_snapshot` yields no a11y tree in this env (global `agent-device` daemon intercepts `action=open`). There is **no non-perturbing programmatic detector** for the tutorial text and **no dismiss handler** — `handleDevClientPicker()` targets the SERVER picker only. Verified by `expo-tutorial-modal.mjs`.

## Fixed in this PR

_None._ The #136 sub-2 hang root cause was diagnosed and reproduced live, but a correct fix exceeds the in-scope budget — see Deferred. No shipped code was changed in this PR (coverage doc only).

## Deferred (>50 LOC or new code path)

- **#136 sub-2 hang — fast-fail / clear message when the picker blocks the bundle (Metro-UP).** Deferred: no safe ≤50 LOC fix exists in `dev-client-picker.ts`/`status.ts`.
  - The dominant cost is the 30 s `waitForReact` in `performSetup` (`setup.ts:67`), which is shared by every connect path (cold start, reload, soft-reconnect). Shortening it globally would regress legitimate slow first-builds. Threading a status-specific shorter timeout down through `autoConnect → discoverAndConnect → connectToTarget → setup() → performSetup` touches 4-5 files plus the `ConnectContext` interface — well over 50 LOC of shared connect plumbing.
  - A pre-`autoConnect` picker detector based on target shape is **not reliable**: live experiment (DC-Task 8) showed `/json/list` returns 0 Hermes targets *transiently during every normal bundle reload*, not only when the picker is up — and the stale C++ targets pass `filterValidTargets`. Such a heuristic would false-positive on healthy connects (the false-positive risk the code-quality review already flagged on the `pickerDetected` gate).
  - **Proposed follow-up approach (for the issue):** in `connectToTarget`, after the `1+1` pre-flight probe succeeds but before `setup()`, run a short bounded "is React reachable?" probe (e.g. `waitForReact` with a ~3-5 s budget on the *status-initiated* connect only) and, on timeout against a target whose `vm` is not `Hermes`, abort that candidate with a typed `PickerBlockingBundleError`; `status.ts` maps it to a fast `failResult`/`warnResult` like *"Dev Client picker is blocking the bundle — select your Metro server on the simulator, then retry cdp_status."* Needs a new error type + a status-vs-other connect-intent flag threaded through the connect chain; estimated >50 LOC across `connect.ts`/`setup.ts`/`status.ts`/`cdp-client.ts`. Track as a dedicated #136 sub-2 follow-up issue.
- **No MCP-exposed picker-dismiss tool.** Deferred: registering a new `cdp_dismiss_dev_client_picker` MCP tool is a new code path (tool schema + `trackedTool` registration + iOS-perturbation handling). Track as a follow-up if agents need on-demand dismissal beyond the internal `cdp_status`/`device_reset_state`/`startup-replay` call sites.
- **Tutorial-modal detection + dismissal.** Deferred: requires either OCR over `xcrun simctl io screenshot` (no programmatic CDP/a11y signal exists for expo-dev-menu's separate surface) or a non-perturbing native bridge into expo-dev-menu — both are new code paths well beyond the budget. Track as a follow-up (relates to #173 sub-4).
- **CI workflow for the harness suites (planned DC-Task 9).** Deferred: the planned `macos-15` workflow runs a ~20 min full native build (`expo prebuild` + `expo run:ios`) + Metro to drive both suites, but (a) the two suites have **opposite Metro requirements** — the picker suite needs Metro DOWN, the tutorial suite needs Metro UP — which the single-Metro-start workflow draft does not satisfy, and (b) both suites are reproduction fixtures with intentionally weak assertions (see "documents the gap" above) guarding a bug that is itself deferred-unfixed. A heavy, flaky-prone CI job guarding weak-signal reproduction of an unfixed bug is low ROI today. **Revisit when #136 sub-2 is fixed** — at that point CI can guard the fix (an asserting suite), and the workflow must run the picker suite Metro-DOWN, then start Metro, then run the tutorial suite Metro-UP. Suites remain runnable on-demand locally meanwhile.
