# Self-Evaluator Design Spec

**Date:** 2026-03-12
**Status:** Approved

## Problem

The `rn-feature-dev` command orchestrates a multi-phase feature development workflow with 11 CDP tools, agent launches, and live verification. When things fail or behave unexpectedly, the only record is the conversation transcript — which is ephemeral, unstructured, and not reviewable across runs. There is no systematic way to track tool reliability, identify recurring issues, or measure pipeline health over time.

## Solution

A development-time evaluation protocol that runs inline during `rn-feature-dev`, captures structured data about every tool call, agent launch, phase transition, and recovery action, then produces a report and auto-logs high-confidence bugs.

## Constraints

- **Not shipped to users** — lives in `dev/`, not registered in `.claude-plugin/plugin.json`
- **Inline capture** — runs during `rn-feature-dev`, not post-hoc analysis
- **Reports in `docs/reports/`** — version-controlled, human-readable
- **Reads `docs/BUGS.md`** — avoids re-logging known issues
- **Confidence-gated bug logging** — only high-confidence failures auto-append to BUGS.md

## Integration

Each phase in `commands/rn-feature-dev.md` gets a one-line evaluator reference:

```
**Evaluator**: Log [phase-specific items] per `dev/evaluator.md`.
```

Phase 1 initializes the report structure. Phase 7 finalizes and writes the file.

## Capture Protocol

### CDP Tool Call Logging — All Phases

CDP tool calls are captured in **every phase**, not just Phase 5.5. Phase 5
may call `cdp_reload`, Phase 6 re-verification reruns Phase 5.5 checks, and
recovery actions in any phase may invoke `cdp_status` or `cdp_reload`.

For each `cdp_*` tool invoked in any phase:
- **Phase** where the call occurred
- **Tool name** (e.g., `cdp_status`, `cdp_component_tree`, `cdp_interact`)
- **Parameters** (filter, path, action, etc.)
- **Result classification**: PASS, WARN (tool returned warning/degraded result), FAIL (error/timeout)
- **Notes**: error message, known bug reference (e.g., "B57"), or observation

### Per-Phase Data

| Phase | Captured Data |
|-------|---------------|
| 1 Discovery | Feature name, feature slug, timestamp, run start time |
| 2 Exploration | Agent launches (count, aspect targeted), files identified count |
| 3 Questions | Questions asked count, questions answered count |
| 4 Architecture | Agent launches, blueprint completeness (Verification Parameters present?) |
| 5 Implementation | Files created/modified count, reload type (fast refresh vs full), CDP calls (reload result) |
| 5.5 Verification | All CDP tool calls (all 11 tools), recovery actions, fix-and-retry loops (count + per-loop detail: error trigger, fix applied, outcome) |
| 5.5-retry | If Phase 6 triggers re-verification, captured as a separate "5.5-retry" section with its own CDP tool table |
| 6 Review | Agent launches, findings count by severity, fixes applied count, whether re-verification was triggered |
| 7 Summary | Total duration, report file path, bugs logged |

### Agent Launch Logging

For each agent dispatched (explorer, architect, reviewer):
- **Agent type** (e.g., `rn-code-explorer`)
- **Aspect targeted** (e.g., "navigation and store architecture")
- **Useful**: yes if it returned 3+ actionable files OR 1+ findings with confidence >= 80; no otherwise

### Recovery Action Logging

For each recovery action during any phase:
- **Action** (e.g., `cdp_reload(full=true)`, `reconnect`, `reinjectHelpers`)
- **Trigger** (what caused it — RedBox, disconnect, missing helpers)
- **Result** (success/failure, time to recover)

## Report Format

### File Naming

Written to `docs/reports/YYYY-MM-DD-<feature-slug>.md`.

Feature slug rules:
- Derived from the feature name established in Phase 1
- Lowercase, hyphens for spaces, no special characters
- Max 40 characters, truncate at word boundary
- Examples: "Add notification badge" → `notification-badge`, "Shopping cart with offline sync" → `shopping-cart-offline-sync`
- If a report with the same slug exists for the same date, append `-2`, `-3`, etc.

### Frontmatter (machine-readable summary)

```yaml
---
date: YYYY-MM-DD
feature: <feature-slug>
phases_completed: <N>/8
cdp_tools:
  called: <int>
  passed: <int>
  warned: <int>
  failed: <int>
agents:
  launched: <int>
  useful: <int>
recovery_actions: <int>
fix_retry_loops: <int>
bugs_found:
  auto_logged: <int>
  report_only: <int>
---
```

Note: 8 phases total (1, 2, 3, 4, 5, 5.5, 6, 7). A re-verification triggered
by Phase 6 does not count as a separate phase — it's part of Phase 6.

### Body Sections

The body sections are **aggregated views** of the per-phase capture data:

1. **Summary** — one-paragraph overview of the run
2. **Phase Results** — subsection per phase with its captured data (see per-phase table above)
3. **CDP Tool Results** — aggregated table of ALL `cdp_*` calls across all phases, with columns: Phase, Tool, Params, Result, Notes
4. **Recovery Actions** — table with action, trigger, result (from any phase)
5. **Agent Launches** — table with agent type, aspect, useful (yes/no)
6. **New Issues Found** — split into:
   - **Auto-logged to BUGS.md** — high-confidence issues with assigned B-number
   - **Report-only** — observations needing manual review

### Example Report

```markdown
---
date: 2026-03-12
feature: notification-badge
phases_completed: 8/8
cdp_tools:
  called: 14
  passed: 13
  warned: 1
  failed: 0
agents:
  launched: 5
  useful: 5
recovery_actions: 1
fix_retry_loops: 1
bugs_found:
  auto_logged: 1
  report_only: 2
---

# Evaluation Report: notification-badge

## Summary
Implemented notification badge and detail view using rn-feature-dev.
All phases completed. 14 CDP tool calls, 1 warning (cdp_dev_settings
dismissRedBox in Expo Go — known B57). One fix-retry loop in Phase 5.5
for a missing import. One new bug auto-logged (B58).

## Phase Results

### Phase 1: Discovery (14:32)
- Feature: "Add notification badge and detail view"
- Slug: notification-badge

### Phase 2: Exploration (14:33 – 14:35)
- Agents launched: 3 (navigation/store, patterns, testIDs)
- Files identified: 12
- All agents useful: yes

### Phase 5: Implementation (14:42 – 14:55)
- Files created: 1 (NotificationDetailScreen.tsx)
- Files modified: 4
- Reload: full (new navigation route)
- cdp_reload result: PASS

### Phase 5.5: Verification (14:55 – 15:02)
- Fix-retry loops: 1
  - Loop 1: Missing import `selectUnreadCount` → added import → PASS on retry

### Phase 5.5-retry (triggered by Phase 6)
- Re-verification after review fix: PASS (all 7 checks green)

## CDP Tool Results

| Phase | Tool | Params | Result | Notes |
|-------|------|--------|--------|-------|
| 5 | cdp_reload | full=true | PASS | reconnected in 2.8s |
| 5.5 | cdp_status | — | PASS | |
| 5.5 | cdp_navigation_state | — | PASS | NotificationsMain |
| 5.5 | cdp_component_tree | filter=notif-screen | PASS | found, 3 children |
| 5.5 | cdp_interact | testID=notif-item-0, action=press | PASS | navigated to detail |
| 5.5 | cdp_store_state | path=notifications | PASS | 3 items, unreadCount=2 |
| 5.5 | cdp_console_log | — | PASS | 5 entries |
| 5.5 | cdp_network_log | — | PASS | POST /api/notifications/read |
| 5.5 | cdp_error_log | — | PASS | 0 new errors |
| 5.5 | cdp_evaluate | dispatch markRead | PASS | |
| 5.5 | cdp_dev_settings | action=dismissRedBox | WARN | B57: not available in Expo Go |
| 5.5 | cdp_reload | full=true | PASS | |
| 5.5-retry | cdp_status | — | PASS | |
| 5.5-retry | cdp_component_tree | filter=notif-screen | PASS | |

## Recovery Actions

| Phase | Action | Trigger | Result |
|-------|--------|---------|--------|
| 5.5 | cdp_reload(full=true) | Missing import caused RedBox | Success, 3.1s |

## Agent Launches

| Phase | Agent | Aspect | Useful |
|-------|-------|--------|--------|
| 2 | rn-code-explorer | navigation and routes | yes |
| 2 | rn-code-explorer | store and data flow | yes |
| 2 | rn-code-explorer | patterns and conventions | yes |
| 4 | rn-code-architect | feature blueprint | yes |
| 6 | rn-code-reviewer | correctness + conventions | yes |

## New Issues Found

### Auto-logged to BUGS.md
- **B58**: cdp_interact handler throw on network timeout returns warnResult
  but UI state is inconsistent (MEDIUM)

### Report-only
- Phase 2 explorer returned 12 files but only 8 were relevant to the feature
- cdp_dev_settings dismissRedBox continues to fail in Expo Go (known B57)
```

## Bug Auto-Logging Rules

### Auto-append to `docs/BUGS.md` (high confidence)

These are appended automatically matching the existing format (severity, description, context):

- CDP tool returns an error/failure result (not a known bug)
- Tool timeout (exceeds 5s CDP timeout)
- Crash or RedBox during verification that wasn't present before
- Recovery action failed (reconnect failed, helpers couldn't re-inject)

**B-number allocation**: scan all `### B<N>:` headers in BUGS.md, find the
highest number, add 1. Do not reuse gaps in numbering.

**Deduplication**: before creating a new bug, check if the failure matches an
existing BUGS.md entry by comparing:
1. **Tool name** — same `cdp_*` tool
2. **Error pattern** — error message contains the same key phrase (e.g., "not available", "timeout", "undefined")
3. **Context** — same platform/environment (e.g., "Expo Go", "Bridgeless mode")

If all 3 match an existing bug, reference it in the report (e.g., "Known: B57")
instead of creating a new entry. If only 1-2 match, create a new bug with a
note referencing the similar existing one.

Examples:
- `cdp_dev_settings dismissRedBox` fails in Expo Go → matches B57 (tool + error + context) → **reference, don't duplicate**
- `cdp_dev_settings togglePerfMonitor` fails in Expo Go → matches B57 on tool + context but different action → **new bug, reference B57**
- `cdp_component_tree` times out → no existing timeout bug for this tool → **new bug**

### Report-only (manual review needed)

- Tool returns warn result (degraded but functional)
- Agent returned fewer results than expected
- Phase took unusually long (no hard threshold — just noted)
- Unexpected but non-breaking behavior

## Acceptance Criteria

1. A test run of `rn-feature-dev` produces a report file in `docs/reports/` with valid YAML frontmatter
2. All phases that executed have corresponding entries in the "Phase Results" section
3. Every `cdp_*` tool call in the run (across all phases) appears in the "CDP Tool Results" table
4. Auto-logged bugs appear in both the report AND `docs/BUGS.md` with the correct next B-number
5. Known bugs are referenced by B-number, not duplicated
6. The `phases_completed` frontmatter field uses N/8 denominator
7. If Phase 6 triggers re-verification, a "Phase 5.5-retry" section exists in the report
8. The `dev/evaluator.md` file is NOT referenced in `.claude-plugin/plugin.json`

## File Changes

| File | Action | Purpose |
|------|--------|---------|
| `dev/evaluator.md` | CREATE | The evaluation protocol — translates this spec's Capture Protocol and Report Format into agent-executable instructions |
| `docs/reports/.gitkeep` | CREATE | Ensure reports directory exists in version control |
| `commands/rn-feature-dev.md` | MODIFY | Add one-line evaluator reference to each phase |

## What This Does NOT Do

- No token usage tracking (too complex, low value)
- No automatic Linear task creation (keep it simple — human promotes bugs)
- No cross-run trend analysis (future iteration — compare frontmatter across reports)
- No modification to the plugin manifest or any shipped code
- No changes to CDP bridge, agents, or skills
