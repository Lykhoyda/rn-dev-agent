# rn-dev-agent

A [Claude Code](https://docs.anthropic.com/en/docs/claude-code) plugin that turns Claude into a React Native development partner. It explores your codebase, designs architecture, implements features, then **verifies everything live on the simulator** — reading the component tree, store state, and navigation stack through Chrome DevTools Protocol.

**74 MCP tools** · **5 agents** · **17 commands** · **1180+ tests** · **46 best-practice rules** · [Full documentation](https://lykhoyda.github.io/rn-dev-agent/)

---

## Install

```bash
/plugin marketplace add Lykhoyda/rn-dev-agent
/plugin install rn-dev-agent@Lykhoyda-rn-dev-agent
/reload-plugins
```

## Setup

Navigate to your React Native project and run the setup check:

```bash
cd /path/to/your-rn-app
```

```
/rn-dev-agent:setup
```

This checks **10 prerequisites** and fixes what it can automatically:

| Check | Required | Auto-install |
|-------|----------|-------------|
| Node.js >= 22 LTS | Yes | No |
| CDP bridge deps | Yes | Yes |
| rn-fast-runner (iOS) | iOS targets only — ships in-tree; prebuilt artifact on releases, one-time `xcodebuild build-for-testing` fallback | No |
| rn-android-runner (Android) | Android targets only — ships in-tree; prebuilt artifact on releases, Gradle build fallback on first use | No |
| [maestro-runner](https://github.com/devicelab-dev/maestro-runner) | Yes | Yes |
| iOS Simulator / Android Emulator | One platform | No |
| Metro dev server | Yes | No |
| CDP connection | Yes | Auto via `cdp_status` |
| ffmpeg | Optional | No |

If auto-install fails for any dependency, the setup command gives step-by-step manual instructions. [Full setup guide](https://lykhoyda.github.io/rn-dev-agent/getting-started/)

**Prebuilt runners:** on a released version the device runners install from a verified prebuilt artifact (a SHA-256-checked local cache, then the GitHub Release asset for your exact plugin version), so the first `device_snapshot action=open` skips the multi-minute cold `xcodebuild` / Gradle build. Resolution is fail-open — offline, a checksum mismatch, or a dev/unreleased checkout transparently falls back to the on-machine build (`/rn-dev-agent:doctor` shows `prebuilt v<X> (cache/download)` vs `local-built`). Force the local build with `RN_RUNNER_BUILD=local`.

## Usage

Tell Claude what to build:

```
/rn-dev-agent:rn-feature-dev add a shopping cart with badge, item list, and checkout flow
```

Claude runs an [8-phase pipeline](https://lykhoyda.github.io/rn-dev-agent/commands/rn-feature-dev/) — from understanding your codebase to verified code with proof screenshots:

| Phase | What happens |
|-------|-------------|
| 1. Discovery | Understand the feature, create a task plan |
| 2. Exploration | Parallel agents map screens, store, navigation, conventions |
| 3. Questions | Clarify edge cases, error states, data flow |
| 4. Architecture | Design implementation with Opus-powered architect |
| 5. Implementation | Build the feature — store, components, navigation, testIDs |
| 5.5. Verification | **Prove it works live** — CDP health, component tree, store state, interaction, screenshot |
| 6. Review | Parallel review agents check correctness and RN conventions |
| 7. Proof | **Rehearse off camera**, persist a Maestro action with metadata, then record a deterministic replay — discovery never appears in the video |

### Other commands

**Develop & test:**

| Command | Purpose |
|---------|---------|
| `/rn-dev-agent:test-feature <desc>` | Test an already-implemented feature; auto-replays an existing Maestro action if one matches |
| `/rn-dev-agent:debug-screen` | Diagnose and fix a broken screen — gathers parallel evidence from CDP + native logs + component tree |
| `/rn-dev-agent:build-and-test <desc>` | Build app (local or EAS), install on device, then test |
| `/rn-dev-agent:proof-capture <desc>` | Rehearsal-gated video + screenshots + PR body |
| `/rn-dev-agent:observe` | Start a read-only local web UI to **watch the agent live** — tool-call timeline, latest device screenshot, and route/store/component-tree panels. Prints a `127.0.0.1` URL to open in a browser. |

**Actions: replayable app flows + the LLM/pragmatic hybrid**

An **action** is a saved Maestro flow the agent **emits** when `/test-feature` verification passes — not something you author. Each task is then composed of two regimes: **pragmatic reusable actions** for predictable parts (login, navigation, multi-step setup) and **LLM-driven discovery** for the part that's actually new. The agent uses actions as prologues to reach a known state before doing fresh interactive work. Measured: a 3-step wizard that took **13 min 55 s** as an interactive walk runs in **~4 s** when replayed — ~210× faster.

| | |
|---|---|
| **What** | A saved, parameterised flow with a metadata header and `${KEY}` placeholders. |
| **Where** | `.rn-agent/actions/<name>.yaml`. The plugin's home in your project is `.rn-agent/`. |
| **Create one** | Run `/rn-dev-agent:test-feature <description>`. The verified walk is saved as an action. |
| **Run one** | List with `/rn-dev-agent:list-learned-actions`; replay with `/rn-dev-agent:run-action <name>`. The agent also picks an action automatically when it needs to reach a known state. |
| **Self-repair** | If a `testID` changes, `cdp_repair_action` fuzzy-matches against the live snapshot, patches the YAML, and retries. Small UI drift absorbed; broken product logic surfaced, not auto-fixed. |
| **Why hybrid** | Pure scripts don't adapt; pure LLM re-derives everything every session. Actions are the memory of the LLM loop — every successful verification adds one, every drift gets quietly absorbed, every truly broken flow escalates. |

[Full actions guide — why the hybrid matters, tool surface, comparison vs Detox/Maestro/pure-LLM](https://lykhoyda.github.io/rn-dev-agent/actions/)

**Setup & diagnostics:**

| Command | Purpose |
|---------|---------|
| `/rn-dev-agent:setup` | Inject CLAUDE.md tool-routing rules + nav-ref + Zustand exposure |
| `/rn-dev-agent:doctor` | 15-row diagnostic table — Node, CDP, rn-fast-runner (iOS), rn-android-runner (Android), maestro-runner, simulators, Metro, helpers freshness, plugin version, CDP auto-reconnect mode |
| `/rn-dev-agent:check-env` | Quick environment-readiness check |
| `/rn-dev-agent:nav-graph` | Extract and inspect the app navigation graph |
| `/rn-dev-agent:send-feedback` | Open a GitHub issue with sanitized environment context |

Repo-local troubleshooting memory: the agent maintains a gitignored `.rn-agent/local/troubleshooting.md` per project (auto-captured failures + config notes), read at session start and updated at session end.

## What makes this different

**Live verification** — After implementing a feature, Claude connects to your running app via CDP, navigates to the screen, checks the component tree, exercises interactions, and confirms store state. No "trust me it works."

**46 best-practice rules** — Integrated from [Vercel's React Native skills](https://github.com/vercel-labs/agent-skills), covering crash prevention, list performance, animations, and state management. Applied during architecture and review. [Browse rules](https://lykhoyda.github.io/rn-dev-agent/best-practices/)

**5 specialized agents** — [tester](https://lykhoyda.github.io/rn-dev-agent/agents/rn-tester/), [debugger](https://lykhoyda.github.io/rn-dev-agent/agents/rn-debugger/), [code explorer](https://lykhoyda.github.io/rn-dev-agent/agents/rn-code-explorer/), [architect](https://lykhoyda.github.io/rn-dev-agent/agents/rn-code-architect/), [reviewer](https://lykhoyda.github.io/rn-dev-agent/agents/rn-code-reviewer/). Each runs a focused protocol for its domain.

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

## MCP Tools

The plugin exposes **74 MCP tools** across five families. See the [tools reference](https://lykhoyda.github.io/rn-dev-agent/tools/) for the full list.

| Family | What it's for | Examples |
|---|---|---|
| **CDP** | React internals via Chrome DevTools Protocol | `cdp_status`, `cdp_component_tree`, `cdp_store_state`, `cdp_evaluate`, `cdp_native_errors`, `cdp_navigate`, `collect_logs` |
| **Device** | Native interaction with the simulator/emulator | `device_find`, `device_press`, `device_fill`, `device_screenshot`, `device_pick_date`, `device_batch` |
| **Actions** | Record / replay / self-repair persistent flows ([guide](https://lykhoyda.github.io/rn-dev-agent/actions/)) | `cdp_run_action`, `cdp_repair_action`, `cdp_record_test_save_as_action`, `cdp_record_test_*` |
| **Testing** | E2E replay and PR-ready proof | `proof_step`, `cross_platform_verify`, `maestro_run`, `maestro_test_all`, `cdp_auto_login` |
| **Macro-Asserts** | State-assertive replays — internal state, not pixels | `expect_redux`, `expect_route`, `expect_visible_by_testid`, `expect_text` |

### What's new in v0.44.18 (2026-05-05)

- **Self-healing actions** — new `cdp_repair_action` patches a stale `testID` via fuzzy match against the live snapshot when `/run-action` fails with `SELECTOR_NOT_FOUND`. Guardrails: refuses on human edits (mtime check), refuses past 3 repairs in 24h, refuses on snapshot infrastructure failure.
- **Auto-repair-aware action replay** — new `cdp_run_action` orchestrates `maestro_run` + parser + `cdp_repair_action` + retry, then persists a `RunRecord` with structured `autoRepair` telemetry (passed / failed / refused / skipped, plus phase-level timing for MTTR analysis).
- **Auto-emission of recorded walks** — new `cdp_record_test_save_as_action` turns a recorded walk into a first-class `.rn-agent/actions/<id>.yaml` with a full metadata header and initialised sidecar. Auto-promotes to `status: active` on first clean replay.
- **Macro-Asserts** — `expect_redux`, `expect_route`, `expect_visible_by_testid`, `expect_text` for state-assertive replays. Maestro asserts pixels; these assert internal state. Differentiated capability over Maestro Cloud / KaneAI / BrowserStack.
- **testID-keyed `device_batch`** — re-resolves via fresh fiber-tree snapshot per call, immune to stale-ref-across-step-transitions failures.
- **Three-layer architecture** — Workflow (rn-feature-dev) / Discovery (CDP + device tools) / Reproducible Actions is the canonical mental model. See [architecture](https://lykhoyda.github.io/rn-dev-agent/architecture/).
- **Atomic YAML+sidecar pair-write** — sidecar-first ordering with future-mtime buffer guarantees no false-positive "external edit" alarms even on partial-write failures (D1101 / issue #101).
- **CAS read-modify-write protection** — `saveActionWithCAS` detects concurrent writer races on the same actionId and retries, so RunRecord history doesn't lose entries under heavy parallel runs (issue #117).
- **1180+ unit tests** in cdp-bridge (was 994 in v0.44.5, 249 in v0.23.0).

## Architecture

```
Claude Code
  ├── Skills (knowledge) + Agents (protocols) + Commands (entry points)
  │
  ├── MCP Server (CDP Bridge) ─── WebSocket → Metro → Hermes CDP
  │   74 tools: component tree, store state, profiling, network, interaction, recording, self-healing
  │
  └── Device interaction
      ├── iOS    → in-tree rn-fast-runner (XCTest /command HTTP)  ← D1219, PR #164
      └── Android → in-tree rn-android-runner (UiAutomator instrumentation)
          │                         │
     iOS Simulator           Android Emulator

      Device lifecycle (boot / install / launch): xcrun simctl + adb
      E2E test execution: maestro-runner (preferred) / Maestro (fallback)
```

[Architecture details](https://lykhoyda.github.io/rn-dev-agent/architecture/)

## Benchmarks

38 stories completed on the test app (35 Ralph Loop + 3 Liquid Glass). [Full benchmarks](https://lykhoyda.github.io/rn-dev-agent/benchmarks/)

| Complexity | Time | Crashes | Manual interventions |
|-----------|------|---------|---------------------|
| Simple (search, toggle, store) | 3-5 min | 0 | 0 |
| Medium (forms, charts, lists) | 5-10 min | 0 | 0 |
| Complex (3-step wizard, onboarding) | 11-25 min | 0 | 0 |
| Glass UI (BlurView, Reanimated, haptics) | 27-90 min | 0 | 1 (Metro restart) |

**Libraries tested:** react-hook-form, zod, @tanstack/react-query, @gorhom/bottom-sheet, @shopify/flash-list, zustand, react-native-svg, expo-notifications, react-native-reanimated, react-native-gesture-handler, expo-haptics, expo-blur

## Troubleshooting

| Problem | Solution |
|---------|----------|
| "Metro not found" | Start Metro: `npx expo start` or `npx react-native start` |
| "No Hermes target" | Open the app on simulator, ensure Hermes is enabled |
| CDP rejected (1006) | Close React Native DevTools, Flipper, or Chrome DevTools |
| Zustand store error | Add `global.__ZUSTAND_STORES__` ([setup](https://lykhoyda.github.io/rn-dev-agent/getting-started/#zustand-stores-one-line)) |
| Plugin not detected | `/plugin install rn-dev-agent@Lykhoyda-rn-dev-agent` then `/reload-plugins` |
| Tools fail after upgrade | Restart Claude Code ([why](https://lykhoyda.github.io/rn-dev-agent/troubleshooting/)) |
| Spawned subagent says "MCP tools unavailable" | Never spawn `rn-tester` / `rn-debugger` via Task tool — MCP stdio doesn't propagate to subprocesses (GH #31). Use `/rn-dev-agent:test-feature` or `/rn-dev-agent:debug-screen` instead; protocols run inline in the parent session. |
| Blank white screen after many reloads | NativeWind stylesheet corruption after 5+ `cdp_reload` cycles. Kill Metro, restart it, relaunch the app. `cdp_status` warns when reload count is high. |
| `device_scroll` times out on Reanimated screens | A `waitForIdle` round-trip can deadlock against Reanimated worklets. Scroll routes through the in-tree runner's HID synthesis instead. Ensure the runner is healthy via the device session (iOS: `rn-fast-runner`, Android: `rn-android-runner`). |
| Legacy `AgentDeviceRunner` re-appears on iOS sim | Stale `~/.agent-device/daemon.json` respawns the upstream runner alongside our in-tree `rn-fast-runner`. Since #202 the plugin terminates stale `AgentDeviceRunner` processes at session-open by default (scoped to the target simulator UDID) and clears orphaned `~/.agent-device/daemon.{json,lock}`, so this self-heals. Opt out with `RN_DEVICE_KILL_LEGACY=0`; to clean up manually: `pkill -f AgentDeviceRunner && rm -f ~/.agent-device/daemon.{json,lock}`. |
| iOS `device_*` calls fail with "rn-fast-runner did not become ready" | Build artifacts missing. Pre-build once: `cd ${CLAUDE_PLUGIN_ROOT}/scripts/rn-fast-runner/RnFastRunner && xcodebuild build-for-testing -project RnFastRunner.xcodeproj -scheme RnFastRunner -destination "platform=iOS Simulator,id=<UDID>" -derivedDataPath ../build/DerivedData`. After that, the runner spawns lazily on `device_snapshot action=open`. |
| iOS `device_fill` returns "main thread execution timed out" but text appears in the field | Known XCTest-internal quiescence behavior; the TS client treats this specific error as success on `.type` (`meta.runnerTimeoutShim: true`). The side-effect succeeded — proceed. |
| Want XCTest's stock idle-waits back / suspect mid-animation snapshots | Since #384 the iOS runner makes XCTest's private quiescence wait a no-op (default ON) so React Native apps with Reanimated/looping animations can't hang queries — the same WebDriverAgent-lineage bypass Maestro uses. Opt out with `RN_QUIESCENCE_BYPASS=0` (read when the runner spawns — an already-running runner keeps its old state and survives session reopen by design, so kill it first: `pkill -f RnFastRunnerUITests`, then reopen the device session and confirm via `cdp_status` → `deviceSession.runnerCapabilities`). Audit: first `device_*` result after boot carries `meta.quiescenceBypass`, and `cdp_status` → `deviceSession.runnerCapabilities` lists `QUIESCENCE_BYPASS` while active. If the runner logs `RN_FAST_RUNNER_QUIESCENCE_UNAVAILABLE`, Apple renamed the private selector on your Xcode — everything still works, just without the bypass; please file an issue. |

[Full troubleshooting guide](https://lykhoyda.github.io/rn-dev-agent/troubleshooting/)

## Security

The `cdp_evaluate` tool runs arbitrary JavaScript in your app's Hermes runtime with full access to component tree, store state, AsyncStorage, and any in-memory secrets. This is **intentional** — runtime introspection is what makes the plugin useful for debugging — but it means **only run this plugin against apps where you trust the agent's prompts**.

Recommended usage:
- **Local dev environments only.** Do not point the plugin at production builds, store-signed apps, or any app holding real user data.
- **Treat the agent like a developer with shell access to your laptop.** Any prompt that reaches `cdp_evaluate` (directly or through another tool that calls it) can read or mutate your app's runtime state.
- **Don't connect to CDP targets you didn't intentionally launch.** The plugin filters Metro endpoints to `127.0.0.1` / `localhost`, but if you're running multiple Hermes targets on your machine, double-check `cdp_targets` before relying on tool output.

The plugin makes no attempt to sandbox `cdp_evaluate` calls. If you need that, gate the agent's tool access through Claude Code's permission prompts rather than trusting the tool layer to enforce safety.

The **observability UI** (`/rn-dev-agent:observe`) is opt-in and read-only: it binds to `127.0.0.1` on a random port, rejects cross-origin requests via Host-header + `Sec-Fetch-Site` checks, and serves no mutation endpoints. Tool arguments and payloads are deep-redacted (fail-closed — an unredactable value is dropped, not leaked) before they ever reach the stream, so tokens, passwords, and PII render as `[REDACTED_*]`. The recorder keeps only a small bounded in-memory ring buffer (recent events, never written to disk); nothing is exposed until you explicitly start the server.

## Keeping up to date

Enable auto-update in the plugin manager (Marketplaces tab), or update manually:

```bash
/plugin update rn-dev-agent@Lykhoyda-rn-dev-agent
/reload-plugins
```

## Development

```bash
git clone https://github.com/Lykhoyda/rn-dev-agent.git
cd rn-dev-agent/scripts/cdp-bridge && npm install && npm run build && cd ../..
cd /path/to/your-rn-app && claude --plugin-dir /path/to/rn-dev-agent
```

Tests: `cd scripts/cdp-bridge && npm test` (1180+ tests, [CI](../../actions))

## License

MIT
