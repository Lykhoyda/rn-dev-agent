# Story 10 — Text-input reliability recipes (iOS two-burst typing, Android ACTION_SET_TEXT)

**Status:** Proposed (2026-07-02)
**Epic:** [Maestro adoption](README.md)
**Impact:** Kills the dropped-keystroke / mangled-unicode flake class at the runner layer; lets `device_fill`'s 4-tier fallback fan-out shrink instead of grow
**Effort:** M
**Depends on:** Story 04 (settle replaces the fixed focus delay); complements Story 07 (`inputText` under native replay)

## Problem

`device_fill` is our most complex path precisely because typing is unreliable underneath it: JS-first dispatch → native tap+fill with read-back verification and up to 2 corrective retypes → Maestro `inputText` fallback with `eraseText` (`tools/device-interact.ts:684-899`). Android additionally has a chunked `adb shell input text` path with a hand-rolled `%s`-splitting workaround (`splitChunkAroundPercentS`, `:520-566`) that cannot represent emoji/IME-composed text. The verification layer is excellent — the *generation* layer under it is weak, so verification does heavy corrective lifting.

## What Maestro does

**iOS (`TextInputHelper.swift`):**
- Wait up to 1 s for `app.keyboards.firstMatch.exists` before typing (`:17-24`) — never type into a keyboard that isn't up.
- **Two-burst typing:** first character at `typingSpeed: 1`, then a 500 ms sleep, then the remainder at frequency 30 (`:26-49`) — specifically to dodge iOS dropping characters right after keyboard appearance/autocorrect/hardware-keyboard events. Erase reuses the path with N delete keys.
- Text goes through the daemon-proxy fast path `_XCT_sendString:maximumFrequency:` (`RunnerDaemonProxy.swift:20-34`), not per-element `typeText`.

**Android (`AndroidDriver.kt:527-539, 1276-1353` + `MaestroDriverService.kt:314-330, 516-570`):**
- ASCII → per-char UIAutomator keycodes with 75 ms pacing.
- Non-ASCII → **their own IME**: enable+set `dev.mobile.maestro/.input.MaestroInputMethodService`, broadcast a readiness probe and poll for `result=0` (≤5 s), send text Base64-URL-encoded in ≤1000-UTF-16-unit chunks that never split surrogate pairs (emoji survive), commit via `InputConnection.beginBatchEdit/commitText/endBatchEdit`, then **restore the original IME in a `finally`**.

## Design

### iOS: adopt the recipe inside rn-fast-runner's `type` handler

1. Keyboard-presence wait (≤1 s poll) before the first keystroke. Interaction with the keyboard guard (#370) is complementary, not conflicting: the guard dismisses a keyboard that would *occlude a tap*; the type path *requires* the keyboard — the `guardKeyboard` flag already distinguishes the intents (`runners/keyboard-guard.ts`).
2. Two-burst send: first char slow → 500 ms → remainder at frequency 30, via the daemon-proxy string API if we aren't already on it (audit; if the runner currently uses `XCUIElement.typeText`, the proxy path also sidesteps quiescence — synergy with Story 03).
3. Surface `meta.typing: {burst: true, keyboardWaitMs}` for telemetry.

### Android: `ACTION_SET_TEXT` as the primary, keyevents as fallback

RN `TextInput` is EditText-backed, so the focused node accepts `AccessibilityNodeInfo.ACTION_SET_TEXT` — atomic, full-Unicode (emoji included), no chunking, and it fires the change events RN's `onChangeText` listens to:

1. Primary: focused-node `ACTION_SET_TEXT` inside rn-android-runner (UIAutomator `UiObject2.setText` wraps exactly this). One shot; the bridge's existing read-back verification (`classifyFillVerification`) confirms controlled-component acceptance.
2. Fallback (read-back mismatch, e.g. a controlled component that re-renders from state on every keystroke and ignores bulk set): per-char keyevents at 75 ms pacing for ASCII (Maestro's pacing constant), current chunked-adb path demoted to last resort.
3. **Not building a custom IME now.** Maestro's IME is the gold-standard endgame but is a whole APK + lifecycle surface; `ACTION_SET_TEXT` + verification should cover RN apps. Record the IME approach (readiness handshake, surrogate-safe chunking, restore-in-finally) as the documented escalation if telemetry shows `ACTION_SET_TEXT` verification failures > ~2 % of fills.

### Simplification payoff

With reliable native generation on both platforms, `device_fill`'s Maestro-`inputText` tier becomes dead weight — remove it once telemetry confirms (aligns with Story 07's direction of pulling maestro-runner out of the interactive path; keep `eraseText` semantics by typing N deletes / setting empty text).

## Implementation steps

1. iOS runner: keyboard-wait + two-burst in the type handler; Swift unit tests for the burst-splitting logic; audit/port to daemon-proxy string send.
2. Android runner: `setText` command variant + focused-node resolution + error surface distinguishing `NO_FOCUSED_FIELD` from `SET_TEXT_REJECTED`.
3. Bridge: reorder the fill ladder (JS-first unchanged → native setText/two-burst → keyevents → chunked adb); thread `meta` telemetry; keep read-back verification exactly as-is (it becomes the arbiter of ladder descent).
4. Fixture screens: emoji field, controlled-component-with-formatter field (masks/uppercase transforms — the `classifyFillVerification` 'transformed' case), autofocus field (keyboard already up), slow-mount field (keyboard appears late).
5. Telemetry review after a dogfood week → decide Maestro-tier removal + IME escalation question.

## Acceptance criteria

- Emoji string `"héllo 👋🏽 世界"` fills correctly on both platforms, verified by read-back — currently impossible on the Android adb path.
- 20-char fill on iOS immediately after keyboard appearance: 0 dropped characters across 20 consecutive runs (currently the corrective-retype counter is nonzero on this pattern).
- Corrective-retype rate (`device_fill` retype telemetry) drops measurably in dogfood; zero increase in `TEXT_ENTRY_UNVERIFIED`.
- `splitChunkAroundPercentS` survives only in the last-resort tier with a comment pointing here.

## Test plan

- Unit: burst splitting, ladder ordering + descent conditions, setText error mapping.
- Live matrix: 4 fixture fields × both platforms × {short ASCII, long ASCII, emoji, RTL string}; results table in PR.
- Story 06 golden set gains one fill-with-emoji step.

## Risks & open questions

- **`ACTION_SET_TEXT` vs controlled components with per-keystroke logic** (input masks, debounced validation): bulk set fires one change event, not N — the read-back verifier already classifies `transformed` outcomes, and the keyevent fallback covers rejection. This is exactly why verification stays mandatory.
- **Autocorrect/smart-punctuation interference on iOS:** the session-open `suppressIOSAutocorrect` best-effort helper already exists (`device-session.ts:349-404`); two-burst reduces exposure further. If flake persists, type-then-verify remains the safety net.
