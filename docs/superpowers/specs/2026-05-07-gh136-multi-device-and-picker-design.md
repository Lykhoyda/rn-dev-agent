# GH #136 — Multi-device routing + dev-client picker hangs

**Date:** 2026-05-07
**Issue:** [Lykhoyda/rn-dev-agent#136](https://github.com/Lykhoyda/rn-dev-agent/issues/136)
**Plugin version at design time:** 0.44.27 (CDP-bridge 0.38.20 in field reports)

## Problem

A long testing session on a real RN app surfaced three friction points filed as a single bug:

1. **`device_screenshot` returns wrong-platform image** — with both iOS sim and Android emu booted, `device_screenshot platform: "android"` returned an iPhone-resolution image (1179×2556).
2. **`cdp_status` hangs 60s/35s on Expo Dev Client picker** — picker is detected but `dismissPicker` cannot find a server entry to tap, returning `"Already connecting to Metro... Dev Client picker detected but could not find a server entry to tap. Select the Metro server manually."` after a long timeout.
3. **`launchApp` races picker auto-advance** — Maestro flows wrap post-launch in `runFlow when: visible: "DEVELOPMENT SERVERS"` to dismiss the picker, but the `tapOn` races against the picker's auto-advance and fails ~30%.

Issues #2 and #3 share the same `dismissPicker` code path (`scripts/cdp-bridge/src/tools/dev-client-picker.ts`); fixing it once helps both. Issue #1 is independent.

## Scope split

This design ships **two independent PRs** to keep blast radius and review surface manageable:

- **PR-B** (ships first, higher user pain): dev-client picker reliability + `cdp_status` ordering fix. Closes issues #2 and #3.
- **PR-A** (ships second): explicit-platform raw screenshot path. Closes issue #1.

Both PRs target `main`; PR-A does not depend on PR-B.

## PR-B: dev-client picker reliability

### Changes

#### 1. Invert `cdp_status` flow — picker check before connect

**File:** `scripts/cdp-bridge/src/tools/status.ts`

The picker probe today runs **inside the `catch` block** at `status.ts:228-249`, after `autoConnect` has already eaten its 60s discovery timeout. When the picker is up the JS bundle has not loaded → no Metro target visible to CDP → discovery polls until timeout. Each `cdp_status` call eats a fresh 60s.

**New flow:**

```
cdp_status(args)
  ├─ if (!client.isConnected):
  │    └─ const picker = await isDevClientPickerShowing()  // light, no tap
  │       if (picker):
  │         await handleDevClientPicker()                  // dismiss + wait for bundle
  │         (proceed to autoConnect; bundle should be live)
  ├─ try autoConnect()
  └─ on failure: existing fallback picker check (kept as safety net for races)
```

The pre-connect picker probe is gated on `!client.isConnected` so connected sessions don't pay the cost. `isDevClientPickerShowing` already exists (`dev-client-picker.ts:99`) and is light (single `device_find` call).

#### 2. Harden `dismissPicker` matching

**File:** `scripts/cdp-bridge/src/tools/dev-client-picker.ts`

Today's strategy: try literal text `localhost`, `127.0.0.1`, `10.0.2.2`, then snapshot+regex IP. Failure mode: dev-client picker rows show `<hostname>:8081` or `<lan-ip>:8081`; the literal hardcoded IPs rarely appear.

**New strategy** (additive — keep existing patterns as first-pass for backward parity):

1. Existing literal-string list (preserve for known-good cases).
2. **Port-pattern match**: snapshot, then find any tappable element whose visible text matches `\b[\w.-]+:\d{2,5}\b` and tap it. Catches `192.168.1.5:8081`, `host.local:8081`, `10.0.2.2:8081`, etc. The Metro port (default 8081, configurable) is the most reliable structural signal.
3. **First-server-row fallback**: if the snapshot has a "Development servers" header, tap the first non-header element below it. (This is the "tap whatever the first option is" fallback the user implicitly suggested.)

#### 3. Beat the auto-advance race

**File:** `scripts/cdp-bridge/src/tools/dev-client-picker.ts`

The picker auto-dismisses on its own after a few seconds when it has only one entry (the user's #3 evidence: ~30% race failure). To beat this:

- **Re-check after each tap attempt**: if `isDevClientPickerShowing()` returns `false` between tries, treat it as success (the picker auto-advanced and we no longer need to act).
- **Tighten the retry cadence**: current `waitForBundle` polls every 2s for 20s. Replace with two probes:
  - First 1s: poll every 100ms for picker absence (catches auto-advance).
  - 1–10s: poll every 500ms for bundle ready (`__RN_AGENT.__v` reachable via Metro).
- **Safer tap retry loop**: 3 attempts, 200ms apart, on the matched server entry. Each attempt re-snapshots first (the picker can move/redraw between attempts).

### Tests (PR-B)

New file: `scripts/cdp-bridge/test/unit/gh-136-dev-client-picker.test.js` (~12 tests, mirrors `gh-61-b1-deep-link-depth.test.js` pattern):

| Group | Cases |
|---|---|
| Port-pattern matcher | matches `host:8081`, `192.168.x.y:8081`, `10.0.2.2:8081`; ignores non-port colons (`:00 PM`); rejects port < 80 (avoids matching version strings); unicode-safe |
| First-server-row fallback | snapshot with "Development servers" header → first child tapped; no header → no fallback action |
| Auto-advance race | picker absent on re-check → return success without tap |
| `cdp_status` flow inversion | mock `isDevClientPickerShowing` true → `handleDevClientPicker` called before `autoConnect`; mock false → existing flow unchanged |
| Backward parity | literal `localhost` row still matches first |

Existing `cdp_status` tests update to assert the new pre-connect probe is invoked.

### Acceptance (PR-B)

- Reproducer from issue #136: dev-client picker with `<hostname>:8081` entry → `cdp_status` returns `connected: true` in <5s (was 60s+ failure).
- Maestro `launchApp { stopApp: true }` followed by `cdp_status` does not require manual tapping or `runFlow when:` workaround in the consuming flow.
- 0 regressions in existing dev-client picker tests.

## PR-A: explicit-platform raw screenshot path

### Change

**File:** `scripts/cdp-bridge/src/tools/device-list.ts`

When `device_screenshot` is called with explicit `platform: 'ios' | 'android'`, take a parallel branch that bypasses `runAgentDevice` entirely:

- **iOS**: resolve booted UDID for the requested platform via `xcrun simctl list -j devices booted`, then `xcrun simctl io <UDID> screenshot --type=jpeg <path>`.
- **Android**: resolve emulator id via `adb devices` (filtered to `emulator-*` or matching `getprop ro.build.product`), then `adb -s <emu-id> exec-out screencap -p > <path>`.

If raw command fails or device cannot be resolved, fall through to the existing `runAgentDevice` path (graceful degradation; no behavior change for single-device users who don't pass `platform`).

The resize pipeline (`resizeWithSips`) and advisories (`computeScreenshotAdvisories`) wrap the result identically — they already operate on a written-to-disk path, agnostic to which capture tier produced it.

**Not changed**: when caller does NOT pass `platform`, behavior is identical to today (current heuristic via `getClient()?.connectedTarget?.platform`). The user's recommendation #1 is "ONLY on explicit platform" — backward-safe.

### Tests (PR-A)

New file: `scripts/cdp-bridge/test/unit/gh-136-screenshot-raw-platform.test.js` (~8 tests):

| Group | Cases |
|---|---|
| iOS raw path | `platform: 'ios'` → `xcrun simctl io` invoked with resolved UDID; UDID resolution from `simctl list -j` parses correctly |
| Android raw path | `platform: 'android'` → `adb -s <emu-id> exec-out screencap` invoked; emu resolution parses `adb devices` |
| Resolution failure | no booted iOS sim with `platform: 'ios'` → falls back to `runAgentDevice` |
| Backward parity | no `platform` arg → existing `runAgentDevice` path unchanged |
| Resize integration | raw-path screenshot still goes through `resizeWithSips` and gets `meta.resize` populated |
| Advisories integration | `path: '/tmp/...'` with raw path → `EPHEMERAL_PATH` advisory fires identically |

### Acceptance (PR-A)

- Reproducer from issue #136 #1: iOS sim + Android emu both booted; `device_screenshot platform: "android"` returns 1280×2856 image (Pixel 9 Pro resolution), not 1179×2556 (iPhone).
- Reverse case: same setup, `platform: "ios"` returns 1179×2556. (Sanity.)
- No `platform` arg with single device booted: behavior identical to today.

## Out of scope (deferred)

- Fixing `agent-device` CLI's `--platform` routing when both devices are booted. The raw-command path in PR-A bypasses the question; the CLI fix belongs in the agent-device repo.
- Generic "device picker" for non-Expo dev-client scenarios. The plugin-managed picker dismissal is Expo-specific by design (the `PICKER_INDICATORS` array is Expo-shape).
- Maestro `runScript` integration for picker dismissal. The user picked "Internal helper only" — Maestro flows benefit transparently when they call `cdp_status` after `launchApp`.

## Risk register

| Risk | Mitigation |
|---|---|
| Port-pattern matcher false-positives on a non-Metro `:8080`-style row in some other dev-client variant | Pattern requires `\d{2,5}` AND keeps existing literal-IP list as preferred match — port-pattern is the second-pass |
| Auto-advance check (`isDevClientPickerShowing` re-poll) costs 1 extra `device_find` per `cdp_status` call when picker is up | Only fires when `!client.isConnected` AND first probe found picker — same surface as current; net latency win because the alternative was a 60s timeout |
| Raw `xcrun simctl io` produces PNG even when `--type=jpeg` requested on older Xcode (pre-15) | Existing resize pipeline handles both formats (`buildSipsResizeArgs` already conditionally emits `-s format jpeg` based on output extension) — degraded result is a slightly larger file, not a failure |
| `adb -s <emu-id>` fails on Android Studio's "transient" emulator IDs that change per boot | Resolution always re-reads `adb devices` per call — no caching of emu-id across sessions |

## Implementation sequencing

1. **PR-B first** (higher user pain — visible 60s hangs every dev-client session).
2. **PR-A second** (workaround documented; less urgent).
3. Both PRs run `/multi-review` on plan AND impl diff per the project's two-stage review doctrine.
4. CHANGELOG entries: `0.44.28` for PR-B, `0.44.29` for PR-A (or both bundled under `0.44.28` if they ship same-day).

## References

- `scripts/cdp-bridge/src/tools/status.ts` — current `cdp_status` flow + post-fail picker check
- `scripts/cdp-bridge/src/tools/dev-client-picker.ts` — `handleDevClientPicker`, `dismissPicker`, `isDevClientPickerShowing`
- `scripts/cdp-bridge/src/tools/device-list.ts` — `createDeviceScreenshotHandler`, `captureAndResizeScreenshot`, `resolveScreenshotPath`
- `scripts/cdp-bridge/src/agent-device-wrapper.ts:494-533` — existing platform-mismatch handling (kept as fallback)
- `scripts/cdp-bridge/test/unit/gh-61-b1-deep-link-depth.test.js` — test-pattern precedent
- Workspace `docs/DECISIONS.md` — log a new D-entry for each PR
