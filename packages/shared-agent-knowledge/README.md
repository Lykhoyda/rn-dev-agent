# Shared Agent Knowledge

This package owns host-neutral agent guidance.

Canonical sources live here:

- `skills/`
- `commands/`
- `agents/`
- `templates/rn-agent/`

Claude and Codex adapters consume these sources through real package-local
outputs in `packages/claude-plugin/` and `packages/codex-plugin/`. Keep durable,
host-neutral workflow knowledge here, then adapt only host-specific entrypoints.
