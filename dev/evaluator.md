# Self-Evaluator Protocol

This protocol captures structured data during `rn-feature-dev` runs. It is
referenced by one-line instructions in each phase of the command.

**This file is development-only.** It is NOT registered in
`.claude-plugin/plugin.json` and is not shipped to plugin users.

---

## How It Works

1. Phase 1 initializes a report structure (in-memory, tracked via TodoWrite)
2. Each subsequent phase logs its data to the report structure
3. Phase 7 writes the final report to `docs/reports/YYYY-MM-DD-<slug>.md`
4. Phase 7 also checks for high-confidence bugs and appends them to `docs/BUGS.md`

The agent executing `rn-feature-dev` maintains the report data across phases.
There is no separate process or file — the agent accumulates data and writes
once at the end.

---

## Phase 1: Initialize Report

When Phase 1 starts, establish the report skeleton:

1. Record the **current date** (YYYY-MM-DD) and **start time** (HH:MM)
2. Record the **feature name** from the user's request
3. Derive the **feature slug**:
   - Lowercase, hyphens for spaces, no special characters
   - Max 40 characters, truncate at word boundary
   - Example: "Add notification badge" → `notification-badge`
4. Initialize counters:
   - `phases_completed: 0`
   - `cdp_tools: { called: 0, passed: 0, warned: 0, failed: 0 }`
   - `agents: { launched: 0, useful: 0 }`
   - `recovery_actions: 0`
   - `fix_retry_loops: 0`
   - `bugs_found: { auto_logged: 0, report_only: 0 }`
5. Initialize empty tables for: CDP Tool Results, Recovery Actions, Agent Launches
6. Mark Phase 1 as complete, increment `phases_completed`

---

## Phase 2: Log Exploration

After all explorer agents return:

1. For each agent launched, add a row to **Agent Launches**:
   | Phase | Agent | Aspect | Useful |
   - **Useful** = yes if agent returned 3+ actionable files OR 1+ findings
     with confidence >= 80
   - Increment `agents.launched` for each agent. If useful, also increment `agents.useful`
2. Record total files identified across all agents
3. Add a Phase Results entry:
   ```
   ### Phase 2: Exploration (HH:MM – HH:MM)
   - Agents launched: <N> (<aspects>)
   - Files identified: <N>
   - All agents useful: <yes/no>
   ```
4. Mark Phase 2 complete, increment `phases_completed`

---

## Phase 3: Log Questions

After user answers all questions:

1. Add a Phase Results entry:
   ```
   ### Phase 3: Clarifying Questions (HH:MM – HH:MM)
   - Questions asked: <N>
   - Questions answered: <N>
   ```
2. Mark Phase 3 complete, increment `phases_completed`

---

## Phase 4: Log Architecture

After architect agent returns:

1. For each agent launched, add a row to **Agent Launches**
   - Increment `agents.launched`. If useful, also increment `agents.useful`
2. Check blueprint completeness:
   - Does it include the **Verification Parameters** section?
   - Does it have `primaryComponent`, `storeQueryPath`, `entryRoute`,
     `requiresFullReload`?
3. Add a Phase Results entry:
   ```
   ### Phase 4: Architecture (HH:MM – HH:MM)
   - Agents launched: <N>
   - Blueprint complete: <yes/no> (Verification Parameters: <present/missing>)
   ```
4. Mark Phase 4 complete, increment `phases_completed`

---

## Phase 5: Log Implementation

After implementation and reload:

1. Count files created and files modified
2. Record reload type (fast refresh / full)
3. If `cdp_reload` was called, add a row to **CDP Tool Results**:
   | Phase | Tool | Params | Result | Notes |
4. Update `cdp_tools` counters accordingly
5. Add a Phase Results entry:
   ```
   ### Phase 5: Implementation (HH:MM – HH:MM)
   - Files created: <N> (<names>)
   - Files modified: <N>
   - Reload: <type>
   - cdp_reload result: <PASS/FAIL>
   ```
6. Mark Phase 5 complete, increment `phases_completed`

---

## Phase 5.5: Log Verification

This is the most data-rich phase. For EVERY `cdp_*` tool call:

1. Add a row to **CDP Tool Results**:
   | Phase | Tool | Params | Result | Notes |
   - Phase = "5.5"
   - Result = PASS, WARN, or FAIL based on tool output
   - Notes = error message, known bug ref, or observation
2. Update `cdp_tools` counters (called, passed/warned/failed)

For recovery actions (reconnect, reload, re-inject):
1. Add a row to **Recovery Actions**:
   | Phase | Action | Trigger | Result |
2. Increment `recovery_actions` counter

For fix-and-retry loops:
1. Increment `fix_retry_loops` counter
2. Record per-loop detail in Phase Results:
   ```
   - Fix-retry loops: <N>
     - Loop 1: <error trigger> → <fix applied> → <outcome>
   ```

After verification completes, add a Phase Results entry:
```
### Phase 5.5: Verification (HH:MM – HH:MM)
- Fix-retry loops: <N>
  - Loop N: <detail>
```

Mark Phase 5.5 complete, increment `phases_completed`.

---

## Phase 5.5-retry: Log Re-verification

If Phase 6 triggers re-verification after applying fixes:

1. Log all CDP tool calls with Phase = "5.5-retry"
2. Add a Phase Results entry:
   ```
   ### Phase 5.5-retry (triggered by Phase 6)
   - Re-verification after review fix: <PASS/FAIL> (<N> checks green)
   ```
3. Do NOT increment `phases_completed` (this is part of Phase 6)

---

## Phase 6: Log Review

After all reviewer agents return:

1. For each agent launched, add a row to **Agent Launches**
   - Increment `agents.launched`. If useful, also increment `agents.useful`
2. Record findings count by severity and fixes applied
3. Record whether re-verification was triggered
4. Add a Phase Results entry:
   ```
   ### Phase 6: Quality Review (HH:MM – HH:MM)
   - Agents launched: <N>
   - Findings: <N> critical, <N> important
   - Fixes applied: <N>
   - Re-verification triggered: <yes/no>
   ```
5. Mark Phase 6 complete, increment `phases_completed`

---

## Phase 7: Finalize and Write Report

This is where the accumulated data becomes a file.

### Step 1: Write the summary paragraph

One paragraph covering: feature name, phases completed, CDP tool call totals,
notable warnings/failures, recovery actions, bugs found.

### Step 2: Check for new bugs

Check two sources for potential new bugs:

**Source A: CDP tool FAILs** — for each FAIL result in CDP Tool Results:

**Source B: Phase 6 deferred findings** — for each high-confidence (>= 80)
review finding that was NOT fixed during Phase 6 (deferred by the user),
evaluate whether it represents a real bug. Code quality suggestions and
style issues are report-only; logic errors, null safety, and crash risks
are candidates for BUGS.md.

For each candidate from either source:

1. Read `docs/BUGS.md` and extract all `### B<N>:` entries
2. Check if the failure matches an existing bug using 3-criteria matching:
   - **Tool name** — same `cdp_*` tool
   - **Error pattern** — error message contains the same key phrase
   - **Context** — same platform/environment
3. If all 3 match → reference in report as "Known: B<N>", do not create new bug
4. If 1-2 match → create new bug, reference similar existing one
5. If 0 match → create new bug

For new bugs:
- Find the highest B-number in BUGS.md (`### B<N>:` headers), add 1
- Append to BUGS.md under the appropriate section, matching existing format:
  ```
  ### B<N>: <title> (<SEVERITY>)
  **Context:** <description>
  ```
- Increment `bugs_found.auto_logged`

For WARN results and other observations:
- Add to report-only section
- Increment `bugs_found.report_only`

### Step 3: Determine report file path

```
docs/reports/YYYY-MM-DD-<feature-slug>.md
```

If a file with that name already exists, append `-2`, `-3`, etc.

### Step 4: Write the report file

Mark Phase 7 complete and increment `phases_completed` BEFORE writing, so the
report reflects the final state (8/8 on a fully completed run).

Assemble the full report with:
1. YAML frontmatter (all counters from the accumulated data)
2. `# Evaluation Report: <feature-slug>`
3. `## Summary` — the paragraph from Step 1
4. `## Phase Results` — all phase subsections accumulated during the run
5. `## CDP Tool Results` — the full table
6. `## Recovery Actions` — the full table (omit section if empty)
7. `## Agent Launches` — the full table
8. `## New Issues Found` — split into auto-logged and report-only

### Step 5: Report the file path

Tell the user: "Evaluation report written to `<path>`"

---

## Reference: Result Classification

| Tool Output | Classification |
|-------------|----------------|
| Tool succeeded, data as expected | PASS |
| Tool returned `warnResult` or degraded data | WARN |
| Tool returned `failResult`, error, or timeout | FAIL |
| Known bug reference (matches existing B-number) | WARN (with note) |
