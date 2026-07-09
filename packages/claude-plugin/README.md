# Claude Plugin Adapter

This package owns the Claude Code host boundary for rn-dev-agent.

## Installation Path

Published users install through the Claude Code marketplace:

```bash
/plugin marketplace add Lykhoyda/rn-dev-agent
/plugin install rn-dev-agent@rn-dev-agent
/reload-plugins
```

Local development usually points Claude Code at the repository root:

```bash
claude --plugin-dir /path/to/rn-dev-agent
```

The root `.claude-plugin/marketplace.json` resolves this package via
`source: "./packages/claude-plugin"`. If a tool asks for the plugin package
root directly, use `/path/to/rn-dev-agent/packages/claude-plugin`.

Package-owned artifacts:

- `plugin.json`
- `package.json`
- `marketplace.json`
- `hooks/`
- `commands/`
- `agents/`
- `skills/`

The Claude package depends on `rn-dev-agent-core` for MCP/device behavior and
`rn-dev-agent-shared-agent-knowledge` for canonical agent workflows. Package
local `commands/`, `agents/`, `skills/`, and `templates/` are generated/adapted
outputs from `packages/shared-agent-knowledge/`, not symlinks. Keep Claude-only
concepts, such as slash-command wiring and hooks, out of the core package.
