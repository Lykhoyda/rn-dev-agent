---
"rn-dev-agent-plugin": minor
---

Phase 1 of device-control hardening (#202): `ensureSingleRunner()` now kills stale `AgentDeviceRunner` processes scoped to the target simulator and clears orphaned `~/.agent-device/daemon.{json,lock}` (default-on; opt out with `RN_DEVICE_KILL_LEGACY=0`). Fast-runner state is no longer reused across simulators. `maestro_run` auto-resolves `--app-file` for iOS `clearState` flows (#201).
