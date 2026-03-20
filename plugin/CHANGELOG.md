# Changelog

All notable changes to rn-dev-agent will be documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/).

## [0.5.0] — 2026-03-20

### Added
- **`collect_logs` tool** — multi-source log collection from JS console, native iOS (`xcrun simctl log stream`), and native Android (`adb logcat`) in parallel. Results merged by timestamp.
- **App-Side Dev Bridge** (`@rn-dev-agent/runtime`) — stable public API replacing fragile fiber walks for navigation state, store state, console, and errors. Local `dev-bridge.ts` for test-app integration.
- **Vercel RN Best Practices skill** — 36 rules from `vercel-labs/agent-skills` + 3 custom rules. Pass 4 keyword-triggered reviewer integration.
- **Post-edit health check hook** — detects app crashes after source file edits via PostToolUse hook. Gated on active CDP session to avoid false positives.
- **MCP server resilience** — reconnect window extended to 46s (30 attempts), background Metro poll for auto-reconnect after Metro restart.
- **DiagnosticsScreen** (test-app) — dev-only screen with FlashList log viewer, level filter pills, and pull-to-refresh for `collect_logs` validation.
- **GlobalSearchModal** (test-app) — FlashList with heterogeneous items, cross-store search, text highlighting.
- **TaskStatsCard** (test-app) — Reanimated animated progress bar with staggered entries.
- **Auto-update guide** in README for marketplace plugin users.
- **Navigation debugging recipe** — B75 nested navigator patterns documented in `skills/rn-debugging/references/`.

### Changed
- Plugin now requires Node.js >= 22 (LTS).
- Reviewer agent (Pass 4) loads best-practice rules based on keyword triggers in reviewed code.
- Architect agent references CRITICAL/HIGH rules when designing component architecture.
- `cdp_status` reports `capabilities.bridgeDetected` and `capabilities.bridgeVersion`.
- Bridge-aware routing in navigation state, store state, console log, error log, and dispatch tools.
- Health check hook gated on active CDP session flag file (`/tmp/rn-dev-agent-cdp-active`).
- Bridgeless mode target detection checks both `.title` and `.description` fields.

### Fixed
- Post-edit health check false positives outside RN projects (GH #1).
- Post-edit health check false positives when app not installed or simulator booted without app (GH #2).
- Console double-wrapping on Fast Refresh via global sentinel.
- Store auto-detection re-scans globals on every call instead of caching first result.
- Bridge detector validates required methods instead of accepting any truthy global.
- Reconnect resets bridge state in `handleClose()` and `softReconnect()`.

## [0.1.0] — 2026-03-09

### Added
- Initial release.
- 19 MCP tools: 11 CDP (status, evaluate, reload, component tree, navigation state, store state, error log, network log, console log, interact, dev settings) + 8 device (list, screenshot, snapshot, find, press, fill, swipe, back).
- 3 skills: rn-device-control, rn-testing, rn-debugging.
- 5 agents: rn-tester, rn-debugger, rn-code-explorer, rn-code-architect, rn-code-reviewer.
- 5 commands: rn-feature-dev, test-feature, debug-screen, check-env, build-and-test.
- Injected helpers IIFE for Hermes runtime introspection.
- Ring buffers for console (200), network (100), and error (50) events.
- Network fallback for RN < 0.83 via fetch/XHR monkey-patches.
- Auto-discovery across Metro ports 8081/8082/19000/19006.
- maestro-runner and agent-device auto-installation hooks.
