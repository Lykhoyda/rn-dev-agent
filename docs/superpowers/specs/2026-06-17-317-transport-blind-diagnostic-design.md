# GH #317 — Phase 1: `TRANSPORT_BLIND` diagnostic (cdp_repair_action guard)

**Status:** Approved (2026-06-17)
**Issue:** [#317](https://github.com/Lykhoyda/rn-dev-agent/issues/317) — iOS 26.2 + bridgeless + react-native-actions-sheet: Maestro/WDA reads an empty a11y tree → all `maestro_run`/`cdp_run_action` fail at the first selector, while rn-fast-runner sees everything (`kano:must-be`, `priority:now`, `effort:l` overall — this spec is the small, unblocked first slice).

## Problem

On iOS 26.2 + bridgeless (new architecture) running an Expo Dev Client, WebDriverAgent/XCTest reads an **empty or partial accessibility tree** for the app. Every Maestro-driven call (`maestro_run`, `cdp_run_action`) therefore fails at the first `extendedWaitUntil`/`tapOn` with `Element '#<testID>' not visible`, even though the in-tree **rn-fast-runner** (`device_snapshot`) sees and interacts with the exact same element by the exact same testID milliseconds earlier.

When a flow fails this way, `cdp_run_action` calls `cdp_repair_action`. Repair takes its **own** rn-fast-runner snapshot (`runNative(['snapshot','-i'])` — `repair-action.ts:251`), fails to confidently match the failed selector, and returns:

> `no confident replacement for "<X>". No candidate scored at or above 0.6` (code `TESTID_NOT_FOUND`, `repair-action.ts:317–329`)

This message is **actively misleading**: it tells the user the testID drifted, sending them toward testID-drift debugging, when the real cause is a blind transport (WDA sees 0 nodes). #317 calls this out directly: *"auto-repair is misleading here: the real cause is 'WDA sees 0 nodes' but it reports 'no confident replacement'."*

A second, latent harm hides in the same case. `attemptRepair` first **removes the failed selector from the candidate pool** (`repair-engine.ts:274` — `candidates.filter(c => c !== failedSelector)`), then fuzzy-matches the failed selector against *the remaining* testIDs. So when the screen genuinely renders the element (transport-blind), repair never even considers it. Two outcomes follow: **(a)** nothing else clears the 0.6 threshold → the misleading "no confident replacement" above (the actual #317 symptom); or worse, **(b)** some *unrelated* testID happens to score ≥ 0.6 → repair silently patches `X → Y`, **corrupting the action with the wrong selector** and demoting it, while the real cause is the blind transport. A guard placed *before* `attemptRepair` prevents both.

## Why the bridge cannot see WDA directly

`maestro-runner` is invoked via `execFile` (`maestro-run.ts:206–218`) and returns **only stdout/stderr text** — no node counts, no view hierarchy. There is no WDA/XCUIElement tree exposed anywhere inside the bridge. So "WDA is blind" can never be **observed** directly; it can only be **inferred** by comparing what Maestro reported against a transport we *can* read: the rn-fast-runner snapshot that `cdp_repair_action` already takes. The transport disagreement is the signal.

## Scope (chosen)

**repair-action guard only**, exact-present hard verdict + soft hint. One detection point, zero new device round-trips (reuses the snapshot repair already takes), fully unit-testable without iOS 26.2 hardware.

1. **Hard verdict `TRANSPORT_BLIND`:** when the failed selector is *used by the action body* **and** present **verbatim** in the rn-fast-runner snapshot's testID set — we see it, Maestro didn't — emit `TRANSPORT_BLIND` instead of reporting `TESTID_NOT_FOUND`. Unambiguous; near-zero false positives. (The body-membership condition preserves the existing `BAD_FILENAME` "your hint is wrong" diagnostic: a hint not in the body but coincidentally on-screen must not be mislabeled transport-blind — plan-review finding #1.)
2. **Soft hint:** on the existing no-confident-match path (selector absent, other candidates present), keep the `TESTID_NOT_FOUND` verdict but **append** a line naming transport-blindness as a possibility to verify with `device_snapshot`. Message-only; no verdict change.
3. **`cdp_run_action` integration:** treat `TRANSPORT_BLIND` as a **terminal refusal** (no retry), record it in `autoRepair` telemetry as `refused / transport_blind`, and surface the diagnostic.

### Explicitly out of scope (Phase 2+)

- Routing action replay through rn-fast-runner when WDA is blind (the larger effort:L piece; needs the real repro stack to device-verify).
- Any `maestro_run` hot-path probe / failure-path snapshot.
- Fuzzy or heuristic transport-blind verdicts (e.g. "populated tree + ≥0.95 near-match"). Exact-present only, to avoid relabeling genuine testID drift.
- The unrelated secondary items in #317 (WDA boot dismissing an open actions-sheet; `device_screenshot` simctl-transition flakiness; `clearState` Dev Client relaunch). Tracked separately.

## Architecture

```
cdp_run_action (run-action.ts)
  └─ on flow failure → cdp_repair_action
        │
cdp_repair_action  (tools/repair-action.ts)
  ├─ snapEnvelope = runNative(['snapshot','-i'])           rn-fast-runner snapshot (existing)
  ├─ RUNNER_LEAK sentinel check                            (existing)
  ├─ candidates = extractAllTestIDs(snapEnvelope)          (existing, repair-engine.ts:103)
  ├─ if candidates.length === 0 → TESTID_NOT_FOUND         (existing — we see nothing either)
  ├─ ⟢ NEW: if detectTransportBlind(failedSelector, candidates)
  │        → failResult(msg, 'TRANSPORT_BLIND', meta)      hard verdict, before attemptRepair
  ├─ result = attemptRepair(action, failedSelector, candidates, threshold)   (existing)
  └─ if result.kind === 'no-match'
         → failResult(msg + ⟢ NEW soft transport-blind hint, 'TESTID_NOT_FOUND', meta)

repair-engine.ts
  └─ ⟢ NEW: detectTransportBlind(failedSelector, candidates: string[]): boolean
            normalize selector (id:/# decoration → bare testID, case-sensitive)
            return candidates includes the normalized testID (verbatim)

types.ts
  └─ ⟢ NEW: ToolErrorCode |= 'TRANSPORT_BLIND'   // GH #317
```

The new check is placed **after** `extractAllTestIDs` (so `candidates` exists) and the empty-snapshot guard, but **before** `attemptRepair` — so the exact-present case short-circuits to the truth instead of letting `attemptRepair` filter the selector out and then either mislead (no-match) or mis-patch (`X → Y`).

A drifted selector (genuinely renamed) is **absent** from the new snapshot, so `candidates` never contains it → the guard stays silent and real drift still flows to `attemptRepair`. This makes exact-present a clean discriminator between transport-blindness and drift.

## Components

### `src/types.ts`
Add `'TRANSPORT_BLIND'` to the `ToolErrorCode` union (near `TESTID_NOT_FOUND` / `SNAPSHOT_FAILED` / `RN_FAST_RUNNER_DOWN`, `types.ts:200–273`), with a `// GH #317` comment.

### `src/domain/repair-engine.ts` (new pure helper)
```
detectTransportBlind(failedSelector: string, candidates: string[]): boolean
```
- Takes the same `candidates` array `cdp_repair_action` already builds from `extractAllTestIDs` (used today as `candidates.length` / `candidates.slice(0,50)`).
- Returns whether `failedSelector` appears **verbatim** in `candidates` (case-sensitive — testIDs are case-sensitive). Build a `Set` internally for O(1) membership if preferred.
- **No normalization needed:** `failedSelector` is already a bare testID by contract. `maestro-error-parser` captures the inner value (`selector: m[2]`, no `#`/`id:` decoration), and `attemptRepair` already compares it verbatim against bare testIDs (`candidates.filter(c => c !== failedSelector)`, `extractIdSelectors(body).includes(failedSelector)`). Verbatim membership keeps this helper consistent with that existing contract.
- Pure, no I/O → trivially unit-testable.

### `src/tools/repair-action.ts`
- Call `detectTransportBlind(args.failedSelector, candidatesSet)` after the empty-snapshot guard, before `attemptRepair`.
- On `true`, return `failResult(message, 'TRANSPORT_BLIND', meta)` where `meta` carries:
  - `failedSelector`
  - `snapshotTestIdCount` (the `N` rn-fast-runner saw)
  - `actionId`
  - the message below.
- On the existing `no-match` branch, append the soft hint to the message (verdict stays `TESTID_NOT_FOUND`).

### `src/domain/reusable-action.ts`
Add `'TRANSPORT_BLIND'` to the `AutoRepairRefusedReason` union (`reusable-action.ts:155`) so the refusal reason can be recorded honestly in `RunRecord.autoRepair`.

### `src/tools/run-action.ts` (`cdp_run_action`)
A non-patched repair is **already terminal** here — `run-action.ts:377–407` maps the reason, persists a `RunRecord`, and returns; there is no retry loop. So "no retry on `TRANSPORT_BLIND`" is the *existing* behavior. Two wiring changes:
- **`mapRefusedReason`** (`run-action.ts:166`): add `if (repairCode === 'TRANSPORT_BLIND') return 'TRANSPORT_BLIND';` — otherwise it falls through to `INTERNAL_ERROR` (the same gap that affected `RUNNER_LEAK`).
- **The refusal return** (`run-action.ts:397–406`): when `refusedReason === 'TRANSPORT_BLIND'`, return the result with code `'TRANSPORT_BLIND'` (not the hardcoded `'TESTID_NOT_FOUND'`) so `cdp_run_action`'s own envelope is honest; the detailed message flows through `repairEnv.error`.

## The diagnostic message (the actual UX)

Hard verdict (`TRANSPORT_BLIND`):

> `TRANSPORT_BLIND: Maestro/WDA reported "<X>" not visible, but rn-fast-runner sees it (N testIDs in the live snapshot). This is transport-blindness, not testID drift — WDA reads an empty/partial accessibility tree on this runtime (e.g. iOS 26.2 + bridgeless, GH #317). Maestro-based replay (maestro_run/cdp_run_action) is blocked here; drive the screen with device_* primitives (device_find/press/fill), which go through rn-fast-runner and work. rn-fast-runner-native action replay is tracked in #317 Phase 2.`

Soft hint (appended to the existing `no confident replacement` message):

> `If "<X>" is in fact correct and the screen renders, WDA may be transport-blind on this runtime (empty a11y tree; see GH #317) — confirm with device_snapshot, which uses rn-fast-runner.`

## Testing (TDD, `node:test` + `node:assert/strict`)

All tests are pure-helper or handler-level with synthetic snapshot envelopes — **no device required**. Test files alongside existing repair tests in `scripts/cdp-bridge/test/unit/` (e.g. `audit-b3-repair-grammar.test.js` style; imports from compiled `../../dist/...`).

`detectTransportBlind` (pure):
1. exact-present (`X` in candidates) → `true`.
2. selector absent, other candidates present → `false`.
3. empty candidate set → `false`.
4. case-sensitivity — `Submit` against candidate `submit` → `false` (testIDs are case-sensitive; verbatim match).

`cdp_repair_action` handler:
5. exact-present → returns code `TRANSPORT_BLIND` (not `TESTID_NOT_FOUND`), `meta.snapshotTestIdCount` correct, message names the selector + `N`.
6. selector absent, candidates present, best score < 0.6 → still `TESTID_NOT_FOUND`, message **includes the soft hint**.
7. empty snapshot (0 testIDs) → stays `TESTID_NOT_FOUND` (genuinely not transport-blind — we see nothing either).
8. exact-present case does **not** invoke a no-op `X → X` repair/retry (guard short-circuits before `attemptRepair`).

`cdp_run_action`:
9. `TRANSPORT_BLIND` from repair ⇒ no flow retry; `autoRepair` telemetry records `refused / transport_blind`; diagnostic surfaced.

## Acceptance criteria

- `cdp_repair_action` returns `TRANSPORT_BLIND` (with actionable message + `snapshotTestIdCount`) whenever the failed selector is present verbatim in the rn-fast-runner snapshot.
- The no-confident-match path is unchanged except for the appended soft hint.
- `cdp_run_action` does not retry on `TRANSPORT_BLIND` and logs `refused/transport_blind`.
- No new device round-trips added; the existing snapshot is reused.
- All new unit tests pass; the full cdp-bridge suite stays green.
- A changeset is added; `dist/` is rebuilt and staged (tracked outputs).

## Notes / risks

- **False-positive containment:** the hard verdict fires only on a verbatim selector match in our own snapshot, so it cannot relabel a genuine drift (where the old selector is gone) as transport-blind. The ambiguous "no confident match" case keeps its drift-oriented verdict and only *gains* a hint.
- **Verbatim match is contract-consistent, not fragile:** `failedSelector` is already a bare testID (`maestro-error-parser` captures `m[2]`; `attemptRepair` compares it verbatim today), so a verbatim `includes` cannot drift out of step with the existing comparison. If that contract ever changed, drift repair would already be broken — this guard rides the same invariant.
- This slice does not *unblock* replay on iOS 26.2 — it stops the tooling from lying about *why* it's blocked and points at the working path. Restoring replay is Phase 2 (rn-fast-runner-native replay).
