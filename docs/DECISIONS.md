# Architectural Decisions

## 2026-03-09: Initial Implementation

### D1: Use 127.0.0.1 instead of localhost for Metro discovery
Node 18+ defaults to IPv6 for `localhost`, which can fail if Metro only binds IPv4. Using `127.0.0.1` directly avoids DNS resolution ambiguity.

### D2: Filter ring buffers before applying limit
Gemini review identified that applying `getLast(limit)` before filtering discards relevant entries. Now we filter the entire buffer first, then slice to limit.

### D3: Reject all pending CDP promises on WebSocket close
When the WebSocket closes (reload or crash), pending `Runtime.evaluate` calls would hang until their 5s timeout. Now we immediately reject them on close to prevent cascading delays.

### D4: Capture text nodes (tag 6) in fiber tree walker
React Fiber text nodes have `tag === 6` and store their text in `memoizedProps` as a string. Without capturing these, the agent cannot read any screen text. Added early return for text nodes in the `walk()` function.

### D5: Extract accessibilityLabel alongside testID
Many RN apps use `accessibilityLabel` for e2e testing. The fiber tree walker now captures `testID`, `accessibilityLabel`, and `nativeID`.

### D6: Catch expected errors in reload()
`DevSettings.reload()` kills the JS bundle, closing the WebSocket. The `evaluate()` call throws because the WS closes. Wrapping in try/catch prevents aborting the reconnect sequence.

### D7: MCP server uses zod schemas from @modelcontextprotocol/sdk
The SDK v1.12+ uses zod for tool parameter validation. All tool definitions use `z.string()`, `z.number()`, `z.boolean()`, `z.enum()` with `.default()` and `.optional()`.

### D8: Single CDPClient instance, mutable global
The MCP server uses a single `let client` that can be reassigned when the user overrides the Metro port. Previous client is disconnected before replacement.

## 2026-03-09: Codex Review Fixes

### D9: disposed flag prevents reconnect on disconnect()
When a CDPClient is discarded (e.g., port override), `disconnect()` sets `disposed = true` and removes all WS listeners. The reconnect handler checks `disposed` before attempting reconnection, preventing a discarded client from stealing Hermes' single CDP session.

### D10: Clear event handlers before re-setup on reconnect
`setup()` now calls `this.eventHandlers.clear()` before `setupEventHandlers()` to prevent duplicate console/network/Debugger.paused handlers from accumulating across reconnects.

### D11: errorCount uses JSON.parse to count actual errors
`__RN_AGENT.getErrors()` returns a JSON string. Previously `.length` counted string characters. Now uses `JSON.parse(__RN_AGENT.getErrors()).length` for correct error count.

### D12: cdp_dev_settings uses correct RN APIs
`toggleInspector` now calls `DevSettings.toggleElementInspector()`. `dismissRedBox` now calls `LogBox.clearAllLogs()` instead of `ignoreLogs("")`. `togglePerfMonitor` calls `DevSettings.toggleFpsMonitor()`.

### D13: prepare script auto-builds on npm install
Added `"prepare": "tsc"` to package.json so `npm install` automatically compiles TypeScript to dist/.

### D14: hasErrorOverlay walks siblings for complete RedBox detection
The RedBox detection function now checks both child and sibling fibers, catching error overlays that are siblings of the main tree root.

## 2026-03-09: Phase 1 Rebuild (Gemini + Codex Review)

### D15: Clean architecture with tools/ directory
Tool handlers live in separate `src/tools/*.ts` files using a factory pattern (`createStatusHandler(getClient)`). This keeps `index.ts` under 60 lines and makes Phases 2-3 purely additive (new file + 2 lines in index).

### D16: connectWs settled guard prevents reconnection race
WebSocket `close` event fires even if `open` never did (e.g., ECONNREFUSED). A `settled` boolean prevents the `close` handler from triggering `handleClose` (and its reconnect loop) when the connection was never established. Only the active `this.ws` triggers reconnect.

### D17: 1006 close code triggers reconnect
React Native bundle reloads commonly produce WebSocket close code 1006 (abnormal). The original architecture blocked reconnect on 1006, but both Gemini and Codex identified this as a critical flaw. Now 1006 triggers the same reconnect path as 1001.

### D18: Timer cleanup in Metro discovery via finally block
`clearTimeout(timer)` moved to a `finally` block in the port scanning loop. If `fetch` rejects before the timeout fires, the timer is still cleaned up, preventing dangling timers.

### D19: Connection generation tracking for reload verification
`CDPClient` tracks a `_connectionGeneration` counter incremented on each successful `autoConnect`. The reload tool compares generation before/after to verify it reconnected to a NEW session, not the stale one.

### D20: Network hook fallback wired to networkBuffer
Console messages prefixed with `__RN_NET__:` are parsed in `handleMessage` and routed to `_networkBuffer` as proper `NetworkEntry` objects. This connects the RN < 0.83 fetch/XHR hook fallback to the same buffer used by CDP Network domain events.

### D21: Helper injection errors are checked and logged
`setup()` now inspects `EvaluateResult.error` after injecting helpers and network hooks. Failures are logged via `console.error` so the developer can diagnose injection failures.

### D22: textResult/errorResult helpers for MCP response typing
TypeScript requires `type: 'text' as const` for MCP SDK compatibility. Helper functions `textResult()` and `errorResult()` in `types.ts` provide correctly typed response builders, preventing the `string is not assignable to "text"` error across all tool handlers.

## 2026-03-09: Phase 2 Review Fixes (Gemini + Codex)

### D23: clearErrors evaluate result must be checked
`__RN_AGENT.clearErrors()` can fail if helpers were evicted by a reload. The tool now checks `clearResult.error` before reporting success, preventing false positives.

### D24: Tool handlers parse helper return shapes
Injected helpers return different JSON shapes: `{error}`, `{warning, message}`, `{tree, totalNodes}`. Tool handlers now parse the JSON and route `{error}` to `errorResult()` and `{warning: 'APP_HAS_REDBOX'}` to a structured warning, instead of passing raw JSON through blindly.

### D25: Filter check uses !== undefined instead of truthiness
`args.filter ? ... : 'undefined'` would treat an empty string `""` as falsy and pass `undefined` to the helper. Changed to `args.filter !== undefined` so empty strings are correctly forwarded.

### D26: Error log validates Array.isArray before .length
`JSON.parse(result.value)` could return a non-array if the helper is corrupted or returns an error object. Added `Array.isArray(parsed)` guard before accessing `.length`.

### D27: Depth schema uses .int().min(1).max(6)
Zod schema for `cdp_component_tree` depth parameter now enforces integer constraint and min/max bounds at the validation layer, preventing fractional or out-of-range values from reaching the helper.

### D28: awaitPromise not needed for synchronous helpers
All injected helper functions (`getTree`, `getNavState`, `getErrors`, `clearErrors`) are synchronous — they use `JSON.stringify` and return strings immediately. Adding `awaitPromise: true` would add unnecessary overhead. This was flagged as HIGH by Gemini but determined to be a false positive after code review.

## 2026-03-09: Phase 3 Data Layer (Gemini + Codex Review)

### D29: Console log level alias mapping (warn → warning)
CDP `Runtime.consoleAPICalled` uses `"warning"` as the type string for `console.warn()`, but the MCP schema exposes `"warn"` for user-friendliness. A `LEVEL_ALIASES` map normalizes `"warn"` → `"warning"` before filtering. Both Gemini and Codex flagged this independently.

### D30: Internal __RN_NET__ messages filtered from console output
When `networkMode === 'hook'`, the fetch/XHR monkey-patches emit `__RN_NET__:` prefixed console messages for internal transport. These are now filtered out before returning console entries to prevent internal telemetry from polluting user-facing logs.

### D31: Store state handles truncated JSON and null values
`safeStringify()` in injected helpers truncates JSON >30KB with `...[TRUNCATED]`, producing invalid JSON. The store-state handler now detects the truncation marker and returns a structured warning instead of crashing. Additionally, `JSON.parse` of `"null"` is handled safely — the error shape check now verifies `parsed !== null && typeof parsed === 'object'` before accessing `.error`.

### D32: dismissRedBox uses LogBoxData.clear()
`LogBox` module has no `.dismiss()` method. Changed to `require("react-native/Libraries/LogBox/Data/LogBoxData").clear()` which properly clears the LogBox overlay UI.

### D33: dev-settings reload only succeeds on confirmed disconnect
Previously, any thrown error during `reload` was treated as success. Now the catch clause checks for WebSocket-specific disconnect messages (`WebSocket closed` or `WebSocket not connected`) before reporting success, preventing false positives from timeouts or other transport failures.

### D34: Network hook fallback adds URL/method defaults
`parseNetworkHookMessage` now applies `?? 'GET'` and `?? ''` fallbacks for `method` and `url` fields from hook payloads, preventing `TypeError` when `cdp_network_log` filters by URL on malformed entries.

## 2026-03-09: Phase 4 Skills (Gemini + Codex Review)

### D35: iOS log stream uses predicate, not --level error
macOS `log` command's `--level` flag only accepts `default`, `info`, `debug`. To filter errors, use `--predicate 'logType == error'` instead of the invalid `--level error`.

### D36: Android gzipped screenshot requires -p flag
`screencap` without `-p` outputs raw RGBA buffer, not PNG. Using `screencap -p | gzip -1` ensures valid PNG data goes through the gzip pipe.

### D37: UIAutomator parser includes content-desc for RN elements
In React Native on Android, `accessibilityLabel` and `testID` map to `content-desc` XML attribute. The parser now includes `content-desc` in both extraction and the filter condition.

### D38: Maestro inputText, not typeText
Maestro's command for typing text is `inputText`, not `typeText`. The `scrollUntilVisible` command requires an `element:` wrapper in its YAML structure.

### D39: snapshot_state.sh marked as Phase 6 planned
The script is referenced in skills but not yet created. Skills now clearly mark it as Phase 6 planned work to avoid confusion about missing files.

## 2026-03-09: Phase 5 Agents + Commands (Gemini + Codex Review)

### D40: Debugger data gathering is two-phase, not fully parallel
`cdp_status` must complete first (it auto-connects and initializes helpers) before other CDP tools can be called. Step 2 is now: cdp_status first, then parallel evidence gathering.

### D41: Agent prompts discover app ID dynamically
Agents now instruct to find bundle ID from `app.json`, `app.config.js`, or `android/app/build.gradle` in Step 1, rather than using hardcoded `com.example.app`.

### D42: Tester uses git diff to discover changed files
Step 1 now uses `git diff HEAD~1 --name-only` or `git diff --staged --name-only` to discover which source files were changed, rather than assuming the agent knows.

### D43: hooks/hooks.json deferred to Phase 6
The plugin manifest no longer references `hooks/hooks.json` since the file doesn't exist yet. It will be added in Phase 6 when the SessionStart hook is implemented.

### D44: cdp_connect replaced with cdp_status
The agent prompt referenced a non-existent `cdp_connect` tool. All connection is handled through `cdp_status` which auto-connects.

## 2026-03-09: Phase 6 Review Fixes (Gemini + Codex)

### D45: uiautomator dump to device file instead of /dev/stdout
`adb shell uiautomator dump /dev/stdout` prepends a status message (`UI hierarchy dumped to: /dev/stdout`) to the output, corrupting the XML. Changed to dump to `/data/local/tmp/uidump.xml` on device, then `adb exec-out cat` the file and clean up afterward.

### D46: Python XML parser exits non-zero on failure
Previously the Python parser caught exceptions and wrote `{"error": ...}` (an object) while exiting 0. Downstream code expects an array. Now logs the error to stderr, outputs `[]` (empty array), and exits with code 1 so the shell can detect the failure.

### D47: Trap-based cleanup for background jobs
`set -e` with separate `wait` calls left orphaned processes when the first `wait` failed. Added a `trap cleanup EXIT` that kills and waits all background jobs. Individual `wait` calls now capture exit codes without triggering `set -e` abort, and report warnings for partial failures.

### D48: Multi-device warning for Android
When multiple Android devices/emulators are connected, `adb` commands fail with "more than one device/emulator". The script now counts connected devices and warns the user to set `ANDROID_SERIAL` env var if multiple are detected.

### D49: app.config.ts added to hook detection conditions
Expo projects using TypeScript config files (`app.config.ts`) were not detected by the SessionStart hook. Added `file_exists:app.config.ts` to the OR condition.

## 2026-03-10: Phase 1 Redo (feature-dev + Gemini Review)

### D50: withConnection() wrapper eliminates tool handler boilerplate
All 9 tool handlers (except status) had identical connection check, helpers check, and try/catch patterns. Extracted `withConnection<T>(getClient, handler, options)` in `utils.ts` that handles all three concerns. Tool handlers now only contain business logic.

### D51: textResult/errorResult moved from types.ts to utils.ts
Utility functions don't belong with type definitions. Created `utils.ts` with `textResult`, `errorResult`, `withConnection`, and the `ToolResult` type.

### D52: CRITICAL — resolve msg.result not msg in handleMessage
`sendWithTimeout` was resolving with the full CDP message (`{ id, result: { result: { value }, exceptionDetails } }`). `evaluate()` cast the result expecting the inner payload but accessed the wrong nesting level — `result.exceptionDetails` and `result.result.value` were always undefined. Fixed: `pending.resolve(msg.result)`. Gemini review HIGH #1.

### D53: Batched status probes into single evaluate call
`cdp_status` previously made 4 sequential `Runtime.evaluate` calls. Replaced with a single IIFE that gathers all status data in one round-trip. Each probe has its own try/catch so one failure doesn't block others. ~4x faster status checks.

### D54: REACT_READY_TIMEOUT_MS increased from 8s to 30s
Bug B2 — cold starts can take 30-60s for first Metro bundle. Increased timeout and added console.error log when timeout fires so developers know helpers were injected into a potentially unready environment.

### D55: Store state uses __agent_error sentinel instead of error
Valid Redux/Zustand state slices commonly contain `error` keys (e.g., `state.auth.error`). Changed injected helper to use `__agent_error` for agent-level errors. Gemini review HIGH #3.

### D56: /json/list fetch gets AbortController timeout
Metro `/json/list` endpoint had no timeout — could hang indefinitely if Metro accepts connections but the CDP endpoint stalls. Added AbortController with 3s timeout. Gemini review MEDIUM #6.

### D57: Filter targets missing webSocketDebuggerUrl
Targets without `webSocketDebuggerUrl` would cause `new WebSocket(undefined)` TypeError. Added `!!t.webSocketDebuggerUrl` to the filter condition. Gemini review LOW #7.

### D58: Clear connectedTarget on WebSocket close
`handleClose` didn't clear `_connectedTarget`, causing `cdp_status` to report stale device info after disconnection. Now sets `_connectedTarget = null`. Gemini review LOW #8.

### D59: Console log filters internal messages before applying limit
Previously, `getLast(limit)` was called first, then internal `__RN_NET__:` messages were filtered out, potentially returning fewer entries than requested. Now fetches full buffer, filters internal messages, then slices to limit. Gemini review MEDIUM #5.

### D60: Reload tool checks evaluate result before polling
`cdp_reload` ignored `evaluate()` error results (non-throwing failures). If `DevSettings.reload()` failed without throwing, the tool entered a 15s polling loop. Now checks `result.error` and returns immediately on failure. Gemini review HIGH #2.

### D61: Removed declaration:true from tsconfig
MCP server doesn't need `.d.ts` files. Removed to reduce build artifacts.

### D62: Malformed CDP messages now logged instead of silently swallowed
Empty catch block in `handleMessage` replaced with `console.error` logging for debugging.

## 2026-03-10: Phase 2 Redo — Injected Helpers (Gemini Review)

### D63: Fiber walk functions use while-loop for siblings, recurse only on children
`hasErrorOverlay`, `findNav`, and `findStore` previously recursed on both `fiber.child` and `fiber.sibling`, incrementing depth for both. This caused: (a) depth limit exhausted by wide sibling lists, missing deeper tree branches, and (b) stack overflow risk on long sibling chains. Refactored to iterate siblings with `while` loop and recurse only on `child`. Gemini HIGH #1.

### D64: Prop stringification uses shallow summary for objects/arrays
`getTree` previously called `JSON.stringify(v)` on every prop, which could freeze the Hermes JS thread on large objects (10MB+ cached API responses, Redux slices passed as props). Now returns `[Array(N)]` for arrays and `{key1, key2, ...}` summary for objects. Gemini MEDIUM #2.

### D65: Navigation state uses safeStringify instead of JSON.stringify
Early returns for Expo Router and React Navigation DevTools state used raw `JSON.stringify`, which throws on circular references in route params. Switched to `safeStringify(state, 50000)`. Gemini MEDIUM #3.

### D66: safeStringify handles getter exceptions and serialization failures
The replacer function now wraps each value check in try/catch to handle getter properties that throw. The outer function also catches total serialization failure and returns `{ __agent_error: "..." }`. Gemini MEDIUM #5.

### D67: Network hook fetch wrapper handles synchronous exceptions
`origFetch.apply()` can throw synchronously on malformed URLs. Wrapped in try/catch that reports the response event before re-throwing, preventing dangling pending requests. Gemini LOW #6.

## 2026-03-10: Phase 3 Redo — Data Layer (Gemini Review)

### D68: Defensive nullish defaults for limit parameters
`Math.max(undefined, 1)` returns `NaN`, causing `getLast(NaN)` to return empty arrays and `slice(-NaN)` to return everything. Added `?? 20` and `?? 50` fallbacks in network-log and console-log handlers. Gemini HIGH #1.

### D69: Network.loadingFailed handler for failed requests
Missing handler meant DNS failures, connection refused, CORS errors, and aborted requests stayed as perpetually pending entries in the network buffer. Now assigns `status: 0` and calculates duration on failure. Gemini HIGH #2.

### D70: Console log correctly stringifies null values
`a.value ?? a.description` with nullish coalescing skipped `null` values (which are valid JS). Changed to `a.value !== undefined ? String(a.value) : (a.description ?? '')` so `console.log(null)` correctly captures "null". Gemini MEDIUM #3.

### D71: autoConnect guards against concurrent reconnection
If `reconnect()` was sleeping between attempts and a tool called `autoConnect()`, two WebSocket connections could race. Added `this.reconnecting` to the guard condition. Gemini MEDIUM #5.

## 2026-03-10: Phase 4 Skills — Gemini Review Fixes

### D72: Remove gzip screenshot command for Android
PNG output from `screencap -p` is already deflate-compressed internally. Wrapping in `gzip -1` yields negligible size reduction while adding command complexity. Removed the gzip approach; plain `exec-out screencap -p` is the recommended method. Gemini HIGH #1.

### D73: Network mocking handles Request objects and sets Content-Type
The fetch mock only checked `url` as a string, but `fetch()` accepts `Request` objects and `URL` instances. Updated to extract URL from all input types. Also sets `Content-Type: application/json` header on mock responses. Added guard against double-patching with `__RN_AGENT_FETCH_PATCHED__` flag. Gemini HIGH #2.

### D74: iOS log predicate uses ENDSWITH instead of contains
`processImagePath contains "YourApp"` can match unrelated system processes with similar substrings. Changed to `ENDSWITH "/YourApp"` for precision. Added instructions for finding the actual binary name via `get_app_container`. Gemini MEDIUM #1.

### D75: Zustand store setup clarifies .getState() behavior
Documentation now explicitly states that users register store *hooks* (not state snapshots), and the MCP tool calls `.getState()` at query time for fresh results. Prevents misconception that state is captured at registration. Gemini MEDIUM #2.

### D76: Add cdp_dev_settings to debugging decision table
Tool was implemented but missing from the "CDP vs Bash Decision Table" in rn-debugging skill. Added entry for dismissing RedBox and toggling inspector. Gemini LOW #1.

### D77: Android pidof without -s flag for broader compatibility
The `-s` flag (single PID) is not available on all Android versions. Changed to `pidof` without `-s` piped through `awk '{print $1}'`, with a `ps | grep` fallback for older devices. Gemini LOW #2.

## 2026-03-10: Phase 5 Agents + Commands — Gemini Review Fixes

### D78: Debugger agent must discover bundle ID before running commands
The rn-debugger agent had no step for discovering the app's actual bundle ID or binary name. Commands used literal `com.example.app` and `YourApp` which an LLM would copy verbatim. Added Step 0 with explicit instructions to find these values from project config. Gemini HIGH #1.

### D79: Maestro templates use placeholders, not example values
Hardcoded `appId: com.example.app` in Maestro YAML templates caused LLMs to write that literal string into test files. Changed to `<app-bundle-id>` placeholder with unquoted heredoc (`<< EOF` not `<< 'EOF'`) so bash interpolation works when needed, plus explicit substitution instructions. Gemini MEDIUM #2.

### D80: Android logcat command consistent across agents
The rn-tester agent used a simpler `pidof` without error suppression or fallback, while rn-debugger had the robust version. Aligned both to use `2>/dev/null` + `ps | grep` fallback pattern. Gemini MEDIUM #3.

## 2026-03-10: Phase 6 Polish + Speed — Gemini Review Fixes

### D81: RN project detection checks package.json dependencies
The SessionStart hook previously matched any project with `package.json` + `app.json`, causing false positives in Next.js and plain Node.js projects. Now checks for `"react-native"` or `"expo"` in package.json before triggering. Gemini HIGH #1.

### D82: Snapshot subshell tolerates uiautomator dump failures
`set -euo pipefail` caused the entire Android subshell to abort if `uiautomator dump` failed (e.g., UI busy). Added `|| true` so the Python fallback produces `[]` instead of a 0-byte file. Gemini HIGH #2.

### D83: MCP server config uses CLAUDE_PLUGIN_ROOT for path resolution
Relative paths like `scripts/cdp-bridge/dist/index.js` resolve against the user's project root, not the plugin root, when installed globally. Changed to `${CLAUDE_PLUGIN_ROOT}/scripts/cdp-bridge/dist/index.js`. Gemini HIGH #3.

### D84: PID-suffixed temp file prevents concurrent snapshot race
Hardcoded `/data/local/tmp/uidump.xml` could be overwritten by concurrent snapshot runs. Changed to `/data/local/tmp/uidump_$$.xml` (PID-suffixed) for uniqueness. Gemini MEDIUM #4.

### D85: Marketplace JSON source field corrected to `source.source`
The correct Claude Code marketplace schema uses `"source": "github"` inside the source object (i.e., `{"source": {"source": "github", "repo": "..."}}`), not `"type": "github"`. The previous `"type"` key was rejected by `claude plugin validate` on Claude Code 2.1.72+. Also moved `marketplace.json` from repo root to `.claude-plugin/marketplace.json` where Claude Code expects it, and added the required `owner` field.

### D86: Auto-select first Android device when multiple connected
When multiple Android devices/emulators are connected and `ANDROID_SERIAL` is not set, `adb` commands fail. Snapshot script now auto-exports `ANDROID_SERIAL` from first connected device. Gemini LOW #6.

## 2026-03-10: Phase 7 — Expo/EAS Build Integration

### D87: Two focused scripts over monolith or micro-scripts
Three architecture options were evaluated: (1) single monolith script (~500 lines), (2) five micro-scripts, (3) two focused scripts. Option 3 chosen: `eas_resolve_artifact.sh` handles artifact resolution (cache → EAS servers → manual), `expo_ensure_running.sh` handles device lifecycle (install, launch, Metro). Each script has one clear responsibility without over-fragmentation.

### D88: JSON stdout contract for all shell script output
Both scripts output valid JSON on stdout for all exit paths (success, error, ambiguous). Diagnostics go to stderr. This allows LLM agents to reliably parse script output without fragile text parsing. Exit codes carry semantic meaning: 0=ok, 1=error, 2=ambiguous, 3=no CLI, 4=no config.

### D89: EAS profile auto-selection by platform-specific criteria
iOS profiles filtered by `ios.simulator == true`, Android by `android.buildType == "apk"`. If exactly one match: auto-select. If zero matches: fall back to "development" profile. If multiple matches: exit 2 with JSON list for user choice. Avoids ambiguity without requiring manual config.

### D90: Three-tier artifact resolution (cache → EAS → manual)
Local cache checked first (files matching profile+extension, <24h old) for instant resolution. EAS servers queried second via `eas build:list --json`. If both fail, error message instructs user to build or provide artifact path. Avoids unnecessary network calls when cached artifacts exist.

### D91: select_profile writes to global variable, not subshell return
Profile auto-selection functions `json_error` and `json_ambiguous` must write to stdout before exiting. Running them in a subshell (`PROFILE=$(select_profile)`) swallows their JSON output. Restructured to write directly to the global `PROFILE` variable. Gemini HIGH #2 fix.

### D92: BSD find -maxdepth before -name
macOS uses BSD `find` which requires global options (`-maxdepth`) before expression options (`-name`). GNU `find` is permissive but warns. Fixed ordering in `expo_ensure_running.sh` for cross-platform compatibility. Gemini MEDIUM #5 fix.

### D93: Agent script invocation captures exit code with || true
Bash `set -e` aborts on non-zero exit codes, but `eas_resolve_artifact.sh` uses exit code 2 for "ambiguous profiles" (not an error). Agent instructions changed to `RESULT=$(...) || EXIT_CODE=$?` pattern to capture all exit codes without aborting. Gemini MEDIUM #6 fix.

### D94: Cache sorting uses ls -t for chronological ordering
`sort -t/ -k999` attempted alphabetical sort by filename which doesn't reflect recency. Changed to `find ... -print0 | xargs -0 ls -t | head -1` for most-recently-modified-first ordering. Gemini LOW #8 fix.

### D95: Removed timeout command, added --non-interactive flag
macOS does not ship with GNU `timeout` (requires `brew install coreutils`). Removed `timeout 300` wrapper around `eas build:list` and added `--non-interactive` flag instead to prevent EAS CLI from prompting for input. Gemini HIGH #3 fix.

### D96: Cache sorting uses find -exec stat instead of xargs ls -t
On macOS BSD, `xargs` without `--no-run-if-empty` runs `ls -t` with no arguments when `find` returns nothing, listing the current directory's files instead. Replaced with `find -exec stat -f "%m %N" {} + | sort -rn | head -1 | cut -d' ' -f2-` which safely handles empty results. Gemini review round 2 HIGH #1.

### D97: Agent logcat/log commands use non-blocking forms
`adb logcat` and `xcrun simctl spawn booted log stream` run continuously and never exit, hanging the agent's Bash tool. Changed to `adb logcat -d` (dump and exit) and `log show --last 5m` (finite output). Gemini review round 2 HIGH #2.

### D98: Empty APP_PID guard before logcat --pid
If the app has crashed, `pidof` returns empty. `adb logcat --pid=` without a value fails. Added `[ -n "$APP_PID" ]` guard: use `--pid` if running, fall back to `adb logcat -d -b crash` if dead. Gemini review round 2 HIGH #3.

### D99: Operator precedence fix in bundle ID resolution
`[ -z "$BUNDLE_ID" ] && [ -f "app.config.js" ] || [ -f "app.config.ts" ]` evaluates left-to-right, causing false warning when BUNDLE_ID is set but app.config.ts exists. Fixed with curly brace grouping: `&& { [ -f ... ] || [ -f ... ]; }`. Gemini review round 2 MEDIUM #4.

### D100: Agent JSON parsing falls back to node when jq unavailable
Agent Step 0 bash examples used `jq -r '.path'` to parse script output, but the scripts themselves support jq-less environments via node fallback. Added `|| node -e "..."` fallback for consistency. Codex review MEDIUM #4.

### D101: Removed overly broad cache fallback
Cache check had a second `find` that matched any `.apk`/`.tar.gz` regardless of profile name. In a shared `/tmp/rn-eas-builds` directory used across multiple projects, this could return a different project's artifact. Removed the broad fallback — only profile-specific matches are returned. Codex review MEDIUM #1.

### D102: JSON helpers escape special characters
`json_ok()`, `json_error()` used raw `printf '%s'` which produced invalid JSON if paths contained quotes, backslashes, or newlines. Added `json_escape()` helper that escapes `\`, `"`, `\n`, `\t` before interpolation. Codex review MEDIUM #2.

### D103: Launch failure warning instead of silent swallow
`simctl launch` and `adb shell am start` failures were silently swallowed with `|| true`, causing `json_ok` to report success even when the app never launched. Changed to emit a stderr warning on launch failure so the agent knows to investigate. Codex review MEDIUM #3.

### D104: Debugger agent includes EAS build path in Step 0
The debugger agent only showed the local-build path for app installation, which could replace the exact EAS/preview binary the user is trying to debug. Added EAS artifact resolution branch mirroring the tester agent's Step 0. Codex review MEDIUM #5.

## 2026-03-10: Security Hardening (Codex Security Review)

### D105: cdp_evaluate tool description warns about arbitrary JS execution
`cdp_evaluate` executes arbitrary JavaScript in Hermes with no sandboxing. Added CAUTION prefix to tool description directing agents to prefer targeted tools. Kept unrestricted since this is a dev tool. Codex security review HIGH #1.

### D106: Same-host enforcement on CDP WebSocket URLs
Metro's `/json/list` returns `webSocketDebuggerUrl` which was used without validation. Added URL hostname filter accepting only `127.0.0.1` and `localhost` after existing IPv6 normalization. Prevents connecting to non-loopback URLs if Metro response is compromised. Codex security review HIGH #2.

### D107: WebSocket hardening — handshakeTimeout and maxPayload
Added `handshakeTimeout: 5000` and `maxPayload: 100MB` to WebSocket constructor. Also added message shape validation in `handleMessage` to reject non-object CDP messages. Codex security review HIGH #2 (supplementary).

### D108: Tar archive path-traversal validation
Added pre-extraction scan (`tar -tzf | grep`) rejecting entries with `..` path components or absolute paths. Added post-extraction symlink scan rejecting targets that are absolute or contain `../` traversal. Codex security review HIGH #3.

### D109: BUNDLE_ID regex validation — hard fail on unsafe characters
Shell-provided `BUNDLE_ID` validated against `^[a-zA-Z][a-zA-Z0-9_.]*$` before use in `adb shell` and `simctl` commands. Hard-fail (exit 1 with JSON error) prevents command injection via crafted bundle IDs. Auto-resolved IDs from `app.json` via jq/node are trusted. Codex security review HIGH #4 (shell).

### D110: PROFILE regex validation in eas_resolve_artifact.sh
`PROFILE` validated against `^[a-zA-Z0-9_-]+$` to prevent path traversal in `ARTIFACT_PATH` construction. Hard-fail on invalid patterns. Codex security review MEDIUM #6.

### D111: mktemp -d replaces hardcoded /tmp paths
Replaced `/tmp/rn-dev-agent` and `/tmp/rn-eas-builds` with `mktemp -d` + EXIT trap cleanup. Also replaced hardcoded `/tmp/rn-eas-build-info.json` with `${OUTPUT_DIR}/build-info.json`. Eliminates symlink race conditions and predictable path attacks. Codex security review MEDIUM #5.

### D112: Plugin manifests corrected to Claude Code schema
Moved `marketplace.json` from repo root to `.claude-plugin/`. Fixed `source.type` → `source.source`, added required `owner` field, prefixed all component paths with `./` in `plugin.json`.

## 2026-03-11: Codex Review Fixes (expo-mcp Port)

### D113: iOS log predicate uses executable name, not bundle ID
`processImagePath CONTAINS` filters by the binary path, which contains the executable name, not the bundle identifier. `IosLogCollector` now takes `executableName` instead of `bundleId`. Resolution chain: CDP → app.json name → derive from bundle ID → Expo Go fallback.

### D114: XCTest uses XCUIApplication(bundleIdentifier:) for app-under-test
`XCUIApplication()` without arguments launches the test host, not the app under test. Now passes `RN_AGENT_BUNDLE_ID` env var and Swift code uses `XCUIApplication(bundleIdentifier:)` when available.

### D115: Replace BSD find with fs.readdirSync for xctestrun discovery
`find -maxdepth` argument order differs between BSD (macOS) and GNU find. Replaced with `readdirSync` + `.find()` which is portable and avoids spawning a subprocess.

### D116: Android appId passed to log collector for PID filtering
`createCollectLogsHandler` now resolves `appId` via CDP when `native_android` source is requested, passing it to `AndroidLogCollector` for PID-based logcat filtering.

### D117: parseLine() signature matches call site
Fixed compile error: `parseLine(line, options)` call was missing the third `filterRegex` argument that the method signature requires.

### D118: Promise.allSettled in CompositeLogCollector
`Promise.all` causes all collectors to fail if one fails. `Promise.allSettled` lets working collectors return results even when one source is unavailable.

### D119: Platform detection prefers CDP-connected device
`AutomationFactory.setCdpPlatformHint()` allows CDP connection to inform platform auto-detection, avoiding mismatches when both iOS and Android devices are available.

### D120: Cache key includes all XCTest source files
`getSourceHash()` now hashes both `AutomationUITests.swift` and `Info.plist`, not just the Swift file. Prevents stale cache when only Info.plist changes.

### D121: cropToElement bounds clamped to image dimensions
If element bounds extend beyond the screenshot (e.g., partially offscreen), crop coordinates are clamped to prevent jimp from throwing. Returns original image if bounds are entirely outside.

### D122: iOS build destination uses generic/platform=iOS Simulator
`name=iPhone` is unstable across Xcode versions (iPhone 14 vs 15 vs 16). `generic/platform=iOS Simulator` builds for any simulator architecture without requiring a specific device name.

### D123: Unique temp file names prevent concurrent access races
Android screenshot and UI dump use `Date.now() + random suffix` for both device and local paths, preventing conflicts if multiple automation calls run concurrently.

### D124: Filter regex validation before use
User-provided filter patterns are wrapped in `try/catch` on `new RegExp()` to surface invalid regex errors early rather than crashing mid-collection.

### D125: iOS log predicate uses ENDSWITH not CONTAINS (consistent with D74)
`processImagePath CONTAINS` matches unrelated system processes with similar substrings. `ENDSWITH` is more precise and consistent with the D74 decision from Phase 5.

### D126: XCTest uses activate() not launch() to preserve running app
`XCUIApplication.launch()` terminates and relaunches the app, breaking the CDP WebSocket connection and losing JS state. Using `activate()` brings the app to foreground without relaunching. Only `launch()` if the app is in `.notRunning` state.

### D127: Android device paths use /data/local/tmp/ not /sdcard/
Newer Android API levels restrict `/sdcard/` write access for shell commands (scoped storage). `/data/local/tmp/` is consistently writable and matches the existing D45 convention.

### D128: collect_logs gracefully handles disconnected CDP
When `js_console` source is requested but CDP is not connected, the source is silently filtered out. If no sources remain, a structured error is returned explaining the requirement.

### D129: CdpLogCollector maps CDP 'log' level to MCP 'info'
CDP uses `log` for `console.log()` calls, but the MCP-facing level values are `info`/`warn`/`error`/`debug`. Added `log → info` mapping alongside existing `warning → warn`.

## 2026-03-11: E2E Testing Setup

### D130: Test app inside plugin repo at test-app/
Keeps test app and plugin code together for easier maintenance. The test app is a development/testing artifact, not a published package.

### D131: Standalone Node.js harness over test framework
A plain Node script that spawns the MCP server and calls tools via the MCP SDK client. No Jest/Vitest overhead — the tests are inherently sequential (one CDP connection) and don't benefit from a framework's parallel execution or watch mode.

### D132: MSW in-app over external mock server
MSW intercepts at the fetch level inside the app, matching the production app's testing pattern. No port conflicts, no extra process. MSW must initialize BEFORE the CDP bridge connects so the plugin's fetch hooks wrap MSW's patched fetch and observe both requests and synthetic responses. On RN >= 0.83 where CDP Network domain is used instead of fetch hooks, MSW-intercepted requests won't appear in network log — the harness accounts for this.

### D133: Purpose-built screens over realistic app clone
Each of the 8 screens targets specific MCP tools with deliberate testIDs and predictable state. This is a test fixture, not a demo app — simplicity enables reliable assertions.

### D134: Harness does not boot the app
The harness assumes the test app is already running on iOS Simulator with Metro. Separating app lifecycle from tool validation keeps the harness simple and avoids flaky simulator boot timing.

### D135: Test app exposes global navigation ref and Redux store
The test app sets `globalThis.__NAV_REF__` (React Navigation ref) and `globalThis.__REDUX_STORE__` (Redux store) in `__DEV__` mode. The harness uses `cdp_evaluate` to call `__NAV_REF__.navigate()` for screen transitions, avoiding the need for Maestro or UI interaction during tool validation.

### D136: Fixed harness suite execution order
Suites run in a deterministic order accounting for side effects: status → evaluate → component-tree → navigation → store-state → network-log → console-log → error-log → dev-settings → reload (last, resets all state). Each suite's preconditions are satisfied by the state left from preceding suites.

### D137: Error Lab RedBox uses render-phase throw
A simple `throw` in an event handler is caught by ErrorUtils and appears in error log but does NOT produce a RedBox. The Error Lab uses a state flag that conditionally renders a component throwing in its render method, producing a genuine React render-phase error. After this test, `cdp_reload` is required to recover.

### D138: Harness suite timeout of 15 seconds
Each suite has a 15-second timeout to prevent hangs from failed CDP connections or unresponsive tools. Matches the plugin's own 15-second reconnect timeout on reload.

### D139: MSW server.listen guarded by __DEV__
The MSW mock server is only started in development mode (`if (__DEV__)`). Even though the test app only runs in dev, the guard prevents accidental interception in production builds and is consistent with the `__NAV_REF__` and `__REDUX_STORE__` exposure pattern.

### D140: Timer cleanup in harness runSuite
The `Promise.race` timeout pattern in `runSuite` clears the `setTimeout` timer on both success and failure paths. Without cleanup, up to 10 orphaned timers accumulate across the sequential suite runs, which would keep the process alive if `process.exit` were removed.

### D141: try/finally for MCP client lifecycle
The harness runner wraps suite execution in `try/finally` to ensure `client.close()` is called even if `connect()` or a suite throws an unexpected error, preventing orphaned child processes.
