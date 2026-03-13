# Ralph Loop — Plugin Tool Improvement via Test App Stories

You are iteratively implementing 5 user stories for the rn-dev-agent test app.
**The features are vehicles for exercising CDP tools in different scenarios.
The real output of each story is plugin improvements, not app code.**

Each iteration, read this prompt fresh, check state, and continue where you left off.

## Workflow Per Story

For each story marked `[ ]` in `docs/RALPH-STORIES.md`:

### Step 1: Implement
1. Mark the story `[IN PROGRESS]` in `docs/RALPH-STORIES.md`
2. Run `/rn-dev-agent:rn-feature-dev` with the story requirements
3. Follow all 8 phases (Discovery → Exploration → Questions → Architecture → Implementation → Verification → Review → Summary)
4. For Phase 3 (Clarifying Questions): use your best judgment, pick the recommended option
5. For Phase 4 (Architecture): proceed with implementation
6. For Phase 6 (Review): fix all findings with confidence >= 80
7. The self-evaluator protocol in `dev/evaluator.md` runs inline — follow its instructions at each phase

### Step 2: External Review
After Phase 7 completes:
1. Ask **Gemini MCP** to review all files changed in this story — focus on correctness, RN conventions, and potential issues
2. Ask **Codex MCP** the same review question (timeout 800s)
3. Consolidate findings from both reviewers
4. Fix all HIGH and MODERATE severity issues
5. Re-verify on device after fixes (full reload + cdp_status + cdp_error_log)

### Step 3: Plugin Analysis
After external review fixes:
1. Analyze what CDP tools worked, what broke, and what was missing
2. For each issue found, determine if it's a plugin fix (do it now) or upstream (log in BUGS.md)
3. Update skills, commands, agents, or MCP server code based on findings
4. Log all plugin improvements as decisions in `docs/DECISIONS.md`
5. Update the story's **Plugin learnings** section in `docs/RALPH-STORIES.md`

### Step 4: Commit and Update
1. Commit all changes for this story with a descriptive message
2. Update `docs/DECISIONS.md` with any new architectural decisions
3. Update `docs/ROADMAP.md` with a new phase entry for this story
4. Mark the story `[DONE]` in `docs/RALPH-STORIES.md`

### Step 5: Check Completion
- If all 5 stories are `[DONE]`: output `<promise>ALL STORIES COMPLETE</promise>` and stop
- If stories remain: continue to the next `[ ]` story

## State Recovery

Each iteration, determine current state by reading:
1. `docs/RALPH-STORIES.md` — which stories are done/in-progress/pending
2. `git log --oneline -10` — recent commits show what was just completed
3. `docs/ROADMAP.md` — phase entries confirm completion

If a story is `[IN PROGRESS]` but appears incomplete (no commit, no roadmap entry),
resume from where it left off rather than starting over.

## Rules

- Always use `/rn-dev-agent:rn-feature-dev` for implementation — never implement directly
- Always ask Gemini AND Codex for review after each story
- Fix HIGH and MODERATE issues. Log LOW as report-only
- Use `docs/DECISIONS.md` for every architectural decision (continue numbering from last D-number)
- Codex MCP timeout must be 800 seconds
- Do not use co-authored-by LLM lines in commits
- Go with recommended options when asked for choices
- Take time, do things properly
- **Focus on plugin improvements** — the app features are arbitrary; what matters is what the tools learned

## Story Order

Implement in order: S1 → S2 → S3 → S4 → S5

This order is deliberate:
- S1 (Feed Search) is simplest — modifies one existing screen
- S2 (Dark Mode) builds on S1 — hook pattern reused across screens
- S3 (Profile Edit) introduces modals — new navigation pattern
- S4 (Notification Snooze) is most complex state logic
- S5 (Task Priority) builds on existing Tasks tab from previous work
