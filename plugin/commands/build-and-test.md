---
command: build-and-test
description: Build the Expo/React Native app (local or EAS), install on simulator/emulator, start Metro, then test the specified feature end-to-end.
argument-hint: [--eas profile] [feature-description]
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, mcp__rn-dev-agent-cdp__*
agent: rn-tester
---

Build the app and test this feature: $ARGUMENTS

## Usage

```
/rn-dev-agent:build-and-test <description>
/rn-dev-agent:build-and-test --eas [profile] <description>
```

## Examples

```
/rn-dev-agent:build-and-test shopping cart -- local build, then test add-to-cart flow
/rn-dev-agent:build-and-test --eas development login screen -- install EAS build, test auth
/rn-dev-agent:build-and-test --eas preview payment flow -- test a specific EAS profile
```

## What This Does

Extends the standard `rn-tester` 7-step protocol with a build pre-flight:

1. **Detect platform** — checks for booted iOS simulator or Android emulator
2. **Check if app is running** — calls `cdp_status` to see if Metro + Hermes are connected
3. **Build/install if needed**:
   - **No `--eas` flag**: runs `expo_ensure_running.sh` which triggers `npx expo run:ios` or `npx expo run:android` (local build, blocks until done)
   - **With `--eas` flag**: runs `eas_resolve_artifact.sh` to find the artifact (cache → EAS servers), then `expo_ensure_running.sh --artifact <path>` to install
4. **Start Metro** if not already running
5. **Run the standard 7-step test protocol** (environment check, understand feature, plan test, navigate, execute+verify, edge cases, generate test file)

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
