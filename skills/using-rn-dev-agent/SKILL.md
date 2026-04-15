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

The React Native development plugin for Claude Code. **51 MCP tools**, **5 agents**, **13 commands**, **6 skills**.

This skill is your front door. Before starting any RN work, use the decision tree below to route the user's intent to the right tool.

---

## Decision Tree

```
What is the user asking for?
│
├── BUILD a new feature / "add X to the app"
│   └─► /rn-dev-agent:rn-feature-dev <description>
│       (8-phase pipeline — see rn-feature-development skill)
│
├── TEST an existing feature
│   └─► /rn-dev-agent:test-feature <description>
│       (Launches rn-tester agent + rn-testing skill)
│
├── BUILD + TEST (app not yet installed)
│   └─► /rn-dev-agent:build-and-test <description>
│       (Builds app via Expo/EAS, installs, starts Metro, then tests)
│
├── Something is BROKEN on the current screen
│   └─► /rn-dev-agent:debug-screen
│       (Launches rn-debugger agent — gathers parallel evidence, applies fix)
│
├── Plugin tools not working / environment broken
│   └─► /rn-dev-agent:setup
│       (9-point environment check with auto-retry + manual fallback)
│
├── Need PROOF for a PR
│   └─► /rn-dev-agent:proof-capture <feature-slug>
│       (Video + screenshots + generated PR body)
│
├── Understand an existing feature (read, don't write)
│   └─► Launch rn-code-explorer agent
│       (Maps screens, state, navigation, testIDs, patterns)
│
├── Design architecture before implementing
│   └─► Launch rn-code-architect agent
│       (Opus-powered blueprint with testID placement + proof flow)
│
├── Review code before merging
│   └─► Launch rn-code-reviewer agent
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
| `rn-debugging` | Reference + process | Diagnosing crashes, errors, blank screens |
| `rn-device-control` | Reference | Simulator / emulator commands, screenshots |
| `rn-best-practices` | Reference | 46 RN rules for architecture + review |

---

## Agent Map

| Agent | Model | Purpose | Launch via |
|-------|-------|---------|-----------|
| `rn-tester` | sonnet | Verify feature works live on device | `/test-feature` or explicit launch |
| `rn-debugger` | opus | Diagnose broken screen, apply fix | `/debug-screen` or explicit launch |
| `rn-code-explorer` | sonnet | Map feature implementation across layers | Explicit launch |
| `rn-code-architect` | opus | Design blueprint with proof flow | Explicit launch, usually from `/rn-feature-dev` Phase 4 |
| `rn-code-reviewer` | sonnet | Review for bugs + RN convention violations | Explicit launch, usually from `/rn-feature-dev` Phase 6 |

---

## Common Rationalizations

Agents skip this skill at the start of conversations. Don't.

| Excuse | Reality |
|--------|---------|
| "The user asked a specific question — I'll answer directly without routing" | You lose the workflow gates. `/rn-feature-dev` wouldn't skip Phase 5.5; neither should an ad-hoc answer. |
| "I know what `cdp_store_state` does — skip reading rn-debugging" | Skills are not API docs. They contain the process knowledge (when to combine tools, when to fallback). You need that context. |
| "The user said 'fix the bug' — I'll just edit the file directly" | Route to `/rn-dev-agent:debug-screen` OR launch `rn-debugger` agent. The agent enforces reproduce → diagnose → fix → verify. |
| "This is a trivial change — I'll skip Phase 5.5 verification" | Trivial changes are where verification gates matter most. They're the ones you tell yourself don't need testing. They do. |

---

## Red Flags — Stop and Reconsider

If you notice yourself doing any of these at the start of an RN task, stop:

- About to edit code without first reading `cdp_error_log` or `cdp_component_tree`
- About to run `xcrun simctl` or `adb` instead of an MCP tool
- About to claim "feature works" without any `device_screenshot` or `cdp_*` output
- Skipping `/rn-dev-agent:setup` because "tools probably work"
- Starting feature development without `/rn-dev-agent:rn-feature-dev`
- Launching an agent without the matching skill loaded in context
- Answering "is this broken?" without running `cdp_status` first

---

## Failure Modes — Common Plugin Workflow Drift

Things that repeatedly go wrong, cataloged for prevention:

| Failure | Cause | Fix |
|---------|-------|-----|
| Feature ships with broken Android | Skipped `cross_platform_verify` | Always run it in Phase 5.5 unless explicitly scoped |
| "Works on my machine" bug | Claimed done without Phase 5.5 evidence | Every row in the results table must have a concrete Evidence value |
| Native crash missed entirely | Only checked `cdp_error_log`, not native logs | Use `collect_logs(sources=["js_console","native_ios"])` together |
| Wasted 10K tokens on component tree | Called `cdp_component_tree()` without filter | Always filter by testID or component name |
| Tests silently broken after refactor | No Maestro flow exists | `/rn-dev-agent:proof-capture` generates one; use it |
| CDP session lost mid-task | Another debugger (DevTools, Flipper) connected | Close all other debuggers before starting |

---

## Verification — Session Ready When

Before starting any real work, confirm:

- [ ] `cdp_status` returns `ok:true` with `cdp.connected: true`
- [ ] The user's intent has been routed to a specific command OR agent (not freestyled)
- [ ] The matching skill is loaded for the work type (testing, debugging, feature-dev)
- [ ] If feature-dev: user's feature description is concrete enough for Phase 1

If any of these fail, address them before proceeding.
