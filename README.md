# rn-dev-agent (WORK IN PROGRESS)

A Claude Code plugin that lets an AI agent fully test React Native features on iOS Simulator / Android Emulator. The agent navigates the app, verifies UI, walks user flows, and confirms internal state (component tree, store data, network responses, navigation stack).

This is a **feature verification pipeline** — not a generic automation tool.

## Table of Contents

- [Requirements](#requirements)
- [Installation](#installation)
- [Setup for Your App](#setup-for-your-app)
- [Usage](#usage)
- [Commands Reference](#commands-reference)
- [MCP Tools Reference](#mcp-tools-reference)
- [Architecture](#architecture)
- [Troubleshooting](#troubleshooting)
- [Documentation](#documentation)

## Requirements

| Requirement | Version | Notes |
|-------------|---------|-------|
| Node.js | >= 18 | Required for the CDP bridge MCP server |
| Claude Code CLI | Latest | `npm install -g @anthropic-ai/claude-code` |
| Xcode + Simulator | Latest | For iOS testing |
| Android Studio + Emulator | Latest | For Android testing |
| Maestro | Latest | `brew install maestro` — for UI interaction flows |

You need at least one platform (iOS or Android) set up. Both are not required.

**Optional but recommended:** [maestro-runner](https://github.com/devicelab-dev/maestro-runner) — a Go-based Maestro alternative that is 3x faster (no JVM cold start).

## Installation

### Option A: From Plugin Tab (Recommended)

```
/plugin marketplace add Lykhoyda/react-native-dev-claude-plugin
/plugin install rn-dev-agent
```

Then navigate to your React Native project and start Claude Code — the plugin activates automatically.

### Option B: From Source

```bash
git clone https://github.com/Lykhoyda/react-native-dev-claude-plugin.git
cd react-native-dev-claude-plugin

# Install MCP server dependencies (dist/ is pre-built, but rebuild after modifying source)
cd scripts/cdp-bridge && npm install && npm run build && cd ../..
```

Launch Claude Code with the plugin:

```bash
cd /path/to/your-react-native-app
claude --plugin-dir /path/to/react-native-dev-claude-plugin
```

On startup, if a React Native project is detected (via `package.json` + `metro.config.js`/`app.json`/`app.config.js`/`app.config.ts`), you'll see a message listing available commands.

## Setup for Your App

### Basic setup (works for most apps)

No app-side changes needed. The plugin connects to your app via Metro's CDP endpoint and inspects the React fiber tree directly.

### Zustand state inspection

If your app uses Zustand, add one line to your app entry point so the plugin can read store state:

```typescript
// app/_layout.tsx or App.tsx
if (__DEV__) {
  global.__ZUSTAND_STORES__ = {
    auth: useAuthStore,
    cart: useCartStore,
    settings: useSettingsStore,
    // add all stores you want inspectable
  };
}
```

This has zero production cost — the `if (__DEV__)` block is stripped in release builds.

### Redux state inspection

Redux is auto-detected via the React fiber tree (finds the `Provider` component and reads the store). No setup needed.

### testID best practices

For reliable UI queries, add `testID` props to key components:

```tsx
<TouchableOpacity testID="checkout-button" onPress={handleCheckout}>
  <Text testID="cart-badge">{itemCount}</Text>
</TouchableOpacity>
```

The plugin uses `testID` to filter the component tree efficiently, avoiding full tree dumps that waste tokens.

## Usage

### Before testing

1. **Boot a simulator/emulator:**
   ```bash
   # iOS
   xcrun simctl boot "iPhone 16"
   open -a Simulator

   # Android
   emulator -avd Pixel_7_API_34
   ```

2. **Start Metro:**
   ```bash
   # Expo
   npx expo start

   # React Native CLI
   npx react-native start
   ```

3. **Launch the app** on the simulator (it should be visible on screen).

4. **Start Claude Code with the plugin:**
   ```bash
   cd /path/to/your-rn-app
   claude --plugin-dir /path/to/react-native-dev-claude-plugin
   ```

5. **Verify the environment:**
   ```
   /rn-dev-agent:check-env
   ```

### Commands

| Command | Description |
|---------|-------------|
| `/rn-dev-agent:test-feature <description>` | Test a feature end-to-end on the simulator/emulator |
| `/rn-dev-agent:build-and-test <description>` | Build/install app, then test (supports `--eas [profile]`) |
| `/rn-dev-agent:debug-screen` | Diagnose and fix the current screen |
| `/rn-dev-agent:check-env` | Verify environment is ready (Metro, CDP, app status) |

### Example: Testing a feature

```
/rn-dev-agent:test-feature shopping cart — add items, see badge, checkout
```

The agent runs a 7-step protocol:
1. **Environment check** — confirms Metro running, CDP connected, no RedBox
2. **Understand the feature** — reads implementation files, finds testIDs, routes, store slices
3. **Plan the test** — writes test steps and expected outcomes before executing
4. **Navigate to start** — uses deep links or Maestro to reach the starting screen
5. **Execute and verify** — for each step: act (Maestro) -> wait (assertVisible) -> verify UI (component tree) -> verify data (store state + network)
6. **Edge cases** — tests empty state, error state, back navigation, rapid interactions
7. **Generate persistent test** — writes `flows/<feature-name>.yaml` Maestro flow for CI

### Example: Debugging a screen

```
/rn-dev-agent:debug-screen
```

No need to describe the problem — the agent captures its own evidence:
1. Takes a screenshot
2. Gathers errors, console, network, and component tree in parallel
3. Identifies the error type and narrows down root cause
4. Applies a fix and verifies recovery

## Commands Reference

### `/rn-dev-agent:check-env`

Runs `cdp_status` and reports on:
- **Metro**: Dev server running? Which port?
- **CDP**: Connected to Hermes? Which device/page?
- **App**: Platform, RN version, Hermes enabled, screen dimensions
- **Capabilities**: CDP Network domain available? Fiber tree accessible?
- **Errors**: Active error count, RedBox, debugger paused state

### `/rn-dev-agent:test-feature <description>`

Invokes the `rn-tester` agent with the feature description. The agent discovers changed files via `git diff`, reads the implementation, and runs the 7-step verification protocol. Outputs a pass/fail report and generates a Maestro YAML flow file.

### `/rn-dev-agent:debug-screen`

Invokes the `rn-debugger` agent. Captures parallel evidence from all layers (CDP + native logs), identifies the error type, applies a minimal fix, and verifies recovery.

## MCP Tools Reference

The CDP bridge exposes 10 tools via MCP. These are used by the agents internally, but you can also call them directly in Claude Code:

| Tool | Purpose | Key Parameters |
|------|---------|----------------|
| `cdp_status` | Health check + auto-connect | `metroPort` (optional override) |
| `cdp_component_tree` | React fiber tree with props/state | `filter` (component name or testID), `depth` (1-6, default 3) |
| `cdp_navigation_state` | Current route, stack, tabs | None |
| `cdp_store_state` | Redux/Zustand state | `path` (dot-path, e.g. `"cart.items"`) |
| `cdp_network_log` | Recent HTTP requests | `limit`, `filter` (URL substring), `clear` |
| `cdp_console_log` | Console output buffer | `level` (all/log/warn/error/info/debug), `limit`, `clear` |
| `cdp_error_log` | JS errors + promise rejections | `clear` (reset captured errors) |
| `cdp_evaluate` | Execute arbitrary JS in Hermes | `expression`, `awaitPromise` |
| `cdp_reload` | Full reload with auto-reconnect | `full` (always true) |
| `cdp_dev_settings` | Dev menu actions | `action` (reload/toggleInspector/togglePerfMonitor/dismissRedBox) |

### Direct tool usage examples

```
> Use cdp_status to check if the app is connected
> Use cdp_component_tree with filter "CartBadge" to inspect the cart badge
> Use cdp_store_state with path "auth.user" to check login state
> Use cdp_network_log with filter "/api/products" to see recent API calls
> Use cdp_console_log with level "error" to see error output
```

## Architecture

Three layers working together:

```
┌─────────────────────────────────────────────────────┐
│  Claude Code                                         │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────┐ │
│  │ Skills       │  │ Agents       │  │ Commands   │ │
│  │ (knowledge)  │  │ (protocols)  │  │ (entry pts)│ │
│  └──────┬───┬──┘  └──────┬───────┘  └─────┬──────┘ │
│         │   │            │                 │        │
│  ┌──────▼───▼────────────▼─────────────────▼──────┐ │
│  │              MCP Server (CDP Bridge)            │ │
│  │  WebSocket → Metro → Hermes CDP                 │ │
│  │  10 tools: status, tree, nav, store, network... │ │
│  └─────────────────────┬───────────────────────────┘ │
│                        │                             │
│  ┌─────────────────────▼───────────────────────────┐ │
│  │           Bash (device lifecycle)                │ │
│  │  xcrun simctl / adb / Maestro / screenshots      │ │
│  └──────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────┘
         │                              │
    ┌────▼────┐                   ┌─────▼─────┐
    │ iOS Sim │                   │ Android   │
    │         │                   │ Emulator  │
    └─────────┘                   └───────────┘
```

### How it works

1. **CDP Bridge MCP Server** maintains a WebSocket connection to Metro's CDP endpoint, which proxies to the Hermes JavaScript engine inside your app
2. On connect, it injects ~2KB of helper JS (`globalThis.__RN_AGENT`) that can walk the React fiber tree, read navigation state, capture errors, etc.
3. Events (console, network, errors) are buffered in ring buffers between agent calls since MCP is pull-based
4. **Skills** provide domain knowledge (device commands, testing patterns, debugging strategies)
5. **Agents** define multi-step protocols (7-step tester, diagnostic debugger)
6. **Commands** are user-facing entry points that invoke agents

### Plugin structure

```
rn-dev-agent/
├── .claude-plugin/plugin.json          # Plugin manifest (MCP servers, skills, agents, commands)
├── skills/
│   ├── rn-device-control/SKILL.md      # simctl, adb, screenshots, UI hierarchy
│   ├── rn-testing/SKILL.md             # Maestro patterns, timing, testID usage
│   └── rn-debugging/SKILL.md           # CDP vs bash, error types, troubleshooting
├── agents/
│   ├── rn-tester.md                    # 7-step test verification protocol
│   └── rn-debugger.md                  # Diagnostic evidence-gathering flow
├── commands/
│   ├── test-feature.md                 # /rn-dev-agent:test-feature
│   ├── build-and-test.md               # /rn-dev-agent:build-and-test
│   ├── debug-screen.md                 # /rn-dev-agent:debug-screen
│   └── check-env.md                    # /rn-dev-agent:check-env
├── hooks/hooks.json                    # SessionStart: auto-detect RN projects
├── scripts/
│   ├── cdp-bridge/                     # MCP server (TypeScript)
│   │   ├── src/
│   │   │   ├── index.ts                # Entry + 10 tool registrations
│   │   │   ├── cdp-client.ts           # WebSocket lifecycle, auto-discovery
│   │   │   ├── injected-helpers.ts     # globalThis.__RN_AGENT helpers
│   │   │   ├── ring-buffer.ts          # Event buffering
│   │   │   ├── types.ts               # Shared types + MCP response helpers
│   │   │   └── tools/                  # Individual tool handlers
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── eas_resolve_artifact.sh          # EAS build artifact resolver
│   ├── expo_ensure_running.sh          # App install + Metro start
│   └── snapshot_state.sh               # Screenshot + UI hierarchy capture
├── hooks/
│   ├── hooks.json                      # SessionStart hook config
│   └── detect-rn-project.sh            # Auto-detect RN projects
└── docs/
    ├── ROADMAP.md                      # Implementation phases
    ├── DECISIONS.md                    # Architectural decision records
    └── BUGS.md                         # Known issues
```

## Troubleshooting

### Connection issues

| Problem | Cause | Solution |
|---------|-------|----------|
| "Metro not found" | Dev server not running | Start Metro: `npx expo start` or `npx react-native start` |
| "No Hermes target" | App not loaded or not using Hermes | Open the app on simulator, ensure Hermes is enabled |
| CDP connection rejected (1006) | Another debugger holds the session | Close React Native DevTools, Flipper, or Chrome DevTools |
| "WebSocket closed" during operations | App reloaded while query was in flight | Retry — the server auto-reconnects |

### Tool-specific issues

| Problem | Solution |
|---------|----------|
| `cdp_evaluate` timeout | Check for `debugger;` statements or long sync operations |
| `cdp_component_tree` returns empty | Use a broader `filter` or check that components have rendered |
| `cdp_store_state` returns error for Zustand | Add `global.__ZUSTAND_STORES__` to your app entry |
| Empty error log but app crashed | Error is native — use `adb logcat -b crash` or `xcrun simctl spawn booted log stream --predicate 'logType == error'` |
| `cdp_network_log` shows no requests | On RN < 0.83, network hooks inject automatically on first call |

### Environment issues

| Problem | Solution |
|---------|----------|
| `node dist/index.js` fails | Run `npm run build` in `scripts/cdp-bridge/` |
| Maestro not found | `brew install maestro` |
| Multiple simulators/emulators | The plugin connects to the first booted device. Use `ANDROID_SERIAL` env var for Android targeting |
| Plugin not detected on startup | Ensure you pass `--plugin-dir` pointing to this repo's root |

## Documentation

| Document | Contents |
|----------|----------|
| `docs/ROADMAP.md` | Implementation phases and completion status |
| `docs/DECISIONS.md` | 49 architectural decision records (D1-D49) |
| `docs/BUGS.md` | Known issues and workarounds |
