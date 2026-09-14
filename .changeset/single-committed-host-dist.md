---
'rn-dev-agent-plugin': patch
'rn-dev-agent-core': patch
---

Ship one committed bundled runtime with host-neutral `rn-dev-agent-core` metadata from `packages/claude-plugin`, which both the Claude and Codex marketplaces now install (Codex selects its generated `.codex-plugin/plugin.json`, `codex.mcp.json`, `bin/` launchers and `codex-*` adapters from the same directory), so a Codex local registration must point at `packages/claude-plugin` instead of the removed `packages/codex-plugin` runtime (GH #892).
