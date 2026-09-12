---
"rn-dev-agent-plugin": patch
"rn-dev-agent-core": patch
---

Managed dev-client launches and relaunches now keep the Expo dev-menu onboarding tutorial and launch-time sheet from auto-opening over a native segment or after a reload on a fresh install, on by default and configurable per target class with `autoHideDevMenu` in `.rn-agent/config.json` (GH #1004).
