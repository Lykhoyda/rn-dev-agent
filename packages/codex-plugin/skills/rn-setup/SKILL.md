---
name: rn-setup
description: Use for Codex rn-dev-agent onboarding, passive recovery diagnosis, dependency readiness, and safe setup routing when tools are missing or failing.
---

# rn-setup

This domain skill owns two deliberately separate modes:

1. **Passive diagnosis** for `$rn-dev-agent:doctor` and the first phase of
   `$rn-dev-agent:setup`.
2. **Consent-based onboarding/remediation** only after passive diagnosis and
   only when the user explicitly invoked setup or approved a proposed action.

## Package identity

Resolve the package root from this exact `SKILL.md` path (`../..` from this
skill directory). Never use a plugin-root environment variable, marketplace
source path, cache scan, or private adapter `package.json` version. The
installed version is `.codex-plugin/plugin.json`.

## Passive recovery protocol

Run package-local `bin/plugin-health.js --json`. It reads Codex version, exact
plugin/enabled state, materialization, `cdp` registration, and a side-effect-free
MCP initialize/`tools/list` contract. It never invokes app tools.

Task facts are explicit observations only. Complete inventories may establish
stale skill/MCP discovery; partial/unknown inventories never do. A prior
`Transport closed` result is transport failure, not absent discovery. A prior
structured disconnected `cdp_status` is app setup, not plugin failure. Keep all
simultaneous findings and ordered next actions.

Codex support policy:

- `>=0.145.0`: same-app install/enable may refresh a subsequent turn.
- Older hosts: fresh launches may work, but plugin changes are restart-only.
- External CLI/manual mutation always requires relaunch.
- `/mcp verbose` is inventory inspection only.

A task with no plugin skills cannot load this skill. Documentation therefore
provides a read-only external bootstrap that validates the exact configured
version/cache root. If materialization is absent, `codex plugin list --json`
reports that directly; diagnosis must not run `plugin add` merely to discover a
path.

## Passive environment checklist

Read/report without mutation:

| Check | Passive evidence | Guidance only |
|---|---|---|
| Node | `node --version` | Node 22.18+ LTS command if missing/old |
| Core package | selected package runtime files | marketplace refresh/materialization |
| iOS runner | packaged Xcode project/artifact presence | one-time build command |
| Android runner | packaged Gradle/APK presence | one-time Gradle command |
| Maestro runner | version/help | package helper/install guidance |
| iOS/Android devices | list-only platform commands | boot guidance |
| Metro | `rn_session` and passive `cdp_status` reads | integrated package script |
| CDP/app | prior supplied observation only | active `check-env` later |
| ffmpeg/idb | version/help and install-state reads | exact install commands |
| physical device | prerequisite file/tool reads | signing/pairing guidance |
| Vercel rules | packaged rules index/checker presence | refresh package if missing |
| auto-connect | environment/project config read | informational only |
| linked worktree private context | packaged `rn-dev-agent-core/dist/worktree-inheritance.js` `plan --host codex --app-root <verified RN app root> --json` plus `hook status` | `$rn-dev-agent:setup` links or repairs after per-resource consent |

For the linked-worktree row, resolve the helper from `<package-root>` derived
from this `SKILL.md` path and verify it exists; never scan caches. Resolve the RN
app root explicitly from its `package.json` React Native/Expo dependency and
never guess it. Read `refusal` first — `NO_PRIMARY`, `AMBIGUOUS`, and
`PRIMARY_APP_MISSING` are the row status and legitimately carry no resources —
then `kind: "primary"` as N/A, then the `rn-agent-actions` regime, app-relative
destination, and state. Report `hook status` in every case. Codex shares only
`.rn-agent/actions`; report Claude local instructions as N/A (Claude-only) and
never create, append, replace, or symlink them. `IGNORE_UNSAFE` and
`LINK_VALID_GIT_VISIBLE` are warnings whose remediation is the shown app-relative
file-form rule for the user's own local ignore policy — never edit a tracked
ignore file or the common exclude, and never print either file's contents.
`LINK_STALE_SOURCE_AVAILABLE` is repairable by setup; `LINK_STALE_SOURCE_MISSING`
is report-only. Never print an absolute private source path or read a private
file.

Doctor never runs a runner build, installer, update, MCP app call, Observe
control, or cleanup. It prints commands for later user confirmation.

## Setup routing

When the user invoked `$rn-dev-agent:setup`, hand off to its package-local
workflow after passive critical checks. Setup uses Codex `AGENTS.md`, not Claude
instruction files. Every AGENTS/scaffold/source/tsconfig write is previewed and
confirmed separately; symlink-inherited corpora are never modified. Optional
active `cdp_status` verification occurs only after the passive phase and project
changes, with the user's setup intent.

When the user invoked `$rn-dev-agent:check-env`, that is an active readiness
workflow and may call `cdp_status`; do not mislabel it passive doctor behavior.

## Recovery messages

Use real Codex CLI commands only, as recommendations:

```text
codex plugin marketplace upgrade rn-dev-agent
codex plugin add rn-dev-agent@rn-dev-agent --json
```

Never invent plugin slash commands. Never add an MCP reload tool, promise
`/new`, call `/mcp` a reconnect, or terminate another host's process.
