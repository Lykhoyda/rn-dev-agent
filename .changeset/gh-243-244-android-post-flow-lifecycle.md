---
"rn-dev-agent-cdp": patch
"rn-dev-agent-plugin": patch
---

fix(#243,#244): Android post-flow lifecycle. `rn-android-runner` readiness is now gated on its own `GET /health` instead of the `adb logcat` ring buffer — a prior runner's stale ready line (same tag + fixed port) used to fire readiness before the new socket bound, so the first `device_*` after a Maestro flow returned a bare `fetch failed`. When the runner genuinely can't come up, `runAndroid` now surfaces a structured `RN_ANDROID_RUNNER_DOWN` with a retry hint. Separately, `device_snapshot action=close` now tolerates an underlying session that a flow already tore down (the #237 slot-release): it cleans up local state and returns ok, so `open → flow → close` round-trips cleanly instead of erroring `SESSION_NOT_FOUND`.
