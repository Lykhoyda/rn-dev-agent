---
"rn-dev-agent-core": patch
"rn-dev-agent-plugin": patch
---

Fence `adb` reads for exact-connect device/platform inference whenever an authority session is present, so an available authority with no device binding — or a registry lookup that throws — no longer falls back to ambient `adb devices`; only a genuinely absent authority runtime keeps the legacy ambient read, and raw `device_*` tools are unaffected.
