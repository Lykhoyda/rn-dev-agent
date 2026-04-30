# rn-dev-agent

A [Claude Code](https://docs.anthropic.com/en/docs/claude-code) plugin that turns Claude into a React Native development partner. It explores your codebase, designs architecture, implements features, then **verifies everything live on the simulator** — reading the component tree, store state, and navigation stack through Chrome DevTools Protocol.

**67 MCP tools** | **5 agents** | **16 commands** | **994 tests** | **46 best-practice rules** | [Full documentation](https://lykhoyda.github.io/rn-dev-agent/)

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

This checks **9 prerequisites** and fixes what it can automatically:

| Check | Required | Auto-install |
|-------|----------|-------------|
| Node.js >= 22 LTS | Yes | No |
| CDP bridge deps | Yes | Yes |
| [agent-device](https://github.com/nicklama/agent-device) | Yes | Yes |
| [maestro-runner](https://github.com/devicelab-dev/maestro-runner) | Yes | Yes |
| iOS Simulator / Android Emulator | One platform | No |
| Metro dev server | Yes | No |
| CDP connection | Yes | Auto via `cdp_status` |
| ffmpeg | Optional | No |

If auto-install fails for any dependency, the setup command gives step-by-step manual instructions. [Full setup guide](https://lykhoyda.github.io/rn-dev-agent/getting-started/)

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

**Reusable actions (M7):**

| Command | Purpose |
|---------|---------|
| `/rn-dev-agent:list-learned-actions` | Browse memories + Maestro flows + UI skeletons + commands available in this project |
| `/rn-dev-agent:run-action <id>` | Replay a persisted Maestro flow with safety pre-flights (mutates flag, appId match, parameter coverage) |

**Setup & diagnostics:**

| Command | Purpose |
|---------|---------|
| `/rn-dev-agent:setup` | Inject CLAUDE.md tool-routing rules + nav-ref + Zustand exposure |
| `/rn-dev-agent:doctor` | 11-row diagnostic table — Node, CDP, agent-device, maestro-runner, simulators, Metro, helpers freshness |
| `/rn-dev-agent:check-env` | Quick environment-readiness check |
| `/rn-dev-agent:nav-graph` | Extract and inspect the app navigation graph |
| `/rn-dev-agent:send-feedback` | Open a GitHub issue with sanitized environment context |

**Experience Engine** (cross-session learning): `/rn-dev-agent:rn-agent-export`, `/rn-dev-agent:rn-agent-import`, `/rn-dev-agent:rn-agent-health`, `/rn-dev-agent:rn-agent-compact` — see [docs](https://lykhoyda.github.io/rn-dev-agent/commands/).

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

67 tools across three layers. [Full reference](https://lykhoyda.github.io/rn-dev-agent/tools/)

| Category | Count | Examples | Docs |
|----------|-------|---------|------|
| **CDP** (React internals) | 38 | `cdp_component_tree`, `cdp_store_state`, `cdp_evaluate`, `cdp_set_shared_value`, `cdp_native_errors`, `cdp_record_test_*` | [CDP tools](https://lykhoyda.github.io/rn-dev-agent/tools/#cdp-tools) |
| **Device** (native interaction) | 22 | `device_find`, `device_press`, `device_fill`, `device_screenshot`, `device_pick_date`, `device_pick_value` | [Device tools](https://lykhoyda.github.io/rn-dev-agent/tools/#device-tools) |
| **Testing** (E2E + proof) | 7 | `proof_step`, `cross_platform_verify`, `maestro_run`, `maestro_generate`, `maestro_test_all` | [Testing tools](https://lykhoyda.github.io/rn-dev-agent/tools/#testing-tools) |

### What's new in v0.44.5 (2026-04-29)

- **M7 reusable-actions metadata schema** — every Maestro flow now carries a 5-key header (`id`, `intent`, `tags`, `mutates`, `status`) so future sessions can find, filter, and replay it safely. New `/list-learned-actions` browses the inventory; new `/run-action` replays with safety pre-flights (mutates flag, appId match, parameter coverage).
- **Phase 8 rehearsal-before-recording gate** — discovery happens off camera, recording captures replay of a verified Maestro flow. Eliminates multi-minute videos of the LLM hunting for testIDs. Max-3 retry budget, Maestro-inexpressibility carve-out documented.
- **CDP helpers auto-reinject** (B149) — `withConnection` does a 1-shot active reinject on `HELPERS_NOT_INJECTED`; `cdp_status` exposes `capabilities.helpersInjected`. Doctor row 8b surfaces the new freshness signal.
- **CDP-001 → CDP-016 review batch** — 15 high-confidence fixes from the multi-LLM CDP tool review (15/16 closed; CDP-008 deferred pending a live keyboard+button accessibility fixture). Session state now lives at `~/Library/Application Support/rn-dev-agent/` per project (CDP-015), off `/tmp`.
- **994 unit tests** in cdp-bridge (was 249 in v0.23.0).

## Architecture

```
Claude Code
  ├── Skills (knowledge) + Agents (protocols) + Commands (entry points)
  │
  ├── MCP Server (CDP Bridge) ─── WebSocket → Metro → Hermes CDP
  │   67 tools: component tree, store state, profiling, network, interaction, recording
  │
  └── Bash (device lifecycle)
      xcrun simctl / adb / maestro-runner / agent-device
          │                         │
     iOS Simulator           Android Emulator
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
| `device_scroll` times out on Reanimated screens | agent-device daemon `waitForIdle` deadlocks with Reanimated worklets. Fixed in v0.22.0 — scroll routes through fast-runner HID synthesis. Ensure fast-runner is healthy via device session. |

[Full troubleshooting guide](https://lykhoyda.github.io/rn-dev-agent/troubleshooting/)

## Security

The `cdp_evaluate` tool runs arbitrary JavaScript in your app's Hermes runtime with full access to component tree, store state, AsyncStorage, and any in-memory secrets. This is **intentional** — runtime introspection is what makes the plugin useful for debugging — but it means **only run this plugin against apps where you trust the agent's prompts**.

Recommended usage:
- **Local dev environments only.** Do not point the plugin at production builds, store-signed apps, or any app holding real user data.
- **Treat the agent like a developer with shell access to your laptop.** Any prompt that reaches `cdp_evaluate` (directly or through another tool that calls it) can read or mutate your app's runtime state.
- **Don't connect to CDP targets you didn't intentionally launch.** The plugin filters Metro endpoints to `127.0.0.1` / `localhost`, but if you're running multiple Hermes targets on your machine, double-check `cdp_targets` before relying on tool output.

The plugin makes no attempt to sandbox `cdp_evaluate` calls. If you need that, gate the agent's tool access through Claude Code's permission prompts rather than trusting the tool layer to enforce safety.

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

Tests: `cd scripts/cdp-bridge && npm test` (994 tests, [CI](../../actions))

## License

MIT
