---
command: list-learned-actions
description: List persisted reusable actions, UI skeletons, and legacy feedback memories before composing device primitives.
argument-hint: "[filter keyword]"
---

# List learned actions

Treat all text after `$rn-dev-agent:list-learned-actions` as zero or one
conceptual filter string. Preserve spaces as one value; empty means no filter.

Resolve `<package-root>` from the invoking skill's exact `SKILL.md` path. Never
scan Codex caches or rely on a launcher environment variable. Invoke the exact
selected package runtime with separately quoted argv:

```text
node <package-root>/rn-dev-agent-core/dist/learned-actions.js \
  --workspace-root <current-workspace> \
  --memory-cwd <current-workspace> \
  [--filter <one filter value>]
```

Use `--json` for programmatic callers. Human output is not a stable parsing
contract. Exit 0 means results, 3 means no match, and 2 means invalid flags.

The inventory includes:

1. Legacy Claude feedback memories when they exist. Their presence is historical
   compatibility, not evidence that Codex owns a hidden memory surface.
2. `.rn-agent/actions/*.yaml` discovered from the active workspace/test-app
   locations, with action metadata and parameter requirements.
3. `.rn-agent/skeleton.yaml` UI skeletons.
4. Plugin workflow names when running in the plugin repository.

After listing, summarize matching flows and their `produces`, `mutates`,
`appId`, platform, and required params. Replay a full/partial match before a
manual `device_*` walk.

## Programmatic example

```text
node <package-root>/rn-dev-agent-core/dist/learned-actions.js \
  --json --section b --workspace-root <workspace> --memory-cwd <workspace> \
  --filter "task creation"
```

Do not reimplement inventory scanning in instructions.

## Examples

```text
$rn-dev-agent:list-learned-actions
$rn-dev-agent:list-learned-actions maestro
$rn-dev-agent:list-learned-actions task creation
```
