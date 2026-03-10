# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**rn-dev-agent** — A Claude Code plugin that lets an AI agent fully test React Native features after implementation. The agent navigates the app on iOS Simulator / Android Emulator, verifies UI, walks user flows, and confirms internal state (component tree, store data, network responses, navigation stack).

This is a **feature verification pipeline**, not a generic automation tool.

**Status:** Implemented (Phases 1-7 complete, reviewed by Gemini + Codex).

## Architecture

The plugin has three layers working together:

| Layer | Tool | Role |
|-------|------|------|
| Device lifecycle | `xcrun simctl` (iOS) + `adb` (Android) | Boot/kill simulators, install apps, screenshots — all via bash |
| UI interaction | maestro-runner (preferred) / Maestro (fallback) | YAML-based cross-platform tap/swipe/assert — LLM-generatable |
| App introspection | Custom MCP server → Hermes CDP via WebSocket | The only layer needing a persistent process — reads React fiber tree, store state, network, console, errors |

### Plugin Structure

```
rn-dev-agent/
├── .claude-plugin/plugin.json        # Plugin manifest
├── skills/                           # Knowledge docs for Claude
│   ├── rn-device-control/SKILL.md    # simctl, adb, screenshots, UI hierarchy
│   ├── rn-testing/SKILL.md           # Maestro patterns, timing rules, testID usage
│   └── rn-debugging/SKILL.md         # CDP vs bash decision table, error types
├── agents/
│   ├── rn-tester.md                  # 7-step test protocol
│   └── rn-debugger.md                # Diagnostic flow
├── commands/                         # User-facing slash commands
│   ├── test-feature.md
│   ├── build-and-test.md
│   ├── debug-screen.md
│   └── check-env.md
├── hooks/hooks.json                  # SessionStart: detect RN project
└── scripts/
    ├── cdp-bridge/                   # MCP server (~400 lines TypeScript)
    │   ├── src/index.ts              # Entry + 10 tool definitions
    │   ├── src/cdp-client.ts         # WebSocket lifecycle, auto-discovery, reconnect
    │   ├── src/injected-helpers.ts   # globalThis.__RN_AGENT (fiber walker, nav, store, errors)
    │   └── src/ring-buffer.ts        # Buffered events (console/network/error)
    └── snapshot_state.sh             # Concurrent screenshot + UI hierarchy capture
```

### MCP Server (cdp-bridge)

10 tools exposed via MCP, all communicating with the React Native app through Chrome DevTools Protocol over WebSocket to Metro/Hermes:

- `cdp_status` — health check (Metro, CDP, app info, errors, RedBox)
- `cdp_component_tree` — React fiber tree (filtered, depth-limited, RedBox-aware)
- `cdp_navigation_state` — current route/stack (Expo Router + React Navigation)
- `cdp_store_state` — Redux (auto-detect) / Zustand (via global) state
- `cdp_network_log`, `cdp_console_log`, `cdp_error_log` — buffered events via ring buffers
- `cdp_evaluate` — arbitrary JS execution in Hermes (5s timeout)
- `cdp_reload` — hot/full reload with auto-reconnect
- `cdp_dev_settings` — programmatic dev menu actions

### Key Technical Decisions

- Inject helpers ONCE on CDP connect (~2KB JS), then call `__RN_AGENT.getTree()` etc.
- 5-second timeout on ALL CDP calls to prevent hanging promises
- Ring buffers for events (console: 200, network: 100, errors: 50) since MCP is pull-based
- Maestro `assertVisible` before CDP reads to avoid React render race conditions
- Network fallback for RN < 0.83: inject fetch/XHR monkey-patches if `Network.enable` fails
- Zustand requires 1-line dev setup: `if (__DEV__) global.__ZUSTAND_STORES__ = { ... }`
- Component tree filter is mandatory — full dumps waste 10K+ tokens

## Implementation Phases

See `docs/ROADMAP.md` for detailed phase breakdown (Phases 1-6). Build order:
1. CDP Bridge Foundation (connect, evaluate, reload)
2. Injected Helpers (component tree, navigation, errors)
3. Data Layer (network, console, store, ring buffers)
4. Skills (device control, testing, debugging docs)
5. Agents + Commands (tester protocol, debugger flow, slash commands)
6. Polish + Speed (hooks, snapshot script, reconnect hardening)

## Documentation

- `docs/ARCHITECTURE.md` — Complete architecture with full MCP server code, tool definitions, agent prompts, skill content, edge cases
- `docs/RESEARCH.md` — CLI speed benchmarks, maestro-runner vs Maestro, screenshot optimization, UI hierarchy extraction
- `docs/ROADMAP.md` — Phase-by-phase implementation plan with deliverables

## Conventions

- CDP bridge is TypeScript (Node.js >= 18)
- Skills/agents/commands are Markdown files
- Maestro flows are YAML
- Prefer maestro-runner over Maestro (3x faster, no JVM)
- Prefer JPEG screenshots on iOS, gzipped PNG on Android
- Always filter component tree queries — never dump the full tree
