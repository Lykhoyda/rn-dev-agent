# Known Bugs & Issues

## Open

### B1: Network.enable may silently succeed on RN < 0.83
**Severity:** Medium
**Description:** Hermes accepts `Network.enable` without error on older RN versions, but doesn't emit events for JS fetch/XHR traffic. The bridge sets `networkMode = "cdp"` and skips the fallback hook, resulting in empty network logs.
**Workaround:** The fetch/XHR hook fallback (`NETWORK_HOOK_SCRIPT`) exists but is only injected when `Network.enable` throws. May need to always inject both and merge results.
**Status:** Open — needs testing with RN < 0.83

### ~~B2: waitForReact timeout may be too short for cold starts~~
**RESOLVED** — Increased to 30s (D54). Logs warning when timeout fires.

### B3: Navigation state fallback relies on brittle internal fiber state
**Severity:** Medium
**Description:** The React Navigation fiber walk fallback accesses `memoizedState.memoizedState[0]` which is an internal implementation detail. May break across RN/React Navigation versions.
**Workaround:** Primary paths (Expo Router global + React Navigation DevTools) are stable. Fiber fallback is last resort.
**Status:** Open — monitor across React Navigation versions

### B4: Store detection does not cover Jotai
**Severity:** Medium
**Description:** Architecture docs mention Jotai support but only Redux (auto-detect + global) and Zustand (explicit global) are implemented.
**Workaround:** Use `cdp_evaluate` to manually query Jotai atoms.
**Status:** Open — add Jotai support in future iteration

### B5: cdp_evaluate is an unrestricted JS execution surface
**Severity:** Medium (by design)
**Description:** Any agent prompt reaching cdp_evaluate can read app state, mutate runtime, or exfiltrate data. This is intentional for a local dev tool but should be documented.
**Workaround:** Only used in trusted local dev environments. Documented in README troubleshooting.
**Status:** Accepted risk — document clearly

## Resolved

### B6: Disconnected client could steal CDP session via reconnect (CRITICAL)
**Fixed:** Added `disposed` flag to CDPClient. `disconnect()` sets it and removes WS listeners. Reconnect handler checks `disposed` before attempting.

### B7: Event handlers duplicated on each reconnect (HIGH)
**Fixed:** `setup()` now calls `eventHandlers.clear()` before `setupEventHandlers()`.

### B8: errorCount reported string length instead of error count (HIGH)
**Fixed:** Changed to `JSON.parse(__RN_AGENT.getErrors()).length`.

### B9: cdp_dev_settings actions were incorrect (HIGH)
**Fixed:** Updated to use correct RN DevSettings APIs.

### B10: No auto-build on npm install (HIGH)
**Fixed:** Added `"prepare": "tsc"` to package.json.

### B11: evaluate() always returned undefined due to wrong CDP message nesting (CRITICAL)
**Fixed:** `handleMessage` resolved with full `msg` instead of `msg.result`. All evaluate calls received `{ value: undefined }` and never detected exceptions. Fixed by resolving with `msg.result` (D52).

### B12: Store state tool rejected valid state containing 'error' key (HIGH)
**Fixed:** Changed injected helper to use `__agent_error` sentinel. Valid Redux/Zustand state with `error` keys now passes through correctly (D55).

### B13: Reload tool entered 15s polling loop on silent evaluate failure (HIGH)
**Fixed:** Now checks `result.error` before entering reconnection polling (D60).

### B14: Status probe abandoned all probes on first failure (HIGH)
**Fixed:** Each status probe in the batched IIFE now has its own try/catch (D53).

## Security Fixes (2026-03-10)

### B15: CDP auto-discovery accepted non-loopback WebSocket URLs (HIGH)
**Fixed:** Added hostname filter accepting only `127.0.0.1` and `localhost` after IPv6 normalization (D106).

### B16: Tar extraction vulnerable to path traversal (HIGH)
**Fixed:** Pre-extract listing scan rejects `..` components and absolute paths. Post-extract symlink scan rejects absolute and `../` traversal targets (D108).

### B17: Hardcoded /tmp paths vulnerable to symlink races (MEDIUM)
**Fixed:** Replaced with `mktemp -d` + EXIT trap in both `expo_ensure_running.sh` and `eas_resolve_artifact.sh` (D111).

### B18: BUNDLE_ID and PROFILE unsanitized in shell commands (MEDIUM)
**Fixed:** Regex validation with hard-fail: BUNDLE_ID `^[a-zA-Z][a-zA-Z0-9_.]*$`, PROFILE `^[a-zA-Z0-9_-]+$` (D109, D110).

## Compatibility Fixes (2026-03-11)

### B19: CDP target filter misses RN 0.76+ Bridgeless targets (HIGH)
**Fixed:** Bridgeless mode targets lack `vm: "Hermes"` field, using `title: "React Native Bridgeless [C++ connection]"` instead. Updated filter to match both (D142).

### B20: Navigation state not found on Bridgeless mode (MEDIUM)
**Fixed:** Fiber walk for NavigationContainer fails in Bridgeless builds. Added `__NAV_REF__.getRootState()` fallback (D143).

### B21: DevSettings.reload undefined in Bridgeless mode (MEDIUM)
**Fixed:** `require()` unavailable in Bridgeless CDP scope. Now uses `__turboModuleProxy("DevSettings")` which exposes all dev menu methods directly (D148).

### B22: Test app MSW incompatible with Expo Babel config (LOW)
**Fixed:** MSW v2 uses `static class blocks` not supported by babel-preset-expo. Removed MSW from app entry. Feed screen shows network error instead of mock data (D146).

## Post-Review Fixes (2026-03-12, Gemini + Codex gpt-5.4)

### B23: Auto-reconnect self-blocks on every retry (CRITICAL)
**Fixed:** `reconnect()` called `autoConnect()` which rejected when `reconnecting=true`. Extracted internal `discoverAndConnect()` method (D151).

### B24: _helpersInjected set true even when injection fails (HIGH)
**Fixed:** Now only set after successful evaluate + verification probe (D152).

### B25: safeStringify truncates mid-JSON producing invalid JSON (HIGH)
**Fixed:** Truncated output wrapped in valid JSON envelope with `__agent_truncated`, `preview`, `originalLength` (D153).

### B26: evaluateAsync memory leak on timeout + false timeout on non-serializable (MEDIUM)
**Fixed:** Deferred cleanup timer inside Hermes (10s) as fallback. Values serialized to JSON inside Hermes before storing in global slot (D154).

### B27: sendWithTimeout leaks pending entry if ws.send() throws (MEDIUM)
**Fixed:** Wrapped `ws.send()` in try/catch, cleans up timer and pending map on failure (D155).

### B28: Network hook messages evict real console logs from ring buffer (MEDIUM)
**Fixed:** `__RN_NET__:` prefix detected before pushing to console buffer, not after (D156).

### B29: XHR hook only listens to loadend, missing error/abort/timeout (MEDIUM)
**Fixed:** Added listeners for `load`, `error`, `abort`, `timeout` with dedup guard (D157).

### B30: Bridgeless reload resets JS context but WS stays open — helpers lost (HIGH)
**Fixed:** Reload tool now detects missing `__RN_AGENT` and calls `reinjectHelpers()` (D158).

### B31: togglePerfMonitor throws on Bridgeless TurboModule (LOW)
**Fixed:** Graceful degradation with fallback method names (D159).

### B32: Socket leak on connectToTarget retry (MEDIUM)
**Fixed:** If connectWs() succeeded but setup() failed, stale socket not closed before retry. Now cleaned up in catch block (D161).

### B33: Reload falsely reports success on unexpected errors (MEDIUM)
**Fixed:** Catch block was too broad — swallowed all eval errors, not just expected WS disconnects. Narrowed to only expected disconnect/timeout patterns (D162).

### B34: Store-state handler used stale truncation detection (LOW)
**Fixed:** Handler checked for old `...[TRUNCATED]` suffix after safeStringify was updated to `__agent_truncated` envelope. Updated to match new contract (D160).

### B35: BFS double-enqueue of child siblings in filtered tree search (MEDIUM)
**Fixed:** Filtered BFS loop enqueued `fiber.child`, iterated `fiber.child.sibling` chain, AND enqueued `fiber.sibling`. The sibling loop was redundant, inflating scan count and wasting the 2000-node budget. Removed inner loop (D170).

### B36: Shared WeakSet across multi-match subtree walks (HIGH)
**Fixed:** All matched subtrees shared a single `visited` WeakSet. The 2nd+ matches were silently pruned if they shared any ancestor/descendant nodes with earlier matches. Now each subtree walk gets a fresh WeakSet (D171).

### B37: Unguarded JSON.parse in interact handler (MEDIUM)
**Fixed:** `JSON.parse(result.value)` threw raw SyntaxError on malformed Hermes response, with no context about which tool failed. Now wrapped in try/catch (D172).

### B38: warnResult meta spread order (LOW)
**Fixed:** `{ warning, ...meta }` let caller meta overwrite the warning param. Reversed to `{ ...meta, warning }` (D173).

### B39: symbolicate clearTimeout leak (LOW)
**Fixed:** `clearTimeout` only called on successful fetch path. Moved to `finally` block (D174).

### B40: dismissRedBox silent false "ok" (MEDIUM)
**Fixed:** All 4 fallback tiers failing returned "ok", giving the agent false confirmation. Now returns "no_method_available" and the handler surfaces a `warnResult` (D164).

## External Review Fixes (2026-03-12, Gemini + Codex Round 2)

### B46: Filtered BFS uses binary tree traversal pattern (MEDIUM)
**Fixed:** `queue.push(fiber.child); queue.push(fiber.sibling)` processes siblings after children, not at the same level. Replaced with sibling chain iteration for true BFS ordering (D175).

### B47: interact findFiber depth limit breaks on deep Fabric apps (MEDIUM)
**Fixed:** `depth > 50` guard insufficient for Fabric apps with 75+ layers. Replaced with `findCount > 5000` node count limit (D176).

### B48: Unguarded JSON.parse in error-log handler (MEDIUM)
**Fixed:** `JSON.parse(result.value)` could throw raw SyntaxError on malformed Hermes response. Wrapped in try/catch with descriptive error (D177).

### B49: dismissRedBox doesn't dismiss native RedBox overlay (MEDIUM)
**Fixed:** Only cleared JS LogBox state. Added native dismiss tiers via `DevSettings.dismissRedbox()` for both TurboModule and legacy require paths (D178).

### B50: togglePerfMonitor false success when unavailable (MEDIUM)
**Fixed:** Returned `"not_available"` but handler only checked `"no_method_available"`. Unified sentinel string and generalized warning (D179).

### B51: Symbolication regex misses Hermes `name@url:line:col` format (MEDIUM)
**Fixed:** Added `HERMES_ATSIGN_RE` pattern to match Firefox-style stack frames alongside existing V8-style format (D180).

### B52: Error handlers accumulate on helper reinjection (MEDIUM)
**Fixed:** ErrorUtils handler saved agent's own wrapper as `origHandler`, and rejection tracker re-registered on each injection. Now saves app's original handler once, guards tracker with flag, shares errors array across versions (D181).

### B41: reconnecting flag not cleared on successful reconnect (HIGH)
**Fixed:** `reconnecting` flag stayed `true` during entire reconnect loop. If the new connection dropped before `.finally()` ran, close events were silently dropped. Now `reconnect()` clears the flag immediately on success/failure/dispose, and `.finally()` is removed in favor of explicit flag management (D182).

### B42: Code-1006 immediately throws, bypassing inner retries (HIGH)
**Fixed:** Code 1006 (abnormal closure — most common failure: another debugger connected) threw immediately without retrying. Now only "refused" (nothing listening) throws immediately. Code 1006 retries through the full retry loop. Final error includes a hint if the last error was 1006 (D183).

## Benchmark Experiment Fixes (2026-03-12)

### B53: cdp_console_log captures 0 app-level entries in Bridgeless mode (CRITICAL)
**Fixed:** CDP `Runtime.consoleAPICalled` doesn't fire for app-level `console.log` in RN Bridgeless because RN's console polyfill routes through the native bridge. Monkey-patched `console.log/warn/error/info/debug` in injected helpers to capture to `globalThis.__RN_AGENT_CONSOLE__` ring buffer. Tool now reads from injected buffer (D184).

### B54: All tools except cdp_status fail without prior connection (HIGH)
**Fixed:** `withConnection` returned "Not connected. Call cdp_status first." for every tool if `cdp_status` hadn't been called. Now auto-connects, waits for in-progress reconnections (15s), waits for helper injection (5s), and retries once on mid-operation disconnect (D185).

### B55: cdp_interact returns failure when handler throws (MEDIUM)
**Fixed:** `onPress` handler throwing returned `failResult`, but the press DID execute. Now the injected `interact()` returns `{ action_executed: true, handler_error: ... }` for handler throws, and the tool surfaces `warnResult` instead of `failResult` (D186).

## Known Pre-existing Issues (from code review, not yet fixed)

### B43: reinjectHelpers waitForReact exceeds reload budget (MEDIUM)
**File:** tools/reload.ts:34-45. `waitForReact(30s)` can block longer than the 15s reload timeout.

### B44: getAppInfo uses require() on Bridgeless (MEDIUM)
**File:** injected-helpers.ts:509-516. `require()` silently fails in Hermes Bridgeless CDP scope, returning null for platform/version.

### B45: evaluateAsync timeout can exceed stated 5s cap (MEDIUM)
**File:** cdp-client.ts:241-265. Each poll can take 2s, total wall-clock time exceeds the 5s guarantee.

### B56: Expo Go deep link confirmation dialog blocks automated verification (MEDIUM)
**Context:** When `xcrun simctl openurl booted "rndatest://..."` is used to navigate, iOS shows a native "Open in Expo Go?" or "Open in rn-dev-agent-test?" confirmation dialog. This dialog cannot be dismissed programmatically via simctl, AppleScript (without assistive access), or CDP. It blocks the deep link from executing, leaving the agent unable to navigate. Workaround: use `cdp_evaluate` with `globalThis.__NAV_REF__?.navigate(...)` for in-app navigation instead of deep links. Long-term fix: detect the dialog via screenshot analysis or use Maestro's `tapOn` to dismiss it.

### B57: cdp_dev_settings dismissRedBox fails in Expo Go (LOW)
**Context:** All 4 fallback approaches for `dismissRedBox` fail in Expo Go because the `DevSettings` module is not directly accessible via `__turboModuleProxy` or `NativeModules` in the Expo Go sandbox. This only affects Expo Go — dev builds with native modules should work. Pre-existing limitation, not a regression.

### ~~B58: CDP Bridgeless mode connects to wrong JS context (HIGH)~~
**RESOLVED** — Smart target selection now probes `__DEV__` on each candidate target before committing (D248). Targets where `__DEV__` is false are skipped. `cdp_status` also warns when connected to a non-dev context (D249). Phase 5.5 gates on `app.dev === true` (D250).

### B59: maestro-runner v1.0.9 requires adb in PATH for iOS-only testing (HIGH)
**Context:** maestro-runner v1.0.9 checks for `adb` in PATH even when `--driver xcuitest` or `--device` iOS flags are specified. Creating an adb shim script gets past the check but the tool then only looks for Android devices. This prevents E2E test execution on iOS without Android SDK installed.
**Workaround:** Use Maestro CLI (`brew install maestro`) instead of maestro-runner for iOS-only testing.
**Status:** Open — upstream regression in maestro-runner, reported

### ~~B60: MCP server process kill makes CDP tools permanently unavailable (HIGH)~~
**RESOLVED** — Auto-restart bash wrapper (`run.sh`) restarts the MCP server on crash (max 5 within 60s). `plugin.json` changed to use `bash run.sh` instead of direct `node`. Unhandled rejections demoted to non-fatal (D265, D268).

### ~~B61: cdp_reload cannot switch CDP targets (MEDIUM)~~
**RESOLVED** — `cdp_reload` now calls `softReconnect()` after triggering `DevSettings.reload()`, which does full target re-discovery via `discoverAndConnect()` with `__DEV__` probing. Also added `_softReconnectRequested` flag to preempt background reconnect loops (D263, D266).

### ~~B62: Stale CDP target not detected mid-session (HIGH)~~
**RESOLVED** — After initial connection, target staleness (e.g., app reloaded outside agent control, Expo Go context switch) was never re-validated. The WS stayed open but all CDP calls returned stale or error results. Added reactive stale-target probe in `withConnection` catch block: when a non-disconnect error occurs, probes `__DEV__` with 2s timeout and calls `softReconnect()` if stale (D264).

### B63: Stale-target probe only fires on thrown errors, not handler-level failResult (MEDIUM)
**Context:** The reactive stale probe in `withConnection` (Path B) only runs when the handler _throws_ an exception. Most tool handlers (component-tree, evaluate, navigation-state) convert stale-context errors from `client.evaluate()` into `failResult(...)` without throwing. In the common case where `__RN_AGENT` is missing due to a stale target, the handler returns immediately and `softReconnect()` is never attempted.
**Workaround:** The stale probe still catches low-level CDP errors (WebSocket-level, timeout). For helper-level staleness, calling `cdp_status` triggers a fresh auto-connect.
**Status:** Open — architectural change needed (tool handlers should throw on evaluate errors, or withConnection should wrap handler return values)

### B64: markAllSynced race condition — edits during in-flight sync marked as synced (MEDIUM)
**Context:** `handleSync` in TasksScreen dispatches `markAllSynced()` after a successful POST to `/api/tasks/sync`. Because the POST is async, if the user adds/modifies/cycles priority on a task while the request is in flight, those newer changes get incorrectly marked as `synced: true` even though they were not included in the sync payload.
**Fix:** Capture unsynced task IDs before the fetch and pass them to a `markSynced(ids: string[])` reducer, or use optimistic updates.
**Found by:** Gemini + Codex review of S5 implementation.
**Status:** Open — pre-existing behavior, not introduced by S5
