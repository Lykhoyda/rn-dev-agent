# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**rn-dev-agent** — A Claude Code plugin that turns Claude into a React Native development partner. It explores the codebase, designs architecture, implements features, then verifies everything live on the simulator — reading the component tree, store state, and navigation stack through Chrome DevTools Protocol.

## Project Structure — sibling repos

This is the **pure plugin repo** — agents, commands, skills, hooks, MCP server (`scripts/cdp-bridge/`), marketplace manifest. It ships to users as-is, so it contains only what runs inside Claude Code.

Development scaffolding lives in the **sibling workspace repo**:
`../rn-dev-agent-workspace` (absolute on dev machine: `/Users/anton_personal/GitHub/rn-dev-agent-workspace`).

| Artifact | Location |
|---|---|
| Test app (Expo Dev Client, exercises plugin tools) | `rn-dev-agent-workspace/test-app/` |
| `ROADMAP.md`, `DECISIONS.md`, `BUGS.md` | `rn-dev-agent-workspace/docs/` |
| Proof artifacts / benchmarks / session reports | `rn-dev-agent-workspace/docs/proof/` |
| Shared packages (agent-device, maestro-runner) | `rn-dev-agent-workspace/packages/` |
| Dev-only scripts (benchmark runners, harnesses) | `rn-dev-agent-workspace/dev/` |

**Do not** recreate `test-app`, `docs`, or `packages` symlinks in this repo — they caused "two test-apps" confusion during benchmarking and were removed on 2026-04-16. Edit workspace files via their absolute/relative path directly (`../rn-dev-agent-workspace/docs/ROADMAP.md`).

**Metro must be started from the workspace**: `cd ../rn-dev-agent-workspace/test-app && npx expo start`. Otherwise the `com.rndevagent.testapp` Dev Client bundle fails to register and you get "App entry not found" on the simulator.

## Quick Start (for users)

### First-time setup
1. Install: `/plugin marketplace add Lykhoyda/rn-dev-agent`
2. Navigate to your RN project: `cd /path/to/your-rn-app`
3. Run setup check: `/rn-dev-agent:setup`
4. Fix any items marked MISSING in the output table

### Prerequisites
- **Node.js >= 22 LTS** (even-numbered release — NOT v25)
- **iOS Simulator** booted with your app OR **Android Emulator** running
- **Metro dev server** running (`npx expo start` or `npx react-native start`)
- Platform-specific device-control runtime (one of):
  - **iOS** — in-tree `rn-fast-runner` XCTest project ships with the plugin (`scripts/rn-fast-runner/`). Pre-build it once with a booted simulator: `cd ${CLAUDE_PLUGIN_ROOT}/scripts/rn-fast-runner/RnFastRunner && xcodebuild build-for-testing -project RnFastRunner.xcodeproj -scheme RnFastRunner -destination "platform=iOS Simulator,id=<UDID>" -derivedDataPath ../build/DerivedData`. After that, the runner spawns lazily on the first `device_snapshot action=open`. iOS no longer requires `agent-device` (PR #164 / D1219).
  - **Android** — `agent-device` CLI: `npm install -g agent-device` (auto-installed by the plugin; may need manual install if the auto-install fails).
- `maestro-runner` — auto-installed to `~/.maestro-runner/`

### Essential commands
```
/rn-dev-agent:setup                    — Check & install all prerequisites
/rn-dev-agent:rn-feature-dev <desc>    — Full 8-phase feature development pipeline
/rn-dev-agent:test-feature <desc>      — Test a feature end-to-end on device
/rn-dev-agent:debug-screen             — Diagnose and fix the current screen
/rn-dev-agent:check-env                — Verify environment readiness
/rn-dev-agent:build-and-test <desc>    — Build app, then test feature
/rn-dev-agent:proof-capture <desc>     — Record proof video + screenshots
/rn-dev-agent:send-feedback            — Report a bug
```

### How it works
1. Always start with `cdp_status` — this connects to your running app via CDP
2. Use MCP tools (not bash) for all app interaction:
   - `cdp_component_tree` — read React components by testID
   - `cdp_store_state` — read Redux/Zustand/React Query state
   - `cdp_navigate` — navigate to any screen
   - `device_screenshot` — capture screen
   - `device_find` / `device_press` — tap UI elements
3. Do NOT use `xcrun simctl` or `adb` for app interaction — use the CDP/device tools

### Troubleshooting
- **"CDP connection failed"** → Is Metro running? Is the app loaded on the simulator?
- **"agent-device not installed"** → Only required for Android. If targeting Android, run `npm install -g agent-device`. iOS uses the in-tree `rn-fast-runner` and does not need it.
- **"rn-fast-runner did not become ready" / no `.xctestrun` at the expected path** → Pre-build the runner once with `xcodebuild build-for-testing` (see Prerequisites). The build artifacts live at `scripts/rn-fast-runner/build/DerivedData/`.
- **Legacy `AgentDeviceRunner` re-appears on the simulator** → A stale `~/.agent-device/daemon.json` is respawning the upstream runner. Either run with `RN_DEVICE_KILL_LEGACY=1` (the plugin terminates the daemon at session-open) or `pkill -f AgentDeviceRunner && rm -f ~/.agent-device/daemon.json ~/.agent-device/daemon.lock` one-time.
- **"No booted simulator"** → Open Simulator.app or boot one via Xcode
- **iOS 26.x beta issues** → Use iOS 18 stable runtime (Xcode > Settings > Platforms)
- **Node.js odd version (v25)** → Switch to Node 22 LTS: `nvm install 22 && nvm use 22`

### Zustand store access
For Zustand stores to be readable by the plugin, add this to your app entry:
```typescript
if (__DEV__) {
  globalThis.__ZUSTAND_STORES__ = {
    myStore: useMyStore,
    // ... other stores
  };
}
```

---

## Architecture (for contributors)

Three layers working together:

| Layer | Tool | Role |
|-------|------|------|
| Device interaction (iOS) | In-tree `rn-fast-runner` XCTest rig (`scripts/rn-fast-runner/`) — single `POST /command` HTTP endpoint | Native iOS device control via XCTest. Always calls `XCUIApplication.activate()` per request so the target app is foregrounded (B155 / D1219). |
| Device interaction (Android) | `agent-device` CLI (auto-installed) | Native Android device control: tap, swipe, fill, find, snapshot, screenshot |
| App introspection | Custom MCP server → Hermes CDP via WebSocket | Persistent WebSocket — reads React fiber tree, store state, network, console, errors |
| E2E testing | maestro-runner (preferred) / Maestro (fallback) | YAML-based persistent test files for CI |

iOS dispatch: every iOS `device_*` call short-circuits through `runIOS()` (TS client at `scripts/cdp-bridge/src/runners/rn-fast-runner-client.ts`) to the in-tree runner's `/command` endpoint. Coordinate-based gestures map to `.drag`; direction-based swipes/scrolls are pre-computed to coords by `device-interact.ts` before dispatch. `device_find` non-exact + `device_scrollintoview` are TS-side orchestrators over `runIOS('snapshot')` (no Swift `.findText` round-trip for fuzzy match — too coarse, returns bool only).

Android dispatch unchanged: 3-tier `agent-device` (daemon socket → fast-runner → CLI). The legacy daemon is detected at session-open on iOS too and warned about (`RN_DEVICE_KILL_LEGACY=1` opts into termination) — a stale daemon respawns the upstream `AgentDeviceRunner` and fights our `RnFastRunner` for focus.

Fallback: `xcrun simctl` (iOS) + `adb` (Android) for device lifecycle (boot / install / launch / terminate) — the runner doesn't manage device state, only interaction.

### MCP Server (cdp-bridge)

64 tools exposed via MCP (count last audited 2026-04-28; per-category breakdown below predates several additions and is approximate):

**CDP tools** (React internals via Chrome DevTools Protocol over WebSocket):
- `cdp_status` — health check with domain capabilities + reconnect state
- `cdp_connect` / `cdp_disconnect` / `cdp_targets` — connection management
- `cdp_evaluate` — arbitrary JS execution in Hermes
- `cdp_reload` — full reload with auto-reconnect
- `cdp_dev_settings` — programmatic dev menu actions
- `cdp_component_tree` / `cdp_component_state` — React fiber introspection
- `cdp_navigation_state` / `cdp_nav_graph` / `cdp_navigate` — navigation
- `cdp_store_state` / `cdp_dispatch` — Redux/Zustand/React Query state
- `cdp_network_log` / `cdp_network_body` / `cdp_console_log` / `cdp_error_log` — buffered events
- `cdp_wait_for_network` — block until a network request matching url_pattern + method completes (D682, GH #65 P3) — collapses "tap → check → tap" into a single deterministic call
- `cdp_interact` — press/type/scroll by testID via fiber tree
- `cdp_heap_usage` — JS memory usage
- `cdp_cpu_profile` — CPU profiling with hot function ranking
- `cdp_object_inspect` — handle-based lazy object inspection
- `cdp_exception_breakpoint` — catch exceptions with timed capture
- `cdp_set_shared_value` — set Reanimated SharedValue by testID for proof captures
- `collect_logs` — parallel multi-source log collection

**Device tools** (14 — iOS: in-tree `rn-fast-runner` `/command` endpoint; Android: `agent-device` CLI):
- `device_list` / `device_screenshot` / `device_snapshot`
- `device_find` / `device_press` / `device_fill` / `device_swipe` / `device_scroll`
- `device_scrollintoview` / `device_back` / `device_longpress` / `device_pinch`
- `device_permission` / `device_batch`

iOS-only quirks worth knowing:
- `device_fill` may surface a Swift-internal `XCUIElement.typeText` quiescence-timeout from XCTest's main-thread sync. The TS client treats this specific error as success on `.type` (`meta.runnerTimeoutShim: true`) because the side-effect (text appended to the field) demonstrably succeeds — observed across the iOS-MVP smoke-tests.
- `device_find` non-exact + `device_scrollintoview` ALWAYS route through the TS orchestrators on iOS (never the legacy `agent-device find/scrollintoview` CLI), so they don't respawn the upstream `AgentDeviceRunner`.

**Testing & composite tools** (13):
- `proof_step` / `cross_platform_verify` / `maestro_run` / `maestro_generate` / `maestro_test_all`
- `cdp_auto_login` + device helpers (deeplink, accept/dismiss dialog, focus_next, pick_date, pick_value)

### Key Technical Decisions

- Inject helpers ONCE on CDP connect (~2KB JS), then call `__RN_AGENT.getTree()` etc.
- Per-method timeout classes: fast (1.5s), standard (5s), slow (30s) — D588
- Ring buffers for events (console: 200, network: 100, log: 50) since MCP is pull-based
- 3-tier interaction model: cdp_interact (JS) > device_press (XCTest) > Maestro (E2E) — D497
- Hook-mode fallbacks for network body + CPU profile on RN < 0.83 — D597
- Proactive __RN_AGENT freshness check before every tool call — D502
- iOS device verbs route through `rn-fast-runner-client.ts` (`runIOS()` → `/command`); Android keeps 3-tier `agent-device` dispatch (fast-runner → daemon → CLI) via `agent-device-wrapper.ts` — D1219, PR #164
- `cdp_repair_action` self-bootstraps the iOS fast-runner on auto-repair (no pre-opened device session required) — D1220

## Conventions

- CDP bridge is TypeScript (Node.js >= 22, LTS versions recommended)
- Skills/agents/commands are Markdown files with YAML frontmatter
- Maestro flows are YAML
- Prefer maestro-runner over Maestro (3x faster, no JVM)
- Always filter component tree queries — never dump the full tree
- Use explicit type imports (`import type { ... }`)
- No unnecessary comments in code
- **When developing tools, instrument them with per-step timing in `meta.timings_ms`** so we can see where they're slow. The 3-tier dispatch (fast-runner → daemon → CLI), agent-device handshake, fiber-tree snapshot, and Maestro flow execution all have variable cost; the dispatcher is the only one that already returns per-step ms. Add `meta.timings_ms: { stepA: ms, stepB: ms, ... }` to tool results so users can run a tool a few times, eyeball the breakdown, and know which path to optimize. Without this we're guessing — the MTTR experiment surfaced two perf-related bugs (B153/B154) that took hours to root-cause precisely because the snapshot path was opaque-timed.
