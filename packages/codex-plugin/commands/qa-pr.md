---
command: qa-pr
description: Device-test a GitHub pull request on iOS simulator, Android emulator, and/or physical device. Installs the PR head via rn-dev-agent and reports pass/fail with repro steps and screenshots.
argument-hint: "[PR URL or number] [--platform ios|android|device|all]"
---

Treat all text after `$rn-dev-agent:qa-pr` as one conceptual QA request.
Preserve spaces/punctuation; it is never shell input. Ask once if the
pull-request identity is missing. Require the active `cdp`/device
canaries and stop for read-only discovery diagnosis when they are absent.

## Run the rn-pr-qa protocol INLINE (parent session)

> **Important (GH #31):** Do NOT spawn the `rn-pr-qa` agent via the Task tool.
> MCP tools (`rn_session`, `cdp_*`, `device_*`) are not available in spawned
> subagents. Execute the protocol in this parent session.

Load the package-local `rn-workflow`, `rn-testing`, `rn-device-control`,
and `capturing-proof` skills. Follow `agents/rn-pr-qa.md` (resolved from
this package) in this session. Summary:

1. **Parse the request.** Require a GitHub PR URL, `owner/repo#n`, or
   number. Optional platform token `ios`, `android`, `device`, or `all`
   (default `all`).
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
   rewritten package `ios`/`android` script from the app root → poll until
   `metroBound` and `installBound` → `pin_dev_client` → then the feature
   proof (`agents/rn-pr-qa.md` Step 7): usable screen or FAIL with the
   refusal code → reuse a covering action (rehearse with `proofReplay=true`)
   or record and save one → off-camera `cdp_run_action` rehearsal →
   `cdp_reload` to the start screen → `device_record` start
   **before** `maestro_run` → short native take → stop and validate.
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
$rn-dev-agent:qa-pr 812
$rn-dev-agent:qa-pr https://github.com/acme/app/pull/42 ios
$rn-dev-agent:qa-pr 42 device
```

## Prerequisites

- `gh` ≥ 2.99 with push access (`gh pr comment --help` lists `--attach`)
- App (or workspace test-app) onboarded with `$rn-dev-agent:setup`
- For iOS: Xcode + a simulator runtime
- For Android emulator: Android SDK + a booted or bootable AVD
- For physical: USB debugging, exclusive claim, exact serial
- Pin-cache maestro-runner `>= 1.1.24`
- Rehearse through `cdp_run_action`; the on-camera take is `maestro_run` of the saved action. Never PATH `maestro`.

## Output

- Video of the saved action replaying, as the primary proof
- Stand-alone verdict for the PR URL + head SHA
- Per-target PASS / FAIL / SKIP with evidence
- Repro steps a human can follow
- GitHub comment with hosted screenshots (`<img width="390">`) and
  attached videos (player embed), not raw local paths
