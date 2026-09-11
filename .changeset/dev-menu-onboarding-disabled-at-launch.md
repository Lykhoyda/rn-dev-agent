---
"rn-dev-agent-plugin": patch
"rn-dev-agent-core": patch
---

Append `disableOnboarding=1` to every managed dev-client launch and relaunch URL, and pass the Android dev-launcher no-auto-launch intent extra on managed `am start` launches, so the Expo dev menu never auto-opens over a native segment or after a reload on a fresh install (GH #1004).
