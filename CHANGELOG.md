# Changelog

All notable changes to rn-dev-agent will be documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/).

## [0.33.0] — 2026-04-21

Phase 90 metro-mcp pattern adoption (Tier 1 + Tier 2) plus story-driven bug sweep. MCP server bumped to 0.28.0. Seven PRs merged on main since v0.25.0 without intermediate public releases; v0.33.0 is the first public-release checkpoint for all of it.

### Added
- **`cdp_metro_events` MCP tool** (M5 / D656). Read Metro reporter events (`bundle_build_started` / `bundle_build_done` / `bundle_build_failed`, reloads) captured by the `MetroEventsClient` attached alongside every CDP session. Accepts `limit` / `type` filter / `clearErrors`. Returns `{ eventsConnected, lastBuild, buildErrors, events, count, eventsReason?, hint? }`.
- **`cdp_open_devtools` MCP tool** (M1a / D654). Reports the React Native DevTools frontend URL + whether DevTools can coexist with the MCP session on the current RN version. On RN ≥ 0.85 returns a direct URL (native multi-debugger). On RN < 0.85 returns explicit guidance — full proxy auto-wiring deferred to M1b.
- **`cdp_status.metro` fields `eventsConnected` / `lastBuild` / `buildErrors` / `eventsReason`** (M5 + B129). Surface bundler state and incompatibility reasons. On Expo-managed projects `eventsReason: "expo-cli-incompatible"` is set because Expo CLI hijacks `/events` for its manifest protocol.
- **`cdp_status.capabilities.supportsMultipleDebuggers`** (M1a / D654). True when RN ≥ 0.85.
- **Single-instance MCP lockfile** at `/tmp/rn-dev-agent-cdp-${uid}-${hash}.lock` (M3 / D652). Two Claude Code windows in the same project no longer fight over the single Hermes CDP slot — the second exits with code 11 and an actionable stderr message. `--no-lock` CLI flag for CI parallelism. Three-tier stale-lock reclaim: PID alive (`kill(pid, 0)`) + process name (`ps -p <pid> -o args=`) + mtime < 24h.
- **`cdp_network_log` + `cdp_network_body` gain optional `device` arg** (M4 / D655). Default scope is the active device; pass `"all"` for a chronologically-merged union across every device.
- **`rn-best-practices` rule 5.2** (R7 / D650). Documents the `presentation: 'transparentModal'` blank-white bug on RN 0.76.7 + Bridgeless + react-native-screens 4.4.x and the dark BlurView workaround.

### Changed (behavioral, forward-compatible)
- **Exponential reconnect with jitter** replaces the old linear 1.5s × 30 retry loop (M2 / D653). Curve: `[0, 500, 1000, 2000, 4000, 8000, 16000, 30000, ...]` ±500ms jitter. Attempt 0 returns 0ms so hot-reload reconnects stay instant. Metro CPU wake-ups in the first 60s of an outage drop from ~40 to ~7 attempts (5× less hammering). `interruptibleSleep` polls the dispose / soft-reconnect flags every 500ms so `softReconnect`'s 3s bail window still preempts a 30s cap sleep.
- **`DeviceBufferManager` for network events** is now a process-scoped singleton at `src/cdp/network-buffer-manager.ts` (B128 / D657). Previously owned by `CDPClient`, so `cdp_connect(force:true)` / `cdp_restart` wiped all per-device buffers. Now buffers survive the canonical platform-switch use case. Memory unchanged (100 × 10 = 1000 entries total).
- **Platform inference reads Metro's `deviceName`** before falling back to package-list heuristics (B131 / D660). Dual-install bundles (same `com.example.app` on both iOS sim + Android emulator) are now correctly disambiguated by `"iPhone 17 Pro"` vs `"sdk_gphone16k_arm64 - 17 - API 37"` instead of defaulting to iOS + `ambiguousPlatform: true`.
- **Runner-leak recovery `closeSession` wrapper** now also calls `clearActiveSession()` + `stopFastRunner()` (B130 / D659). Matches the normal close path. Stale fast-runner ref-map no longer survives recovery, so the post-recovery snapshot lands via daemon/CLI (with `@eN` refs) instead of fast-runner (tree-shaped, no refs) — which means `device_fill` / `press` / `find` actually work after recovery fires.

### Fixed
- **B128: per-device buffers wiped on reconnect** — see Changed. Root cause: `DeviceBufferManager` lifetime was tied to CDPClient instance, not MCP process.
- **B129: Expo `/events` endpoint incompatibility surfaces silently** — `MetroEventsClient` now probes HTTP GET `/events` before WS upgrade. If the body matches the Expo manifest shape (`runtimeVersion` string OR `launchAsset.url` string), marks state `'incompatible'` with `eventsReason: "expo-cli-incompatible"` and an actionable hint. Probe failure (timeout / non-200) falls through to WS attempt — doesn't mark incompatible.
- **B130: `device_fill` "No snapshot in session" after runner-leak recovery** — see Changed.
- **B131: `cdp_connect({platform: "android"})` errored with "no matches" on dual-install bundles** — see Changed.
- **M2 multi-review catch: `softReconnect` preemption race at 30s cap** — `interruptibleSleep` polls the dispose/soft-reconnect flags every 500ms so preemption latency stays bounded regardless of the sleep duration.
- **M5 multi-review catches** — double-schedule on initial connect failure (error + close both fired), `start()` during reconnecting double-connected, port mismatch after CDP port change, `stop()` during CONNECTING state crashed the process via unhandled handshake-abort error. All four fixed with targeted regression tests.
- **M3 pre-release multi-review catch**: `ps -p <pid> -o comm=` returned only `"node"` for Node-launched scripts, which meant the `cdp-bridge` needle match would NEVER succeed in production → the lockfile would be a no-op. Switched to `-o args=` which returns the full command line. This bug would have shipped silently without multi-review.

### Performance
- **Unit test suite: 24,246ms → 3,151ms (87% faster)** after adding `skipIncompatibilityProbe: true` to pre-B129 MetroEventsClient tests that use the WS-only mock server. The mock doesn't respond to HTTP GET; every test was paying a 1500ms probe timeout.
- **Screenshot downscale via sips** (B120/D647 from 0.26.0 — first public release). `device_screenshot` auto-resizes to max 800px width via macOS `sips`, saving ~35–46% on iPhone captures with no readability loss.

### Tests
272 → **448** (+176 across the series):
- M3: 14 hermetic unit + 4 real-process regression (stale-lock reclaim, multi-project coexistence, process-name validation against a real child process)
- M2: 8 curve tests + 6 interruptibleSleep tests
- M1a: 7 pure-function + 10 multiplexer integration + 5 tool handler
- M4: 20 DeviceBufferManager tests + updates to 6 pre-existing network-tool tests
- M5: 13 feature + 4 pass-1 regression + 1 pass-2 crash regression
- B128-B131: 4 singleton + 10 Expo detector + 2 recovery-close-wrapper contract + 7 deviceName inference

### Multi-review
Every feature PR and the fix PR went through a 2-pass multi-review (Gemini + Codex in parallel). Pass 1 blockers caught and fixed pre-merge. Three of the M3/M2/M5 blockers would have silently degraded or broken production had they shipped without review. The pattern "hermetic injection for unit coverage + at least one integration test per feature exercising the real default against a real external thing" captured in D652 and reinforced by every subsequent fix.

### Live validation
All three cross-platform validation stories (M4 network isolation, M5 Metro events, device interaction parity) and the B128-B131 fix validation story executed live against both iOS and Android simulators. 8/8 assertions pass in the B128-B131 validation. Artifacts in `docs/stories/*.md` and `docs/proof/*.jpg` in the workspace repo.

### Upgrade notes
- **Required action: restart Claude Code after `/plugin update rn-dev-agent`** to load the new MCP server. `/reload-plugins` alone does not respawn MCP subprocesses.
- **Expected behavior change (B131):** `cdp_connect({platform: "android"})` now succeeds on apps with the same bundleId installed on both iOS and Android. Callers that relied on explicit `targetId` for disambiguation are unaffected — the platform filter is now an additional valid path.
- **Expected behavior change (B128):** network buffers persist across `cdp_connect(force:true)` / `cdp_restart`. To explicitly wipe, call `cdp_network_log({clear: true})` (scoped to active device) or pass `device: "<key>"` for a specific device.
- **Expected behavior change (B129):** on Expo-managed projects, `cdp_status.metro.eventsConnected` is now correctly `false` (previously `true` with silent empty events). Applications watching `lastBuild` should also watch `eventsReason` for the `"expo-cli-incompatible"` signal.
- **Two-window workflow (M3):** opening the same project in two Claude Code windows now exits the second MCP with code 11 and the conflict message. Kill PID or close the other window to resolve.

### Validation matrix
| Area | iOS | Android |
|---|---|---|
| CDP connect + targets | ✅ | ✅ (after B131 fix) |
| Per-device network buffers | ✅ | ✅ |
| Cross-device `'all'` merge | ✅ | ✅ |
| Metro events (Expo → incompatible) | ✅ | ✅ |
| `device_fill` post-recovery | ✅ (B130) | n/a (no runner-leak on Android) |
| `cdp_open_devtools` native mode | n/a (RN 0.76 < 0.85) | n/a |
| Single-instance lockfile | ✅ | ✅ |

### Backlog state
- **Closed:** M3 + M2 + M1a + M4 + M5 + R7 (Phase 85) + B128-B131. Phase 90 Tier 1 + Tier 2 complete.
- **Open (carveouts):** M1b (CDPClient proxy routing — needs live simulator for end-to-end verification); Tier 3 (M6 test recorder, M7 fast-runner liveness, M8 renderer 1..5 loop); Tier 4 (M9–M11 polish).
- **Noted during validation but not blocking:** `cdp_store_state` dot-path resolver breaks on hyphenated Zustand keys; stale `agent-device` daemon sessions (`rn-agent-recovery-*`) persist across MCP boots and cause `DEVICE_IN_USE` on first session open. Workarounds: pass `storeType` without `path`; `agent-device close --session <name>`.

## [0.25.0] — 2026-04-19

Three-PR stability sprint: zombie target disambiguation (B111), MCP process lifecycle hardening (B76 + zombie cleanup), and security documentation (B5). MCP server bumped to 0.20.0. Skipped 0.24.0 because the inter-PR version coordination jumped from 0.23.0 → 0.24.0 (PR #32) → 0.25.0 (PR #33) on main without a public release at the intermediate step.

### Added
- **`cdp_restart` MCP tool** — in-process soft state reset (disconnect + new CDPClient + autoConnect). Recovers from stuck connection state without losing the CC session. Does NOT reload new dist/ — that still requires a full Claude Code restart (B76/D644).
- **`cdp.bundleId` field on `cdp_status`** — surfaces the connected target's `description` (Metro reports the bundleId there) for "which app am I connected to?" debugging (B111/D643).
- **README `## Security` section** — documents that `cdp_evaluate` runs unrestricted JS in the app's Hermes runtime; recommends local-dev-only usage and treating the agent like a developer with shell access (B5/PR #34).

### Fixed
- **B111 (CRITICAL — silent data corruption): CDP target selection picked zombie over fresh app target.** `selectTarget` now hard-fails on explicit `targetId` / `bundleId` mismatch with actionable warnings listing available ids/descriptions; `autoConnect` auto-populates `preferredBundleId` from `resolveBundleId(platform)`; bundleId/preferredBundleId matching is case-insensitive; deterministic sort tie-break (page-id desc → preferredBundleId-matched first → ascending lex by full id) (D643).
- **B76: MCP server cannot be restarted within a session** — fixed via the new `cdp_restart` tool for in-process reset. SIGUSR2 handler retained for future supervisor wiring (CC does not auto-respawn MCP subprocesses today) (D644).
- **MCP zombie subprocesses surviving parent CC quit** — root cause: the 5s `setInterval` background Metro poll held the Node event loop alive indefinitely when CC closed stdin without SIGTERM. New `lifecycle/graceful-shutdown.ts` factory funnels SIGTERM/SIGINT/SIGHUP/SIGUSR2/`stdin.end`/`uncaughtException` into a single idempotent shutdown path (clears bgPoll → disconnects CDP → stops fast-runner → exit) with a 3s timeout race for stuck cleanup (D644).
- **`CDPClient.disconnect()` race safety** — added 2-line idempotent guard so concurrent `cdp_restart` + signal-shutdown don't race (D644).
- **Latent production bug surfaced by CI: `setTimeout(...).unref()` on the load-bearing graceful-shutdown timeout** meant the timer wouldn't fire when the event loop had no other work, defeating its purpose. Removed `.unref()` so the timer always keeps the loop alive long enough to force-exit (D644 follow-up).

### Verified-stale (closed via empirical sweep, no code change in this release)
- **B73 (HIGH): MCP dies on Metro restart** — verified empirically already fixed by historical reconnect loop + background poll pattern (D622). MCP survives Metro death and auto-reconnects when Metro returns.
- **B84, B100, B110, B112** — fixes had already shipped through earlier hardening phases; BUGS.md was stale.
- **All Phase 85 R-stories (R1-R10 except R7)** — closed; R7 (transparentModal) noted as react-native-screens upstream.

### Tests
249 → **272** (+23). New: 10 for B111 (selectTarget hard-fail, case-insensitive, deterministic sort tie-break, discoverAndConnect throw-on-empty); 13 for B76 (gracefulShutdown factory + cdp_restart handler, including a concurrent-race test that proves idempotency under parallel invocation).

### Multi-review
PRs #32 (B111) and #33 (B76) reviewed independently by Gemini + Codex. PR #32: 0 high-confidence issues. PR #33: 1 important (SIGUSR1 → SIGUSR2 to avoid Node `--inspect` collision) + 3 advisories — all 4 applied as follow-ups before merge.

### Upgrade notes
- Restart Claude Code after `/plugin update rn-dev-agent` to pick up the new MCP server (`/reload-plugins` does NOT restart MCP subprocesses).
- New tool `cdp_restart` is available immediately. Use it for in-session state reset without losing CC context. Loading new `dist/` after `npm run build` still requires a full CC quit + reopen.
- **Behavioral change (B111):** callers that previously passed an explicit `targetId` or `bundleId` that didn't match any target used to silently connect to whatever sorted first; now they get a clear error with the available ids/descriptions listed. Any caller relying on the old silent-fallthrough behavior was already getting wrong data — the new error is strictly better.
- **Behavioral change (B76):** SIGINT, SIGHUP, and stdin EOF now route through graceful shutdown (previously only SIGTERM). Subprocess termination is cleaner; no zombie MCP processes after CC quit.

### Validation
- 5-gate live smoke for B76 fix (CC restart → `cdp_restart` tool present → invocation → MCP PID unchanged) — all green.
- 4-gate live smoke for B111 fix (kill Metro test → bad targetId reject → bad bundleId reject → auto-select picks live target) — all green.
- B73 verification trace at `docs/proof/b73-b76-mcp-lifecycle/b73-verification.log` in the workspace repo.

### Backlog state
Plugin code-side stability backlog effectively cleared after this release. All Phase 85 R-stories closed (R7 deferred as upstream). Remaining open items in BUGS.md are out-of-scope for plugin code (workspace test-app cosmetic, environmental Hermes/Android, accepted-tradeoff items).

## [0.23.0] — 2026-04-16

Major session of correctness and performance fixes surfaced by end-to-end benchmarks and a live feature-dev run. MCP server bumped to 0.18.0.

### Added
- **`cdp_native_errors` MCP tool** — reads `xcrun simctl log show` on iOS / `adb logcat -d` on Android, parses known native-module / bundle-fetch / FATAL EXCEPTION patterns, dedupes by message body. Fills the gap when `cdp_error_log` / `cdp_console_log` stay empty because native errors fired before `__RN_AGENT` injected. `cdp_status` also emits a suspicion hint pointing at this tool when `connected && !helpersInjected && !hasRedBox && errorCount === 0` (B114/D642).
- **`targetId` + `bundleId` filters on `cdp_connect`** — disambiguate zombie Expo Go host pages from real app targets (B111/D635).
- **`attachOnly: true` on `device_snapshot`** — skip app launch when it's already running; verifies via `xcrun simctl spawn booted launchctl list` / `adb shell pidof`. Prevents the ~12s app-restart cascade. Exported `isAppRunning(platform, bundleId, probes?)` helper (B112/D641).
- **Platform-aware CDP timeouts** — `defaultTimeout(platform)` and `timeoutForMethod(method, platform)` apply a 2× Android multiplier via a single constant `ANDROID_MULTIPLIER`. `CDPClient` routes `Runtime.evaluate` paths through it using `this._connectedTarget?.platform`. iOS unchanged (B118/D637).
- **`platform` param on `device_screenshot`** — inherits from `client.connectedTarget?.platform` or accepts explicit override. When no active session is open, the wrapper appends `--platform <p>` to agent-device CLI args. Session-bound dispatch remains the canonical path (B117/D638, partial — upstream agent-device CLI ignores `--platform` without a session; workaround via open session).
- **`simctl listapps` cross-check in platform inference** — `cdp/discovery.ts::inferPlatforms` now reads both `adb shell pm list packages` AND `xcrun simctl listapps booted`; targets installed on both platforms are flagged with `ambiguousPlatform: true`. Readers are injectable for unit testing (B116/D639).
- **Tab-dispatch fix for `cdp_nav_graph`** — `buildTabNavigateArgs(tab, screen, params)` emits the flat `ref.navigate(tab, params)` when target === tab, nested form when they differ. Prevents self-referential `navigate('TasksTab', { screen: 'TasksTab' })` that left RN stuck on the old tab (B115/D640).

### Fixed
- **B110: MCP server reports stale version** — server version now read from `package.json` at module load; `sync-versions.sh` gained a regex guard against hardcoded `version:` literals in src/ (D630).
- **B113: `device_screenshot --format` always rejected** — agent-device >= 0.8.0 doesn't accept `--format`. Refactored into `buildScreenshotArgs()` + thin delegate; now uses `--out <path>` explicitly, extension drives encoding (D636).
- **Freshness probe caching** — 2s TTL per `connectionGeneration`, WeakMap-keyed. Saves 30-150ms per back-to-back tool call by skipping redundant `__RN_AGENT.__v` round-trips (D631).
- **Structured error codes on `ResultEnvelope`** — `ToolErrorCode` union (`STALE_TARGET`, `HELPERS_STALE`, `RECONNECT_TIMEOUT`, `NOT_CONNECTED`, `HELPERS_NOT_INJECTED`). Agents can branch on `code` instead of regex on error text. Back-compat preserved (D634).
- **Extracted `cdp/recovery.ts`** — `probeFreshness()` + `recoverFromStaleTarget()` moved out of `utils.ts`. Replaced error-string matching for stale detection with the `__RN_AGENT.__v` probe as the primary signal (D633).
- **`RingBuffer` requestId index** — optional `indexKey` extractor builds a parallel `Map<key, item>`; `getByKey(id)` is O(1). Swapped 5 call sites (`event-handlers.ts` ×4, `tools/network-body.ts` ×1) from `findLast` → `getByKey` (D632).

### Refactors
- **CDP module extraction continued** — `cdp/connect.ts` (213 lines), `cdp/helper-expr.ts`, `cdp/recovery.ts` (99 lines). CDPClient facade shrunk further; every module now has a typed Context interface instead of reaching into the facade directly.
- **`cdp/state.ts` setter-based `ResettableState` interface** — replaces `as unknown as CDPResettableState` cast. Renaming a private field on `CDPClient` now produces a real TypeScript error.

### Benchmarks validated live

Cross-platform benchmark (Task Power User flow + Priority Filter Row feature):
- **iOS (iPhone 17 Pro, iOS 26.3)**: 3.37s / 29 calls / 0 failures (`cdp_interact` p50 7ms)
- **Android (Pixel_9_Pro, API 37) pre-fix**: 16.11s / 32 calls / 3 failures (incl. 5.3s `typeText` timeout)
- **Android post-fix**: ~7.2s / 24 calls / 0 failures — **55% faster, zero false-negative timeouts** (`cdp_interact` p50 16ms, p95 45ms)

### Test count
158 → **249** (+91 this release cycle).

### Decisions logged
D630 through D642 in `rn-dev-agent-workspace/docs/DECISIONS.md`.

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
