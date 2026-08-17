---
"rn-dev-agent-core": patch
"rn-dev-agent-plugin": patch
---

Fence `adb` reads for exact-connect device/platform inference whenever an authority session is present, so an available authority with no device binding, a registry lookup that throws, or an unavailable runtime whose code is not `SESSION_NOT_INITIALIZED` (`SESSION_OWNER_LOST`, `PROCESS_BIRTH_UNAVAILABLE`, `AUTHORITY_STORE_UNAVAILABLE`) no longer falls back to ambient `adb devices`; only a runtime that was never initialized keeps the legacy ambient read, and raw `device_*` tools are unaffected.
