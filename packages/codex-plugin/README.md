# rn-dev-agent Codex adapter (authoring source)

This package is the authoring source for the Codex host surface of rn-dev-agent.
It is **not** an installable plugin directory. `scripts/build-host-runtimes.ts`
copies its contents into `packages/claude-plugin`, the one directory both the
Claude and Codex marketplaces install, and generates the 17 workflow skills there:

| Authored here | Shipped from `packages/claude-plugin` |
|---|---|
| `.codex-plugin/plugin.json` | `.codex-plugin/plugin.json` |
| `.mcp.json` | `codex.mcp.json` |
| `bin/cdp-supervisor.js` | `bin/cdp-supervisor.js` (+ generated `bin/package.json`) |
| `src/plugin-health.ts` | `bin/plugin-health.js` |
| `src/AGENTS-MD-TEMPLATE.md` | `AGENTS-MD-TEMPLATE.md` |
| `skills/` (11 adapted domain skills) | `codex-skills/` (+ 17 generated workflow skills) |
| `commands/` | `codex-commands/` |
| `agents/` | `codex-agents/` |
| `templates/` | `codex-templates/` |

Package-relative links in these files therefore target the shipped names
(`../../codex-commands/...`, `<package-root>/codex-skills/...`), not the local
`commands/` or `skills/` directories.

## Install

```bash
codex plugin marketplace add Lykhoyda/rn-dev-agent
codex plugin add rn-dev-agent@rn-dev-agent --json
```

A local install points at `/path/to/rn-dev-agent/packages/claude-plugin`, not
this directory and not the repository root. `No plugin hooks` is expected: the
Codex manifest declares an inline empty hooks object so Claude's `hooks/` is
never discovered.

## Native surface

- Stable MCP server key `cdp` and the full MCP tool suite, launched through
  `bin/cdp-supervisor.js` into the one bundled runtime at
  `rn-dev-agent-core/dist/supervisor.js`.
- Eleven implicit domain skills.
- Seventeen explicit native workflow skills, invoked as
  `$rn-dev-agent:<workflow> [request text]`.
- Exactly 28 Codex skills total.

The seventeen workflows are `build-and-test`, `check-env`,
`check-vercel-rules`, `debug-screen`, `doctor`, `list-learned-actions`,
`lock-e2e`, `nav-graph`, `observe`, `proof-capture`, `qa-pr`, `rn-feature-dev`,
`run-action`, `run-workflow`, `send-feedback`, `setup`, and `test-feature`.

See the authoring-to-distribution map above for playbook locations. The Codex manifest
sets `"commands": []` to disable host best-effort command migration; no
`source-command-*` name is supported. Claude's slash-command spelling remains a
Claude-only surface.

## Refresh and recovery

Codex 0.145.0 is the live-refresh floor. A plugin change performed through the
same app can update a subsequent turn, never the current sampling request.
External CLI/manual changes and older hosts require exiting and relaunching
Codex. `/mcp verbose` displays inventory only.

`$rn-dev-agent:doctor` runs the generated `bin/plugin-health.js` program. It
reports independent host/install/materialization/registration/contract/schema/
task observation axes and is strictly read-only. It never installs, updates,
removes, edits configuration, attaches to an app/device, controls Observe, or
kills/restarts a process. A task with zero plugin skills must use the external
bootstrap documented on the troubleshooting page.

Resolve runtime resources relative to the exact selected `SKILL.md` or
`import.meta.url`; never scan caches or treat a marketplace source path as the
materialized package.

```bash
corepack yarn build:host-runtimes
```
