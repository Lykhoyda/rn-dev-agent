# rn-dev-agent

A Claude Code plugin that lets an AI agent fully test React Native features on iOS Simulator / Android Emulator. The agent navigates the app, verifies UI, walks user flows, and confirms internal state (component tree, store data, network responses, navigation stack).

## Installation

### Prerequisites

- **Node.js >= 18**
- **Xcode + Simulator** (iOS) and/or **Android Studio + Emulator** (Android)
- **Maestro** or **maestro-runner** (recommended — 3x faster):

```bash
# Option A: maestro-runner (recommended, no JVM)
# Download from github.com/devicelab-dev/maestro-runner

# Option B: Maestro (requires Java)
brew install maestro
```

### Install the plugin

```bash
# From local directory
claude --plugin-dir ./rn-dev-agent

# Or from marketplace (when published)
claude plugin install rn-dev-agent
```

### Build the CDP bridge

```bash
cd scripts/cdp-bridge
npm install
npm run build
```

### For Zustand apps

Add one line to your app entry (zero production cost):

```typescript
// app/_layout.tsx or App.tsx
if (__DEV__) {
  global.__ZUSTAND_STORES__ = {
    auth: useAuthStore,
    cart: useCartStore,
  };
}
```

## Usage

### Commands

| Command | Description |
|---------|-------------|
| `/rn-dev-agent:test-feature <description>` | Test a feature on simulator/emulator |
| `/rn-dev-agent:debug-screen` | Debug the current screen state |
| `/rn-dev-agent:check-env` | Verify environment readiness |

### Example

```
> /rn-dev-agent:test-feature "Shopping cart — add items, see badge, checkout"
```

The agent will:
1. Check environment (Metro, simulator, CDP connection)
2. Read your implementation to understand what was built
3. Plan test steps
4. Navigate to the starting screen
5. Execute each step with UI + data verification
6. Test edge cases
7. Generate a persistent Maestro test flow
8. Report pass/fail with evidence

## Architecture

Three layers working together:

| Layer | Tool | Role |
|-------|------|------|
| Device lifecycle | `xcrun simctl` / `adb` | Boot/kill simulators, install apps, screenshots |
| UI interaction | maestro-runner / Maestro | YAML-based tap/swipe/assert |
| App introspection | CDP bridge MCP server | React fiber tree, store state, network, console, errors |

### MCP Tools (10 total)

| Tool | Purpose |
|------|---------|
| `cdp_status` | Health check, auto-connect |
| `cdp_component_tree` | React fiber tree (filtered, depth-limited) |
| `cdp_navigation_state` | Current route/stack |
| `cdp_store_state` | Redux/Zustand state |
| `cdp_network_log` | Recent HTTP requests |
| `cdp_console_log` | Console output |
| `cdp_error_log` | JS errors + promise rejections |
| `cdp_evaluate` | Execute arbitrary JS in Hermes |
| `cdp_reload` | Hot/full reload with reconnect |
| `cdp_dev_settings` | Programmatic dev menu actions |

## Troubleshooting

| Problem | Solution |
|---------|----------|
| "Metro not found" | Start dev server: `npx expo start` or `npx react-native start` |
| "No Hermes target" | Wait for app to finish loading, retry |
| CDP connection rejected (1006) | Close React Native DevTools, Flipper, or Chrome DevTools |
| cdp_evaluate timeout | Check for `debugger;` statements or long sync operations |
| Empty error log but app crashed | Error is native — check `adb logcat -b crash` or `xcrun simctl spawn booted log stream` |

## Documentation

- `docs/ARCHITECTURE.md` — Full architecture, MCP server code, tool definitions, agent prompts
- `docs/RESEARCH.md` — CLI speed benchmarks, tool comparisons, optimization research
- `docs/ROADMAP.md` — Implementation phases and status
- `docs/DECISIONS.md` — Architectural decision records
- `docs/BUGS.md` — Known issues
