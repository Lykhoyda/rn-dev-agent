# rn-dev-agent plugin package

This is the one directory Claude, Cursor, and Codex install: Claude Code reads
its surface from `.claude-plugin/plugin.json`, Cursor from
`.cursor-plugin/plugin.json` and `mcp.json` (root
`.cursor-plugin/marketplace.json` points here), Codex from
`.codex-plugin/plugin.json`, and all three run the single bundled runtime under
`rn-dev-agent-core/dist/`.

## Installation Path

Claude Code:

```bash
/plugin marketplace add Lykhoyda/rn-dev-agent
/plugin install rn-dev-agent@rn-dev-agent
/reload-plugins
```

Codex:

```bash
codex plugin marketplace add Lykhoyda/rn-dev-agent
codex plugin add rn-dev-agent@rn-dev-agent --json
```

Local development points Claude Code at the repository root
(`claude --plugin-dir /path/to/rn-dev-agent`; the root
`.claude-plugin/marketplace.json` resolves `source: "./packages/claude-plugin"`)
and registers `/path/to/rn-dev-agent/packages/claude-plugin` in Codex.

## Layout

Claude surface (authored here, `commands/`/`agents/`/`skills/`/`templates/`
mirrored from `packages/shared-agent-knowledge/`):

- `plugin.json`, `.claude-plugin/plugin.json`, `marketplace.json`, `package.json`
- `.cursor-plugin/plugin.json` and `mcp.json` (Cursor Plugin launch)
- `hooks/`, `commands/`, `agents/`, `skills/`, `templates/`

Codex surface (generated from `packages/codex-plugin/` by
`scripts/build-host-runtimes.ts`; never hand-edit):

- `.codex-plugin/plugin.json` — explicit `./codex-skills/`, `./codex.mcp.json`,
  `commands: []`, inline empty `hooks` so Claude's `hooks/` is never loaded
- `codex.mcp.json`, `bin/cdp-supervisor.js`, `bin/plugin-health.js`,
  `bin/package.json` (ESM boundary for the launchers)
- `codex-skills/` (11 adapted domain + 17 generated workflow skills),
  `codex-commands/`, `codex-agents/`, `codex-templates/`, `AGENTS-MD-TEMPLATE.md`

Shared, generated for both hosts:

- `rn-dev-agent-core/` — one bundled runtime with host-neutral
  `rn-dev-agent-core` package metadata
- `scripts/` (helpers + native runner sources), `runner-manifest.json`,
  `CLAUDE-MD-TEMPLATE.md`

Claude spawns `rn-dev-agent-core/dist/supervisor.js` directly and clears
inherited Codex root hints in its MCP env; the Codex launcher spawns the same
supervisor with `--no-lock` and exports `RN_DEV_AGENT_CODEX_PLUGIN_ROOT`.

Regenerate every generated path with:

```bash
corepack yarn build:host-runtimes
```
