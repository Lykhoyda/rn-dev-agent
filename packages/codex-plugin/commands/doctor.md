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

When the RN app root is known, also run the read-only packaged helper
`<package-root>/rn-dev-agent-core/dist/worktree-inheritance.js plan --host codex --app-root <app> --json` and `hook status`. Report the `.rn-agent/actions` state without printing its private source path or reading action bodies. Mutation and hook installation belong to setup.

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
skill is present, not all 27. A task with zero rn-dev-agent skills cannot invoke
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

Also run `<package-root>/rn-dev-agent-core/dist/maestro-runner-pin.js diagnose --json`
read-only. Report that iOS exact React testIDs use `react-tree`, while native/system
selectors use `xctest-native`. Runtime version is diagnostic context, never proof of WDA
blindness. `NATIVE_SURFACE_BLIND` requires bounded same-screen native-selector evidence;
without it, preserve the ordinary selector miss. Recommend the central native WDA smoke
on a WDA-healthy runtime as the supported next action.

For missing components, print exact commands but do not offer to execute them
inside doctor. Plugin recovery order is user-confirmed marketplace upgrade,
materialization with `codex plugin add rn-dev-agent@rn-dev-agent --json`, Codex
relaunch when required, then inventory recheck.

## Session-authority wedge

When the RN app root is known, run the read-only packaged probe
`node <package-root>/rn-dev-agent-core/dist/session-doctor.js report --json`. The report is
three-state: GREEN when `sameRootOwner` is `absent` and `wedged` and `repairable` are both
false, YELLOW when `repairable` is true (a proven-dead owner of this exact root, released by
the next transport start or by the repair command) or `sameRootOwner` is `live` (another
session holds this worktree right now — report its `ownerSession` and `ownerAppRoot` instead
of GREEN; it is never released and clears when that session closes), and RED when `wedged`
is true. On RED, name the exact cause it returns
instead of a generic stale-lock story:
`sameRootOwner: unprovable` (the recorded owner's process identity cannot be read, so it
is conservatively treated as live), `startupCleanupBlocked` (the owner is proven dead but
an obligation such as `RUNNER_ADOPTION_REQUIRED` could not be discharged), or
`ownerIsThisRoot: false`, whose `ownerMismatch` says which: `app-root` (a proven-dead owner
of another app root in this worktree) or `source-identity` (the same app root under different
declared manifests). Report a non-zero `abandonedContenders` too. Print the supported repair,
`node <package-root>/rn-dev-agent-core/dist/session-doctor.js repair`, but do not execute
it from doctor. Print it rooted where it can succeed: for `ownerMismatch: app-root` that is
the reported `ownerAppRoot`, because repair from the current root can never release another
root's owner. For `ownerMismatch: source-identity` do not re-root it — the payload's own
remedy names the declared-manifest restore that makes this root's repair work. It runs the same proven-dead startup cleanup a fresh transport runs and
never releases a live or unprovable owner; not every stale lock self-heals, only a proven
-dead owner does. Never recommend deleting or moving files in the authority store.

Never recommend raw Maestro as strict-proof recovery and never kill a bridge
owned by another host.
