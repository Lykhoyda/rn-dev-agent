---
"rn-dev-agent-cdp": minor
---

Expose `params` in the `maestro_run` and `cdp_run_action` MCP tool schemas.

Both handlers have accepted `params` since GH #116 (forwarded to maestro as `-e KEY=VALUE` on the first attempt AND the post-repair retry), but the zod registrations omitted the field — and zod strips unknown keys by default, so a caller's parameter bindings were **silently dropped** at the tool-call layer and a parameterised action failed at runtime with unset `${VAR}` placeholders. Found by Codex review on PR #272 (the new `creating-actions` skill recommends `cdp_run_action({ actionId, params, trigger })`, which was un-callable as advertised; `commands/run-action.md` documented the same call shape). Key-format validation (`/^[A-Z_][A-Z0-9_]*$/`) stays in the handler. Wiring test pins both registrations.
