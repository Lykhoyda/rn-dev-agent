# rn-dev-agent — Codex project instructions template

The body between the managed sentinels is installed into a project's `AGENTS.md`
by `$rn-dev-agent:setup`. Setup must preview every create/append/replacement and
obtain consent. Content outside the sentinels belongs to the project and must
never be replaced.

<!-- rn-dev-agent:codex-template-start -->
## React Native development with rn-dev-agent

This project uses **rn-dev-agent** for React Native development, device control,
live CDP introspection, reusable-action replay, and strict proof. Codex uses the
`cdp` MCP server, ten domain skills, and fifteen explicit workflow skills.
Invoke a workflow as `$rn-dev-agent:<workflow> [request text]`.

### Mandatory preflight before app/device interaction

1. Inspect the active MCP inventory and call `cdp_status` before app work.
2. Run `$rn-dev-agent:list-learned-actions [feature keyword]` before composing
   any `device_*` sequence.
3. If a saved action covers all or part of the requested setup, replay it with
   `$rn-dev-agent:run-action <id> [-e KEY=VALUE ...]` or structured
   `cdp_run_action` arguments. Manual primitives are a fallback.
4. Bind every action to the intended platform/device/app. Stop on ambiguity.
5. Verify outcomes with concrete component-tree, route/store, screenshot, and
   error-log evidence. Never claim success from intuition.

### Workflow routing

| Intent | Explicit Codex workflow |
|---|---|
| Onboard this project | `$rn-dev-agent:setup` |
| Passive installation/recovery diagnosis | `$rn-dev-agent:doctor` |
| Check the active app environment | `$rn-dev-agent:check-env` |
| Build a feature | `$rn-dev-agent:rn-feature-dev <description>` |
| Test an existing feature | `$rn-dev-agent:test-feature <description>` |
| Build/install then test | `$rn-dev-agent:build-and-test [--eas profile] <description>` |
| Diagnose a broken screen | `$rn-dev-agent:debug-screen` |
| List/replay reusable actions | `$rn-dev-agent:list-learned-actions` / `$rn-dev-agent:run-action` |
| Freeze a verified action | `$rn-dev-agent:lock-e2e <id>` |
| Inspect navigation | `$rn-dev-agent:nav-graph [scan|read|find <screen>]` |
| Open the Observe UI | `$rn-dev-agent:observe` |
| Audit RN best-practice rules | `$rn-dev-agent:check-vercel-rules` |
| Capture evidence | `$rn-dev-agent:proof-capture [--strict] <slug> <flow>` |
| Submit reviewed feedback | `$rn-dev-agent:send-feedback <context>` |

Domain skills (`rn-setup`, `rn-testing`, `rn-debugging`,
`rn-feature-development`, `rn-device-control`, `capturing-proof`,
`creating-actions`, `sending-feedback`, `rn-best-practices`, and
`using-rn-dev-agent`) own implicit knowledge. Workflow skills are explicit entry
points and execute their package-local playbooks in the current parent task.

### Tool selection and evidence

- Use `cdp_*` for app internals, navigation, store, network, console, and errors.
- Use `device_*` for native interaction and screenshots.
- Prefer filtered component-tree queries; do not dump the complete tree.
- Prefer `cdp_run_action` for saved actions because it enforces app, parameter,
  mutation, device, and repair checks.
- Never use raw Maestro output as a substitute for an rn-dev-agent strict proof
  receipt.
- Execute MCP-bound testing/debugging protocols in the current task; a spawned
  subagent does not inherit the active MCP tool snapshot.

### Reusable-action safety

Read action metadata before replay. Confirm a `mutates: true` or destructive
flow, validate every `${PARAM}` value, match `appId`, and require explicit
platform selection when both iOS and Android are available. A matching partial
action is a valid setup prologue: replay it, re-read route/store state, then
walk only the novel remainder. Persist a verified novel flow under
`.rn-agent/actions/`.

### Strict proof

Strict proof is fail-closed. Use `$rn-dev-agent:proof-capture --strict`, a clean
candidate tree, the actual issue/PR/head, a pinned learned action and hash, a
typed storyboard, result-bound screenshots/assertions, and an independent
reviewer provider. Repair, reload, reset, or undeclared interaction during
recording invalidates the capture. Rejected media is discarded, never
reclassified as accepted evidence.

### Recovery truth

- `/mcp verbose` is Codex inventory inspection only; it is not reconnection.
- Codex 0.145.0 is the live-refresh floor. A plugin change made through the same
  running app can affect a subsequent turn, never the current sampling request.
- External CLI/manual plugin changes and older Codex hosts require exiting and
  relaunching Codex.
- If skills/tools are absent, use the documented external read-only health
  command. If tools are present but calls say `Transport closed`, relaunch the
  owning Codex process; do not kill a process owned by another host.
- A callable `cdp_status` reporting no app is an app/setup problem, not missing
  plugin discovery.
- Recovery diagnosis is read-only. It recommends commands but never installs,
  updates, removes, rewrites configuration, attaches to a device, controls
  Observe, or kills/restarts processes.

### Project-local files

`.rn-agent/` owns the reusable-action corpus, scaffold, navigation graph, local
state, recordings, and diagnostics. Preserve user-edited files. Setup may add
missing scaffold files only after preview/consent and must not overwrite an
existing action, skeleton, config, or symlink-inherited corpus.

<!-- rn-dev-agent:codex-template-end -->
