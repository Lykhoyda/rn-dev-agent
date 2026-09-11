---
command: qa-pr
description: Device-test a GitHub pull request on iOS simulator, Android emulator, and/or physical device. Installs the PR head via rn-dev-agent and reports pass/fail with repro steps and screenshots.
argument-hint: "[PR URL or number] [--platform ios|android|device|all]"
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, mcp__*cdp__*
---

QA this React Native pull request: $ARGUMENTS

## Run the rn-pr-qa protocol INLINE (parent session)

> **Important (GH #31):** Do NOT spawn the `rn-pr-qa` agent via the Task tool.
> MCP tools (`rn_session`, `cdp_*`, `device_*`) are not available in spawned
> subagents. Execute the protocol in this parent session.

Load `rn-workflow`, `rn-testing`, and `rn-device-control`. Follow
`agents/rn-pr-qa.md` in this session. Summary:

1. **Parse `$ARGUMENTS`.** Require a GitHub PR URL, `owner/repo#n`, or
   number. Optional `--platform ios|android|device|all` (default `all`).
   If the PR identity is missing, ask once and stop.
2. **Fetch** with `gh pr view`. Stop on auth or lookup failure.
3. **Classify** the changed files. Docs-only → SKIP device, report files.
   Plugin MCP/device changes → exercise the workspace test-app (or the
   declared candidate app), never Metro-bind the plugin checkout.
4. **Pin the head** in a disposable git worktree. Do not mutate the
   primary checkout.
5. **Inventory** with `rn-workflow` steps 0–2, then
   `rn_session(action="status")`. `device_list` diagnoses; it does not
   choose. Missing requested hardware is SKIP with the exact setup gap.
6. **Per selected target:** `bind_device` (exact id) →
   `preview_integration` → `apply_integration confirmed=true` → run the
   rewritten `<pm> run ios|android` from the app root → poll until
   `metroBound` and `installBound` → `pin_dev_client` → exercise the
   PR change (artifact-first; `cdp_login_prologue` for auth).
7. **Cleanup** reverse-order: runner close → `stop_metro` →
   `restore_integration` → `release`. Remove only the worktree you added.
8. **Report** a per-target table (PASS / FAIL / SKIP) with screenshot
   paths, repro steps, and `cdp_error_log` on failures.

## Examples

```
/rn-dev-agent:qa-pr 812
/rn-dev-agent:qa-pr https://github.com/acme/app/pull/42 --platform ios
/rn-dev-agent:qa-pr 42 --platform device
```

## Prerequisites

- `gh` authenticated for the PR's repository
- App (or workspace test-app) onboarded with `/rn-dev-agent:setup`
- For iOS: Xcode + a simulator runtime
- For Android emulator: Android SDK + a booted or bootable AVD
- For physical: USB debugging, exclusive claim, exact serial
- Pin-cache maestro-runner `>= 1.1.24`
- Replay YAML only through `cdp_run_action`. Never PATH `maestro`.

## Output

- Stand-alone verdict for the PR URL + head SHA
- Per-target PASS / FAIL / SKIP with evidence
- Repro steps a human can follow
- Screenshot and log paths the tools actually wrote
