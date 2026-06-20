---
"rn-dev-agent-cdp": patch
"rn-dev-agent-plugin": patch
---

fix(actions): inject `- hideKeyboard` before button taps that follow text entry when generating/saving Maestro action flows (#356, Phase 1). Bottom-pinned taps (submit/continue) previously landed on the soft keyboard during replays — the single biggest source of flaky replays. `generateMaestro` now tracks soft-keyboard state and emits a `hideKeyboard` step before a `tap`/`long_press` that follows an `inputText`, reset on navigation. `hideKeyboard` is a no-op when no keyboard is showing and Maestro re-resolves the selector after dismiss, so the injection is safe. Live `device_*` taps (the in-runner guard) and existing-corpus backfill are deferred to later phases.
