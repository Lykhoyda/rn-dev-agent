# React Native Debugging

Decision tables and troubleshooting for debugging RN apps via CDP and bash.

## CDP vs Bash Decision Table

| What you need | Use CDP (MCP tool) | Use Bash |
|--------------|-------------------|----------|
| JS runtime errors | `cdp_error_log` | — |
| React component state | `cdp_component_tree` | — |
| Navigation state | `cdp_navigation_state` | — |
| Store state (Redux/Zustand) | `cdp_store_state` | — |
| Network requests | `cdp_network_log` | — |
| Console output | `cdp_console_log` | — |
| Execute JS in app | `cdp_evaluate` | — |
| Screenshot | — | `xcrun simctl io` / `adb exec-out screencap` |
| Native crash (iOS) | — | `xcrun simctl spawn booted log stream --predicate 'processImagePath contains "App"' --level error` |
| Native crash (Android) | — | `adb logcat -b crash` |
| App lifecycle | — | `xcrun simctl launch/terminate` / `adb shell am` |
| UI hierarchy (Android) | — | `adb shell uiautomator dump` |
| Metro bundle errors | — | `curl localhost:8081/status` |

## Error Types and Where to Find Them

| Error Type | Where | Tool |
|-----------|-------|------|
| JS runtime error | `cdp_error_log` | MCP |
| Unhandled promise | `cdp_error_log` | MCP |
| React render error | `cdp_component_tree` (RedBox detection) | MCP |
| Console.error() | `cdp_console_log(level="error")` | MCP |
| Native crash (iOS) | `xcrun simctl spawn booted log stream` | bash |
| Native crash (Android) | `adb logcat -b crash` | bash |
| Metro bundle error | `curl localhost:8081/status` | bash |
| Network failure | `cdp_network_log` (status=0 or missing) | MCP |

**Key rule: If CDP shows no errors but the app is broken, the problem is native.** Always check native logs as a fallback.

## Connection Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| cdp_status: Metro not found | Dev server not running | `npx expo start` or `npx react-native start` |
| cdp_status: No Hermes target | App not loaded yet | Wait, then retry |
| CDP connect: code 1006 | Another debugger connected | Close RN DevTools / Flipper / Chrome DevTools |
| cdp_evaluate: timeout | JS thread blocked or paused | Check for `debugger;` statements, long sync ops |
| cdp_component_tree: "hook not available" | Release build or non-Hermes | Only works in __DEV__ with Hermes |
| cdp_component_tree: APP_HAS_REDBOX | Error screen showing | Read `cdp_error_log`, fix code, `cdp_reload` |

## Diagnostic Flow

When something is broken:

```
1. cdp_status → Check connection, RedBox, paused state
   ├── Not connected → Is Metro running? Is app loaded?
   ├── RedBox → cdp_error_log → read error → fix
   └── Connected, no RedBox → continue

2. Screenshot → What does the user see?
   bash: xcrun simctl io booted screenshot --type=jpeg /tmp/debug.jpg

3. Gather data (parallel):
   - cdp_component_tree(filter="ProblemArea")
   - cdp_console_log(level="error", limit=10)
   - cdp_network_log(limit=5)
   - cdp_store_state(path="relevant.slice")

4. Narrow down:
   - UI wrong? → Check component tree props/state
   - Data wrong? → Check store state, network responses
   - Error in console? → Trace the error source
   - Network failed? → Check URL, status, timing

5. Fix → cdp_reload → Verify fix
```

## Post-Reload Readiness

After `cdp_reload(full=true)`, the MCP server auto-reconnects and waits for React readiness. But if `cdp_component_tree` returns "No fiber roots" immediately after reload, wait 2 seconds and retry.

## WebSocket Close Codes

| Code | Meaning | Action |
|------|---------|--------|
| 1001 | Going away (reload) | Auto-reconnect after 1.5s |
| 1006 | Abnormal close (crash or session conflict) | Stop, investigate native logs |
| 1000 | Normal close | Reconnect if needed |

## Common Debugging Patterns

### App shows blank screen
```
1. cdp_status → Check if connected
2. cdp_error_log → Check for JS errors
3. cdp_component_tree(depth=1) → Is anything rendered?
4. cdp_console_log → Check for warnings/errors
5. If all empty → native crash: check adb logcat / simctl log
```

### API calls failing
```
1. cdp_network_log(filter="/api") → Check status codes
2. If status=0 → Network unreachable (check emulator networking)
3. If status=4xx/5xx → Server error (check response)
4. cdp_evaluate("fetch('http://localhost:3000/health').then(r=>r.text())") → Test connectivity
```

### State not updating after action
```
1. Verify timing: Did you assertVisible BEFORE querying CDP?
2. cdp_store_state(path="slice") → Is store updated?
3. cdp_component_tree(filter="Component") → Are props fresh?
4. If store updated but component stale → Re-render issue
5. If store NOT updated → Check action dispatch / reducer
```
