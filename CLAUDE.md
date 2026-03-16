# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**rn-dev-agent** — A Claude Code plugin that turns Claude into a React Native development partner. It explores the codebase, designs architecture, implements features, then verifies everything live on the simulator — reading the component tree, store state, and navigation stack through Chrome DevTools Protocol.

The primary workflow is `/rn-dev-agent:rn-feature-dev <description>` — an 8-phase pipeline (discovery, exploration, questions, architecture, implementation, live verification, review, summary) that goes from a feature description to verified code with proof screenshots.

## Commands

```bash
# Build the CDP bridge MCP server (after modifying source)
cd scripts/cdp-bridge && npm install && npm run build

# Run with a React Native project
cd /path/to/your-rn-app
claude --plugin-dir /path/to/rn-dev-agent
```

## Architecture

Three layers working together:

| Layer | Tool | Role |
|-------|------|------|
| Device interaction | agent-device CLI (auto-installed) | Cross-platform native device control: tap, swipe, fill, find, snapshot, screenshot |
| App introspection | Custom MCP server → Hermes CDP via WebSocket | Persistent WebSocket — reads React fiber tree, store state, network, console, errors |
| E2E testing | maestro-runner (preferred) / Maestro (fallback) | YAML-based persistent test files for CI |

Fallback: `xcrun simctl` (iOS) + `adb` (Android) for device lifecycle when agent-device is unavailable.

### Plugin Structure

```
rn-dev-agent/
├── .claude-plugin/plugin.json        # Plugin manifest
├── skills/
│   ├── rn-device-control/            # simctl, adb, screenshots, UI hierarchy
│   │   ├── SKILL.md
│   │   └── references/
│   ├── rn-testing/                   # Maestro patterns, timing rules, testID usage
│   │   ├── SKILL.md
│   │   └── references/
│   └── rn-debugging/                 # CDP vs bash decision table, error types
│       ├── SKILL.md
│       └── references/
├── agents/
│   ├── rn-tester.md                  # 7-step test verification protocol
│   ├── rn-debugger.md                # Diagnostic evidence-gathering flow
│   ├── rn-code-architect.md          # Architecture design with E2E proof flow
│   ├── rn-code-explorer.md           # Codebase exploration and mapping
│   └── rn-code-reviewer.md           # Code review for correctness and conventions
├── commands/
│   ├── rn-feature-dev.md             # Primary: 8-phase feature development workflow
│   ├── test-feature.md               # Test an implemented feature end-to-end
│   ├── build-and-test.md             # Build app, then test
│   ├── debug-screen.md               # Diagnose and fix current screen
│   └── check-env.md                  # Verify environment readiness
├── hooks/
│   ├── hooks.json                    # SessionStart + PostToolUse hook config
│   ├── detect-rn-project.sh          # Auto-detect RN projects + install maestro-runner + agent-device
│   └── post-edit-health-check.sh     # PostToolUse: checks simulator for crashes after source file edits
└── scripts/
    ├── cdp-bridge/                   # MCP server (TypeScript)
    │   ├── src/
    │   │   ├── index.ts              # Entry + 19 tool registrations (11 CDP + 8 device)
    │   │   ├── cdp-client.ts         # WebSocket lifecycle, auto-discovery, reconnect
    │   │   ├── injected-helpers.ts   # globalThis.__RN_AGENT (fiber walker, nav, store, errors)
    │   │   ├── ring-buffer.ts        # Event buffering (console/network/error)
    │   │   ├── types.ts              # Shared types + MCP response helpers
    │   │   ├── utils.ts              # Target validation, retry logic, withSession wrapper
    │   │   ├── symbolicate.ts        # Stack trace symbolication
    │   │   ├── agent-device-wrapper.ts  # agent-device CLI wrapper + session state
    │   │   └── tools/                # Individual tool handlers (11 CDP + 3 device files)
    │   ├── dist/                     # Pre-built JS output
    │   ├── package.json
    │   └── tsconfig.json
    ├── ensure-maestro-runner.sh      # Auto-install maestro-runner on plugin load
    ├── ensure-agent-device.sh        # Auto-install agent-device CLI on plugin load
    ├── expo_ensure_running.sh        # App install + Metro start
    ├── eas_resolve_artifact.sh       # EAS build artifact resolver
    └── snapshot_state.sh             # Concurrent screenshot + UI hierarchy capture
```

### MCP Server (cdp-bridge)

19 tools exposed via MCP in two categories:

**CDP tools** (React internals via Chrome DevTools Protocol over WebSocket):
- `cdp_status` — health check (Metro, CDP, app info, errors, RedBox)
- `cdp_component_tree` — React fiber tree (filtered, depth-limited, RedBox-aware)
- `cdp_navigation_state` — current route/stack (Expo Router + React Navigation)
- `cdp_store_state` — Redux (auto-detect) / Zustand (via global) state
- `cdp_interact` — DEPRECATED: tap/press UI elements by testID (use device_press/device_find instead)
- `cdp_network_log`, `cdp_console_log`, `cdp_error_log` — buffered events via ring buffers
- `cdp_evaluate` — arbitrary JS execution in Hermes (5s timeout)
- `cdp_reload` — full reload with auto-reconnect and target re-validation
- `cdp_dev_settings` — programmatic dev menu actions

**Device tools** (native interaction via agent-device CLI):
- `device_list` — list available simulators/emulators
- `device_screenshot` — capture screen image
- `device_snapshot` — session management + accessibility tree with @refs
- `device_find` — find element by text, optionally tap it
- `device_press` — tap element by @ref from snapshot
- `device_fill` — type text into input by @ref
- `device_swipe` — directional swipe gesture
- `device_back` — system back navigation

### Key Technical Decisions

- Inject helpers ONCE on CDP connect (~2KB JS), then call `__RN_AGENT.getTree()` etc.
- 5-second timeout on ALL CDP calls to prevent hanging promises
- Ring buffers for events (console: 200, network: 100, errors: 50) since MCP is pull-based
- `device_snapshot` or Maestro `assertVisible` before CDP reads to avoid React render race conditions
- agent-device CLI wrapped via `agent-device-wrapper.ts` — all CLI calls isolated to one module for version resilience
- Device session state persisted in-memory + `/tmp/rn-dev-agent-session.json` for cross-process access
- Network fallback for RN < 0.83: inject fetch/XHR monkey-patches if `Network.enable` fails
- Zustand requires 1-line dev setup: `if (__DEV__) global.__ZUSTAND_STORES__ = { ... }`
- Component tree filter is mandatory — full dumps waste 10K+ tokens
- Architect (Opus) designs E2E proof flows during Phase 4; Phase 8 executes mechanically

## Documentation

Local-only (gitignored, not in repo):
- `docs/ROADMAP.md` — Phase-by-phase implementation plan (Phases 1-33)
- `docs/DECISIONS.md` — Architectural decision records (D1-D280)
- `docs/BUGS.md` — Known issues and workarounds

## Conventions

- CDP bridge is TypeScript (Node.js >= 18, LTS versions recommended)
- Skills/agents/commands are Markdown files with YAML frontmatter
- Maestro flows are YAML
- Prefer maestro-runner over Maestro (3x faster, no JVM)
- Prefer JPEG screenshots on iOS, gzipped PNG on Android
- Always filter component tree queries — never dump the full tree
- Use explicit type imports (`import type { ... }`)
- No unnecessary comments in code
