# Honest `hittable` computation in the iOS snapshot path (GH #395, re-scoped)

**Date:** 2026-07-09
**Issue:** [#395](https://github.com/Lykhoyda/rn-dev-agent/issues/395) — originally "iOS modal subtrees report hittable=false → device_batch/find press paths refuse on modal screens"
**Status:** Approved design (Approach 1 of 3)
**Relates:** #396 (fixed the refusal half), #383/#418 (runner artifact staleness gates), Story 13 Phase 3 (#397 — this issue is the documented PR 2 precondition), Story 16 (#409 — snapshot honesty, capture side)

## Re-scope: what #395 actually is today

The issue as filed had two halves. Investigation (2026-07-07, iPhone 17 / iOS 26.5 / test-app) showed one half is already fixed and the other is broader than reported:

1. **The refusal no longer reproduces.** `device_batch` press steps by testID on the TaskWizard modal and `device_find action=click` on modal controls all succeed. The error message quoted in the issue ("Element at ref … no longer hittable — UI re-rendered since snapshot") is emitted by the **stale-ref path** (`staleRefFail` in `agent-device-wrapper.ts`, `_staleRef` in `rn-fast-runner-client.ts`) — not by any hittability gate. The actual cause was the `@@ref` double-prefix bug fixed by #396 (PR #401): `findRefByTestID` passed `@e68` through, batch composed `@@e68`, the ref-map missed, and the failure surfaced with the misleading "no longer hittable" wording. There is **no gate anywhere in the tap path that refuses on `hittable=false`**: Swift `activateElement` (`RnFastRunnerTests+Interaction.swift:70-78`) already falls back to a coordinate tap on the element's frame center, and the TS press paths (`pressCandidate`, `device_batch` press) tap by ref-map coordinates.

2. **The data defect is real and affects ALL screens, not just modals.** Raw runner snapshots (`snapshot raw:true`) show `computedSnapshotHittable` (`RnFastRunnerTests+Snapshot.swift:284-301`) marks essentially every node `hittable=false`:
   - TaskWizard modal: 85/85 nodes `false` — including fully visible `wizard-next-btn`, `wizard-title-input`.
   - Plain Tasks screen (no modal): all 226 nodes `false` — including `fab-create-task`, every tab button, every task row.

   Root cause, verified by replaying the exact algorithm against the raw tree: the occlusion loop treats **any later-in-tree node whose frame contains the target's center** as an occluder (`isOccludingType` only exempts `.application`/`.window`). Real RN apps always carry trailing full-screen *transparent* containers — gesture-handler root views, portal hosts, collapsed bottom-sheet wrappers (one on the Tasks screen is a full-screen container labeled "Bottom Sheet") — so everything painted before them is declared occluded.

3. **The occlusion check cannot serve its intended purpose at all.** When an RN `Modal` is open it gets its own `UIWindow`; XCTest exposes only the frontmost window's content, so elements genuinely hidden under a modal are **not in the tree** to be marked. The only thing the loop ever catches is transparent same-window containers — i.e., the flag is pure noise.

### Blast radius of the noise

- `device_find` candidate ranking: `hittable === true` is worth +1000 (`device-interact.ts:117`) — never fires, so ranking degrades to type priority alone.
- `device_batch` annotates `hittable: false` as "surface dead controls" (`device-batch.ts:123`) — fires on everything, telling LLM agents every control is dead.
- Any agent reading `device_snapshot` output concludes nothing on screen is tappable.

## Design (Approach 1: drop the occlusion term)

### 1. New predicate

In `RnFastRunnerTests+Snapshot.swift`, `computedSnapshotHittable` becomes:

```
hittable = snapshot.isEnabled
        ∧ frame is non-null and non-empty
        ∧ viewport.contains(frame center)
```

The occlusion loop is deleted, along with the machinery that exists only to feed it: the `laterNodes` parameter, `laterSnapshots(for:in:ranges:)`, `isOccludingType`, and the `flatSnapshots`/`snapshotRanges` fields of `SnapshotTraversalContext` (+ `flattenedSnapshots` if nothing else uses it).

This preserves the two genuinely useful signals confirmed on-device:
- **Off-screen** nodes stay `false` — wizard steps 2/3 sit at x=402..1206 (outside the 402-wide viewport), and their controls (`wizard-priority-low` etc.) correctly report `false` via center-not-in-viewport, with zero occluders involved.
- **Disabled** nodes stay `false` via `isEnabled`.

The collapsed-tab fallback path (`RnFastRunnerTests+Snapshot.swift:583`) keeps using real `XCUIElement.isHittable` — that is the real XCTest API queried on a live element, not the snapshot heuristic, and is out of scope.

Semantics statement for the field going forward: `hittable` means **"enabled and its center is on-screen"** (plausibly tappable), not "verified front-most". Front-most verification is unrepresentable from `XCUIElementSnapshot` data (no opacity, occluded-by-modal content absent from the tree).

### 2. Decouple snapshot filtering from the emitted flag

`shouldInclude` currently takes `hittable` and uses it in two rules:
- compact: exclude contentless single-child `.other` only when `!hittable`; include when `hasContent || hittable`
- interactiveOnly: include when `hittable && type != .other`

Feeding the new permissive value into these rules would bloat compact/interactiveOnly snapshots with enabled on-screen wrapper nodes. But because the flag is ~always `false` today, the *de-facto* current filter is content/type-based only. So: **remove `hittable` from `shouldInclude`'s inputs entirely**, making today's effective behavior explicit:
- compact `.other` exclusion rule drops the `&& !hittable` term.
- compact include rule becomes `hasContent`.
- interactiveOnly drops the `hittable && type != .other` arm (scrollable-container, `interactiveTypes`, and `hasContent` arms already carry the real inclusion work).

Result: snapshot shapes and sizes stay as they are today (modulo the rare trailing nodes that happened to compute `true` under the old algorithm), and the emitted `hittable` field is free to carry the new meaning.

### 3. TS consumers — no code changes, better data

- `device_find` ranking (+1000) starts discriminating on-screen-enabled vs off-screen/disabled again.
- `device_batch`'s `hittable: false` annotation only fires for genuinely disabled/off-screen controls.
- `settle-hash` includes `hittable` per node — unaffected: both sides of any settle comparison run the same algorithm within one session.
- Ref-map / stale-ref healing: unaffected (identity-based, doesn't read `hittable`).

### 4. Android parity — verify, don't assume

`rn-android-runner` also emits `hittable` (`rn-android-runner-client.ts:969` maps it). Read the Kotlin source and device-check a raw snapshot on the emulator. Expected: UIAutomator's `isVisibleToUser`-backed value is already honest → no change. If the Android runner turns out to compute its own occlusion heuristic with the same defect, fix it with the same predicate in a follow-up commit within this branch (same semantics statement).

### 5. Rollout / artifact staleness

Behavior-only Swift change: no wire-shape change (`PROTOCOL_VERSION` unchanged), no new command verbs (the #418 `missing-commands` gate won't trigger). Confirm what the #383 version gate keys on: if a prebuilt DerivedData artifact would keep serving the old flag silently after plugin upgrade, bump the runner version constant the liveness gate compares so the standard "runner upgraded (protocol/version mismatch)" restart+rebuild path picks the change up. This must be settled in the implementation plan, not left to chance.

### 6. Testing

- **Swift unit tests** (Story 06 Phase A native-test rig) for the new predicate: on-screen enabled → `true`; disabled → `false`; center off-viewport → `false`; empty/null frame → `false`. Plus `shouldInclude` cases pinning that filtering is hittable-independent.
- **TS suite**: existing contract fixtures keep passing (payload shape unchanged). Update any fixture that encodes the old always-false expectation.
- **Device verification** (test-app, iOS simulator):
  - TaskWizard modal raw snapshot: visible controls (`wizard-next-btn`, `wizard-title-input`, `wizard-back-btn`) report `true`; off-screen step-2/3 controls report `false`.
  - Tasks screen raw snapshot: `fab-create-task`, tab buttons report `true`.
  - Node-count comparison before/after for default (`interactiveOnly`) and compact snapshots — proves no bloat from the filtering decoupling.
  - `device_find` on an ambiguous label: confirm ranking now prefers the on-screen hittable candidate.
- **Android device check** (parity step): raw snapshot on the emulator; assert interactive elements don't report a uniform `false`.

### 7. Error handling

None new — this is a pure computation change inside snapshot capture. No new failure modes; snapshot capture failure paths are untouched.

## Out of scope

- No coordinate-tap gate changes (no gate refuses on `hittable`; Swift `activateElement` fallback already exists).
- No Android behavior change unless the parity check finds the same defect.
- No `device_find` ranking-weight retuning.
- No changes to the `XCUIElement.isHittable`-based collapsed-tab fallback.
- Story 16 (#409) quality verdicts — related honesty work, separate story.

## Alternatives considered

- **Refine the occluder predicate** (occluders must have content / interactive type; exempt full-viewport rects): still demonstrably broken — the Tasks screen's full-screen "Bottom Sheet"-labeled container passes any content-based predicate and would keep occluding everything. Heuristic whack-a-mole; rejected.
- **Probe real `XCUIElement.isHittable` per node**: ground truth, but each probe is a per-element XCTest query (internally re-snapshots); seconds of added latency on 200-node trees even with the quiescence bypass. Bounded top-N probing reintroduces "which N" heuristics. Rejected.

## Closure notes for GH #395

When this ships, the issue closes with: (a) refusal half — fixed by #396, device-verified 2026-07-07; (b) data half — fixed here with the new `hittable` semantics. Story 13 Phase 3's PR 2 precondition is satisfied by (a) + (b).
