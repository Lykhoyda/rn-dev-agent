# rn-dev-agent

A [Claude Code](https://docs.anthropic.com/en/docs/claude-code) plugin that turns Claude into a React Native development partner. It explores your codebase, designs architecture, implements features, then **verifies everything live on the simulator** — reading the component tree, store state, and navigation stack through Chrome DevTools Protocol.

**51 MCP tools** | **5 agents** | **13 commands** | **46 best-practice rules** | [Full documentation](https://lykhoyda.github.io/rn-dev-agent/)

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
| 7. Proof | Execute proof flow step by step, capture screenshots |

### Other commands

| Command | Purpose | Docs |
|---------|---------|------|
| `/rn-dev-agent:test-feature <desc>` | Test an already-implemented feature | [docs](https://lykhoyda.github.io/rn-dev-agent/commands/test-feature/) |
| `/rn-dev-agent:debug-screen` | Diagnose and fix a broken screen | [docs](https://lykhoyda.github.io/rn-dev-agent/commands/debug-screen/) |
| `/rn-dev-agent:build-and-test <desc>` | Build app, then test | [docs](https://lykhoyda.github.io/rn-dev-agent/commands/build-and-test/) |
| `/rn-dev-agent:check-env` | Verify environment readiness | [docs](https://lykhoyda.github.io/rn-dev-agent/commands/check-env/) |
| `/rn-dev-agent:proof-capture <desc>` | Record proof video + screenshots | [docs](https://lykhoyda.github.io/rn-dev-agent/commands/proof-capture/) |
| `/rn-dev-agent:nav-graph` | Extract navigation graph | [docs](https://lykhoyda.github.io/rn-dev-agent/commands/nav-graph/) |

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

51 tools across three layers. [Full reference](https://lykhoyda.github.io/rn-dev-agent/tools/)

| Category | Count | Examples | Docs |
|----------|-------|---------|------|
| **CDP** (React internals) | 24 | `cdp_component_tree`, `cdp_store_state`, `cdp_evaluate`, `cdp_network_body` | [CDP tools](https://lykhoyda.github.io/rn-dev-agent/tools/#cdp-tools) |
| **Device** (native interaction) | 14 | `device_find`, `device_press`, `device_fill`, `device_screenshot` | [Device tools](https://lykhoyda.github.io/rn-dev-agent/tools/#device-tools) |
| **Testing** (E2E + proof) | 13 | `proof_step`, `cross_platform_verify`, `maestro_run` | [Testing tools](https://lykhoyda.github.io/rn-dev-agent/tools/#testing-tools) |

## Architecture

```
Claude Code
  ├── Skills (knowledge) + Agents (protocols) + Commands (entry points)
  │
  ├── MCP Server (CDP Bridge) ─── WebSocket → Metro → Hermes CDP
  │   51 tools: component tree, store state, profiling, network, interaction
  │
  └── Bash (device lifecycle)
      xcrun simctl / adb / maestro-runner / agent-device
          │                         │
     iOS Simulator           Android Emulator
```

[Architecture details](https://lykhoyda.github.io/rn-dev-agent/architecture/)

## Benchmarks

35 stories completed on the test app. [Full benchmarks](https://lykhoyda.github.io/rn-dev-agent/benchmarks/)

| Complexity | Time | Crashes | Manual interventions |
|-----------|------|---------|---------------------|
| Simple (search, toggle, store) | 3-5 min | 0 | 0 |
| Medium (forms, charts, lists) | 5-10 min | 0 | 0 |
| Complex (3-step wizard, onboarding) | 11-25 min | 0 | 0 |

**Libraries tested:** react-hook-form, zod, @tanstack/react-query, @gorhom/bottom-sheet, @shopify/flash-list, zustand, react-native-svg, expo-notifications, react-native-reanimated, react-native-gesture-handler, expo-haptics

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

[Full troubleshooting guide](https://lykhoyda.github.io/rn-dev-agent/troubleshooting/)

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

Tests: `cd scripts/cdp-bridge && npm test` (144 tests, [CI](../../actions))

## License

MIT
