---
command: check-env
description: Check that the fenced React Native session, Metro, app target, and device inventory are ready for testing.
allowed-tools: Bash, Read, Grep, mcp__*cdp__*
---

Run `rn_session(action="status")`, then passive `cdp_status`, and report
environment readiness. Use `device_list` only as diagnostic inventory; never
turn an ambient port or the first available device into authority.

Check each subsystem and report status as a table:

| Subsystem | What to check | Source |
|-----------|--------------|--------|
| Session | Ready state, worktree, app, platform, exact device, Metro binding, and migration readiness | `rn_session(action="status")` |
| Metro | Allocated and bound port for this session | `rn_session`, then `cdp_status` → `metro` |
| CDP | Exact authority-bound target connected? | `rn_session`, then `cdp_status` → `cdp` |
| Device inventory | Intended UUID/serial still present? | `device_list`, compared with the session binding |

If issues are found, suggest the appropriate fix:

| Status | Fix |
|--------|-----|
| Session missing or not ready | Run setup, review/apply the integration preview, and bind the intended device and app |
| Metro not found | Use literal `pnpm ios` or `pnpm android` through the confirmed integration |
| No Hermes target | Open the bound app, then call `cdp_connect` for the exact signed target |
| CDP code 1006 | Close React Native DevTools, Flipper, Chrome DevTools |
| `cdp_component_tree` reports RedBox | Run `/rn-dev-agent:debug-screen` |
| Narrow gated CDP read times out | Check for a blocked JS thread, then use `cdp_reload` |
| `HELPERS_NOT_INJECTED` | Use a `__DEV__` Hermes build; retry through the gated tool after reload |
| No devices in device_list | Boot a simulator: `xcrun simctl boot "iPhone 16"` or start an emulator |

Present results clearly with a pass/fail indicator for each subsystem.
If the session is ready and passive diagnostics match its bindings, confirm
the environment is ready for authoritative testing.
