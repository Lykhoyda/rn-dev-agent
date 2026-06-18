# GH #317 — Phase 2: CDP/JS action-replay fallback

**Status:** Approved (2026-06-19)
**Issue:** [#317](https://github.com/Lykhoyda/rn-dev-agent/issues/317) — iOS 26.x + bridgeless: Maestro/WDA reads an empty accessibility tree, so `cdp_run_action`/`maestro_run` fail at the first selector.
**Builds on:** Phase 1 (`TRANSPORT_BLIND` diagnostic, merged #330) — which *detected and named* the blindness but explicitly deferred restoring replay. This phase restores replay for **actions**.

## Problem

On iOS 26.x bridgeless, WebDriverAgent (the transport behind `maestro-runner`) reads an empty/partial accessibility tree, so every `tapOn`/`assertVisible` in an action flow fails with `SELECTOR_NOT_FOUND`. The observe Regression **Run** button and `cdp_run_action` therefore cannot replay any action on this runtime — verified live: `cycle-task-priority` reached `maestro-runner 1.0.9` on the booted iPhone 17 (iOS 26.5), spent ~40s in WDA, then failed at the first selector.

**Verified feasibility (spike, 2026-06-19):** the same screen, the same testIDs, were driven successfully via **CDP/JS** — `cdp_interact press onboarding-skip` → `onboarding-done` advanced the app from route `Onboarding` → `Tabs › HomeTab › HomeMain`. `cdp_interact` calls the React `onPress` handler through the JS fiber tree and does **not** touch the native accessibility tree, so it is unaffected by #317.

**Phase 1's detection gap.** Phase 1 inferred blindness by comparing maestro's failure against an **rn-fast-runner** snapshot. In the live repro rn-fast-runner was itself down (`rnFastRunner: dead`, repair returned `SNAPSHOT_FAILED` / "agent-device unreachable"), so the Phase 1 `TRANSPORT_BLIND` verdict never even fired. The detection oracle for this phase therefore moves to the **CDP component tree** — the same transport we replay through, so detection and execution share one dependency and cannot disagree.

## Scope (chosen)

**Actions only** (`cdp_run_action` and, through it, the observe Regression Run button). Reactive trigger. Replay through CDP/JS. Narrowest viable slice; actions already carry structured, testID-based steps, which map cleanly onto `cdp_interact`.

### Explicitly out of scope (Phase 2)
- `maestro_run` / `maestro_test_all` / the locked-e2e suite fallback (they take arbitrary YAML, not just action steps). Scope is actions.
- Proactive blind-probe before maestro (reactive only — the ~40s doomed maestro attempt is accepted; a later probe can reclaim it without redesign).
- Maestro step types **not used by any current action**: `scroll`, `scrollUntilVisible`, `swipe`, `assertNotVisible`, `extendedWaitUntil`, coordinate taps, `pressKey`, `copyTextFrom`, etc. Add per-step when an action needs it; until then they hit the `UNSUPPORTED_STEP` guard.
- Android (the empty-a11y-tree regression is iOS 26.x).

## Trigger (reactive)

```
runActionHandler (cdp_run_action)
 ├─ maestro attempt (today)
 ├─ pass → done                                    ← healthy-OS path UNCHANGED
 └─ fail with SELECTOR_NOT_FOUND:
      ├─ isTransportBlindViaCdp(failedSelector)     ← failed testID present in CDP component tree?
      │     no  → existing repair / drift / fail    ← UNCHANGED
      │     yes → replayActionViaCdp(steps, params) ← NEW
      └─ map replay result → verdict + RunRecord(transport:'cdp-js')
```

Healthy OSes never reach the new branch (maestro passes). A genuinely-drifted selector is absent from the CDP tree too, so `isTransportBlindViaCdp` returns `false` and real drift still flows to the existing repair path — exact-presence is the discriminator (same principle as Phase 1, different oracle).

## Architecture & components

### `src/domain/cdp-flow-replay.ts` (new — pure interpreter)
```
replayFlow(steps: ReplayStep[], params: Record<string,string>, dispatch: ReplayDispatch): Promise<ReplayResult>
```
- `ReplayStep` — typed union for the supported subset (below).
- `ReplayDispatch` — injected interface, no CDP/IO inside the interpreter:
  ```
  press(testID): Promise<void>
  type(testID, text): Promise<void>
  isVisible(testID): Promise<boolean>
  launch(opts: { stopApp: boolean }): Promise<void>
  settle(): Promise<void>                  // waitForAnimationToEnd
  ```
- `ReplayResult` — `{ passed: boolean; failedStepIndex?: number; reason?: string; steps: {type,target,ok}[] }`.
- Tracks `lastTappedTestID` so `inputText` (which maestro routes to the focused field) targets the most-recently-pressed element.
- Fully unit-testable with a mock `dispatch`.

### Step source
Parse the action's YAML body into `ReplayStep[]` by reading the body with the existing `yaml` dependency (the deterministic source of truth — `parseAndValidateFlow` is a validator, not a step extractor, so it is not used here). A small `normalizeSteps()` maps the raw YAML objects onto the typed `ReplayStep` union and rejects anything outside the supported subset (→ `UNSUPPORTED_STEP`). `${VAR}` placeholders in ids/text are interpolated from the already-resolved action params before dispatch.

### Dispatch implementation (in `run-action.ts`)
Concrete `ReplayDispatch` that calls the **underlying handler functions** — `createInteractHandler(getClient)` (press/typeText), `createComponentTreeHandler(getClient)` (isVisible by testID filter) — not the wrapped MCP tools, so the whole replay runs under the single arbiter lease `cdp_run_action` already holds (composite-tool rule). `launch` uses the existing simctl-launch helper.

### `isTransportBlindViaCdp(getClient, failedSelector): Promise<boolean>`
The CDP-tree oracle. **Exact-match required, not "filter returned something."** `cdp_component_tree`'s `filter` is a broad **case-insensitive substring** match across component name / testID / nativeID / accessibilityLabel, so a filtered hit is NOT proof of presence — a substring, label, or component-name coincidence would route genuine drift into CDP replay. The oracle therefore parses the returned nodes and returns `true` only when some node's `testID` (or `nativeID`) is **verbatim equal** to `failedSelector` (case-sensitive — testIDs are case-sensitive, consistent with Phase 1's `detectTransportBlind`). Same-key equality, never substring.

### Telemetry — `RunRecord`
Add an **optional** `transport?: 'cdp-js'`, recorded **only on fallback runs**. Maestro (healthy) runs omit the field entirely, so existing run-history JSON and any consumers/snapshots are unchanged — this is what preserves the byte-for-byte healthy-path guarantee in the acceptance criteria. Absence of the field ⇒ maestro. The existing `autoRepair`/outcome fields reflect the CDP replay outcome.

## Step → CDP mapping (complete for all 7 current actions)

| Maestro step (only these exist in actions) | CDP/JS op |
|---|---|
| `launchApp` (`stopApp: true\|false`) | `simctl launch <udid> <appId>`; `stopApp:true` terminates first, `false` foregrounds in place |
| `tapOn: {id}` | `dispatch.press(id)` → set `lastTapped = id` |
| `inputText: "<text>"` | `dispatch.type(lastTapped, text)`; error if no prior `tapOn` |
| `assertVisible: {id}` | `dispatch.isVisible(id)` → fail the step if absent |
| `runFlow: {when:{visible:{id}}, commands:[…]}` | if `isVisible(id)` → recurse into `commands`; else skip the block |
| `waitForAnimationToEnd` | `dispatch.settle()` — bounded (poll tree stable, cap ~2s) |
| `${VAR}` inside an id or text | interpolate from resolved params before dispatch |

## Error handling / fidelity (safety rules)

- **Unsupported step type → hard `UNSUPPORTED_STEP` error; never a silent pass.** A regression runner that skips steps and reports green is worse than useless. This is non-negotiable.
- **Handler-level verdict semantics (honest labeling).** A CDP/JS replay calls the component's React handler directly, bypassing native interaction gates a real tap (or WDA) enforces: `disabled` controls, overlays / `pointerEvents:'none'`, off-screen position, gesture-responder arbitration, keyboard focus. A CDP-replay pass therefore means *"the handlers fired and the asserted state was reached,"* NOT *"a user could physically perform this."* Fallback verdicts carry `transport:'cdp-js'` precisely so they are never mistaken for native-fidelity passes; the diagnostic message says so.
- **Disabled / non-interactable guard.** Before `press`/`type`, the dispatch inspects the target node's props for `disabled === true` or `accessibilityState.disabled === true` (and `pointerEvents:'none'` where readable) and **fails the step** instead of firing the handler — so a CDP replay cannot silently "pass" by pressing a control a user couldn't. Best-effort: limited to props observable in the fiber tree (it cannot detect an opaque sibling overlay that isn't expressed as a prop — a known limitation of handler-level replay, documented under Risks).
- `assertVisible` "visible" = testID present in the fiber tree (rendered), **not** pixel visibility. Documented approximation; adequate for actions, which assert state milestones.
- A testID genuinely absent mid-replay (a real tap/assert target missing) → **genuine failure**, reported as a normal flow failure — *not* relabeled transport-blind.
- `inputText` with no prior `tapOn`, or CDP not connected → error. Never fabricate a verdict.
- New `ToolErrorCode`s as needed: `UNSUPPORTED_STEP` (and reuse `TRANSPORT_BLIND`).

## Testing (TDD; units require no device)

Pure / handler-level with mocks — alongside existing tests in `scripts/cdp-bridge/test/unit/`, importing from compiled `../../dist/...`:

1. **Step parser** — YAML subset → typed steps; `${VAR}` interpolation; nested `runFlow.commands`.
2. **Replay engine** (mock dispatch): each step → correct op; `runFlow` when-visible true→recurse / false→skip; `inputText` targets `lastTapped`; `assertVisible` present→pass / absent→fail; unsupported step → `UNSUPPORTED_STEP`; real-missing testID → fail (not blind).
3. **Detection oracle (exact-match)** — exact testID present → `true`; testID **absent** → `false`; empty tree → `false`; a node matching `failedSelector` only as a **substring / accessibilityLabel / component-name** (no verbatim testID) → `false` (must not misfire on the broad filter).
4. **Handler-level** — maestro fails `SELECTOR_NOT_FOUND` + exact testID in CDP tree → replay invoked → pass; `RunRecord.transport === 'cdp-js'`; a healthy maestro **pass** persists **no** `transport` field (byte-for-byte guarantee); maestro fails + testID **absent** → existing repair path, replay NOT invoked.
5. **Negative (no false green)** — a target whose props mark it `disabled` / `accessibilityState.disabled` → the dispatch **fails the step**, does not fire the handler, run reported **fail** — proving CDP replay cannot silently pass an invalid interaction.
6. **Device verification** — replay an existing action (`cycle-task-priority`, then a mutating one like `toggle-theme`) on the iOS 26.5 sim end-to-end → **PASS via CDP/JS**. This is the real proof the phase exists for.

## Acceptance criteria

- On iOS 26.x, a failing-via-WDA action whose testIDs are present in the CDP tree replays through CDP/JS and yields a real pass/fail verdict; the observe Run button shows the result.
- Healthy-OS behavior is byte-for-byte unchanged (maestro passes, new branch never entered).
- Genuine testID drift still routes to the existing repair path (unchanged).
- Unsupported step types fail loudly; no action is ever silently reported green with skipped steps.
- `RunRecord` records `transport: 'cdp-js'` for fallback runs.
- All new unit tests pass; full cdp-bridge suite stays green; oxlint + oxfmt clean; a changeset is added and `dist/` rebuilt + staged.
- Device-verified: at least one action replays green on the iOS 26.5 simulator.

## Notes / risks

- **Fiber-presence ≠ pixel-visibility.** A testID can be mounted but off-screen; `assertVisible` would pass. Accepted for actions (state-milestone asserts). If this bites, a later refinement can check layout/measure — out of scope now.
- **Handler-level replay can't see opaque native gates.** The disabled-guard catches `disabled`/`pointerEvents` expressed as props, but an opaque sibling overlay, a native modal intercepting touches, or a gesture-responder that would steal the touch are NOT expressed on the target node — so a CDP press can fire a handler a real finger couldn't reach. This is the inherent limit of handler-level replay; the `transport:'cdp-js'` label + honest verdict semantics are the mitigation, not a claim of native equivalence. A flow that genuinely depends on native-gesture fidelity should run on iOS 18 (full WDA) rather than the 26.x fallback.
- **`inputText` focus model.** Maestro types into the focused field; we approximate "focused" as "last `tapOn`ed testID." Holds for the tap-then-type pattern every current action uses; documented as a constraint of the supported subset.
- **`launchApp` foregrounding.** `simctl launch` of an already-running app foregrounds it with the same pid (resuming JS) — same mechanism the Phase 2b wedge-recovery already relies on.
- The reactive trigger keeps the ~40s doomed maestro attempt on 26.x; intentional (zero risk to the healthy path). A proactive probe is a later, redesign-free optimization.
