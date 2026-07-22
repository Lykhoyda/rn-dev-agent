---
command: doctor
description: Run strictly read-only Codex plugin, MCP contract, schema, and environment diagnostics; recommend but never execute recovery.
---

# Doctor — passive recovery diagnosis

This workflow is strictly read-only. It does not install/update/reinstall,
write config/project/cache/state/log files, build runners, attach to CDP/device,
start Observe, or kill/restart any process.

Resolve `<package-root>` from this exact workflow skill's `SKILL.md` path and
run `<package-root>/bin/plugin-health.js --json` with any caller-observed task
facts. Never scan caches or use a launcher-only environment variable.

## Active-task observations

Pass only facts actually observed in this task:

```text
--task-skill <qualified-name>      repeatable
--task-skills-complete             only after inspecting the complete inventory
--task-mcp-tool <qualified-name>   repeatable
--task-mcp-complete                only after `/mcp verbose`/complete inventory
--observed-transport healthy|closed|unknown
--host-proof-schema usable|empty|unknown
--observed-app-status connected|disconnected|unknown
```

Do not infer absence from a partial list. Running this skill proves only this
skill is present, not all 25. A task with zero rn-dev-agent skills cannot invoke
this workflow; use the documented external exact-cache bootstrap.

## Report independent axes

Present host support, installation/enabled state, exact materialization, `cdp`
registration, side-effect-free MCP contract probe, direct proof schema, task
skill/MCP observations, prior transport/schema/app observations, all findings,
primary finding, and ordered next actions.

Codex 0.145.0 is the live-refresh floor. Older/unknown hosts receive
restart-required/unknown guidance, never corruption solely from version.
`/mcp verbose` inspects only. Same-app supported mutation can refresh a later
turn; external mutation and legacy hosts require relaunch.

## Passive environment table

In addition to package health, read only already available/version/file state
for Node, core runtime, packaged iOS/Android runner sources/artifacts,
maestro-runner, simulator/emulator presence, Metro reachability, ffmpeg, idb,
physical-device prerequisites, packaged Vercel rules, and CDP auto-connect
configuration. Do not call `cdp_status`: it can attach. Device/app/CDP state is
`UNKNOWN` unless supplied from a prior structured observation.

For missing components, print exact commands but do not offer to execute them
inside doctor. Plugin recovery order is user-confirmed marketplace upgrade,
materialization with `codex plugin add rn-dev-agent@rn-dev-agent --json`, Codex
relaunch when required, then inventory recheck.

Never recommend raw Maestro as strict-proof recovery and never kill a bridge
owned by another host.
