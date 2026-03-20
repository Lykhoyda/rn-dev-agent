---
command: check-env
description: Check that the React Native development environment is ready for testing -- Metro running, app loaded, CDP connected, no active errors.
allowed-tools: Bash, Read, Grep, mcp__rn-dev-agent-cdp__*
---

Run `cdp_status` and report environment readiness.

Check each subsystem and report status as a table:

| Subsystem | What to check | Source |
|-----------|--------------|--------|
| Metro | Running? Which port? | `cdp_status` → `metro` |
| CDP | Connected to Hermes? Which device/page? | `cdp_status` → `cdp` |
| App | Platform, RN version, Hermes enabled, screen dimensions | `cdp_status` → `app` |
| Capabilities | Network domain available? Fiber tree accessible? | `cdp_status` → `capabilities` |
| Errors | Active error count, RedBox showing, debugger paused? | `cdp_status` → `app.errorCount`, `app.hasRedBox`, `app.isPaused` |
| agent-device | CLI installed? Devices available? | `device_list` → check for at least one device |

If issues are found, suggest the appropriate fix:

| Status | Fix |
|--------|-----|
| Metro not found | `npx expo start` or `npx react-native start` |
| No Hermes target | Open the app on the simulator |
| CDP code 1006 | Close React Native DevTools, Flipper, Chrome DevTools |
| hasRedBox: true | Run `/rn-dev-agent:debug-screen` |
| isPaused: true | Remove `debugger;` statements or use `cdp_reload` |
| fiberTree: false | Only works in `__DEV__` builds with Hermes |
| agent-device not found | `npm install -g agent-device` |
| No devices in device_list | Boot a simulator: `xcrun simctl boot "iPhone 16"` or start an emulator |

Present results clearly with a pass/fail indicator for each subsystem.
If all checks pass, confirm the environment is ready for testing.
