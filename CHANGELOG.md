# Changelog

All notable changes to rn-dev-agent will be documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/).

## [0.22.0] — 2026-04-16

### Added
- **`cdp_set_shared_value` tool** — Drive Reanimated SharedValue animations by testID for proof captures when gesture/scroll synthesis is unavailable. Walks the React fiber tree, finds the named prop, sets `.value` on the JS thread (D623).
- **Fast-runner auto-restart** — When fast-runner dies mid-session, `tryFastRunner` automatically attempts one restart using the session's deviceId. `isFastRunnerAvailable()` now probes process liveness via `kill(pid, 0)` instead of just checking state file (D620).
- **Reload counter + NativeWind corruption warning** — `cdp_status` warns after 5+ `cdp_reload` calls in a session: "NativeWind stylesheet may be corrupted" (D622).
- **Auto-open device session in Phase 5.5** — The 8-phase pipeline skill now mandates opening a device session at verification start, preventing fallback to bash commands (D619).
- **9 new unit tests** for deviceId parsing — covers all 4 agent-device response shapes, UDID regex validation, priority ordering, and edge cases. Test count: 139 → 148 (D625).

### Fixed
- **B103: `cdp_navigate` false success** — Fallback navigation path now verifies the target screen exists in the navigation state after dispatch. Returns error if screen not found in any navigator (D616).
- **B106: `device_scroll`/`device_swipe` deadlock on Reanimated screens** — Routes through fast-runner HID synthesis when available, bypassing agent-device daemon's `waitForIdle` which deadlocks with Reanimated worklets (D610).
- **B107: `deviceId` parsing for agent-device v0.8.0** — Parses `data.device_udid`, `data.id`, and `data.device.id` (when object). Prefers `device_udid` over generic `id`. Validates against UDID regex before `ensureFastRunner` (D611, D618).
- **R2: `device_screenshot` ignores requested path** — Fast-runner screenshot tier now copies the captured PNG to the requested output path instead of always writing to `/tmp` (D617).
- **R5: Scroll amount semantics diverge** — Dropped `* 2` factor in fast-runner scroll computation to match agent-device daemon's interpretation of `amount` (D621).
- **MCP-only proof capture enforcement** — Added "Never use `xcrun simctl` for screenshots" and "Never use `sleep` for settling" to skill boundaries (D624).

### Security
- **hono 4.12.12 → 4.12.14** — Fixes HTML injection in JSX SSR (Dependabot #5). Transitive dep of `@modelcontextprotocol/sdk`.

### Changed
- MCP tool count: 51 → 52 (`cdp_set_shared_value`). CDP tools: 24 → 25.
- Plugin version: 0.21.1 → 0.22.0. MCP server: 0.16.0 → 0.17.0.
- Decisions logged: D610-D625 (16 new).

## [0.21.1] — 2026-04-15

### Fixed
- **MCP tools unavailable in spawned subagents** (GH #31) — Agents split into protocol playbooks (parent-session-only) and spawnable workers.

## [0.19.2] — 2026-04-13

### Fixed
- **MCP server reconnection failure after upgrade** (#30) — Renaming the `mcpServers` key from `rn-dev-agent-cdp` to `cdp` in v0.19.1 broke Claude Code session reconnection. Added upgrade detection in SessionStart hook: compares plugin version against last-seen version, outputs restart notice on upgrade.

### Added
- **Convention D605:** MCP server keys in `plugin.json` must never be renamed in minor or patch versions. Major versions may rename with explicit migration notes.

### Migration from v0.19.1
If CDP tools fail after upgrading, restart Claude Code to reinitialize MCP servers. This is a one-time issue caused by the server key rename in v0.19.1.

## [0.9.0] — 2026-04-02

### Added
- **Experience Engine (Phases A-D)** — self-improving failure pattern learning system:
  - **Phase B: Classification + Retrieval** — normalized error signatures, failure family matching, three-layer experience cascade (seed → project → user), environment fingerprint filtering
  - **Phase B: Ghost Recovery** — auto-recovers FF_STALE_CDP transparently (depth-1 circuit breaker, 30s cooldown, 15s timeout)
  - **Phase C: Compaction + Promotion** — telemetry scanner, candidate generator, auto-promotes ghost recoveries, stale heuristic decay, `rn-agent-compact` command
  - **Phase D: Sharing + Polish** — anonymized export/import, experience health dashboard, `rn-agent-export`, `rn-agent-import`, `rn-agent-health` commands
- **Auto-handle Dev Client picker** (#9) — `cdp_status` detects and dismisses the Expo Dev Client server picker via `device_find`, auto-retries CDP connection after dismissal
- **`FF_DEV_CLIENT_PICKER`** failure family in seed experience

### Changed
- MCP tool count: 25 (unchanged). Command count: 6 → 10 (4 new experience engine commands).
- `cdp_status` refactored: extracted `buildStatusResult()` helper, picker detection in catch block
- `record_proof.sh` standardized video output (#14): always MP4 with `-movflags +faststart`, `ffprobe` validation before copy, graceful fallback preserving correct extension
- All command/skill `.mov` references updated to `.mp4`
- Zod schemas tightened: `count`, `holdMs`, `durationMs`, `amount`, `scale` now have min/max bounds

### Fixed
- **ENAMETOOLONG on marketplace install** (#6) — changed to local source `"./"` in marketplace.json
- **Shell globbing vulnerability** in `androidClipboardFill` — escape `*?[]{}` chars
- **Missing `-s` device serial** in adb calls — added `getAdbSerial()` helper
- **Platform detection gap** — `isAndroidSession()` falls back to `ANDROID_SERIAL` env
- **Misleading `disableDevMenu` fallback** — removed unrelated `setIsDebuggingRemotely` call
- **`ANDROID_SDK_ROOT` not honored** in run.sh — maps to `ANDROID_HOME`
- **Ineffective `ANDROID_SERIAL` export** — persisted to file for cross-process access
- **Inexact package matching** in post-edit health check — exact match with `grep -cxF`
- **Video corruption** (#14) — record to temp, convert on stop, validate with ffprobe
- **Double `.mp4.mp4` extension** — strip any extension before appending .mp4

## [0.8.0] — 2026-03-30

### Added
- **`device_longpress`** — long press by @ref or coordinates with configurable duration. Enables context menus, drag initiation, hold-to-delete.
- **`device_scroll`** — native directional scroll with configurable amount (0-1). Smoother than swipe for list scrolling.
- **`device_scrollintoview`** — scroll until element visible by text or @ref. Works with ScrollView content (FlatList virtualizes, so elements must be rendered).
- **`device_pinch`** — pinch/zoom gesture with scale factor and optional center point. iOS simulator only.
- **`device_press` enhanced** — added `doubleTap`, `count` (repeated taps), and `holdMs` (long press via ref) options.
- **`device_swipe` enhanced** — now supports coordinate-based swipes (`x1,y1,x2,y2,durationMs`) for precise gestures (drag-to-reorder, bottom sheets, pull-to-refresh). Direction shortcut still works, now delegates to native scroll.

### Changed
- MCP tool count: 21 → 25 (4 new device gesture tools).

## [0.7.2] — 2026-03-30

### Added
- **`disableDevMenu` action** for `cdp_dev_settings` (#8) — suppresses shake-to-show dev menu via `DevSettings.setIsShakeToShowDevMenuEnabled(false)`. Auto-called before proof recordings.
- **Pre-recording readiness check** in proof-capture and rn-feature-dev Phase 8 (#8) — verifies valid navigation route (not Dev Client picker) and disables dev menu before recording starts.
- **Dev Client clearState warning** in rn-testing skill (#8) — all Maestro YAML examples updated to not use `clearState:true`.

### Changed
- rn-tester agent Safety Constraints now explicitly forbid `clearState:true` with Dev Client builds.

## [0.7.1] — 2026-03-30

### Added
- **Video label subcommand** (`record_proof.sh label`) — adds timed text labels to proof videos in a dedicated dark bar below the video content. Cross-platform (works on any .mp4). Uses Pillow for rendering, auto-installs in venv if missing.

## [0.7.0] — 2026-03-30

### Added
- **Android emulator readiness script** (`scripts/ensure-android-ready.sh`) — checks boot completion, cleans stale port forwarding, auto-selects `ANDROID_SERIAL`, warns about Play Protect. Runs on SessionStart.
- **Android text input workaround** — `device_fill` auto-detects Android sessions and chunks long/special-char strings into safe 10-char segments via `adb shell input text`.
- **Android app installation check** in post-edit health check — verifies `expo.android.package` via `adb shell pm list packages`.
- **Android-Specific Testing Rules** section in rn-testing skill — maestro-runner enforcement, text input best practices, boot timing, Play Protect.
- **2 new failure families** — `FF_MAESTRO_GRPC_ANDROID` and `FF_ANDROID_TEXT_INPUT_CRASH` in seed experience.
- **3 new platform quirks** — `PQ_ANDROID_MAESTRO_GRPC`, `PQ_ANDROID_TEXT_INPUT_CRASH`, `PQ_ANDROID_PLAY_PROTECT`.

### Changed
- **maestro-runner enforced on Android** — all agents (rn-tester, rn-debugger) and skills now require maestro-runner over classic Maestro for Android flows. Classic Maestro's gRPC driver is unreliable (upstream #998).
- All Maestro commands now include `--platform` flag explicitly.

### Fixed
- **Maestro gRPC UNAVAILABLE on Android** (#7) — bypassed by enforcing maestro-runner which uses HTTP to UIAutomator2 instead of gRPC.
- **`mobile_type_keys` crashes app on Android** (#7) — special characters and long strings now auto-chunked.

## [0.6.1] — 2026-03-30

### Fixed
- **ENAMETOOLONG on marketplace install** (#6) — repo renamed from `react-native-dev-claude-plugin` to `rn-dev-agent`, shortening marketplace qualifier from 39 to 21 chars on every cached path.
- Shortened 9 long reference filenames in `skills/rn-best-practices/references/` (max 42 → 31 chars).
- Updated all internal references: plugin.json, marketplace.json, README install commands, troubleshooting, and source clone instructions.

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
