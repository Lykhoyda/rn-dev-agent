---
"rn-dev-agent-core": minor
"rn-dev-agent-plugin": minor
---

Story 10 (GH #391) — text-input reliability recipes. iOS: the runner's `type` handler now waits (≤1 s, best-effort) for the keyboard before the first keystroke and types in Maestro's two-burst shape (first character, 500 ms pause, remainder), killing the dropped-first-keystrokes flake class; typing telemetry (`typingBurst`, `keyboardWaitMs`) surfaces in the response and threads into `device_fill`'s `meta.typing`. Android: the runner's `type` classifies its `ACTION_SET_TEXT` read-back (accepted / transformed / rejected), falls back to per-char keyevents at Maestro's 75 ms pacing when the set was ignored, and reports `SET_TEXT_REJECTED` when both tiers fail. Bridge: `device_fill`'s Android unsafe-char/length short-circuit to chunked `adb input text` is removed — emoji and long text now reach the runner's full-Unicode `setText` primary, with chunked adb demoted to a genuine last resort and `SET_TEXT_REJECTED` descending the ladder without wasted re-taps.
