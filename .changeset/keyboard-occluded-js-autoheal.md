---
"rn-dev-agent-core": patch
"rn-dev-agent-plugin": patch
---

Auto-heal `KEYBOARD_OCCLUDED` tap refusals JS-first (GH #379): when the iOS keyboard guard refuses a `device_press`/`device_longpress` because the tap point is under an iPhone QWERTY keyboard with no dismiss control, the bridge now dismisses via the new injected `__RN_AGENT.dismissKeyboard()` helper (RN `Keyboard.dismiss()`, falling back to blurring the focused TextInput host instance), refreshes the snapshot (targets relayout when the keyboard lifts), and retries the tap exactly once — surfaced as `meta.keyboardGuard: "js_dismissed"` + `meta.keyboardAutoHeal`. The retried tap re-runs the native guard, so a dismissal that didn't take effect re-refuses instead of tapping through. Also ships the #370 review follow-ups: the iOS refusal now carries a structured `code: "KEYBOARD_OCCLUDED"`, both runners report the guard step's native duration (lifted to `meta.timings_ms.keyboardGuard`), and `surfaceKeyboardGuard` hardens its never-throws contract against non-object JSON envelopes.
