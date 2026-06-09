---
"rn-dev-agent-cdp": patch
"rn-dev-agent-plugin": patch
---

fix(B191,B192): post-flow lifecycle hardening follow-ups to #243/#244. `isAndroidConnectionFailure` now also classifies `startAndroidRunner`'s startup-failure shapes (`exited before readiness`, `Failed to spawn Android runner instrumentation`) into the structured retryable `RN_ANDROID_RUNNER_DOWN` instead of letting a startup crash escape as a raw exception. And `isBenignSessionGoneError` no longer runs its session-gone regex over unparseable (non-JSON) close payloads — with no error field to scope the match to, they surface unchanged, so a real close failure whose raw text merely mentions "no active session" can't be silently swallowed.
