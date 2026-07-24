---
name: rn-debugging
description: This skill should be used when the user asks to "debug the app", "fix a crash", "diagnose a blank screen", "read error logs", "troubleshoot CDP connection", "check Metro status", "find native crashes", "inspect network failures", "the app crashed", "I see a blank screen", "the screen is white", "something broke", "app won't load", "RedBox error", "network requests failing", or needs guidance on CDP vs bash debugging, error type identification, connection troubleshooting, or post-reload readiness for React Native apps.
---

# rn-debugging — CDP Usage, Error Identification, and Connection Troubleshooting

How to diagnose problems in React Native apps using the CDP MCP server,
native device logs, and bash tools.

---

## CDP vs Bash Decision Table

| What you need to know | Tool | Command / MCP call |
|----------------------|------|--------------------|
| Is Metro running? | MCP | `cdp_status` |
| Is app showing a crash (JS)? | MCP | `cdp_error_log` |
| Is app showing a crash (native)? | MCP | `collect_logs(sources=["native_ios"])` or `collect_logs(sources=["native_android"])` |
| Unified JS + native logs? | MCP | `collect_logs(sources=["js_console","native_ios"], durationMs=3000)` |
| What screen is the user on? | MCP | `cdp_navigation_state` |
| What does the component render? | MCP | `cdp_component_tree(filter="MyComponent")` |
| What is in the store? | MCP | `cdp_store_state(path="cart.items")` |
| What API calls were made? | MCP | `cdp_network_log(limit=10)` |
| What did console.log output? | MCP | `cdp_console_log(level="all")` |
| Did the JS engine pause? | MCP | `cdp_status` (reports isPaused) |
| Is there a RedBox overlay? | MCP | `cdp_component_tree` (auto-detects and warns) |
| Dismiss RedBox / toggle inspector | MCP | `cdp_dev_settings(action="dismissRedBox")` |
| Is Metro bundler alive? | MCP | `cdp_status` |
| Is a specific element on screen? | MCP | `device_find(text="element")` or Maestro `assertVisible` |
| Tap an element by text or ref | MCP | `device_find(text="Login", action="click")` or `device_press(ref="@e3")` |
| Fill a text input | MCP | `device_fill(ref="@e5", text="hello")` |
| What are all UI elements? | MCP | `device_snapshot` (cross-platform accessibility tree with @refs) |
| What are all UI elements' positions? | bash | `adb shell uiautomator dump` (Android only, raw XML) |
| Arbitrary runtime value | MCP | `cdp_evaluate(expression="...")` |

**Key rule:** If `cdp_error_log` is empty but the app is visibly broken, the
problem is native. CDP only sees JavaScript — check native logs as fallback.

---

## Error Types Matrix

| Error Type | Where to Find It | Tool |
|-----------|------------------|------|
| JS runtime error (throw, TypeError) | `cdp_error_log` | MCP |
| Unhandled promise rejection | `cdp_error_log` | MCP |
| Uncaught error overlay (RedBox) | `cdp_component_tree` (APP_HAS_REDBOX warning) | MCP |
| `console.error()` call | `cdp_console_log(level="error")` | MCP |
| Metro bundle syntax error | `cdp_metro_events` | MCP |
| Native crash (iOS) | `collect_logs(sources=["native_ios"], logLevel="error")` | MCP |
| Native crash (Android) | `collect_logs(sources=["native_android"], logLevel="error")` | MCP |
| Cross-layer crash diagnosis | `collect_logs(sources=["js_console","native_ios"], durationMs=3000, logLevel="error")` | MCP |
| Network failure | `cdp_network_log` (look for status=0 or missing status) | MCP |

**Note:** Replace `"/YourApp"` with the actual binary name and `com.example.app`
with the real bundle ID. Find the binary name on the bound simulator:
`ls $(xcrun simctl get_app_container <bound-udid> <bundle-id>)`

---

## Environment Status Check (Always First)

Before any testing or debugging, call `cdp_status`. It returns:

```json
{
  "metro": { "running": true, "port": 8081 },
  "cdp": { "connected": true, "device": "iPhone 16 Pro", "pageId": 3 },
  "app": {
    "platform": "ios", "dev": true, "hermes": true,
    "rnVersion": "0.83.1",
    "dimensions": { "width": 393, "height": 852 },
    "hasRedBox": false, "isPaused": false, "errorCount": 0
  },
  "capabilities": {
    "networkDomain": true, "fiberTree": true, "networkFallback": false
  }
}
```

Decision tree:
- `metro.running = false` → inspect `rn_session(action="status")`, then use literal `pnpm ios` or `pnpm android` for an integrated session
- `app.hasRedBox = true` → read `cdp_error_log`, fix the error, then `cdp_reload`
- `app.isPaused = true` → `cdp_reload` (auto-reconnects after reload)
- `app.errorCount > 0` → check `cdp_error_log` before continuing
- `capabilities.networkDomain = false` → network logging uses injected hooks (RN < 0.83)
- `capabilities.fiberTree = false` → release build or non-Hermes engine

---

## Connection Troubleshooting Guide

| Symptom | Cause | Fix |
|---------|-------|-----|
| Metro not found | Session Metro is not running | Inspect `rn_session(action="status")`, then use literal `pnpm ios` or `pnpm android` |
| No Hermes target | Bound app target is not loaded | Open the bound app, wait for its bundle, then call `cdp_connect` |
| Error code 1006 | Another debugger connected | Close React Native DevTools, Flipper, or Chrome DevTools |
| Evaluate timeout (5s) | JS thread blocked or paused | Search for `debugger;` statements; check for long sync ops |
| "hook not available" | Release build or JSC engine | Only works in `__DEV__` mode with Hermes |
| `APP_HAS_REDBOX` | Error overlay showing | Read `cdp_error_log`, fix code, `cdp_reload` |
| "No store found" | Zustand not exposed | Add `if (__DEV__) global.__ZUSTAND_STORES__ = { ... }` |
| All CDP calls fail | Stale authority-bound Hermes target | Reload the bound app and reconnect with `cdp_connect` |
| `dev: false` in status | Bound runtime lacks development helpers | Restart the session-bound Metro and app, then call `cdp_connect` |
| fiberTree/navRef missing | Wrong Bridgeless context | RN 0.76+ Bridgeless exposes multiple Hermes targets; `cdp_status` warns if `dev: false` |

**Code 1006:** Hermes allows only one CDP client. Close all debugger UIs first.
**Code 1001:** Normal close from a reload — handled automatically, no action needed.

---

## Recovering from HELPERS_NOT_INJECTED

When a `cdp_*` tool returns `code: HELPERS_NOT_INJECTED`, the bridge has already done all of this:

1. Waited up to 5s for the connect-time injection to flip the flag
2. Actively re-injected `__RN_AGENT` once with a 3s React-ready timeout
3. Attempted a Dev Client picker dismissal (in case a native overlay was blocking React)
4. Waited up to another 30s if the picker was dismissed

So when this error appears, **the JS world is genuinely hung** — Hermes is up but `__RN_AGENT` won't land. Two recovery paths, in order:

| Step | Action | Why |
|------|--------|-----|
| 1 | Switch the immediate task to `device_*` tools (`device_press`, `device_fill`, `device_snapshot`, `device_screenshot`) | These run through XCTest / adb and don't depend on injected JS at all. The task usually doesn't need React fiber introspection — it just needs to interact with the visible UI. |
| 2 | If React state is specifically needed (`cdp_component_tree`, `cdp_store_state`, `cdp_navigation_state`), call `cdp_reload` once | Forces a clean bundle reload + reconnect, which re-runs the full injection handshake. Note: open modals, in-progress forms, or unsaved screen state are wiped — confirm with the user before reloading if their work is at risk. |

**Anti-pattern**: retrying `cdp_status` in a loop. The connection is up; status calls don't re-trigger injection in this state — they return immediately and let you spin. The error code is the signal to change strategy, not to wait longer.

---

## Post-Reload Readiness

After `cdp_reload`, the server auto-reconnects and waits up to 30 seconds for
React DevTools hook. If `cdp_component_tree` returns "No fiber roots"
immediately after reload, wait 2 seconds and retry.

Manual readiness check:
```
cdp_evaluate(expression="typeof __REACT_DEVTOOLS_GLOBAL_HOOK__ !== 'undefined' && __REACT_DEVTOOLS_GLOBAL_HOOK__.renderers?.size > 0")
```

---

## CDP Technical Constraints

### 5-Second Timeout on All Calls

Every CDP call has a hard 5-second timeout. Common causes of timeout:
- `debugger;` statement in code
- Long synchronous computation
- Unresolved promise with `awaitPromise=true`
- Metro busy bundling

### Single CDP Session

Hermes allows exactly one CDP client at a time. Things that consume a session:
- React Native DevTools (built into RN 0.73+)
- Flipper (older projects)
- Chrome DevTools connected via Metro
- The MCP server itself

### Fiber Tree Limitations

- Only works in `__DEV__` builds with Hermes engine
- Component in fiber tree does NOT mean visible on screen
- Full tree dumps are expensive — always use `filter` parameter

---

## Common Error Patterns

For diagnostic recipes covering "Cannot read property X of undefined",
"Invariant Violation", native crashes with no CDP error, truncated results,
and missing network requests, consult **`references/common-error-patterns.md`**.

---

## Metro Health Check

Call `rn_session(action="status")` to inspect the bound Metro authority, then
use `cdp_status` for passive runtime health and `cdp_metro_events` for bundle
failures. Ambient default ports are diagnostic only and never establish
session authority.

---

## Native Log Commands

For full native log command reference (iOS `log stream`, Android `logcat`,
binary name discovery), see the **rn-device-control** skill.

---

## Common Rationalizations

Agents routinely skip diagnostic steps because "the problem looks obvious." Don't.

| Excuse | Reality |
|--------|---------|
| "The error message is clear — I'll just fix what it says" | Error messages are symptoms. A "Cannot read property 'x' of undefined" may mean a store slice isn't hydrated, a race condition in a selector, or a stale cache. Read `cdp_store_state` and `cdp_error_log` together before editing code. |
| "Native crashes look rare — skip `collect_logs(sources=['native_ios'])`" | Blank screens, unresponsive apps, and reload loops are often native crashes that show nothing in JS. If the screen is empty and `cdp_error_log` is empty, native is where the truth lives. |
| "CDP is flaky, I'll work around it with `xcrun simctl`" | `xcrun simctl` bypasses the app state — you fix the wrong layer. If CDP is unstable, debug CDP (`cdp_status`, check Metro, check target). Don't route around it. |
| "I know what's wrong, skip the component tree" | `cdp_component_tree(filter="X")` is ~300ms. Confirming the rendered fiber state takes less time than one wrong guess. Always verify your mental model before editing. |
| "The fix is small, I don't need to reproduce first" | Without a before-state, you can't prove the fix actually works. Reproduce → fix → reproduce-again is the only trustworthy loop. |
| "Reloading will make the problem go away" | Reload is a lazy workaround, not a fix. If the bug re-appears after navigation or state changes, you haven't fixed it. Find the root cause. |

## Red Flags — Stop and Reconsider

If you notice yourself doing any of these, stop and reassess:

- Editing code without having read `cdp_error_log` + `cdp_component_tree` first
- About to run `xcrun simctl` or `adb logcat` directly instead of `collect_logs`
- Claiming "fixed" without running the reproduction steps again
- Declaring "looks fine now" based on a screenshot alone — check store state too
- Suggesting a reload without having identified the actual bug
- Adding `try/catch` to silence the error instead of understanding it

## Verification — Before Declaring a Fix Complete

- [ ] `cdp_status` returns `ok:true` with no errors
- [ ] Reproduction steps executed AGAIN after the fix → bug no longer reproduces
- [ ] `cdp_error_log(clear: true)` → `cdp_error_log()` shows zero new errors
- [ ] If the bug showed symptoms on screen, `device_screenshot` now shows expected state
- [ ] If the bug was state-related, `cdp_store_state(path="<slice>")` returns expected shape
- [ ] Cross-platform: check the same flow on the OTHER platform (`cross_platform_verify`)

---

## Additional Resources

- **`references/common-error-patterns.md`** — Diagnostic recipes for common RN errors
- **`references/navigation-patterns.md`** — Navigation debugging: modal→tab navigation (B75), nested navigator patterns, CDP navigate usage
- **`references/capability-matrix.md`** — CDP feature support by React Native version
