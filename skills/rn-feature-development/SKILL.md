---
name: rn-feature-development
description: >
  Full 8-phase React Native feature development pipeline — discovery, codebase
  exploration, clarifying questions, architecture, implementation, live
  verification, quality review, and E2E proof. Use when building any new
  feature in a React Native or Expo app. Triggers on "build a feature",
  "add X to the app", "implement Y", "create a new screen", "rn-feature-dev",
  "feature development", "build me X".
---

# React Native Feature Development (8-Phase Pipeline)

You are helping a developer implement a new feature in a React Native app.
Follow this systematic approach: understand the codebase deeply, ask about
all ambiguities, design an elegant architecture, implement, verify live on
the simulator, review quality, and produce E2E proof with screenshots.

## Core Principles

- **NEVER skip phases**: Every phase (1-8) must be executed. Do NOT bypass
  explorer agents (Phase 2), architect agents (Phase 4), reviewer agents
  (Phase 6), or proof capture (Phase 8) even when the codebase is familiar.
  Speed comes from parallel agent launches, not phase elimination.
- **Ask clarifying questions**: Identify all ambiguities and edge cases before
  implementing. Wait for user answers before proceeding.
- **Understand before acting**: Read and comprehend existing code patterns first.
- **Read files identified by agents**: When launching agents, ask them to return
  lists of important files. After agents complete, read those files yourself.
- **Simple and elegant**: Prioritize readable, maintainable code.
- **Use TodoWrite**: Track all progress through the phases.
- **Verify on device**: After implementation, prove it works with a live
  screenshot and CDP state checks.
- **Cross-platform visual verification**: When both iOS and Android are
  available, compare screenshots element-by-element. A screen that renders
  without crashing but has missing icons/images is a FAIL, not a PASS.

---

## Phase 1: Discovery

**Goal**: Understand what needs to be built.

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

### GATE: Environment Readiness (CRITICAL — GH #28)

**Before ANY verification, confirm the environment is functional.**
Call `cdp_status`. If it fails to connect:

1. **DO NOT proceed to verification.** Do not fall back to raw bash commands.
2. **DO NOT use `xcrun simctl`, `adb`, or `xcodebuild` as substitutes for
   CDP tools.** These bypass the plugin's connection management and error
   recovery, and produce a degraded experience.
3. Instead, tell the user:
   - "CDP connection failed. Please ensure Metro is running (`npx expo start`
     or `npx react-native start`) and the app is loaded on a simulator."
   - "Run `/rn-dev-agent:check-env` to diagnose missing dependencies."
4. If Metro is running but CDP still fails, check:
   - Is another debugger connected? (React Native DevTools, Flipper, Chrome)
   - Is the app on the Dev Client launcher instead of the actual app?
   - Is the correct platform targeted? (`cdp_connect(platform="ios")`)

**Only proceed to Step 0 after `cdp_status` returns `ok: true`.**

### Step 0: Ensure Simulator & Navigate to Feature

First, verify the simulator is running and CDP is connected:
1. Call `device_list` to check for booted simulators/emulators
2. If no device is booted, attempt auto-recovery:
   - Run `rn-ensure-running <platform>`
   - If exit 0: call `cdp_status` to confirm connection
   - If the script fails: tell the user to boot a simulator and run
     `/rn-dev-agent:setup` to verify all dependencies are installed.
     Do not skip verification without user consent.
3. Call `cdp_status` to confirm CDP connection before proceeding.

Then, if the blueprint's `entryRoute` is not "none", navigate to the feature
screen using `cdp_navigate` or `cdp_evaluate`:
```
cdp_navigate(screen="<screen>", params={...})
```
Or if `cdp_navigate` is unavailable:
```
cdp_evaluate(expression="globalThis.__NAV_REF__?.navigate('<screen>', <params>)")
```

If navigation ref is not available, use `device_deeplink` as a last resort:
```
device_deeplink(url="<entryRoute from blueprint>")
```

After navigation, call `cdp_navigation_state` to confirm you are on the
correct screen. Wait 1-2 seconds for the screen to settle.

### Step 1: Baseline & Screenshot

First, clear the error buffer to establish a baseline:
```
cdp_error_log(clear=true)
```

Then capture the current screen state:
```
device_screenshot(path="/tmp/rn-feature-verify.jpg")
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

### Step 6: Cross-Platform Element Verification (CRITICAL)

**If both iOS and Android are available**, run this check BEFORE marking
verification as complete. This catches platform-specific rendering failures
(e.g., missing icon fonts, layout differences, invisible elements).

1. **Build an element checklist** from the architect's blueprint — list every
   new UI element (icons, buttons, text, images) with its testID.
2. **Take screenshots on BOTH platforms** and compare element-by-element.
3. **Present a cross-platform comparison table:**

| Element | testID | iOS | Android |
|---------|--------|-----|---------|
| Like icon | feed-like-1 | visible | visible/MISSING |
| Like count | feed-like-count-1 | "1" | "1" |
| Avatar image | profile-avatar-image | visible | visible/MISSING |

4. **Any "MISSING" = FAIL** — do not proceed. Diagnose the cause (missing
   font assets, native rebuild needed, platform-specific API differences).
5. If the issue requires a native rebuild (e.g., font assets not linked),
   log it in `docs/BUGS.md` and note it in the verification report.
   Verification can proceed with the working platform, but the MISSING
   elements must be documented and the Android column in the results log
   must show the actual status, not a false "PASS".

**Never mark a platform as "PASS" if UI elements are invisible or missing.**
A screen that loads without crashing but has missing icons is a FAIL, not
a PASS.

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

### Step 1.5: Pre-recording setup and start video

**Pre-recording readiness (GH #8, #9):**
1. Call `cdp_status` — auto-detects and dismisses the Dev Client picker if
   an agent-device session is open (GH #9). If warning returned, retry.
2. Call `cdp_navigation_state` — verify a valid route (not Dev Client picker).
   If still stuck, ask the user to select the Metro server.
3. Call `cdp_dev_settings(action="disableDevMenu")` — suppress dev menu popups
   during recording.
4. Take a baseline screenshot to confirm app is on an actual screen.

Then start recording:

```bash
# Detect platform
PLATFORM="ios"  # or "android" based on booted devices

# Start recording
rn-record-proof start $PLATFORM docs/proof/<feature-slug>/flow-$PLATFORM.mp4
```

If recording fails to start (no simulator, permissions), log a warning and
continue — video is a nice-to-have, not a gate. Screenshots remain primary.

### Step 2: Execute the E2E Proof Flow from the blueprint

Read the **E2E Proof Flow** table from the Phase 4 blueprint. For each row
in the table, execute in order:

1. **Perform the action** exactly as specified:
   - Navigation: use `cdp_evaluate` with the expression from the table
   - Interaction: use `device_find(text="<text>", action="click")`,
     `device_press(ref="@<ref>")`, or `device_fill(ref="@<ref>", text="<input>")`
   - Wait 1-2 seconds for state to settle (or use `device_snapshot` to confirm)

2. **Capture the screenshot** using the exact filename from the table:
   ```
   device_screenshot(path="docs/proof/<feature-slug>/<filename>")
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

### Step 2.5: Stop recording and convert

Stop the background video recording:

```bash
rn-record-proof stop
```

Attempt GIF conversion for inline PR display:

```bash
rn-record-proof convert-gif \
  docs/proof/<feature-slug>/flow-$PLATFORM.mp4 \
  docs/proof/<feature-slug>/flow-$PLATFORM.gif
```

If ffmpeg is not available, skip GIF conversion — the raw .mp4 is still useful.

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

### Step 4: Validate proof artifacts (CRITICAL)

**Before presenting proof to the user, verify the recording and screenshots
actually show the expected feature.** This prevents presenting invalid proof.

Validation checklist:
1. **Video file exists and has reasonable size** (> 10KB):
   ```bash
   ls -la docs/proof/<feature-slug>/flow-*.mp4 2>/dev/null
   ```
2. **Final screenshot shows the expected end state** — verify via
   `cdp_component_tree` or `cdp_navigation_state` that the app is on the
   expected screen with expected data visible.
3. **No errors during recording** — call `cdp_error_log` and confirm no
   new errors appeared during the proof flow.
4. **All numbered screenshots exist** with non-zero size.

If validation fails: report what went wrong and ask the user if they want
to re-record. Do NOT present invalid proof as complete.

### Step 5: Generate PR body

```bash
rn-generate-pr-body docs/proof/<feature-slug>/
```

This produces `docs/proof/<feature-slug>/PR-BODY.md` — a ready-to-paste PR
description with embedded screenshots, video upload placeholders, device
info, and a files-changed summary.

### Step 6: Mark complete

Mark all todos complete. The feature is done — implemented, verified, reviewed,
and proven with screenshots and video.

**Gate**: PROOF.md exists, contains screenshots for ALL steps in the architect's
E2E Proof Flow, all state assertions match, and PR-BODY.md is generated.
If screenshot capture fails (e.g., no simulator), log the failure in PROOF.md
and note it in the Phase 7 summary. If a state assertion doesn't match,
this is a bug — fix it before completing.

---

## Prerequisites

- iOS Simulator or Android Emulator running with the app loaded
- Metro dev server running (`npx expo start` or `npx react-native start`)
- For Zustand apps: `if (__DEV__) global.__ZUSTAND_STORES__ = { ... }` in app entry

## Safety Constraints (GH #5)

- **NEVER launch parallel agents targeting the same device.** Multiple agents
  competing for one simulator causes cascading failures (app data cleared,
  Metro restarted on wrong branch, screenshot races). Use sequential testing
  or separate devices.
- **NEVER change git state** from agents — no `git checkout`, `git stash`,
  `git reset`. Agents read and verify, they don't manage branches.
- **Retry budget**: All agents follow a max-3-retries-per-action-type rule.
  After 3 failures, they stop and report the blocker.

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

---

## Common Rationalizations

Each phase has shortcuts agents reach for. Don't.

| Excuse | Reality |
|--------|---------|
| "I read the explorer's report — skip reading the actual files" | Explorer reports are summaries. Read 2-3 key files the explorer flagged before designing. |
| "The blueprint is detailed enough — implement directly, skip questions" | Phase 3 (Questions) catches the 5 assumptions that would waste 2 hours of rework. Ask them. |
| "Phase 5.5 verification is slow — skip it and trust the review" | Code review ≠ runtime verification. A component can look correct and render wrong. `cdp_component_tree` + `cdp_store_state` takes 10 seconds. |
| "I tested iOS — Android works the same" | Wrong ~40% of the time. Keyboard, permissions, back button, text input, safe-area all differ. `cross_platform_verify` is mandatory unless explicitly single-platform. |
| "Phase 6 found 1 issue — ship it" | Review agents already filter by confidence. If ONE flags an issue, read it fully. |
| "Phase 8 (E2E Proof) is just for PR theater" | Proof flows become the permanent Maestro test file. Skip them and you pay in manual testing every sprint. |

## Red Flags — Stop and Reconsider

- About to enter Phase 5 without user approval on the architecture
- About to mark Phase 5.5 complete with a PASS row that has empty Evidence
- About to commit without running `cdp_error_log` to confirm zero new errors
- About to skip a phase "because the feature is small"
- About to add a dependency without asking the user first
- Editing files outside the architect's blueprint "while I'm here"

## Boundaries

### Always
- Call `cdp_status` before Phase 5.5 starts
- Run the architect's proof flow step-by-step in Phase 8
- Use MCP tools (cdp_*, device_*) for app state reads
- Present the Phase 5.5 verification table with concrete Evidence
- Gate Phase 5 on user approval of the architecture

### Ask First
- Adding any new dependency to the user's project
- Changing navigation structure (route names, param types)
- Modifying existing store shape
- Creating more than 5 files for a single feature
- Disabling an existing test

### Never
- Claim "done" without a Phase 5.5 table with Evidence in every row
- Use `xcrun simctl` or `adb` for app interaction (use MCP tools)
- Refactor adjacent components ("while I'm here")
- Add `console.log` calls and leave them in committed code
- Proceed past Phase 4 without user approval on architecture
- Commit with `cdp_error_log` showing new errors

## Verification — Feature Complete When

- [ ] Phase 5.5 verification table has concrete Evidence in every row (no blanks, no "seems fine")
- [ ] `cdp_status` returns `ok:true` at end of Phase 5.5 and Phase 8
- [ ] `cdp_error_log` shows 0 new errors at end of Phase 8
- [ ] At least 3 numbered screenshots saved to `docs/proof/<feature>/`
- [ ] `PROOF.md` written with the architect's steps and actual results
- [ ] Phase 6 review agents all reported (or "no high-confidence issues")
- [ ] `cross_platform_verify` run OR single-platform noted in Phase 7 summary
- [ ] Phase 7 summary lists: files modified, decisions logged, verification results
- [ ] No adjacent files modified outside the architect's blueprint
