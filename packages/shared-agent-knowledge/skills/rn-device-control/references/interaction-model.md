# 3-Tier Interaction Model (D497)

Three levels of UI interaction, each with distinct trade-offs. Choose based on what you need.

## Tier 1: `cdp_interact` / `cdp_evaluate` — JS-level

**How it works:** Calls `onPress`, `onSubmitEditing`, or dispatches events directly in the React fiber tree via Chrome DevTools Protocol.

**When to use:**
- Pressable inside PanResponder / gesture handler (native touches hit the outer container)
- Triggering callbacks that don't have visible UI anchors
- Programmatic navigation (`cdp_navigate`)
- Store mutations (`cdp_dispatch`)

**Limitations:**
- Requires CDP connection and injected helpers
- Bypasses native touch pipeline (won't trigger native gesture recognizers)
- Doesn't test actual user interaction path

---

## Tier 2: `device_press` / `device_find` — XCTest (iOS) / UIAutomator (Android)

**How it works:** Synthesizes native touch events via `_XCT_synthesizeEvent` (iOS fast-runner) or `adb input` (Android). Uses accessibility tree `@ref` identifiers.

**When to use:**
- Standard button taps, long-press, swipe
- Testing the real touch pipeline
- Any element visible in the accessibility tree (`device_snapshot`)

**Limitations:**
- `@ref` points to accessibility element, which may be a container (not inner Pressable)
- Coordinate-based: if the ref's frame covers a gesture handler, the touch hits the handler
- iOS: ~210ms floor per tap (XPC overhead)
- Android: limited to raw coordinates via `adb input tap x y`

---

## Tier 3: Maestro / maestro-runner — Cross-platform E2E

**How it works:** YAML-based test flows. Uses XCTest on iOS and UIAutomator2 on Android. Persistent test files for CI regression.

**When to use:**
- Android element-based interaction (better than raw `adb input`)
- Generating persistent regression tests
- Cross-platform verification in CI
- Complex multi-step flows that should be repeatable

**Limitations:**
- Slower than direct device_press (JVM startup for Maestro, though maestro-runner avoids this)
- Same coordinate/accessibility limitations as Tier 2 on iOS
- Requires maestro-runner or Maestro CLI installed

---

## Decision Table

| Scenario | Use |
|----------|-----|
| Standard tap on visible button | `device_press` (Tier 2) |
| Long-press with confirmation | `device_press` with holdMs (Tier 2) |
| Tap inside PanResponder/gesture | `cdp_interact` (Tier 1) |
| Tap a KNOWN testID (single action) | `cdp_interact(testID=...)` (Tier 1) — fiber-tree-resolved, no coord caching |
| Multi-step flow with KNOWN testIDs | `device_batch` with `testID=` on find/press/fill (Phase 125) — snapshot-resolves per step, no stale-ref drift across step transitions |
| Navigate to a screen | `cdp_navigate` (Tier 1) |
| Dispatch Redux action | `cdp_dispatch` (Tier 1) |
| Android element interaction | Maestro (Tier 3) or `device_find` (Tier 2) |
| Generate persistent test | Maestro YAML (Tier 3) |
| Form input (known testID) | `device_batch` with `fill` step + `testID=` (Tier 2) |
| Form input (unknown element) | `device_snapshot` → `device_fill(ref="@eN", text=…)` (Tier 2) |
| Verify element exists | `device_find` (Tier 2) |
| Read component state after tap | `device_press` → `cdp_component_tree` (Tier 2 + CDP) |

## When to choose `cdp_interact` vs `device_batch.testID` (D1206 Tier 2 / Phase 125)

Both re-resolve testIDs at execution time (no cached coords, no stale refs). Choose by call shape:

- **Single action, known testID** → `cdp_interact(testID=…, action="press"|"fill"|...)`. Single call, fiber-tree-resolved, fastest.
- **Sequence of N actions on known testIDs** → `device_batch` with `testID=` on each step. One round-trip; snapshot-resolves per step. Use this for multi-step wizards or forms.
- **Single action, unknown element** → `device_snapshot` (one-time discover) → `device_press(ref="@eN")`. The ref is valid only until the next layout change.
- **Sequence on unknown elements where layout changes** → `device_batch` with `snapshot` steps interleaved, then `press(ref=...)` on the same screen. Don't reuse refs across step boundaries that transition screens.

The 13:55 experiment (D1206) failed because the agent used `device_press(ref=…)` with refs cached from an earlier screen's snapshot. After a step transition, those refs pointed at off-screen coordinates. **Rule of thumb:** for any cross-step interaction on a known testID, prefer the testID-keyed primitives — they're slightly slower per call but immune to layout drift.
