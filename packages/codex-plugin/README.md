# Codex Plugin Adapter

This package owns the Codex host boundary for rn-dev-agent.

## Installation

Install from the marketplace (recommended):

```bash
codex plugin marketplace add Lykhoyda/rn-dev-agent
codex plugin add rn-dev-agent@rn-dev-agent
```

The repo's `.agents/plugins/marketplace.json` resolves the Codex payload from
`packages/codex-plugin/`, and the installed plugin is fully self-contained
(bundled MCP runtime, native runner sources, runner manifest).

## Local Installation Path

Local Codex installs should point at this package directory:

```text
/path/to/rn-dev-agent/packages/codex-plugin
```

Do not point Codex at the repository root or `packages/claude-plugin`; those are
Claude Code surfaces. This directory owns `.codex-plugin/plugin.json`,
`.mcp.json`, `bin/cdp-supervisor.js`, package-local skills, and the bundled MCP
runtime under `rn-dev-agent-core/dist/`.

Codex does not consume Claude Code hooks. A Codex plugin detail screen that
shows `No plugin hooks` is expected for this package.

Package-owned artifacts:

- `.codex-plugin/plugin.json`
- `.mcp.json`
- `bin/cdp-supervisor.js`
- `rn-dev-agent-core/dist/supervisor.js`
- `skills/`
- `commands/`
- `agents/`
- `scripts/rn-fast-runner/`
- `scripts/rn-android-runner/`
- `scripts/collect-feedback.sh`
- `skills/sending-feedback/`

Codex consumes the same `rn-dev-agent-core` MCP server as Claude Code, but the
Codex artifact carries a bundled runtime and native runner sources so installed
plugins do not depend on a sibling workspace checkout. Regenerate it with
`corepack yarn build:host-runtimes`.

Package-local `skills/`, `commands/`, `agents/`, and `templates/` are
generated/adapted outputs from `packages/shared-agent-knowledge/`, not symlinks.
Claude slash commands and subagent role files are not native Codex concepts; the
shared skills describe how to translate those workflows into Codex session steps.
