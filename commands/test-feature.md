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

Load the `rn-testing` skill and follow this 8-step protocol in this session:

0. **Artifact-first scan (MANDATORY before any device_* call).** Glob
   `**/test-app/.maestro/flows/*.yaml` (and `.ui-skeleton.yaml`) within the
   current project AND the sibling workspace at
   `../rn-dev-agent-workspace/test-app/.maestro/flows/`. For each candidate,
   read the file header / appId and decide if it matches the requested
   feature by:
   - filename keyword overlap with `$ARGUMENTS`
   - first-comment-block intent overlap with `$ARGUMENTS`
   If a match exists, **REPLAY IT FIRST** via:
   ```bash
   maestro-runner --platform <ios|android> test -e KEY=VAL <flow-path>
   ```
   If the replay passes, you have your evidence — proceed to step 7
   (verification + generate-or-refresh artifact). If the replay fails with a
   concrete error (`Element not found`, `assertion failed`), fix the flow
   rather than abandoning to manual primitives. Falling back to `device_*`
   walks WITHOUT having tried the existing flow is a captured anti-pattern
   (see `feedback_execute_artifacts_before_manual.md` in auto-memory). Run
   `/rn-dev-agent:list-learned-actions` if you want to inspect the
   inventory.
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
7. **Generate or refresh persistent test (MANDATORY).** Always end the run by
   ensuring a Maestro flow exists for the tested feature:
   - If step 0 found and replayed an existing flow: re-validate it still
     covers the new edge cases; if you discovered a gap, ADD steps to the
     existing flow (don't fork a new file).
   - If step 0 found NO matching flow: prefer **auto-emission** over hand-
     authoring. Wrap the manual walk between `cdp_record_test_start` and
     `cdp_record_test_stop`, then `cdp_record_test_save` to write
     `<test-app>/.maestro/flows/<feature-slug>.yaml` with the metadata
     header pre-populated (`id`, `intent`, `tags`, `mutates`, `status` —
     see `skills/rn-testing/SKILL.md` "Reusable Action Metadata Schema").
     Hand-edit the result to parameterise input strings via `${VAR}`
     placeholders and add a `when: visible: id: tab-X` self-bootstrap if
     the flow assumes a starting screen. If `<test-app>/.ui-skeleton.yaml`
     exists, add any new testIDs the flow references there too.
   - If step 0 found a flow that doesn't cleanly extend (different feature
     overlap), still add a NEW flow. Two short flows beat one tangled flow.

## Verification (mandatory before declaring "tested")

- [ ] Step 0 was performed: existing flows scanned, candidate replayed (or
      explicit "no match" + plan to write one)
- [ ] `cdp_status` returned `ok:true` with `cdp.connected: true`
- [ ] Every assertion has concrete Evidence (not "looks fine")
- [ ] At least one `device_screenshot` saved
- [ ] `<test-app>/.maestro/flows/<feature>.yaml` exists at end of run (either
      pre-existed and was replayed, or was newly written this session)
- [ ] If `<test-app>/.ui-skeleton.yaml` exists, any new testIDs the flow
      references are added there
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
