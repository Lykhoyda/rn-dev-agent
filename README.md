# rn-dev-agent

A Claude Code plugin that turns Claude into a React Native development partner. It explores your codebase, designs architecture, implements features, then **verifies everything live on the simulator** — reading the component tree, store state, and navigation stack through Chrome DevTools Protocol.

## Quick Start

```bash
# Add the marketplace and install the plugin
claude mcp add-marketplace Lykhoyda/react-native-dev-claude-plugin
claude plugin install rn-dev-agent

# Navigate to your React Native project
cd /path/to/your-rn-app

# Start Claude Code
claude
```

On startup the plugin auto-detects your React Native project and installs [maestro-runner](https://github.com/devicelab-dev/maestro-runner) for UI interactions.

Then tell Claude what to build:

```
/rn-dev-agent:rn-feature-dev add a shopping cart with badge, item list, and checkout flow
```

That's it. Claude handles the rest.

## How It Works: `/rn-feature-dev`

This is the primary command. It runs an 8-phase development workflow that goes from a feature description to verified, reviewed code with proof screenshots.

| Phase | What happens |
|-------|-------------|
| 1. Discovery | Understand the feature request, create a task plan |
| 2. Exploration | Launch parallel agents to map screens, store, navigation, and conventions |
| 3. Questions | Ask clarifying questions about edge cases, error states, and data flow |
| 4. Architecture | Design the implementation with an Opus-powered architect agent, including E2E proof steps |
| 5. Implementation | Build the feature following the blueprint — store, components, navigation, testIDs |
| 5.5. Verification | Prove it works live: CDP health check, component tree, store state, interaction test, screenshot |
| 6. Review | Launch parallel review agents for correctness, RN conventions, and project patterns |
| 7. Summary | Document what was built, decisions made, files changed, and verification results |

Each phase gates on the previous one. Claude asks for your approval before implementing and before applying review fixes.

### What makes this different

- **Live verification** — After implementation, Claude connects to your running app via CDP, navigates to the feature screen, checks the component tree, exercises interactions, and confirms store state matches expectations. No "trust me it works."
- **Architect-designed proof flows** — The architect agent (Opus) designs the exact E2E verification steps during Phase 4, including which testIDs to check, which CDP expressions to run, and which screenshots to take. Phase 5.5 executes this plan mechanically.
- **Parallel exploration** — Phase 2 launches multiple explorer agents simultaneously to map different aspects of your codebase, so Claude understands your patterns before writing a single line.

### Example session

```
> /rn-dev-agent:rn-feature-dev add task priority levels (high/medium/low) with color coding and sort

Phase 1: I understand you want priority levels on tasks. Creating task plan...

Phase 2: Launching 3 explorer agents...
  - Explorer 1: Found TasksScreen, tasksSlice, 12 testIDs
  - Explorer 2: Found Redux Toolkit pattern, createSelector usage
  - Explorer 3: Found NativeWind styling, chip-based filter pattern

Phase 3: Before I design this, a few questions:
  1. Should priority be required or optional (default medium)?
  2. What colors? Red/yellow/green or match your existing theme?
  3. Sort by priority — should it be a toggle or replace the existing sort?

> default medium, use theme colors, toggle alongside existing sort

Phase 4: Here's the architecture...
  - Extend tasksSlice with priority field + PRIORITY_WEIGHT map
  - Add PriorityChip component with cycle-on-press
  - Composed selector: selectSortedFilteredTasks
  Proceed with implementation?

> yes

Phase 5: Implementing... [creates/modifies 4 files]

Phase 5.5: Verifying live on simulator...
  | Check | Result |
  |-------|--------|
  | Navigation | PASS — on Tasks screen |
  | Health | PASS — no errors |
  | Component tree | PASS — PriorityChip found with priority="medium" |
  | Interaction | PASS — priority cycled to "high", store confirmed |
  | Screenshot | PASS — saved to docs/proof/ |

Phase 6: Review agents found 2 issues (both fixed)...

Phase 7: Done. 4 files modified, 3 decisions logged.
```

## Other Commands

These are useful on their own or alongside `rn-feature-dev`:

| Command | When to use |
|---------|-------------|
| `/rn-dev-agent:test-feature <desc>` | Test an already-implemented feature end-to-end |
| `/rn-dev-agent:build-and-test <desc>` | Build the app first (if not installed), then test |
| `/rn-dev-agent:debug-screen` | Diagnose a broken screen — gathers evidence and applies a fix |
| `/rn-dev-agent:check-env` | Verify Metro, CDP, and simulator are ready |

## Requirements

| Requirement | Notes |
|-------------|-------|
| Node.js >= 18 | For the CDP bridge MCP server |
| Claude Code CLI | `npm install -g @anthropic-ai/claude-code` |
| iOS Simulator or Android Emulator | At least one platform |
| Metro dev server running | `npx expo start` or `npx react-native start` |

**maestro-runner** is auto-installed on first plugin load. It enables real UI interactions (tap, type, swipe) beyond what CDP can do alone.

## Setup for Your App

### No setup needed for most apps

The plugin connects to your running app via Metro's CDP endpoint and reads the React fiber tree directly.

### Zustand stores (one line)

```typescript
// App.tsx or app/_layout.tsx
if (__DEV__) {
  global.__ZUSTAND_STORES__ = {
    auth: useAuthStore,
    cart: useCartStore,
  };
}
```

Zero production cost — stripped in release builds.

### Redux

Auto-detected. No setup needed.

### testIDs

Add `testID` to interactive elements for reliable component queries:

```tsx
<TouchableOpacity testID="checkout-button" onPress={handleCheckout}>
  <Text testID="cart-badge">{itemCount}</Text>
</TouchableOpacity>
```

## Architecture

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
│  │  xcrun simctl / adb / maestro-runner / screenshots│ │
│  └──────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────┘
         │                              │
    ┌────▼────┐                   ┌─────▼─────┐
    │ iOS Sim │                   │ Android   │
    │         │                   │ Emulator  │
    └─────────┘                   └───────────┘
```

### CDP Bridge MCP Tools

10 tools available to agents and directly in Claude Code:

| Tool | Purpose |
|------|---------|
| `cdp_status` | Health check + auto-connect |
| `cdp_component_tree` | React fiber tree (filtered by component name or testID) |
| `cdp_navigation_state` | Current route, stack, tabs |
| `cdp_store_state` | Redux/Zustand state at a dot-path |
| `cdp_network_log` | Recent HTTP requests |
| `cdp_console_log` | Console output buffer |
| `cdp_error_log` | JS errors + promise rejections |
| `cdp_evaluate` | Execute JS in Hermes |
| `cdp_reload` | Full reload with auto-reconnect |
| `cdp_dev_settings` | Dev menu actions |

## Troubleshooting

| Problem | Solution |
|---------|----------|
| "Metro not found" | Start Metro: `npx expo start` or `npx react-native start` |
| "No Hermes target" | Open the app on simulator, ensure Hermes is enabled |
| CDP connection rejected (1006) | Close React Native DevTools, Flipper, or Chrome DevTools |
| `cdp_store_state` error for Zustand | Add `global.__ZUSTAND_STORES__` to your app entry |
| Empty error log but app crashed | Native crash — use `adb logcat -b crash` or Xcode console |
| Plugin not detected | Pass `--plugin-dir` pointing to this repo, or install via marketplace |
| maestro-runner not in PATH | `export PATH="$HOME/.maestro-runner/bin:$PATH"` |

## Install from Source

```bash
git clone https://github.com/Lykhoyda/react-native-dev-claude-plugin.git
cd react-native-dev-claude-plugin
cd scripts/cdp-bridge && npm install && npm run build && cd ../..

# Then use with any RN project
cd /path/to/your-rn-app
claude --plugin-dir /path/to/react-native-dev-claude-plugin
```
