---
command: build-and-test
description: Build the Expo/React Native app (local or EAS), install on simulator/emulator, start Metro, then test the specified feature end-to-end.
argument-hint: "[--eas profile] [feature-description]"
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, mcp__*cdp__*
---

Build the app and test this feature: $ARGUMENTS

## Run the build + test protocol INLINE (parent session)

> **Important (GH #31):** Do NOT spawn the `rn-tester` agent via the Task tool.
> MCP tools (`cdp_*`, `device_*`) are not available in spawned subagents.
> Execute the build + test protocol directly in this parent session.

Phase A — Build pre-flight (run in this session):

1. **Detect platform** — check booted devices via `device_list` or `xcrun simctl
   list devices booted` / `adb devices`. Record the result as `<platform>` =
   `ios` or `android` — every script below needs it as argument 1.
2. **Check if app is already running** — call `cdp_status`. If `cdp.connected
   == true` AND `app.dev == true`, skip to Phase B.
3. **Build / install** (substitute `<platform>` with `ios` or `android`):
   - **No `--eas` flag:** run `bash $CLAUDE_PLUGIN_ROOT/scripts/expo_ensure_running.sh <platform>`
     which triggers `npx expo run:ios` or `npx expo run:android` (local build).
   - **With `--eas` flag:** run `bash $CLAUDE_PLUGIN_ROOT/scripts/eas_resolve_artifact.sh <platform> <profile>`
     to find the artifact, then `bash $CLAUDE_PLUGIN_ROOT/scripts/expo_ensure_running.sh <platform> --artifact <path>`
     to install.
4. **Start Metro** if not running (`npx expo start` in background, or instruct
   user to start it).
5. **Confirm CDP** — call `cdp_status` again, must return `ok:true`.

Phase B — Run the rn-tester 7-step protocol (load `rn-testing` skill):

Follow the same protocol as `/rn-dev-agent:test-feature` — environment check,
understand the feature, plan, navigate, execute+verify, edge cases, generate
persistent test.

## Verification (mandatory before declaring complete)

- [ ] `cdp_status` returns `ok:true` with `cdp.connected: true` after Phase A
- [ ] Every test assertion has concrete Evidence
- [ ] At least one `device_screenshot` saved
- [ ] `flows/<feature-name>.yaml` written
- [ ] `cdp_error_log` shows 0 new errors at end

## Examples

```
/rn-dev-agent:build-and-test shopping cart -- local build, then test add-to-cart flow
/rn-dev-agent:build-and-test --eas development login screen -- install EAS build, test auth
/rn-dev-agent:build-and-test --eas preview payment flow -- test a specific EAS profile
```

## Build Modes

| Mode | When | Command |
|------|------|---------|
| Local dev build | Default, no `--eas` flag | `npx expo run:ios` / `npx expo run:android` |
| EAS artifact | `--eas` flag provided | Downloads from EAS, installs on simulator |
| Skip build | App already running | Proceeds directly to testing |

## Prerequisites

- iOS Simulator or Android Emulator **booted** (not necessarily with app installed)
- Expo project with `app.json` or `app.config.js/ts`
- For EAS builds: `eas-cli` installed and logged in (`eas whoami`)
- For local builds: native build tools (Xcode for iOS, Android SDK for Android)
