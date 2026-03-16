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

## 2026-03-11: Live Plugin Testing & Compatibility Fixes

### D142: Broaden CDP target filter for RN 0.76+ Bridgeless mode
RN 0.76+ with Bridgeless architecture registers debug targets as `"React Native Bridgeless [C++ connection]"` without a `vm: "Hermes"` field. Updated target filter from `t.vm === 'Hermes'` to `(t.vm === 'Hermes' || t.title?.includes('React Native'))` to match both legacy and Bridgeless targets.

### D143: Navigation state fallback to __NAV_REF__.getRootState()
The fiber-walk approach to find NavigationContainer fails on Bridgeless mode because the component's displayName is not preserved in production-like builds. Added `globalThis.__NAV_REF__.getRootState()` as a fallback, which the test app already sets via `createNavigationContainerRef()`.

### D144: getTree() accepts opts object instead of positional args
Changed `getTree(maxDepth, filter)` to `getTree(opts)` where opts has `maxDepth`, `filter`, `testID`, and `type` fields. This is more extensible and avoids confusion when only some parameters are provided.

### D145: Root index.js entry for expo run:ios native binary
Native binaries built with `expo run:ios` request `index.bundle` from Metro, which resolves `./index` at the project root. Expo's `AppEntry.js` (used by `expo start`) is different. Created `test-app/index.js` that imports from `src/App` and calls `registerRootComponent()`.

### D146: Remove MSW from test app entry
MSW v2's `@mswjs/interceptors` uses `static class blocks` which Expo's Babel config doesn't transform. Since MSW is not essential for CDP tool testing, removed the server import from App.tsx. The feed screen shows a network error instead of mock data, which is acceptable for testing network logging.

### D147: Remove NativeWind from Metro/Babel config
NativeWind v4 requires `react-native-worklets/plugin` which is incompatible with RN 0.76. Removed NativeWind from both `babel.config.js` and `metro.config.js`. Components with `className` props render without styles but remain functional for CDP testing.

### D148: DevSettings via TurboModule proxy in Bridgeless mode
`require("react-native").DevSettings` returns `undefined` in RN 0.76 Bridgeless CDP scope because `require()` is unavailable. Fixed by using `__turboModuleProxy("DevSettings")` which exposes `reload`, `toggleElementInspector`, and other methods directly. Both `cdp_dev_settings` and `cdp_reload` tools now use TurboModule with require fallback.

### D149: Async evaluate via global slot + polling
Hermes CDP doesn't support `awaitPromise: true` — it returns raw promise internals (`_h`, `_i`, `_j`, `_k`) instead of resolved values. Implemented workaround: store promise result in a uniquely-named global slot, poll every 100ms until resolved (up to 5s timeout), then clean up the global.

### D150: Reload maintains WebSocket in Bridgeless mode
In RN 0.76 Bridgeless, `DevSettings.reload()` may not close the CDP WebSocket (unlike legacy architecture). The `cdp_reload` tool now handles both cases: if WS disconnects, auto-reconnect; if WS stays open, verify the app is still responsive post-reload.

## 2026-03-12: Post-Review Bug Fixes (Gemini + Codex gpt-5.4)

### D151: Split autoConnect into public guard + internal discoverAndConnect
Codex review (CRITICAL): `reconnect()` called `autoConnect()` which threw when `reconnecting=true`, making every auto-reconnect self-fail. Extracted `discoverAndConnect()` as the internal discovery+connection method. `autoConnect()` now guards against duplicate calls then delegates to `discoverAndConnect()`. `reconnect()` calls `discoverAndConnect()` directly.

### D152: Only set _helpersInjected after verified injection
Codex review (HIGH): `setup()` set `_helpersInjected = true` unconditionally even when `evaluate(INJECTED_HELPERS)` failed. Now: injection result is checked, then a verification probe (`typeof globalThis.__RN_AGENT === "object"`) must pass before the flag is set.

### D153: safeStringify returns valid JSON on truncation
Gemini review: `safeStringify()` truncated mid-JSON with `...[TRUNCATED]` suffix, producing invalid JSON that downstream `JSON.parse()` would reject. Now wraps truncated output in a valid envelope: `{ __agent_truncated: true, preview: "...", originalLength: N }`.

### D154: evaluateAsync — deferred cleanup + serialization inside Hermes
Gemini review (memory leak): if a Promise resolved after the 5s timeout, the global slot was never cleaned because the Node-side cleanup ran before resolution. Now the wrapper installs a `setTimeout(delete, 10s)` inside Hermes as a deferred fallback.
Codex review (false timeout): non-serializable resolved values caused `returnByValue` to omit `result.value`, making the poll loop never observe completion. Now the wrapper serializes values to JSON inside Hermes (`safeVal()`), so the slot always contains a string the poll can read.

### D155: sendWithTimeout wraps ws.send() in try/catch
Codex review: if `ws.send()` threw synchronously (e.g., during a close race), the pending entry and timeout timer leaked. Now caught, cleaned up, and rejected immediately.

### D156: Filter __RN_NET__ messages before console buffer push
Codex review: in hook mode, internal `__RN_NET__:` console messages consumed ring buffer slots, evicting real app logs. Now the `Runtime.consoleAPICalled` handler checks for the prefix before pushing. The `parseNetworkHookMessage` handler in `handleMessage` still processes them independently.

### D157: XHR hook listens for all terminal events
Gemini review: XHR hook only had `loadend` listener, missing `error`, `abort`, `timeout`. Added all four listeners with a `reported` guard to prevent duplicate reporting.

### D158: Reload re-injects helpers when Bridgeless WS stays open
Post-test finding: Bridgeless reload resets the JS context but keeps the WebSocket open. The reconnect flow (which re-runs `setup()`) never triggered. Now the reload tool polls for `__RN_AGENT` existence; if absent, calls `reinjectHelpers()` to re-inject into the new context.

### D159: togglePerfMonitor graceful degradation
Post-test finding: `togglePerformanceMonitor` method not available on all Bridgeless TurboModule implementations. Now tries `togglePerformanceMonitor`, then `togglePerfMonitor`, then returns `not_available` instead of throwing.

### D160: Fix store-state truncation contract drift
Codex follow-up: `store-state.ts` handler still checked for old `...[TRUNCATED]` suffix after `safeStringify` was updated to return `{ __agent_truncated, preview, originalLength }` envelope (D153). Updated handler to detect `__agent_truncated` key instead.

### D161: Close stale socket on connectToTarget retry
Codex review: if `connectWs()` succeeded but `setup()` failed, the retry loop opened a new socket without closing the old one, leaking event listeners and duplicate buffering. Now the catch block closes and nulls the stale socket before retrying.

### D162: Narrow reload catch to expected disconnect errors
Codex review: `cdp_reload` caught all evaluation errors (not just expected WS disconnects), then proceeded to report success. Now only WS-close, WS-not-connected, and timeout errors are swallowed; unexpected failures return an error result.

## 2026-03-12: Phase 13 — Four Prioritized Improvements

### D163: Structured result envelope for all tools
Replaced `textResult`/`errorResult` with typed `okResult`/`failResult`/`warnResult` builders that wrap all responses in `{ ok, data, error, truncated, meta }`. Non-breaking: existing payload shapes are preserved inside `data`. Enables consistent error handling and metadata propagation across all 11 tools.

### D164: Reliable LogBox/RedBox dismissal via 4-tier fallback
`dismissRedBox` now tries: (1) `LogBoxData.clear()`, (2) `globalThis.__logBoxData.clear()`, (3) `LogBox.ignoreAllLogs` toggle, (4) returns `"no_method_available"` instead of silent "ok". The handler surfaces a `warnResult` when all tiers fail, preventing false confirmation.

### D165: cdp_interact tool for UI events via fiber tree
New tool dispatches `press`, `typeText`, and `scroll` actions by walking the React fiber tree to find components by `testID` or `accessibilityLabel`, then calling `memoizedProps` handlers directly (`onPress`, `onChangeText`, `scrollTo`/`onScroll`). Does not simulate native touch — calls JS handlers directly.

### D166: Source map symbolication for error stacks
New `symbolicate.ts` module batches all stack frames from error entries into a single POST to Metro's `/symbolicate` endpoint. 3-second timeout with AbortController, graceful fallback to raw stacks on failure. Integrated into `cdp_error_log` tool.

### D167: Two-phase BFS search for filtered component tree queries
Replaced the single-pass walk-then-prune approach with a two-phase strategy: (1) BFS to find all matching fibers (up to 2000 nodes), (2) build compact subtrees from each match using the user's depth limit. Solves the depth problem where React Navigation + Fabric apps have 40-75+ user component layers from root to actual UI components.

### D168: Versioned helper injection
Added `__HELPERS_VERSION__` to prevent stale cached helpers. On connect, if the version doesn't match, old helpers are deleted and fresh ones injected. Solves the issue where a rebuilt MCP server skipped injection because `globalThis.__RN_AGENT` already existed from a previous session.

### D169: Max depth increased to 12 for unfiltered queries
Previous max of 6 was too restrictive for Fabric/Bridgeless RN apps where View, Provider, NavigationContainer, etc. all count as user components. Increased to 12, with default 4.

### D170: Fix BFS double-enqueue of child siblings
Code review fix: the filtered BFS loop was enqueuing `fiber.child`, then separately iterating `fiber.child.sibling` chain, then also enqueuing `fiber.sibling`. The sibling loop was redundant — the standard `child + sibling` pattern covers the full tree. Removed the inner loop.

### D171: Fresh WeakSet per subtree walk in filtered queries
Code review fix: all matched subtrees shared a single `visited` WeakSet, causing the 2nd+ matches to be silently pruned if they shared any nodes with earlier matches. Now each subtree walk gets its own WeakSet.

### D172: Guard JSON.parse in interact handler
Code review fix: `JSON.parse(result.value)` in `interact.ts` was unguarded. If Hermes returned malformed JSON, the raw SyntaxError would propagate through `withConnection` catch with no context. Now wrapped in try/catch with descriptive error message.

### D173: Fix warnResult meta spread order
Code review fix: `{ warning, ...meta }` allowed caller-supplied `meta.warning` to silently overwrite the `warning` parameter. Reversed to `{ ...meta, warning }` so the explicit warning argument always wins.

### D174: Fix symbolicate clearTimeout leak
Code review fix: `clearTimeout(timer)` was only called after successful fetch. Moved into `finally` block to ensure cleanup on all paths (non-OK response, JSON parse failure, network error).

## 2026-03-12: External Review Fixes (Gemini + Codex Round 2)

### D175: True BFS in filtered component tree search
Gemini review: the filtered BFS used `queue.push(fiber.child); queue.push(fiber.sibling)` which treats the fiber tree as a binary tree, processing siblings after children in queue order. Fixed to iterate the full sibling chain (`var ch = fiber.child; while (ch) { queue.push(ch); ch = ch.sibling; }`) for proper breadth-first ordering.

### D176: interact findFiber uses node count limit instead of depth limit
Gemini review: `findFiber` had a `depth > 50` guard which fails on deep Fabric apps where the target component sits at depth 75+. Replaced with a `findCount > 5000` node count limit that scales with tree size regardless of depth.

### D177: Guard JSON.parse in error-log handler
Gemini review: `JSON.parse(result.value)` in `error-log.ts` was unguarded. If Hermes returned malformed JSON, the raw SyntaxError propagated with no diagnostic context. Wrapped in try/catch with descriptive failResult.

### D178: Native RedBox dismiss via DevSettings.dismissRedbox()
Codex review: `dismissRedBox` only cleared JS-side LogBox state, leaving the native RedBox overlay visible. Added two new tiers at the top: (1) `__turboModuleProxy("DevSettings").dismissRedbox()` for Bridgeless, (2) `require("react-native").DevSettings.dismissRedbox()` for legacy. Now dismisses both JS LogBox and native RedBox.

### D179: togglePerfMonitor returns consistent sentinel
Codex review: `togglePerfMonitor` returned `"not_available"` while the handler only checked `"no_method_available"`, causing false success for perf monitor when unavailable. Unified to `"no_method_available"` and generalized the warning message.

### D180: Symbolication regex supports Hermes `name@url:line:col` format
Codex review: the stack frame parser only matched V8-style `at name (url:line:col)` format. Hermes also emits `name@url:line:col` (Firefox-style). Added `HERMES_ATSIGN_RE` as a fallback pattern.

### D181: Error handler accumulation guard on helper reinjection
Codex review: when helpers were reinjected (version upgrade), `ErrorUtils.setGlobalHandler()` saved the current handler as `origHandler` — but the current handler was already our agent's wrapper, not the app's original. The rejection tracker also re-registered, doubling callbacks. Fixed: (1) save app's original handler in `globalThis.__RN_AGENT_ORIG_ERR_HANDLER__` on first injection only, (2) guard rejection tracker with `__RN_AGENT_REJECTION_TRACKED__` flag, (3) use `globalThis.__RN_AGENT_ERRORS__` shared array so old callbacks still write to the right buffer.

### D182: Clear reconnecting flag immediately on reconnect success
Pre-existing B41: `reconnecting` flag was only cleared in `.finally()` after the `reconnect()` promise settled. During the reconnect loop, the flag stayed `true`, causing close events on newly established connections to be silently dropped by `handleClose()`. Now `reconnect()` clears the flag at every exit point (success, failure, disposed), and the `.finally()` is removed. The `.catch()` handler in `handleClose()` serves as the last-resort safety net.

### D183: Allow Code-1006 to retry instead of immediate throw
Pre-existing B42: `connectToTarget()` threw immediately on code 1006 ("abnormal closure"), which is the most common transient failure (another debugger grabbed the target). The other debugger often disconnects within seconds, making retry worthwhile. Now only "refused" (nothing listening at all) triggers an immediate throw. Code 1006 retries through the full 5-attempt loop with 2s delays. The final error message includes a helpful hint if the last failure was code 1006.

## 2026-03-12: Benchmark Experiment Fixes

### D184: Console capture via monkey-patch instead of CDP events
Benchmark experiment (CRITICAL): `cdp_console_log` returned 0 entries for app-level `console.log` calls in RN Bridgeless mode. Root cause: React Native's console polyfill routes logs through the native bridge, not through Hermes' built-in console, so CDP `Runtime.consoleAPICalled` events never fire. Fixed by monkey-patching `console.log/warn/error/info/debug` in injected helpers to push to `globalThis.__RN_AGENT_CONSOLE__` ring buffer (200 entries). The `cdp_console_log` tool now reads from this injected buffer via `__RN_AGENT.getConsole()`. Console patches are guarded by `__RN_AGENT_CONSOLE_PATCHED__` to prevent double-wrapping on reinjection.

### D185: Auto-connect in withConnection wrapper
Benchmark experiment (HIGH): All tools except `cdp_status` failed with "Not connected. Call cdp_status first." if called without prior `cdp_status`. AI agents shouldn't need this ceremony. `withConnection` now calls `autoConnect()` when not connected, waits up to 15s for in-progress reconnections, waits up to 5s for helper injection, and retries once on mid-operation disconnect.

### D186: Interact distinguishes handler-threw from action-failed
Benchmark experiment (MEDIUM): `cdp_interact` returned `failResult` when `onPress` handler threw, even though the press executed successfully. The injected `interact()` catch block now returns `{ success: true, action_executed: true, handler_error: ... }`, and the handler surfaces this as `warnResult` instead of `failResult`.

## 2026-03-12: rn-feature-dev Command

### D187: rn-feature-dev as self-orchestrating command without agent field
The `rn-feature-dev` command needs to launch different agent types at different phases (explorers, architects, reviewers) and run CDP tools directly for verification. Commands with an `agent:` field delegate entirely to one agent. Omitting it keeps the main Claude thread as orchestrator, matching how the upstream feature-dev plugin works.

### D188: Three RN-adapted agents copied from feature-dev plugin
Copied `code-explorer`, `code-architect`, `code-reviewer` from the official feature-dev plugin (Apache 2.0) and adapted for React Native. Named with `rn-` prefix (`rn-code-explorer`, etc.) to avoid collisions if users install both plugins. RN adaptations: explorer greps for testIDs/routes/store slices, architect outputs Verification Parameters section, reviewer checks testID coverage and `__DEV__` guards.

### D189: Architect blueprint includes Verification Parameters section
Phase 5.5 (Live Verification) needs to know which component to filter in `cdp_component_tree` and which store path to query. Rather than re-analyzing the implementation, the architect's blueprint includes a mandatory `Verification Parameters` section with `primaryComponent`, `storeQueryPath`, and `requiresFullReload`. This makes Phase 5.5 mechanical — no guessing.

### D190: Phase 5.5 inline in command rather than separate skill or agent
The live verification sequence is 5 CDP calls + 1 screenshot. Creating a separate skill or agent for this adds indirection without benefit. The verification is embedded in the command body with exact pass/fail criteria and a gate that blocks Phase 6. The same sequence is also appended to `rn-tester.md` as a reusable "Verification Checkpoint" section.

### D191: Code agents get analysis-only tools — no device access
The three new agents (`rn-code-explorer`, `rn-code-architect`, `rn-code-reviewer`) use Glob, Grep, Read, and other file-reading tools but never get `Bash`, `Write`, `Edit`, or `mcp__rn-dev-agent-cdp__*`. This prevents them from accidentally mutating the repo or interfering with the running app. Only the main thread and `rn-tester` have device access.

### D192: Phase 5.5 navigates to feature screen before verification
Gemini + Codex review: after a full reload, the app returns to its initial route. Features on sub-screens would false-fail the component tree check. Added `entryRoute` to the architect's Verification Parameters and a navigation Step 0 in Phase 5.5 that deep-links to the feature screen before taking measurements.

### D193: Error baseline via buffer clear before verification
Codex review: Step 2 required `errorCount == 0` but Step 5 allowed "pre-existing errors" — contradictory since both read the same buffer. Fixed by clearing the error buffer at the start of Phase 5.5 (Step 1), establishing a clean baseline. Any errors after the clear are definitively new regressions.

### D194: isPaused check added to Phase 5.5 health gate
Codex review: both `rn-tester` and `rn-debugger` check for paused execution, but Phase 5.5 did not. A paused JS runtime leaves CDP queries returning stale data. Added `isPaused == false` to the health gate with `cdp_reload` recovery.

### D195: Phase 5.5 auto-recovery instead of delegating to /check-env
Codex review: the recovery path told users to run `/check-env`, which breaks the guided flow. Now Phase 5.5 Step 0 attempts auto-recovery via `expo_ensure_running.sh` before asking the user, matching the pattern already used by `rn-tester` Step 0.

## 2026-03-12: rn-feature-dev Benchmark (Notification Feature)

### D196: Wrap NotificationsTab in a stack navigator
The NotificationsTab was the only tab rendered as a bare screen (no nested stack). Adding a NotificationDetail screen required wrapping it in a `NotificationsStack` navigator with `headerShown: false` on the tab, matching the existing HomeTab/ProfileTab pattern.

### D197: Derive unreadCount from items instead of storing separately
Code review: `unreadCount` was stored as a separate integer alongside `items`, creating a desync risk. Replaced with a derived selector `selectUnreadCount` that computes `items.filter(i => !i.read).length`. The `unreadCount` field remains in state for backward compatibility with the existing reducer logic.

### D198: Tab badge driven by Redux selector
Used `tabBarBadge` option on the NotificationsTab screen, driven by `useSelector(selectUnreadCount)` in the `TabNavigator` component. Badge shows the count when > 0, `undefined` (hidden) when 0.

## 2026-03-12: Gemini + Codex Review Fixes (Round 2)

### D199: Phase 5.5 uses cdp_evaluate navigation instead of deep links
Deep links trigger native confirmation dialogs in Expo Go (B56) that block automation. Replaced `xcrun simctl openurl` with `cdp_evaluate` using `globalThis.__NAV_REF__?.navigate()` as the primary navigation method. Deep links remain as a last-resort fallback.

### D200: Phase 5.5 detects simulator before navigation attempt
Recovery path was ordered after the deep-link attempt, meaning the first navigation would fail before recovery kicked in. Restructured Step 0 to verify simulator + CDP connection first, then navigate.

### D201: Phase 5.5 includes interaction verification step (Step 3.5)
Phase 5.5 only performed static checks (component exists, state shape correct). Added Step 3.5 that uses `cdp_interact` to exercise the primary user action and verify its side effect (state change, navigation, or visual update).

### D202: Phase 6 skips "which to fix" prompt when no findings
Phase 6 always asked "Which findings should I fix?" even when reviewers found zero issues. Now proceeds directly to Phase 7 when no high-confidence issues are found.

### D203: rn-code-reviewer console.log severity unified to Important
Reviewer had conflicting severity for console.log: Critical (must have testID) vs Low (no bare console.log). Unified to Important with clear guidance: production code paths must guard console calls with `__DEV__`, test app console calls for CDP testing are acceptable when guarded.

### D204: rn-tester Verification Checkpoint includes navigation step
Checkpoint was missing a navigation step that existed in Phase 5.5. Added Step 0 using `cdp_evaluate` with `__NAV_REF__` for in-app navigation. Also fixed copy-paste text ("blocks proceeding to quality review" → "blocks proceeding to the next testing step").

### D205: NotificationsTab gets tabBarTestID
Added `tabBarTestID: 'tab-notifications'` so Maestro and `cdp_component_tree` can target the tab bar item for interaction and verification.

### D206: NotificationsScreen uses selectUnreadCount selector
Screen was destructuring raw `unreadCount` from state despite D197 establishing a derived selector. Changed to use `selectUnreadCount` for consistency, eliminating desync risk between the items array and displayed count.

## 2026-03-12: Self-Evaluator Protocol

### D207: Evaluator lives in dev/, outside plugin manifest
The self-evaluator is a development-time tool for improving the plugin, not a user-facing feature. Placing it in `dev/` keeps it out of `.claude-plugin/plugin.json` and ensures it is never shipped to plugin consumers.

### D208: Inline capture during rn-feature-dev, not post-run analysis
Capturing data inline during the run (via one-line evaluator references per phase) produces the most accurate and complete data. Post-run analysis from git history or conversation transcripts would be incomplete and error-prone.

### D209: Confidence-gated bug logging to BUGS.md
Only high-confidence failures (tool errors, timeouts, crashes, failed recoveries) are auto-appended to BUGS.md. Warnings and ambiguous observations go to the report only, avoiding noise in the bug tracker. 3-criteria deduplication (tool + error pattern + context) prevents duplicate entries.

## 2026-03-12: Gemini + Codex Review Fixes (Self-Evaluator)

### D210: Architect Verification Parameters include navigation action and interaction metadata
Both Gemini and Codex flagged that `entryRoute` (deep link URI) is incompatible with the Phase 5.5 `cdp_evaluate` navigation strategy. Extended Verification Parameters with `navigationAction` (literal `__NAV_REF__` expression), `primaryInteractionTestID`, and `expectedInteractionEffect`. `entryRoute` retained as deep link fallback only.

### D211: Dispatch Redux state before network call in test app
`fetch()` to `api.testapp.local` rejects since MSW is removed (B22). Moving `dispatch()` before the fire-and-forget `fetch().catch(() => {})` ensures state updates are immediate and the mark-read/clear-all flows work without a backend.

### D212: Evaluator Phase 7 checks Phase 6 deferred findings for bugs
Evaluator only checked CDP tool FAILs for bug logging. Gemini flagged that deferred Phase 6 reviewer findings (logic errors, null safety, crash risks) are also bug candidates. Added Source B to Step 2.

### D213: Evaluator increments agent counters in Phases 2, 4, 6
Codex found `agents.launched` and `agents.useful` were initialized but never incremented. Added increment instructions to each phase that launches agents.

### D214: Evaluator increments phases_completed before writing report
Codex found report always showed 7/8 because Phase 7 was marked complete after writing. Moved increment before the write step.

## 2026-03-12: Tasks Tab Feature

### D215: State-derived IDs in Redux reducers instead of module-level counters
Module-level `let nextId = 4` resets to 4 on Fast Refresh while the Redux store preserves existing items, causing ID collisions. Deriving the next ID from `state.items.reduce(max)` inside the reducer is deterministic and survives hot reload.

### D216: Use createSelector for array-returning selectors
`selectFilteredTasks` calls `.filter()` which returns a new array reference every time. `useSelector` uses strict equality, so this triggers re-renders on every store change. Wrapping with `createSelector` from RTK memoizes the result and only recomputes when inputs change.

### D217: Optimistic sync with markAllUnsynced rollback on failure
`handleSync` dispatches `markAllSynced` optimistically before the network call. If the fetch fails, `markAllUnsynced` is dispatched to restore the unsynced indicators. This prevents the silent data loss where items appear synced but the server never received the update.

### D218: All tabs must have tabBarTestID for consistent testability
`HomeTab` and `ProfileTab` were missing `tabBarTestID` while `NotificationsTab` and `TasksTab` had them. Added `tab-home` and `tab-profile` for consistent agent navigation via CDP/Maestro.

### D219: Named selector exports for all useSelector calls
Inline `useSelector((state: RootState) => state.tasks.filter)` is inconsistent with the named-selector pattern used for all other selectors in the same component. Exported `selectCurrentFilter` from the slice for consistency and easier refactoring.

### D220: Dispatch sync only on server success, not optimistically
Gemini (100) and Codex (96) both flagged that optimistic `markAllSynced` + `markAllUnsynced` rollback corrupts sync state — it marks ALL tasks dirty, not just the ones that were unsynced before. Simplest correct fix: dispatch `markAllSynced` only after a successful server response.

### D221: Memoize renderItem with useCallback in FlatList screens
Gemini (95) flagged that `renderItem` defined inline creates a new function reference on every render. Combined with a controlled TextInput, every keystroke re-renders all FlatList rows. Wrapping in `useCallback` with `[dispatch]` dependency prevents this.

### D222: Memoize all selectors that compute derived values with createSelector
Gemini (90) flagged `selectActiveTaskCount` using `.filter()` without memoization. Even though it returns a primitive, the filter runs on every Redux state change. Wrapping with `createSelector` avoids recomputation when `tasks.items` hasn't changed.

### D223: Add keyboardShouldPersistTaps to FlatList with TextInput siblings
Codex (84) flagged that without `keyboardShouldPersistTaps="handled"`, the first tap on a FlatList row after typing is swallowed (it dismisses the keyboard instead). Standard fix for screens mixing TextInput with tappable lists.

### D224: Clear button bypasses debounce by setting debouncedQuery directly
Codex (95) flagged that `setSearchText('')` alone triggers the 300ms debounce timer, leaving the filtered list showing stale results for 300ms after the clear button is pressed. Fix: set both `setSearchText('')` and `setDebouncedQuery('')` in the clear handler for immediate reset.

### D225: Use ListEmptyComponent instead of conditional FlatList mount
Gemini (95) flagged that conditionally rendering FlatList vs empty-state View destroys scroll position and FlatList internal state on each toggle. Using `ListEmptyComponent` prop keeps the FlatList always mounted, preserving virtualization state.

### D226: FlatList requires flex-1 for proper virtualization
Gemini (100) flagged that without `className="flex-1"`, FlatList cannot measure its container height, breaking virtualization (windowSize, maxToRenderPerBatch) and potentially pushing sibling elements off screen.

### D227: NativeWind v4 requires jsxImportSource in babel config
NativeWind v4 CSS-interop requires `jsxImportSource: "nativewind"` in babel-preset-expo options. Without it, `className` props are passed through but never converted to native styles. The `withNativeWind` metro config alone is insufficient — babel must rewrite JSX imports. Note: the `nativewind/babel` preset requires `react-native-worklets` which may not be installed; `jsxImportSource` alone is sufficient for basic styling.

### D228: Maestro E2E flows must handle Expo Go dialog states conditionally
Each maestro-runner invocation relaunches the `host.exp.Exponent` app. The developer welcome dialog ("Continue" button) only appears on first-time launches. Use `runFlow` with `when: visible` conditions to handle both cases — dialog present or already dismissed. Never use hard `extendedWaitUntil` for optional UI elements.

### D229: iOS Maestro flows cannot use `back` command
Maestro's `back` command is Android-only (hardware back button). On iOS, navigate back by tapping the React Navigation header back button text (e.g., `tapOn: "Home"` for the back button on a screen pushed from Home).

## 2026-03-12: Plugin Quality Hardening

### D230: Skills require YAML frontmatter for Claude Code discovery
Skills without `name` and `description` in YAML frontmatter cannot be matched to user queries by Claude Code's skill routing. All 3 skills (rn-device-control, rn-testing, rn-debugging) were missing frontmatter. Added third-person descriptions with specific trigger phrases.

### D231: Agent descriptions need example blocks and explicit triggers
Agent `description` frontmatter drives Claude's routing. Without `<example>` blocks and `Triggers:` lines, agents trigger unreliably. Added 2-3 examples per agent and explicit trigger phrases to all 5 agents.

### D232: Commands must include mcp__rn-dev-agent-cdp__* in allowed-tools
Commands that reference CDP MCP tools in their body (cdp_status, cdp_error_log, etc.) must include `mcp__rn-dev-agent-cdp__*` in `allowed-tools`. Without it, the frontmatter contradicts the command body and prevents execution. Fixed in check-env, test-feature, build-and-test, debug-screen.

### D233: Remove allowed-tools from rn-feature-dev (inherit session permissions)
rn-feature-dev is a self-orchestrating command that uses TodoWrite, multiple MCP tools, and launches agents. Restricting `allowed-tools` blocks its own protocol. Removed the field so it inherits all session permissions.

### D234: Commands with agent delegation must pass $ARGUMENTS
Commands with `agent:` frontmatter that accept user arguments must interpolate `$ARGUMENTS` in the body. Without it, the agent is launched without knowing what feature to test. Fixed in test-feature and build-and-test.

### D235: Remove WebFetch/TodoWrite/WebSearch from read-only agents
rn-code-explorer, rn-code-architect, and rn-code-reviewer are read-only analysis agents. WebFetch, TodoWrite, and WebSearch are unnecessary and violate least-privilege. Reduced tools to `Glob, Grep, LS, Read`.

### D236: Each agent needs a distinct color for UI identification
Agents sharing the same color (or missing color) reduce visual clarity. Assigned distinct colors: rn-tester=cyan, rn-debugger=red, rn-code-explorer=yellow, rn-code-architect=green, rn-code-reviewer=magenta.

### D237: Hook hint must list all user-facing commands
The SessionStart hook hint listed 4 commands but omitted `rn-feature-dev` — the plugin's most sophisticated command. Users couldn't discover it without reading docs. Added to the hint output.

### D238: Code-analysis agents only need rn-testing skill
rn-code-explorer, rn-code-architect, and rn-code-reviewer are read-only analysis agents that never interact with devices or run debuggers. Loading all 3 skills (rn-device-control, rn-testing, rn-debugging) wastes context tokens. Reduced to `rn-testing` only — it has testID conventions and component tree patterns these agents actually reference.

## 2026-03-13: Profile Edit Modal — Ralph S3

### D239: Modal screens registered on RootStack, not nested stacks
ProfileEditModal is a full-screen modal that overlays the tab navigator. Registering it on `RootStack` with `presentation: 'modal'` makes it accessible from any tab and provides native modal animation. Nested stack registration would limit access to a single tab.

### D240: Nested CompositeScreenProps for cross-navigator navigation
ProfileScreen lives inside ProfileStack → TabNavigator → RootStack. To call `navigation.navigate('ProfileEditModal')` (a RootStack route), the screen's type must include all three navigator levels via nested `CompositeScreenProps<ProfileStackProps, CompositeScreenProps<TabProps, RootStackProps>>`. Using `navigation.getParent()?.navigate()` silently no-ops because `getParent()` reaches TabNavigator, not RootStack.

### D241: Single updateProfile action for atomic name+email update
Added `updateProfile({ name, email })` to userSlice instead of calling `updateName` + a hypothetical `updateEmail` separately. Single dispatch is atomic — no intermediate state where name is updated but email isn't. Follows existing slice patterns.

### D242: Email validation requires chars before and after @
`!email.includes('@')` accepts standalone `@` as valid. Changed to `indexOf` check requiring `atIndex >= 1` (at least one char before @) and `atIndex < email.length - 1` (at least one char after @). Lightweight validation appropriate for a client-side modal — server does authoritative validation.

### D243: Fire-and-forget POST with dispatch-first pattern
Profile save dispatches Redux state update immediately, then fires `fetch(...).catch(() => {})` without await. Matches the NotificationsScreen convention (D211). User sees immediate UI feedback; network failure is acceptable for a local-first profile update.

## 2026-03-13: Profile Edit Modal — Gemini + Codex Review Fixes

### D244: Modal headerShown: false to prevent duplicate title
ProfileEditModal renders its own inline title. The RootStack screen also had `title: 'Edit Profile'` which showed a native header. Gemini (95) flagged the visual duplication. Fixed by setting `headerShown: false` on the modal screen options.

### D245: Validate trimmed strings to prevent whitespace bypass
Both Gemini (85) and Codex (97) flagged that validation runs on raw state but dispatch uses `trim()`. Input like `" @ "` passes validation but trims to invalid `"@"`. Fixed by trimming once at the start of `validate()` and reusing trimmed values in `handleSave`.

### D246: KeyboardAvoidingView for modal forms
Gemini (90) flagged that the keyboard covers Save/Cancel buttons on smaller screens. Wrapped the modal content in `KeyboardAvoidingView` with `behavior="padding"` on iOS. Standard pattern for forms with multiple TextInputs.

### D247: Wire returnKeyType="next" to onSubmitEditing + ref
Gemini (85) flagged that `returnKeyType="next"` on the name input does nothing without an `onSubmitEditing` handler. Added `useRef<TextInput>` for the email input and `onSubmitEditing={() => emailRef.current?.focus()}` on the name input.

## 2026-03-13: Plugin Improvements from S1-S3 Analysis

### D248: CDP smart target selection — probe __DEV__ before committing
The highest-page-ID heuristic (B58) fails in Bridgeless mode where multiple Hermes targets exist and the newest isn't always the app's main JS context. New flow: sort targets by descending page ID, try each one, probe `__DEV__ === true` after setup. Skip targets where `__DEV__` is false. Falls back to last available target with a warning if none have `__DEV__: true`.

### D249: cdp_status warns when connected to wrong JS context
When `app.dev` is false, `cdp_status` now returns a `warnResult` instead of `okResult`, telling the agent: "Connected to a JS context where __DEV__ is false. This may not be the app's main context." This surfaces the problem immediately instead of leaving the agent to discover it through cascading tool failures.

### D250: Phase 5.5 Health Check gates on app.dev === true
Added `app.dev = true` as a gate condition in Phase 5.5 Step 2. If false, the command instructs the agent to call `cdp_reload(full=true)` to force target re-selection, which now uses the __DEV__ probe (D248). This creates a full recovery path: detect wrong context → reload → re-select correct target.

### D251: rn-debugging skill adds wrong-context troubleshooting
Added two rows to the Connection Troubleshooting Guide: `dev: false` in status (wrong JS context) and fiberTree/navRef missing (wrong Bridgeless context). These guide agents to the correct recovery action instead of spinning on cascading failures.

### D252: Guard evaluator references with file existence check
All 8 `**Evaluator**:` lines in `rn-feature-dev.md` are shipped to plugin users, but `dev/evaluator.md` only exists in our dev repo. Without a guard, the agent would try to read a nonexistent file. Added "If `dev/evaluator.md` exists in the plugin root" prefix to each line — no-op for users, active for us.

## 2026-03-13: S4 Notification Snooze with Timer

### D253: Plain selectors for Date.now()-dependent filtering
`selectVisibleNotifications` and `selectSnoozedCount` use `Date.now()` in their filter predicate. Using `createSelector` would memoize the result — subsequent calls with the same `items` array reference would return stale filtered lists even after snooze timers expire. Plain selector functions ensure fresh filtering on every render.

### D254: useStore() for timer callback state reads
The auto-unsnooze `setTimeout` callback needs current notification items, not the stale closure from when the effect ran. Using `useStore<RootState>()` from react-redux and calling `store.getState()` inside the callback avoids the stale closure problem without adding `allItems` to the timeout's conceptual dependency scope.

### D255: Stable testID uses item.id not positional index
`notif-item-${index}` breaks Maestro flows when list items are reordered (snooze/unsnooze changes visible set). Using `notif-item-${item.id}` produces stable, predictable testIDs tied to the data model.

### D256: Local variable narrowing eliminates non-null assertion
`item.snoozedUntil!` in JSX is a TypeScript escape hatch that bypasses null checking. Extracting `const snoozedUntil = item.snoozedUntil` before the `isSnoozed` check lets TypeScript narrow the type through the conditional branch, eliminating the need for `!`.

### D257: createSelector for pure derived state (selectUnreadCount)
`selectUnreadCount` filters by `!item.read` which is a pure function of items. Unlike the Date.now()-dependent selectors (D253), this benefits from memoization — it only recomputes when the items array reference changes.

### D258: MCP server process kill makes tools permanently unavailable (B60)
Running `pkill -f "cdp-bridge"` during a session killed the MCP server process. All `mcp__plugin_rn-dev-agent_rn-dev-agent-cdp__*` tools became permanently unavailable — no auto-restart, no ToolSearch results. Fallback: raw WebSocket CDP scripts using the `ws` module from cdp-bridge's node_modules.

### D259: cdp_reload cannot switch CDP targets (B61)
`cdp_reload` calls `DevSettings.reload()` within the current WebSocket session. It never calls `discoverAndConnect()` to re-probe targets. If initially connected to the wrong target, reload cannot fix it — only a full disconnect/reconnect cycle can.

## 2026-03-13: S4 Post-Review Fixes (Gemini + Codex)

### D260: Pure reducer — accept snoozedUntil timestamp, not durationMs
Both Gemini (HIGH) and Codex (MEDIUM) flagged `Date.now()` inside the `snoozeNotification` reducer as an impurity. Reducers must be deterministic for time-travel debugging and replay. Changed payload from `{ id, durationMs }` to `{ id, snoozedUntil }` — the component computes `Date.now() + durationMs` before dispatch.

### D261: shallowEqual for array-returning selectors
`selectVisibleNotifications` returns a new `.filter()` array on every call. Without memoization, `useSelector` fails reference equality (`===`) and re-renders the component on every Redux dispatch anywhere. Adding `shallowEqual` as the equality function compares array elements by identity, preventing unnecessary re-renders when the filtered set hasn't changed. Gemini rated this CRITICAL.

### D262: Include entity ID in fire-and-forget API path
`handleMarkRead` POSTed to `/api/notifications/read` (same as mark-all-read) without the notification ID. Changed to `/api/notifications/${id}/read`. Gemini HIGH — logic error that would mark all notifications as read server-side.

## 2026-03-13: CDP Reliability Fixes (B58/B60/B61)

### D263: softReconnect() as shared recovery primitive
A single `softReconnect()` method on CDPClient handles both stale-target recovery (B58) and reload target-switching (B61). It tears down the current WS without setting `disposed`, rejects pending calls, and calls `discoverAndConnect()` for full target re-discovery with `__DEV__` probing. Avoids code duplication between two recovery paths.

### D264: Reactive stale-target probe in withConnection catch block
Instead of periodic keep-alive polling (wastes bandwidth/tokens), stale targets are detected reactively: when a non-disconnect error occurs while the WS is still open, `withConnection` probes `__DEV__` with a 2s timeout. If stale, calls `softReconnect()` and retries the handler once. Zero overhead in the happy path.

### D265: Auto-restart bash wrapper for MCP server (B60 fix)
MCP servers spawned by Claude Code cannot restart themselves within a session. Wrapping `node dist/index.js` in a bash loop that restarts on non-zero exit (max 5 within 60s) makes crashes transparent to the agent. `plugin.json` changed from `command: "node"` to `command: "bash"` with `run.sh`.

### D266: softReconnect preempts background reconnect loop
When `handleClose` fires (e.g., during reload), it sets `reconnecting=true` and starts a background `reconnect()` loop. If `softReconnect()` is called concurrently (e.g., by reload handler), it must not block 15s waiting for the background loop. Instead, `softReconnect()` sets `_softReconnectRequested` flag, which the background loop checks and bails on, then `softReconnect()` takes over with its own `discoverAndConnect()`.

### D267: Preserve original error context in stale-target recovery
When stale-target recovery fails (reconnect fails, helpers not injected, retry fails), the `failResult` message describes what went wrong in recovery, but the _original_ error that triggered the probe is lost. Adding `{ originalError: message }` to the meta object preserves diagnostic context for the agent.

### D268: Unhandled rejections are non-fatal
Transient CDP errors (e.g., WebSocket closes during an evaluate) can bubble up as unhandled rejections if a caller doesn't await properly. Calling `process.exit(1)` for these consumes the restart budget in `run.sh`, potentially killing the server after 5 transient errors. Changed to log-only — the MCP protocol handles per-request errors. Only `uncaughtException` is fatal.

### D269: SIGINT trap in run.sh
Without `trap 'exit 0' SIGINT`, Ctrl+C or parent SIGINT would kill the node process but the bash loop would restart it. The trap ensures SIGINT cleanly exits the wrapper.

## 2026-03-13: Gemini + Codex Review Fixes — CDP Reliability

### D270: Stale probe timeout resolves instead of rejecting
Both Gemini (CRITICAL) and Codex (HIGH) identified that the `Promise.race` timeout for the stale-target probe used `reject()`, which threw into the catch block that swallows errors. This meant unresponsive stale targets bypassed recovery entirely. Changed to `resolve({ error: 'probe timeout' })` so the `isStale` check evaluates it correctly.

### D271: connectToTarget checks _softReconnectRequested
Gemini (HIGH): when `softReconnect()` signals the background `reconnect()` loop to bail, `connectToTarget()` has its own inner retry loop (5 retries * 2s) that never checks the flag. Two concurrent `discoverAndConnect()` calls could fight over `this.ws`. Added preempt check at the start of each `connectToTarget` retry iteration.

### D272: cdp_reload retries softReconnect up to 3 times
Gemini (MEDIUM): `softReconnect()` calls `discoverAndConnect()` once. During reload, the new Hermes target may not be registered with Metro yet. Added 3-attempt retry with 1.5s delay in reload.ts Step 3.

### D273: cdp_reload checks reinjectHelpers return value
Codex (MEDIUM): `reinjectHelpers()` returns `false` on failure but reload.ts ignored it, always returning `reconnected: true`. Now returns `warnResult` when injection fails, signaling the app may still be loading.

### D274: Phase 8 E2E Proof uses CDP screenshots, not Maestro
Added Phase 8 to rn-feature-dev as the final step. Uses CDP interactions (`cdp_interact`) + `simctl screenshot` / `adb screencap` to walk through the feature flow and capture numbered screenshots. No Maestro dependency — avoids B59 (maestro-runner broken on iOS) and keeps the flow reliable regardless of tooling. Proof artifacts saved to `docs/proof/<feature-slug>/` with a `PROOF.md` summary.

## 2026-03-13: S5 Task Priority and Sort

### D275: Item.id-based testIDs instead of index-based
Migrated task item testIDs from `task-item-${index}` to `task-item-${item.id}`. Index-based IDs break when sort order changes — the same testID would point to a different task after toggling priority sort, making CDP verification unreliable.

### D276: Compose selectSortedFilteredTasks on selectFilteredTasks
Review found duplicated filter logic across two selectors. Refactored `selectSortedFilteredTasks` to compose on `selectFilteredTasks` — single source of truth for filter logic and better memoization (short-circuits when filtered list reference unchanged).

### D277: Memoize selectUnsyncedCount with createSelector
Review found `selectUnsyncedCount` was a plain function running `.filter()` on every state change. Wrapped with `createSelector` to skip computation when `items` reference hasn't changed.

### D278: NativeWind line-through as static class literal
Review found `${colors.muted} line-through` assembled dynamically — NativeWind v4 static extractor can't process it. Split into two separate ternaries so `'line-through'` appears as a standalone static string literal.

### D279: __DEV__ guard on handleSync console.error
Production builds shouldn't log error details including stack traces. Wrapped `console.error` in sync handler with `if (__DEV__)` guard.

### D280: E2E Proof Flow designed by architect (Opus), executed mechanically by Phase 8
Phase 8 was improvising the proof flow at execution time, risking skipped steps and shallow coverage. Now the architect agent (running on Opus with full feature context) defines the exact E2E Proof Flow table during Phase 4 — including testIDs, CDP expressions, expected state assertions, and numbered screenshot filenames. Phase 8 executes this plan mechanically with no improvisation. Added mandatory section 9 to rn-code-architect output format, verification in Phase 4, clarifying question in Phase 3, and "Deviations from Plan" section in PROOF.md.

## 2026-03-16: S6 — Offline Banner with Network Detection

### D281: New networkSlice instead of extending settingsSlice
Network state (`isOffline`) is transient and should not be persisted. Keeping it in a separate `networkSlice` avoids accidentally adding it to the redux-persist whitelist (which only includes `settings` and `user`).

### D282: Poll globalThis.__OFFLINE__ instead of @react-native-community/netinfo
NetInfo requires native module installation which complicates Expo Go testing. Polling a global flag via `setInterval` is simpler, fully mockable via `cdp_evaluate`, and aligns with the test app's purpose of exercising plugin tools.

### D283: Hardcoded STATUS_BAR_HEIGHT fallback over useSafeAreaInsets
`useSafeAreaInsets` from react-native-safe-area-context crashes in Expo Go when `<SafeAreaProvider>` isn't initialized early enough. Hardcoded `Platform.OS === 'ios' ? 59 : StatusBar.currentHeight` is reliable across all Expo Go scenarios. Trade-off: won't adapt to future iOS devices with different notch heights.

### D284: useRef pattern for stale closure prevention in useCallback
`fetchFeed` uses `useCallback([dispatch])` but reads `isOffline`. Closing over the Redux selector value creates stale reads. Solution: `isOfflineRef` synced via a separate `useEffect`, read inside the callback. Avoids adding `isOffline` to deps (which would recreate the callback on every toggle).

### D285: Immediate network check on mount before interval starts
Gemini review found that `setInterval` doesn't fire immediately — first check waits 2s. Extracted the check into a named function, called it synchronously before starting the interval. Ensures banner appears on mount if already offline.

### D286: UIManager.setLayoutAnimationEnabledExperimental for Android
LayoutAnimation is experimental on Android and silently no-ops without explicit enablement. Added platform-guarded call at module scope in OfflineBanner.

### D287: Stable item.id-based testIDs over index-based
Codex review flagged `feed-item-${index}` — indices shift when items are filtered or reordered, making E2E assertions unreliable. Changed to `feed-item-${item.id}` for stability.

### D288: PostToolUse hook for automatic post-edit health checks
During S6, the agent introduced a broken MSW import that caused a syntax error on the simulator. The agent continued working without noticing. Added a PostToolUse hook on Edit/Write that fires after `.ts/.tsx/.js/.jsx` edits: waits 2s for Fast Refresh, checks Metro status and Hermes debug targets via HTTP (no WebSocket to avoid conflicting with cdp-bridge). Debounced to 5s to avoid latency on rapid edits. Exit 2 with stderr surfaces the error to Claude's context.

### D289: HTTP-only health check (no WebSocket from hook)
The PostToolUse hook cannot open a WebSocket to Hermes because cdp-bridge already holds the persistent connection — a second connection causes "another debugger connected" errors. Instead, the hook uses HTTP only: `GET /status` (Metro alive) and `GET /json` (debug targets exist). This catches app crashes and Metro failures but not RedBox errors. RedBox detection remains in Phase 5.5 verification via cdp_status.

### D290: AbortController timeout on fetch calls
FeedScreen's fetch to `api.testapp.local` (mock domain) hung indefinitely when MSW wasn't running. Added 5s AbortController timeout so the fetch aborts and shows an error state instead of loading forever. Applied to FeedScreen; other screens with similar patterns should follow.

## 2026-03-16: S7-S10 Implementation

### D291: PanResponder + Animated for swipe-to-delete (no gesture handler)
Used `PanResponder` + `Animated` API from react-native core instead of `react-native-gesture-handler` because RNGH is not installed and adding it requires an Expo Go rebuild. Trade-off: gesture runs on JS thread (not native), so swipe may stutter under heavy JS load.

### D292: pendingDelete in Redux with insertIndex for restore position
Stores the soft-deleted task, its original array index, and its ID in `tasksSlice.pendingDelete`. On restore, task is spliced back at the original position (clamped to array bounds). Only one pending delete at a time — second delete permanently commits the first.

### D293: UndoSnackbar timer in component, not Redux
The 5-second undo countdown lives as a `setTimeout` in `UndoSnackbar`'s `useEffect`, not in the store. Keeps the store serializable while the component manages the ephemeral timer lifecycle.

### D294: isRefresh parameter to skip loading overlay during pull-to-refresh
`fetchFeed(triggerError, isRefresh)` skips `dispatch(setLoading(true))` when `isRefresh=true`, preventing the full-screen loading spinner from replacing the FlatList during pull-to-refresh. The native `RefreshControl` spinner handles the visual feedback instead.

### D295: formatRelativeTime as pure function in feedSlice
Shared `formatRelativeTime(ts)` utility exported from `feedSlice.ts` for both FeedScreen and SettingsScreen. Returns "just now" / "Xm ago" / "Xh ago". Note: does not auto-refresh — requires a re-render from state change to update the display.

### D296: SyncContext + SyncBridge for background sync state sharing
`useBackgroundSync` hook must mount globally in App.tsx for the 30s interval to persist across tab switches. `SyncContext` provides `syncNow` and `isSyncing` to SettingsScreen without prop drilling through the navigation tree.

### D297: lastSynced in settingsSlice auto-persisted
Added `lastSynced: number | null` to `settingsSlice` which is already in redux-persist's whitelist. Sync timestamp persists across app restarts automatically — no migration needed.

### D298: Removed dead badge Animated.Values after Codex/Gemini review
Initially added `Animated.spring` scale animations for tab badge counts, but `tabBarBadge` only accepts `number | string` — the Animated.Values were never attached to any rendered element. Removed dead code. Badge animation would require a fully custom `tabBarIcon` which is over-engineering for the test app.

### D299: Include pendingDelete in addTask maxId computation
`addTask` computes `maxId` from `state.items` to generate unique IDs. If the highest-ID task is soft-deleted and a new task is added, it would get the same ID as the pending task. Fixed by including `pendingDelete.task.id` in the maxId calculation.

### D300: TaskDetail deep link reuses existing linking pattern
`TaskDetail: 'tasks/:id'` follows the identical nesting pattern as `NotificationDetail: 'notification/:id'`. No `initialRouteName` needed — matches existing convention.

### D301: CDP-only verification strategy for Expo Go apps
During S7-S10 live verification, `device_*` tools (agent-device CLI) brought the Agent Device Runner app to the foreground, stealing focus from Expo Go. Adopted a CDP-only verification strategy: `cdp_interact` for button presses, `cdp_evaluate` for synchronous store dispatch + read, `cdp_store_state` for state verification, and `xcrun simctl io booted screenshot` for screenshots. This avoids the agent-device focus-stealing issue (B71).

### D302: Synchronous cdp_evaluate for time-sensitive store verification
The 5s undo timer in UndoSnackbar fires before MCP tool round-trips can complete. Used single `cdp_evaluate` calls that find the Redux store via the fiber tree, dispatch actions, and read state synchronously — proving softDelete/restoreTask work correctly without race conditions.

## 2026-03-16: Critical Plugin Tool Fixes (Phase 37)

### D303: WeakSet-based cycle detection in getTree() serializer
`JSON.stringify` on React fiber trees throws `TypeError: cyclical structure in JSON object` when components use `PanResponder` or `Animated.ValueXY` (B69). Replaced all three `JSON.stringify` call sites in the injected helpers `getTree()` with a `safeStringify()` function that uses a `WeakSet` to track visited objects and replaces cycles with `'[Circular]'`. Also sanitizes `hookStates` — functions become `'[Function]'`, circular objects become `'[Circular]'` via pre-serialization try/catch. Bumped `__HELPERS_VERSION__` from 6 to 7.

### D304: Expo Go detection in device_snapshot to prevent focus stealing
`agent-device` CLI's `device_snapshot(action=open)` brings its own Runner app to the foreground on iOS Simulator, stealing focus from Expo Go (B71). Added early detection of Expo Go bundle IDs (`host.exp.Exponent`, `host.exp.exponent`) in `device-session.ts` — returns `failResult` with guidance to use CDP tools and `xcrun simctl` instead. This is a routing-level fix: the tool rejects the call before spawning the CLI process.

### D305: Atomic dispatch+read via cdp_dispatch tool
Added `cdp_dispatch` as a new MCP tool (20th tool) that calls `__RN_AGENT.dispatchAction()` — a single synchronous JS execution that finds the Redux store (3-tier: global → Zustand → Provider fiber walk), dispatches an action, and optionally reads state at a given path. This eliminates the race condition where separate dispatch and read MCP calls are separated by 1-2s round-trip time, which caused the 5s undo timer to fire between operations. The `dispatchAction` helper reuses the same store-finding fiber walk pattern as `getStoreState` but with `dispatch()` instead of `getState()`.

### D306: Auto-recovery in cdp_status for dev:false and isPaused states
`cdp_status` now auto-recovers from two common failure states without user intervention: (1) When `__DEV__` is false — indicates CDP connected to wrong Hermes JS context (common in RN 0.76+ Bridgeless mode). Calls `client.softReconnect()` to re-probe targets, retries the status probe, and returns recovered status with `autoRecovered` metadata if successful. (2) When `isPaused` is true — calls `softReconnect()` which resumes the debugger, then checks if still paused. Both paths fall through to warning messages if recovery fails, guiding the user to `cdp_reload(full=true)`.

## 2026-03-16: Post-Review Fixes (Codex + Gemini)

### D307: Pass large maxLen to safeStringify in getTree() to preserve fallback logic
Codex and Gemini both identified that `safeStringify`'s internal 50KB truncation made `getTree()`'s fallback logic unreachable — the function returned a short truncation sentinel before `getTree()` could measure the real length and apply its graceful degradation (single-match fallback or "Tree too large" error). Fixed by passing `maxLen=999999` on the initial `safeStringify` calls in `getTree()`, letting the function measure real output size, then using standard `safeStringify` (with default 50KB limit) for the fallback payloads.

### D308: dev:false recovery falls through to isPaused check instead of returning early
Gemini identified that the `dev === false` auto-recovery path returned `okResult` immediately on success, skipping the subsequent `isPaused` check. If the recovered JS context was also paused, the caller would get `isPaused: true` inside a success response without guidance. Refactored to set `devRecovered` flag and `autoRecoveredMessage`, fall through to the `isPaused` check, then attach the recovery metadata to the final `okResult`.
