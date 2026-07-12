---
name: using-rn-dev-agent
description: >
  Entry point for the rn-dev-agent plugin. Maps user intent to the right
  command, agent, or skill. Use at the START of any React Native
  development conversation. Triggers on "I want to build", "build a feature",
  "add a feature to the app", "test this", "something is broken", "fix the
  crash", "help with my React Native app", "how do I use rn-dev-agent".
---

# Using rn-dev-agent

The React Native development plugin for Claude Code and Codex. **79 MCP tools**, **5 agents**, **15 commands**, **9 skills**.

This skill is your front door. Before starting any RN work, use the decision tree below to route the user's intent to the right tool.

---

## Host Surface Map

- **Claude Code** local development points at the repository root with
  `claude --plugin-dir /path/to/rn-dev-agent`; the root
  `.claude-plugin/marketplace.json` resolves the package at
  `packages/claude-plugin/`. The Claude package owns slash commands in
  `commands/`, Claude subagents in `agents/`, hooks in `hooks/`, skills in
  `skills/`, and the `cdp` MCP server.
- **Codex** local development points at
  `/path/to/rn-dev-agent/packages/codex-plugin`. Codex loads
  `.codex-plugin/plugin.json`, package-local shared skills in `skills/`, and the
  same `cdp` MCP server from `.mcp.json`. Claude slash commands, subagents, and
  hooks are not native Codex surfaces; treat `commands/*.md` and `agents/*.md`
  as playbooks to execute inline. `No plugin hooks` in Codex is expected.
- Keep the MCP server key named `cdp` in both manifests. Older sessions and
  docs assume this stable key.

Codex translation rule: when this skill routes to `/rn-dev-agent:<command>`,
load the matching skill or command Markdown and run the underlying steps
directly. For action inventory, the slash command wraps:

```bash
node <plugin-root>/rn-dev-agent-core/dist/learned-actions.js --json --filter "<keyword>"
```

(`<plugin-root>` = `${CLAUDE_PLUGIN_ROOT}` on Claude, the Codex package root on
Codex — the bundled runtime lives INSIDE the installed package.)

For action replay, prefer the MCP tool `cdp_run_action` after the same
pre-flight checks documented in `commands/run-action.md`.

---

## Decision Tree

```
What is the user asking for?
│
├── INVENTORY of reusable actions ("what's already automated for this?")
│   └─► /rn-dev-agent:list-learned-actions [keyword]
│       (Scans feedback memories + .rn-agent/actions/ + .rn-agent/skeleton.yaml.
│        ALWAYS run this BEFORE any device_* sequence — replay an
│        existing flow instead of recomposing primitives manually.
│        See feedback_execute_artifacts_before_manual.md.)
│
├── REPLAY a learned action (Maestro flow)
│   └─► /rn-dev-agent:run-action <name> [-e KEY=VALUE …] [--platform ios|android]
│       (Counterpart to list-learned-actions: list discovers, run executes.
│        Pre-flights mutates flag, appId match, parameter coverage. Use to
│        skip a 7-min manual walk when a 23-sec flow already exists.)
│
├── CREATE a new reusable action ("save this flow", "make this replayable")
│   └─► Load the creating-actions skill
│       (Inventory-dedup first, ground selectors in evidence, ASCII flow
│        diagram, M7 header, validate, then replay to promote. Covers both
│        the recorder path and direct YAML authoring.)
│
├── BUILD a new feature / "add X to the app"
│   └─► /rn-dev-agent:rn-feature-dev <description>
│       (8-phase pipeline — see rn-feature-development skill)
│
├── TEST an existing feature
│   └─► /rn-dev-agent:test-feature <description>
│       (Runs rn-tester protocol INLINE in parent session — MCP tools required.
│        Step 0 is automatic artifact-first scan via list-learned-actions.)
│
├── BUILD + TEST (app not yet installed)
│   └─► /rn-dev-agent:build-and-test <description>
│       (Builds app via Expo/EAS, installs, starts Metro, then runs tester protocol inline)
│
├── Something is BROKEN on the current screen
│   └─► /rn-dev-agent:debug-screen
│       (Runs rn-debugger protocol INLINE in parent session — MCP tools required)
│
├── Plugin tools not working / environment broken
│   └─► /rn-dev-agent:setup
│       (13-check environment diagnostic with auto-retry + manual fallback,
│        then CLAUDE.md/nav-ref/store-exposure injection)
│
├── DIAGNOSE the environment (read-only, no changes)
│   └─► /rn-dev-agent:doctor
│       (Same 13-check diagnostic as setup Phase 1 — reports, never modifies)
│
├── Need PROOF for a PR ("record a demo", "capture proof", "PR video")
│   └─► Load the capturing-proof skill (or run /rn-dev-agent:proof-capture <feature-slug>)
│       (Rehearsal-gated video + screenshots + generated PR body)
│
├── FREEZE a verified action into a locked regression test
│   └─► /rn-dev-agent:lock-e2e <action-name>
│       (Strict no-repair run via cdp_lock_e2e_test, freezes to .rn-agent/e2e/;
│        the frozen suite runs via cdp_run_e2e_suite)
│
├── Watch tool activity live in a browser ("observability UI")
│   └─► /rn-dev-agent:observe
│       (Shows the observe web UI URL; stop/restart the server)
│
├── Audit project rules sync (Vercel rules)
│   └─► /rn-dev-agent:check-vercel-rules
│
├── REPORT a plugin bug / send feedback
│   └─► /rn-dev-agent:send-feedback
│       (Sanitized environment context → GitHub issue, user-confirmed)
│
├── Understand an existing feature (read, don't write)
│   └─► Spawn rn-code-explorer via Task tool (read-only, safe to spawn)
│       (Maps screens, state, navigation, testIDs, patterns)
│
├── Design architecture before implementing
│   └─► Spawn rn-code-architect via Task tool (read-only, safe to spawn)
│       (Fable-powered blueprint with testID placement + proof flow)
│
├── Review code before merging
│   └─► Spawn rn-code-reviewer via Task tool (read-only, safe to spawn)
│       (Confidence-filtered review, RN conventions + best practices)
│
├── Just check if environment is ready
│   └─► /rn-dev-agent:check-env
│       (Quick cdp_status check, no setup attempt)
│
└── Extract the navigation graph
    └─► /rn-dev-agent:nav-graph
        (Maps all screens and navigators)
```

---

## Core Operating Behaviors

These apply to every RN task:

### Always
1. **Start with `cdp_status`** before any app interaction or feature verification
2. **Use MCP tools** (`cdp_*`, `device_*`) for app state reads — never raw bash
3. **Verify with evidence**, not intuition — CDP output, screenshot, store state
4. **Do cross-platform checks** unless the user explicitly scoped to one platform
5. **Filter `cdp_component_tree` queries** — never dump the full tree (10K+ tokens wasted)
6. **Stop at the first red flag** from the agent's red flags list
7. **Run `/rn-dev-agent:list-learned-actions` BEFORE composing any `device_*` sequence.** If a saved action already covers the request, replay it via `cdp_run_action` (or `/rn-dev-agent:run-action`) first — that path runs the mutates/appId/param pre-flights and auto-repair; reserve raw `maestro_run` for non-action YAML flows. Manual primitives are a fallback, not a default. (Codified in `feedback_execute_artifacts_before_manual.md`. The original failure case: a 7-minute / 11-tool-call manual walk that an existing 23-second Maestro flow would have covered.)

### Ask First
- Adding new dependencies to the user's project
- Changing navigation structure (route names, param types)
- Modifying existing store shape (breaks existing consumers)
- Creating more than 5 files for a single feature
- Disabling existing tests

### Never
- Use `xcrun simctl` or `adb` for app interaction (use MCP tools)
- Bypass `cdp_status` with direct WebSocket calls
- Claim a feature works without Phase 5.5 evidence
- Refactor code adjacent to your change ("while I'm here")
- Add features not in the feature description
- Rename MCP server keys in minor/patch versions (D605)

---

## Skill Map

| Skill | Type | When loaded |
|-------|------|-------------|
| `using-rn-dev-agent` (this) | Meta / entry point | Start of any RN conversation |
| `rn-setup` | Process | User runs `/rn-dev-agent:setup` or tools fail |
| `rn-feature-development` | Process | Inside `/rn-dev-agent:rn-feature-dev` — 8-phase pipeline |
| `rn-testing` | Reference + process | Test writing, Maestro flows, E2E verification |
| `creating-actions` | Process + reference | Authoring a new reusable action (save / replay a flow) |
| `rn-debugging` | Reference + process | Diagnosing crashes, errors, blank screens |
| `rn-device-control` | Reference | Simulator / emulator commands, screenshots |
| `capturing-proof` | Process | Recording proof artifacts (video + screenshots + PR body) for a verified feature |
| `rn-best-practices` | Reference | 118 review rules (48 RN-applicable) for architecture + review |

---

## Agent Map

Two categories — invocation pattern matters:

### Parent-session-only agents (MCP-bound — NEVER spawn via Task tool)

These agents' protocols require `cdp_*` / `device_*` MCP tools, which don't
propagate to spawned subagents (GH #31). They are **protocol playbooks** —
read them as reference, execute the steps INLINE in the parent session.

| Agent | Model | Purpose | How to invoke |
|-------|-------|---------|-----------|
| `rn-tester` | opus | Verify feature works live on device | Run `/test-feature` — protocol executes inline in parent session |
| `rn-debugger` | opus | Diagnose broken screen, apply fix | Run `/debug-screen` — protocol executes inline in parent session |

### Spawnable agents (read-only — safe to use via Task tool)

These use only `Glob, Grep, LS, Read` — no MCP tools. They can be spawned
in parallel via the Task tool for concurrent codebase analysis. (Task-tool
spawning is a Claude surface; on Codex, read the agent markdown and execute
the playbook inline instead — see the Host Surface Map above.)

| Agent | Model | Purpose | How to invoke |
|-------|-------|---------|-----------|
| `rn-code-explorer` | opus | Map feature implementation across layers | `Task(subagent_type='rn-dev-agent:rn-code-explorer', ...)` — typically × 2-3 in parallel during `/rn-feature-dev` Phase 2 |
| `rn-code-architect` | fable | Design blueprint with proof flow | `Task(subagent_type='rn-dev-agent:rn-code-architect', ...)` — typically × 1-2 during `/rn-feature-dev` Phase 4 |
| `rn-code-reviewer` | opus | Review for bugs + RN convention violations | `Task(subagent_type='rn-dev-agent:rn-code-reviewer', ...)` — typically × 2-3 in parallel during `/rn-feature-dev` Phase 6 |

---

## Common Rationalizations

Agents skip this skill at the start of conversations. Don't.

| Excuse | Reality |
|--------|---------|
| "The user asked a specific question — I'll answer directly without routing" | You lose the workflow gates. `/rn-feature-dev` wouldn't skip Phase 5.5; neither should an ad-hoc answer. |
| "I know what `cdp_store_state` does — skip reading rn-debugging" | Skills are not API docs. They contain the process knowledge (when to combine tools, when to fallback). You need that context. |
| "The user said 'fix the bug' — I'll just edit the file directly" | Route to `/rn-dev-agent:debug-screen` which runs the rn-debugger protocol inline in the parent session. Enforces reproduce → diagnose → fix → verify. Never spawn `rn-debugger` via Task tool — MCP tools won't work (GH #31). |
| "I'll spawn `rn-tester` via Task to verify while I work on something else" | You can't — MCP stdio doesn't propagate to Task-spawned subagents (GH #31). rn-tester and rn-debugger are parent-session-only protocol playbooks. Only `rn-code-explorer`, `rn-code-architect`, `rn-code-reviewer` are safe to spawn (they're read-only, no MCP). |
| "This is a trivial change — I'll skip Phase 5.5 verification" | Trivial changes are where verification gates matter most. They're the ones you tell yourself don't need testing. They do. |
| "I got `HELPERS_NOT_INJECTED` — let me retry `cdp_status`" | Retrying `cdp_status` does NOT re-run helper injection if the bridge thinks it's connected; it just returns status. The plugin auto-retries injection internally on every gated call (see "Recovering from HELPERS_NOT_INJECTED" in the rn-debugging skill). If the auto-retry exhausted, switch to `device_*` tools (XCTest path — no helpers required) or call `cdp_reload`. Don't spin on `cdp_status`. |

---

## Red Flags — Stop and Reconsider

If you notice yourself doing any of these at the start of an RN task, stop:

- About to edit code without first reading `cdp_error_log` or `cdp_component_tree`
- About to run `xcrun simctl` or `adb` instead of an MCP tool
- About to claim "feature works" without any `device_screenshot` or `cdp_*` output
- Skipping `/rn-dev-agent:setup` because "tools probably work"
- Starting feature development without `/rn-dev-agent:rn-feature-dev`
- Spawning `rn-tester` or `rn-debugger` via Task tool — their protocols need MCP tools that don't propagate to subagents (GH #31). Run `/test-feature` or `/debug-screen` instead; the protocol executes inline in the parent session.
- Spawning an agent without the matching skill loaded in context
- Answering "is this broken?" without running `cdp_status` first

---

## Failure Modes — Common Plugin Workflow Drift

Things that repeatedly go wrong, cataloged for prevention:

| Failure | Cause | Fix |
|---------|-------|-----|
| Manual `device_*` walk for a flow that already exists as a YAML | Skipped `/rn-dev-agent:list-learned-actions` at session start | Run it BEFORE any UI work; replay matching flows via `maestro_run` |
| Feature ships with broken Android | Skipped `cross_platform_verify` | Always run it in Phase 5.5 unless explicitly scoped |
| "Works on my machine" bug | Claimed done without Phase 5.5 evidence | Every row in the results table must have a concrete Evidence value |
| Native crash missed entirely | Only checked `cdp_error_log`, not native logs | Use `collect_logs(sources=["js_console","native_ios"])` together |
| Wasted 10K tokens on component tree | Called `cdp_component_tree()` without filter | Always filter by testID or component name |
| Tests silently broken after refactor | No Maestro flow exists | `/rn-dev-agent:proof-capture` generates one; use it |
| CDP session lost mid-task | Another debugger (DevTools, Flipper) connected | Close all other debuggers before starting |
| Stuck on `HELPERS_NOT_INJECTED` for minutes | Retrying `cdp_status` instead of letting the auto-retry surface a final answer, or instead of falling back to device tools | The error is authoritative (the bridge already auto-retried injection) — switch to `device_*` tools or call `cdp_reload`; never sit in a `cdp_status` retry loop. Full recovery protocol: rn-debugging skill § "Recovering from HELPERS_NOT_INJECTED". |

---

## Verification — Session Ready When

Before starting any real work, confirm:

- [ ] `cdp_status` returns `ok:true` with `cdp.connected: true`
- [ ] The user's intent has been routed to a specific command OR agent (not freestyled)
- [ ] The matching skill is loaded for the work type (testing, debugging, feature-dev)
- [ ] If feature-dev: user's feature description is concrete enough for Phase 1

If any of these fail, address them before proceeding.
