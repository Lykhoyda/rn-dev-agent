---
"rn-dev-agent-plugin": minor
---

Harden device-control conflicts: add an Android serial-scoped device lock (parity with iOS) that engages on a normal emulator, separate the Android runner's probed host port from its fixed device-listener port (`adb forward`), and let the iOS runner self-assign a free port when 22088 is taken.
