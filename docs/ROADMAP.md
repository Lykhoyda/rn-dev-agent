# rn-dev-agent — Final Architecture & Roadmap

## What We're Building

A **Claude Code plugin** that lets an AI agent fully test React Native features after implementation. The agent navigates the app on iOS Simulator / Android Emulator, verifies UI renders correctly, walks through user flows, and confirms internal state (component props, store data, network responses, navigation stack) matches expectations.

**Not** a generic automation tool. A **feature verification pipeline**.

---

## Architecture Decision Record

These decisions are final — validated through research, Gemini's critical review, and the CLI tool deep-dive.

### What we're using

| Layer | Tool | Why |
|-------|------|-----|
| **Device lifecycle** | `xcrun simctl` (iOS) + `adb` (Android) | Built-in, zero deps, via bash |
| **UI interaction** | maestro-runner (preferred) / Maestro (fallback) | YAML trivially LLM-generatable, cross-platform |
| **App introspection** | Custom MCP server → Hermes CDP via Metro | The ONE thing bash can't do (persistent WebSocket) |
| **Screenshots** | JPEG (iOS) / gzipped PNG (Android) via bash | 2x faster than PNG, good enough for AI |
| **Screen state reading** | `uiautomator dump` (Android) / CDP fiber tree (iOS) | 10x fewer tokens than screenshot |
| **Error capture** | CDP error hooks + `adb logcat` / `simctl log` | JS errors via CDP, native crashes via bash |
| **Test execution** | maestro-runner (Go, no JVM, 3x faster) | Eliminates 2-4s JVM cold start per invocation |

### What we're NOT using (and why)

| Tool | Why not |
|------|---------|
| **Facebook idb** | Python + pip + companion daemon = too much setup friction |
| **Appium** | Too heavy, latency overhead, black-box (no RN sync) |
| **Flipper** | Deprecated for debugging in RN 0.76+ |
| **mobile-mcp** | Good for screenshots/taps but we already have bash + Maestro |
| **Custom wrapper scripts** | Maestro IS the semantic navigation layer |
| **Detox** | Great for JS tests but not AI-agent-friendly (JS files, not YAML) |

### Key Technical Decisions

| Decision | Rationale |
|----------|-----------|
| Inject helpers ONCE on CDP connect | ~2KB JS injected once via `Runtime.evaluate`, then call `__RN_AGENT.getTree()` — small payloads per call |
| 5-second timeout on ALL CDP calls | Prevents the "hanging CDP promise" trap (Gemini review) |
| Differentiate WS close 1001 vs 1006 | 1001 = reload (auto-reconnect), 1006 = crash or session conflict (stop, report) |
| Auto-resume `Debugger.paused` | Prevents silent JS thread freeze from `debugger;` statements |
| RedBox detection before tree return | Check fiber root for LogBox/ErrorWindow, return warning not error overlay tree |
| Ring buffers for events | Console (200), network (100), errors (50) — MCP is pull-based, events fire while agent thinks |
| Maestro `assertVisible` before CDP | Prevents race condition — React render cycle needs time after tap |
| Network fallback for RN < 0.83 | Try `Network.enable`, if fails → inject fetch/XHR monkey-patches |
| Zustand: require 1-line dev setup | `if (__DEV__) global.__ZUSTAND_STORES__ = { ... }` — can't detect via fiber walk |
| Filter mandatory on component tree | Full dumps waste 10K+ tokens — always scope to specific component/testID |

---

## Plugin Structure (Final)

```
rn-dev-agent/
├── .claude-plugin/
│   └── plugin.json                    # Plugin manifest
├── skills/
│   ├── rn-device-control/
│   │   └── SKILL.md                   # simctl, adb, deep links, device settings,
│   │                                  # language, permissions, JPEG screenshots,
│   │                                  # uiautomator dump, disable animations
│   ├── rn-testing/
│   │   └── SKILL.md                   # maestro-runner/Maestro patterns, testID usage,
│   │                                  # timing rules (assertVisible before CDP),
│   │                                  # multi-device, network mocking, Zustand setup,
│   │                                  # accessibility testing, fast test pattern
│   └── rn-debugging/
│       └── SKILL.md                   # CDP vs bash decision table, error types,
│                                      # native crash investigation, connection
│                                      # troubleshooting, post-reload readiness
├── agents/
│   ├── rn-tester.md                   # 7-step test protocol: env check → understand →
│   │                                  # plan → navigate → interact+verify → edge cases →
│   │                                  # generate persistent test → report
│   └── rn-debugger.md                 # Diagnose flow: screenshot → gather (tree, logs,
│                                      # network, store) → narrow down → fix → verify
├── commands/
│   ├── test-feature.md                # /rn-dev-agent:test-feature <description>
│   ├── debug-screen.md                # /rn-dev-agent:debug-screen
│   └── check-env.md                   # /rn-dev-agent:check-env
├── hooks/
│   └── hooks.json                     # SessionStart: detect RN project, hint user
├── .mcp.json                          # CDP bridge MCP server config
└── scripts/
    ├── cdp-bridge/                    # MCP server (~400 lines TypeScript)
    │   ├── package.json
    │   ├── tsconfig.json
    │   └── src/
    │       ├── index.ts               # MCP server entry + 11 tool definitions
    │       ├── cdp-client.ts          # WebSocket: auto-discovery, IPv6 normalization,
    │       │                          # zombie target filtering, retry, reconnect,
    │       │                          # Debugger.paused handling, timeout wrapper
    │       ├── injected-helpers.ts    # globalThis.__RN_AGENT: getTree, getNavState,
    │       │                          # getStoreState, getErrors, clearErrors, isReady,
    │       │                          # getAppInfo — injected ONCE on connect
    │       └── ring-buffer.ts         # Generic ring buffer for console/network/error events
    └── snapshot_state.sh              # Concurrent screenshot + UI hierarchy capture
```

---

## MCP Tools (11 total)

| Tool | Purpose | Source |
|------|---------|--------|
| `cdp_status` | One-call health check: Metro, CDP, app info, errors, RedBox, paused state. Auto-connects. | CDP + evaluate |
| `cdp_component_tree` | React fiber tree with props, state, testIDs. Filtered, depth-limited, RedBox-aware. | Injected helper |
| `cdp_navigation_state` | Current route, params, stack, tabs. Expo Router + React Navigation. | Injected helper |
| `cdp_store_state` | Redux (auto-detect via fiber) / Zustand (via global) state at dot-path. | Injected helper |
| `cdp_network_log` | Recent requests: method, URL, status, timing. CDP Network or fetch hook fallback. | CDP events + ring buffer |
| `cdp_console_log` | Recent console output. Buffered between agent calls. | CDP events + ring buffer |
| `cdp_error_log` | Unhandled JS errors + promise rejections. | Injected helper |
| `cdp_evaluate` | Execute arbitrary JS in Hermes. 5s timeout. Use sparingly. | CDP Runtime.evaluate |
| `cdp_reload` | Hot reload or full reload. Auto-reconnects on new Hermes target. | CDP + Metro WS |
| `cdp_dev_settings` | Programmatic reload, toggle inspector, dismiss RedBox. No visual dev menu. | CDP evaluate |

---

## The Core Testing Loop

```
For each step in the user flow:

1. ACT     → maestro-runner test /tmp/step.yaml     (bash, ~300ms)
2. SETTLE  → Maestro assertVisible confirms UI done  (built into flow)
3. SNAP    → snapshot_state.sh [platform]            (bash, ~200ms concurrent)
4. INSPECT → cdp_component_tree(filter="CartBadge")  (MCP, ~400ms)
5. VERIFY  → cdp_store_state("cart.items")           (MCP, ~200ms)
6. DECIDE  → pass → next step / fail → investigate

Total per step: ~1.4 seconds (down from ~3.1s in naive approach)
```

---

## Roadmap

### Phase 1: CDP Bridge Foundation ✅
**Deliverables:**
- [x] `scripts/cdp-bridge/` — MCP server with `cdp_status`, `cdp_evaluate`, `cdp_reload`
- [x] Auto-discovery: scan ports 8081/8082/19000/19006, filter Hermes targets, normalize IPv6
- [x] Connection lifecycle: retry, timeout wrapper (5s), WS close code handling
- [x] `Debugger.enable` + auto-resume on `Debugger.paused`
- [x] `.mcp.json` config

### Phase 2: Injected Helpers ✅
**Deliverables:**
- [x] `injected-helpers.ts` — full `globalThis.__RN_AGENT` object
- [x] `cdp_component_tree` — fiber walker with filter, depth limit, WeakSet, RedBox detection, 50KB cap, text node capture
- [x] `cdp_navigation_state` — Expo Router + React Navigation + fiber walk fallback
- [x] `cdp_error_log` — ErrorUtils hook + Hermes promise rejection tracker + clear option

### Phase 3: Data Layer ✅
**Deliverables:**
- [x] `cdp_network_log` — CDP Network domain (RN 0.83+) + fetch/XHR hook fallback
- [x] `cdp_console_log` — Runtime.consoleAPICalled + ring buffer
- [x] `cdp_store_state` — Redux (fiber walk for Provider) + Zustand (global.__ZUSTAND_STORES__)
- [x] `ring-buffer.ts` — shared event buffer implementation
- [x] `cdp_dev_settings` — programmatic reload, toggle inspector, dismiss RedBox

### Phase 4: Skills ✅
**Deliverables:**
- [x] `skills/rn-device-control/SKILL.md` — full simctl + adb reference, JPEG screenshots, UI hierarchy dump, device settings, language changes, animation disable
- [x] `skills/rn-testing/SKILL.md` — maestro-runner patterns, timing rules, fast test pattern, testID best practices, Zustand setup, network mocking, multi-device
- [x] `skills/rn-debugging/SKILL.md` — CDP vs bash decision table, error types matrix, connection troubleshooting, post-reload readiness

### Phase 5: Agents + Commands ✅
**Deliverables:**
- [x] `agents/rn-tester.md` — 7-step protocol, scoped tree queries, timing rules, native error fallback
- [x] `agents/rn-debugger.md` — diagnostic flow, parallel data gathering, fix-verify cycle
- [x] `commands/test-feature.md` — `/rn-dev-agent:test-feature <description>`
- [x] `commands/debug-screen.md` — `/rn-dev-agent:debug-screen`
- [x] `commands/check-env.md` — `/rn-dev-agent:check-env`
- [x] `plugin.json`

### Phase 6: Polish + Speed ✅
**Deliverables:**
- [x] `hooks/hooks.json` — SessionStart RN project detection
- [x] `scripts/snapshot_state.sh` — concurrent screenshot + UI hierarchy
- [x] maestro-runner auto-detection in skills (prefer over Maestro)
- [x] Zombie target filtering (pick highest page ID)
- [x] Reconnect hardening: reject pending on WS close, catch reload errors
- [x] README.md with installation + usage guide

### Gemini Review Fixes Applied ✅
- [x] Fixed port override leak in cdp_status (Critical)
- [x] Added text node capture in fiber tree walker (Critical)
- [x] Fixed pending promises on WS close + reload error handling (Critical)
- [x] Fixed filter-before-limit on console/network logs (High)
- [x] Added clear option to cdp_error_log (High)
- [x] Added accessibilityLabel extraction in fiber tree (Medium)
- [x] Used 127.0.0.1 instead of localhost for Node 18+ DNS (Medium)

---

## After MVP: Future Improvements

| Feature | Impact | Effort |
|---------|--------|--------|
| Visual regression (screenshot diff before/after) | Medium | 2 days |
| Auto-detect app's bundleId from project config | Quality of life | 0.5 day |
| Parallel iOS + Android testing | Double coverage | 1 day |
| Network mocking via CDP (inject mock responses) | Test isolation | 2 days |
| Performance profiling (Hermes sampling profiler) | Deep debugging | 3 days |
| CI mode (run as headless test suite) | Team workflow | 2 days |
| Expo MCP Server integration (use their local capabilities when available) | Ecosystem | 1 day |

---

## Prerequisites for End Users

```bash
# Required
brew install maestro                     # or download maestro-runner binary
# + Xcode with Simulator (iOS)
# + Android Studio with Emulator (Android)
# + Node.js >= 18

# Install plugin
claude plugin install rn-dev-agent       # from marketplace
# or
claude --plugin-dir ./rn-dev-agent       # local dev

# For Zustand apps: add one line to app entry
# if (__DEV__) global.__ZUSTAND_STORES__ = { auth, cart, settings };
```

---

## Source Documents

| Document | Contains |
|----------|----------|
| `rn-dev-agent-v2-architecture.md` | Complete architecture: plugin structure, full MCP server code (cdp-client.ts, injected-helpers.ts), all 11 tool definitions, agent prompts, skill content, edge case handling |
| `rn-dev-agent-cli-research.md` | CLI speed research: screenshot benchmarks, maestro-runner vs Maestro, idb vs simctl analysis, uiautomator dump, snapshot_state.sh script, animation disabling, optimized testing loop timing |

Both are in the project files and serve as the implementation reference.