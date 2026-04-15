---
command: test-feature
description: Test a React Native feature on the running simulator/emulator. Verifies UI, user flows, and internal state. Generates a persistent Maestro test file.
argument-hint: [feature-description]
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, mcp__*cdp__*
---

Test this React Native feature: $ARGUMENTS

## Run the rn-tester protocol INLINE (parent session)

> **Important (GH #31):** Do NOT spawn the `rn-tester` agent via the Task tool.
> MCP tools (`cdp_*`, `device_*`) are not available in spawned subagents.
> Execute the rn-tester protocol directly in this parent session using the
> `rn-testing` and `rn-device-control` skills as your reference.

Load the `rn-testing` skill and follow this 7-step protocol in this session:

1. **Environment check** — call `cdp_status`. If it fails, stop and tell the
   user to run `/rn-dev-agent:setup`.
2. **Understand the feature** — read implementation files, find testIDs, routes,
   store slices.
3. **Plan the test** — write test steps and expected outcomes BEFORE executing.
4. **Navigate to start** — use `cdp_navigate` or `device_deeplink` to reach the
   starting screen.
5. **Execute and verify** — for each step:
   - Act (`device_press`, `device_fill`, `device_find`)
   - Wait (`assertVisible` or 1-2s settle)
   - Verify UI (`cdp_component_tree(filter=...)`)
   - Verify data (`cdp_store_state(path=...)` + `cdp_network_log`)
6. **Edge cases** — test empty state, error state, back navigation, rapid taps.
7. **Generate persistent test** — write `flows/<feature-name>.yaml` for CI.

## Verification (mandatory before declaring "tested")

- [ ] `cdp_status` returned `ok:true` with `cdp.connected: true`
- [ ] Every assertion has concrete Evidence (not "looks fine")
- [ ] At least one `device_screenshot` saved
- [ ] `flows/<feature-name>.yaml` written
- [ ] `cdp_error_log` shows 0 new errors at end of flow
- [ ] Cross-platform check via `cross_platform_verify` (or single-platform noted)

## Examples

```
/rn-dev-agent:test-feature shopping cart -- add items, see badge, checkout
/rn-dev-agent:test-feature user authentication -- login, persist session, logout
/rn-dev-agent:test-feature profile screen -- edit name, upload photo, save
```

## Prerequisites

- iOS Simulator or Android Emulator running with the app loaded
- Metro dev server running (`npx expo start` or `npx react-native start`)
- Maestro or maestro-runner installed
- For Zustand apps: `if (__DEV__) global.__ZUSTAND_STORES__ = { ... }` in app entry

## Output

- Pass/fail summary with evidence (screenshots, component tree snapshots, store state)
- A `flows/<feature-name>.yaml` Maestro flow file written to the repo
