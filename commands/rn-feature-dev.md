---
command: rn-feature-dev
description: Guided feature development for React Native — explore codebase, design architecture, implement, verify live on device, and review quality.
argument-hint: [feature-description]
---

# React Native Feature Development

You are helping a developer implement a new feature in a React Native app.
Follow this systematic approach: understand the codebase deeply, ask about
all ambiguities, design an elegant architecture, implement, verify live on
the simulator, review quality, and produce E2E proof with screenshots.

## Core Principles

- **Ask clarifying questions**: Identify all ambiguities and edge cases before
  implementing. Wait for user answers before proceeding.
- **Understand before acting**: Read and comprehend existing code patterns first.
- **Read files identified by agents**: When launching agents, ask them to return
  lists of important files. After agents complete, read those files yourself.
- **Simple and elegant**: Prioritize readable, maintainable code.
- **Use TodoWrite**: Track all progress through the phases.
- **Verify on device**: After implementation, prove it works with a live
  screenshot and CDP state checks.

---

## Phase 1: Discovery

**Goal**: Understand what needs to be built.

Initial request: $ARGUMENTS

**Actions**:
1. Create a todo list with all 9 phases (1, 2, 3, 4, 5, 5.5, 6, 7, 8)
2. If the feature is unclear, ask the user:
   - What problem does this solve?
   - What screen is the entry point?
   - Does this touch the store — if so which slice?
   - Are there API calls involved?
3. Summarize your understanding and confirm with the user

**Evaluator**: If `dev/evaluator.md` exists in the plugin root, initialize report — record feature name, slug, start time per `dev/evaluator.md` Phase 1.

---

## Phase 2: Codebase Exploration

**Goal**: Understand relevant existing code and patterns.

**Actions**:
1. Launch 2–3 `rn-code-explorer` agents in parallel. Each should:
   - Trace through the code comprehensively
   - Target a different aspect:
     - "Find screens, components, and navigation routes related to [feature]. Trace
       the component hierarchy. List all testIDs found."
     - "Map the store architecture, API layer, and data flow patterns. Find Redux
       slices, Zustand stores, fetch calls, and React Query usage."
     - "Analyze similar existing features to extract patterns for file naming,
       folder structure, styling, and testing."
   - Include a list of 5–10 key files to read
2. Once agents return, read all files they identified
3. Present a comprehensive summary of findings

**Evaluator**: If `dev/evaluator.md` exists in the plugin root, log agent launches and files identified per `dev/evaluator.md` Phase 2.

---

## Phase 3: Clarifying Questions

**Goal**: Fill in all gaps before designing.

**CRITICAL**: This is the most important phase. DO NOT SKIP.

**Actions**:
1. Review the codebase findings and original feature request
2. Identify underspecified aspects:
   - Error states: what happens when the API fails or data is missing?
   - Loading states: spinner, skeleton, or inline?
   - Empty states: what does the screen show with no data?
   - Navigation: where does the user go on success? On cancel?
   - Store: new slice or extend existing? Redux or Zustand?
   - testIDs: any specific naming convention to follow?
   - Backward compatibility: does this change existing behavior?
   - E2E proof: any specific user flows or edge cases that must be proven?
3. **Present all questions in a clear, organized list**
4. **Wait for answers before proceeding to Phase 4**

If the user says "whatever you think is best", provide your recommendation
and get explicit confirmation.

**Evaluator**: If `dev/evaluator.md` exists in the plugin root, log question counts per `dev/evaluator.md` Phase 3.

---

## Phase 4: Architecture Design

**Goal**: Design the implementation approach.

**Actions**:
1. Launch 1–2 `rn-code-architect` agents with the feature spec, explorer
   findings, and user answers. Ask for a complete blueprint including the
   mandatory **Verification Parameters** and **E2E Proof Flow** sections.
2. Review the blueprint and form your opinion on fit
3. **Verify the E2E Proof Flow** section exists and has:
   - At least 3 steps with specific testIDs/CDP expressions
   - Expected state assertions for each state-changing step
   - Numbered screenshot filenames
   - At least one edge case or secondary flow
   If the architect omitted or under-specified the proof flow, add it yourself
   before presenting to the user — you have the feature context now.
4. Present to user:
   - What will be built (one paragraph)
   - Files to create/modify (list)
   - E2E Proof Flow table (from the blueprint)
   - Whether a full reload or Fast Refresh is sufficient
   - Any trade-offs worth noting
5. **Ask: "Proceed with implementation?"**
6. **Do NOT start Phase 5 without explicit user approval**

**Evaluator**: If `dev/evaluator.md` exists in the plugin root, log agent launches and blueprint completeness per `dev/evaluator.md` Phase 4.

---

## Phase 5: Implementation

**Goal**: Build the feature.

**Actions**:
1. Follow the architect's Build Sequence exactly. Typical order:
   - Store slice / action creators first (if any)
   - API / service layer second (if any)
   - Components — add testIDs to every interactive element
   - Navigation registration
   - `__DEV__` Zustand exposure (if Zustand project)
2. Follow codebase conventions strictly
3. Update todos as you progress
4. After all files are saved:
   - If `requiresFullReload` is true: call `cdp_reload(full=true)` and wait
     for reconnection
   - Otherwise: wait 2 seconds for Fast Refresh to apply

**Evaluator**: If `dev/evaluator.md` exists in the plugin root, log files changed, reload type, and cdp_reload result per `dev/evaluator.md` Phase 5.

---

## Phase 5.5: Live Verification

**Goal**: Prove the feature works on the running simulator/emulator.

This is what separates rn-feature-dev from generic feature development.
After implementation, verify the feature live using CDP tools and screenshots.

**Actions**:

Run this verification sequence in order. Stop and fix if any step fails.

### Step 0: Ensure Simulator & Navigate to Feature

First, verify the simulator is running and CDP is connected:
1. Detect platform: check `xcrun simctl list devices booted` (iOS) or
   `adb devices` (Android)
2. If no device is booted, attempt auto-recovery:
   - Run `bash ${CLAUDE_PLUGIN_ROOT}/scripts/expo_ensure_running.sh <platform>`
   - If exit 0: call `cdp_status` to confirm connection
   - If the script fails: report the error and ask the user to boot the simulator.
     Do not skip verification without user consent.
3. Call `cdp_status` to confirm CDP connection before proceeding.

Then, if the blueprint's `entryRoute` is not "none", navigate to the feature
screen before taking any measurements. After a full reload, the app starts on
the initial route — features on sub-screens will not be visible without
navigation.

**Use `cdp_evaluate` with the app's navigation ref** — deep links trigger
native confirmation dialogs in Expo Go that cannot be dismissed programmatically
(see B56):
```
cdp_evaluate(expression="globalThis.__NAV_REF__?.navigate('<screen>', <params>)")
```

If `__NAV_REF__` is not available, fall back to deep links as a last resort:
```bash
# iOS
xcrun simctl openurl booted "<entryRoute from blueprint>"
# Android
adb shell am start -a android.intent.action.VIEW -d "<entryRoute from blueprint>"
```

After navigation, call `cdp_navigation_state` to confirm you are on the
correct screen. Wait 1-2 seconds for the screen to settle.

### Step 1: Baseline & Screenshot

First, clear the error buffer to establish a baseline:
```
cdp_error_log(clear=true)
```

Then capture the current screen state:
```bash
# iOS
xcrun simctl io booted screenshot --type=jpeg /tmp/rn-feature-verify.jpg
# Android
adb exec-out screencap -p > /tmp/rn-feature-verify.png
```

### Step 2: Health Check

Call `cdp_status`. Gate on:
- `metro.running` = true
- `cdp.connected` = true
- `app.dev` = true (not false)
- `app.hasRedBox` = false
- `app.isPaused` = false
- `app.errorCount` = 0

If `app.dev` is false: CDP is connected to the wrong JS context (common in
RN 0.76+ Bridgeless mode with multiple Hermes targets). Call
`cdp_reload(full=true)` to force reconnection — the target selection now
probes `__DEV__` on each candidate. If still false after reload, ask the
user to restart Metro.

If `isPaused` is true: call `cdp_reload(full=true)` to recover, then
restart Phase 5.5 from Step 0.

If RedBox is showing: read `cdp_error_log`, fix the error in source,
save, wait for Fast Refresh, then restart Phase 5.5 from Step 0.

### Step 3: Component Verification

Call `cdp_component_tree(filter="<primaryComponent from blueprint>", depth=3)`.
Gate on:
- The component appears in the tree
- Key props are present and non-null
- No unexpected error components in the subtree

If the component is not found, call `cdp_navigation_state` to check if you
are on the wrong screen before diagnosing a render issue.

### Step 3.5: Interaction Verification

If the blueprint specifies interactive elements (buttons, pressables, inputs),
exercise at least ONE primary interaction to verify the feature works
end-to-end, not just renders:

1. Use `device_find(text="<button text>", action="click")` or
   `device_press(ref="@<ref>")` to trigger the main user action.
   Fallback: `cdp_interact(testID="<testID>", action="press")` if agent-device unavailable
2. Wait 1-2 seconds for state to settle (or use `device_snapshot` to verify UI changed)
3. Verify the expected side effect:
   - State change: call `cdp_store_state` to confirm
   - Navigation: call `cdp_navigation_state` to confirm
   - Visual: take a screenshot to confirm UI update
4. If the interaction fails, check `cdp_error_log` for handler errors

This step proves the feature is functional, not just rendered. Skip only if
the feature has no interactive elements (e.g., display-only screens).

### Step 4: State Verification

If the blueprint's `storeQueryPath` is not "none":
Call `cdp_store_state(path="<storeQueryPath from blueprint>")`.
Gate on:
- The slice exists
- Data shape matches the architect's design
- No `__agent_error` key in the response

Skip this step if the feature has no store involvement.

### Step 5: Error Regression Check

Call `cdp_error_log`. Gate on:
- Errors array is empty (baseline was cleared in Step 1, so any errors
  here are new regressions introduced by the implementation)

If new errors are present: read the stack trace, fix the source, save,
wait for Fast Refresh, then restart Phase 5.5 from Step 0.

Maximum 3 fix-and-retry loops before escalating to the user with a
full state dump.

### Verification Report

Present results as a table (use the actual screenshot path for the platform):

| Check | Result | Evidence |
|-------|--------|----------|
| Navigation (cdp_navigation_state) | PASS/SKIP | current route |
| Screenshot | PASS/FAIL | actual file path |
| Health (cdp_status) | PASS/FAIL | errorCount, hasRedBox, isPaused |
| Component (cdp_component_tree) | PASS/FAIL | component found, props summary |
| Interaction (device_find/device_press) | PASS/FAIL/SKIP | action + side effect verified |
| State (cdp_store_state) | PASS/FAIL/SKIP | state shape summary |
| Errors (cdp_error_log) | PASS/FAIL | error count since baseline |

**Gate**: All checks must be PASS (or SKIP where not applicable)
before proceeding to Phase 6.

**Evaluator**: If `dev/evaluator.md` exists in the plugin root, log every CDP tool call, recovery action, and fix-retry loop per `dev/evaluator.md` Phase 5.5.

---

## Phase 6: Quality Review

**Goal**: Ensure code is clean, correct, and follows RN conventions.

**Actions**:
1. Launch 2–3 `rn-code-reviewer` agents in parallel:
   - "Review the implementation for correctness: logic errors, null safety,
     async error handling, memory leaks. Scope: [list of files changed]"
   - "Review the implementation for React Native conventions: testID coverage
     on all interactive elements, `__DEV__` guards on debug code, Zustand
     exposure, selector memoization. Scope: [list of files changed]"
   - "Review the implementation for project conventions: file naming, folder
     structure, import patterns, CLAUDE.md rules. Scope: [list of files changed]"
2. Consolidate findings — only issues with confidence >= 80
3. If no high-confidence issues found: confirm the code meets standards and
   proceed directly to Phase 7
4. If issues found: **present findings grouped by severity (Critical, then
   Important)** and **ask: "Which findings should I fix?"**
5. Apply approved fixes
6. If fixes were applied, re-run Phase 5.5 verification to confirm nothing broke

**Evaluator**: If `dev/evaluator.md` exists in the plugin root, log agent launches, findings, and re-verification per `dev/evaluator.md` Phase 6. If re-verification ran, log as Phase 5.5-retry.

---

## Phase 7: Summary

**Goal**: Document what was accomplished.

**Actions**:
1. Summarize:
   - **What was built** (one paragraph)
   - **Files created/modified** (table with file path + change type)
   - **Key decisions made** (align with docs/DECISIONS.md format)
   - **Verification results** (the Phase 5.5 table)
   - **Review findings** (count fixed / count deferred)

**Evaluator**: If `dev/evaluator.md` exists in the plugin root, finalize and write the evaluation report per `dev/evaluator.md` Phase 7. Append high-confidence bugs to `docs/BUGS.md`.

---

## Phase 8: E2E Proof

**Goal**: Produce a permanent proof artifact showing the feature works end-to-end,
with screenshots of each step of the user flow.

**CRITICAL**: This phase executes the **E2E Proof Flow** designed by the architect
in Phase 4 — step by step, mechanically. Do NOT improvise the flow, skip steps,
or simplify the sequence. The architect (Opus) designed this flow with full feature
context. Your job is to execute it faithfully and capture the evidence.

The output is a `docs/proof/<feature-slug>/` directory with numbered screenshots
and a `PROOF.md` summary.

**Actions**:

### Step 1: Prepare proof directory

```bash
mkdir -p docs/proof/<feature-slug>
```

Use the feature slug from Phase 1 (e.g., `s4-notification-snooze`, `profile-edit-modal`).

### Step 2: Execute the E2E Proof Flow from the blueprint

Read the **E2E Proof Flow** table from the Phase 4 blueprint. For each row
in the table, execute in order:

1. **Perform the action** exactly as specified:
   - Navigation: use `cdp_evaluate` with the expression from the table
   - Interaction: use `device_find(text="<text>", action="click")`,
     `device_press(ref="@<ref>")`, or `device_fill(ref="@<ref>", text="<input>")`
   - Wait 1-2 seconds for state to settle (or use `device_snapshot` to confirm)

2. **Capture the screenshot** using the exact filename from the table:
   ```bash
   # iOS
   xcrun simctl io booted screenshot --type=jpeg docs/proof/<feature-slug>/<filename>
   # Android
   adb exec-out screencap -p > docs/proof/<feature-slug>/<filename>
   ```

3. **Verify the expected state** as specified in the table:
   - If the table specifies a store assertion: call `cdp_store_state` and
     verify the value matches
   - If the table specifies a navigation assertion: call `cdp_navigation_state`
   - If the table specifies a visual assertion: verify via the screenshot
   - Record the actual value for the PROOF.md

4. **If a step fails**: fix the issue and retry that step. Do NOT skip steps
   or proceed with a failing assertion. Maximum 2 retries per step before
   escalating to the user.

Execute ALL rows in the table. Do not stop early or skip "optional" steps —
the architect included them for a reason.

### Step 3: Write PROOF.md

Create `docs/proof/<feature-slug>/PROOF.md` with this structure:

```markdown
# <Feature Name> — E2E Proof

**Date:** <YYYY-MM-DD>
**Device:** <device name> (<OS version>, Simulator/Emulator)
**Method:** CDP interactions + screenshots (flow designed by architect in Phase 4)

## Flow

| Step | Screenshot | Action | Verification |
|------|-----------|--------|--------------|
| 1 | 01-initial.jpg | Navigate to <screen> | Route confirmed via cdp_navigation_state |
| 2 | 02-action.jpg | <interaction description> | <state or visual confirmation> |
| 3 | 03-result.jpg | <interaction description> | <state or visual confirmation> |

## Key State Snapshots

- After step 2: `store.path = <value>`
- After step 3: `store.path = <value>`

## Deviations from Plan

List any steps where the actual result differed from the architect's expected
state, or any steps that required retries. If none, write "None — all steps
matched the architect's E2E Proof Flow."

## Files

- `01-initial.jpg` — <description>
- `02-action.jpg` — <description>
- `03-result.jpg` — <description>
```

### Step 4: Mark complete

Mark all todos complete. The feature is done — implemented, verified, reviewed,
and proven with screenshots.

**Gate**: PROOF.md exists, contains screenshots for ALL steps in the architect's
E2E Proof Flow, and all state assertions match. If screenshot capture fails
(e.g., no simulator), log the failure in PROOF.md and note it in the Phase 7
summary. If a state assertion doesn't match, this is a bug — fix it before
completing.

---

## Prerequisites

- iOS Simulator or Android Emulator running with the app loaded
- Metro dev server running (`npx expo start` or `npx react-native start`)
- For Zustand apps: `if (__DEV__) global.__ZUSTAND_STORES__ = { ... }` in app entry

## Recovery Procedures

- **Simulator not running**: Auto-recovery via `expo_ensure_running.sh` is
  attempted in Phase 5.5 Step 0. If that fails, ask the user to boot it.
  Verification can be skipped with explicit user consent, but must be noted
  in the Phase 7 summary.
- **RedBox during verification**: Read `cdp_error_log`, fix source, reload,
  restart Phase 5.5.
- **CDP not connecting**: Call `cdp_status` which auto-connects. If that
  fails, check Metro is running (`curl http://localhost:8081/status`).
- **Debugger paused**: Call `cdp_reload(full=true)` to resume.
- **Another debugger connected (code 1006)**: Ask user to close React Native
  DevTools, Flipper, or Chrome DevTools.
