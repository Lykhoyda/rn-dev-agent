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

## MCP Tools (10 current, 14 after Phase 9)

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

### Phase 1: CDP Bridge Foundation ✅ (redone 2026-03-10)
**Deliverables:**
- [x] `scripts/cdp-bridge/` — MCP server with `cdp_status`, `cdp_evaluate`, `cdp_reload`
- [x] Auto-discovery: scan ports 8081/8082/19000/19006, filter Hermes targets, normalize IPv6
- [x] Connection lifecycle: retry, timeout wrapper (5s), WS close code handling
- [x] `Debugger.enable` + auto-resume on `Debugger.paused`
- [x] `.mcp.json` config
- [x] `utils.ts` — `withConnection()` wrapper, `textResult`/`errorResult` (D50-D51)
- [x] CRITICAL fix: `msg.result` unpacking in handleMessage (D52)
- [x] Batched status probes — single evaluate call with per-probe try/catch (D53)
- [x] B2 fix: REACT_READY_TIMEOUT_MS 8s → 30s (D54)
- [x] `/json/list` timeout, target URL filter, stale connectedTarget cleanup (D56-D58)
- [x] Gemini review: 4 HIGH, 2 MEDIUM, 2 LOW — all fixed

### Phase 2: Injected Helpers ✅ (redone 2026-03-10)
**Deliverables:**
- [x] `injected-helpers.ts` — full `globalThis.__RN_AGENT` object (included in Phase 1)
- [x] `cdp_component_tree` — fiber walker with filter, depth limit, WeakSet, RedBox detection, 50KB cap, text node capture
- [x] `cdp_navigation_state` — Expo Router + React Navigation + fiber walk fallback
- [x] `cdp_error_log` — ErrorUtils hook + Hermes promise rejection tracker + clear option
- [x] Fiber walks refactored: while-loop siblings, recurse only on children (D63)
- [x] Prop stringification uses shallow summaries for objects/arrays (D64)
- [x] Nav state uses safeStringify for circular-reference safety (D65)
- [x] safeStringify handles getter exceptions gracefully (D66)
- [x] Network hook handles synchronous fetch exceptions (D67)
- [x] Gemini review: 1 HIGH, 4 MEDIUM, 2 LOW — all fixed

### Phase 3: Data Layer ✅ (redone 2026-03-10)
**Deliverables:**
- [x] `cdp_network_log` — CDP Network domain (RN 0.83+) + fetch/XHR hook fallback
- [x] `cdp_console_log` — Runtime.consoleAPICalled + ring buffer
- [x] `cdp_store_state` — Redux (fiber walk for Provider) + Zustand (global.__ZUSTAND_STORES__)
- [x] `ring-buffer.ts` — shared event buffer implementation (included in Phase 1)
- [x] `cdp_dev_settings` — programmatic reload, toggle inspector, dismiss RedBox
- [x] Defensive nullish defaults for limit params (D68)
- [x] Network.loadingFailed handler for failed requests (D69)
- [x] Console log correctly stringifies null values (D70)
- [x] autoConnect guards against concurrent reconnection (D71)
- [x] Gemini review: 2 HIGH, 3 MEDIUM, 1 LOW — all actionable fixed

### Phase 4: Skills ✅ (redone 2026-03-10)
**Deliverables:**
- [x] `skills/rn-device-control/SKILL.md` — full simctl + adb reference, JPEG screenshots, UI hierarchy dump, device settings, language changes, animation disable
- [x] `skills/rn-testing/SKILL.md` — maestro-runner patterns, timing rules, fast test pattern, testID best practices, Zustand setup, network mocking, multi-device
- [x] `skills/rn-debugging/SKILL.md` — CDP vs bash decision table, error types matrix, connection troubleshooting, post-reload readiness
- [x] Pre-review fixes: uiautomator dump file-based approach, snapshot script reference, timeout 30s, iOS log predicate
- [x] Gemini review: 2 HIGH, 2 MEDIUM, 2 LOW — all fixed (D72-D77)
  - Removed misleading gzip screenshot command (PNG already deflate-compressed)
  - Network mock handles Request objects, URL instances, sets Content-Type
  - iOS log predicate uses ENDSWITH for binary name precision
  - Zustand docs clarify .getState() is called at query time
  - Added cdp_dev_settings to debugging decision table
  - Android pidof without -s flag, with ps fallback for compatibility

### Phase 5: Agents + Commands ✅ (redone 2026-03-10)
**Deliverables:**
- [x] `agents/rn-tester.md` — 7-step protocol, scoped tree queries, timing rules, native error fallback
- [x] `agents/rn-debugger.md` — diagnostic flow, parallel data gathering, fix-verify cycle
- [x] `commands/test-feature.md` — `/rn-dev-agent:test-feature <description>`
- [x] `commands/debug-screen.md` — `/rn-dev-agent:debug-screen`
- [x] `commands/check-env.md` — `/rn-dev-agent:check-env`
- [x] `plugin.json`
- [x] Pre-review fixes: updated native log commands in both agents to match Phase 4 skill updates
- [x] Gemini review: 1 HIGH, 2 MEDIUM, 2 LOW — all fixed (D78-D80)
  - Debugger agent now has Step 0 for bundle ID/binary name discovery
  - Maestro templates use placeholders with substitution instructions
  - Android logcat command consistent across both agents (pidof fallback)

### Phase 6: Polish + Speed ✅ (redone 2026-03-10)
**Deliverables:**
- [x] `hooks/hooks.json` — SessionStart RN project detection (detects metro.config, app.json, app.config.js/ts)
- [x] `scripts/snapshot_state.sh` — concurrent screenshot + UI hierarchy (dump-to-file fix, trap cleanup, exit code handling)
- [x] `plugin.json` updated with hooks reference
- [x] Zombie target filtering (pick highest page ID) — implemented in Phase 1 cdp-client.ts
- [x] Reconnect hardening: reject pending on WS close, catch reload errors — implemented in Phase 1 cdp-client.ts
- [x] Gemini review: 3 HIGH, 2 MEDIUM, 2 LOW — all actionable fixed (D81-D86)
  - Hook checks package.json for react-native/expo dependencies (prevents false positives)
  - Snapshot subshell tolerates uiautomator dump failures with || true
  - MCP config uses ${CLAUDE_PLUGIN_ROOT} for path resolution
  - PID-suffixed temp file prevents concurrent snapshot race conditions
  - Marketplace JSON uses type instead of source for source kind
  - Auto-selects first Android device when multiple connected
- [ ] maestro-runner auto-detection in skills (prefer over Maestro) — deferred to post-MVP
- [ ] README.md update with installation + usage guide — deferred to post-MVP

### Phase 7: Expo/EAS Build Integration ✅ (2026-03-10)
**Deliverables:**
- [x] `scripts/eas_resolve_artifact.sh` — three-tier EAS artifact resolver (cache → EAS servers → manual)
  - JSON stdout contract on all exit paths
  - Profile auto-selection: filter by `ios.simulator:true` / `android.buildType:"apk"`
  - Ambiguous profile handling (exit 2 with profile list)
  - jq primary with Node.js fallback for eas.json parsing
- [x] `scripts/expo_ensure_running.sh` — device lifecycle manager
  - Three modes: no artifact (local dev build), .tar.gz (iOS EAS), .apk (Android EAS)
  - Metro auto-start with port detection (8081/8082/19000/19006)
  - Bundle ID auto-resolution from app.json
  - Multi-device handling for Android
- [x] `commands/build-and-test.md` — `/rn-dev-agent:build-and-test <description>` slash command
  - Supports `--eas [profile]` flag for EAS builds
  - Delegates to `rn-tester` agent with build pre-flight
- [x] `agents/rn-tester.md` updated — Step 0 extended with build pre-flight
  - EAS artifact resolution with exit code handling
  - Local dev build fallback
  - Skip build if already connected
- [x] `agents/rn-debugger.md` updated — Step 0 with app install instructions
- [x] `skills/rn-device-control/SKILL.md` updated — Expo/EAS Build Integration section
  - Decision table (when to build vs skip)
  - Script references with exit codes and JSON output shapes
  - Combined workflow examples
- [x] `hooks/detect-rn-project.sh` updated — build-and-test in command hints
- [x] `plugin.json` updated — build-and-test.md in commands array
- [x] Gemini review: 4 HIGH, 2 MEDIUM, 2 LOW — all fixed (D87-D95)
  - grep -c fallback with || true (prevents set -e abort)
  - select_profile writes to global PROFILE (JSON stdout preserved)
  - Removed macOS-incompatible timeout command
  - Removed head -1 that corrupted multi-line JSON
  - BSD find -maxdepth before -name
  - Agent script invocation captures exit code without aborting
  - EAS CLI stderr routed to log file
  - Cache sorting uses ls -t for chronological order
- [x] Gemini+Codex review round 2: 3 HIGH, 2 MEDIUM — all fixed (D96-D100)
  - Cache sorting uses find -exec stat (xargs runs ls on CWD when empty)
  - Agent logcat/log commands use non-blocking -d / log show forms
  - Empty APP_PID guard before logcat --pid
  - Operator precedence fix in bundle ID resolution
  - Agent JSON parsing falls back to node when jq unavailable
  - Removed overly broad cache fallback (wrong project artifact risk)
  - JSON helpers escape special characters (quotes, backslashes, newlines)
  - Launch failure emits warning instead of silent swallow
  - Debugger agent includes EAS build path in Step 0

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

## Phase 8: Security Hardening (2026-03-10)

**Status: Complete**

Codex security review identified 4 High + 4 Medium severity findings. All 4 High-severity findings addressed:

| Finding | Fix | File(s) |
|---------|-----|---------|
| Unrestricted `cdp_evaluate` | Added CAUTION warning to tool description | `index.ts` |
| CDP auto-discovery trusts any loopback service | Same-host (127.0.0.1/localhost) URL enforcement | `cdp-client.ts` |
| Tar archive path traversal | Pre-extract scan + post-extract symlink check | `expo_ensure_running.sh` |
| WebSocket no timeout/validation | `handshakeTimeout`, `maxPayload`, message shape guard | `cdp-client.ts` |

Additional shell hardening:
- BUNDLE_ID regex validation (hard-fail on unsafe chars)
- PROFILE regex validation (reject path separators)
- `mktemp -d` + EXIT trap replaces hardcoded `/tmp` paths
- EAS build-info temp files scoped to `${OUTPUT_DIR}`

Plugin manifests also corrected to match Claude Code schema (D112).

---

## Phase 9: expo-mcp Patterns Port (2026-03-11)

**Status: Spec & Plan Complete — Implementation Pending**

Porting proven patterns from [expo/expo-mcp](https://github.com/expo/expo-mcp) into the plugin:

| Capability | Tools | Status |
|-----------|-------|--------|
| Native device automation (XCTest iOS + ADB Android) | `automation_tap`, `automation_find`, `automation_screenshot` | Planned |
| Multi-source log collection with factory pattern | `collect_logs` | Planned |
| Image optimization pipeline (jimp-compact, 700KB target) | Internal utility | Planned |

Design spec: `docs/superpowers/specs/2026-03-10-expo-mcp-patterns-port-design.md`
Implementation plan: `docs/superpowers/plans/2026-03-10-expo-mcp-patterns-port.md`

Codex review completed and all issues fixed in spec/plan (D113-D124).

---

## Phase 10: E2E Testing Setup ✅ (2026-03-11)

**Status: Complete**

Purpose-built Expo test app + Node.js test harness to validate all 10 MCP tools against a real app on iOS Simulator.

| Component | Description | Status |
|-----------|-------------|--------|
| Test app (8 screens) | Expo 52, React Navigation 6, Redux Toolkit, NativeWind, MSW 2.x | Complete |
| Test harness (10 suites) | Node.js script, MCP SDK client, one suite per tool | Complete |

Design spec: `docs/superpowers/specs/2026-03-11-testing-setup-design.md`
Implementation plan: `docs/superpowers/plans/2026-03-11-e2e-testing-setup.md`

Decisions: D130-D141.

---

## Source Documents

| Document | Contains |
|----------|----------|
| `rn-dev-agent-v2-architecture.md` | Complete architecture: plugin structure, full MCP server code (cdp-client.ts, injected-helpers.ts), all 10 tool definitions, agent prompts, skill content, edge case handling |
| `rn-dev-agent-cli-research.md` | CLI speed research: screenshot benchmarks, maestro-runner vs Maestro, idb vs simctl analysis, uiautomator dump, snapshot_state.sh script, animation disabling, optimized testing loop timing |

Both are in the project files and serve as the implementation reference.