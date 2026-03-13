# Self-Evaluator Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a development-time  evaluation protocol that captures structured data during `rn-feature-dev` runs and produces reports in `docs/reports/`.

**Architecture:** A single markdown file (`dev/evaluator.md`) contains the full evaluation protocol. It is referenced by one-line instructions in each phase of `commands/rn-feature-dev.md`. Reports are written to `docs/reports/YYYY-MM-DD-<slug>.md` with YAML frontmatter. High-confidence bugs are auto-appended to `docs/BUGS.md`.

**Tech Stack:** Markdown only — no code, no tests. All files are agent instructions or reports.

**Spec:** `docs/superpowers/specs/2026-03-12-self-evaluator-design.md`

---

## Chunk 1: File scaffolding and evaluator protocol

### Task 1: Create reports directory

**Files:**
- Create: `docs/reports/.gitkeep`

- [x] **Step 1: Create the .gitkeep file**

```bash
mkdir -p docs/reports && touch docs/reports/.gitkeep
```

- [x] **Step 2: Verify directory exists**

```bash
ls -la docs/reports/
```

Expected: `.gitkeep` file present.

- [x] **Step 3: Commit**

```bash
git add docs/reports/.gitkeep
git commit -m "chore: add docs/reports/ directory for evaluator reports"
```

---

### Task 2: Create dev/evaluator.md

This is the core deliverable — the full evaluation protocol that the agent reads during `rn-feature-dev` runs.

**Files:**
- Create: `dev/evaluator.md`

- [x] **Step 1: Create the dev directory**

```bash
mkdir -p dev
```

- [x] **Step 2: Write dev/evaluator.md**

Write the file with the following content. This translates the spec's Capture Protocol and Report Format sections into agent-executable instructions.

```markdown
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

For each FAIL result in CDP Tool Results:

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
  **Fixed/Context:** <description>
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

Mark Phase 7 complete, increment `phases_completed`.

---

## Reference: Result Classification

| Tool Output | Classification |
|-------------|----------------|
| Tool succeeded, data as expected | PASS |
| Tool returned `warnResult` or degraded data | WARN |
| Tool returned `failResult`, error, or timeout | FAIL |
| Known bug reference (matches existing B-number) | WARN (with note) |
```

- [x] **Step 3: Verify the file is not in plugin.json**

Read `.claude-plugin/plugin.json` and confirm `dev/evaluator.md` is NOT referenced anywhere in the manifest.

- [x] **Step 4: Commit**

```bash
git add dev/evaluator.md
git commit -m "feat: add self-evaluator protocol for rn-feature-dev runs"
```

---

## Chunk 2: Integrate evaluator into rn-feature-dev command

### Task 3: Add evaluator references to each phase in rn-feature-dev.md

**Files:**
- Modify: `commands/rn-feature-dev.md`

Add a one-line `**Evaluator**:` instruction at the end of each phase's Actions section. The evaluator reference tells the agent what to capture for that phase. Each reference points to `dev/evaluator.md` for the full protocol.

- [x] **Step 1: Add evaluator reference to Phase 1**

After line `3. Summarize your understanding and confirm with the user`, add:

```markdown

**Evaluator**: Initialize report — record feature name, slug, start time per `dev/evaluator.md` Phase 1.
```

- [x] **Step 2: Add evaluator reference to Phase 2**

After line `3. Present a comprehensive summary of findings`, add:

```markdown

**Evaluator**: Log agent launches and files identified per `dev/evaluator.md` Phase 2.
```

- [x] **Step 3: Add evaluator reference to Phase 3**

After line `4. **Wait for answers before proceeding to Phase 4**`, add:

```markdown

**Evaluator**: Log question counts per `dev/evaluator.md` Phase 3.
```

- [x] **Step 4: Add evaluator reference to Phase 4**

After line `5. **Do NOT start Phase 5 without explicit user approval**`, add:

```markdown

**Evaluator**: Log agent launches and blueprint completeness per `dev/evaluator.md` Phase 4.
```

- [x] **Step 5: Add evaluator reference to Phase 5**

After the reload instructions (after `Otherwise: wait 2 seconds for Fast Refresh to apply`), add:

```markdown

**Evaluator**: Log files changed, reload type, and cdp_reload result per `dev/evaluator.md` Phase 5.
```

- [x] **Step 6: Add evaluator reference to Phase 5.5**

After the Verification Report table (after `**Gate**: All checks must be PASS...`), add:

```markdown

**Evaluator**: Log every CDP tool call, recovery action, and fix-retry loop per `dev/evaluator.md` Phase 5.5.
```

- [x] **Step 7: Add evaluator reference to Phase 6**

After line `6. If fixes were applied, re-run Phase 5.5 verification to confirm nothing broke`, add:

```markdown

**Evaluator**: Log agent launches, findings, and re-verification per `dev/evaluator.md` Phase 6. If re-verification ran, log as Phase 5.5-retry.
```

- [x] **Step 8: Add evaluator reference to Phase 7**

After the summary bullet list (after `Suggested next step...`), add:

```markdown

**Evaluator**: Finalize and write the evaluation report per `dev/evaluator.md` Phase 7. Append high-confidence bugs to `docs/BUGS.md`.
```

- [x] **Step 9: Verify all 8 phases have evaluator references**

Search `commands/rn-feature-dev.md` for `**Evaluator**:` — should find exactly 8 occurrences (Phases 1, 2, 3, 4, 5, 5.5, 6, 7).

- [x] **Step 10: Commit**

```bash
git add commands/rn-feature-dev.md
git commit -m "feat: add evaluator references to all rn-feature-dev phases"
```

---

### Task 4: Update ROADMAP.md and DECISIONS.md

**Files:**
- Modify: `docs/ROADMAP.md` (append Phase 18)
- Modify: `docs/DECISIONS.md` (append D207-D209)

- [x] **Step 1: Append Phase 18 to ROADMAP.md**

Add at the end of the file:

```markdown

## Phase 18: Self-Evaluator Protocol (Complete)

**Status:** Complete (2026-03-12)

Development-time evaluation protocol that captures structured data during
`rn-feature-dev` runs and produces reports in `docs/reports/`.

### Deliverables
- `dev/evaluator.md` — evaluation protocol (not shipped to users)
- `docs/reports/` — report output directory
- Evaluator references in all 8 phases of `commands/rn-feature-dev.md`

### Decisions (D207-D209)
- D207: Evaluator lives in dev/, outside plugin manifest
- D208: Inline capture during rn-feature-dev, not post-run analysis
- D209: Confidence-gated bug logging to BUGS.md
```

- [x] **Step 2: Append D207-D209 to DECISIONS.md**

Add at the end of the file:

```markdown

## 2026-03-12: Self-Evaluator Protocol

### D207: Evaluator lives in dev/, outside plugin manifest
The self-evaluator is a development-time tool for improving the plugin, not a user-facing feature. Placing it in `dev/` keeps it out of `.claude-plugin/plugin.json` and ensures it is never shipped to plugin consumers.

### D208: Inline capture during rn-feature-dev, not post-run analysis
Capturing data inline during the run (via one-line evaluator references per phase) produces the most accurate and complete data. Post-run analysis from git history or conversation transcripts would be incomplete and error-prone.

### D209: Confidence-gated bug logging to BUGS.md
Only high-confidence failures (tool errors, timeouts, crashes, failed recoveries) are auto-appended to BUGS.md. Warnings and ambiguous observations go to the report only, avoiding noise in the bug tracker. 3-criteria deduplication (tool + error pattern + context) prevents duplicate entries.
```

- [x] **Step 3: Commit**

```bash
git add docs/ROADMAP.md docs/DECISIONS.md
git commit -m "docs: add Phase 18 (self-evaluator) to roadmap and decisions D207-D209"
```

---

### Task 5: Verify acceptance criteria

- [x] **Step 1: Verify dev/evaluator.md exists and is not in plugin manifest**

Read `dev/evaluator.md` — confirm it exists and contains the full protocol.
Read `.claude-plugin/plugin.json` — confirm `dev/evaluator.md` is NOT listed.

- [x] **Step 2: Verify docs/reports/ directory exists**

```bash
ls docs/reports/.gitkeep
```

- [x] **Step 3: Verify all 8 evaluator references in rn-feature-dev.md**

Search for `**Evaluator**:` in `commands/rn-feature-dev.md` — expect exactly 8 matches covering Phases 1, 2, 3, 4, 5, 5.5, 6, 7.

- [x] **Step 4: Verify ROADMAP and DECISIONS updated**

Confirm Phase 18 exists in ROADMAP.md and D207-D209 exist in DECISIONS.md.

- [x] **Step 5: Final acceptance checklist**

Cross-reference against spec acceptance criteria:
1. Report format documented with valid YAML frontmatter template ✓
2. All phases have Phase Results capture instructions ✓
3. CDP tool call logging covers all phases ✓
4. Bug auto-logging rules with B-number allocation ✓
5. Deduplication with 3-criteria matching ✓
6. phases_completed uses N/8 denominator ✓
7. Phase 5.5-retry section documented ✓
8. dev/evaluator.md NOT in plugin.json ✓
