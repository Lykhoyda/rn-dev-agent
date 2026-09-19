# Shared Agent Knowledge

This package owns host-neutral agent guidance.

Canonical sources live here:

- `skills/`
- `commands/`
- `agents/`
- `templates/rn-agent/`

Claude consumes these sources as byte copies inside `packages/claude-plugin/`;
Codex consumes hand-adapted copies authored in `packages/codex-plugin/` and
shipped as `codex-*` directories inside that same `packages/claude-plugin/`
package. Keep durable, host-neutral workflow knowledge here, then adapt only
host-specific entrypoints.
