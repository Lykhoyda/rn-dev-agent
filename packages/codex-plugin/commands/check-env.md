---
command: check-env
description: Check that the fenced React Native session, Metro, app target, and device inventory are ready for testing.
---

This is an explicitly active readiness workflow, not the passive recovery
doctor. Require `rn_session`, `cdp_status`, and `device_list` in the active task;
when absent, stop for read-only discovery diagnosis. Call
`rn_session(action="status")`, then passive `cdp_status`, for the intended
app/device. Use `device_list` only as diagnostic inventory; never turn an
ambient port or the first available device into authority.

Check each subsystem and report status as a table:

| Subsystem | What to check | Source |
|-----------|--------------|--------|
| Source declaration | Git app roots declare nothing. A non-Git app root must export `RN_DEV_AGENT_DECLARED_ROOT` (the exact existing application root) and `RN_DEV_AGENT_DECLARED_MANIFESTS` (comma-separated required existing manifest files inside it) before the supervisor starts | `git rev-parse --show-toplevel`, then the two variables in the supervisor environment |
| Session | Ready state, worktree, app, platform, exact device, Metro binding, and migration readiness | `rn_session(action="status")` |
| Metro | Allocated and bound port for this session | `rn_session`, then `cdp_status` → `metro` |
| CDP | Exact authority-bound target connected? | `rn_session`, then `cdp_status` → `cdp` |
| Device inventory | Intended UUID/serial still present? | `device_list`, compared with the session binding |

If issues are found, suggest the appropriate fix:

| Status | Fix |
|--------|-----|
| `NON_GIT_MANIFEST_REQUIRED` | Report this before setup or build, not after. Set `RN_DEV_AGENT_DECLARED_ROOT` to the exact existing application root and `RN_DEV_AGENT_DECLARED_MANIFESTS` to the required existing manifest files inside it, then restart the supervisor. Never invent either value, generate a manifest, or fall back to trusting the working directory — the refusal names which half is missing |
| Session missing or not ready | Run setup, review/apply the integration preview, and bind the intended device and app |
| Metro not found | Use literal `pnpm ios` or `pnpm android` through the confirmed integration |
| No Hermes target | Open the bound app, then call `cdp_connect` for the exact signed target |
| CDP code 1006 | Close React Native DevTools, Flipper, Chrome DevTools |
| `cdp_component_tree` reports RedBox | Run `$rn-dev-agent:debug-screen` |
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
