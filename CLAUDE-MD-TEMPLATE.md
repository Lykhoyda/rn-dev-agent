# rn-dev-agent — Project Instructions Template

Copy the section below into your project's `CLAUDE.md` file to ensure Claude
always uses the rn-dev-agent plugin tools instead of raw bash commands.

---

## React Native Development (rn-dev-agent)

This project uses the **rn-dev-agent** plugin for React Native development and testing.
It provides MCP tools across three categories: CDP introspection, device control, and testing.
Run `/rn-dev-agent:check-env` to verify the current plugin version and tool count.

### 🚨 MANDATORY PRE-FLIGHT (before ANY device_* call)

Run this 3-step checklist at the start of every UI-touching task. This is the
single highest-leverage rule in the plugin — it prevents the most common
failure mode (multi-minute manual `device_*` walks for flows that already
exist as YAML).

1. **List existing automation:** `/rn-dev-agent:list-learned-actions [feature-keyword]`
   — surfaces matching Maestro flows + UI skeletons + feedback memories for the
   current project.
2. **If a flow matches your intent:** replay it first.
   `/rn-dev-agent:run-action <flow-name> [-e KEY=VALUE …]` — pre-flights
   mutates flag, appId match, and parameter coverage; falls back to direct
   `maestro-runner --platform <ios|android> test … <flow-path>` if you
   need to inspect the run yourself. A passing replay IS your evidence —
   skip ahead to capturing proof.
3. **Only if no match (or replay fails with a concrete error):** fall back to
   manual primitives (`device_press` / `device_fill` / `device_find`). When
   you do, **end the session by persisting the verified flow** as a new YAML
   under `<test-app>/.rn-agent/actions/<feature-slug>.yaml` so the next session
   starts at step 2, not step 3.

Manual walks are a fallback, not a default. Codified in
`feedback_execute_artifacts_before_manual.md`. Enforced as Step 0 of
`/rn-dev-agent:test-feature` and Step 0a of the `rn-tester` / `rn-debugger`
agent protocols.

---

### Reusable Actions (the L3 corpus)

An "action" is a Maestro YAML flow stored at `<project>/.rn-agent/actions/<id>.yaml`
paired with a runtime sidecar at `<project>/.rn-agent/state/<id>.state.json`.
The YAML is the executable test; the sidecar tracks `revision`, `status`
(`experimental` / `active` / `deprecated`), `runHistory[]`, and `repairHistory[]`.
The plugin records, replays, and self-heals these flows so an identical user
flow that took ~13 minutes the first time costs ~4 seconds on every replay
afterward — discovery is a one-time cost, replay is the steady state.

**Lifecycle and tooling:**

| Stage | Tool / command | What it does |
|---|---|---|
| **Discover** (record) | `cdp_record_test_start` → walk the app → `cdp_record_test_stop` | Buffers events to `.rn-agent/recordings/<id>.json` (pre-save) |
| **Save** | `cdp_record_test_save_as_action` | Promotes a recording into a paired YAML + sidecar at `.rn-agent/actions/` + `.rn-agent/state/`. Auto-writes the M7 metadata header (`id`, `intent`, `tags`, `mutates`, `status`, optional `produces`) |
| **List** | `/rn-dev-agent:list-learned-actions [keyword]` | Browse the corpus by intent / tags / appId. Section B of the output shows actions, Section C shows the UI skeleton, Section A surfaces feedback memories |
| **Run** | `/rn-dev-agent:run-action <id> [-e KEY=VALUE …]` (calls `cdp_run_action`) | Replays with safety pre-flights (mutates flag, appId match, parameter coverage) and auto-repair on `SELECTOR_NOT_FOUND` |
| **Self-heal** | `cdp_repair_action <id>` | Fuzzy-matches the stale testID against the live snapshot, patches the YAML in place, bumps `revision`, demotes `status` to `experimental` until next clean replay. Bounded: max 3 attempts/24h, refuses on human edits (mtime check) |
| **Assert state** | `expect_redux`, `expect_route`, `expect_visible_by_testid`, `expect_text` | Macro-Asserts — embed internal-state assertions inside replays. Maestro asserts pixels; these assert what the app actually believes |
| **Compact** | `/rn-dev-agent:rn-agent-compact` | Periodic corpus health report — flags cold (90+ day), flaky (>50% failure), or high-churn (5+ repairs/30d) actions. Deletion is human-in-the-loop |

**Canonical loop.** Record a verified walk once → save as an action → in the
next session, `list-learned-actions` surfaces it for the agent → `run-action`
replays it in ~4 seconds → if a testID drifted, `cdp_run_action` auto-invokes
`cdp_repair_action`, patches the YAML, retries once, and persists the result
to the sidecar's `runHistory[]` with auto-repair telemetry.

**Status maturity.** New actions ship as `experimental`. The first clean
replay auto-promotes them to `active`. Self-repair demotes back to
`experimental` until the next clean replay re-validates. `deprecated` is a
manual gesture for actions you want to retain for history but no longer run.

#### Hybrid composition (D1209)

Treat actions as **composable skill primitives**, not just self-contained
tests. Many tasks share *partial* overlap with existing actions — login is
the cardinal example: every test that needs an authenticated session
benefits from replaying a saved login action as a deterministic prologue
(~4s) instead of re-walking it (~30s+ with LLM-in-the-loop).

The artifact-first rule generalizes from "replay if exact match" to
**"use deterministic actions wherever they fit, walk only the gaps"**.

**Three rules for any goal-state task:**

1. **Detect current state first.** Before navigating to the requested
   feature, read `cdp_navigation_state` (current route) and
   `cdp_store_state(path=…)` (relevant slices, e.g. `auth.user`). Note
   any mismatch with the expected starting state — login screen vs home,
   wrong tab, missing onboarding step, etc.

2. **Match the gap, not just the intent.** When you scan
   `/rn-dev-agent:list-learned-actions` output, check the `Produces`
   column alongside `Purpose`. An action with
   `produces: { authenticated: true, route: home }` is the right
   prologue when current state is `LoginScreen` and the user wants
   anything that requires auth — even if the user's task isn't "log in"
   per se. Replay that action via `cdp_run_action`. Re-verify state.
   Then continue with interactive `cdp_*` / `device_*` tools for the
   novel part.

3. **No false-binary fallbacks.** Never fall back to a fully-manual
   walk when a partial replay (login prologue, onboarding skip, locale
   set) covers half the work. The cost of one failed replay attempt is
   `cdp_run_action`'s auto-repair budget (3/24h); the cost of a fully
   manual walk is 30s+ of context-burning device interaction.

**Example — user says "go to home and tap the cart badge":**

```
1. cdp_navigation_state             → returns "LoginScreen" (mismatch)
2. /rn-dev-agent:list-learned-actions  (or read .rn-agent/actions/ directly)
                                    → finds `user-login` with
                                      produces: { authenticated: true, route: home }
3. cdp_run_action({                 (deterministic prologue, ~4s)
     id: "user-login",
     params: { EMAIL, PASSWORD }
   })
4. cdp_navigation_state             → returns "HomeScreen" (state delta closed)
5. cdp_component_tree({             (interactive discovery for the novel part)
     filter: "cart"
   })                               → finds `cart-badge` ref
6. device_press({ ref: "cart-badge" })
```

**When persisting a new action**, populate `produces` if the flow
establishes any reusable state — auth, route, feature flag, locale,
seeded data. Schema: flat map of primitives.

```
cdp_record_test_save_as_action({
  id: "user-login",
  intent: "Log in via email + password",
  tags: ["auth", "login"],
  mutates: false,
  produces: { authenticated: true, route: "home" }
})
```

Optional — actions without `produces` keep working; the LLM falls back
to intent-string matching for them. The field is purely additive
metadata.

---

### 🚨 Tool Routing — STRICT RULES (read this second)

All app interaction MUST go through plugin MCP tools — never raw shell. The plugin's tools
handle waits, multi-device routing, session reuse, retry logic, and timing that
`xcrun simctl` / `adb shell` / `screencapture` do not. **Bypassing them is the #1 source
of flaky agent behavior.** When in doubt, prefer the plugin tool; the escape hatches below
are documented exceptions, not defaults.

| Action | ✅ ALWAYS use | 🚫 NEVER use |
|---|---|---|
| Screenshot the screen | `device_screenshot` | `xcrun simctl io booted screenshot`, `adb shell screencap`, `screencapture` |
| Read the UI / accessibility tree | `device_snapshot` (returns @ref handles) | parsing `xcrun simctl io ui`, `uiautomator dump`, ad-hoc tree dumps |
| Tap an element | `device_press(ref=…)` or `device_find(text=…, action="click")` | `xcrun simctl io booted input tap`, `adb shell input tap`, coordinate guesses |
| Type into a field | `device_fill(ref=…, text=…)` | `xcrun simctl spawn booted … keyboard`, `adb shell input text` |
| Open an in-app URL / deep link | `device_deeplink` / `cdp_navigate` / `cdp_nav_graph` | `xcrun simctl openurl`, `adb shell am start -a android.intent.action.VIEW` |
| Read app state (Redux/Zustand/Jotai/RQ) | `cdp_store_state(path=…)` | `console.log` + log-tailing, dispatching probes via `cdp_evaluate` |
| Inspect React internals | `cdp_component_tree(filter=…)`, `cdp_component_state` | guessing from screenshots, walking the fiber via raw `cdp_evaluate` |
| Check connection / Metro / errors | `cdp_status` | `curl http://localhost:8081/json`, `xcrun simctl list`, `adb devices` |
| Read JS errors / console / network | `cdp_error_log`, `cdp_console_log`, `cdp_network_log` | `tail -f` log files, `adb logcat | grep` (those are NATIVE-error fallbacks only — see Error Recovery below) |
| Reload the app | `cdp_reload` (auto-reconnects) | `xcrun simctl terminate … && launch …`, `adb shell am force-stop` |
| Manage permissions | `device_permission(action=…)` | raw `xcrun simctl privacy`, `adb shell pm grant` |
| Run an E2E flow | **First**: replay any existing `<test-app>/.rn-agent/actions/*.yaml` via `maestro_run`. **Then**: `device_*` for novel verification. **Last**: `maestro_generate` to persist the new flow under `.rn-agent/actions/`. | hand-rolled bash loops, ad-hoc xdotool/AppleScript, recreating a flow that already exists |

**Artifact-first rule (paired with the table):** Before composing any `device_*` sequence,
scan for existing automation. Run `/rn-dev-agent:list-learned-actions` to see the inventory
of feedback memories + Maestro flows + UI skeletons available in this project. If a flow
matches what you're about to do manually, replay it instead. This rule is enforced as
**Step 0** of `/rn-dev-agent:test-feature` and codified in the auto-memory entry
`feedback_execute_artifacts_before_manual.md`. Manual primitives are a fallback, not a
default.

**Documented escape hatches** (use ONLY when the listed condition fires):

| Condition | Escape | Why |
|---|---|---|
| Multiple Hermes targets, `cdp_connect` picked the wrong one | `curl -s http://localhost:8081/json` to enumerate, then `cdp_connect(targetId="…")` | The plugin can't disambiguate without the explicit ID |
| Multi-device routing bug — `device_screenshot` captured the wrong platform | `xcrun simctl io <UDID> screenshot` (iOS) / `adb -s <id> exec-out screencap -p` (Android) | Tracked: [Lykhoyda/rn-dev-agent#60](https://github.com/Lykhoyda/rn-dev-agent/issues/60) |
| `cdp_error_log` empty but app is broken | `collect_logs` (parallel JS+native) — drops to native log streams | Native crashes don't surface in the JS error buffer |
| App fully crashed / picker stuck | `xcrun simctl terminate` + manual relaunch + `cdp_connect force: true` | When `cdp_reload` can't recover |

If you find yourself reaching for `xcrun simctl` / `adb shell` and your situation is NOT in
the escape-hatch table above, **stop** — you're routing around a plugin tool that exists.

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
- **For KNOWN testIDs**: prefer `cdp_interact(testID=…)` (fiber-tree-resolved, no coordinate caching) OR `device_batch` with the new `testID` field on find/press/fill (snapshot-resolved per call). Both eliminate the stale-ref-across-step-transitions failure mode.
- **For UNKNOWN elements** (need to discover what's on screen): `device_snapshot` first, then `device_press(ref="@eN")`.

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
- **Run all flows:** `maestro_test_all` — regression suite across all `.rn-agent/actions/` flows
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

Most projects need **zero source mutation** — the plugin's CDP-injected helpers walk the React fiber tree to find `<NavigationContainer>`'s ref and the React Navigation hooks chain automatically. The table below lists what each tool needs to work; rows marked "auto-discovered" require no user code.

| Tool | Requires |
|------|----------|
| `cdp_navigate` / `cdp_nav_graph go` | **Auto-discovered via fiber walk** for any project using `<NavigationContainer ref={…}>` (React Navigation 6+) or Expo Router's `Stack`/`Slot`. **Fallback**: if the fiber walk misses (rare; class-component roots, exotic patterns), call `getBridge()?.registerNavRef(navigationRef)` once after creating the ref. The bridge lives at `.rn-agent/dev-bridge.ts` (shipped by `/rn-dev-agent:setup`). |
| `cdp_store_state` (Zustand) | One call from your app entry: `getBridge()?.registerStores({ name1: useStore1, name2: useStore2 })`. No fiber-walkable signal exists for Zustand stores, so explicit registration is required. |
| `cdp_store_state` (Jotai) | `global.__JOTAI_STORE__` + `global.__JOTAI_ATOMS__` in `__DEV__` (manual; bridge support pending) |
| `cdp_store_state` (Redux) | Auto-detected via Provider |
| `cdp_store_state` (React Query) | Auto-detected via QueryClient |
| `device_deeplink` (custom scheme) | App registers the URL scheme in `app.json` / native configs |
| MMKV read/write via `cdp_evaluate` | `react-native-mmkv@^3` (Nitro-based) OR legacy shim exposed on global |

**Bridge pattern (`.rn-agent/dev-bridge.ts`):** the file is committed in the user's repo at `<project>/.rn-agent/dev-bridge.ts` and exposes a tiny API gated by `__DEV__`:

```ts
import { getBridge } from './.rn-agent/dev-bridge';

const navigationRef = createNavigationContainerRef<RootStackParams>();
getBridge()?.registerNavRef(navigationRef);
getBridge()?.registerStores({ auth: useAuthStore, cart: useCartStore });
```

`getBridge()` returns null in production, so the optional-chain is a no-op — every assignment is tree-shaken from the release bundle. No `__DEV__` guards needed at the call site.

If `cdp_navigate` fails with "Navigation ref not found" despite the fiber walk, the most likely causes are: (a) the app isn't fully bundled yet — wait for `cdp_status.helpersInjected: true`; (b) class-component root that doesn't expose a ref — use the bridge `registerNavRef` fallback; (c) a non-React-Navigation router — out of scope for this plugin's current tools.

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
5. `device_press(ref=@eN)` with a stale ref from an earlier-screen snapshot (the "13:55 experiment" failure mode — refs don't survive step transitions) — use `cdp_interact(testID=…)` or `device_batch.{find,press,fill}(testID=…)` for known testIDs, which re-resolve per call
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
| `cdp_interact accessibilityLabel="..."` fails (label matching is fuzzy) | Prefer testID-keyed calls: `cdp_interact(testID="...")` or `device_batch` with `testID=` field. Fall back to `device_snapshot` + `device_press(ref="@eN")` only when no testID exists. | Label matching unreliable; testID matching is exact and fiber-tree-resolved | — |

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
