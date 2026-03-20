---
command: test-feature
description: Test a React Native feature on the running simulator/emulator. Verifies UI, user flows, and internal state. Generates a persistent Maestro test file.
argument-hint: [feature-description]
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, mcp__rn-dev-agent-cdp__*
agent: rn-tester
---

Test this React Native feature: $ARGUMENTS

## Usage

```
/rn-dev-agent:test-feature <description>
```

## Examples

```
/rn-dev-agent:test-feature shopping cart -- add items, see badge, checkout
/rn-dev-agent:test-feature user authentication -- login, persist session, logout
/rn-dev-agent:test-feature profile screen -- edit name, upload photo, save
```

## What This Does

Invokes the `rn-tester` agent, which runs a 7-step verification protocol:

1. **Environment check** -- confirms Metro running, CDP connected, no RedBox
2. **Understand the feature** -- reads implementation files, finds testIDs, routes, store slices
3. **Plan the test** -- writes test steps and expected outcomes before executing
4. **Navigate to start** -- uses deep links or Maestro to reach the starting screen
5. **Execute and verify** -- for each step: act (Maestro), wait (assertVisible), verify UI (cdp_component_tree), verify data (cdp_store_state + cdp_network_log)
6. **Edge cases** -- tests empty state, error state, back navigation, rapid interactions
7. **Generate persistent test** -- writes `flows/<feature-name>.yaml` for CI

## Prerequisites

- iOS Simulator or Android Emulator running with the app loaded
- Metro dev server running (`npx expo start` or `npx react-native start`)
- Maestro or maestro-runner installed (`brew install maestro`)
- For Zustand apps: `if (__DEV__) global.__ZUSTAND_STORES__ = { ... }` in app entry

## Output

- Pass/fail summary with evidence (screenshots, component tree snapshots, store state)
- A `flows/<feature-name>.yaml` Maestro flow file written to the repo
