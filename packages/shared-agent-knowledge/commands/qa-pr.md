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

Load `rn-workflow`, `rn-testing`, `rn-device-control`, and
`capturing-proof`. Follow `agents/rn-pr-qa.md` in this session. Summary:

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
   `metroBound` and `installBound` → `pin_dev_client` → then the feature
   proof (`agents/rn-pr-qa.md` Step 7): usable screen or FAIL with the
   refusal code → reuse a covering action that starts from the attached
   app (rehearse with `proofReplay=true`); if none does, record and save a
   new one and drop its generated `launchApp` → first `cdp_run_action`
   rehearsal of a reused action from the screen the app is on → return to
   the first screen off camera (`cdp_navigate`) before a saved action's
   first rehearsal, any repeat rehearsal, and the take, no runtime reset and no relaunch (never `cdp_reload` /
   `cdp_restart` / `launchApp` on camera) → hash the action after the last
   passing rehearsal → `device_record` start **before** the
   on-camera `cdp_run_action` proof replay → stop and validate.
   Missing video on an app-facing target is FAIL.
7. **Cleanup** reverse-order: runner close → `stop_metro` →
   `restore_integration` → `release`. Remove only the worktree you added.
8. **Report** on the PR with `gh pr comment --body-file` plus
   `--attach` for every screenshot and video (GitHub CLI attaching-files
   flow). Then rewrite screenshot markdown to
   `<img src="…" alt="…" width="390">` via `--edit-last`. Re-read the
   head with `gh pr view "<pr-url>" --json headRefOid` before posting
   and stop if it fails; the verdict binds to the tested SHA. In-session,
   print the verdict table and the comment URL. Never leave unhosted
   `/tmp` paths as the reviewer-visible proof. Public comments are public:
   never write hostname (including `.local`), machine UUID, home
   directory (`/Users/…`), or other absolute local paths — even in a
   code fence. Replace with `[HOST]`, `[MACHINE_ID]`, `[HOME]`,
   `[PATH]`, `[UDID]`, `[UUID]`. Sanitize the pre-upload body before posting
   (exempt only Markdown `--attach` destinations). Then self-check the
   rewritten GitHub body. Follow `agents/rn-pr-qa.md` § Public identity.

## Examples

```
/rn-dev-agent:qa-pr 812
/rn-dev-agent:qa-pr https://github.com/acme/app/pull/42 --platform ios
/rn-dev-agent:qa-pr 42 --platform device
```

## Prerequisites

- `gh` ≥ 2.99 with push access (`gh pr comment --help` lists `--attach`)
- App (or workspace test-app) onboarded with `/rn-dev-agent:setup`
- For iOS: Xcode + a simulator runtime
- For Android emulator: Android SDK + a booted or bootable AVD
- For physical: USB debugging, exclusive claim, exact serial
- Pin-cache maestro-runner `>= 1.1.24`
- Rehearse through `cdp_run_action`; the on-camera take is the same `cdp_run_action` proof replay. Never PATH `maestro`.

## Output

- Video of the saved action replaying, as the primary proof
- Stand-alone verdict for the PR URL + head SHA
- Per-target PASS / FAIL / SKIP with evidence
- Repro steps a human can follow
- GitHub comment with hosted screenshots (`<img width="390">`) and
  attached videos (player embed), not raw local paths
