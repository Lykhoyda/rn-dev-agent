# Keyboard-Occlusion Guard Phase 2 (in-runner, live taps) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop live `device_press` / `device_batch` / `cdp_interact`-native-fallback taps from landing on the software keyboard by auto-dismissing it, in-runner, only when the tap point is genuinely under the keyboard.

**Architecture:** The guard runs at each native runner's **command handler** for the in-scope verbs (`tap`/`press`, `longPress`) — NOT inside the shared `tapAt`, which fans out to by-text taps, element-center taps, and tap-series loops that must not be guarded. The *occlusion decision* is a pure, dependency-free predicate (tap point inside a sane keyboard rect) unit-tested off-device; the *frame measurement + dismiss* is device-verified. The opt-out (`RN_KEYBOARD_GUARD=0`) is resolved TS-side into a per-command `guardKeyboard` boolean, because the runner's env is fixed at process launch and can't vary per call.

**Tech Stack:** TypeScript (cdp-bridge, `node --test`), Swift/XCTest (`rn-fast-runner`), Kotlin/UIAutomator2 (`rn-android-runner`, local JVM `src/test` + instrumented `src/androidTest`).

## Amendments applied from the multi-LLM plan review (2026-07-01, Claude Opus + Codex; Gemini unavailable)

The v1 plan was reviewed pre-code. Verified blockers folded in below:

- **B1 (iOS won't compile):** predicate moved to a dependency-free `KeyboardGuard.swift` as `enum KeyboardGuard { static func shouldDismiss(...) }` (same target as the test → no `@testable import`, no instance-method-as-free-function).
- **B2 (no telemetry slot):** guard runs in the command handler where the `DataPayload` is built; `DataPayload` gains `keyboardGuard: String?`. `tapAt` is left untouched.
- **B3 (default widens scope):** NO `guardKeyboard` param on `tapAt`; guarding happens only at the `.tap`/`.longPress` command cases.
- **B4 (tapSeries correctness):** `tapSeries` (`+CommandExecution.swift:303`) is explicitly EXCLUDED — dismissing mid-series relayouts and misses.
- **B5 (Android silent no-op):** `UiAutomation.getWindows()` returns empty unless `FLAG_RETRIEVE_INTERACTIVE_WINDOWS` is set via `setServiceInfo`. Task 6 enables it once at init (flag-only mutation of the injected instrumentation's uiAutomation). Device-verify asserts an actual `"dismissed"` (regression net vs shipping a no-op — the B223 class).
- **B6 + R3/R4 (weak/destructive gate):** predicate switched from `tapY >= keyboardTop` to **point-in-rect containment on a sane rect** (non-empty, height ≥ platform min, bottom-anchored), and Android `pressBack()` is gated on that — never on `!= null`. Tiny/accessory-bar/empty frames → not occluded.
- **R1 (telemetry contract):** `keyboardGuard` states (`"dismissed"|"not_occluded"|"no_keyboard"|"off"`) pinned; both-platform response-mapping unit tests added (Task 7).
- **R5 (hot-path cost):** guard only on the command-level path; collapse the iOS visibility+frame reads into one; add `meta.timings_ms` on the guarded native path.
- **R6 (test feedback loop):** pure predicates in dependency-free files; Android predicate takes **primitive Int bounds** (not `android.graphics.Rect`, which is unavailable in local JVM tests) so it gets a fast `src/test` JVM test; device tests reserved for integration.
- **R7:** `device_batch` gets an explicit verification case (Task 7).
- **R8:** the `.xctestrun` rebuild is a hard predecessor of iOS device-verify, with a liveness assertion that the running runner carries the new field.
- **Settled (verified, no change needed):** coordinate spaces already match at both chokepoints; TS-side opt-out layering is correct and the only workable option.

## Global Constraints

- Node.js >= 22 LTS; explicit type imports; no unnecessary comments.
- Any `scripts/cdp-bridge/src/` change requires a `.changeset/*.md` (`require-changeset` CI).
- `oxlint` + `oxfmt --check` pass; add `meta.timings_ms` on the guarded native path.
- Default-ON guard; opt-out `RN_KEYBOARD_GUARD=0`/`false`, resolved TS-side into a per-command `guardKeyboard`.
- **Predicate = containment on a sane rect:** dismiss iff the keyboard/IME rect is non-empty, its height ≥ platform min (iOS 120pt, Android 150px — rejects accessory/predictive bars), AND the tap point falls inside it. This preserves `KeyboardAvoidingView` (control above the keyboard → not contained → no dismiss) and handles floating/split keyboards (containment uses x too).
- **Guard scope:** command-handler `tap`/`press` + `longPress` ONLY. NOT `tapAt` directly, NOT `tapSeries`, NOT by-text/element-center taps, NOT the focus-tap inside `type`/fill, NOT swipes/scrolls/drags/doubleTap.
- **Android safety invariant:** `device.pressBack()` with no IME shown navigates the app back (destructive). Dismiss only when the containment predicate holds on a sane, bottom-anchored IME rect — never on window-existence alone. Requires `FLAG_RETRIEVE_INTERACTIVE_WINDOWS`.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `scripts/cdp-bridge/src/runners/keyboard-guard.ts` | Pure TS: `resolveKeyboardGuard(env)` + `withKeyboardGuard(payload,verb,env)` | Create |
| `scripts/cdp-bridge/src/runners/rn-fast-runner-client.ts` | iOS `runIOS()` — add `guardKeyboard` to tap/longPress payload | Modify |
| `scripts/cdp-bridge/src/runners/rn-android-runner-client.ts` | Android `runAndroid()` — same | Modify |
| `scripts/cdp-bridge/src/tools/device-interact.ts` | Surface runner `keyboardGuard` → `meta.keyboardGuard` | Modify |
| `scripts/cdp-bridge/test/unit/gh-370-keyboard-guard.test.js` | TS unit: flag resolver, payload wiring, both-platform response mapping | Create |
| `…/RnFastRunnerUITests/KeyboardGuard.swift` | iOS pure `enum KeyboardGuard { static func shouldDismiss(keyboardFrame:tapPoint:minHeight:) }` | Create |
| `…/RnFastRunnerUITests/KeyboardGuardTests.swift` | iOS: direct-call unit test (no device UI, no `@testable`) | Create |
| `…/RnFastRunnerUITests/RnFastRunnerTests+CommandExecution.swift` | iOS: guard `.tap`/`.longPress` cases; add `keyboardGuard` to `DataPayload` | Modify |
| `…/RnFastRunnerUITests/RnFastRunnerTests+Interaction.swift` | iOS: reuse `isKeyboardVisible`/`dismissKeyboard`; add a single collapsed `keyboardFrameIfVisible(app:)` | Modify |
| `…/RnFastRunnerUITests/RnFastRunnerTests+Models.swift` | iOS: `DataPayload.keyboardGuard: String?` | Modify |
| `app/src/main/java/.../androidrunner/KeyboardGuard.kt` | Android pure `object KeyboardGuard { fun shouldDismiss(imeLeft/Top/Right/Bottom, tapX, tapY, minHeightPx): Boolean }` (no android imports) | Create |
| `app/src/test/java/.../androidrunner/KeyboardGuardTest.kt` | Android: local JVM unit test | Create |
| `app/src/androidTest/java/.../androidrunner/CommandDispatcher.kt` | Android: enable `FLAG_RETRIEVE_INTERACTIVE_WINDOWS`; `imeBoundsInScreen(): Rect?`; guard `tap()`/`longPress()`; `keyboardGuard` in JSON | Modify |
| `.changeset/370-keyboard-occlusion-guard-phase2.md` | Changeset | Create |
| `CLAUDE.md` + `docs-site` device-control page | Document guard + `RN_KEYBOARD_GUARD=0` + Android safety note | Modify |

**PR decomposition:** stacked — **2a = TS plumbing + iOS (T1–T4, T7-TS, T8)**, **2b = Android (T5–T6 + Android verify)** off 2a. Runners are independent; keeps each PR device-verifiable on one platform.

---

## Task 1: TS `resolveKeyboardGuard(env)` (pure)

**Files:** Create `scripts/cdp-bridge/src/runners/keyboard-guard.ts`; Test `scripts/cdp-bridge/test/unit/gh-370-keyboard-guard.test.js`.
**Interfaces:** Produces `resolveKeyboardGuard(env: NodeJS.ProcessEnv): boolean` — `false` only when `RN_KEYBOARD_GUARD` trims/lowercases to `"0"`/`"false"`.

- [ ] **Step 1: Failing test**
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveKeyboardGuard } from '../../dist/runners/keyboard-guard.js';
test('defaults ON when unset', () => assert.equal(resolveKeyboardGuard({}), true));
test('OFF for 0/false (case/space-insensitive)', () => {
  assert.equal(resolveKeyboardGuard({ RN_KEYBOARD_GUARD: '0' }), false);
  assert.equal(resolveKeyboardGuard({ RN_KEYBOARD_GUARD: ' False ' }), false);
});
test('ON for any other value', () => assert.equal(resolveKeyboardGuard({ RN_KEYBOARD_GUARD: 'yes' }), true));
```
- [ ] **Step 2: Run → FAIL** `cd scripts/cdp-bridge && npm run build && node --test test/unit/gh-370-keyboard-guard.test.js` → module not found.
- [ ] **Step 3: Implement**
```ts
export function resolveKeyboardGuard(env: NodeJS.ProcessEnv): boolean {
  const raw = (env.RN_KEYBOARD_GUARD ?? '').trim().toLowerCase();
  return !(raw === '0' || raw === 'false');
}
```
- [ ] **Step 4: Run → PASS** (3 tests).
- [ ] **Step 5: Commit** `git commit -m "feat(keyboard-guard): resolveKeyboardGuard(env) (#370)"`

---

## Task 2: `withKeyboardGuard` + plumb into iOS/Android tap+longPress payloads

**Files:** Modify `keyboard-guard.ts`, `rn-fast-runner-client.ts`, `rn-android-runner-client.ts`; extend the Task 1 test.
**Interfaces:** Produces `withKeyboardGuard(payload, verb, env)` adding `guardKeyboard` only for `tap`/`press`/`longPress`.

- [ ] **Step 1: Failing test** (append)
```js
import { withKeyboardGuard } from '../../dist/runners/keyboard-guard.js';
test('withKeyboardGuard: tap/longPress only', () => {
  assert.equal(withKeyboardGuard({ command: 'tap' }, 'tap', {}).guardKeyboard, true);
  assert.equal(withKeyboardGuard({ command: 'longPress' }, 'longPress', { RN_KEYBOARD_GUARD: '0' }).guardKeyboard, false);
  assert.equal('guardKeyboard' in withKeyboardGuard({ command: 'swipe' }, 'swipe', {}), false);
});
```
- [ ] **Step 2: Run → FAIL** (not exported).
- [ ] **Step 3: Implement** (add to `keyboard-guard.ts`)
```ts
const GUARDED_VERBS = new Set(['tap', 'press', 'longPress']);
export function withKeyboardGuard<T extends object>(payload: T, verb: string, env: NodeJS.ProcessEnv): T & { guardKeyboard?: boolean } {
  if (!GUARDED_VERBS.has(verb)) return payload;
  return { ...payload, guardKeyboard: resolveKeyboardGuard(env) };
}
```
Wrap the tap/longPress command object in each client before POST: `const body = withKeyboardGuard(baseCmd, verb, process.env);` (exact command-builder lines located during impl — `runIOS`/`runAndroid` tap+longpress cases).
- [ ] **Step 4: Run → PASS** (4 tests).
- [ ] **Step 5: Commit** `git commit -m "feat(keyboard-guard): thread guardKeyboard into iOS+Android tap/longPress commands (#370)"`

---

## Task 3: iOS pure containment predicate + off-device test

**Files:** Create `…/RnFastRunnerUITests/KeyboardGuard.swift`, `…/KeyboardGuardTests.swift`.
**Interfaces:** Produces `enum KeyboardGuard { static func shouldDismiss(keyboardFrame: CGRect, tapPoint: CGPoint, minHeight: CGFloat) -> Bool }` — non-empty AND `keyboardFrame.height >= minHeight` AND `keyboardFrame.contains(tapPoint)`.

- [ ] **Step 1: Failing test** (`KeyboardGuardTests.swift`, calls the function directly — same module, NO `@testable import`)
```swift
import XCTest
import CoreGraphics

final class KeyboardGuardTests: XCTestCase {
  let kb = CGRect(x: 0, y: 500, width: 390, height: 336) // docked, tall
  func testOccludedWhenPointInsideKeyboard() {
    XCTAssertTrue(KeyboardGuard.shouldDismiss(keyboardFrame: kb, tapPoint: CGPoint(x: 200, y: 700), minHeight: 120))
  }
  func testNotOccludedAboveKeyboard() {
    XCTAssertFalse(KeyboardGuard.shouldDismiss(keyboardFrame: kb, tapPoint: CGPoint(x: 200, y: 480), minHeight: 120))
  }
  func testAccessoryBarTooShortNotOccluded() {
    let bar = CGRect(x: 0, y: 800, width: 390, height: 44)
    XCTAssertFalse(KeyboardGuard.shouldDismiss(keyboardFrame: bar, tapPoint: CGPoint(x: 200, y: 820), minHeight: 120))
  }
  func testEmptyFrameNeverOccludes() {
    XCTAssertFalse(KeyboardGuard.shouldDismiss(keyboardFrame: .zero, tapPoint: CGPoint(x: 1, y: 9999), minHeight: 120))
  }
  func testFloatingKeyboardUsesXContainment() {
    let floating = CGRect(x: 40, y: 500, width: 300, height: 300)
    XCTAssertFalse(KeyboardGuard.shouldDismiss(keyboardFrame: floating, tapPoint: CGPoint(x: 10, y: 600), minHeight: 120))
  }
}
```
- [ ] **Step 2: Run → FAIL** `cd scripts/rn-fast-runner/RnFastRunner && xcodebuild test -project RnFastRunner.xcodeproj -scheme RnFastRunner -destination "platform=iOS Simulator,id=<UDID>" -only-testing:RnFastRunnerUITests/KeyboardGuardTests` → `KeyboardGuard` not found.
- [ ] **Step 3: Implement** (`KeyboardGuard.swift`)
```swift
import CoreGraphics
enum KeyboardGuard {
  static func shouldDismiss(keyboardFrame: CGRect, tapPoint: CGPoint, minHeight: CGFloat) -> Bool {
    guard !keyboardFrame.isEmpty, keyboardFrame.height >= minHeight else { return false }
    return keyboardFrame.contains(tapPoint)
  }
}
```
- [ ] **Step 4: Run → PASS** (5 tests).
- [ ] **Step 5: Commit** `git commit -m "feat(ios-runner): pure KeyboardGuard.shouldDismiss containment predicate (#370)"`

---

## Task 4: iOS — guard the `.tap`/`.longPress` command cases + telemetry

**Files:** Modify `+CommandExecution.swift` (`.tap` at `:211`, `.longPress`; leave `.tapSeries` at `:303` UNGUARDED), `+Interaction.swift` (add `keyboardFrameIfVisible`), `+Models.swift` (`DataPayload.keyboardGuard`).
**Interfaces:** Consumes `KeyboardGuard.shouldDismiss`, `dismissKeyboard`. Produces `func keyboardFrameIfVisible(app:) -> CGRect?` (one snapshot read), and a command-handler-local `applyGuard(...) -> String` returning `"dismissed"|"not_occluded"|"no_keyboard"|"off"`, written into `DataPayload.keyboardGuard`.

- [ ] **Step 1:** Add `keyboardFrameIfVisible` (collapses the double read — R5):
```swift
func keyboardFrameIfVisible(app: XCUIApplication) -> CGRect? {
  let kb = app.keyboards.firstMatch
  guard kb.exists else { return nil }
  let frame = kb.frame
  return frame.isEmpty ? nil : frame
}
```
- [ ] **Step 2:** Add `DataPayload.keyboardGuard: String?` (Codable optional) in `+Models.swift`.
- [ ] **Step 3:** In the `.tap` and `.longPress` command cases (NOT tapSeries), before dispatching to `tapAt`/`longPressAt`, when `command.guardKeyboard != false`:
```swift
var kbStatus = "off"
if command.guardKeyboard != false {  // #if !os(tvOS)
  if let frame = keyboardFrameIfVisible(app: activeApp) {
    if KeyboardGuard.shouldDismiss(keyboardFrame: frame, tapPoint: CGPoint(x: x, y: y), minHeight: 120) {
      _ = dismissKeyboard(app: activeApp); kbStatus = "dismissed"
    } else { kbStatus = "not_occluded" }
  } else { kbStatus = "no_keyboard" }
}
// … existing tapAt(app:x:y:) …
payload.keyboardGuard = kbStatus
```
Add `guardKeyboard: Bool?` to the command model in `+Models.swift`.
- [ ] **Step 4:** `.xctestrun` rebuild is a HARD predecessor of Step 5 (R8): `xcodebuild build-for-testing … -derivedDataPath ../build/DerivedData`.
- [ ] **Step 5: Device-verify** (procedure Task 6-common): keyboard-up + tap under keyboard → `keyboardGuard:"dismissed"` and the button fires (`cdp_store_state`/`cdp_navigation_state`); `KeyboardAvoidingView` screen (button above keyboard) → `"not_occluded"`, keyboard stays; assert the running runner actually returns the field (liveness).
- [ ] **Step 6: Commit** `git add -A scripts/rn-fast-runner/ && git commit -m "feat(ios-runner): dismiss occluding keyboard before .tap/.longPress; telemetry (#370)"`

---

## Task 5: Android pure predicate (primitive bounds) + local JVM test

**Files:** Create `app/src/main/java/dev/lykhoyda/rndevagent/androidrunner/KeyboardGuard.kt`, `app/src/test/java/.../KeyboardGuardTest.kt`.
**Interfaces:** Produces `object KeyboardGuard { fun shouldDismiss(imeLeft: Int, imeTop: Int, imeRight: Int, imeBottom: Int, tapX: Int, tapY: Int, minHeightPx: Int): Boolean }` — no android imports (JVM-testable); sane-rect (non-empty, height ≥ min) AND point containment.

- [ ] **Step 1: Failing test** (`src/test`, plain JVM — runs without an emulator)
```kotlin
import org.junit.Assert.*
import org.junit.Test
class KeyboardGuardTest {
  @Test fun occludedWhenInsideImeRect() = assertTrue(KeyboardGuard.shouldDismiss(0, 1400, 1080, 2400, 540, 1600, 150))
  @Test fun notOccludedAboveIme() = assertFalse(KeyboardGuard.shouldDismiss(0, 1400, 1080, 2400, 540, 1200, 150))
  @Test fun tooShortRectRejected() = assertFalse(KeyboardGuard.shouldDismiss(0, 2360, 1080, 2400, 540, 2380, 150))
  @Test fun emptyRectNeverOccludes() = assertFalse(KeyboardGuard.shouldDismiss(0, 0, 0, 0, 5, 9999, 150))
}
```
- [ ] **Step 2: Run → FAIL** `cd scripts/rn-android-runner && ./gradlew :app:testDebugUnitTest --tests '*KeyboardGuardTest'` → unresolved. (Confirm `src/test` JVM unit tests are wired; add the `testImplementation junit` dep if missing.)
- [ ] **Step 3: Implement**
```kotlin
package dev.lykhoyda.rndevagent.androidrunner
object KeyboardGuard {
  fun shouldDismiss(imeLeft: Int, imeTop: Int, imeRight: Int, imeBottom: Int, tapX: Int, tapY: Int, minHeightPx: Int): Boolean {
    val width = imeRight - imeLeft; val height = imeBottom - imeTop
    if (width <= 0 || height < minHeightPx) return false
    return tapX in imeLeft until imeRight && tapY in imeTop until imeBottom
  }
}
```
- [ ] **Step 4: Run → PASS** (4 tests, no emulator).
- [ ] **Step 5: Commit** `git commit -m "feat(android-runner): pure KeyboardGuard predicate + JVM test (#370)"`

---

## Task 6: Android — enable interactive windows, IME bounds, guard `tap()`/`longPress()`

**Files:** Modify `CommandDispatcher.kt`.
**Interfaces:** Produces `imeBoundsInScreen(): Rect?` and guarded `tap()`/`longPress()` returning `keyboardGuard` in the JSON result. Consumes `KeyboardGuard.shouldDismiss`.

- [ ] **Step 1: Enable interactive windows once at init (B5).** Where the dispatcher holds `instrumentation`/`device`:
```kotlin
init {
  val ua = instrumentation.uiAutomation
  ua.serviceInfo = ua.serviceInfo.apply {
    flags = flags or AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS
  }
}
```
Imports: `android.accessibilityservice.AccessibilityServiceInfo`, `android.view.accessibility.AccessibilityWindowInfo`. Reuse the already-injected `instrumentation` (no second `InstrumentationRegistry` path).
- [ ] **Step 2: `imeBoundsInScreen()` (B6-sane rect):**
```kotlin
private fun imeBoundsInScreen(): Rect? {
  val ime = instrumentation.uiAutomation.windows
    .firstOrNull { it.type == AccessibilityWindowInfo.TYPE_INPUT_METHOD } ?: return null
  val r = Rect(); ime.getBoundsInScreen(r)
  return if (r.isEmpty) null else r
}
```
- [ ] **Step 3: Guard `tap()` (and `longPress()`), before `device.click`/swipe:**
```kotlin
var kbStatus = "off"
if (cmd.optBoolean("guardKeyboard", true)) {
  val b = imeBoundsInScreen()
  kbStatus = when {
    b == null -> "no_keyboard"
    KeyboardGuard.shouldDismiss(b.left, b.top, b.right, b.bottom, x, y, 150) -> {
      device.pressBack(); device.waitForIdle(); "dismissed"
    }
    else -> "not_occluded"
  }
}
// … existing device.click(x, y) …
return JSONObject()./*existing*/put("keyboardGuard", kbStatus)
```
- [ ] **Step 4: Device-verify** (emulator): (a) keyboard up + tap under IME → `"dismissed"` + button fires; (b) `KeyboardAvoidingView`/button above IME → `"not_occluded"`, keyboard stays; (c) **destructive-back guard:** NO keyboard up + low tap → `"no_keyboard"` and route UNCHANGED (`cdp_navigation_state`); (d) assert a genuine dismissal really occurs (regression net vs B5 no-op).
- [ ] **Step 5: Commit** `git add -A scripts/rn-android-runner/ && git commit -m "feat(android-runner): FLAG_RETRIEVE_INTERACTIVE_WINDOWS + IME-occlusion guard for live taps (#370)"`

---

## Task 7: TS telemetry mapping + response-mapping tests + device_batch

**Files:** Modify `device-interact.ts`; extend `gh-370-keyboard-guard.test.js`.

- [ ] **Step 1: Failing test** — map a stubbed runner outcome `{ keyboardGuard: 'dismissed', … }` (iOS shape) and `{ ...,"keyboardGuard":"dismissed"}` (Android JSON) to `meta.keyboardGuard` for `device_press`/`device_longpress`; assert absent field → `meta.keyboardGuard` undefined (both platforms).
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3:** Surface `keyboardGuard` from the runner outcome into `meta.keyboardGuard` in the press/longpress result builders; add `meta.timings_ms.keyboardGuard` on the guarded path.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Device-verify `device_batch` (R7):** a batch containing a `press` on an occluded control dismisses + fires; assert `meta.keyboardGuard` present on that step.
- [ ] **Step 6: Commit** `git commit -m "feat(keyboard-guard): surface meta.keyboardGuard + timings; batch verified (#370)"`

---

## Task 8: Changeset + docs

- [ ] **Step 1:** `.changeset/370-keyboard-occlusion-guard-phase2.md` (`rn-dev-agent-cdp` + `rn-dev-agent-plugin` patch): in-runner live-tap keyboard-occlusion guard, `RN_KEYBOARD_GUARD=0` opt-out, `meta.keyboardGuard` telemetry, Android `FLAG_RETRIEVE_INTERACTIVE_WINDOWS` requirement + destructive-back safety.
- [ ] **Step 2:** `CLAUDE.md` device-control section + `docs-site` page: L2 live-tap guard, opt-out env, Android safety note, `doubleTap`/`tapSeries` explicitly unguarded.
- [ ] **Step 3: Commit.**

---

## Self-Review

- **Spec coverage:** in-runner atomic ✓ (guard at command handler, one round-trip); frame-precise both platforms ✓ (iOS `keyboards.frame`, Android `getWindows`+`FLAG_RETRIEVE_INTERACTIVE_WINDOWS`); coordinate-stability/only-if-occluded ✓ (containment predicate); opt-out ✓ (T1/T2).
- **Blockers folded:** B1–B6 addressed (see Amendments); coordinate-space + TS-layering verified as non-issues.
- **Type consistency:** `KeyboardGuard.shouldDismiss` (iOS CGRect/point, Android primitive bounds), `guardKeyboard` flag, `keyboardGuard` result field, `withKeyboardGuard` used identically across TS/Swift/Kotlin.
- **Open (for the executor):** exact `runIOS`/`runAndroid` command-builder line numbers; confirm `src/test` JVM wiring exists in the android-runner gradle module (add if missing in T5 Step 2).
