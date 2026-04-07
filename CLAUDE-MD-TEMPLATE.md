# rn-dev-agent — Project Instructions Template

Copy the section below into your project's `CLAUDE.md` file to ensure Claude
always uses the rn-dev-agent CDP tools instead of raw bash commands.

---

## React Native Development (rn-dev-agent)

This project uses the **rn-dev-agent** plugin for React Native development and testing.

### Tool Usage Rules

When interacting with the running React Native app:
- **ALWAYS** use CDP MCP tools (`cdp_status`, `cdp_component_tree`, `cdp_store_state`, `cdp_evaluate`, `cdp_interact`, `cdp_navigate`) instead of raw bash commands
- **ALWAYS** call `cdp_status` first to establish a CDP connection before any app interaction
- **NEVER** use `xcrun simctl openurl` for navigation — use `cdp_evaluate` with `__NAV_REF__` instead
- **NEVER** use `curl localhost:8081` to check Metro — use `cdp_status` which handles this automatically
- For screenshots, use `device_screenshot` (or `xcrun simctl io booted screenshot` if no device session)
- For UI interaction, use `device_find`/`device_press`/`cdp_interact` — not simctl or adb input

### Verification Flow

After implementing any feature:
1. `cdp_status` — verify connection
2. `cdp_error_log(clear=true)` — clear baseline
3. Navigate to feature screen via `cdp_evaluate` or `cdp_navigate`
4. `cdp_component_tree(filter="<testID>")` — verify component renders
5. `cdp_interact` or `device_press` — test interaction
6. `cdp_store_state` — verify state changes
7. `cdp_error_log` — check for regressions
8. `device_screenshot` — capture proof

### Key Commands

- `/rn-dev-agent:rn-feature-dev <description>` — Full 8-phase pipeline
- `/rn-dev-agent:check-env` — Verify environment
- `/rn-dev-agent:debug-screen` — Diagnose current screen
- `/rn-dev-agent:send-feedback` — Report issues
