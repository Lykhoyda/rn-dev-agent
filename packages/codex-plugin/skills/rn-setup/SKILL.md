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

Resolve `APP_ROOT` to the exact existing target React Native app directory before
starting the checklist. Use the app selected by the user or the uniquely matching
app from the available project evidence; in a monorepo, use the nested app
directory rather than the repository root. If multiple candidates remain, ask
which app is authoritative. Never run the source-declaration probe with
`APP_ROOT` unset or empty.

Read/report without mutation:

| Check | Passive evidence | Guidance only |
|---|---|---|
| Source declaration | `git -C "$APP_ROOT" rev-parse --show-toplevel`; for a non-Git app root, `RN_DEV_AGENT_DECLARED_ROOT` and `RN_DEV_AGENT_DECLARED_MANIFESTS` in the supervisor environment | Report the missing declaration and point to the [session-authority contract](https://lykhoyda.github.io/rn-dev-agent/session-authority/#what-each-source-identity-proves) |
| Node | `node --version` | Require Node >= 24; every later major, including odd-numbered releases, is supported. Prefer current LTS installation guidance if missing/old. |
| Core package | selected package runtime files | marketplace refresh/materialization |
| iOS runner | packaged Xcode project/artifact presence | one-time build command |
| Android runner | packaged Gradle/APK presence | one-time Gradle command |
| Maestro runner | `maestro-runner-pin.js diagnose --json` must be `pinned-ok` / `>= 1.1.24` / `pin-cache` | package `ensure-maestro-runner.sh` for attested 1.1.24 (floor >= 1.1.24); never PATH, `~/.maestro-runner`, or brew maestro |
| iOS/Android devices | list-only platform commands | boot guidance |
| Metro | `rn_session` and passive `cdp_status` reads | integrated package script |
| CDP/app | prior supplied observation only | active `check-env` later |
| ffmpeg/idb | version/help and install-state reads | exact install commands |
| physical device | list-only readiness plus pre-existing Android reverse-forward reads | signing/pairing guidance; session authority is the sole reverse-forward writer |
| Vercel rules | packaged rules index/checker presence | refresh package if missing |
| auto-connect | environment/project config read | informational only |

Read the source-declaration row first: it is the only row that can fail before a
session exists at all. Report `NON_GIT_MANIFEST_REQUIRED` before setup or build,
then defer declaration requirements to the
[session-authority contract](https://lykhoyda.github.io/rn-dev-agent/session-authority/#what-each-source-identity-proves).

Doctor never runs a runner build, installer, update, MCP app call, Observe
control, cleanup, or `adb reverse` mutation. It reports pre-existing foreign
forwards truthfully and prints commands for later user confirmation.

## Setup routing

When the user invoked `$rn-dev-agent:setup`, hand off to its package-local
workflow after passive critical checks. Before project onboarding can succeed,
run the package-local pin workflow in this exact order:

```text
node <package-root>/rn-dev-agent-core/dist/maestro-runner-pin.js diagnose --json
bash <package-root>/scripts/ensure-maestro-runner.sh
node <package-root>/rn-dev-agent-core/dist/maestro-runner-pin.js diagnose --json
node <package-root>/rn-dev-agent-core/dist/maestro-runner-pin.js migrate-actions --root "$APP_ROOT" --json
```

Continue only when diagnosis reports `status: pinned-ok`, `installedVersion`
`>= 1.1.24`, `pin: 1.1.24`, `provenance: pin-cache`, and every owned action is
migrated or already pinned. Missing,
older, unattested, checksum-mismatched, unknown, unverified, unsupported, unreadable,
or incompatible results are terminal setup failures. Setup uses Codex
`AGENTS.md`, not Claude instruction files. Every AGENTS/scaffold/source/tsconfig
write is previewed and confirmed separately; symlink-inherited corpora are never
modified. Optional active `cdp_status` verification occurs only after the
passive phase and project changes, with the user's setup intent.

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
