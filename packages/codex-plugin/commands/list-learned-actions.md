---
command: list-learned-actions
description: List persisted "learned actions" — feedback memories, Maestro flows, UI skeletons, and plugin commands that should be consulted before composing new device_* primitives. Wraps packages/rn-dev-agent-core/dist/learned-actions.js for programmatic discovery.
argument-hint: [filter-keyword]
allowed-tools: Bash, Read, Glob
---

List learned actions matching: $ARGUMENTS (optional keyword filter; omit to list all)

## Why this command exists

Past sessions accumulate two kinds of reusable knowledge that future sessions
should look at BEFORE re-deriving anything from scratch:

1. **Feedback memories** at `~/.claude/projects/<encoded-cwd>/memory/feedback_*.md`
2. **Executable artifacts**: `.rn-agent/actions/*.yaml`, `.rn-agent/skeleton.yaml`

This command surfaces both lists in one place — and the underlying
`packages/rn-dev-agent-core/src/learned-actions.ts` (compiled to `packages/rn-dev-agent-core/dist/learned-actions.js`) is the **same script** invoked programmatically
by `/rn-dev-agent:test-feature` Step 0 and by the `rn-tester` / `rn-debugger`
agents' artifact-scan steps. Keeping the discovery logic in one script means
every consumer sees the same inventory.

## Run

```bash
CODEX_PLUGIN_ROOT="${RN_DEV_AGENT_CODEX_PLUGIN_ROOT:-${CODEX_PLUGIN_ROOT:-}}"
if [ -z "$CODEX_PLUGIN_ROOT" ] && [ -f "packages/codex-plugin/.codex-plugin/plugin.json" ]; then
  CODEX_PLUGIN_ROOT="packages/codex-plugin"
fi
if [ -z "$CODEX_PLUGIN_ROOT" ]; then
  CODEX_PLUGIN_MANIFEST="$(find "${CODEX_HOME:-$HOME/.codex}/plugins/cache" -path "*/rn-dev-agent/*/.codex-plugin/plugin.json" -print -quit 2>/dev/null || true)"
  [ -n "$CODEX_PLUGIN_MANIFEST" ] && CODEX_PLUGIN_ROOT="$(dirname "$(dirname "$CODEX_PLUGIN_MANIFEST")")"
fi
test -n "$CODEX_PLUGIN_ROOT" || { echo "rn-dev-agent Codex plugin root not found" >&2; exit 2; }
node "${CODEX_PLUGIN_ROOT}/rn-dev-agent-core/dist/learned-actions.js" \
  --workspace-root "$PWD" \
  --memory-cwd "$PWD" \
  ${ARGUMENTS:+--filter "$ARGUMENTS"}
```

The script auto-discovers:
- The user's per-project auto-memory directory (Section A)
- `.rn-agent/actions/*.yaml` in the cwd, in `<cwd>/test-app/`, and in any
  `<sibling>/test-app/` adjacent to the cwd (Section B)
- `.rn-agent/skeleton.yaml` in the same locations (Section C)
- Plugin commands (Section D — only populated when running inside the plugin repo)

It exits 0 when results found, 3 when nothing matches, 2 on bad flags.

## Programmatic invocation

Other commands and agents can call the script directly to get JSON for
decision-making. **Always use `--json` from a programmatic caller** — the
human table format is not a stable contract.

```bash
CODEX_PLUGIN_ROOT="${RN_DEV_AGENT_CODEX_PLUGIN_ROOT:-${CODEX_PLUGIN_ROOT:-}}"
if [ -z "$CODEX_PLUGIN_ROOT" ] && [ -f "packages/codex-plugin/.codex-plugin/plugin.json" ]; then
  CODEX_PLUGIN_ROOT="packages/codex-plugin"
fi
if [ -z "$CODEX_PLUGIN_ROOT" ]; then
  CODEX_PLUGIN_MANIFEST="$(find "${CODEX_HOME:-$HOME/.codex}/plugins/cache" -path "*/rn-dev-agent/*/.codex-plugin/plugin.json" -print -quit 2>/dev/null || true)"
  [ -n "$CODEX_PLUGIN_MANIFEST" ] && CODEX_PLUGIN_ROOT="$(dirname "$(dirname "$CODEX_PLUGIN_MANIFEST")")"
fi
test -n "$CODEX_PLUGIN_ROOT" || { echo "rn-dev-agent Codex plugin root not found" >&2; exit 2; }
RESULT=$(node "${CODEX_PLUGIN_ROOT}/rn-dev-agent-core/dist/learned-actions.js" \
  --json --section b --filter "task creation" --workspace-root "$PWD" --memory-cwd "$PWD")
echo "$RESULT" | jq '.sections.flows.items[0].path'
```

JSON shape (abridged):

```json
{
  "cwd": "/Users/.../my-rn-app",
  "filter": "cart",
  "sections": {
    "memories": { "count": 0, "dir": "...", "items": [] },
    "flows": {
      "count": 1,
      "roots": ["..."],
      "items": [
        {
          "flow": "cart-add-item",
          "path": "/.../cart-add-item.yaml",
          "appId": "com.example.app",
          "purpose": "Add an item to the cart and verify the badge increments",
          "params": ["ITEM_ID", "QTY"],
          "replay": "maestro-runner --platform ios test -e ITEM_ID=... -e QTY=... /.../cart-add-item.yaml"
        }
      ]
    },
    "skeletons": { "count": 1, "items": [...] },
    "commands": { "count": 15, "items": [...] }
  },
  "total": 17
}
```

## Sample invocations

```
/rn-dev-agent:list-learned-actions
/rn-dev-agent:list-learned-actions maestro
/rn-dev-agent:list-learned-actions task creation
/rn-dev-agent:list-learned-actions cdp helpers
```

After reading the output, surface a 1-paragraph summary to the user that
explicitly names any **flows** that match their current intent — those should
be replayed before any manual `device_*` walk. Per
`feedback_execute_artifacts_before_manual.md`: manual primitives are a
fallback, not a default.

## Implementation notes

- The script handles all filesystem scanning + frontmatter parsing — DO NOT
  re-implement it inline (this caused stale logic in the previous version of
  this command).
- Prefer `RN_DEV_AGENT_CODEX_PLUGIN_ROOT`, which the Codex MCP launcher exports
  for installed plugins. In a repository checkout, use `CODEX_PLUGIN_ROOT=packages/codex-plugin`.
  Do not use Claude-only plugin-root variables in Codex workflows.
- The script's project-cwd encoding maps both `/` and `_` to `-`, matching
  Claude Code's `~/.claude/projects/<encoded>/` convention.
- Output is bounded to 50 entries per section by default (`--max N` to override).
- The same script is referenced by:
  - `commands/test-feature.md` Step 0 (artifact-first scan)
  - `agents/rn-tester.md` Step 0a (artifact scan inline)
  - `agents/rn-debugger.md` Step 0a (reproduction scan inline)
- If you need to point the script at a different memory dir or workspace
  (e.g. when working on a sibling test-app from inside the plugin repo), use
  `--memory-cwd` and `--workspace-root` overrides.
