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
| Navigate to a screen | `cdp_navigate` (Tier 1) |
| Dispatch Redux action | `cdp_dispatch` (Tier 1) |
| Android element interaction | Maestro (Tier 3) or `device_find` (Tier 2) |
| Generate persistent test | Maestro YAML (Tier 3) |
| Form input | `device_fill` (Tier 2) |
| Verify element exists | `device_find` (Tier 2) |
| Read component state after tap | `device_press` → `cdp_component_tree` (Tier 2 + CDP) |
