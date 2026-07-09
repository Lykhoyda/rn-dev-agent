# rn-dev-agent

[![CI](https://github.com/Lykhoyda/rn-dev-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/Lykhoyda/rn-dev-agent/actions/workflows/ci.yml)
[![Docs](https://img.shields.io/badge/docs-lykhoyda.github.io%2Frn--dev--agent-blue)](https://lykhoyda.github.io/rn-dev-agent/)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

A coding-agent plugin for **Claude Code** and **Codex** that turns an AI agent into a React Native development partner. It explores your codebase, designs architecture, implements features — then **proves everything works live on the simulator** by reading the component tree, store state, and navigation stack through the Chrome DevTools Protocol, driving the app like a user, and recording the evidence.

**78 MCP tools** · **5 agents** · **15 commands** · **8 skills** · **118 best-practice rules** · **2,976 unit tests** · [Full documentation](https://lykhoyda.github.io/rn-dev-agent/)

---

## Why this exists

Coding agents are good at writing React Native code and bad at knowing whether it actually works. This plugin closes that loop:

- **Live verification, not "trust me it works."** After implementing a feature, the agent connects to your running app via CDP, navigates to the screen, checks the component tree, exercises interactions, and confirms store state — before declaring victory.
- **Replayable actions.** Every verified flow is saved as a parameterised Maestro action in `.rn-agent/actions/`. A 3-step wizard that took ~14 minutes as an interactive walk replays in **~4 seconds** (~210× faster). Actions self-repair when `testID`s drift.
- **Native device control on both platforms.** In-tree XCTest (iOS) and UiAutomator (Android) runners give the agent real taps, typing, scrolling, and screenshots — with prebuilt artifacts so first use skips the multi-minute cold build.
- **Curated best practices.** 118 indexed rules (48 React Native + 70 React/web, integrated from [Vercel's agent skills](https://github.com/vercel-labs/agent-skills)) applied during architecture and review — crash prevention, list performance, animations, state management.
- **Watch it work.** `/rn-dev-agent:observe` serves a read-only local web UI with a live tool-call timeline, device mirror, and route/store/component-tree panels.

## Quick start

### 1. Install

**Claude Code** (published marketplace):

```bash
/plugin marketplace add Lykhoyda/rn-dev-agent
/plugin install rn-dev-agent@rn-dev-agent
/reload-plugins
```

Local checkout: `claude --plugin-dir /path/to/rn-dev-agent` (the root `.claude-plugin/marketplace.json` resolves the plugin package from `packages/claude-plugin/`).

**Codex** (published marketplace):

```bash
codex plugin marketplace add Lykhoyda/rn-dev-agent
codex plugin add rn-dev-agent@rn-dev-agent
```

Local checkout: register the package directory `/path/to/rn-dev-agent/packages/codex-plugin` — not the repository root. The Codex package is self-contained (bundled MCP runtime, native runner sources, runner manifest) and loads the same `cdp` MCP server from its `.mcp.json`. Codex does not load Claude Code hooks — `No plugin hooks` in the Codex plugin detail screen is expected.

### 2. Set up your project

```bash
cd /path/to/your-rn-app
```

```
/rn-dev-agent:setup
```

Setup checks the full toolchain and fixes what it can automatically:

| Check | Required | Auto-install |
|-------|----------|--------------|
| Node.js ≥ 22.18 LTS | Yes | No |
| CDP bridge deps | Yes | Yes |
| rn-fast-runner (iOS) | iOS targets only | Prebuilt artifact on releases; one-time `xcodebuild build-for-testing` fallback |
| rn-android-runner (Android) | Android targets only | Prebuilt artifact on releases; Gradle build fallback on first use |
| [maestro-runner](https://github.com/devicelab-dev/maestro-runner) | Yes | Yes (pinned engine, checksum-verified) |
| iOS Simulator / Android Emulator | One platform | No |
| Metro dev server | Yes | No |
| CDP connection | Yes | Auto via `cdp_status` |
| ffmpeg | Optional (proof videos) | Yes |
| idb + idb-companion | Optional (smooth observe-UI mirroring) | Yes |

If auto-install fails, setup gives step-by-step manual instructions. [Full setup guide](https://lykhoyda.github.io/rn-dev-agent/getting-started/)

**Prebuilt runners:** on a released version, the device runners install from a verified prebuilt artifact (SHA-256-checked local cache, then the GitHub Release asset for your exact plugin version), so the first `device_snapshot action=open` skips the cold build. Resolution is fail-open — offline, a checksum mismatch, or a dev checkout falls back transparently to the on-machine build (`/rn-dev-agent:doctor` shows which one you got). Force local builds with `RN_RUNNER_BUILD=local`.

### 3. Build something

```
/rn-dev-agent:rn-feature-dev add a shopping cart with badge, item list, and checkout flow
```

## The pipeline

`/rn-feature-dev` runs an [8-phase pipeline](https://lykhoyda.github.io/rn-dev-agent/commands/rn-feature-dev/) — from understanding your codebase to verified code with proof recordings:

| Phase | What happens |
|-------|--------------|
| 1. Discovery | Understand the feature, create a task plan |
| 2. Exploration | Parallel agents map screens, store, navigation, conventions |
| 3. Questions | Clarify edge cases, error states, data flow |
| 4. Architecture | Design the implementation with the architect agent |
| 5. Implementation | Build the feature — store, components, navigation, testIDs |
| 5.5. Verification | **Prove it works live** — CDP health, component tree, store state, interaction, screenshot |
| 6. Review | Parallel review agents check correctness and RN conventions |
| 7. Proof | **Rehearse off camera**, persist a Maestro action, then record a deterministic replay — discovery never appears in the video |

## Commands

**Develop & test:**

| Command | Purpose |
|---------|---------|
| `/rn-dev-agent:rn-feature-dev <desc>` | Full 8-phase feature pipeline (above) |
| `/rn-dev-agent:test-feature <desc>` | Test an already-implemented feature; auto-replays a matching saved action |
| `/rn-dev-agent:debug-screen` | Diagnose and fix a broken screen — parallel evidence from CDP + native logs + component tree |
| `/rn-dev-agent:build-and-test <desc>` | Build the app (local or EAS), install on device, then test |
| `/rn-dev-agent:proof-capture <desc>` | Rehearsal-gated video + screenshots + generated PR body |
| `/rn-dev-agent:observe` | Read-only local web UI to **watch the agent live** — tool-call timeline, device mirror, route/store/component-tree panels |

**Actions & regression:**

| Command | Purpose |
|---------|---------|
| `/rn-dev-agent:list-learned-actions` | List persisted actions, flows, and feedback memories |
| `/rn-dev-agent:run-action <name>` | Replay a saved action with auto-repair and structured run records |
| `/rn-dev-agent:lock-e2e <name>` | Promote a verified action into a **frozen, locked e2e regression test** (strict no-repair run required) |

**Setup & diagnostics:**

| Command | Purpose |
|---------|---------|
| `/rn-dev-agent:setup` | Onboard a project — prerequisites + CLAUDE.md tool-routing rules + nav-ref + Zustand exposure (refreshes stale template blocks in place) |
| `/rn-dev-agent:doctor` | Full diagnostic table — Node, CDP, device runners, maestro-runner engine pin, simulators, Metro, helpers freshness, plugin version |
| `/rn-dev-agent:check-env` | Quick environment-readiness check |
| `/rn-dev-agent:nav-graph` | Extract and inspect the app navigation graph |
| `/rn-dev-agent:check-vercel-rules` | Report drift between bundled best-practice rules and upstream |
| `/rn-dev-agent:send-feedback` | Open a GitHub issue with sanitized environment context |

The plugin also keeps a gitignored per-project troubleshooting memory (`.rn-agent/local/troubleshooting.md`) — auto-captured failures and config notes, read at session start.

## Actions: replayable flows + the LLM/pragmatic hybrid

An **action** is a saved Maestro flow the agent **emits** when verification passes — not something you author. Each task then splits into two regimes: **pragmatic reusable actions** for the predictable parts (login, navigation, multi-step setup) and **LLM-driven discovery** for the part that's actually new. Actions serve as prologues to reach a known state before fresh interactive work.

| | |
|---|---|
| **What** | A saved, parameterised flow with a metadata header and `${KEY}` placeholders |
| **Where** | `.rn-agent/actions/<name>.yaml` — the plugin's home in your project is `.rn-agent/` |
| **Create one** | Run `/rn-dev-agent:test-feature <description>`; the verified walk is saved automatically |
| **Run one** | `/rn-dev-agent:run-action <name>` — the agent also picks actions automatically when it needs a known state |
| **Self-repair** | If a `testID` changes, `cdp_repair_action` fuzzy-matches against the live snapshot, patches the YAML, and retries. Small UI drift is absorbed; broken product logic is surfaced, never auto-fixed |
| **Lock it in** | `/rn-dev-agent:lock-e2e` freezes a passing action into `.rn-agent/e2e/` — locked tests run strict (no repair) via `cdp_run_e2e_suite` |
| **Why hybrid** | Pure scripts don't adapt; pure LLM re-derives everything every session. Actions are the memory of the LLM loop — every successful verification adds one, every drift gets quietly absorbed, every truly broken flow escalates |

[Full actions guide — why the hybrid matters, tool surface, comparison vs Detox/Maestro/pure-LLM](https://lykhoyda.github.io/rn-dev-agent/actions/)

## MCP tools

The plugin exposes **78 MCP tools** across five families ([full reference](https://lykhoyda.github.io/rn-dev-agent/tools/)):

| Family | What it's for | Examples |
|---|---|---|
| **CDP** | React internals via Chrome DevTools Protocol | `cdp_status`, `cdp_component_tree`, `cdp_store_state`, `cdp_evaluate`, `cdp_native_errors`, `cdp_navigate`, `collect_logs` |
| **Device** | Native interaction with the simulator/emulator | `device_find`, `device_press`, `device_fill`, `device_screenshot`, `device_pick_date`, `device_batch` |
| **Actions** | Record / replay / self-repair persistent flows | `cdp_run_action`, `cdp_repair_action`, `cdp_record_test_save_as_action`, `cdp_lock_e2e_test`, `cdp_run_e2e_suite` |
| **Testing** | E2E replay and PR-ready proof | `proof_step`, `cross_platform_verify`, `maestro_run`, `maestro_test_all`, `cdp_auto_login` |
| **Macro-Asserts** | State-assertive replays — internal state, not pixels | `expect_redux`, `expect_route`, `expect_visible_by_testid`, `expect_text` |

The committed tool surface is asserted in CI against a golden registry (`packages/rn-dev-agent-core/test/fixtures/tool-registry.json`), so this count can't silently drift.

**Reliability features baked into the tool layer:**

- **Self-healing taps** — a stale `@ref` is re-bound by identity (testID/label/role, unique match only), and a tap whose settle hash shows no UI change is re-tapped exactly once. Opt out with `RN_SELF_HEAL=0`.
- **Quiescence bypass (iOS)** — XCTest's private idle-wait is disabled by default so apps with Reanimated/looping animations can't hang queries (the same WebDriverAgent-lineage technique Maestro uses). Opt out with `RN_QUIESCENCE_BYPASS=0`.
- **Engine pinning** — maestro-runner installs a tested pin, checksum-verified fail-closed; `/doctor` and `cdp_status` report drift.
- **Degraded-runtime detection** — when taps succeed but the app doesn't respond, results carry a "simulator likely wedged, reboot it" hint instead of a misleading "element not found."

## Specialized agents

Five agents, each running a focused protocol: [tester](https://lykhoyda.github.io/rn-dev-agent/agents/rn-tester/), [debugger](https://lykhoyda.github.io/rn-dev-agent/agents/rn-debugger/), [code explorer](https://lykhoyda.github.io/rn-dev-agent/agents/rn-code-explorer/), [architect](https://lykhoyda.github.io/rn-dev-agent/agents/rn-code-architect/), [reviewer](https://lykhoyda.github.io/rn-dev-agent/agents/rn-code-reviewer/).

> **Note:** `rn-tester` and `rn-debugger` need MCP tools, which don't propagate to spawned subagents — use `/rn-dev-agent:test-feature` and `/rn-dev-agent:debug-screen`, which run the protocols inline (GH #31).

## App setup

**Most apps need zero setup** — the plugin reads the React fiber tree directly via Metro's CDP endpoint.

**Zustand stores** — one line in your app entry ([details](https://lykhoyda.github.io/rn-dev-agent/getting-started/#zustand-stores-one-line)):

```typescript
if (__DEV__) {
  global.__ZUSTAND_STORES__ = { auth: useAuthStore, cart: useCartStore };
}
```

**Redux** — auto-detected, no setup needed.

**testIDs** — add to interactive elements for reliable queries:

```tsx
<Pressable testID="checkout-button" onPress={handleCheckout}>
  <Text testID="cart-badge">{itemCount}</Text>
</Pressable>
```

## Architecture

```
Claude Code / Codex
  ├── Skills (knowledge) + Agents (protocols) + Commands (entry points)
  │
  ├── MCP Server (CDP Bridge) ─── WebSocket → Metro → Hermes CDP
  │   78 tools: component tree, store state, profiling, network,
  │   interaction, recording, self-healing replay
  │
  └── Device interaction
      ├── iOS    → in-tree rn-fast-runner (XCTest /command HTTP)
      └── Android → in-tree rn-android-runner (UiAutomator instrumentation)
          │                         │
     iOS Simulator           Android Emulator

      Device lifecycle (boot / install / launch): xcrun simctl + adb
      E2E test execution: maestro-runner (pinned) / Maestro (fallback)
```

[Architecture details](https://lykhoyda.github.io/rn-dev-agent/architecture/)

## Benchmarks

38 stories completed on the test app (35 Ralph Loop + 3 Liquid Glass). [Full benchmarks](https://lykhoyda.github.io/rn-dev-agent/benchmarks/)

| Complexity | Time | Crashes | Manual interventions |
|-----------|------|---------|---------------------|
| Simple (search, toggle, store) | 3–5 min | 0 | 0 |
| Medium (forms, charts, lists) | 5–10 min | 0 | 0 |
| Complex (3-step wizard, onboarding) | 11–25 min | 0 | 0 |
| Glass UI (BlurView, Reanimated, haptics) | 27–90 min | 0 | 1 (Metro restart) |

**Libraries tested:** react-hook-form, zod, @tanstack/react-query, @gorhom/bottom-sheet, @shopify/flash-list, zustand, react-native-svg, expo-notifications, react-native-reanimated, react-native-gesture-handler, expo-haptics, expo-blur

## Troubleshooting

| Problem | Solution |
|---------|----------|
| "Metro not found" | Start Metro: `npx expo start` or `npx react-native start` |
| "No Hermes target" | Open the app on the simulator, ensure Hermes is enabled |
| CDP rejected (1006) | Close React Native DevTools, Flipper, or Chrome DevTools |
| Zustand store error | Add `global.__ZUSTAND_STORES__` ([setup](https://lykhoyda.github.io/rn-dev-agent/getting-started/#zustand-stores-one-line)) |
| Plugin not detected | `/plugin install rn-dev-agent@rn-dev-agent` then `/reload-plugins` |
| Tools fail after upgrade | Restart Claude Code ([why](https://lykhoyda.github.io/rn-dev-agent/troubleshooting/)) |
| Subagent says "MCP tools unavailable" | Never spawn `rn-tester`/`rn-debugger` via the Task tool — use `/rn-dev-agent:test-feature` or `/rn-dev-agent:debug-screen` instead (GH #31) |
| Blank white screen after many reloads | NativeWind stylesheet corruption after 5+ `cdp_reload` cycles — kill and restart Metro, relaunch the app |

<details>
<summary><strong>Advanced: device-runner issues</strong></summary>

| Problem | Solution |
|---------|----------|
| `device_scroll` times out on Reanimated screens | A `waitForIdle` round-trip can deadlock against Reanimated worklets; scroll routes through the in-tree runner's HID synthesis instead. Ensure the runner is healthy via the device session |
| Legacy `AgentDeviceRunner` re-appears on iOS | Stale `~/.agent-device/daemon.json` respawns the upstream runner. The plugin terminates stale processes at session-open (opt out: `RN_DEVICE_KILL_LEGACY=0`); manual cleanup: `pkill -f AgentDeviceRunner && rm -f ~/.agent-device/daemon.{json,lock}` |
| iOS "rn-fast-runner did not become ready" | The runner self-build timed out or failed. In a source checkout, pre-build once: `cd packages/rn-fast-runner/RnFastRunner && xcodebuild build-for-testing -project RnFastRunner.xcodeproj -scheme RnFastRunner -destination "platform=iOS Simulator,id=<UDID>" -derivedDataPath ../build/DerivedData` |
| `device_fill` reports "main thread execution timed out" but the text appeared | Known XCTest-internal quiescence behavior; the client treats this specific error as success on `.type` (`meta.runnerTimeoutShim: true`). Proceed |
| Want XCTest's stock idle-waits back | Kill the running runner (`pkill -f RnFastRunnerUITests`), set `RN_QUIESCENCE_BYPASS=0`, reopen the device session. Audit via `cdp_status` → `deviceSession.runnerCapabilities` |
| Seeing `meta.reResolved` / `meta.tapRetried` | Self-healing taps at work (Story 05, #386). Disable per call with `retryIfNoChange: false` or globally with `RN_SELF_HEAL=0` |

</details>

[Full troubleshooting guide](https://lykhoyda.github.io/rn-dev-agent/troubleshooting/)

## Security

The `cdp_evaluate` tool runs arbitrary JavaScript in your app's Hermes runtime with full access to the component tree, store state, AsyncStorage, and any in-memory secrets. This is **intentional** — runtime introspection is what makes the plugin useful — but it means **only run this plugin against apps where you trust the agent's prompts**.

- **Local dev environments only.** Do not point the plugin at production builds, store-signed apps, or any app holding real user data.
- **Treat the agent like a developer with shell access to your laptop.** Any prompt that reaches `cdp_evaluate` (directly or through another tool) can read or mutate your app's runtime state.
- **Don't connect to CDP targets you didn't intentionally launch.** The plugin filters Metro endpoints to `127.0.0.1`/`localhost`, but if multiple Hermes targets are running, double-check `cdp_targets`.

The plugin makes no attempt to sandbox `cdp_evaluate`. If you need that, gate tool access through your agent's permission prompts rather than trusting the tool layer.

The **observability UI** (`/rn-dev-agent:observe`) is opt-in and read-only: it binds to `127.0.0.1` on a random port, rejects cross-origin requests via Host-header + `Sec-Fetch-Site` checks, and serves no mutation endpoints. Tool arguments are deep-redacted fail-closed before reaching the stream (tokens, passwords, and PII render as `[REDACTED_*]`), and the recorder keeps only a small bounded in-memory ring buffer — nothing touches disk, and nothing is exposed until you start the server.

## Keeping up to date

Enable auto-update in the plugin manager (Marketplaces tab), or update manually:

```bash
/plugin update rn-dev-agent@rn-dev-agent
/reload-plugins
```

Release notes: [GitHub Releases](https://github.com/Lykhoyda/rn-dev-agent/releases) · [core changelog](packages/rn-dev-agent-core/CHANGELOG.md)

## Development

This is a Yarn workspace monorepo:

| Package | What it is |
|---------|------------|
| `packages/rn-dev-agent-core` | The MCP server (CDP bridge, device control, actions, testing) — all TypeScript source and tests |
| `packages/claude-plugin` | Claude Code plugin package — manifest, commands, agents, skills, hooks, MCP registration |
| `packages/codex-plugin` | Codex plugin package — self-contained with bundled runtime |
| `packages/shared-agent-knowledge` | Source of truth both host packages are generated from |
| `packages/rn-fast-runner` | In-tree iOS XCTest device runner |
| `packages/rn-android-runner` | In-tree Android UiAutomator device runner |
| `apps/docs-site` | Astro Starlight docs → [lykhoyda.github.io/rn-dev-agent](https://lykhoyda.github.io/rn-dev-agent/) |

```bash
git clone https://github.com/Lykhoyda/rn-dev-agent.git
cd rn-dev-agent
corepack enable
corepack yarn install --immutable
corepack yarn build:host-runtimes   # builds core + generates both host packages
```

Run locally: `claude --plugin-dir /path/to/rn-dev-agent` (Claude Code) or register `packages/codex-plugin` (Codex).

```bash
corepack yarn test          # 2,976 unit tests
corepack yarn lint          # oxlint
corepack yarn format:check  # oxfmt
```

Versioning uses [changesets](https://github.com/changesets/changesets); every tool-surface change must update the golden registry (`node scripts/update-tool-registry.mjs`).

## License

MIT
