# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**rn-dev-agent** — A Claude Code plugin that turns Claude into a React Native development partner. It explores the codebase, designs architecture, implements features, then verifies everything live on the simulator — reading the component tree, store state, and navigation stack through Chrome DevTools Protocol.

## Feature Development Workflow (how we work — read this first)

This is the standard process for any non-trivial feature or fix, so sessions stay consistent. **Plan first, get the plan reviewed by other models, then build — verifying the design before writing code is where the cheapest fixes live.**

1. **Plan comprehensively.** Use `superpowers:brainstorming` to turn the idea into an approved design spec, then `superpowers:writing-plans` for a comprehensive TDD plan. Both artifacts live under `docs/superpowers/{specs,plans}/YYYY-MM-DD-<topic>.md` and are committed. Large features are **decomposed into phases** — each phase gets its own spec section, plan, and PR (e.g. `#202` → Phase 1 / 1.5 / 2a / 2b…).

2. **Review the plan with other LLMs (Codex + Gemini).** Run `/brainstorm gemini,codex <plan + key files>` BEFORE writing any code. It consistently catches blockers in the *plan* (cheap to fix) that would otherwise become bugs. Apply the findings, then amend the plan commit with an "Amendments applied from the multi-LLM plan review" note.

3. **Execute the plan task-by-task** (TDD: failing test → minimal impl → pass → commit). Two options:
   - **Codex-Pair** (`/codex-pair`) — Codex reviews **every edit** as you go; **pay attention to its per-edit feedback** and address it inline.
   - **`superpowers:subagent-driven-development`** — a fresh Opus subagent per task with a spec-compliance + code-quality review between each.
   Commits are **signed**, small, and per-task; `dist/` is tracked so stage rebuilt outputs; add a changeset per change.

4. **Multi-review the finished changes.** Run `/multi-review` (Gemini + Codex code review of the diff) — and/or a final holistic review — once the increment is complete.

5. **Run + verify on real devices, then benchmark.** Test the change on the **iOS simulator AND Android emulator** (the plugin's own `device_*`/`cdp_*` tools, or a direct `dist` test against the booted device for bridge-internal logic), and benchmark where performance matters.

6. **Fix findings and re-test.** Address review + device-verification findings, then re-run the unit suite + device checks until everything is green. Then finish the branch (`superpowers:finishing-a-development-branch`) — usually a **stacked PR** on the previous phase's branch.

Logging: per the global instructions, log architectural decisions to `DECISIONS.md`, bugs to `BUGS.md`, and a dated narrative to `ROADMAP.md` in the sibling `rn-dev-agent-workspace` (the `/end-session` skill does this).

## Project Structure — sibling repos

This is the **pure plugin repo** — agents, commands, skills, hooks, MCP server (`scripts/cdp-bridge/`), marketplace manifest. It ships to users as-is, so it contains only what runs inside Claude Code.

Development scaffolding lives in the **sibling workspace repo**:
`../rn-dev-agent-workspace` (absolute on dev machine: `/Users/anton_personal/GitHub/rn-dev-agent-workspace`).

| Artifact | Location |
|---|---|
| Test app (Expo Dev Client, exercises plugin tools) | `rn-dev-agent-workspace/test-app/` |
| `ROADMAP.md`, `DECISIONS.md`, `BUGS.md` | `rn-dev-agent-workspace/docs/` |
| Proof artifacts / benchmarks / session reports | `rn-dev-agent-workspace/docs/proof/` |
| Shared packages (agent-device, maestro-runner) | `rn-dev-agent-workspace/packages/` |
| Dev-only scripts (benchmark runners, harnesses) | `rn-dev-agent-workspace/dev/` |

**Do not** recreate `test-app`, `docs`, or `packages` symlinks in this repo — they caused "two test-apps" confusion during benchmarking and were removed on 2026-04-16. Edit workspace files via their absolute/relative path directly (`../rn-dev-agent-workspace/docs/ROADMAP.md`).

**Metro must be started from the workspace**: `cd ../rn-dev-agent-workspace/test-app && npx expo start`. Otherwise the `com.rndevagent.testapp` Dev Client bundle fails to register and you get "App entry not found" on the simulator.

## Quick Start (for users)

### First-time setup
1. Install: `/plugin marketplace add Lykhoyda/rn-dev-agent`
2. Navigate to your RN project: `cd /path/to/your-rn-app`
3. Run setup check: `/rn-dev-agent:setup`
4. Fix any items marked MISSING in the output table

### Prerequisites
- **Node.js >= 22 LTS** (even-numbered release — NOT v25)
- **iOS Simulator** booted with your app OR **Android Emulator** running
- **Metro dev server** running (`npx expo start` or `npx react-native start`)
- Platform-specific device-control runtime (one of):
  - **iOS** — in-tree `rn-fast-runner` XCTest project ships with the plugin (`scripts/rn-fast-runner/`). It **self-builds on first use**: the first `device_snapshot action=open` runs `xcodebuild test` (build + test) when no prebuilt `.xctestrun` exists, then `test-without-building` thereafter — so a fresh machine works with no manual step (the first call cold-builds, which takes several minutes). To skip that one-time wait, optionally pre-build with a booted simulator: `cd ${CLAUDE_PLUGIN_ROOT}/scripts/rn-fast-runner/RnFastRunner && xcodebuild build-for-testing -project RnFastRunner.xcodeproj -scheme RnFastRunner -destination "platform=iOS Simulator,id=<UDID>" -derivedDataPath ../build/DerivedData`. iOS no longer requires `agent-device` (PR #164 / D1219).
  - **Android** — `agent-device` CLI: `npm install -g agent-device` (auto-installed by the plugin; may need manual install if the auto-install fails).
- `maestro-runner` — auto-installed to `~/.maestro-runner/`

### Essential commands

Authoring & lifecycle:
```
/rn-dev-agent:setup                    — Check & install all prerequisites; scaffolds .rn-agent/
/rn-dev-agent:doctor                   — 14-row diagnostic table for the whole environment
/rn-dev-agent:check-env                — Quick environment-readiness check
/rn-dev-agent:rn-feature-dev <desc>    — Full 8-phase feature development pipeline
/rn-dev-agent:test-feature <desc>      — Test a feature end-to-end; auto-records an action on pass
/rn-dev-agent:debug-screen             — Diagnose and fix the current screen
/rn-dev-agent:build-and-test <desc>    — Build app, then test feature
/rn-dev-agent:proof-capture <desc>     — Rehearsal-gated video + screenshots + PR body
/rn-dev-agent:nav-graph                — Extract / inspect the app navigation graph
/rn-dev-agent:send-feedback            — Report a bug with sanitised environment context
```

Actions (replayable flows — see "Actions" section below):
```
/rn-dev-agent:list-learned-actions [q] — Inventory of saved flows + feedback memories
/rn-dev-agent:run-action <name> -e K=V — Replay a saved action; auto-repair-aware
```

Repo-local troubleshooting memory (replaces the Experience Engine):
`.rn-agent/local/troubleshooting.md` — gitignored, agent-read at SessionStart, auto-updated by the Stop hook after failures (GH #200).

### How it works
1. Always start with `cdp_status` — this connects to your running app via CDP
2. Use MCP tools (not bash) for all app interaction:
   - `cdp_component_tree` — read React components by testID
   - `cdp_store_state` — read Redux/Zustand/React Query state
   - `cdp_navigate` — navigate to any screen
   - `device_screenshot` — capture screen
   - `device_find` / `device_press` — tap UI elements
3. Do NOT use `xcrun simctl` or `adb` for app interaction — use the CDP/device tools

### Troubleshooting
- **"CDP connection failed"** → Is Metro running? Is the app loaded on the simulator?
- **"agent-device not installed"** → Only required for Android. If targeting Android, run `npm install -g agent-device`. iOS uses the in-tree `rn-fast-runner` and does not need it.
- **"rn-fast-runner did not become ready" / no `.xctestrun` at the expected path** → The runner self-builds on first use (cold `xcodebuild test`), so this now usually means the cold build itself timed out or failed — not a missing prebuild. The cold-build ready timeout is 360s; a slower machine or a build error (check Xcode/simulator state) can still trip it. To take the build out of the hot path, pre-build once with `xcodebuild build-for-testing` (see Prerequisites). The build artifacts live at `scripts/rn-fast-runner/build/DerivedData/`.
- **Legacy `AgentDeviceRunner` re-appears on the simulator** → A stale `~/.agent-device/daemon.json` is respawning the upstream runner. Since #202 the plugin terminates stale `AgentDeviceRunner` processes at session-open by default (scoped to the target simulator UDID) and clears orphaned `~/.agent-device/daemon.{json,lock}`, so this should self-heal. If you've opted out via `RN_DEVICE_KILL_LEGACY=0`, either drop that override or clean up one-time: `pkill -f AgentDeviceRunner && rm -f ~/.agent-device/daemon.json ~/.agent-device/daemon.lock`.
- **`RnFastRunner` / `RnFastRunnerUITests-Runner` icons appear on the simulator** → Expected, not clutter. iOS device control is an XCUITest rig (D1219), so running it installs two apps: `RnFastRunner` (the minimal host app, bundle `dev.lykhoyda.rndevagent.fastrunner`) and `RnFastRunnerUITests-Runner` (the XCUITest harness — same pattern as WebDriverAgent's `WebDriverAgentRunner`). The Runner hosts the `POST /command` HTTP server on port 22088 and drives YOUR app via `XCUIApplication(bundleIdentifier:)` — it never drives itself. It stays installed/running on purpose so subsequent `device_*` calls are fast; leave it. (Contrast the legacy `AgentDeviceRunner` above, which IS unwanted.)
- **"No booted simulator"** → Open Simulator.app or boot one via Xcode
- **iOS 26.x beta issues** → Use iOS 18 stable runtime (Xcode > Settings > Platforms)
- **Node.js odd version (v25)** → Switch to Node 22 LTS: `nvm install 22 && nvm use 22`

### Zustand store access
For Zustand stores to be readable by the plugin, add this to your app entry:
```typescript
if (__DEV__) {
  globalThis.__ZUSTAND_STORES__ = {
    myStore: useMyStore,
    // ... other stores
  };
}
```

---

## Architecture (for contributors)

Three layers working together:

| Layer | Tool | Role |
|-------|------|------|
| Device interaction (iOS) | In-tree `rn-fast-runner` XCTest rig (`scripts/rn-fast-runner/`) — single `POST /command` HTTP endpoint | Native iOS device control via XCTest. Always calls `XCUIApplication.activate()` per request so the target app is foregrounded (B155 / D1219). |
| Device interaction (Android) | `agent-device` CLI (auto-installed) | Native Android device control: tap, swipe, fill, find, snapshot, screenshot |
| App introspection | Custom MCP server → Hermes CDP via WebSocket | Persistent WebSocket — reads React fiber tree, store state, network, console, errors |
| E2E testing | maestro-runner (preferred) / Maestro (fallback) | YAML-based persistent test files for CI |

iOS dispatch: every iOS `device_*` call short-circuits through `runIOS()` (TS client at `scripts/cdp-bridge/src/runners/rn-fast-runner-client.ts`) to the in-tree runner's `/command` endpoint. Coordinate-based gestures map to `.drag`; direction-based swipes/scrolls are pre-computed to coords by `device-interact.ts` before dispatch. `device_find` non-exact + `device_scrollintoview` are TS-side orchestrators over `runIOS('snapshot')` (no Swift `.findText` round-trip for fuzzy match — too coarse, returns bool only).

Android dispatch unchanged: 3-tier `agent-device` (daemon socket → fast-runner → CLI). The legacy daemon is detected at session-open on iOS too and, since #202, terminated by default — `ensureSingleRunner()` kills stale `AgentDeviceRunner` processes scoped to the target simulator UDID and clears orphaned `~/.agent-device/daemon.{json,lock}` (opt out with `RN_DEVICE_KILL_LEGACY=0`) — because a stale daemon respawns the upstream `AgentDeviceRunner` and fights our `RnFastRunner` for focus.

Since #202 Phase 1.5, iOS sessions also take a persisted, UDID-scoped ownership lock (`${TMPDIR}/rn-dev-agent-device-<uid>-ios-<udid>.lock`) at `device_snapshot action=open` — additive to the projectRoot bridge lock (`lifecycle/lockfile.ts`). It stops two *different* projects' bridges from driving the *same* simulator: the second gets `DEVICE_BUSY`. It self-heals via PID-liveness + a 30s heartbeat (a holder is reclaimable once its PID is dead or its heartbeat is >90s stale), so it cannot orphan the way the legacy `daemon.lock` did. On an fs error the acquire fails *open* (logged) — never blocking a legitimate session.

Since #202 Phase 2a, a process-wide in-memory `DeviceSessionArbiter` (`lifecycle/device-arbiter.ts`) serializes the three planes per MCP call: `flow` (Maestro) is exclusive, `introspection` (CDP reads) + `interaction` (`device_*`) coexist. Every tool passes through `arbiterWrap` at `trackedTool`; a read/tap issued while a Maestro flow runs refuses fast with `BUSY_FLOW_ACTIVE`. Diagnostics (`cdp_status`), connection management, and session-less tools are unarbitrated so they always work — even mid-flow. The lease is in-memory only (persisting it would recreate the #202 orphaned-lock bug); a leaked lease is cleared via `cdp_status({ resetArbiter: true })`. The flow tools (`maestro_run`/`maestro_test_all`/`cdp_auto_login`) also park the L2 fast-runner for the flow and mark CDP stale after. Composite tools call underlying handler functions, not wrapped MCP tools, so one external call takes exactly one lease.

Since #202 Phase 2b, `cdp_status` auto-recovers the JS-thread-paused wedge (something stole the simulator's foreground, so iOS suspended the app's JS thread): it parks the fast-runner, re-foregrounds the target (`simctl launch <udid> <appId>` — bare launch foregrounds an already-running app with the same pid, resuming its JS thread), reconnects, and confirms recovery with a real CDP liveness probe (not the `isPaused` debugger bit). Bounded to 3 *consecutive* attempts per session (reset on a successful recovery and on `device_snapshot action=open`). It SKIPS when a Maestro flow holds the arbiter lease (it would yank the app out from under the flow), and points you at `cdp_restart(hardReset=true)` if it can't clear the wedge. It does NOT diagnose *who* stole focus (`launchctl list` shows running, not frontmost, apps) — unconditional re-foreground fixes the wedge regardless. iOS-only.

Fallback: `xcrun simctl` (iOS) + `adb` (Android) for device lifecycle (boot / install / launch / terminate) — the runner doesn't manage device state, only interaction.

### Three-layer device-control contract

One mechanism per capability tier. The device-session honors this contract (the L2 coexistence behavior shipped in #188; #202 Phase 3 wrote it down + added a proactive warning).

| Layer | Mechanism | Role | Exclusivity | Toward a foreign runner |
|---|---|---|---|---|
| **L1 INTROSPECTION** | CDP / Hermes | read store / network / component-tree / mmkv / native | **shared** | always safe — never touches XCUITest |
| **L2 INTERACTION** | iOS `RnFastRunner` / Android `agent-device`; `cdp_interact` | primitive taps / types / scrolls | **shared** | re-attach, don't evict (Tier-0 reacquire + CDP re-pin, #188) |
| **L3 FLOW-REPLAY** | `maestro-runner` (Go + WDA) | whole-`.yaml` E2E flows | **exclusive** | owns the device for the flow's duration |

**Coexistence rule:** L1 reads never conflict with a foreign runner; L2 re-attaches rather than evicts; L3 owns the device. On `device_snapshot action=open`, if a foreign maestro session is detected (UDID-scoped) AND no local flow lease is held, the open result carries an informational `meta.foreignRunner` + `FOREIGN_RUNNER_ACTIVE` warning (`runners/external-runner-detect.ts`; opt out with `RN_IOS_FOREIGN_WARN=0`). See `docs-site` → "Using rn-dev-agent with maestro-mcp".

**Device-session visibility + self-healing (#210, D1249).** The L2 `rn-fast-runner` is THE iOS `device_*` backend; Maestro/WDA is the L3 flow engine — **serialized, not competing** (there is no shared WDA session to "ride": maestro-runner spawns WDA per-flow and tears it down). Three reuse-first behaviors make the single iOS path coherent: (1) `cdp_status.deviceSession` reports `{ sessionOpen, rnFastRunner: 'alive'|'stale'|'dead', foreignRunner? }` (iOS-gated) so the runner's state is visible before any `device_*`; (2) `device_find/press/fill` **auto-spawn** the runner from the dispatch choke point when it's down and the XCUITest rig is **prebuilt** — a missing rig returns an actionable `RN_FAST_RUNNER_DOWN` (never a silent multi-minute `xcodebuild`); (3) `device_screenshot` **falls back to `xcrun simctl io screenshot`** whenever the runner can't serve it — including while a Maestro flow owns the device (it runs unleased via the arbiter's `FLOW_FALLBACK_TOOLS` allowlist; simctl is OS-level and can't conflict with WDA). Mid-flow needs map to non-conflicting mechanisms: **pixels → simctl**, **tree/state → `cdp_component_tree`/`cdp_store_state`** (CDP introspection coexists with a flow by design), **taps → not mid-flow** (the arbiter refuses them on purpose). A WDA W3C client was rejected — it would add a *second* XCUITest backend, the opposite of unifying.

### MCP Server (cdp-bridge)

**76 tools** exposed via MCP (re-audited 2026-05-31; counted from `trackedTool()` calls in `scripts/cdp-bridge/src/index.ts`). Five conceptual families:

**CDP tools** — React internals via Chrome DevTools Protocol over WebSocket:
- `cdp_status` — health check with domain capabilities + reconnect state
- `cdp_connect` / `cdp_disconnect` / `cdp_targets` — connection management
- `cdp_evaluate` — arbitrary JS execution in Hermes
- `cdp_reload` / `cdp_restart` — full reload / restart with auto-reconnect
- `cdp_dev_settings` / `cdp_open_devtools` — dev menu + DevTools attach
- `cdp_component_tree` / `cdp_component_state` / `cdp_diagnostic_renderers` — React fiber introspection
- `cdp_navigation_state` / `cdp_nav_graph` / `cdp_navigate` — navigation
- `cdp_store_state` / `cdp_dispatch` — Redux/Zustand/React Query state
- `cdp_network_log` / `cdp_network_body` / `cdp_wait_for_network` — network buffer + sync (D682)
- `cdp_console_log` / `cdp_error_log` / `cdp_native_errors` / `cdp_metro_events` — log/error/metro streams
- `cdp_interact` — press/type/scroll by testID via fiber tree (JS-level; not deprecated — preferred over device_* when a testID is reliable)
- `cdp_heap_usage` / `cdp_cpu_profile` / `cdp_object_inspect` / `cdp_exception_breakpoint` — profiling + inspection
- `cdp_mmkv` — read/write MMKV storage
- `cdp_set_shared_value` — set Reanimated SharedValue by testID for proof captures
- `collect_logs` — parallel multi-source log collection

**Device tools** (14, native interaction — iOS: in-tree `rn-fast-runner` `/command`; Android: `agent-device` CLI):
- `device_list` / `device_screenshot` / `device_snapshot`
- `device_find` / `device_press` / `device_fill` / `device_swipe` / `device_scroll`
- `device_scrollintoview` / `device_back` / `device_longpress` / `device_pinch`
- `device_permission` / `device_batch`

Plus device helpers filed alongside CDP in code: `device_deeplink`, `device_accept_system_dialog`, `device_dismiss_system_dialog`, `device_focus_next`, `device_pick_date`, `device_pick_value`, `device_record`, `device_reset_state`, `cdp_dismiss_dev_client_picker`.

iOS-only quirks worth knowing:
- `device_fill` may surface a Swift-internal `XCUIElement.typeText` quiescence-timeout from XCTest's main-thread sync. The TS client treats this specific error as success on `.type` (`meta.runnerTimeoutShim: true`) because the side-effect (text appended to the field) demonstrably succeeds — observed across the iOS-MVP smoke-tests.
- `device_fill` is **JS-first** (GH #191, D1250). When CDP is connected and the ref resolves to a testID (explicit `testID` arg, or the ref's cached snapshot identifier), it fires React `onChangeText` directly via the injected helper (deterministic — no software keyboard, no predictive-bar corruption) and settle-polls the field value to verify (`meta.textEntryPath: 'js'`, `meta.verify`). It falls back to the native path when there's no JS handler / CDP is down / the ref doesn't resolve. The native path read-back-verifies too and, on a strong corruption signal, runs a bounded clear+retype (`--clear-first --delay-ms`), then a verified maestro fallback, finally erroring `TEXT_ENTRY_UNVERIFIED`. Transforming inputs (masks/`maxLength`) pass as `verify: 'transformed'` (no wasted retries); an unreadable field is `unverifiable` and soft-accepted (a fill never errors merely because we couldn't prove it). `device_batch` fills do NOT yet take this path (follow-up).
- `device_find` non-exact + `device_scrollintoview` ALWAYS route through the TS orchestrators on iOS (never the legacy `agent-device find/scrollintoview` CLI), so they don't respawn the upstream `AgentDeviceRunner`.

**Actions** (the LLM/pragmatic hybrid — see the Actions section below):
- `cdp_run_action` — replay an action by id with `params`; orchestrates `maestro_run` + `cdp_repair_action` + retry; persists a `RunRecord` with `autoRepair` telemetry
- `cdp_repair_action` — fuzzy-match a stale `testID` against the live snapshot, patch the YAML, retry; refuses on human edits (mtime), >3 repairs/24h, or snapshot infra failure
- `cdp_record_test_save_as_action` — promote a recorded walk to `.rn-agent/actions/<id>.yaml` with metadata header + sidecar; auto-promotes to `status: active` on first clean replay
- `cdp_record_test_*` — start / stop / generate / annotate / save / load / list (recorder upstream of actions)

**Testing & composite tools**:
- `proof_step` / `cross_platform_verify` — verification primitives
- `maestro_run` / `maestro_generate` / `maestro_test_all` — Maestro orchestration
- `cdp_auto_login` — credentials-or-deeplink login wrapper

**Macro-Asserts** (state-assertive replays — internal state, not pixels):
- `expect_redux` / `expect_route` / `expect_visible_by_testid` / `expect_text`

### Actions — the LLM/pragmatic hybrid

An **action** is a parameterised Maestro flow under `.rn-agent/actions/<id>.yaml` with a metadata header (id / intent / tags / mutates / status / appId). Actions are **emitted by the agent** when `/test-feature` verification passes — they are not human-authored. They get replayed via `/run-action` (or directly by `cdp_run_action`) as **prologues** before the agent does new interactive work.

**Why we have them.** LLM agents are good at improvising on novel screens, slow and stochastic at re-deriving things they've already seen. Pure-script approaches (Detox, Maestro, Appium) are the opposite — fast but brittle to UI drift. Actions sit in the middle: every successful verification adds one, every drift gets quietly absorbed by `cdp_repair_action`, every truly broken flow escalates. Measured: a 3-step wizard that takes ~14 min as an interactive walk runs in ~4 s replayed (~210× speedup); across 35 stories the average dropped from ~12 min to ~4 min once the corresponding actions existed.

**Composition rule.** The agent never replays an entire job from a script. Each task is two regimes:
1. **Pragmatic reusable actions** for the predictable parts (login, navigation, multi-step setup, locale switching, dismissing gates).
2. **LLM-driven discovery** for the part that is actually new (verifying a specific UI state, exercising a new edge case, debugging a regression).

**Artifact-first protocol.** `rn-tester` and `rn-debugger` agents are instructed (via `feedback_execute_artifacts_before_manual.md`) to scan saved actions before composing any new `device_*` primitives. Manual primitives are a **fallback**, not the default. Single source of truth for the inventory is `scripts/learned-actions.mjs` — shared by `/list-learned-actions`, `/run-action`, and both agents' Step 0 artifact scans.

**Tool surface for actions** (one conceptual family — see "Actions" in the MCP server list above):

| Tool / Command | Role |
|---|---|
| `cdp_record_test_save_as_action` | Promote a recorded walk → first-class action with metadata header + sidecar |
| `cdp_run_action` | Replay with params; orchestrates `maestro_run` + `cdp_repair_action` + retry; persists `RunRecord` with `autoRepair` telemetry (passed/failed/refused/skipped + phase timings) |
| `cdp_repair_action` | Fuzzy-match stale `testID` against live snapshot, patch YAML, retry; refuses on human edits (mtime), >3 repairs/24h, or snapshot infra failure |
| `/list-learned-actions` | Read-only inventory (single source of truth: `scripts/learned-actions.mjs`) |
| `/run-action <name> -e K=V` | Side-effecting execution; gates safety checks (mutates flag, appId match, `${VAR}` coverage), then calls `cdp_run_action` |

**Why hybrid beats either extreme**:

| Failure mode | Pure script | Pure LLM | This plugin |
|---|---|---|---|
| `testID` renamed | Breaks; human re-records | Re-discovers each run | `cdp_repair_action` patches + retries + logs diff |
| Product logic changed | Passes anyway, masks bug | Probabilistically catches | Refuses to auto-patch logic break; surfaces failure |
| Net-new behaviour | Can't author | Re-derives every session | Discovers interactively, **auto-saves verified walk as new action** |
| Cost over time | Linear (drift = human) | Quadratic (full walk each session) | Sub-linear (drift absorbed, library compounds) |

Full user-facing doc: [docs-site/actions](docs-site/src/content/docs/actions/index.mdx) (published at `lykhoyda.github.io/rn-dev-agent/actions/`).

### Key Technical Decisions

- Inject helpers ONCE on CDP connect (~2KB JS), then call `__RN_AGENT.getTree()` etc.
- Per-method timeout classes: fast (1.5s), standard (5s), slow (30s) — D588
- Ring buffers for events (console: 200, network: 100, log: 50) since MCP is pull-based
- 3-tier interaction model: cdp_interact (JS) > device_press (XCTest) > Maestro (E2E) — D497
- Hook-mode fallbacks for network body + CPU profile on RN < 0.83 — D597
- Proactive __RN_AGENT freshness check before every tool call — D502
- iOS device verbs route through `rn-fast-runner-client.ts` (`runIOS()` → `/command`); Android keeps 3-tier `agent-device` dispatch (fast-runner → daemon → CLI) via `agent-device-wrapper.ts` — D1219, PR #164
- `cdp_repair_action` self-bootstraps the iOS fast-runner on auto-repair (no pre-opened device session required) — D1220

## Conventions

- CDP bridge is TypeScript (Node.js >= 22, LTS versions recommended)
- Skills/agents/commands are Markdown files with YAML frontmatter
- Maestro flows are YAML
- Prefer maestro-runner over Maestro (3x faster, no JVM)
- Always filter component tree queries — never dump the full tree
- Use explicit type imports (`import type { ... }`)
- No unnecessary comments in code
- **When developing tools, instrument them with per-step timing in `meta.timings_ms`** so we can see where they're slow. The 3-tier dispatch (fast-runner → daemon → CLI), agent-device handshake, fiber-tree snapshot, and Maestro flow execution all have variable cost; the dispatcher is the only one that already returns per-step ms. Add `meta.timings_ms: { stepA: ms, stepB: ms, ... }` to tool results so users can run a tool a few times, eyeball the breakdown, and know which path to optimize. Without this we're guessing — the MTTR experiment surfaced two perf-related bugs (B153/B154) that took hours to root-cause precisely because the snapshot path was opaque-timed.
