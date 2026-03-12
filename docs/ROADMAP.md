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