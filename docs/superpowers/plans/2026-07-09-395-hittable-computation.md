# Honest `hittable` Computation (GH #395) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the iOS runner's per-node `hittable` flag mean "enabled and its center is on-screen" instead of the current occlusion heuristic that marks every node `false` on real RN screens.

**Architecture:** Two new pure, unit-testable predicate functions (`computeSnapshotHittable`, `shouldIncludeSnapshotNode`) land in a new file in the `RnFastRunnerUITests` target; `RnFastRunnerTests+Snapshot.swift` is rewired to call them and the occlusion machinery (`laterSnapshots`, `flattenedSnapshots`, `isOccludingType`, the `flatSnapshots`/`snapshotRanges` context fields) is deleted. Snapshot *filtering* deliberately stops reading `hittable` (its de-facto behavior today, made explicit) so snapshot sizes don't change while the emitted flag gains its new meaning. No TypeScript code changes — TS consumers (`device_find` ranking, `device_batch` dead-control annotation) start receiving meaningful data for free.

**Tech Stack:** Swift/XCTest (`scripts/rn-fast-runner`), Node 22 + `node --test` (`scripts/cdp-bridge`), xcodebuild against a booted iOS simulator.

**Spec:** `docs/superpowers/specs/2026-07-09-395-hittable-computation-design.md`

## Global Constraints

- Branch: `fix/395-hittable-computation` (already created; spec committed as `3d53b580`).
- Node.js >= 22 LTS for the TS suite.
- New Swift files under `RnFastRunner/RnFastRunnerUITests/` auto-join the target (Xcode 16 `FileSystemSynchronizedRootGroup`) — do NOT edit `project.pbxproj`.
- The native iOS test script runs the whole `RnFastRunnerUITests` bundle minus a skip-list; new test classes run automatically (`scripts/test-native-ios.sh`).
- Semantics statement (copy verbatim into code comment and changeset): `hittable` means **"enabled and its center is on-screen"** (plausibly tappable), not "verified front-most".
- No new comments beyond the two semantics comments shown in Task 1 (project convention: no unnecessary comments).
- No wire-shape change: `RUNNER_PROTOCOL_VERSION` stays 1; no new command verbs; `REQUIRED_IOS_COMMANDS` untouched.
- Rollout is a no-op by construction: plugin releases install to per-version cache dirs (`~/.claude/plugins/cache/rn-dev-agent/rn-dev-agent/<version>/`), so each release cold-builds or downloads its own runner artifact (built from that release's sources by `.github/workflows/runner-artifacts.yml`). Only dev checkouts carry a stale `scripts/rn-fast-runner/build/DerivedData` across source edits — Task 5 deletes it before device verification.

---

### Task 1: Pure predicate `computeSnapshotHittable` + unit tests

**Files:**
- Create: `scripts/rn-fast-runner/RnFastRunner/RnFastRunnerUITests/SnapshotPredicates.swift`
- Test: `scripts/rn-fast-runner/RnFastRunner/RnFastRunnerUITests/SnapshotPredicatesTests.swift`

**Interfaces:**
- Consumes: nothing (pure function over `Bool`/`CGRect`).
- Produces: `func computeSnapshotHittable(enabled: Bool, frame: CGRect, viewport: CGRect) -> Bool` — internal (file-scope, no access modifier), callable from any file in the `RnFastRunnerUITests` target. Task 3 wires it into `evaluateSnapshot`.

- [ ] **Step 1: Write the failing test**

Create `scripts/rn-fast-runner/RnFastRunner/RnFastRunnerUITests/SnapshotPredicatesTests.swift`:

```swift
import XCTest

// GH #395: hittable = enabled ∧ non-empty frame ∧ center-in-viewport. These
// pure-logic tests pin the predicate the snapshot path emits per node.
final class SnapshotPredicatesTests: XCTestCase {
  private let viewport = CGRect(x: 0, y: 0, width: 402, height: 874)

  func testEnabledOnScreenIsHittable() {
    let frame = CGRect(x: 21, y: 790, width: 360, height: 49)
    XCTAssertTrue(computeSnapshotHittable(enabled: true, frame: frame, viewport: viewport))
  }

  func testDisabledIsNotHittable() {
    let frame = CGRect(x: 21, y: 790, width: 360, height: 49)
    XCTAssertFalse(computeSnapshotHittable(enabled: false, frame: frame, viewport: viewport))
  }

  func testEmptyFrameIsNotHittable() {
    XCTAssertFalse(computeSnapshotHittable(enabled: true, frame: .zero, viewport: viewport))
  }

  func testNullFrameIsNotHittable() {
    XCTAssertFalse(computeSnapshotHittable(enabled: true, frame: .null, viewport: viewport))
  }

  // The wizard step-2 pane sits at x=402..804 on a 402pt-wide viewport —
  // off-screen center must stay false (device-verified useful signal).
  func testCenterOutsideViewportIsNotHittable() {
    let frame = CGRect(x: 423, y: 290, width: 60, height: 39)
    XCTAssertFalse(computeSnapshotHittable(enabled: true, frame: frame, viewport: viewport))
  }

  func testInfiniteViewportFallbackIsHittable() {
    let frame = CGRect(x: 21, y: 790, width: 360, height: 49)
    XCTAssertTrue(computeSnapshotHittable(enabled: true, frame: frame, viewport: .infinite))
  }

  func testCenterExactlyOnViewportEdgeCounts() {
    let frame = CGRect(x: 302, y: 791, width: 200, height: 49)
    XCTAssertTrue(computeSnapshotHittable(enabled: true, frame: frame, viewport: viewport))
  }
}
```

(`testCenterExactlyOnViewportEdgeCounts`: center x = 302+100 = 402 = viewport max-x; `CGRect.contains` includes the max edge point only when the point equals origin+size on one axis — this documents actual `CGRect.contains` behavior. If the assertion fails on this Xcode, flip it to `XCTAssertFalse` and keep the test: its job is to pin the edge behavior, whichever way CGRect resolves it.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:native:ios` (from repo root; requires a booted or available iPhone simulator)
Expected: BUILD FAILURE — `cannot find 'computeSnapshotHittable' in scope` (compile error is the failing state for a missing Swift symbol).

- [ ] **Step 3: Write minimal implementation**

Create `scripts/rn-fast-runner/RnFastRunner/RnFastRunnerUITests/SnapshotPredicates.swift`:

```swift
import CoreGraphics
import XCTest

// GH #395: `hittable` means "enabled and its center is on-screen" (plausibly
// tappable), not "verified front-most". Front-most is unrepresentable from
// XCUIElementSnapshot data: RN modals get their own UIWindow (content under
// them is absent from the tree entirely) and same-window full-screen containers
// carry no opacity signal, so the old later-node occlusion loop only ever
// matched transparent wrappers and marked every node non-hittable.
func computeSnapshotHittable(enabled: Bool, frame: CGRect, viewport: CGRect) -> Bool {
  guard enabled else { return false }
  if frame.isNull || frame.isEmpty { return false }
  return viewport.contains(CGPoint(x: frame.midX, y: frame.midY))
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:native:ios`
Expected: PASS — all `SnapshotPredicatesTests` cases green (plus the pre-existing suites: `CommandSurfaceTests`, `KeyboardGuardTests`, `QuiescenceBypassTests`).

- [ ] **Step 5: Commit**

```bash
git add scripts/rn-fast-runner/RnFastRunner/RnFastRunnerUITests/SnapshotPredicates.swift \
        scripts/rn-fast-runner/RnFastRunner/RnFastRunnerUITests/SnapshotPredicatesTests.swift
git commit -m "feat(rn-fast-runner): pure computeSnapshotHittable predicate (#395)"
```

---

### Task 2: Pure predicate `shouldIncludeSnapshotNode` + unit tests

**Files:**
- Modify: `scripts/rn-fast-runner/RnFastRunner/RnFastRunnerUITests/SnapshotPredicates.swift`
- Test: `scripts/rn-fast-runner/RnFastRunner/RnFastRunnerUITests/SnapshotPredicatesTests.swift`

**Interfaces:**
- Consumes: nothing (pure function).
- Produces: `func shouldIncludeSnapshotNode(type: XCUIElement.ElementType, hasContent: Bool, childCount: Int, isScrollableContainer: Bool, isInteractiveType: Bool, visible: Bool, compact: Bool, interactiveOnly: Bool) -> Bool`. Task 3's `shouldInclude` instance method becomes a thin adapter over this. Note the signature has NO `hittable` parameter — that absence IS the decoupling.

- [ ] **Step 1: Write the failing tests**

Append to `SnapshotPredicatesTests.swift`:

```swift
// GH #395: filtering is hittable-independent by signature — these pin the
// de-facto content/type-based rules that always-false hittable produced.
final class SnapshotInclusionTests: XCTestCase {
  private func include(
    type: XCUIElement.ElementType = .other,
    hasContent: Bool = false,
    childCount: Int = 0,
    isScrollableContainer: Bool = false,
    isInteractiveType: Bool = false,
    visible: Bool = true,
    compact: Bool = false,
    interactiveOnly: Bool = false
  ) -> Bool {
    return shouldIncludeSnapshotNode(
      type: type,
      hasContent: hasContent,
      childCount: childCount,
      isScrollableContainer: isScrollableContainer,
      isInteractiveType: isInteractiveType,
      visible: visible,
      compact: compact,
      interactiveOnly: interactiveOnly
    )
  }

  func testDefaultModeIncludesEverything() {
    XCTAssertTrue(include())
    XCTAssertTrue(include(type: .staticText, hasContent: false))
  }

  func testCompactExcludesContentlessSingleChildOther() {
    XCTAssertFalse(include(childCount: 1, compact: true))
    XCTAssertFalse(include(childCount: 0, compact: true))
  }

  func testCompactExcludesContentlessOtherEvenWithManyChildren() {
    XCTAssertFalse(include(childCount: 3, compact: true))
  }

  func testCompactIncludesContentfulNodes() {
    XCTAssertTrue(include(hasContent: true, compact: true))
    XCTAssertTrue(include(type: .staticText, hasContent: true, compact: true))
  }

  func testCompactExcludesContentlessTypedNodes() {
    XCTAssertFalse(include(type: .image, compact: true))
  }

  func testInteractiveOnlyIncludesScrollableContainers() {
    XCTAssertTrue(include(type: .scrollView, isScrollableContainer: true, interactiveOnly: true))
  }

  func testInteractiveOnlyIncludesInteractiveTypes() {
    XCTAssertTrue(include(type: .button, isInteractiveType: true, interactiveOnly: true))
  }

  func testInteractiveOnlyIncludesContentfulNodes() {
    XCTAssertTrue(include(type: .staticText, hasContent: true, interactiveOnly: true))
  }

  func testInteractiveOnlyExcludesContentlessNonInteractive() {
    XCTAssertFalse(include(type: .image, interactiveOnly: true))
    XCTAssertFalse(include(interactiveOnly: true))
  }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:native:ios`
Expected: BUILD FAILURE — `cannot find 'shouldIncludeSnapshotNode' in scope`.

- [ ] **Step 3: Write minimal implementation**

Append to `SnapshotPredicates.swift`:

```swift
// GH #395: snapshot filtering deliberately ignores `hittable`. Under the old
// always-false computation these rules were de-facto content/type-based;
// keeping them that way pins snapshot sizes while `hittable` gains its new
// meaning. The signature having no hittable parameter is the contract.
func shouldIncludeSnapshotNode(
  type: XCUIElement.ElementType,
  hasContent: Bool,
  childCount: Int,
  isScrollableContainer: Bool,
  isInteractiveType: Bool,
  visible: Bool,
  compact: Bool,
  interactiveOnly: Bool
) -> Bool {
  if compact && type == .other && !hasContent && childCount <= 1 {
    return false
  }
  if interactiveOnly {
    if isScrollableContainer { return true }
    #if os(macOS)
      if !visible && type != .application { return false }
    #endif
    if isInteractiveType { return true }
    return hasContent
  }
  if compact { return hasContent }
  return true
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:native:ios`
Expected: PASS — `SnapshotPredicatesTests` + `SnapshotInclusionTests` green.

- [ ] **Step 5: Commit**

```bash
git add scripts/rn-fast-runner/RnFastRunner/RnFastRunnerUITests/SnapshotPredicates.swift \
        scripts/rn-fast-runner/RnFastRunner/RnFastRunnerUITests/SnapshotPredicatesTests.swift
git commit -m "feat(rn-fast-runner): hittable-independent shouldIncludeSnapshotNode predicate (#395)"
```

---

### Task 3: Wire predicates into the snapshot path; delete occlusion machinery

**Files:**
- Modify: `scripts/rn-fast-runner/RnFastRunner/RnFastRunnerUITests/RnFastRunnerTests+Snapshot.swift`

**Interfaces:**
- Consumes: `computeSnapshotHittable(enabled:frame:viewport:)` (Task 1), `shouldIncludeSnapshotNode(type:hasContent:childCount:isScrollableContainer:isInteractiveType:visible:compact:interactiveOnly:)` (Task 2).
- Produces: unchanged wire shape — `SnapshotNode.hittable: Bool` keeps its name/type; only its value semantics change. The two snapshot walkers (`snapshotFast` envelope path and `snapshotRaw`) both flow through `evaluateSnapshot` and `shouldInclude`, so one rewiring covers both.

- [ ] **Step 1: Slim `SnapshotTraversalContext` and its factory**

In `RnFastRunnerTests+Snapshot.swift`, replace the struct (currently lines 17-24):

```swift
  private struct SnapshotTraversalContext {
    let queryRoot: XCUIElement
    let rootSnapshot: XCUIElementSnapshot
    let viewport: CGRect
    let maxDepth: Int
  }
```

and replace `makeSnapshotTraversalContext` (currently lines 303-326):

```swift
  private func makeSnapshotTraversalContext(
    app: XCUIApplication,
    options: SnapshotOptions
  ) -> SnapshotTraversalContext? {
    let viewport = snapshotViewport(app: app)
    let queryRoot = options.scope.flatMap { findScopeElement(app: app, scope: $0) } ?? app

    let rootSnapshot: XCUIElementSnapshot
    do {
      rootSnapshot = try queryRoot.snapshot()
    } catch {
      return nil
    }

    return SnapshotTraversalContext(
      queryRoot: queryRoot,
      rootSnapshot: rootSnapshot,
      viewport: viewport,
      maxDepth: options.depth ?? Int.max
    )
  }
```

- [ ] **Step 2: Rewire `evaluateSnapshot` to the pure predicate**

Replace `evaluateSnapshot` (currently lines 328-348):

```swift
  private func evaluateSnapshot(
    _ snapshot: XCUIElementSnapshot,
    in context: SnapshotTraversalContext
  ) -> SnapshotEvaluation {
    let label = aggregatedLabel(for: snapshot) ?? snapshot.label.trimmingCharacters(in: .whitespacesAndNewlines)
    let identifier = snapshot.identifier.trimmingCharacters(in: .whitespacesAndNewlines)
    let valueText = snapshotValueText(snapshot)
    return SnapshotEvaluation(
      label: label,
      identifier: identifier,
      valueText: valueText,
      hittable: computeSnapshotHittable(
        enabled: snapshot.isEnabled,
        frame: snapshot.frame,
        viewport: context.viewport
      ),
      focused: snapshotHasFocus(snapshot),
      visible: isVisibleInViewport(snapshot.frame, context.viewport)
    )
  }
```

- [ ] **Step 3: Turn `shouldInclude` into an adapter and update both call sites**

Replace `shouldInclude` (currently lines 252-282):

```swift
  private func shouldInclude(
    snapshot: XCUIElementSnapshot,
    label: String,
    identifier: String,
    valueText: String?,
    options: SnapshotOptions,
    visible: Bool
  ) -> Bool {
    let type = snapshot.elementType
    return shouldIncludeSnapshotNode(
      type: type,
      hasContent: !label.isEmpty || !identifier.isEmpty || (valueText != nil),
      childCount: snapshot.children.count,
      isScrollableContainer: isScrollableContainer(snapshot, visible: visible),
      isInteractiveType: interactiveTypes.contains(type),
      visible: visible,
      compact: options.compact,
      interactiveOnly: options.interactiveOnly
    )
  }
```

At BOTH call sites (the fast-path walker, currently lines 135-143, and `snapshotRaw`, currently lines 208-216), delete the `hittable: evaluation.hittable,` argument line so the calls read:

```swift
      let include = shouldInclude(
        snapshot: snapshot,
        label: evaluation.label,
        identifier: evaluation.identifier,
        valueText: evaluation.valueText,
        options: options,
        visible: evaluation.visible
      )
```

- [ ] **Step 4: Delete the dead occlusion machinery**

Remove these four private members entirely from `RnFastRunnerTests+Snapshot.swift`:
- `computedSnapshotHittable(_:viewport:laterNodes:)` (currently lines 284-301)
- `isOccludingType(_:)` (currently lines 374-381)
- `flattenedSnapshots(_:)` (currently lines 383-403)
- `laterSnapshots(for:in:ranges:)` (currently lines 405-418)

Then confirm nothing else references them:

Run: `grep -rn "flattenedSnapshots\|laterSnapshots\|isOccludingType\|computedSnapshotHittable" scripts/rn-fast-runner/`
Expected: no matches.

(Do NOT touch the collapsed-tab fallback's `element.isHittable` at ~line 583 — that is the real XCTest API on a live `XCUIElement`, out of scope per spec.)

- [ ] **Step 5: Run the full native suite**

Run: `npm run test:native:ios`
Expected: PASS — full bundle compiles (deleting the members breaks the build if any reference survived) and all suites green.

- [ ] **Step 6: Commit**

```bash
git add scripts/rn-fast-runner/RnFastRunner/RnFastRunnerUITests/RnFastRunnerTests+Snapshot.swift
git commit -m "fix(rn-fast-runner): honest hittable — drop occlusion heuristic, decouple filtering (#395)"
```

---

### Task 4: TS suite sweep, Android parity evidence, changeset

**Files:**
- Create: `.changeset/honest-hittable-395.md`
- No TS source changes expected — this task PROVES that.

**Interfaces:**
- Consumes: nothing from Tasks 1-3 (independent verification).
- Produces: green TS suite + the changeset the release gate requires.

- [ ] **Step 1: Confirm no TS test pins the old always-false semantics**

Run: `grep -rn "occlu\|laterNodes\|hittable" scripts/cdp-bridge/test --include="*.test.*" -l`
Expected: hits only in fixture-driven tests (`gh-59-4-rank-snapshot-nodes.test.js`, `device-batch-salient.test.js`, `settle-hash.test.js`, `flatten-xcui-tree.test.js`, etc.) whose `hittable` values are synthetic TS-level inputs, not derived from the Swift heuristic. Skim each hit: if any test comment or fixture asserts "hittable is always false on device" semantics, update the comment — no logic changes.

- [ ] **Step 2: Run the full TS suite**

Run: `cd scripts/cdp-bridge && npm test`
Expected: PASS (2,930+ tests as of PR #475). The build step inside `npm test` must not dirty tracked `dist/` output (`git status --short scripts/cdp-bridge/dist` shows nothing) — there are no TS source changes on this branch.

- [ ] **Step 3: Record Android parity evidence (code-read, no change)**

The Android snapshot path is already honest: `CommandDispatcher.kt:178` maps `hittable` from UIAutomator's `visible-to-user` attribute (native visibility, no occlusion heuristic), and the find-path `uiObjectToJson` (`CommandDispatcher.kt:314`) maps `isEnabled` — consistent with the new iOS semantics. If an Android emulator is running (`adb devices` lists one), optionally confirm live: open a device session on it and check a snapshot's nodes are not uniformly `hittable: false`. No Kotlin changes either way; the evidence lines go into the PR body.

- [ ] **Step 4: Add the changeset**

Create `.changeset/honest-hittable-395.md`:

```markdown
---
'rn-dev-agent-cdp': patch
'rn-dev-agent-plugin': patch
---

fix(rn-fast-runner): honest `hittable` in iOS snapshots (#395). `hittable` now means "enabled and its center is on-screen" (plausibly tappable). The old occlusion heuristic counted trailing transparent full-screen containers (gesture-handler roots, portal hosts) as occluders and marked every node `hittable=false` on real RN screens — poisoning `device_find` candidate ranking and `device_batch`'s dead-control annotation. Real modal occlusion was never representable anyway: RN modals get their own UIWindow, so occluded content is absent from the XCUI tree entirely. Snapshot filtering (compact/interactiveOnly) is now explicitly hittable-independent, so snapshot sizes are unchanged. The refusal half of the original #395 report ("no longer hittable" errors on modal screens) was a stale-ref message fixed by #396. No wire-shape change; new plugin releases pick this up via their per-version runner artifact. Dev checkouts: delete `scripts/rn-fast-runner/build/DerivedData` to rebuild.
```

- [ ] **Step 5: Commit**

```bash
git add .changeset/honest-hittable-395.md
git commit -m "chore: changeset for honest hittable computation (#395)"
```

---

### Task 5: iOS device verification against the checkout-built runner

The MCP tools in a live session run the *installed plugin's* runner (`~/.claude/plugins/cache/...`), which does not contain this change — so verification drives the checkout-built runner directly over its `/command` HTTP endpoint, the same protocol the bridge uses.

**Files:**
- No repo files. Evidence (before/after JSON, node counts) goes into the PR body.

**Interfaces:**
- Consumes: the Task 3 runner build; the booted simulator with `com.rndevagent.testapp` (Metro serving `../rn-dev-agent-workspace/test-app`).
- Produces: device-verification evidence for the PR + GH #395 closure comment.

- [ ] **Step 1: Rebuild the checkout runner from the new sources**

```bash
UDID=$(xcrun simctl list devices booted -j | python3 -c 'import json,sys; d=json.load(sys.stdin); print([x["udid"] for v in d["devices"].values() for x in v][0])')
pkill -f RnFastRunnerUITests-Runner || true
rm -rf scripts/rn-fast-runner/build/DerivedData
cd scripts/rn-fast-runner/RnFastRunner
xcodebuild build-for-testing -project RnFastRunner.xcodeproj -scheme RnFastRunner \
  -destination "id=$UDID" -derivedDataPath ../build/DerivedData
```

Expected: `** TEST BUILD SUCCEEDED **` (cold build, several minutes).

- [ ] **Step 2: Launch the runner and find its port**

```bash
xcodebuild test-without-building -project RnFastRunner.xcodeproj -scheme RnFastRunner \
  -destination "id=$UDID" -derivedDataPath ../build/DerivedData \
  -only-testing:RnFastRunnerUITests/RnFastRunnerTests/testCommand &
sleep 25
PORT=$(lsof -nP -iTCP -sTCP:LISTEN | awk '/RnFastRun/ {sub(".*:","",$9); print $9; exit}')
echo "runner on :$PORT"
```

Expected: a numeric port (the runner resolves `RN_FAST_RUNNER_PORT` or picks its own; read the actual listener).

- [ ] **Step 3: Verify the Tasks screen (non-modal)**

Navigate the app to the Tasks tab first (tap in Simulator by hand, or via `curl` tap on the tab's coordinates from a snapshot). Then:

```bash
curl -s -X POST http://localhost:$PORT/command -H 'Content-Type: application/json' \
  -d '{"command":"snapshot","raw":true,"appBundleId":"com.rndevagent.testapp"}' \
  | python3 -c '
import json,sys
nodes=json.load(sys.stdin)["data"]["nodes"]
by_id={n.get("identifier"):n for n in nodes}
for ident in ("fab-create-task","tab-home","task-add-btn"):
    n=by_id.get(ident)
    print(ident, "hittable=", n and n["hittable"])
total=len(nodes); true_count=sum(1 for n in nodes if n["hittable"])
print(f"{true_count}/{total} hittable")'
```

Expected: `fab-create-task hittable= True`, `tab-home hittable= True`, `task-add-btn hittable= True`; `true_count` is a large majority of `total` (baseline before this fix: 0/226).

- [ ] **Step 4: Verify the TaskWizard modal**

Open the wizard (tap `fab-create-task` via curl using its rect center from Step 3's snapshot: `{"command":"tap","x":<midX>,"y":<midY>,"appBundleId":"com.rndevagent.testapp"}`), then re-snapshot with the same curl as Step 3 and assert:

- `wizard-next-btn`, `wizard-title-input`, `wizard-back-btn` → `hittable: true` (baseline: all false)
- `wizard-priority-low` (off-screen pane at x≈423 on a 402pt viewport) → `hittable: false` (the preserved useful signal)

Close the wizard afterwards (tap `wizard-back-btn` center).

- [ ] **Step 5: Confirm no snapshot-size regression**

From the same two screens, capture the DEFAULT snapshot (`{"command":"snapshot","interactiveOnly":true,...}` — no `raw`) and compare node counts against the pre-fix baselines recorded during investigation: Tasks screen 127 full nodes, wizard 45 nodes. Expected: within a few nodes of baseline (the decoupling may EXCLUDE a handful of trailing contentless overlay wrappers that the old code included via `hasContent || hittable`; counts must not grow).

- [ ] **Step 6: Clean up and record evidence**

```bash
pkill -f RnFastRunnerUITests-Runner || true
```

Paste the Step 3-5 outputs (before/after hittable ratios, node counts) into the PR body and the GH #395 closure comment. No commit in this task.

---

## Self-Review (completed)

- **Spec coverage:** §1 re-scope → changeset text + PR/closure notes (Tasks 4-5); §2 new predicate + deletions → Tasks 1, 3; §3 filtering decoupling → Tasks 2, 3; §4 TS consumers untouched → Task 4 Steps 1-2; §4 Android parity → Task 4 Step 3; §5 rollout → Global Constraints (no-op by per-version cache construction; dev-checkout DerivedData handled in Task 5 Step 1); §6 testing matrix → Tasks 1-2 (Swift unit), Task 4 (TS), Task 5 (device + size comparison); §7 no new error handling → none added.
- **Placeholder scan:** none — every step has runnable code/commands and expected output.
- **Type consistency:** `computeSnapshotHittable(enabled:frame:viewport:)` and `shouldIncludeSnapshotNode(type:hasContent:childCount:isScrollableContainer:isInteractiveType:visible:compact:interactiveOnly:)` are used with identical signatures in Tasks 1/2 (definition), Task 2 tests, and Task 3 (call sites).
