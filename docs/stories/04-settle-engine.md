# Story 04 — Shared two-tier settle engine + capability flags

**Status:** Implemented (2026-07-04, #385)
**Epic:** [Maestro adoption](README.md)
**Impact:** Replaces fixed sleeps (`FOCUS_DELAY_MS=150` etc.) with a principled "UI is stable" invariant applied after every mutating native `device_*` verb, on both platforms, from one implementation (`cdp_interact` JS-path settling is a deferred follow-up — see Open questions)
**Effort:** M
**Depends on:** Story 02 (capability negotiation via `/health`); pairs with Story 03 (bypass makes *us* responsible for settling)

## Problem

We have no generic post-mutation settle primitive. `device_fill` has bespoke settle-reads (`nativeSettle`, `tools/fill-verify.ts`), taps rely on fixed delays, and `device_batch` steps race screen transitions. Meanwhile Story 03 removes XCTest's own (broken) waiting, which makes an explicit settle layer mandatory rather than optional.

## What Maestro does

Every mutating call in `Maestro.kt` is followed by `waitForAppToSettle()` (`backPress`, `inputText`, `swipe`, tap — `Maestro.kt:117-122, 193-245`). The settle decision is **capability-switched** (`Capability.FAST_HIERARCHY`, `Maestro.kt:290-306`):

- **Hierarchy-equality polling** (Android, which has fast dumps): poll until two consecutive hierarchies are equal AND root not `is-loading`; bounded 10 iterations × 200 ms (`ScreenshotUtils.kt:38-74`).
- **Screenshot-static** (iOS/web): two consecutive screenshots compared — on-runner SHA-256 of PNGs (`ScreenDiffHandler.swift:16-21`), host-side 0.5 % pixel-diff threshold (`ScreenshotUtils.kt:76-96`, `SCREENSHOT_DIFF_THRESHOLD = 0.005`); iOS tries 3 s of screenshot-static first and only falls back to hierarchy polling if the screen never goes static (`IOSDriver.kt:487-504`).
- **Cheap pre-gate** (Android): a single `isWindowUpdating(appId)` RPC (`waitForWindowUpdate(appId, 500)`, `MaestroDriverService.kt:353-365`) decides whether to pay for hierarchy polling at all; if the window isn't updating, sleep 50 ms and return (`AndroidDriver.kt:706-728`, bounded by 750 ms).
- A tap is judged "landed" by *hierarchy changed* — not by time passed (`hierarchyBasedTap`, `Maestro.kt:308-346`).

## Design

### Runner additions

- **iOS:** new `/isScreenStatic` route — take two screenshots ~100 ms apart, compare SHA-256, return `{static: bool}` (direct port of `ScreenDiffHandler.swift`). Capability `SCREEN_STATIC`.
- **Android:** new `/isWindowUpdating` command — `uiDevice.waitForWindowUpdate(appId, 500)` wrapper returning `{updating: bool}`. Capability `WINDOW_UPDATE`. (Android snapshot dumps are fast enough that hierarchy polling is the main tier, matching Maestro's `FAST_HIERARCHY` posture.)

### Bridge: `scripts/cdp-bridge/src/lifecycle/settle.ts`

```ts
type SettleOutcome = { settled: boolean; method: 'window-gate'|'screen-static'|'snapshot-eq'|'timeout'; ms: number; hierarchyChanged?: boolean };
async function waitForSettle(opts: {platform, appId, budgetMs?, initialSnapshotHash?}): Promise<SettleOutcome>
```

- **Android:** tier 0 `isWindowUpdating` pre-gate (not updating → 50 ms sleep → settled) → tier 1 snapshot-hash equality polling (≤10 × 200 ms).
- **iOS:** tier 1 screen-static poll (budget 3000 ms, matching Maestro's `SCREEN_SETTLE_TIMEOUT_MS`) → tier 2 snapshot-hash equality polling.
- **Snapshot hash:** normalize the flat node list to `(testID, role, text, label, rounded bounds/4px)` tuples, hash. Rounding absorbs sub-pixel animation jitter that strict equality (Maestro's choice) would treat as motion. Hash computation reuses the snapshot path that already feeds the ref-map, so a settle call also *refreshes the ref-map for free* — that freshness is what Story 05 consumes.
- Capability-driven: tiers only run when `/health.capabilities` advertises them (Story 02); a legacy runner degrades to snapshot-polling only.

### Wiring

- `runNative()` already knows which verbs mutate (`SNAPSHOT_MUTATING_VERBS`, `agent-device-wrapper.ts:265-277` — it uses them to dirty the snapshot cache). After a mutating verb succeeds, call `waitForSettle` and attach `meta.timings_ms.settle` + `meta.settle.method`.
- `device_fill`: skip the fixed `FOCUS_DELAY_MS=150` tap→fill delay whenever the pre-tap's envelope carries `meta.settle` (the 150ms constant survives ONLY as the settle-less fallback — `RN_SETTLE=0` or a legacy-path failure); keep read-back verification unchanged (it verifies *content*, settle verifies *stability* — complementary). As implemented (#385), the fill also pins its target coords once up front (`--at-x/--at-y`) so the settle's ref-map refresh cannot retarget it mid-call, and corrective retypes skip settle (their stability check is the read-back).
- `device_batch`: settle between steps by default (batch-scoped 2500ms budget); per-step `settle: false` escape hatch.
- Timeout budget arithmetic: adopt Maestro's `adjustedToLatestInteraction` trick (`Orchestra.kt:1646-1649`) — a slow settle eats into the *next* lookup's budget rather than stacking timeouts. **Deferred to Story 05** (#385 shares one budget across tiers *within* a settle; cross-tool carryover needs the interaction clock Story 05's re-resolution loop introduces).
- Env `RN_SETTLE=0` global opt-out; per-call `settleTimeoutMs` override.

## Implementation steps

1. Runner endpoints (Swift + Kotlin) + capability advertising + runner-side unit tests for the pure comparison logic.
2. `settle.ts` with injected transport (fully unit-testable with scripted probe sequences).
3. `runNative` integration behind `RN_SETTLE` flag; `device_fill` and `device_batch` adoption; timings surfaced.
4. Remove/deprecate scattered fixed sleeps (each removal gets its own commit for bisectability).

## Acceptance criteria

- After `device_press` on a button that opens a new screen: the tool returns only once the target screen is static; `meta.settle.method` recorded; no fixed sleeps execute on the settle-enabled press/fill paths. Two documented exceptions: the 150ms focus constant survives as the settle-less fallback (`RN_SETTLE=0` or legacy-path failure), and the Android clipboard-workaround path keeps its 300ms sleep (upstream of the dispatch choke point — explicit follow-up in the #385 plan).
- On a static screen, settle overhead ≤ 150 ms on Android (window-gate short-circuit) and ≤ ~250 ms on iOS (one screen-static probe).
- On the Reanimated fixture (Story 03): settle returns `method: 'timeout'` at budget rather than hanging — a perpetually-animating screen must degrade gracefully, matching Maestro's bounded loops.
- `device_batch` TaskWizard walk passes with zero step-transition races across 10 consecutive runs (currently flaky without manual waits).

## Test plan

- Unit: probe-sequence matrix (static-immediately / static-after-N / never-static / capability-absent fallbacks / budget exhaustion); hash normalization (jitter under 4 px settles, real transition does not).
- Integration: fake-runner harness serving scripted `/isScreenStatic` sequences.
- Live: 10× repeated TaskWizard batch walk on both platforms, before/after flake counts recorded in the PR.

## Risks & open questions

- **Perpetual animations** (spinners, shimmer): screen-static never true → tier 2 snapshot-hash usually still settles (hierarchy stable even while pixels move) — this is why hierarchy equality is the final tier on both platforms, and why the bounded budget + `method: 'timeout'` outcome exists.
- **Cost of settle screenshots on iOS:** on-runner SHA comparison avoids shipping images to the host (Maestro's exact split: runner hashes, host only gets a boolean).
- Should `cdp_interact` (JS-path mutations) also settle? Yes — it already dirties the snapshot cache via `trackedTool` (`index.ts:283-300`); route it through the same `waitForSettle` when a device session is open. Deferred to a follow-up if scope grows.
