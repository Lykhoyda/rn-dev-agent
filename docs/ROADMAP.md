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

## Phase 11: Live Plugin Testing & RN 0.76 Compatibility ✅ (2026-03-11)

**Status: Complete**

Installed plugin from directory, launched test app on iOS 26.3 Simulator, and verified all 10 MCP tools against a live React Native 0.76 Bridgeless app.

| Fix | Description | Decision |
|-----|-------------|----------|
| CDP target filter | Bridgeless targets lack `vm: "Hermes"` — match on `title` instead | D142 |
| Navigation fallback | Fiber walk fails in Bridgeless — use `__NAV_REF__` ref | D143 |
| getTree opts API | Positional args → opts object for extensibility | D144 |
| Entry point | Created `index.js` for `expo run:ios` native binaries | D145 |
| MSW removed | `static class blocks` incompatible with Expo Babel | D146 |
| NativeWind removed | Requires `react-native-worklets` incompatible with RN 0.76 | D147 |

### Tool Verification Results

| Tool | Result | Notes |
|------|--------|-------|
| `cdp_status` | PASS | Metro + CDP connected, helpers injected |
| `cdp_evaluate` | PASS | JS execution works (42*2 = 84) |
| `cdp_component_tree` | PASS | Tree renders, filter works, RedBox detection works |
| `cdp_navigation_state` | PASS | Full hierarchy: Tabs → HomeTab → HomeMain |
| `cdp_store_state` | PASS | Redux state with all 4 slices |
| `cdp_console_log` | PASS | Ring buffer operational |
| `cdp_network_log` | PASS | Fallback hook mode active |
| `cdp_error_log` | PASS | Error tracking operational |
| `cdp_dev_settings` | PARTIAL | DevSettings unavailable in Bridgeless (B21) |
| `cdp_reload` | SKIPPED | Would disconnect test session |

---

## Phase 12: Post-Review Bug Fixes (Gemini + Codex gpt-5.4)

**Status: Complete**

Both Gemini and Codex (gpt-5.4) independently reviewed the full CDP bridge implementation. Combined findings: 9 bugs (1 critical, 2 high, 6 medium), 6 stress test scenarios, 2 complex feature proposals, 8 improvement suggestions.

All 9 bugs fixed and verified (13/13 tests passing including post-reload verification).

| Fix | Severity | Description | Decision |
|-----|----------|-------------|----------|
| Auto-reconnect self-blocks | CRITICAL | `reconnect()` → `autoConnect()` threw on `reconnecting=true` | D151 |
| _helpersInjected false positive | HIGH | Set true even when injection failed | D152 |
| Bridgeless reload loses helpers | HIGH | JS context reset but WS stays open | D158 |
| safeStringify invalid JSON | HIGH | Truncation mid-JSON broke parsing | D153 |
| evaluateAsync leak + false timeout | MEDIUM | Memory leak on timeout; non-serializable false timeout | D154 |
| sendWithTimeout leak | MEDIUM | ws.send() throw leaked pending entries | D155 |
| Console buffer pollution | MEDIUM | __RN_NET__ messages evicted real logs | D156 |
| XHR hook incomplete events | MEDIUM | Only loadend, missing error/abort/timeout | D157 |
| togglePerfMonitor throws | LOW | Not available on all Bridgeless builds | D159 |

### Post-Fix Verification Results

| Tool | Result | Notes |
|------|--------|-------|
| `cdp_status` | PASS | Metro + CDP connected, helpers injected |
| `cdp_evaluate` | PASS | JS execution works (1+1=2) |
| `cdp_component_tree` | PASS | Tree renders with AppContainer root |
| `cdp_navigation_state` | PASS | Full hierarchy: Tabs → HomeTab → HomeMain |
| `cdp_store_state` | PASS | Redux state with all slices |
| `cdp_console_log` | PASS | Ring buffer operational |
| `cdp_network_log` | PASS | Fallback hook mode active |
| `cdp_error_log` | PASS | Error tracking operational |
| `cdp_dev_settings` | PASS | togglePerfMonitor graceful degradation |
| `cdp_reload` | PASS | Bridgeless reload with helper re-injection |
| Post-reload status | PASS | Reconnected and responsive |
| Post-reload tree | PASS | __RN_AGENT available after reload |
| Post-reload evaluate | PASS | JS execution works post-reload |

---

## Source Documents

| Document | Contains |
|----------|----------|
| `rn-dev-agent-v2-architecture.md` | Complete architecture: plugin structure, full MCP server code (cdp-client.ts, injected-helpers.ts), all 10 tool definitions, agent prompts, skill content, edge case handling |
| `rn-dev-agent-cli-research.md` | CLI speed research: screenshot benchmarks, maestro-runner vs Maestro, idb vs simctl analysis, uiautomator dump, snapshot_state.sh script, animation disabling, optimized testing loop timing |

Both are in the project files and serve as the implementation reference.

---

## Phase 13: Four Prioritized Improvements (Complete)

**Status:** Complete (2026-03-12)

### Improvements Implemented
1. **Structured result envelope** — All 11 tools return `{ ok, data, error, truncated, meta }` via typed builders (`okResult`/`failResult`/`warnResult`)
2. **Reliable LogBox dismissal** — 4-tier fallback chain with `warnResult` when all tiers fail (replaces silent false "ok")
3. **`cdp_interact` tool** — Press, typeText, scroll via fiber tree (calls `memoizedProps` handlers directly)
4. **Source map symbolication** — Batched POST to Metro `/symbolicate` with 3s timeout, integrated in `cdp_error_log`

### Bonus Fixes
- Two-phase BFS search for filtered component tree (works at any depth in Fabric/Navigation apps)
- Versioned helper injection (prevents stale `__RN_AGENT` cache)
- Max depth increased to 12 for unfiltered queries

### Code Review Fixes (D170-D174)
- BFS double-enqueue of child siblings
- Shared WeakSet across multi-match subtree walks
- Unguarded JSON.parse in interact handler
- warnResult meta spread order
- symbolicate clearTimeout leak

### Pre-existing HIGH Bug Fixes (D182-D183)
- B41: `reconnecting` flag cleared immediately on success (not deferred to `.finally()`)
- B42: Code-1006 retries through full loop instead of immediate throw

### External Review Fixes (D175-D181)
- True BFS in filtered component tree search (sibling chain iteration)
- interact findFiber uses node count limit (5000) instead of depth limit (50)
- Guard JSON.parse in error-log handler
- Native RedBox dismiss via DevSettings.dismissRedbox() (Bridgeless + legacy)
- togglePerfMonitor consistent "no_method_available" sentinel
- Symbolication regex supports Hermes `name@url:line:col` format
- Error handler accumulation guard on helper reinjection

### Verification
| Test | Result | Notes |
|------|--------|-------|
| cdp_status | PASS | Auto-connect, app info, capabilities |
| cdp_evaluate | PASS | getAppInfo, globals accessible |
| cdp_component_tree | PASS | Two-phase BFS filter finds deep testIDs (319 nodes) |
| cdp_navigation_state | PASS | DeepLink navigation + params |
| cdp_store_state | PASS | Redux path queries |
| cdp_network_log | PASS | Hook mode capture |
| cdp_console_log | PASS | 3 log levels |
| cdp_error_log | PASS | Error buffer + symbolication |
| cdp_dev_settings | PASS | togglePerfMonitor |
| cdp_interact | PASS | Press action via fiber tree |
| cdp_reload | PASS | Full reload + reconnect + helper re-injection |

## Phase 14: Benchmark Experiment (Complete)

**Status:** Complete (2026-03-12)

28-call benchmark exercising all 11 tools in a realistic debugging workflow against the live test app on iPhone 17 Pro simulator.

### Bugs Found & Fixed (D184-D186)
1. **B53 (CRITICAL):** `cdp_console_log` captured 0 app-level entries — RN Bridgeless routes console through native bridge, not CDP events. Fixed with console monkey-patch in injected helpers.
2. **B54 (HIGH):** All tools fail without prior `cdp_status` — no auto-connect. Fixed with lazy auto-connect, reconnect-wait, helper-wait, and one retry on disconnect in `withConnection`.
3. **B55 (MEDIUM):** `cdp_interact` returned failure when handler threw — press DID execute. Fixed to return `warnResult` with handler error details.

### Performance (clean environment, no orphaned processes)
| Tool | Calls | Avg(ms) | Min(ms) | Max(ms) |
|------|-------|---------|---------|---------|
| cdp_reload | 1 | 577 | 577 | 577 |
| cdp_status | 2 | 130 | 10 | 249 |
| cdp_error_log | 1 | 10 | 10 | 10 |
| cdp_console_log | 2 | 10 | 4 | 15 |
| cdp_interact | 3 | 7 | 4 | 9 |
| cdp_evaluate | 6 | 7 | 2 | 19 |
| cdp_navigation_state | 2 | 5 | 1 | 9 |
| cdp_component_tree | 4 | 4 | 1 | 9 |
| cdp_dev_settings | 2 | 4 | 3 | 4 |
| cdp_store_state | 4 | 2 | 1 | 3 |
| cdp_network_log | 1 | 1 | 1 | 1 |

**Total:** 28 calls, 971ms, 20.3KB data. 25 ok, 3 warnings, 0 failures.

## Phase 15: rn-feature-dev Command (Complete)

**Status:** Complete (2026-03-12)

Adapted the official feature-dev plugin workflow for React Native development, adding live device verification after implementation.

### Deliverables

1. **`commands/rn-feature-dev.md`** — 8-phase orchestrating command (Phases 1–7 + 5.5 Live Verification)
2. **`agents/rn-code-explorer.md`** — RN-aware codebase analysis agent (testID inventory, route/store/API mapping)
3. **`agents/rn-code-architect.md`** — RN-aware architecture design agent (with mandatory Verification Parameters output)
4. **`agents/rn-code-reviewer.md`** — RN-aware code quality reviewer (testID coverage, `__DEV__` guards, Zustand exposure)
5. **`agents/rn-tester.md`** — Extended with Verification Checkpoint section for medium-depth live checks

### Architecture Decisions (D187-D191)
- D187: Self-orchestrating command (no `agent:` field) — launches different agents per phase
- D188: Three RN-adapted agents with `rn-` prefix to avoid collisions with official plugin
- D189: Architect blueprint includes Verification Parameters for mechanical Phase 5.5
- D190: Phase 5.5 inline in command (5 CDP calls + screenshot, not a separate skill)
- D191: Code agents get analysis-only tools — no device access or repo mutation

### Workflow
```
User: /rn-dev-agent:rn-feature-dev "add cart badge"
  Phase 1: Discovery — clarify requirements
  Phase 2: Exploration — 2-3 rn-code-explorer agents in parallel
  Phase 3: Clarifying Questions — surface gaps, wait for answers
  Phase 4: Architecture — rn-code-architect agent → blueprint with Verification Parameters
  Phase 5: Implementation — follow blueprint, save files, Fast Refresh
  Phase 5.5: Live Verification — screenshot + cdp_status + cdp_component_tree + cdp_store_state + cdp_error_log
  Phase 6: Quality Review — 2-3 rn-code-reviewer agents in parallel
  Phase 7: Summary — document results, suggest /test-feature for full E2E
```

## Phase 16: rn-feature-dev Benchmark — Notification Feature (Complete)

**Status:** Complete (2026-03-12)

End-to-end benchmark of the `rn-feature-dev` command: used it to implement a notification badge + detail view feature in the test app, exercising all 11 CDP tools during Phase 5.5 live verification.

### Feature Implemented
- Unread count badge on Notifications tab icon
- Tappable notification items → NotificationDetail screen
- "Mark as Read" button on detail screen (dispatches markRead action)
- "Clear All" button on notifications list (dispatches clearAll action)
- NotificationsTab wrapped in stack navigator (matches HomeTab/ProfileTab pattern)
- Deep link: `rndatest://notification/:id`

### CDP Tool Benchmark Results (All 11 Tools)
| Tool | Result | What It Proved |
|------|--------|----------------|
| cdp_status | PASS | Health check: Metro, CDP, no errors |
| cdp_navigation_state | PASS | Route tracking: NotificationsMain → NotificationDetail |
| cdp_component_tree | PASS | UI verification: all testIDs found in tree |
| cdp_store_state | PASS | State verification: notifications slice shape, unreadCount |
| cdp_console_log | PASS | Log capture: 5 entries across log/warn/error levels |
| cdp_network_log | PASS | Network capture: POST /api/notifications/read |
| cdp_error_log | PASS | Regression check: 0 new errors |
| cdp_evaluate | PASS | Direct JS execution: dispatched markRead via store |
| cdp_interact | PASS | UI interaction: pressed notif-item-0, pressed mark-read-btn |
| cdp_reload | PASS | Full reload with auto-reconnect and helper re-injection |
| cdp_dev_settings | WARN | Pre-existing: dismissRedBox not available in Expo Go |

### Agents Used
- rn-code-explorer: Mapped notifications area, navigation, store, testIDs
- rn-code-architect: (blueprint created inline due to scope clarity)
- rn-code-reviewer: Found 6 issues (2 fixed, 4 intentional test patterns)

### Decisions (D196-D198)
- D196: Wrap NotificationsTab in stack navigator
- D197: Derive unreadCount from items (not duplicated state)
- D198: Tab badge driven by Redux selector

## Phase 17: Gemini + Codex Review Fixes Round 2 (Complete)

**Status:** Complete (2026-03-12)

Fixed 10 issues identified by parallel Gemini + Codex reviews of the rn-feature-dev command and notification benchmark.

### Fixes Applied
| # | Severity | Fix | Decision |
|---|----------|-----|----------|
| 1 | HIGH | Phase 5.5 Step 0 uses `cdp_evaluate` navigation instead of deep links (B56) | D199 |
| 2 | HIGH | rn-tester Verification Checkpoint adds navigation step | D204 |
| 3 | CRITICAL | Phase 5.5 adds Step 3.5 interaction verification via `cdp_interact` | D201 |
| 4 | IMPORTANT | Step 0 detects simulator before navigation attempt | D200 |
| 5 | IMPORTANT | Phase 6 skips prompt when no findings | D202 |
| 6 | IMPORTANT | rn-code-reviewer console.log severity unified to Important | D203 |
| 7 | IMPORTANT | NotificationsTab gets `tabBarTestID` | D205 |
| 8 | MEDIUM | NotificationsScreen uses `selectUnreadCount` selector | D206 |
| 9 | MEDIUM | rn-tester checkpoint fixes copy-paste text | D204 |
| 10 | MEDIUM | rn-tester checkpoint table adds Navigation row | D204 |

### Decisions (D199-D206)
- D199: Phase 5.5 uses cdp_evaluate navigation instead of deep links
- D200: Phase 5.5 detects simulator before navigation attempt
- D201: Phase 5.5 includes interaction verification step
- D202: Phase 6 skips "which to fix" prompt when no findings
- D203: rn-code-reviewer console.log severity unified
- D204: rn-tester Verification Checkpoint navigation + text fixes
- D205: NotificationsTab tabBarTestID
- D206: NotificationsScreen uses selectUnreadCount

## Phase 18: Self-Evaluator Protocol (Complete)

**Status:** Complete (2026-03-12)

Development-time evaluation protocol that captures structured data during
`rn-feature-dev` runs and produces reports in `docs/reports/`.

### Deliverables
- `dev/evaluator.md` — evaluation protocol (not shipped to users)
- `docs/reports/` — report output directory
- Evaluator references in all 8 phases of `commands/rn-feature-dev.md`

### Decisions (D207-D209)
- D207: Evaluator lives in dev/, outside plugin manifest
- D208: Inline capture during rn-feature-dev, not post-run analysis
- D209: Confidence-gated bug logging to BUGS.md

## Phase 19: Gemini + Codex Review Fixes — Self-Evaluator (Complete)

**Status:** Complete (2026-03-12)

Fixed 5 issues from parallel Gemini + Codex reviews of the self-evaluator and related changes.

### Fixes Applied
| # | Severity | Fix | Decision |
|---|----------|-----|----------|
| 1 | HIGH | Architect Verification Parameters extended with navigationAction + interaction metadata | D210 |
| 2 | HIGH | Test app dispatches Redux before fire-and-forget fetch | D211 |
| 3 | HIGH | Evaluator Phase 7 checks Phase 6 deferred findings for bugs | D212 |
| 4 | MEDIUM | Evaluator increments agent counters in Phases 2, 4, 6 | D213 |
| 5 | MEDIUM | Evaluator increments phases_completed before writing report | D214 |

### Decisions (D210-D214)
- D210: Architect Verification Parameters include navigation action and interaction metadata
- D211: Dispatch Redux state before network call in test app
- D212: Evaluator Phase 7 checks Phase 6 deferred findings
- D213: Evaluator increments agent counters
- D214: Evaluator increments phases_completed before writing

## Phase 20: Tasks Tab Feature — Test App (Complete)

**Status:** Complete (2026-03-12)

Implemented a new "Tasks" tab in the test app using the full rn-feature-dev 8-phase workflow. The feature adds inline task creation, completion toggling, deletion, filter chips (All/Active/Done), active task count badge on the tab bar, and sync with rollback on failure.

### Files
| File | Action |
|------|--------|
| `src/store/slices/tasksSlice.ts` | CREATE — Redux slice with 6 reducers, memoized selectors |
| `src/screens/TasksScreen.tsx` | CREATE — Full screen with input, filters, FlatList, sync |
| `src/store/index.ts` | MODIFY — Register tasks reducer |
| `src/navigation/types.ts` | MODIFY — Add TasksStackParams + TasksTab |
| `src/navigation/RootNavigator.tsx` | MODIFY — TasksStack, tab badge, deep link, tabBarTestIDs |
| `src/mocks/handlers.ts` | MODIFY — POST /api/tasks/sync handler |

### Review Findings Fixed
| # | Severity | Issue | Decision |
|---|----------|-------|----------|
| C1 | CRITICAL | Module-level `nextId` counter breaks Fast Refresh — derive from state | D215 |
| C2 | CRITICAL | `selectFilteredTasks` creates new array every render — use createSelector | D216 |
| C3 | CRITICAL | `handleSync` dispatches before fetch succeeds — add rollback | D217 |
| I1 | IMPORTANT | HomeTab/ProfileTab missing tabBarTestID | D218 |
| I2 | IMPORTANT | Inline useSelector inconsistent — export selectCurrentFilter | D219 |

### Verification
All 6 CDP checks passed: navigation, screenshot, health, component tree, store state, error log.

### Decisions (D215-D219)
- D215: State-derived IDs in Redux reducers instead of module-level counters
- D216: Use createSelector for array-returning selectors
- D217: Optimistic sync with markAllUnsynced rollback on failure
- D218: All tabs must have tabBarTestID for consistent testability
- D219: Named selector exports for all useSelector calls

## Phase 21: Feed Search with Debounce — Ralph S1 (Complete)

**Status:** Complete (2026-03-12)

Added search/filter functionality to the FeedScreen as the first Ralph Loop user story (S1). The feature includes a debounced TextInput search bar (300ms), client-side filtering by title and body (case-insensitive), clear button with instant reset (bypasses debounce), and an empty state via ListEmptyComponent. Store items remain unchanged — filtering is purely client-side via useMemo.

### Files
| File | Action |
|------|--------|
| `src/screens/FeedScreen.tsx` | MODIFY — Add search bar, debounce, filtering, clear button, ListEmptyComponent |

### Review Findings Fixed
| # | Source | Severity | Issue | Decision |
|---|--------|----------|-------|----------|
| 1 | Internal | IMPORTANT | Individual useSelector calls instead of object selector | Existing pattern |
| 2 | Internal | IMPORTANT | debouncedQuery label missing from evaluator | Fixed inline |
| 3 | Codex (95) | HIGH | Clear button has 300ms delay — bypass debounce | D224 |
| 4 | Gemini (95) | MODERATE | Conditional FlatList mount/unmount — use ListEmptyComponent | D225 |
| 5 | Gemini (100) | HIGH | FlatList missing flex-1 — breaks virtualization | D226 |

### Verification
All 6 CDP checks passed: navigation (Feed route), screenshot, health (0 errors), component tree (search input + FlatList with flex-1 + ListEmptyComponent), store state (3 items unchanged), error log (0 new errors).

### Decisions (D224-D226)
- D224: Clear button bypasses debounce by setting debouncedQuery directly
- D225: Use ListEmptyComponent instead of conditional FlatList mount
- D226: FlatList requires flex-1 for proper virtualization

---

## Phase 22: Dark Mode Theme Toggle — Ralph S2 (Complete)

**Status:** Complete
**Date:** 2026-03-12

### What Was Built
- `useThemeColors()` hook — returns NativeWind className strings based on Redux theme state
- Theme toggle on Settings screen (Pressable, testID: `settings-theme-toggle`)
- Theme applied to all 5 screens: Home, Feed, Tasks, Profile, Settings
- NativeWind v4 babel config fix (`jsxImportSource: "nativewind"`)
- `import './global.css'` added to App.tsx entry point

### Key Fix
NativeWind v4 was silently failing — `className` props were in the component tree but not rendering visually. Root cause: `babel.config.js` was missing `jsxImportSource: "nativewind"` option. The `withNativeWind` metro config alone is not sufficient.

### Decisions (D227-D229)
- D227: NativeWind v4 requires jsxImportSource in babel config
- D228: Maestro flows must handle Expo Go dialog states conditionally
- D229: iOS Maestro flows cannot use `back` command

---

## Phase 23: Maestro E2E Tests — Ralph S1+S2 Proof (Complete)

**Status:** Complete
**Date:** 2026-03-12

### What Was Built
- `e2e/s1-feed-search.yaml` — 17 steps, all passing (35.2s)
- `e2e/s2-dark-mode.yaml` — 28 steps, all passing (30.2s)
- `e2e/launch-app.yaml` — reusable launch helper
- `e2e/dismiss-expo-dialog.yaml` — conditional dialog dismiss
- `docs/proof/s1-feed-search/` — screenshots + test report
- `docs/proof/s2-dark-mode/` — light/dark screenshots + test report
- maestro-runner v1.0.9 (Go binary, no JVM)

### S1 Feed Search Verified
Search input visible, text entry works, clear button appears/disappears, search re-entry works, navigation back to Home.

### S2 Dark Mode Verified
Light→Dark toggle, label changes (Light/Dark), dark background renders (bg-gray-900), theme persists across Profile→Home→Settings navigation, Dark→Light toggle restores original.

---

## Phase 24: Plugin Quality Hardening

**Status:** Complete
**Date:** 2026-03-12

### What Was Done
Quality hardening pass across all 13 plugin component files. No new components — structural and metadata improvements only.

### Skills (3 files)
- Added YAML frontmatter with `name` and `description` to all 3 skills
- Descriptions use third-person format with specific trigger phrases

### Agents (5 files)
- Added 2-3 `<example>` blocks to all 5 agent descriptions
- Added explicit `Triggers:` lines to rn-code-explorer, rn-code-architect, rn-code-reviewer
- Removed WebFetch, TodoWrite, WebSearch from read-only agents (rn-code-explorer, rn-code-architect, rn-code-reviewer)
- Added `color` field to rn-tester (cyan) and rn-debugger (red)
- Changed rn-code-reviewer color from red to magenta (avoid collision with rn-debugger)

### Commands (5 files)
- Added `allowed-tools` with `mcp__rn-dev-agent-cdp__*` to test-feature, debug-screen, build-and-test, check-env
- Removed `allowed-tools` from rn-feature-dev (inherits session permissions — needs TodoWrite + MCP tools)
- Added `argument-hint` to test-feature and build-and-test
- Normalized argument-hint to bracket format across all commands
- Added `$ARGUMENTS` interpolation to test-feature and build-and-test
- Rewrote check-env body from user-facing docs to agent instructions

### Review Results
- Gemini: 2 HIGH (fixed), 2 MODERATE (fixed), 2 LOW (deferred)
- Codex: 2 HIGH (fixed), 1 MODERATE (fixed)

---

## Phase 25: Skills Progressive Disclosure (Complete)

**Status:** Complete
**Date:** 2026-03-13

### What Was Done
Extracted large content blocks from all 3 skills to `references/` directories, tightened prose to imperative form, added trigger phrases, and applied all skill-reviewer feedback.

| Skill | Before (words) | After (words) | References Added |
|-------|---------------|---------------|------------------|
| rn-device-control | 1,872 | 1,448 | `references/expo-eas-builds.md` |
| rn-testing | 1,114 | 1,020 | `references/network-mocking-setup.md` |
| rn-debugging | 1,407 | 1,115 | `references/common-error-patterns.md`, `references/capability-matrix.md` |

---

## Phase 26: Profile Edit Modal — Ralph S3 (Complete)

**Status:** Complete
**Date:** 2026-03-13

### What Was Built
Profile edit modal presented from RootStack with name/email editing, inline validation, Redux state update, fire-and-forget POST to `/api/user/profile`, and NativeWind dark mode theming.

### Files
| File | Action |
|------|--------|
| `src/store/slices/userSlice.ts` | MODIFY — Added `updateProfile` action |
| `src/mocks/handlers.ts` | MODIFY — Added POST `/api/user/profile` handler |
| `src/navigation/types.ts` | MODIFY — Added `ProfileEditModal` to RootStackParams |
| `src/screens/ProfileEditModal.tsx` | CREATE — Modal screen with validation |
| `src/navigation/RootNavigator.tsx` | MODIFY — Registered modal screen |
| `src/screens/ProfileScreen.tsx` | MODIFY — Added Edit Profile button with CompositeScreenProps |

### Review Findings (3 found, 3 fixed)
| # | Severity | Issue | Fix |
|---|----------|-------|-----|
| 1 | CRITICAL | `getParent()?.navigate()` silently no-ops (reaches TabNavigator, not RootStack) | Nested CompositeScreenProps + direct navigate (D240) |
| 2 | IMPORTANT | Untyped `useDispatch()` | Added `<AppDispatch>` generic |
| 3 | IMPORTANT | Email validation accepts standalone `@` | IndexOf check with boundary chars (D242) |

### Verification
Screenshot confirmed Profile screen renders with "Edit Profile" button in dark mode. CDP verification blocked by B58 (Bridgeless wrong JS context).

### Plugin Observations
- ~~B58: CDP target selection picks wrong JS context~~ → Fixed in Phase 27 (D248)
- B59: maestro-runner v1.0.9 requires adb for iOS-only testing (upstream regression)
- Deep link navigation triggers native confirmation dialog in Expo Go (B56 workaround: use `cdp_evaluate` with `__NAV_REF__`)

---

## Phase 27: Plugin Improvements from S1-S3 Analysis (Complete)

**Status:** Complete
**Date:** 2026-03-13

Analysis of what worked and what broke during Ralph Loop stories S1-S3, followed by targeted plugin fixes.

### Findings from S1-S3
| Story | What Broke | Root Cause |
|-------|-----------|------------|
| S3 | CDP connects to wrong JS context (B58) | Highest-page-ID heuristic picks non-app Bridgeless target |
| S3 | Phase 5.5 verification failed silently | No detection/recovery for wrong-context scenario |
| S3 | maestro-runner needs adb for iOS (B59) | Upstream regression in v1.0.9 |

### Fixes Applied
| Fix | File(s) | Decision |
|-----|---------|----------|
| Smart target selection: probe `__DEV__` on each candidate | `cdp-client.ts` | D248 |
| cdp_status warns when `dev: false` | `tools/status.ts` | D249 |
| Phase 5.5 gates on `app.dev === true` | `rn-feature-dev.md` | D250 |
| Wrong-context troubleshooting in rn-debugging skill | `rn-debugging/SKILL.md` | D251 |

### Decisions (D248-D251)
- D248: CDP smart target selection with `__DEV__` probing
- D249: cdp_status warnResult for wrong JS context
- D250: Phase 5.5 Health Check gates on app.dev
- D251: Wrong-context rows in debugging skill troubleshooting table

### Decisions (D239-D243)
- D239: Modal screens on RootStack for cross-tab access
- D240: Nested CompositeScreenProps for cross-navigator navigation
- D241: Single updateProfile action for atomic name+email
- D242: Email validation with indexOf boundary check
- D243: Fire-and-forget POST with dispatch-first pattern

## Phase 28: Notification Snooze with Timer — Ralph S4 (Complete)

**Status:** Complete
**Date:** 2026-03-13

Implemented notification snooze feature as the fourth Ralph Loop story (S4). The feature adds snooze chips (1m/5m/15m) on the notification detail screen, filtered list hiding snoozed items, auto-unsnooze via setTimeout, and snoozed count badge in the header. First story to produce a self-evaluator report.

### Files Changed
| File | Change |
|------|--------|
| `test-app/src/store/slices/notificationsSlice.ts` | Added `snoozedUntil` field, `snoozeNotification`/`unsnoozeNotification` reducers, `selectVisibleNotifications`/`selectSnoozedCount` selectors, memoized `selectUnreadCount` |
| `test-app/src/screens/NotificationsScreen.tsx` | Filtered list via `selectVisibleNotifications`, auto-unsnooze timer with `useStore()`, snoozed count in header |
| `test-app/src/screens/NotificationDetailScreen.tsx` | Created — snooze chip row, snoozed badge, mark-read, dark mode |

### CDP Tools Benchmark
| Tool | Called | Result | Notes |
|------|--------|--------|-------|
| cdp_status | 1 | FAIL | MCP server killed (B60) |
| raw WS: __DEV__ probe | 1 | WARN | Wrong target first, correct on retry |
| raw WS: store dispatch | 2 | PASS | snooze + unsnooze |
| raw WS: store query | 3 | PASS | visible count, items shape |
| raw WS: navigate | 1 | PASS | Tab navigation |

### Bugs Found
- B60 (NEW): MCP server kill → tools permanently unavailable
- B61 (NEW): cdp_reload cannot switch targets

### Review Findings (7 found, 7 fixed)
1. createSelector with Date.now() → plain selectors (D253)
2. Missing __DEV__ guards on console.log
3. Stale closure in setTimeout → useStore() (D254)
4. testID uses index → item.id (D255)
5. selectUnreadCount not memoized → createSelector (D257)
6. Missing __DEV__ guards in NotificationsScreen
7. Non-null assertion → local variable narrowing (D256)

### Decisions (D253-D259)
- D253: Plain selectors for Date.now()-dependent filtering
- D254: useStore() for timer callback state reads
- D255: Stable testID uses item.id not positional index
- D256: Local variable narrowing eliminates non-null assertion
- D257: createSelector for pure derived state
- D258: MCP server process kill recovery gap
- D259: cdp_reload cannot switch CDP targets

### Self-Evaluator Report
First report written to `docs/reports/2026-03-13-notification-snooze.md`. 8 phases complete, 8 CDP calls (6 pass, 1 warn, 1 fail), 2 recovery actions, 2 bugs auto-logged.

## Phase 29: CDP Reliability Fixes — B58 Recurrence, B60, B61 (Complete)

**Status:** Complete
**Date:** 2026-03-13

Fixed the 3 systemic CDP reliability gaps identified during S4 development that were the biggest blockers to reliable automated verification.

### Problems Solved
1. **B58 recurrence (stale target):** After initial connection, target staleness (app reload outside agent control, Expo Go context switch) was never re-validated. WS stayed open but CDP calls returned stale results.
2. **B60 (MCP server death):** `pkill -f "cdp-bridge"` killed the MCP server permanently — no auto-restart within a session.
3. **B61 (reload can't switch targets):** `cdp_reload` never re-probed targets after reload. If connected to wrong context, reload couldn't fix it.

### Solution Architecture
- **`softReconnect()`** — shared recovery primitive on CDPClient. Tears down WS without setting `disposed`, rejects pending calls, calls `discoverAndConnect()` for full target re-discovery with `__DEV__` probing.
- **Reactive stale probe** — `withConnection` catch block probes `__DEV__` when a non-disconnect error occurs while WS is still open. If stale, calls `softReconnect()` + retry.
- **Auto-restart wrapper** — `run.sh` bash script restarts node process on crash (max 5 within 60s window).
- **Preempt flag** — `_softReconnectRequested` lets `softReconnect()` cancel background `reconnect()` loops instead of blocking.

### Files Changed
| File | Change |
|------|--------|
| `scripts/cdp-bridge/src/cdp-client.ts` | Added `softReconnect()`, `_softReconnectRequested` flag, preempt check in `reconnect()` |
| `scripts/cdp-bridge/src/utils.ts` | Added stale-target probe in `withConnection` catch, original error preservation in meta |
| `scripts/cdp-bridge/src/tools/reload.ts` | Complete rewrite — uses `softReconnect()` for full target re-discovery after reload |
| `scripts/cdp-bridge/src/index.ts` | Unhandled rejection demoted to non-fatal, added signal handlers |
| `scripts/cdp-bridge/run.sh` | NEW — auto-restart wrapper with crash budget |
| `.claude-plugin/plugin.json` | MCP server command changed from `node` to `bash run.sh` |

### Review Findings (6 found, 6 fixed)
1. CRITICAL: `run.sh` stale `exit_code` variable — reset to 0 each iteration
2. CRITICAL: `softReconnect()` missing `reconnecting` guard — added try/finally
3. HIGH: Stale probe loses original error context — added `originalError` to meta
4. HIGH: `softReconnect()` blocks on background reconnect — added preempt flag
5. HIGH: `process.exit(1)` on unhandled rejection consumes crash budget — demoted to non-fatal
6. LOW: Missing SIGINT trap in `run.sh` — added `trap 'exit 0' SIGINT`

### Decisions (D263-D269)
- D263: softReconnect() as shared recovery primitive
- D264: Reactive stale-target probe in withConnection catch
- D265: Auto-restart bash wrapper for MCP server
- D266: softReconnect preempts background reconnect loop
- D267: Preserve original error context in stale-target recovery
- D268: Unhandled rejections are non-fatal
- D269: SIGINT trap in run.sh

### Gemini + Codex Review (4 fixed, 1 deferred)
1. CRITICAL (Gemini) / HIGH (Codex): Probe timeout rejected instead of resolving → fixed (D270)
2. HIGH (Gemini): connectToTarget doesn't check preempt flag → fixed (D271)
3. MEDIUM (Gemini): softReconnect lacks retries for reload → added 3-attempt retry (D272)
4. MEDIUM (Codex): reinjectHelpers return value ignored → check + warnResult (D273)
5. HIGH (Codex): Tool handlers don't throw on stale errors → deferred as B63

### Decisions (D263-D273)
- D263: softReconnect() as shared recovery primitive
- D264: Reactive stale-target probe in withConnection catch
- D265: Auto-restart bash wrapper for MCP server
- D266: softReconnect preempts background reconnect loop
- D267: Preserve original error context in stale-target recovery
- D268: Unhandled rejections are non-fatal
- D269: SIGINT trap in run.sh
- D270: Stale probe timeout resolves instead of rejecting
- D271: connectToTarget checks _softReconnectRequested
- D272: cdp_reload retries softReconnect up to 3 times
- D273: cdp_reload checks reinjectHelpers return value

### Bugs Resolved
- ~~B60~~: MCP server death → auto-restart wrapper
- ~~B61~~: cdp_reload can't switch targets → softReconnect() with full re-discovery
- ~~B62~~: Stale target not detected mid-session → reactive probe in withConnection

### Bugs Found
- B63 (NEW): Stale-target probe only fires on thrown errors, not handler-level failResult

## Phase 30: E2E Proof as rn-feature-dev Phase 8 (Complete)

**Status:** Complete
**Date:** 2026-03-13

Added Phase 8 to the `rn-feature-dev` command. Every feature now ends with a permanent proof artifact: numbered CDP screenshots walking through the user flow, saved to `docs/proof/<feature-slug>/` with a `PROOF.md` summary.

### Design Choice
CDP interactions + `simctl screenshot` instead of Maestro. Avoids B59 (maestro-runner broken on iOS), zero external dependencies, uses the same CDP tools already proven in Phase 5.5.

### Files Changed
| File | Change |
|------|--------|
| `commands/rn-feature-dev.md` | Added Phase 8: E2E Proof, updated phase count to 9 |

### Decisions
- D274: Phase 8 E2E Proof uses CDP screenshots, not Maestro

## Phase 31: Ralph Loop S5 — Task Priority and Sort (Complete)

**Status:** Complete
**Date:** 2026-03-13

Implemented S5 from RALPH-STORIES.md using the full rn-feature-dev workflow (Phases 1-8) including the new Phase 8 E2E Proof.

### What Was Built
Priority field (`low`/`medium`/`high`) on task items with color-coded chips (red/amber/green), tap-to-cycle priority, sort toggle button (default/priority), and a memoized `selectSortedFilteredTasks` selector that composes filter then sort. First story to use Phase 8 E2E Proof with 5 CDP screenshots.

### Files Changed
| File | Change |
|------|--------|
| `test-app/src/store/slices/tasksSlice.ts` | Added priority field, cyclePriority/toggleSort reducers, selectSortedFilteredTasks composed selector, memoized selectUnsyncedCount |
| `test-app/src/screens/TasksScreen.tsx` | Priority chips, sort button, id-based testIDs, NativeWind line-through fix, __DEV__ guard |
| `docs/proof/s5-task-priority-sort/` | 5 E2E proof screenshots + PROOF.md |

### Review Findings
5 issues found by 3 rn-code-reviewer agents. All 5 fixed:
- NativeWind line-through static literal (D278)
- Selector composition / dedup (D276)
- selectUnsyncedCount memoization (D277)
- __DEV__ guard on console.error (D279)
- selectFilteredTasks dead code preserved for composition

### Decisions
- D275: Item.id-based testIDs instead of index-based
- D276: Compose selectSortedFilteredTasks on selectFilteredTasks
- D277: Memoize selectUnsyncedCount with createSelector
- D278: NativeWind line-through as static class literal
- D279: __DEV__ guard on handleSync console.error

## Phase 32: Architect-Designed E2E Proof Flow (Complete)

**Status:** Complete
**Date:** 2026-03-13

Phase 8 was improvising proof flows at execution time — risking skipped steps and shallow coverage, especially with context compression. Now the architect agent (Opus, full feature context) designs the exact E2E Proof Flow during Phase 4, and Phase 8 executes it mechanically.

### What Changed
- `agents/rn-code-architect.md` — New mandatory section 9: E2E Proof Flow table with testIDs, CDP expressions, expected states, screenshot filenames
- `commands/rn-feature-dev.md` — Phase 3 asks about E2E flows, Phase 4 verifies the proof flow exists, Phase 8 executes from blueprint with no improvisation + "Deviations from Plan" section in PROOF.md

### Decisions
- D280: E2E Proof Flow designed by architect (Opus), executed mechanically by Phase 8

## Phase 33: Ralph Loop S6 — Offline Banner with Network Detection (Complete)

**Status:** Complete
**Date:** 2026-03-16

Implemented persistent offline banner as the sixth Ralph Loop story (S6). The feature adds a red "No Connection" banner at the top of all screens when offline, with a green "Back Online" toast for 2s on reconnection. Network status is mocked via `globalThis.__OFFLINE__` polling (2s interval with immediate check on mount). API calls are blocked while offline with inline messaging.

### Files Changed

| File | Change |
|------|--------|
| `test-app/src/store/slices/networkSlice.ts` | Created — Redux slice with `isOffline` state, `setOffline`/`setOnline` reducers |
| `test-app/src/hooks/useNetworkStatus.ts` | Created — Polls `globalThis.__OFFLINE__` every 2s, dispatches to Redux |
| `test-app/src/components/OfflineBanner.tsx` | Created — Global banner with LayoutAnimation, retry button, online toast |
| `test-app/src/store/index.ts` | Modified — Added `network` reducer (not persisted) |
| `test-app/src/App.tsx` | Modified — Wrapped navigator with OfflineBanner |
| `test-app/src/screens/FeedScreen.tsx` | Modified — Added offline guard, inline offline message, stable testIDs |

### Decisions
- D281: New networkSlice instead of extending settingsSlice
- D282: Poll globalThis.__OFFLINE__ instead of NetInfo
- D283: Hardcoded STATUS_BAR_HEIGHT fallback over useSafeAreaInsets
- D284: useRef pattern for stale closure prevention in useCallback
- D285: Immediate network check on mount before interval starts
- D286: UIManager.setLayoutAnimationEnabledExperimental for Android
- D287: Stable item.id-based testIDs over index-based

### Review Findings
Internal review: 6 issues found, 3 critical fixed (timer leak, circular import, stale closure)
Gemini review: 4 findings — 2 fixed (immediate poll, Android LayoutAnimation)
Codex review: 3 findings — 1 fixed (stable testIDs), 1 deferred (hardcoded height)

## Phase 34: Post-Edit Health Check Hook (Complete)

**Status:** Complete
**Date:** 2026-03-16

Added a PostToolUse hook that automatically checks the simulator for crashes after source file edits. This catches the most critical failure mode: an edit that crashes the app or kills Metro, which previously went unnoticed until the user reported it.

### What Changed
- `hooks/post-edit-health-check.sh` — New PostToolUse hook script
- `hooks/hooks.json` — Added PostToolUse event for Edit/Write tools
- `CLAUDE.md` — Updated plugin structure tree

### How It Works
1. Fires after any Edit/Write on `.ts/.tsx/.js/.jsx` files
2. Debounced to 5s (rapid edits don't stack up)
3. Waits 2s for Fast Refresh / Metro rebundle
4. HTTP-only checks (no WebSocket to avoid conflicting with cdp-bridge):
   - `GET /status` — Metro still running?
   - `GET /json` — Hermes debug targets still alive?
5. Exit 2 with stderr message → Claude sees the error and investigates

### Limitations
- Cannot detect RedBox errors (app running but showing error) — requires WebSocket which conflicts with cdp-bridge
- 2s sleep adds latency to Edit/Write calls (mitigated by debounce)
- Future: cdp-bridge could write health status to a temp file for richer hook checks

### Decisions
- D288: PostToolUse hook for automatic post-edit health checks
- D289: HTTP-only health check (no WebSocket from hook)
- D290: AbortController timeout on fetch calls

## Phase 35: Ralph Loop S7-S10 Implementation (Complete)

**Status:** Complete
**Date:** 2026-03-16

### What Was Built

Four Ralph Loop stories implemented in a single batch using the `feature-dev:feature-dev` skill workflow:

**S7: Swipe-to-Delete with Undo**
- `SwipeableTaskRow` component with `PanResponder` + `Animated` swipe gesture
- Red delete zone revealed on left swipe past -80px threshold
- `UndoSnackbar` with 5-second countdown timer
- `softDelete`/`restoreTask`/`commitDelete` reducers in `tasksSlice`
- `pendingDelete` with `insertIndex` for accurate restore position

**S8: Pull-to-Refresh with Loading States**
- `RefreshControl` on FeedScreen's FlatList
- `isRefresh` parameter prevents full-screen loading overlay during pull
- `lastFetched` field in `feedSlice` with `formatRelativeTime` utility
- "Last updated" label below search bar

**S9: Nested Navigation with Deep Links**
- `TaskDetailScreen` with toggle done / cycle priority actions
- `TaskDetail: { id: string }` in `TasksStackParams`
- Deep link `rndatest://tasks/:id` registered in linking config
- `task-row-pressable-{id}` on title area for navigation trigger

**S10: Badge Counts with Background Sync**
- `useBackgroundSync` hook with 30s `setInterval` + 5s AbortController timeout
- `SyncContext` + `SyncBridge` for global state sharing
- `lastSynced` in `settingsSlice` (auto-persisted via redux-persist whitelist)
- "Last synced" display + "Sync Now" button in SettingsScreen
- Removed dead badge Animated.Values after Codex/Gemini review

### Files Created (6)
- `src/constants/taskStyles.ts` — shared PRIORITY_STYLES
- `src/components/SwipeableTaskRow.tsx` — swipe gesture row
- `src/components/UndoSnackbar.tsx` — timer-based undo
- `src/screens/TaskDetailScreen.tsx` — task detail screen
- `src/hooks/useBackgroundSync.ts` — background sync hook
- `src/context/SyncContext.ts` — sync state context

### Files Modified (9)
- `src/store/slices/tasksSlice.ts` — pendingDelete, softDelete/restoreTask/commitDelete
- `src/store/slices/feedSlice.ts` — lastFetched, formatRelativeTime
- `src/store/slices/settingsSlice.ts` — lastSynced, setLastSynced
- `src/navigation/types.ts` — TaskDetail params
- `src/screens/TasksScreen.tsx` — SwipeableTaskRow + UndoSnackbar
- `src/screens/FeedScreen.tsx` — RefreshControl, lastFetched label
- `src/screens/SettingsScreen.tsx` — sync status + sync-now-btn
- `src/navigation/RootNavigator.tsx` — TaskDetail screen + deep link
- `src/App.tsx` — SyncBridge wrapper

### Review Results
- Internal code review: 7 findings, all critical fixed
- Codex review: 5 findings — duplicate ID bug fixed, dead animations removed
- Gemini review: 8 findings — stale closure acknowledged (mitigated by keyExtractor), dead animations confirmed

### Decisions (D291-D300)
- D291: PanResponder + Animated (no gesture handler, avoid rebuild)
- D292: pendingDelete with insertIndex for restore position
- D293: Timer in UndoSnackbar component, not Redux
- D294: isRefresh parameter skips loading overlay
- D295: formatRelativeTime as pure function in feedSlice
- D296: SyncContext + SyncBridge for state sharing
- D297: lastSynced auto-persisted via settingsSlice
- D298: Removed dead badge Animated.Values
- D299: Include pendingDelete in addTask maxId computation
- D300: TaskDetail deep link reuses existing linking pattern
- D301: CDP-only verification strategy for Expo Go apps
- D302: Synchronous cdp_evaluate for time-sensitive store verification

### Live Verification Results (Phase 5.5)

All 4 stories verified on iPhone 17 Pro Simulator via CDP tools:

| Check | Story | Result |
|-------|-------|--------|
| Tasks screen renders (3 tasks, priorities, filters) | S7 | PASS |
| softDelete sets pendingDelete synchronously | S7 | PASS |
| restoreTask restores item at correct index | S7 | PASS |
| commitDelete auto-fires after 5s | S7 | PASS |
| Feed renders with "Last updated: just now" | S8 | PASS |
| RefreshControl wired to FlatList | S8 | PASS |
| TaskDetail navigation with params | S9 | PASS |
| cyclePriority via TaskDetail button | S9 | PASS |
| Settings shows "Last synced: just now" | S10 | PASS |
| Sync Now button renders | S10 | PASS |
| Error regression (cdp_error_log) | All | WARN (1 non-critical) |

**Bugs found:** B69 (PanResponder cyclical structure in component tree), B70 (DOMException missing in Hermes), B71 (agent-device steals focus from Expo Go)

**Tool performance notes:** CDP tools (cdp_status, cdp_store_state, cdp_interact, cdp_evaluate) all responded within 1-2 seconds. The 5s undo timer required synchronous cdp_evaluate dispatch+read pattern since MCP round-trips exceed 5s. agent-device tools incompatible with Expo Go due to focus-stealing (B71).

---

## Phase 37: Critical Plugin Tool Fixes (Complete)

**Status:** Complete
**Date:** 2026-03-16

Four targeted fixes to the CDP bridge MCP server that reduced live verification time from ~30 minutes (with multiple crashes and manual interventions) to ~5 minutes 40 seconds (zero crashes, zero manual interventions).

### What Changed

**Fix 1: Cycle detection in getTree() serializer (D303, fixes B69)**
- `scripts/cdp-bridge/src/injected-helpers.ts` — Added `safeStringify()` with WeakSet cycle tracking, replaced `JSON.stringify` at 3 call sites. Sanitized `hookStates` (functions → `'[Function]'`, circular → `'[Circular]'`). Removed unparseable `preview` field from truncation output, replaced with `hint`. Bumped helpers version to 7.

**Fix 2: Expo Go detection in device_snapshot (D304, mitigates B71)**
- `scripts/cdp-bridge/src/tools/device-session.ts` — Early rejection of Expo Go bundle IDs before spawning agent-device CLI. Returns guidance to use CDP tools instead.

**Fix 3: Atomic cdp_dispatch tool (D305)**
- `scripts/cdp-bridge/src/tools/dispatch.ts` — New file. Tool handler using `withConnection` pattern.
- `scripts/cdp-bridge/src/injected-helpers.ts` — Added `dispatchAction()` helper (~60 lines) with 3-tier Redux store finder + dispatch + optional state read.
- `scripts/cdp-bridge/src/index.ts` — Registered `cdp_dispatch` tool (20th tool).

**Fix 4: Auto-recovery in cdp_status (D306)**
- `scripts/cdp-bridge/src/tools/status.ts` — Auto-recovery for `dev:false` (softReconnect + re-probe) and `isPaused:true` (softReconnect + resume check). Warning fallbacks if recovery fails.

### Verification Results

| Metric | Before | After |
|--------|--------|-------|
| Total verification time | ~30 min | 5 min 40 sec |
| Crashes during verification | 2-3 (cycle errors) | 0 |
| Manual interventions needed | 5+ (reconnect, retry) | 0 |
| Features verified (S7-S10) | Partial, with workarounds | All complete |

### Code Review

Reviewed by code-reviewer agents (3 parallel reviews):
- 4 issues found (all Important severity)
- 3 fixed: unparseable `preview` field, missing isPaused warning after recovery, deprecated `cdp_interact` reference in hint
- 1 deferred: `dispatchAction` duplicates store-finding fiber walk from `getStoreState` (maintenance concern, not a bug)

---

## Phase 38: Node.js LTS-Only Support (Planned)

**Status:** Planned
**Date:** 2026-03-13

Drop support for non-LTS Node.js versions. The CDP bridge MCP server should target only active LTS releases (currently Node 22 LTS, next Node 24 LTS in October 2026). This simplifies CI matrix, avoids chasing odd-numbered release quirks, and aligns with React Native's own support policy.

### Changes Needed
- Update `engines` field in `scripts/cdp-bridge/package.json` to `"node": ">=22"`
- Update README requirements table to specify LTS versions only
- Add Node version check to `hooks/detect-rn-project.sh` (warn if non-LTS detected)
- Update CI workflows (if added) to test only against LTS versions

### Why
- Non-LTS Node versions (19, 21, 23) have 6-month lifespans and receive no security patches after EOL
- React Native and Expo both recommend LTS versions
- Reduces surface area for "works on my machine" issues caused by V8/libuv differences in odd releases