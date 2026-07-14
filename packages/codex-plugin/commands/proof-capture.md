---
command: proof-capture
description: Capture PR-ready proof artifacts for a feature. Use --strict for a fail-closed proof_capture receipt; omit it for the interactive video, screenshots, and PR-body workflow.
argument-hint: [--strict] <feature-slug> [description of flow to execute]
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, mcp__*cdp__*
---

Capture PR proof artifacts for: $ARGUMENTS

If `$ARGUMENTS` contains `--strict`, execute the strict machine workflow below.
Otherwise, load the **capturing-proof** skill and execute its Protocol (Steps
1–9) inline in this parent session. Use the first argument as
`<feature-slug>` (ask the user if missing) and the remaining arguments as the
flow description. The skill owns the interactive rehearsal gate, named
Maestro-inexpressibility carve-out, validation checklist, PROOF.md, and
PR-BODY.md generation; do not duplicate or improvise that protocol here.

## Strict Machine Workflow (`--strict`)

`/rn-dev-agent:proof-capture --strict <feature-slug> [description]` is the
human and agent entry point for the `proof_capture` tool. Every transition goes
through `proof_capture`; no manual estimate or caller self-attestation can
accept evidence.

```text
rehearsing -> rehearsed -> armed -> recording -> validating -> mechanically_accepted -> accepted
```

### 1. Build the immutable proof context

Before beginning a session:

1. Resolve the absolute Git worktree root and require a clean source tree.
2. Resolve the issue, pull request head SHA, proof class, acceptance criteria,
   fixture identity, and current writer provider. Stop before beginning if any
   required value is unknown.
3. Select one existing learned action and pin its id, runtime revision, and
   SHA-256 of the exact `.rn-agent/actions/<id>.yaml` bytes. The action must not
   change for the rest of the run.
4. Create a unique lowercase kebab-case run id. All destinations must be fresh,
   absolute descendants of `docs/proof/<run-id>/`: `proof.mp4`,
   `proof-contact-sheet.jpg`, `proof-receipt.json`, and the declared screenshot
   paths.
5. Define a typed storyboard whose source SHA equals the clean Git `HEAD` and
   whose operation and assertion argument hashes are computed from canonical recursively
   key-sorted, redacted JSON.
   Declare at least three storyboard steps, each with one result-bound screenshot and one passing assertion.
6. For every step, declare the exact operation tool, operation argument hash,
   assertion tool, `verifyTestID`, screenshot path, and `assertionWaitMs` from
   0–10000. Bind `assertionArgsSha256` to the exact
   `proof_step(verifyTestID=..., screenshotPath=..., waitMs=assertionWaitMs)`
   arguments. Keep the first step at zero wait for start-state freshness. A
   short bounded wait for later animated transitions lets assertions capture
   stable destination states.

Use the rehearsal duration reported by `finish_rehearsal`; do not estimate
video time or label ranges manually:

```text
minimum = floor(rehearsalDurationMs * 0.8)
targetMaximum = min(ceil(rehearsalDurationMs * 1.5 + 10000), 120000)
hardMaximum = targetMaximum + 5000
```

The adaptive target includes a 10-second API/device timing grace and is capped at two minutes.
A clip above `targetMaximum` is accepted only when every frame, semantic, timing, Git/runtime/error, and final evidence-review gate passes.
The five-second tolerance is not an independent bypass, and any clip above `hardMaximum` fails with `VIDEO_TOO_LONG`.

### 2. Execute every strict transition

1. Start the session with the complete immutable context:
   `proof_capture(action="begin_rehearsal", projectRoot=..., receiptPath=..., videoPath=..., contactSheetPath=..., writerProvider=..., runId=..., issue=..., pullRequest=..., proofClass=..., acceptanceMappings=..., fixture=..., proofAction=..., storyboard=...)`.
2. During rehearsal, call only
   `cdp_run_action(actionId=..., autoRepair=false, forceReload=false, proofReplay=true)`.
   Then immediately call `proof_capture(action="finish_rehearsal")`.
3. Re-establish the declared start state and call the first step's exact
   `proof_step`. Call `proof_capture(action="arm")`, then call the same start
   assertion once more so recording start is bound to a fresh post-arm result.
4. Call `proof_capture(action="start_recording")`. Do not call `device_record`
   directly.
5. Execute each storyboard operation once, in order. Immediately follow every
   operation with its declared `proof_step`; do not add undeclared tools.
6. Call `proof_capture(action="stop_recording")`. The tool owns recorder
   shutdown, the saved-path check, and result-bound evidence derivation.
7. Call `proof_capture(action="validate")`. The tool validates the event trace,
   adaptive duration, hashes, screenshots, frame matches, contact sheet, Git
   authority, device/runtime identity, Metro continuity, and error baseline.
8. Give the mechanically accepted receipt and contact sheet to a vision-capable
   reviewer whose provider differs from the writer. Require an independent
   review with `exactFeature=true`, `irrelevantScreens=false`,
   `debuggingFriction=false`, and `personalData=false`. The review must name its
   provider, repeat the session's `writerProvider`, echo the validation result's
   `reviewTargetSha256` as `evidenceSha256`, and bind the reviewed output with
   `resultHash`. Then call
   `proof_capture(action="finalize", evidenceReview=...)`.

### 3. Fail closed

Any video start, stop, path, device, media, or validation failure is a hard stop.
Screenshots never downgrade or replace the required video.
Strict mode never asks whether to re-record; discard the rejected capture and begin a fresh rehearsal.
Do not provide GitHub drag-and-drop or PR-upload instructions in strict mode.

Call `proof_capture(action="status")` when the current stage is uncertain. On
rejection, print the returned stable reason code exactly, call
`proof_capture(action="discard")`, restore the clean start state, and create a
new session from `begin_rehearsal`. Never reuse a rejected clip, screenshot, or
receipt destination.

Repair, reload, restart, reset, Dev Client dismissal, or any other debugging during recording invalidates the capture.
Action repair and reload are also
forbidden during rehearsal: use
`autoRepair=false, forceReload=false, proofReplay=true`. If the learned action
needs repair, discard the session, repair and replay it outside strict capture,
then begin again with its new identity and clean Git state.

### Strict result

Print only:

- accepted receipt path
- screenshot paths
- local video path and SHA-256 hash
- contact-sheet path
- action and storyboard SHA-256 hashes
- exact invalidation reason on failure

Do not print time estimates, manual visual-validation claims, GIF/label status,
PR-body instructions, or upload instructions. Read accepted values from the
`finalize` receipt; never reconstruct or self-attest them.

## Interactive Compatibility

Interactive mode is delegated to the capturing-proof skill as described above.
