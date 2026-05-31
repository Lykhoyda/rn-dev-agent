# rn-dev-agent-cdp

## 0.39.0

### Minor Changes

- 5c4ca04: Add the read-only observability UI (D1226 "watch the agent live"): an in-process recorder + opt-in SSE server serving a React SPA (timeline | device | state). New `observe` MCP tool + `/rn-dev-agent:observe` slash command. Deep-redacted (args + payload, fail-closed), localhost-only with Host-header + Sec-Fetch-Site guards.

### Patch Changes

- c4804dc: Add `cdp_dismiss_dev_client_picker` MCP tool (Android) and best-effort Dev
  Client picker dismissal after Android deep links (#136 sub-3). Routed through a
  single guarded `clearDevClientPickerIfPresent()` helper; iOS returns an
  actionable manual-select message instead of touching the legacy agent-device
  path. Cross-platform iOS support tracked as a follow-up.

## 0.38.40

### Patch Changes

- Deliver the GH #186 maestro-interop fixes that merged in #188 without a version bump (closes #189).

  - `cdp_run_action` now allows `runFlow` (including `when:` conditionals and `{file}` sub-flows) through the Maestro command allowlist, so actions with conditional dialog-handling (Expo dev-server picker, iOS "Open in" dialog) replay through the canonical runner instead of hard-failing with `Command not in allowlist: runFlow (Phase 134.1)`.
  - Non-destructive runner-leak `reacquire` recovery tier + cross-tool CDP re-pin, avoiding the ~44s relaunch / ~47s STALE_TARGET when maestro-mcp and rn-dev-agent contend for the same iOS device.
  - Structural route-drift detection: a stale-selector failure on an inserted screen is classified `ROUTE_DRIFT` instead of triggering a wasted fuzzy-repair.

  #188 shipped these to `main` with no version bump, leaving them undeliverable to marketplace installs; this patch publishes them.
