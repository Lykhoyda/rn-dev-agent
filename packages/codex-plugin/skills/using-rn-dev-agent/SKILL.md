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

The Codex rn-dev-agent surface provides an MCP tool suite, **16 explicit workflow skills**, and **11 implicit domain skills**—exactly **27 native Codex skills**. The five packaged agent files are inline playbooks, not a native Codex subagent contract.

This skill is your front door. Before starting any RN work, use the decision tree below to route the user's intent to the right tool.

---

## Codex surface map

Codex loads `.codex-plugin/plugin.json`, package-local `skills/`, and stable MCP
server key `cdp` from `.mcp.json`. `No plugin hooks` is expected. Packaged
`commands/*.md` are complete workflow playbooks reached through the sixteen
native `$rn-dev-agent:<workflow>` skills; best-effort command migration is
explicitly disabled, so `source-command-*` is not a supported vocabulary.

Workflow adapters are explicit-only. Domain skills remain implicit knowledge
owners. Resolve every playbook/helper relative to the exact selected
`SKILL.md`; never scan caches or use a launcher-only package-root variable. For
action replay, prefer structured `cdp_run_action` after the preflights in the
package-local `run-action` workflow.

---

## Decision Tree

```
What is the user asking for?
│
├── INVENTORY of reusable actions ("what's already automated for this?")
│   └─► $rn-dev-agent:list-learned-actions [keyword]
│       (Scans feedback memories + .rn-agent/actions/ + .rn-agent/skeleton.yaml.
│        ALWAYS run this BEFORE any device_* sequence — replay an
│        existing flow instead of recomposing primitives manually.
│        See feedback_execute_artifacts_before_manual.md.)
│
├── REPLAY a learned action (Maestro flow)
│   └─► $rn-dev-agent:run-action <name> [-e KEY=VALUE …] [--platform ios|android]
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
│   └─► $rn-dev-agent:rn-feature-dev <description>
│       (8-phase pipeline — see rn-feature-development skill)
│
├── TEST an existing feature
│   └─► $rn-dev-agent:test-feature <description>
│       (Runs rn-tester protocol INLINE in parent session — MCP tools required.
│        Step 0 is automatic artifact-first scan via list-learned-actions.)
│
├── BUILD + TEST (app not yet installed)
│   └─► $rn-dev-agent:build-and-test <description>
│       (Builds app via Expo/EAS, installs, starts Metro, then runs tester protocol inline)
│
├── Something is BROKEN on the current screen
│   └─► $rn-dev-agent:debug-screen
│       (Runs rn-debugger protocol INLINE in parent session — MCP tools required)
│
├── Plugin tools not working / environment broken
│   └─► $rn-dev-agent:setup
│       (passive package health first, then consented AGENTS.md/nav/store/scaffold setup)
│
├── DIAGNOSE the environment (read-only, no changes)
│   └─► $rn-dev-agent:doctor
│       (Same 13-check diagnostic as setup Phase 1 — reports, never modifies)
│
├── Need PROOF for a PR ("record a demo", "capture proof", "PR video")
│   └─► Load the capturing-proof skill (or run $rn-dev-agent:proof-capture <feature-slug>)
│       (Rehearsal-gated video + screenshots + generated PR body)
│
├── FREEZE a verified action into a locked regression test
│   └─► $rn-dev-agent:lock-e2e <action-name>
│       (Strict no-repair run via cdp_lock_e2e_test, freezes to .rn-agent/e2e/;
│        the frozen suite runs via cdp_run_e2e_suite)
│
├── Watch tool activity live in a browser ("observability UI")
│   └─► $rn-dev-agent:observe
│       (Shows the observe web UI URL; stop/restart the server)
│
├── Audit project rules sync (Vercel rules)
│   └─► $rn-dev-agent:check-vercel-rules
│
├── REPORT a plugin bug / send feedback
│   └─► $rn-dev-agent:send-feedback (routes to `sending-feedback`)
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
├── About to start a real device journey (build / test / proof, end to end)
│   └─► $rn-dev-agent:run-workflow [journey-description]
│       (Loads the rn-workflow domain skill: declared package manager + deps,
│        read-only inventory, typed session recovery, one exclusive device,
│        managed integration/Metro, only the requested proof, reverse cleanup)
│
├── Just check if environment is ready
│   └─► $rn-dev-agent:check-env
│       (Quick cdp_status check, no setup attempt)
│
└── Extract the navigation graph
    └─► $rn-dev-agent:nav-graph
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
7. **Run `$rn-dev-agent:list-learned-actions` BEFORE composing any `device_*` sequence.** If a saved action already covers the request, replay it via `cdp_run_action` (or `$rn-dev-agent:run-action`) first — that path runs the mutates/appId/param pre-flights and auto-repair; reserve raw `maestro_run` for non-action YAML flows. Manual primitives are a fallback, not a default. (Codified in `feedback_execute_artifacts_before_manual.md`. The original failure case: a 7-minute / 11-tool-call manual walk that an existing 23-second Maestro flow would have covered.)

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
| `rn-workflow` | Process | Inside `$rn-dev-agent:run-workflow` — the proven operating sequence (preflight → authority → proof → reverse cleanup) before any device journey |
| `rn-setup` | Process | User runs `$rn-dev-agent:setup` or tools fail |
| `rn-feature-development` | Process | Inside `$rn-dev-agent:rn-feature-dev` — 8-phase pipeline |
| `rn-testing` | Reference + process | Test writing, Maestro flows, E2E verification |
| `creating-actions` | Process + reference | Authoring a new reusable action (save / replay a flow) |
| `rn-debugging` | Reference + process | Diagnosing crashes, errors, blank screens |
| `rn-device-control` | Reference | Simulator / emulator commands, screenshots |
| `capturing-proof` | Process | Recording proof artifacts (video + screenshots + PR body) for a verified feature |
| `sending-feedback` | Process | Reporting plugin bugs or requests with reviewed, sanitized diagnostics |
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
| "The user said 'fix the bug' — I'll just edit the file directly" | Route to `$rn-dev-agent:debug-screen` which runs the rn-debugger protocol inline in the parent session. Enforces reproduce → diagnose → fix → verify. Never spawn `rn-debugger` via Task tool — MCP tools won't work (GH #31). |
| "I'll spawn `rn-tester` via Task to verify while I work on something else" | You can't — MCP stdio doesn't propagate to Task-spawned subagents (GH #31). rn-tester and rn-debugger are parent-session-only protocol playbooks. Only `rn-code-explorer`, `rn-code-architect`, `rn-code-reviewer` are safe to spawn (they're read-only, no MCP). |
| "This is a trivial change — I'll skip Phase 5.5 verification" | Trivial changes are where verification gates matter most. They're the ones you tell yourself don't need testing. They do. |
| "I got `HELPERS_NOT_INJECTED` — let me retry `cdp_status`" | Retrying `cdp_status` does NOT re-run helper injection if the bridge thinks it's connected; it just returns status. The plugin auto-retries injection internally on every gated call (see "Recovering from HELPERS_NOT_INJECTED" in the rn-debugging skill). If the auto-retry exhausted, switch to `device_*` tools (XCTest path — no helpers required) or call `cdp_reload`. Don't spin on `cdp_status`. |

---

## Red Flags — Stop and Reconsider

If you notice yourself doing any of these at the start of an RN task, stop:

- About to edit code without first reading `cdp_error_log` or `cdp_component_tree`
- About to run `xcrun simctl` or `adb` instead of an MCP tool
- About to claim "feature works" without any `device_screenshot` or `cdp_*` output
- Skipping `$rn-dev-agent:setup` because "tools probably work"
- Starting feature development without `$rn-dev-agent:rn-feature-dev`
- Spawning `rn-tester` or `rn-debugger` via Task tool — their protocols need MCP tools that don't propagate to subagents (GH #31). Run `/test-feature` or `/debug-screen` instead; the protocol executes inline in the parent session.
- Spawning an agent without the matching skill loaded in context
- Answering "is this broken?" without running `cdp_status` first

---

## Failure Modes — Common Plugin Workflow Drift

Things that repeatedly go wrong, cataloged for prevention:

| Failure | Cause | Fix |
|---------|-------|-----|
| Manual `device_*` walk for a flow that already exists as a YAML | Skipped `$rn-dev-agent:list-learned-actions` at session start | Run it BEFORE any UI work; replay matching flows via `cdp_run_action` (recorded, auto-repair-aware) — not raw `maestro_run` |
| Retrying a replay that keeps refusing with `SESSION_AUTHORITY_REQUIRED` | Treated an ownership refusal as UI drift | Not repairable by retry, repair, or another device — see the "Session ownership recovery" section |
| Feature ships with broken Android | Skipped `cross_platform_verify` | Always run it in Phase 5.5 unless explicitly scoped |
| "Works on my machine" bug | Claimed done without Phase 5.5 evidence | Every row in the results table must have a concrete Evidence value |
| Native crash missed entirely | Only checked `cdp_error_log`, not native logs | Use `collect_logs(sources=["js_console","native_ios"])` together |
| Wasted 10K tokens on component tree | Called `cdp_component_tree()` without filter | Always filter by testID or component name |
| Tests silently broken after refactor | No Maestro flow exists | `$rn-dev-agent:proof-capture` generates one; use it |
| CDP session lost mid-task | Another debugger (DevTools, Flipper) connected | Close all other debuggers before starting |
| Stuck on `HELPERS_NOT_INJECTED` for minutes | Retrying `cdp_status` instead of letting the auto-retry surface a final answer, or instead of falling back to device tools | The error is authoritative (the bridge already auto-retried injection) — switch to `device_*` tools or call `cdp_reload`; never sit in a `cdp_status` retry loop. Full recovery protocol: rn-debugging skill § "Recovering from HELPERS_NOT_INJECTED". |

---

## Session ownership recovery — `SESSION_AUTHORITY_REQUIRED`

**Canonical wording for ownership recovery lives here.** Other commands and
skills point at this section instead of restating it.

A session can be `blocked`: another session's claim on this worktree is still in
the registry. Discovery keeps working — listing learned actions is a read-only
filesystem scan and grants no replay authority — but every authoritative tool
(`cdp_run_action`, `maestro_run`, `device_*`, gated `cdp_*`) refuses with
`SESSION_AUTHORITY_REQUIRED` until ownership is resolved.

`rn_session({action: "status"})` is the one action every blocked session can
reach and the canonical recovery surface. Its `recoveryRequirement` owns the
remedy; gated refusals carry the same measured `nextAction`. Follow it verbatim.
Legacy sessions may expose the capability-bound adoption action named there;
grouped sessions do not.

| `recoveryRequirement.requirement` | What it means | What to do |
|---|---|---|
| `transport-restart` | the blocking claim is gone, or its owner is proven dead | run the remedy the `nextAction` names — restart the MCP transport, or run the packaged recovery command below when a restart is not available. **Unless `startupCleanupBlocked` is also present**, which means startup cleanup refused for a stated reason and another restart will not clear it. Resolve that reason first. |
| `attach` | the prior owner is live, or its identity cannot be proven | use that session, or work in a separate worktree. A live or unprovable owner is never adopted |
| `adoption` (legacy sessions only) | the prior owner is proven dead and minted an adoption handle | follow the handle named in the `nextAction` |

### Recovery without a transport restart

Resolve `<package-root>` from this skill's own `SKILL.md` path, then run the packaged
recovery from the RN app root:

```bash
node <package-root>/rn-dev-agent-core/dist/session-doctor.js report   # read-only
node <package-root>/rn-dev-agent-core/dist/session-doctor.js repair   # release + reap
```

`report` prints the authority store path, whether this source root is wedged,
`sameRootOwner` (`absent` / `live` / `stale` / `unprovable`), any retained
`startupCleanupBlocked`, and the count of abandoned blocked contenders, and exits non-zero
when it finds the root wedged. `repair` runs
exactly the startup cleanup a fresh transport runs: it releases a **proven-dead**
same-root owner and discards abandoned contender rows that never held a claim. It never
releases an owner that is live or whose identity is unprovable, and exits non-zero when it
finds one — the abandoned claim-less contender rows are still reaped. There is no
force-steal, by timeout or otherwise. The `nextAction` a refusal returns
names the Claude form of the same file; the artifact path inside the package is
identical.

A recorded pid that the OS has recycled into a process you cannot inspect counts as
**proven dead** (GH #792): the recorded owner could only ever be a process of your own
user, so a pid you cannot inspect is provably not it. An identity that is unreadable for
any other reason stays `unprovable` and keeps refusing.

Rules, no exceptions:

- **Never bind around a blocker.** Do not run setup, call `bind_device`, or pick
  another booted device to escape a `blocked` state. Those calls are refused too,
  and a claim conflict is never force-stolen.
- **Never retry the replay.** `SESSION_AUTHORITY_REQUIRED` is not UI drift; it is
  not repairable by `cdp_repair_action`, by editing the flow, or by rerunning.
- **Never treat discovery as authority.** A listed action proves the file exists,
  not that this session may replay it.
- **Re-read `rn_session({action: "status"})` after any recovery step** and require
  a non-`blocked` state before resuming work.

### Linked git worktrees — `SOURCE_ROOT_DIVERGENCE`

The session binds the source root the MCP transport was started in. When branch
work lives in a linked `git worktree` of the same repository, declare it instead
of building around the session:

- `rn_session({action: "bind_source", projectRoot: "<worktree path>"})` releases
  the session and mints its successor bound to that worktree. Same repository
  only — a foreign tree is refused with `SOURCE_ROOT_DIVERGENCE`, never attached.
- Pass `projectRoot` on `bind_device`, `preview_integration`, or
  `apply_integration` to fence them: it must be the session's exact source root.
  A different worktree — or a different app package inside the same worktree —
  refuses with `SOURCE_ROOT_DIVERGENCE` naming both paths instead of silently
  mutating the bound tree.

---

## Verification — Session Ready When

Before starting any real work, confirm:

- [ ] `rn_session({action: "status"})` does not report `state: blocked` — if it does, stop and follow the "Session ownership recovery" section
- [ ] `cdp_status` returns `ok:true` with `cdp.connected: true`
- [ ] The user's intent has been routed to a specific command OR agent (not freestyled)
- [ ] The matching skill is loaded for the work type (testing, debugging, feature-dev)
- [ ] If feature-dev: user's feature description is concrete enough for Phase 1

If any of these fail, address them before proceeding.
