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

1. **Resolve session authority** — call `rn_session(action="status")` and
   require the intended worktree, platform, exact UUID/serial, and app ID.
   `device_list` may diagnose available hardware but never selects the target.
2. **Check if app is already running** — call passive `cdp_status`. If the
   session's exact signed target is connected and `app.dev == true`, skip to
   Phase B.
3. **Build / install** (substitute `<platform>` with `ios` or `android`):
   - **No `--eas` flag:** after previewing and confirming the session
     integration, run literal `pnpm ios` or `pnpm android`. The adapter injects
     the exact device and allocated Metro port and records the build/install
     receipt.
   - **With `--eas` flag:** enter one shell scope, create `<artifact-dir>` with
     `artifact_dir=$(mktemp -d)`, and immediately register
     `trap 'rm -rf -- "$artifact_dir"' EXIT` in that same scope. Then run
     `bash "$CLAUDE_PLUGIN_ROOT/scripts/eas_resolve_artifact.sh" "<platform>" "<profile>" "<artifact-dir>"`,
     parse a successful absolute artifact path, and run
     `bash "$CLAUDE_PLUGIN_ROOT/scripts/expo_ensure_running.sh" "<platform>" --device-id "<device-id>" --artifact "<path>"`.
     Keep resolution and installation inside the trapped scope so every success
     or failure path cleans only that exact caller-owned directory after the
     install attempt.
4. **Start Metro** only through the literal integrated package script; an
   ambient default-port Metro is diagnostic, not authoritative.
5. **Confirm CDP** — call `cdp_connect` for the exact signed target, then
   passive `cdp_status`.

Phase B — Run the rn-tester protocol (load `rn-testing` skill):

Follow the same protocol as `/rn-dev-agent:test-feature`, INCLUDING its
mandatory Step 0 — scan saved actions (`/rn-dev-agent:list-learned-actions`)
and replay a matching flow BEFORE composing any `device_*` primitives — then
environment check, understand the feature, plan, navigate, execute+verify,
edge cases, generate persistent test.

## Verification (mandatory before declaring complete)

- [ ] `cdp_status` returns `ok:true` with `cdp.connected: true` after Phase A
- [ ] Every test assertion has concrete Evidence
- [ ] At least one `device_screenshot` saved
- [ ] `<test-app>/.rn-agent/actions/<feature>.yaml` written (auto-emitted on pass)
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
