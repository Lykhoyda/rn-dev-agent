---
command: debug-screen
description: Diagnose why the current screen is broken, showing unexpected content, or crashing. Gathers parallel evidence from all layers and applies a targeted fix.
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, mcp__*cdp__*
---

Diagnose and fix the current screen state on the simulator/emulator.

## Run the rn-debugger protocol INLINE (parent session)

> **Important (GH #31):** Do NOT spawn the `rn-debugger` agent via the Task tool.
> MCP tools (`cdp_*`, `device_*`, `collect_logs`) are not available in spawned
> subagents. Execute the debugger protocol directly in this parent session
> using the `rn-debugging` and `rn-device-control` skills as your reference.

Load the `rn-debugging` skill and follow this diagnostic flow in this session:

1. **Screenshot** — `device_screenshot` to capture the broken state immediately.
2. **Parallel evidence gathering** — call these in parallel:
   - `cdp_error_log` (JS errors)
   - `cdp_console_log` (console output)
   - `cdp_network_log` (recent requests)
   - `cdp_component_tree(filter=...)` (rendered fiber)
   - `collect_logs(sources=["native_ios"])` or `["native_android"]` for native crashes
3. **Error type identification** — classify: JS error vs native crash vs data
   mismatch vs navigation issue vs blank screen.
4. **Root cause narrowing** — read source files flagged by stack traces, check
   `cdp_store_state(path=...)`, inspect native logs if CDP shows nothing.
5. **Fix** — apply the minimal targeted fix, save, wait for Fast Refresh
   (or `cdp_reload(full=true)` for native changes).
6. **Verify recovery** — reproduce the failing action AGAIN, confirm the bug
   no longer reproduces, capture a "fixed" `device_screenshot`.

## Verification (mandatory before declaring "fixed")

- [ ] Root cause stated (not just symptom)
- [ ] Reproduction steps executed AGAIN after the fix → bug gone
- [ ] `cdp_error_log` shows 0 new errors after fix
- [ ] "Before" and "after" screenshots both saved
- [ ] No adjacent files refactored ("while I'm here")

## When to Use

- The screen is blank or white with no RedBox
- There is a RedBox / LogBox error showing
- The UI shows wrong data or is in an unexpected state
- The app is frozen or unresponsive
- A network request is failing
- Navigation went to the wrong screen

## What You Don't Need to Do

You don't need to describe the problem in detail. The MCP tools gather their
own evidence from the running app. Just run the command while the broken
state is visible on the simulator.
