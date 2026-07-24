# rn-dev-agent — Project Instructions Template

Copy the section below into your project's `CLAUDE.md` file to ensure Claude
always uses the rn-dev-agent plugin tools instead of raw bash commands.

The `<!-- rn-dev-agent:template-end -->` sentinel on the last line is part of
the template body: `/rn-dev-agent:setup` uses it to delimit the injected block
when diffing a project's copy against this file for refresh. Keep it last.

---

## React Native Development (rn-dev-agent)

This project uses the **rn-dev-agent** plugin for React Native development and testing.
It provides MCP tools across three categories: CDP introspection, device control, and testing.
Run `/rn-dev-agent:check-env` to verify the current plugin version and tool count.

### 🧠 Repo-local troubleshooting memory

This project keeps an auto-maintained, gitignored notes file at
`.rn-agent/local/troubleshooting.md` with two sections: **Configuration & How-To**
(repo-specific facts — Metro start dir, store exposure, testID conventions,
auth/deeplink, build quirks) and **Troubleshooting** (failure→resolution gotchas).

- **Read it first.** At the start of any device/CDP task, consult this file (the
  SessionStart hook also injects it) so you don't re-derive known gotchas or
  re-hit a known failure.
- **It updates itself.** When rn-dev-agent tool calls fail, a hook records them;
  at session end a Stop hook asks you to merge new gotchas into this file. If
  prompted, do it — keep entries concise and under ~2000 tokens total.
- It is per-developer and never committed.

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

### 🧩 Hybrid composition — actions are skill primitives, not just full replays

Use deterministic actions wherever they fit, and walk only the parts that
don't have a saved action. The all-or-nothing "match → replay; else fully
manual" rule is gone — most real tasks share *partial* overlap with existing
actions (login, onboarding, locale, subscription gate). Compose action +
manual when state mismatches; never re-walk a flow you already have.

**Three rules:**

1. **State-detection prologue.** Before any goal-state task, read current
   state — `cdp_navigation_state` for the route, `cdp_store_state` for the
   relevant slice. Note any mismatch with the expected starting state.
2. **Compose action + manual.** If current state ≠ expected start, scan
   `list-learned-actions` for an action whose `produces` covers the gap.
   Replay via `cdp_run_action`. Re-verify state. Then continue
   interactively for the novel part.
3. **No fully-manual fallback when partial replay would cover half the work.**
   Login is the cardinal example — if a saved login action exists, use it
   as a prologue, never re-walk login interactively.

**Worked example.** User: "tap the cart badge."

- Agent: `cdp_navigation_state` → `LoginScreen` (mismatch with home)
- Agent: `list-learned-actions` → finds `user-login` with
  `produces: { authenticated: true, route: home }`
- Agent: `cdp_run_action({ id: "user-login", params: { EMAIL, PASSWORD } })`
- Agent: `cdp_navigation_state` → `HomeScreen` (state delta closed)
- Agent: `cdp_component_tree({ filter: "cart" })` → finds `cart-badge` ref
- Agent: `device_press({ ref: "cart-badge" })`

**The `produces:` field is optional metadata in the M7 action header.** Existing
actions without `produces` fall back to today's intent-string matching.
Recorders are encouraged to populate it from observed end-of-flow state when
saving via `cdp_record_test_save_as_action`.

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
| **Lock** (promote to regression) | `/rn-dev-agent:lock-e2e <id>` (calls `cdp_lock_e2e_test`) | Runs the action once strict (no repair); freezes the passing flow to `.rn-agent/e2e/<id>.yaml` as an immutable regression test |
| **Regression suite** | `cdp_run_e2e_suite` | Replays all locked tests strict; persists a suite-run report (verdict + per-test results). Also runnable from the observe UI's e2e tab |

**Authoring a new action by hand?** Use the `creating-actions` skill — it walks
the full contract (inventory-dedup scan, selector grounding, M7 header, flow
diagram, pre-replay validation, replay-to-promote).

**Canonical loop.** Record a verified walk once → save as an action → in the
next session, `list-learned-actions` surfaces it for the agent → `run-action`
replays it in ~4 seconds → if a testID drifted, `cdp_run_action` auto-invokes
`cdp_repair_action`, patches the YAML, retries once, and persists the result
to the sidecar's `runHistory[]` with auto-repair telemetry. Successful replay
envelopes explicitly report `transport`, `transportVersion`, `fallback`,
`repair`, per-step engine readback, and authorized `writes`; ordinary replays
preserve tracked action YAML bytes.

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
| Tap an element | `device_press(ref=…)` or `device_find(text=…, action="click")`; use `device_press(x=…, y=…)` only for an intentional raw-coordinate tap | `xcrun simctl io booted input tap`, `adb shell input tap`, coordinate guesses |
| Type into a field | `device_fill(ref=…, text=…)` | `xcrun simctl spawn booted … keyboard`, `adb shell input text` |
| Open an in-app URL / deep link | `device_deeplink` / `cdp_navigate` / `cdp_nav_graph` | `xcrun simctl openurl`, `adb shell am start -a android.intent.action.VIEW` |
| Read app state (Redux/Zustand/Jotai/RQ) | `cdp_store_state(path=…)` | `console.log` + log-tailing, dispatching probes via `cdp_evaluate` |
| Read/clear app storage (MMKV) | `cdp_mmkv` (get/set/delete/has/keys/clear); `device_reset_state` for full reset preflight | raw Nitro poking via `cdp_evaluate`, `simctl uninstall` to clear state |
| Inspect React internals | `cdp_component_tree(filter=…)`, `cdp_component_state` | guessing from screenshots, walking the fiber via raw `cdp_evaluate` |
| Check session / connection / Metro / errors | `rn_session(action="status")`, then `cdp_status` | ambient port or device scans as authority |
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
| Authority-bound Hermes target is missing | `cdp_targets` for diagnostics, then `cdp_connect` | Ambient targets may explain the mismatch but cannot replace the session binding |
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
- Use `rn_session(action="status")` first when the authority binding itself is in question.
- **Do not** use ambient port or device scans to select a target.

#### "I need to see what's on screen"
- **Accessibility tree (for interaction):** `device_snapshot` — returns the full UI tree with @ref handles you can tap/fill. **First action on any new screen.**
- **"What can I tap here?" on a novel screen:** `cdp_component_tree(interactiveOnly: true)` — a salient digest of only the actionable nodes (`{testID, role, text, label, placeholder, disabled}`). Hundreds of tokens instead of the full fiber tree's thousands.
- **React component tree (for debugging):** `cdp_component_tree(filter="<testID>")` — returns fiber tree with props/state. **Always filter or use `interactiveOnly`** — never dump the full tree (wastes 10K+ tokens)
- **Visual screenshot:** `device_screenshot` — captures the screen as an image
- Repeated `device_find` calls on an unchanged screen are near-free — the snapshot is cached and auto-invalidated by any mutating tool call, so don't contort call order to avoid a re-find.

#### "I need to tap a button / fill an input"
- **If you don't know the testID / @ref yet**: `device_snapshot` FIRST.
- **Know the @ref** (from `device_snapshot`): `device_press(ref="@e3")`
- **Know the visible text**: `device_find(text="Submit", action="click")` — finds and taps in one call
- **Fill a text input**: `device_fill(ref="@e5", text="hello@example.com")`
- **Multiple steps at once**: `device_batch` — chain press/fill/swipe actions in one call. Its implicit final snapshot defaults to `salient` (actionable nodes only); pass `finalSnapshot: 'none'` for action-only batches you verify via `expect_*`/`cdp_store_state`, or `'full'` for the complete node list.
- **Swipe/scroll**: `device_swipe`, `device_scroll`, `device_scrollintoview`
- **Long press**: `device_longpress(ref="@e7")` or with coordinates
- **NEVER** use `xcrun simctl` or `adb input` for UI interaction
- **For KNOWN testIDs**: prefer `cdp_interact(testID=…)` (fiber-tree-resolved, no coordinate caching) OR `device_batch` with the `testID` field on find/press/fill (snapshot-resolved per call). Both eliminate the stale-ref-across-step-transitions failure mode. `cdp_interact` also resolves RNTL-style selectors — `role`/`name`/`text`/`placeholder` — and fails closed on ambiguity rather than picking the wrong element.
- **For UNKNOWN elements** (need to discover what's on screen): `device_snapshot` first, then `device_press(ref="@eN")`.
- Stale-`@ref` taps self-heal: the runner re-resolves by identity signature when the match is unique and retries a no-effect tap once (`meta.reResolved` / `meta.tapRetried`). Treat that as a safety net, not a license to reuse old refs — ambiguous re-resolution still fails with `STALE_REF`.

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
Use `cdp_mmkv` — actions `get | set | delete | has | keys | clear`, with typed
reads (`string`/`number`/`boolean`). Requires `react-native-mmkv@^3` (Nitro-based);
older TurboModule versions are not reachable and return `__agent_error`.

For a full test-reset (revoke permissions + clear MMKV keys + force-stop +
relaunch + reconnect CDP), use `device_reset_state` — one atomic preflight call
instead of hand-chaining four tools.

Raw `cdp_evaluate` against `globalThis.NitroModulesProxy` is the fallback only
when `cdp_mmkv` reports MMKV unavailable.

**Verification caveat:** clearing state keys (cooldowns, flags, timestamps) to
unblock a test is a bypass. State it openly when you do it — do not silently
reset and re-test.

#### "I need to check for errors"
- **JS errors:** `cdp_error_log` — buffered JS exceptions (last 50). Use `clear=true` to reset baseline before testing
- **Console output:** `cdp_console_log` — buffered console.log/warn/error (last 200)
- **Network requests:** `cdp_network_log` — buffered fetch/XHR history (last 100). Use `filter="/api/endpoint"` to narrow
- **All logs at once:** `collect_logs` — parallel collection from JS console + native logs. Native Android collection is pinned to the open session's adb serial; native iOS collection is pinned to the open session's simulator and current target-app PID.
- **If `cdp_error_log` is empty but app is broken** — the problem is native. Use `collect_logs` to check native crash logs

#### "I need to run arbitrary JavaScript in the app"
Use `cdp_evaluate(expression="...")` — executes in the Hermes runtime with a 5-second timeout. Good for one-off checks, toggling feature flags, or calling injected helper functions.

**Note:** Hermes dev runtime does not have Node's `require` — Metro bundles modules internally. Access native-module functionality via `globalThis.NitroModulesProxy` (Nitro-based libraries) or the exposed global hooks set up in dev mode (see Required Dev Setup).

#### "I need to reload the app"
Use `cdp_reload` — triggers a full reload with automatic reconnect and target re-validation. After reload, wait for `cdp_component_tree` to return fiber roots before proceeding (retry after 2s if empty).

**If `cdp_reload` returns `reconnected: false` (30s deadline exceeded):**
1. Wait 5-10s for Metro to fully rebuild
2. Call `cdp_connect platform: "android"|"ios" force: true` to re-pin
3. If multiple Hermes targets exist, use `cdp_targets` only to diagnose why the session-bound signed target is unavailable

**iOS expo-dev-client dev menu:** `cdp_reload` best-effort auto-dismisses it after
reconnect. If the bottom sheet is still covering the app, use
`cdp_dev_settings(action="hideDevMenu")` — it dismisses over CDP with no touch,
so Hermes stays attached and the in-memory store survives (a coordinate tap/swipe
on the sheet can detach the debugger). `disableDevMenu` suppresses shake-to-show
before proof recordings.

#### "I need to manage device permissions"
- **Query:** `device_permission(action="query", permission="notifications")`
- **Grant/revoke:** `device_permission(action="grant", permission="camera")`
- **Warning:** Revoking certain permissions (camera, microphone, location) kills the app process on both platforms. Other permissions (notifications on Android in particular) can often be toggled without killing the app. When in doubt, follow up with `cdp_status` — if connection dropped, use `cdp_connect force: true` to recover.

#### "I need to write or run E2E tests"
- **Generate a Maestro test:** `maestro_generate` — creates persistent YAML test file from structured steps
- **Run a single flow:** `maestro_run(flow="path/to/flow.yaml")` — returns structured `steps[]`, `failedStep`, and partial progress on timeout
- **Run all flows:** `maestro_test_all` — regression suite across all `.rn-agent/actions/` flows
- **Freeze a proven action as a regression test:** `/rn-dev-agent:lock-e2e <action-id>` (calls `cdp_lock_e2e_test`) — runs the action once strict (no auto-repair) and freezes it to `.rn-agent/e2e/` only if it passes. Parameterized actions need their params covered by the project's e2e config, or they're refused.
- **Run the locked suite:** `cdp_run_e2e_suite` — replays all locked tests strict, persists a suite-run report with verdict + per-test results (also runnable from the observe UI's e2e tab)
- Prefer `maestro-runner` over classic Maestro (3x faster, no JVM)

#### "I need to capture proof for a PR"
- **Single proof step:** `proof_step` — navigate + verify + screenshot in one atomic call
- **Full proof capture:** Use `/rn-dev-agent:proof-capture` command for video + screenshots + PR body

### Multi-Device Setups

If `device_list` shows more than one booted device (e.g., both an iOS simulator and an Android emulator):

1. Call `cdp_status platform: "android"` or `platform: "ios"` to pin CDP to one target
2. Pass `platform:` explicitly to **all** `device_*` tools thereafter

While a `device_snapshot action=open` session is active, `cdp_status` is bound
to that session's platform (and, on Android, its emulator/physical device
class): requesting a different platform fails with `TARGET_SESSION_MISMATCH`
instead of silently re-targeting — close the session first to switch.

An explicit `platform:` on `device_screenshot` resolves the booted device
directly and captures via raw `simctl` / `adb` (GH #60 — fixed), so
wrong-platform captures should no longer occur. If routing still misbehaves
(e.g. `device_deeplink` to the wrong device), the last-resort manual forms are:

- **Android:** `adb -s <emulator-id> shell am start -a android.intent.action.VIEW -d "<url>"`
- **iOS:** `xcrun simctl openurl <UDID> "<url>"` (may trigger a "Open in App?" system dialog on Expo Dev Client builds)

If you hit a wrong-device routing case the tools can't handle, report it via `/rn-dev-agent:send-feedback`.

### Device Runtime — In-tree runners (`rn-fast-runner` iOS, `rn-android-runner` Android)

Device automation on BOTH platforms is owned by in-tree runners that ship with the plugin: `rn-fast-runner` (XCTest) on iOS and `rn-android-runner` (UIAutomator instrumentation) on Android. The legacy `agent-device` dependency is fully removed — there is no daemon-socket/CLI fallback tier, no global install, and `RN_ANDROID_RUNNER=0` now errors with `RUNNER_DISABLED` instead of silently falling back. The user-facing tool surface (`device_press`, `device_fill`, `device_swipe`, …) is unchanged — only the transport.

What this means in practice:

- **Zero manual setup on either platform.** Runners resolve from a **prebuilt artifact** first — a SHA-256-checked local cache, then a download of the release asset matching the exact plugin version — and only fall back to an on-machine build (`xcodebuild` / Gradle) when no artifact is available. Resolution is fail-open: offline, 404, or checksum mismatch degrades to the local build with a one-line `meta.note`, never a hard failure. A local iOS cold build persists a reusable `.xctestrun`, so even self-built runners pay the multi-minute build at most once. Force a source build with `RN_RUNNER_BUILD=local`. `cdp_status` / `/rn-dev-agent:doctor` report provenance (`prebuilt v<X>` vs `local-built`).
- **Runner staleness self-heals.** Runners version their wire protocol and enumerate supported commands in `/health`; the bridge reaps + reinstalls a stale runner transparently (one restart, `meta.note: "runner upgraded"`). `device_snapshot action=open` auto-invalidates and rebuilds an artifact missing required verbs; mid-flow tools refuse fast with `RUNNER_COMMANDS_STALE` instead of silently building. Only a mismatch that survives reinstall surfaces `RUNNER_PROTOCOL_MISMATCH` with exact rebuild commands. Handshake visible at `cdp_status` → `deviceSession.runnerProtocol`.
- **Legacy upstream `AgentDeviceRunner` apps** from an old install are detected and `simctl uninstall`ed at iOS device-open (an installed XCUITest runner relaunches itself into the foreground mid-flow, backgrounding your app and wedging CDP). Opt out with `RN_DEVICE_KILL_LEGACY=0`.
- **XCTest's idle-wait (quiescence) is bypassed by default on iOS.** RN apps with looping animations/Reanimated worklets never report idle, which used to stall queries and snapshots. Opt out with `RN_QUIESCENCE_BYPASS=0`; audit via `meta.quiescenceBypass` and `cdp_status.deviceSession.runnerCapabilities`. `XCUIElement.typeText` runs its own internal sync, so `device_fill` may still hit a main-thread timeout. The client poisons and reaps that runner and succeeds only when an independent exact CDP readback proves the requested value (`meta.runnerTimeoutRecovery.verification: "exact-readback"`); otherwise it fails closed with `RUNNER_TIMEOUT`.
- **Foreign automation is arbitrated, not collided with.** While a foreign Maestro/XCUITest session drives the target simulator, `device_*` and flow tools refuse fast with `BUSY_FOREIGN_FLOW` (~50 ms) instead of cascading into a runner leak. CDP reads stay free; `device_screenshot` still serves pixels via simctl. Disable with `RN_IOS_FOREIGN_GUARD=0`.
- **The bridge survives Metro restarts.** The MCP entry point is a supervisor holding zero network sockets; killing whatever listens on 8081 kills only the worker, which is respawned with the session intact (`cdp_status` → `bridge.workerRestarts`). Opt out with `RN_BRIDGE_SUPERVISOR=0`.

Built-in reliability layers on `device_*` interactions (all default-ON, each with an opt-out):

| Layer | What it does | Surfaced as | Opt out |
|---|---|---|---|
| **Settle engine** | Every mutating `device_*` verb waits for the UI to actually stabilize (window-update probe / screenshot-static compare, snapshot-hash fallback) instead of fixed sleeps. `device_batch` settles between steps by default. | `meta.settle: {method, settled}` | `RN_SETTLE=0` global, `settle: false` per batch step, `settleTimeoutMs` budget knob |
| **Self-healing taps** | A stale `@ref` re-resolves inline by identity signature (unique match only — ambiguous/absent → `STALE_REF` with candidates); a tap that produced no UI change retries exactly once, unless keyboard-guard or transport recovery already consumed that single retry budget (then it reports `meta.noUiChange` without re-firing); `device_batch` testID resolution refuses ambiguous matches (`AMBIGUOUS_TESTID`). | `meta.reResolved`, `meta.tapRetried`, `meta.noUiChange` | `RN_SELF_HEAL=0` global, `retryIfNoChange: false` per call |
| **Keyboard guard** | Guarded iOS taps use fresh, on-screen target rectangles against the current keyboard frame. If target geometry is stale, off-screen, or unknown (including raw coordinates) while the keyboard is visible, the keyboard is always dismissed first; refs are refreshed/re-resolved and the intended tap is dispatched once. Dismissal tiers are native dismiss control, native swipe, then injected JS with a fresh hidden-state post-check; all tiers failing returns `KEYBOARD_DISMISS_FAILED` without tapping. | `meta.keyboardGuard` (`auto_dismissed` after a heal), `meta.keyboardAutoHeal`, `meta.via`, `meta.timings_ms.keyboardGuard` | `RN_KEYBOARD_GUARD=0` |

Three consecutive no-change taps on distinct targets surface a wedged-runtime hint — reboot the simulator rather than blaming app code.

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

### Portal modal coverage (react-native-actions-sheet, @gorhom/bottom-sheet, custom Modals)

If your app uses `react-native-actions-sheet`, `@gorhom/bottom-sheet`, or any other library that mounts modal content via React Native's `Modal` (which on iOS spawns a separate UIWindow with its own fiber root that React DevTools doesn't enumerate), `cdp_interact press testID="..."` will return "Component not found" for fields inside the modal even though they're visibly mounted.

Fix: expose those portal roots to the plugin in your app entry's `__DEV__` block:

```typescript
if (__DEV__) {
  globalThis.__RN_AGENT_EXTRA_ROOTS__ = () =>
    [
      sheetProviderRef.current,        // react-native-actions-sheet
      bottomSheetRef.current,          // @gorhom/bottom-sheet
    ].filter(Boolean);
}
```

The function is called fresh on every fiber-root scan, so refs that mount and unmount are picked up dynamically. `.filter(Boolean)` handles the case where a ref hasn't been attached yet.

### Critical Timing Rules

Tool calls must follow this sequence to avoid race conditions:

```
1. Interaction  →  device_press / device_find / device_fill
2. Wait         →  device_snapshot (confirms UI settled)
3. Query        →  cdp_component_tree / cdp_store_state / cdp_error_log
```

**Common mistake:** Querying `cdp_store_state` immediately after a tap returns stale state. Always take a `device_snapshot` between interaction and CDP queries to let React finish rendering.

Mutating `device_*` verbs now settle internally (they wait for the UI to
stabilize before returning — check `meta.settle`), so a `device_press` that
returned `settled: true` is usually safe to query after. The explicit
snapshot-between-interaction-and-query rule still fully applies after JS-side
mutations (`cdp_interact`, `cdp_navigate`, `cdp_dispatch`) — those don't run
the runner's settle engine.

### Anti-Patterns — Do Not Do

1. Ambient Metro target scans — use `rn_session(action="status")`, `cdp_status`, and diagnostic-only `cdp_targets`
2. `xcrun simctl list` / `adb devices` for status — use `cdp_status`
3. `xcrun simctl openurl` / `adb shell am start` for in-app navigation — use `cdp_nav_graph` or `device_deeplink`
4. `xcrun simctl` / `adb input` for UI taps — use `device_press` / `device_find`
5. `device_press(ref=@eN)` with a stale ref from an earlier-screen snapshot (refs don't survive step transitions) — use `cdp_interact(testID=…)` or `device_batch.{find,press,fill}(testID=…)` for known testIDs, which re-resolve per call. Self-healing re-resolution catches the unique-match case, but ambiguous matches still fail with `STALE_REF`
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
| `cdp_status` fails | `rn_session(action="status")` | Session Metro or target binding is unavailable | Use the integrated package script, then `cdp_connect` |
| `cdp_component_tree` returns "No fiber roots" | Wait 2s, retry | App still mounting after reload | Retry; if persistent, `cdp_reload` |
| `cdp_evaluate` returns `__RN_AGENT is not defined` | Automatic (retry) | Helpers lost after reload | Tool auto-re-injects; if stuck, `cdp_reload` |
| Device tools return "no session" | `rn_session(action="status")` | Authority session expired or lost its device binding | Restore the exact session binding before opening `device_snapshot` |
| Blank screen, no JS errors | `collect_logs` | Native crash | Check native logs for crash stack |
| `cdp_store_state` returns stale data | `device_snapshot` first | Read before React finished rendering | Always snapshot before store reads |
| Network request missing | `cdp_network_log(filter="...")` | Request not yet made or filtered | Widen filter or check `cdp_console_log` for fetch errors |
| `cdp_reload` reports `reconnected: false` | Wait 5-10s | New Hermes target not yet registered | `cdp_connect force: true`; if ambiguous target, pass `targetId:` |
| `BUSY_FOREIGN_FLOW` refusal | `cdp_status` | A foreign Maestro/XCUITest session is driving the simulator | Wait for it to finish or stop the foreign automation; CDP reads and `device_screenshot` still work |
| `RUNNER_COMMANDS_STALE` / `RUNNER_PROTOCOL_MISMATCH` | `cdp_status` → `deviceSession.runnerProtocol` | Runner artifact predates the installed plugin | `device_snapshot action=open` auto-invalidates + rebuilds; only a surviving mismatch needs the rebuild commands in the error |
| `KEYBOARD_DISMISS_FAILED` refusal (iOS) | `device_snapshot` | A visible keyboard could not be proven hidden after the native control/swipe tiers and the optional injected JS tier, so no tap was performed | Connect CDP with `cdp_connect` so the JS tier can run, dismiss the keyboard explicitly, then retry with a fresh snapshot/ref |
| `maestro_run` fails with `RUNTIME_DEGRADED` hint | — | Simulator runtime is wedged (taps report success, `onPress` never fires) | `xcrun simctl shutdown/boot` the simulator, relaunch, retry — don't chase app code |
| `APP_NOT_INSTALLED` | — | Relaunch/recovery target isn't installed (e.g. after clearState) | Follow the `simctl install` advice in the error, then reconnect |
| Replay fails, `meta.cdpJsFallback` present | `cdp_status` | iOS 26.x WDA reads an empty a11y tree (TRANSPORT_BLIND) | The CDP/JS replay fallback engages automatically; a `cdp-unreachable` skip means fix the CDP connection first |
| All `cdp_*`/`device_*` tools missing after a Claude plugin upgrade | `/reload-plugins`, then inspect MCP inventory | The active Claude process still has the previous plugin snapshot | Reload Claude plugins; if the tools remain absent, exit and relaunch Claude Code. Do not describe Codex `/mcp verbose` as reconnect. |
| Verifying against stale code with Metro running | `rn_session(action="status")`, then `cdp_status` | Session Metro or signed bundle does not match the worktree | Restart through the integrated package script and re-pin with `cdp_connect` |
| `cdp_interact accessibilityLabel="..."` fails (label matching is fuzzy) | Prefer testID-keyed calls: `cdp_interact(testID="...")` or `device_batch` with `testID=` field. Fall back to `device_snapshot` + `device_press(ref="@eN")` only when no testID exists. | Label matching unreliable; testID matching is exact and fiber-tree-resolved | — |
| "Disconnected due to opening a second DevTools window" / React Native DevTools keeps getting kicked | `cdp_status` → `autoConnect` field | RN allows one debugger frontend per app; bridge auto-reconnects by default (agent-first) | Set `RN_CDP_AUTOCONNECT=0` or `.rn-agent/config.json` → `{ "cdp": { "autoConnect": false } }`. `cdp_status` stays passive; `cdp_connect` and gated CDP tools reclaim the authority-bound seat when needed. |

### Authentication & Permission Pre-flight

Before testing **auth-gated features:**
1. `cdp_navigation_state` — check if on a login screen
2. Scan `/rn-dev-agent:list-learned-actions login` — a saved login action with `produces: { authenticated: true }` is the preferred prologue (replay via `cdp_run_action`, ~4s; see Hybrid composition)
3. Otherwise look for `.maestro/subflows/login.yaml`, or `cdp_auto_login` — auto-detects auth screen and runs the login subflow
4. `cdp_navigation_state` — verify arrival at home/target screen

Before testing **permission-gated features:**
1. `device_permission(action="query", permission="<name>")` — check current state
2. Grant/revoke as needed — **remember: some permissions (camera/mic/location) kill the app process; notifications on Android usually do not**
3. If revoked and the app died, relaunch + `cdp_status` to reconnect before continuing
4. For a full clean-slate preflight (permissions + MMKV keys + force-stop + relaunch + reconnect), `device_reset_state` does it in one atomic call

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
| `/rn-dev-agent:doctor` | Diagnose installation health — runners, Metro, CDP, helpers, ffmpeg/idb, plugin version. Read-only |
| `/rn-dev-agent:list-learned-actions [keyword]` | Inventory of saved actions + UI skeleton + feedback memories — run before any manual `device_*` walk |
| `/rn-dev-agent:run-action <id> [-e K=V]` | Replay a saved action with pre-flights + auto-repair |
| `/rn-dev-agent:lock-e2e <action-id>` | Freeze a proven action into a strict locked regression test |
| `/rn-dev-agent:proof-capture` | Feature is done, need PR-ready video + screenshots + PR body |
| `/rn-dev-agent:nav-graph` | Need to understand or query the app's navigation structure |
| `/rn-dev-agent:observe` | The observe web UI autostarts with the session at `http://127.0.0.1:7333` — tool-call timeline, live device mirror (MJPEG), route/store/tree panels, learned-actions runner, e2e tab. Use the command to get the URL, `stop`, or `restart`; opt out via `observe.autoStart: false` or `RN_AGENT_OBSERVE_AUTOSTART=0` |
| `/rn-dev-agent:send-feedback` | Report a plugin bug or issue (creates sanitized GitHub issue) |

<!-- rn-dev-agent:template-end -->
