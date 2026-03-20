---
command: debug-screen
description: Diagnose why the current screen is broken, showing unexpected content, or crashing. Gathers parallel evidence from all layers and applies a targeted fix.
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, mcp__rn-dev-agent-cdp__*
agent: rn-debugger
---

Diagnose and fix the current screen state on the simulator/emulator.

## Usage

```
/rn-dev-agent:debug-screen
```

## What This Does

Invokes the `rn-debugger` agent, which runs a structured diagnostic flow:

1. **Screenshot** -- captures current screen state immediately
2. **Parallel evidence gathering** -- simultaneously reads error log, console, network log, and component tree
3. **Error type identification** -- routes to the right investigation path (JS error vs native crash vs data mismatch vs navigation issue)
4. **Root cause narrowing** -- reads source files, checks store state, inspects native logs if CDP shows nothing
5. **Fix** -- applies minimal targeted fix, waits for Fast Refresh
6. **Verify recovery** -- confirms error is gone, re-runs the failing action

## When to Use

- The screen is blank or white with no RedBox
- There is a RedBox / LogBox error showing
- The UI shows wrong data or is in an unexpected state
- The app is frozen or unresponsive
- A network request is failing
- Navigation went to the wrong screen

## What You Don't Need to Do

You don't need to describe the problem in detail. The agent gathers its own
evidence from the running app. Just run the command while the broken state
is visible on the simulator.
