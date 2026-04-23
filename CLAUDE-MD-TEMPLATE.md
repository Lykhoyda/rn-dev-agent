# rn-dev-agent — Project Instructions Template

Copy the section below into your project's `CLAUDE.md` file to ensure Claude
always uses the rn-dev-agent plugin tools instead of raw bash commands.

---

## React Native Development (rn-dev-agent)

This project uses the **rn-dev-agent** plugin for React Native development and testing.
It provides MCP tools across three categories: CDP introspection, device control, and testing.
Run `/rn-dev-agent:check-env` to verify the current plugin version and tool count.

### Operating Modes

The rules tighten as you move rightward:

| Mode | What it means | Shortcuts allowed? |
|------|---------------|--------------------|
| **Exploration** | Understanding how the app works | ✅ Anything goes — deep-link, dispatch, set state |
| **Debugging** | Isolating a broken screen | ⚠️ OK to reproduce broken state; state shortcuts explicitly |
| **Verification** | Confirming the feature works for real users | 🚫 NO SHORTCUTS — see Verification Discipline below |

When you start a task, identify which mode you're in. If in doubt during a user-facing
feature task, **assume Verification** — it has the strictest rules.

### Verification Discipline (non-negotiable during verification)

When verifying a feature works for real users, the following are **SHORTCUTS** that
invalidate the verification unless the user explicitly accepts them:

1. Deep-linking past the entry point of the flow you're verifying
   (`gtsf://main/settings/success` instead of tapping from home)
2. Forcing route params a real user can't set (`isNewPolicy=true`,
   `fromSuccess=true`, `isFirstTime=true`)
3. Clearing MMKV/AsyncStorage keys to reset cooldowns, flags, or onboarding state
4. Dispatching Redux actions instead of triggering through UI
5. Using `cdp_nav_graph` / `cdp_navigate` to jump past login, onboarding, or
   mutation prerequisites

**If you must shortcut, STATE it explicitly and ask the user whether the verification
is still valid.** Do not silently paper over UI friction with programmatic state injection.

**Mutation-as-proof:** for features involving a mutation (add, update, delete),
`cdp_network_log` must show the mutation fired through normal UI interaction —
not pre-inserted via deep-link or Redux dispatch. The network log is the ground
truth of "did the user's journey work."

**Snapshot-first:** on any new/unfamiliar screen, `device_snapshot` is always the
correct first action. Do not tap by coordinates or trust remembered testIDs.
Jumping to `device_press` without snapshotting is how agents tap the wrong
element, then stab at coords when confused.

### When to Use Which Tool

#### "I need to check if the app is running"
Use `cdp_status` — it checks Metro, CDP connection, app info, active errors, and RedBox state in one call.
- **Do not** use `curl localhost:8081` or `xcrun simctl list` for routine status checks.
- **Exception:** when multiple Hermes targets exist (common after reload spawns extras) and `cdp_connect` picks the wrong one, `curl -s http://localhost:8081/json` is the correct way to enumerate target IDs — pass the right one via `targetId:`.

#### "I need to see what's on screen"
- **Accessibility tree (for interaction):** `device_snapshot` — returns the full UI tree with @ref handles you can tap/fill. **First action on any new screen.**
- **React component tree (for debugging):** `cdp_component_tree(filter="<testID>")` — returns fiber tree with props/state. **Always filter** — never dump the full tree (wastes 10K+ tokens)
- **Visual screenshot:** `device_screenshot` — captures the screen as an image

#### "I need to tap a button / fill an input"
- **If you don't know the testID / @ref yet**: `device_snapshot` FIRST.
- **Know the @ref** (from `device_snapshot`): `device_press(ref="@e3")`
- **Know the visible text**: `device_find(text="Submit", action="click")` — finds and taps in one call
- **Fill a text input**: `device_fill(ref="@e5", text="hello@example.com")`
- **Multiple steps at once**: `device_batch` — chain press/fill/swipe actions in one call
- **Swipe/scroll**: `device_swipe`, `device_scroll`, `device_scrollintoview`
- **Long press**: `device_longpress(ref="@e7")` or with coordinates
- **NEVER** use `xcrun simctl` or `adb input` for UI interaction
- **`cdp_interact` is DEPRECATED** — always use device tools instead

#### "I need to navigate to a specific screen"
- **Best option:** `cdp_nav_graph(action="go", screen="ProfileScreen")` — scans navigation graph, plans route, navigates in one call
- **Direct dispatch:** `cdp_navigate(screen="Settings")` — dispatches navigate action (supports nested navigators)
- **Check current location:** `cdp_navigation_state` — returns current route + full stack
- **Map all screens:** `cdp_nav_graph(action="scan")` — returns complete navigator tree
- **NEVER** use `xcrun simctl openurl` for in-app navigation
- **Verification caveat:** during verification, `cdp_nav_graph` / `cdp_navigate` are shortcuts if they bypass a login screen, onboarding step, or mutation prerequisite. Prefer UI taps or deep links that a real user could produce. See Verification Discipline.

#### "I need to check app state (Redux/Zustand/React Query)"
- **Read store state:** `cdp_store_state` — auto-detects Redux, reads Zustand globals, queries React Query cache
- **Dispatch an action + read back:** `cdp_dispatch(action={type: "cart/addItem", payload: ...}, readBack="cart")` — dispatch and verify in one call
- **Read component hook state:** `cdp_component_state(testID="email-input")` — returns useState, useForm, useRef values
- **Verification caveat:** `cdp_dispatch` to force state is a shortcut. Only use during exploration/debugging.

#### "I need to read or clear app storage (MMKV)"
For apps using `react-native-mmkv@^3` (Nitro-based):

```typescript
// Via cdp_evaluate:
const factory = globalThis.NitroModulesProxy.createHybridObject('MMKVFactory')
const mmkv = factory.createMMKV({ id: factory.defaultMMKVInstanceId })
const value = mmkv.getString('MyKey')         // read
mmkv.remove('CooldownTimestamps')             // clear
mmkv.set('MyKey', 'value')                    // write
```

**Verification caveat:** clearing state keys (cooldowns, flags, timestamps) to
unblock a test is a bypass. State it openly when you do it — do not silently
reset and re-test.

#### "I need to check for errors"
- **JS errors:** `cdp_error_log` — buffered JS exceptions (last 50). Use `clear=true` to reset baseline before testing
- **Console output:** `cdp_console_log` — buffered console.log/warn/error (last 200)
- **Network requests:** `cdp_network_log` — buffered fetch/XHR history (last 100). Use `filter="/api/endpoint"` to narrow
- **All logs at once:** `collect_logs` — parallel collection from JS console + native iOS/Android logs
- **If `cdp_error_log` is empty but app is broken** — the problem is native. Use `collect_logs` to check native crash logs

#### "I need to run arbitrary JavaScript in the app"
Use `cdp_evaluate(expression="...")` — executes in the Hermes runtime with a 5-second timeout. Good for one-off checks, toggling feature flags, or calling injected helper functions.

**Note:** Hermes dev runtime does not have Node's `require` — Metro bundles modules internally. Access native-module functionality via `globalThis.NitroModulesProxy` (Nitro-based libraries) or the exposed global hooks set up in dev mode (see Required Dev Setup).

#### "I need to reload the app"
Use `cdp_reload` — triggers a full reload with automatic reconnect and target re-validation. After reload, wait for `cdp_component_tree` to return fiber roots before proceeding (retry after 2s if empty).

**If `cdp_reload` returns `reconnected: false` (30s deadline exceeded):**
1. Wait 5-10s for Metro to fully rebuild
2. Call `cdp_connect platform: "android"|"ios" force: true` to re-pin
3. If multiple Hermes targets exist (reload sometimes spawns extras), use `targetId:` with the exact id from `curl -s http://localhost:8081/json`

#### "I need to manage device permissions"
- **Query:** `device_permission(action="query", permission="notifications")`
- **Grant/revoke:** `device_permission(action="grant", permission="camera")`
- **Warning:** Revoking certain permissions (camera, microphone, location) kills the app process on both platforms. Other permissions (notifications on Android in particular) can often be toggled without killing the app. When in doubt, follow up with `cdp_status` — if connection dropped, use `cdp_connect force: true` to recover.

#### "I need to write or run E2E tests"
- **Generate a Maestro test:** `maestro_generate` — creates persistent YAML test file from structured steps
- **Run a single flow:** `maestro_run(flow="path/to/flow.yaml")`
- **Run all flows:** `maestro_test_all` — regression suite across all `.maestro/` flows
- Prefer `maestro-runner` over classic Maestro (3x faster, no JVM)

#### "I need to capture proof for a PR"
- **Single proof step:** `proof_step` — navigate + verify + screenshot in one atomic call
- **Full proof capture:** Use `/rn-dev-agent:proof-capture` command for video + screenshots + PR body

### Multi-Device Setups

If `device_list` shows more than one booted device (e.g., both an iOS simulator and an Android emulator):

1. Call `cdp_status platform: "android"` or `platform: "ios"` to pin CDP to one target
2. Pass `platform:` explicitly to **all** `device_*` tools thereafter
3. If `device_screenshot` captures the wrong platform despite `platform:`, fall back to:
   - **Android:** `adb -s <emulator-id> exec-out screencap -p > out.png`
   - **iOS:** `xcrun simctl io <UDID> screenshot out.png`
4. If `device_deeplink` routes to the wrong device, use:
   - **Android:** `adb -s <emulator-id> shell am start -a android.intent.action.VIEW -d "<url>"`
   - **iOS:** `xcrun simctl openurl <UDID> "<url>"` (may trigger a "Open in App?" system dialog on Expo Dev Client builds)

This is a known plugin issue — see [Lykhoyda/rn-dev-agent#60](https://github.com/Lykhoyda/rn-dev-agent/issues/60) for tracking and escape-hatch patterns.

### Required Dev Setup for Full Tool Coverage

| Tool | Requires |
|------|----------|
| `cdp_navigate` / `cdp_nav_graph go` | `globalThis.__NAV_REF__ = navigationRef.current` set in dev only (typically in `NavigationContainer.onReady`) |
| `cdp_store_state` (Zustand) | `global.__ZUSTAND_STORES__ = { store1, store2 }` in `__DEV__` |
| `cdp_store_state` (Jotai) | `global.__JOTAI_STORE__` + `global.__JOTAI_ATOMS__` in `__DEV__` |
| `cdp_store_state` (Redux) | Auto-detected via Provider |
| `cdp_store_state` (React Query) | Auto-detected via QueryClient |
| `device_deeplink` (custom scheme) | App registers the URL scheme in `app.json` / native configs |
| MMKV read/write via `cdp_evaluate` | `react-native-mmkv@^3` (Nitro-based) OR legacy shim exposed on global |

If `cdp_navigate` fails with "Navigation ref not found," add the one-line assignment
in your `NavigationContainer.onReady` handler. Do **not** commit this — it's
dev-only instrumentation.

### Critical Timing Rules

Tool calls must follow this sequence to avoid race conditions:

```
1. Interaction  →  device_press / device_find / device_fill
2. Wait         →  device_snapshot (confirms UI settled)
3. Query        →  cdp_component_tree / cdp_store_state / cdp_error_log
```

**Common mistake:** Querying `cdp_store_state` immediately after a tap returns stale state. Always take a `device_snapshot` between interaction and CDP queries to let React finish rendering.

### Anti-Patterns — Do Not Do

1. `curl http://localhost:8081/json` — use `cdp_status` (except for multi-target enumeration, see above)
2. `xcrun simctl list` / `adb devices` for status — use `cdp_status`
3. `xcrun simctl openurl` / `adb shell am start` for in-app navigation — use `cdp_nav_graph` or `device_deeplink`
4. `xcrun simctl` / `adb input` for UI taps — use `device_press` / `device_find`
5. `cdp_interact` — DEPRECATED, use `device_press` / `device_find` / `device_fill`
6. Coordinate taps (`input tap 640 2300`) without prior `device_snapshot`
7. **Deep-linking past the entry point during verification** (see Verification Discipline)
8. **Forcing transient route params (`isNewPolicy=true`, `fromSuccess=true`) during verification**
9. **Clearing cooldown/timestamp MMKV keys mid-verification without flagging it**
10. **Dispatching Redux actions when the feature should be triggered via UI**
11. Relying on a remembered testID without a fresh `device_snapshot` after screen change
12. Declaring a verification "passed" when the network log doesn't show the mutation real users trigger

### Error Recovery Patterns

| Symptom | Diagnostic tool | Likely cause | Recovery |
|---------|----------------|--------------|----------|
| `cdp_status` fails | `curl localhost:8081/json` | Metro not running or wrong port | Start Metro, then `cdp_connect(port=XXXX)` |
| `cdp_component_tree` returns "No fiber roots" | Wait 2s, retry | App still mounting after reload | Retry; if persistent, `cdp_reload` |
| `cdp_evaluate` returns `__RN_AGENT is not defined` | Automatic (retry) | Helpers lost after reload | Tool auto-re-injects; if stuck, `cdp_reload` |
| Device tools return "no session" | `device_snapshot` | Session expired or device rebooted | `device_snapshot` starts a new session |
| Blank screen, no JS errors | `collect_logs` | Native crash | Check native logs for crash stack |
| `cdp_store_state` returns stale data | `device_snapshot` first | Read before React finished rendering | Always snapshot before store reads |
| Network request missing | `cdp_network_log(filter="...")` | Request not yet made or filtered | Widen filter or check `cdp_console_log` for fetch errors |
| `cdp_reload` reports `reconnected: false` | Wait 5-10s | New Hermes target not yet registered | `cdp_connect force: true`; if ambiguous target, pass `targetId:` |
| `device_screenshot` captures the wrong platform | — | Multi-device routing bug | Pass `platform:` explicitly, or fall back to raw `adb screencap` / `simctl io` |
| `cdp_interact accessibilityLabel="..."` fails | `device_snapshot` first | Label matching unreliable | Switch to `device_press(ref="@eN")` using snapshot output |

### Authentication & Permission Pre-flight

Before testing **auth-gated features:**
1. `cdp_navigation_state` — check if on a login screen
2. Look for `.maestro/subflows/login.yaml` — use if available
3. `cdp_auto_login` — auto-detects auth screen and runs login subflow
4. `cdp_navigation_state` — verify arrival at home/target screen

Before testing **permission-gated features:**
1. `device_permission(action="query", permission="<name>")` — check current state
2. Grant/revoke as needed — **remember: some permissions (camera/mic/location) kill the app process; notifications on Android usually do not**
3. If revoked and the app died, relaunch + `cdp_status` to reconnect before continuing

### Verification Flow

After implementing any feature, in this order:

1. `cdp_status` — verify connection is healthy
2. `cdp_error_log(clear=true)` — clear error baseline
3. **Declare the user journey** — write out the user-facing steps you expect in plain language *before* you start clicking. This is your contract.
4. Navigate to the feature **via the entry point a real user would use** (home screen tab, deep link a user could receive, etc.). Only use `cdp_nav_graph(action="go", ...)` if that screen is itself the entry point.
5. `device_snapshot` — first action on every new screen. Confirm UI settled.
6. `cdp_component_tree(filter="<testID>")` — verify component structure and props
7. `device_find` / `device_press` — test user interaction
8. `device_snapshot` — wait for UI to settle after interaction
9. `cdp_network_log` — verify the expected mutation fired through the UI (mutation-as-proof)
10. `cdp_store_state` — verify state changes propagated
11. `cdp_error_log` — check for regressions
12. `device_screenshot` + `proof_step` — capture proof
13. **Terminal check:** does your network log include the real-user mutation? Did you take any shortcuts? If so, list them and flag the verification as "partial / with bypasses." A clean verify is one where no step bypassed the real user path.

### Key Commands

| Command | When to use |
|---------|-------------|
| `/rn-dev-agent:rn-feature-dev <desc>` | Building a new feature end-to-end (8-phase pipeline: explore, design, implement, verify) |
| `/rn-dev-agent:test-feature` | Feature is implemented, need to verify it works on simulator |
| `/rn-dev-agent:build-and-test` | Need to build from scratch (EAS/local), install, and test |
| `/rn-dev-agent:debug-screen` | Screen is broken, blank, or showing unexpected content |
| `/rn-dev-agent:check-env` | Verify Metro, CDP, simulator are ready before starting work |
| `/rn-dev-agent:proof-capture` | Feature is done, need PR-ready video + screenshots + PR body |
| `/rn-dev-agent:nav-graph` | Need to understand or query the app's navigation structure |
| `/rn-dev-agent:send-feedback` | Report a plugin bug or issue (creates sanitized GitHub issue) |
