# rn-dev-agent Codex plugin

This package is the self-contained Codex host boundary for rn-dev-agent.

## Install

```bash
codex plugin marketplace add Lykhoyda/rn-dev-agent
codex plugin add rn-dev-agent@rn-dev-agent --json
```

A local install points at `/path/to/rn-dev-agent/packages/codex-plugin`, not the
repository root or Claude package. `No plugin hooks` is expected.

## Native surface

- Stable MCP server key `cdp` and the full MCP tool suite.
- Ten implicit domain skills.
- Fifteen explicit native workflow skills, invoked as
  `$rn-dev-agent:<workflow> [request text]`.
- Exactly 25 Codex skills total.

The fifteen workflows are `build-and-test`, `check-env`,
`check-vercel-rules`, `debug-screen`, `doctor`, `list-learned-actions`,
`lock-e2e`, `nav-graph`, `observe`, `proof-capture`, `rn-feature-dev`,
`run-action`, `send-feedback`, `setup`, and `test-feature`.

`commands/` contains their full package-local playbooks. The Codex manifest
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

## Package-local ownership

- `.codex-plugin/plugin.json`, `.mcp.json`
- `bin/cdp-supervisor.js`, generated `bin/plugin-health.js`
- bundled `rn-dev-agent-core/`
- ten adapted domain skills + fifteen generated workflow adapters
- fifteen adapted workflow playbooks under `commands/`
- generated `AGENTS-MD-TEMPLATE.md`
- Expo/EAS, Vercel, feedback, proof, snapshot, and native-runner helpers
- rn-agent scaffold templates and runner manifest

Resolve runtime resources relative to the exact selected `SKILL.md` or
`import.meta.url`; never scan caches or treat a marketplace source path as the
materialized package.

Generated runtime, adapters, helpers, health entry, AGENTS template, runner
sources, and manifests are owned by `scripts/build-host-runtimes.ts`:

```bash
corepack yarn build:host-runtimes
```
