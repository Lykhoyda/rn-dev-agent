# rn-dev-agent — Project Instructions Template

Copy the section below into your project's `CLAUDE.md` file to ensure Claude
always uses the rn-dev-agent plugin tools instead of raw bash commands.

---

## React Native Development (rn-dev-agent)

This project uses the **rn-dev-agent** plugin (v0.15.1) for React Native development and testing.
It provides 38 MCP tools across three categories: CDP introspection, device control, and testing.

### When to Use Which Tool

#### "I need to check if the app is running"
Use `cdp_status` — it checks Metro, CDP connection, app info, active errors, and RedBox state in one call. **NEVER** use `curl localhost:8081` or `xcrun simctl list` for this.

#### "I need to see what's on screen"
- **Accessibility tree (for interaction):** `device_snapshot` — returns the full UI tree with @ref handles you can tap/fill
- **React component tree (for debugging):** `cdp_component_tree(filter="<testID>")` — returns fiber tree with props/state. **Always filter** — never dump the full tree (wastes 10K+ tokens)
- **Visual screenshot:** `device_screenshot` — captures the screen as an image

#### "I need to tap a button / fill an input"
- **Know the @ref** (from a prior `device_snapshot`): `device_press(ref="@e3")`
- **Know the visible text**: `device_find(text="Submit", action="click")` — finds and taps in one call
- **Fill a text input**: `device_fill(ref="@e5", text="hello@example.com")`
- **Multiple steps at once**: `device_batch` — chain press/fill/swipe actions in one call
- **Swipe/scroll**: `device_swipe`, `device_scroll`, `device_scrollintoview`
- **Long press**: `device_longpress(ref="@e7")` or with coordinates
- **NEVER** use `xcrun simctl` or `adb input` for UI interaction
- `cdp_interact` is **DEPRECATED** — always use device tools instead

#### "I need to navigate to a specific screen"
- **Best option:** `cdp_nav_graph(action="go", screen="ProfileScreen")` — scans navigation graph, plans route, navigates in one call
- **Direct dispatch:** `cdp_navigate(screen="Settings")` — dispatches navigate action (supports nested navigators)
- **Check current location:** `cdp_navigation_state` — returns current route + full stack
- **Map all screens:** `cdp_nav_graph(action="scan")` — returns complete navigator tree
- **NEVER** use `xcrun simctl openurl` for in-app navigation

#### "I need to check app state (Redux/Zustand/React Query)"
- **Read store state:** `cdp_store_state` — auto-detects Redux, reads Zustand globals, queries React Query cache
- **Dispatch an action + read back:** `cdp_dispatch(action={type: "cart/addItem", payload: ...}, readBack="cart")` — dispatch and verify in one call
- **Read component hook state:** `cdp_component_state(testID="email-input")` — returns useState, useForm, useRef values

#### "I need to check for errors"
- **JS errors:** `cdp_error_log` — buffered JS exceptions (last 50). Use `clear=true` to reset baseline before testing
- **Console output:** `cdp_console_log` — buffered console.log/warn/error (last 200)
- **Network requests:** `cdp_network_log` — buffered fetch/XHR history (last 100). Use `filter="/api/endpoint"` to narrow
- **All logs at once:** `collect_logs` — parallel collection from JS console + native iOS/Android logs
- **If `cdp_error_log` is empty but app is broken** — the problem is native. Use `collect_logs` to check native crash logs

#### "I need to run arbitrary JavaScript in the app"
Use `cdp_evaluate(expression="...")` — executes in the Hermes runtime with a 5-second timeout. Good for one-off checks, toggling feature flags, or calling injected helper functions.

#### "I need to reload the app"
Use `cdp_reload` — triggers a full reload with automatic reconnect and target re-validation. After reload, wait for `cdp_component_tree` to return fiber roots before proceeding (retry after 2s if empty).

#### "I need to manage device permissions"
- **Query:** `device_permission(action="query", permission="notifications")`
- **Grant/revoke:** `device_permission(action="grant", permission="camera")`
- **Warning:** Revoking a permission kills the app process on both platforms — follow up with `cdp_status` to reconnect

#### "I need to write or run E2E tests"
- **Generate a Maestro test:** `maestro_generate` — creates persistent YAML test file from structured steps
- **Run a single flow:** `maestro_run(flow="path/to/flow.yaml")`
- **Run all flows:** `maestro_test_all` — regression suite across all `.maestro/` flows
- Prefer `maestro-runner` over classic Maestro (3x faster, no JVM)

#### "I need to capture proof for a PR"
- **Single proof step:** `proof_step` — navigate + verify + screenshot in one atomic call
- **Full proof capture:** Use `/rn-dev-agent:proof-capture` command for video + screenshots + PR body

### Critical Timing Rules

Tool calls must follow this sequence to avoid race conditions:

```
1. Interaction  →  device_press / device_find / device_fill
2. Wait         →  device_snapshot (confirms UI settled)
3. Query        →  cdp_component_tree / cdp_store_state / cdp_error_log
```

**Common mistake:** Querying `cdp_store_state` immediately after a tap returns stale state. Always take a `device_snapshot` between interaction and CDP queries to let React finish rendering.

### Error Recovery Patterns

| Symptom | Diagnostic tool | Likely cause | Recovery |
|---------|----------------|--------------|----------|
| `cdp_status` fails | Check Metro manually | Metro not running or wrong port | Start Metro, then `cdp_connect(port=XXXX)` |
| `cdp_component_tree` returns "No fiber roots" | Wait 2s, retry | App still mounting after reload | Retry; if persistent, `cdp_reload` |
| `cdp_evaluate` returns `__RN_AGENT is not defined` | Automatic (retry) | Helpers lost after reload | Tool auto-re-injects; if stuck, `cdp_reload` |
| Device tools return "no session" | `device_snapshot` | Session expired or device rebooted | `device_snapshot` starts a new session |
| Blank screen, no JS errors | `collect_logs` | Native crash | Check native logs for crash stack |
| `cdp_store_state` returns stale data | `device_snapshot` first | Read before React finished rendering | Always snapshot before store reads |
| Network request missing | `cdp_network_log(filter="...")` | Request not yet made or filtered | Widen filter or check `cdp_console_log` for fetch errors |

### Authentication & Permission Pre-flight

Before testing **auth-gated features:**
1. `cdp_navigation_state` — check if on a login screen
2. Look for `.maestro/subflows/login.yaml` — use if available
3. `cdp_auto_login` — auto-detects auth screen and runs login subflow
4. `cdp_navigation_state` — verify arrival at home/target screen

Before testing **permission-gated features:**
1. `device_permission(action="query", permission="<name>")` — check current state
2. Grant/revoke as needed — **remember: revoke kills the app process**
3. If revoked, relaunch + `cdp_status` to reconnect before continuing

### Verification Flow

After implementing any feature:
1. `cdp_status` — verify connection is healthy
2. `cdp_error_log(clear=true)` — clear error baseline
3. `cdp_nav_graph(action="go", screen="<ScreenName>")` — navigate to feature screen
4. `device_snapshot` — get accessibility tree, confirm UI settled
5. `cdp_component_tree(filter="<testID>")` — verify component structure and props
6. `device_find` / `device_press` — test user interaction
7. `device_snapshot` — wait for UI to settle after interaction
8. `cdp_store_state` — verify state changes propagated
9. `cdp_error_log` — check for regressions
10. `device_screenshot` — capture proof

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

### Store Setup (for Zustand)

Zustand stores require a one-line dev setup to be inspectable via `cdp_store_state`:

```typescript
if (__DEV__) {
  global.__ZUSTAND_STORES__ = { myStore, otherStore };
}
```

Redux stores are auto-detected. React Query client is auto-detected.
