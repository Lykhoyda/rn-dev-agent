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
| Source declaration | Git app roots declare nothing. Before the supervisor starts for a non-Git app root, check `RN_DEV_AGENT_DECLARED_ROOT` and `RN_DEV_AGENT_DECLARED_MANIFESTS` against the [session-authority contract](https://lykhoyda.github.io/rn-dev-agent/session-authority/#what-each-source-identity-proves) | `git rev-parse --show-toplevel`, then the two variables in the supervisor environment |
| Session | Ready state, worktree, app, platform, exact device, Metro binding, and migration readiness | `rn_session(action="status")` |
| Metro | Allocated and bound port for this session | `rn_session`, then `cdp_status` → `metro` |
| CDP | Exact authority-bound target connected? | `rn_session`, then `cdp_status` → `cdp` |
| Device inventory | Intended UUID/serial still present? | `device_list`, compared with the session binding |

If issues are found, suggest the appropriate fix:

| Status | Fix |
|--------|-----|
| `NON_GIT_MANIFEST_REQUIRED` | Report this before setup or build, name the missing `RN_DEV_AGENT_DECLARED_ROOT` or `RN_DEV_AGENT_DECLARED_MANIFESTS` declaration, and point to the [session-authority contract](https://lykhoyda.github.io/rn-dev-agent/session-authority/#what-each-source-identity-proves) |
| Session missing or not ready | Run setup, review/apply the integration preview, and bind the intended device and app |
| Metro not found | Use literal `pnpm ios` or `pnpm android` through the confirmed integration |
| No Hermes target | Open the bound app, then call `cdp_connect` for the exact signed target |
| CDP code 1006 | Close React Native DevTools, Flipper, Chrome DevTools |
| `cdp_component_tree` reports RedBox | Run `/rn-dev-agent:debug-screen` |
| Narrow gated CDP read times out | Check for a blocked JS thread, then use `cdp_reload` |
| `HELPERS_NOT_INJECTED` | Read bounded `meta.helperHealth`; use a `__DEV__` Hermes build and retry through the gated tool after reload |
| No devices in device_list | Boot a simulator: `xcrun simctl boot "iPhone 16"` or start an emulator |

Present results clearly with a pass/fail indicator for each subsystem.
If the session is ready and passive diagnostics match its bindings, confirm
the environment is ready for authoritative testing.

Run the source-declaration row first: it is the only row that can fail before a
session exists at all, so a non-Git project missing its declaration reports
`NON_GIT_MANIFEST_REQUIRED` here rather than surfacing as an unexplained
setup or build failure later. The full contract lives in the session-authority
documentation ("What each source identity proves"); repeat only the two
variable names here.
