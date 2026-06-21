---
"rn-dev-agent-cdp": patch
"rn-dev-agent-plugin": patch
---

fix(actions): inject `- hideKeyboard` before button taps that follow text entry when generating/saving Maestro action flows, and route Android hideKeyboard replays to the official Maestro CLI (#356, Phase 1). Bottom-pinned taps (submit/continue) previously landed on the soft keyboard during replays — the single biggest source of flaky replays. `generateMaestro` now tracks soft-keyboard state and emits a `hideKeyboard` step before a `tap`/`long_press` that follows an `inputText`, reset on navigation. `hideKeyboard` is a no-op when no keyboard is showing and Maestro re-resolves the selector after dismiss, so the injection is safe. Device verification surfaced that maestro-runner v1.0.9 silently no-ops `hideKeyboard` on Android (B223), so `maestro_run` now prefers the official Maestro CLI for Android flows containing `hideKeyboard` (verified to dismiss the keyboard on-device), warning when the CLI is unavailable; iOS is unaffected (maestro-runner honors hideKeyboard there). Live `device_*` taps (the in-runner guard) and existing-corpus backfill are deferred to later phases.
