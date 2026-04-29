---
marp: true
theme: default
paginate: true
size: 16:9
title: rn-dev-agent — Closing the gap between Claude and your React Native app
description: A Claude Code plugin for React Native development powered by Chrome DevTools Protocol
header: 'rn-dev-agent'
footer: 'github.com/Lykhoyda/rn-dev-agent'
style: |
  section { font-family: -apple-system, BlinkMacSystemFont, sans-serif; font-size: 26px; }
  section h1 { font-size: 44px; }
  section h2 { font-size: 36px; color: #2563eb; }
  section h3 { font-size: 28px; }
  table { font-size: 22px; }
  code { background: #f1f5f9; padding: 2px 6px; border-radius: 4px; }
  pre { background: #0f172a; color: #e2e8f0; font-size: 20px; }
  .col2 { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
  .bad { border-left: 4px solid #dc2626; padding-left: 16px; }
  .good { border-left: 4px solid #16a34a; padding-left: 16px; }
  .stat { font-size: 56px; color: #2563eb; font-weight: 700; }
---

<!-- _class: lead -->

# rn-dev-agent

## A Claude Code plugin for React Native

The CDP-powered loop that closes the gap between Claude and your app.

<br>

`/plugin marketplace add Lykhoyda/rn-dev-agent`

---

## The problem

Claude can **write** React Native code.
Claude can't **see** or **touch** the running app.

So devs become the eyes and hands:

- Take screenshot → paste → "what do you see?"
- Copy console output → paste → "is this normal?"
- Run the user flow yourself → report back → "still broken"
- Tell Claude what testIDs exist; trust it remembered them next turn

> **The agent is half-deaf and half-blind.** Every loop costs you minutes.

---

## What if Claude could just… look?

<div class="col2">
<div class="bad">

**Today (without plugin)**

You: *"Open the app on the simulator and check if the cart badge updates."*

Claude: *"I can't open the simulator — can you run this curl command and paste the output? Or take a screenshot?"*

</div>
<div class="good">

**With rn-dev-agent**

Claude calls `device_screenshot`, `device_press(ref="@e8")`, `cdp_store_state(path="cart.items")`.

Inspects the React fiber, reads the Redux slice, asserts the network mutation fired — all in one turn.

</div>
</div>

---

## How it works — three layers, one agent

<div class="col2">
<div>

**1. CDP introspection** (37 tools)
Hermes speaks Chrome DevTools Protocol. We open a WebSocket through Metro and read:
- React fiber tree
- Redux / Zustand / Jotai / React Query state
- Console, network, errors, exceptions
- Navigation graph + routes

</div>
<div>

**2. Device control** (14 tools)
Native gestures via XCTest (iOS) and UIAutomator2 (Android):
- snapshot, screenshot, press, fill, swipe, scroll
- permissions, deep links, system dialogs

**3. E2E persistence** (13 tools)
Maestro flows + `maestro-runner` (Go, 3× faster than JVM Maestro). Every verified flow becomes a YAML the team can replay in CI.

</div>
</div>

**67 MCP tools total.** All exposed to Claude through the Model Context Protocol.

---

## Use case 1 — "What's on screen?"

<div class="col2">
<div class="bad">

**Without plugin**

```bash
$ xcrun simctl io booted screenshot /tmp/x.png
# paste image, describe to Claude
# Claude guesses testIDs, often wrong
```

3–5 min, manual paste loop, no element handles.

</div>
<div class="good">

**With plugin**

```js
device_snapshot()
// returns:
// e1: Application "rn-dev-agent-test"
// e7: NavigationBar "Tasks"
// e148: Button "fab-create-task"
// …all rects + identifiers + a11y labels
```

**5–200ms.** Returns @ref handles you can immediately tap or fill.

</div>
</div>

---

## Use case 2 — "Why is the state wrong?"

<div class="col2">
<div class="bad">

**Without plugin**

```js
// scatter console.log everywhere
// reload, reproduce, scroll Metro
// paste 200 lines into Claude
console.log('cart', store.getState().cart)
```

Claude reads logs, guesses what mutated. Slow loop, no live read.

</div>
<div class="good">

**With plugin**

```js
cdp_store_state(path: "cart.items")
// → [{ id: "1", qty: 3, … }, …]

cdp_dispatch(action: { type: "cart/clear" }, readBack: "cart")
// dispatches AND reads back in one call
```

Direct `.getState()` over CDP. **Auto-detects Redux**, registers Zustand stores, queries React Query cache.

</div>
</div>

---

## Use case 3 — "Test this feature"

<div class="col2">
<div class="bad">

**Without plugin**

You drive the simulator yourself. Claude waits.

You: *"OK I tapped the FAB, the wizard opened, I filled the title…"*

Claude: *"Did the network request fire?"*

You: *"…let me check Charles…"*

</div>
<div class="good">

**With plugin**

```
device_find("fab-create-task", action: "click")
device_fill(ref: "e29", text: "Buy milk")
device_press(ref: "e60")  // Next
device_find("wizard-priority-high", action: "click")
device_press(ref: "wizard-create-btn")
cdp_network_log(filter: "/tasks")
cdp_store_state(path: "tasks.items[0]")
```

Claude drives the app. You read the diff.

</div>
</div>

---

## Use case 4 — "Did the flow actually work?"

The plugin enforces **mutation-as-proof**:

```
cdp_network_log(filter: "/api/tasks")
// → POST /api/tasks 201 {id: "5", title: "Buy milk", …}
```

A test "passes" only if the **network log shows the mutation a real user would have triggered.**

> Forcing state via `cdp_dispatch` is treated as a *shortcut* and flagged in the verification report — not as proof.

This single rule kills an entire class of false-pass test results that plague AI-driven QA.

---

## Use case 5 — "Persist what you just verified"

<div class="col2">
<div class="bad">

**Without plugin**

You verified the flow once. Tomorrow's refactor breaks it silently. Nobody re-runs the steps.

Knowledge dies in the chat log.

</div>
<div class="good">

**With plugin**

`maestro_generate` writes the verified flow to `<test-app>/.maestro/flows/wizard-create-task.yaml` — parameterised, replayable, committed to git. Carries an **M7 metadata header** (`id`, `intent`, `tags`, `mutates`, `status`) so future sessions can find and replay it safely.

```bash
maestro-runner test \
  -e TITLE="Buy milk" -e PRIORITY=high \
  flows/wizard-create-task.yaml
# 16/16 commands, 19s, status=passed
```

CI runs this on every PR. Claude reuses it next session via `/run-action`.

</div>
</div>

---

## Use case 6 — "The screen is broken"

<div class="col2">
<div>

**Diagnosis tools, in parallel:**

```
collect_logs()
// → JS console + iOS log + Android logcat
//   merged + timestamped

cdp_error_log()
// → buffered JS exceptions

cdp_native_errors()
// → native crash dumps when JS is silent

cdp_exception_breakpoint(timed: 5s)
// → catch the next exception thrown
```

</div>
<div>

`/rn-dev-agent:debug-screen` runs all of these in parallel, plus checks RedBox state, paused-debugger detection, helpers freshness.

The agent gathers evidence from **every layer** before guessing — instead of guessing, asking, guessing.

</div>
</div>

---

## Discovery off camera. Replay on camera.

The dev video used to show 5 minutes of LLM fumbling:

> *"Let me check `cdp_component_tree`… wait, the FAB testID is different on this screen… let me try again…"*

The plugin's Phase 8 forbids that. **Recording captures a known-good replay, never the search for it.**

1. Rehearse the flow once with `device_*` / `cdp_*` — no video
2. Persist as Maestro YAML with M7 metadata (`id`, `intent`, `tags`, `mutates`, `status`)
3. Smoke-test via `maestro-runner` — must replay clean (max 3 retry budget)
4. **Now** start recording
5. Replay via `maestro-runner` — deterministic, hesitation-free, native speed

Result: 23s of feature, not 5min of fumbling. The PR reviewer sees the work, not the workings.

---

## Reusable actions, cross-session

Once a flow is persisted with metadata, the next session doesn't rediscover — it **replays**.

```
/rn-dev-agent:list-learned-actions
# A. Memories (feedback heuristics)
# B. Reusable Maestro flows (id, intent, tags, mutates, status)
# C. UI skeletons (semantic testID maps)
# D. Plugin commands available

/rn-dev-agent:run-action wizard-create-task \
  -e TITLE="Buy milk" -e PRIORITY=high
# Pre-flight: mutates=true → confirm safe
# Pre-flight: appId match ✓ — TITLE, PRIORITY supplied ✓
# Replay: 4.2s
```

Tomorrow's bug report becomes a 4-second replay instead of a 7-minute walk.

---

## The real number — from a session today

Test the task-creation wizard end-to-end on a live simulator:

<div class="col2">
<div class="bad">

**Manual `device_*` walk**

<span class="stat">~7 min</span>

11 tool calls, fought keyboard occlusion, mis-resolved coordinates, dual-target Hermes confusion, three retries.

</div>
<div class="good">

**`maestro-runner` replay of existing flow**

<span class="stat">23 s</span>

6 commands, parameterised, deterministic. Same coverage. Re-runnable in CI.

</div>
</div>

The plugin's value isn't just the tools — it's **forcing the artifact-first rule** so attempt N doesn't get worse than attempt N-1.

---

## Workflow, not just tools

The plugin ships as a workflow stack:

| Command | What it does |
|---|---|
| `/rn-dev-agent:setup` | Inject CLAUDE.md tool-routing rules + nav-ref + Zustand exposure |
| `/rn-dev-agent:rn-feature-dev` | 8-phase pipeline: explore → design → implement → verify → review → proof |
| `/rn-dev-agent:test-feature` | Artifact-first: scan existing flows → replay → only fall back to manual |
| `/rn-dev-agent:debug-screen` | Parallel evidence gather → root cause → fix → verify recovery |
| `/rn-dev-agent:list-learned-actions` | Inventory of memories + flows + skeletons available in this project |
| `/rn-dev-agent:run-action <id>` | Replay a persisted Maestro flow with safety pre-flights (mutates flag, appId match, parameter coverage) |
| `/rn-dev-agent:proof-capture` | Video + screenshots + PR body — rehearsal-gated so the recording shows replay, not discovery |

Each command is a **forcing function** for discipline AI agents otherwise skip.

---

## What devs see day-to-day

- **Cold start a feature**: `/rn-dev-agent:rn-feature-dev "shopping cart"` — Claude explores the codebase, designs the slice, implements components, runs the wizard live on the simulator, captures proof video.
- **Bug report comes in**: `/rn-dev-agent:debug-screen` — Claude reproduces, gathers parallel evidence (CDP + native logs + component tree), proposes root cause, applies fix, re-verifies.
- **Pre-PR**: `/rn-dev-agent:proof-capture` — recorded MP4 + cropped screenshots + drafted PR body, all from one command.

You stay in the IDE. The simulator and Claude talk to each other.

---

## Numbers

<div class="col2">
<div>

<span class="stat">67</span> MCP tools
<span class="stat">994</span> unit tests in cdp-bridge
<span class="stat">216 ms</span> tap latency (iOS, fast-runner)
<span class="stat">5 ms</span> snapshot latency

</div>
<div>

<span class="stat">23 s</span> end-to-end Maestro replay
<span class="stat">3×</span> faster than JVM Maestro
<span class="stat">v0.44.5</span> current plugin
<span class="stat">v0.38.5</span> current MCP server

</div>
</div>

Free, MIT-licensed, runs entirely on your machine — no cloud, no telemetry.

---

## What's next

- **M7 wiring through MCP**: the metadata fields (`id`, `intent`, `tags`, `mutates`, `status`) are plumbed through the YAML generator but the MCP tool schema doesn't yet forward them — agents currently prepend the header by hand. Wiring it through drops one manual step from the rehearsal pass.
- **`maestro_run` env-var pass-through**: today the MCP tool replays env-free flows; `${VAR}` substitution requires the `maestro-runner` Bash CLI. Closing this gap removes the dual-path documentation.
- **Phase 90 — metro-mcp adoption**: switch from polling to Metro's WebSocket event stream (sub-100ms reactivity to bundle / build / log events).
- **Cross-platform parity**: every test gates on `cross_platform_verify`. iOS-only tests are explicitly flagged.
- **Experience Engine**: the plugin learns heuristics from your sessions (recovery patterns, common testID conventions, your team's flow naming) and shares them across projects.
- **Open backlog** at github.com/Lykhoyda/rn-dev-agent/issues — 35 stories shipped via Ralph Loop, 3 stability sprints, M6 + M7 reusable-actions epic complete.

---

<!-- _class: lead -->

## Get started

```
/plugin marketplace add Lykhoyda/rn-dev-agent
cd your-rn-app
/rn-dev-agent:setup
```

That's it. Claude can now drive your app.

<br>

**github.com/Lykhoyda/rn-dev-agent**
**Issues / feedback: `/rn-dev-agent:send-feedback`**

---

<!-- _class: lead -->

# Demo

Live: task-creation wizard, end-to-end.
3 steps, 4 fields, 1 mutation, 1 persisted Maestro flow.

> Run it yourself after the talk:
> `/rn-dev-agent:test-feature task creation`
