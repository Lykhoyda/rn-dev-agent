---
"rn-dev-agent-core": patch
"rn-dev-agent-plugin": patch
---

Refuse maestro-runner action replay on Android below API 26 with a truthful capability diagnosis instead of an opaque install error, and point RUNNER_OWNERSHIP_MISMATCH refusals at the device_snapshot re-open repair instead of a status read that repairs nothing.
