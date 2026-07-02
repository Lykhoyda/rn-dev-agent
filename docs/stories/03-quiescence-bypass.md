# Story 03 — Quiescence bypass in rn-fast-runner (FBQuiescence-style swizzle)

**Status:** Proposed (2026-07-02)
**Epic:** [Maestro adoption](README.md)
**Impact:** Eliminates the XCTest idle-wait flake class (Reanimated deadlocks, animation hangs, slow snapshots on busy apps) at the root instead of per-symptom
**Effort:** M (small code, large verification surface)
**Depends on:** —

## Problem

XCTest blocks queries, snapshots, and typing until the target app reports "quiesced" — which a React Native app with Reanimated worklets, looping animations, or a busy bridge may *never* report. We currently route around individual symptoms:

- `device_scroll` deadlock on Reanimated → bypassed via HID synthesis (`tools/device-interact.ts:1028-1180`, README troubleshooting).
- "main thread execution timed out" / "Could not detect idle state" on `.type` → treated as success via the runner-timeout shim (`rn-fast-runner-client.ts:731-740`).
- 35 s slow-command timeouts on `snapshot`/`type` as a blunt backstop.

Each is a patch over the same root cause: we let XCTest wait for an idle state RN apps don't reach.

## What Maestro does

Maestro (inheriting WebDriverAgent's approach, BSD-licensed Facebook lineage) method-swizzles `XCUIApplicationProcess -waitForQuiescenceIncludingAnimationsIdle:` at `+load` time into a no-op when quiescence is disabled (`maestro-ios-xctest-runner/MaestroDriverLib/.../XCUIApplicationProcess+FBQuiescence.m:11-72`):

```objc
static void swizzledWaitForQuiescenceIncludingAnimationsIdle(id self, SEL _cmd, BOOL includingAnimations) {
  if (![[self fb_shouldWaitForQuiescence] boolValue] || FBConfiguration.waitForIdleTimeout < DBL_EPSILON) {
    return;   // make XCTest believe the app is idling
  }
  // else bound the original wait with _XCTSetApplicationStateTimeout(...)
}
```

It probes for both the classic selector and the newer `waitForQuiescenceIncludingAnimationsIdle:isPreEvent:` variant, and throws a clear "driver build not compatible with your OS version" if neither exists (`:59-103`). Settle detection then happens entirely on the host side (Story 04). **This is the single biggest reason Maestro doesn't hang on RN apps.**

## Design

1. **Vendor the swizzle.** New `scripts/rn-fast-runner/RnFastRunner/ThirdParty/FBQuiescence/` containing an adapted `XCUIApplicationProcess+RNQuiescence.m` (+ a minimal config singleton replacing `FBConfiguration`), with upstream attribution in `third_party`-style headers and an entry in `scripts/rn-fast-runner/IMPORT_NOTES.md` (the file already documents imported code provenance). License: WebDriverAgent is BSD; Maestro's adaptation is Apache-2.0 — attribute both.
2. **Selector probing:** exactly Maestro's pattern — try `waitForQuiescenceIncludingAnimationsIdle:`, then the `:isPreEvent:` variant; if neither resolves, log one loud line `RN_FAST_RUNNER_QUIESCENCE_UNAVAILABLE` and continue *without* the bypass (never crash the runner over an optional optimization).
3. **Toggle:** env `SIMCTL_CHILD_RN_QUIESCENCE_BYPASS` read by the runner at startup; TS side threads `RN_QUIESCENCE_BYPASS` (default **on**, opt-out `=0`) — same rollout shape as the keyboard guard (`runners/keyboard-guard.ts`, `RN_KEYBOARD_GUARD=0`).
4. **Capability + telemetry:** `/health.capabilities` gains `"QUIESCENCE_BYPASS"` (Story 02). Runner responses include `meta.quiescenceBypass: true` on the first command after boot so sessions are auditable. Keep the runner-timeout shim in place but count its firings (`meta.runnerTimeoutShim` already exists) — the acceptance signal is that count trending to zero.
5. **Follow-on (do not couple):** once bake-in confirms stability, re-evaluate whether the HID-synthesis scroll special-case can be simplified. Do not remove it in this story — it works.

## Implementation steps

1. Port + adapt the two ObjC files; wire into the runner target; bridging header if needed.
2. Startup log markers (`..._QUIESCENCE_BYPASS_ACTIVE` / `..._UNAVAILABLE`) parsed by the existing chunk parser (`rn-fast-runner-client.ts:22-93`) into runner state.
3. TS env threading + capability surfacing + docs.
4. Verification fixture: add a screen to the test app with an infinite Reanimated loop (`withRepeat(withTiming(...))`) and a visible counter.

## Acceptance criteria

- On the Reanimated fixture screen with bypass ON: `device_snapshot` completes < 2 s; `device_fill` types without the timeout shim firing; `device_scroll` (non-HID path, forced via test flag) does not deadlock.
- With bypass OFF (`RN_QUIESCENCE_BYPASS=0`): current behavior unchanged (shim still fires) — proves the toggle isolates the change.
- On an OS where the private selector is missing: runner boots, logs `..._UNAVAILABLE`, all commands still work (no crash, no bypass).
- No regression across the existing golden flows (TaskWizard fill/press/longpress with keyboard guard).

## Test plan

- Swift unit tests for the selector-probe logic (probe result enum, not the swizzle side effect).
- Live matrix (manual, recorded in PR): iOS 18 sim + iOS 26 sim × bypass on/off × {snapshot, type, scroll, longpress} on the Reanimated fixture + TaskWizard.
- Telemetry check over one week of dogfooding: `runnerTimeoutShim` firing count before/after.

## Risks & open questions

- **Private API drift:** Apple renames the selector in a future Xcode/iOS — mitigated by the probe-both-then-degrade design (Maestro's exact posture) and the loud log marker; doctor can surface `QUIESCENCE_BYPASS` capability absence.
- **Behavioral surprise:** with quiescence gone, XCTest may snapshot mid-animation. That is *by design* — Story 04's settle engine becomes the correctness layer; until Story 04 lands, existing read-back verification (`device_fill`) and settle-reads cover the mutating paths.
- **App Store review concerns do not apply** (runner is a dev-time XCTest bundle, never shipped in the user's app).
