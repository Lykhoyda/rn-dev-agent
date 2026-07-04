---
"rn-dev-agent-cdp": minor
"rn-dev-agent-plugin": patch
---

Observe UI: continuous live mirroring of the simulator/emulator screen (Maestro-style MJPEG). New `GET /api/device/mirror` stream — idb (20–30fps) or simctl loop (~6fps) on iOS, adb screenrecord+ffmpeg on Android emulators and physical devices. Zero capture cost with no tab open; per-tool-call screenshots are skipped while the mirror streams. Config: `observe.mirror.enabled` / `observe.mirror.fps`, env `RN_AGENT_OBSERVE_MIRROR=0` to disable.
