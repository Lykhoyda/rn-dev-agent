---
command: proof-capture
description: Capture PR-ready proof artifacts for a feature. Use --strict for a fail-closed proof_capture receipt; omit it for the interactive video, screenshots, and PR-body workflow.
argument-hint: [--strict] <feature-slug> [description of flow to execute]
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, mcp__*cdp__*
---

Capture PR proof artifacts for: $ARGUMENTS

If `$ARGUMENTS` contains `--strict`, execute the strict machine workflow below.
Otherwise, execute the interactive compatibility workflow.

## What Interactive Mode Does

This section applies only when `--strict` is absent.

1. **Rehearses the flow OFF camera** to discover testIDs / navigation / state — recording captures replay, not exploration
2. **Generates a Maestro flow** capturing the verified sequence (with M7 metadata)
3. Starts video recording on the active simulator/emulator
4. **Replays the rehearsed flow** via `maestro_run` (deterministic, hesitation-free)
5. Captures numbered screenshots at each step
6. Stops recording and converts to GIF (if ffmpeg available)
7. **Labels the video** — adds a text bar below the video with step descriptions (default)
8. **Validates the recording** — verifies the feature is actually visible
9. Writes PROOF.md and generates PR-BODY.md

**Core principle.** Discovery happens before the camera rolls. The video is
the replay of a known-good action — never the LLM working out testIDs or
navigation paths on screen. If you would not show the rehearsal pass to a
reviewer, do not record it.

## Strict Machine Workflow (`--strict`)

`/rn-dev-agent:proof-capture --strict <feature-slug> [description]` is the
human and agent entry point for the `proof_capture` tool. Strict mode is a
machine workflow: every state transition goes through `proof_capture`, and no
manual estimate or caller self-attestation can accept evidence.

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
   whose operation and assertion argument hashes use canonical recursively
   key-sorted, redacted JSON. Declare at least three storyboard steps, each with one result-bound screenshot and one passing assertion.
6. For every step, declare the exact operation tool and argument hash, then use
   `proof_step(verifyTestID=..., screenshotPath=..., waitMs=0)` as its assertion.
   The screenshot path and assertion argument hash must match the storyboard.

Use the rehearsal duration reported by `finish_rehearsal`; do not estimate video
time or label ranges manually:

```text
minimum = floor(rehearsalDurationMs * 0.8)
maximum = min(ceil(rehearsalDurationMs * 1.5 + 10000), 120000)
```

The duration window includes a 10-second API and device timing grace and has an absolute two-minute maximum.

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
   `debuggingFriction=false`, and `personalData=false`. The review must also
   name its provider, repeat the session's `writerProvider`, and bind the
   reviewed output with `resultHash`. Then call
   `proof_capture(action="finalize", evidenceReview=...)`.

### 3. Fail closed

Any video start, stop, path, device, media, or validation failure is a hard stop.
Screenshots never downgrade or replace the required video.
Strict mode never asks whether to re-record; discard the rejected capture and begin a fresh rehearsal.
Do not provide GitHub drag-and-drop or PR-upload instructions in strict mode.

Call `proof_capture(action="status")` when the current stage is uncertain. On any
rejection, print the returned stable reason code exactly, call
`proof_capture(action="discard")`, restore the clean start state, and create a
new session from `begin_rehearsal`. Never reuse a rejected clip, screenshot, or
receipt destination.

Repair, reload, restart, reset, Dev Client dismissal, or any other debugging during recording invalidates the capture.
Action repair and reload are also forbidden during rehearsal: use
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

When `--strict` is absent, keep the existing best-effort workflow below. Its
re-record prompt, screenshot fallback, optional GIF/labels, PROOF.md, PR-BODY.md,
and upload guidance are interactive-only behavior.

### Step 1: Parse arguments and prepare

Extract `<feature-slug>` from the first argument. The rest is the flow description.
If no slug provided, ask the user.

```bash
mkdir -p docs/proof/<feature-slug>
```

### Step 2: Environment check

Call `cdp_status` to confirm the app is running and CDP is connected.

**Pre-recording readiness check (GH #8, #9):**
1. Call `cdp_status` — this auto-detects and auto-dismisses the Dev Client
   server picker if a device session is open (GH #9). If `cdp_status`
   returns a warning about the picker, call it again after a few seconds.
2. Call `cdp_navigation_state` — verify it returns a valid route name
   (not empty, not "DevClientLauncher", not "ServerPicker"). If still stuck,
   ask the user to select the Metro server manually.
3. Call `cdp_dev_settings(action="disableDevMenu")` — suppress the shake-to-show
   dev menu so it doesn't pop up during recording and ruin the video.
4. Take a baseline screenshot to confirm the starting screen is the actual
   app, not a system dialog or dev client picker.

### Step 2.5: Rehearsal pass (MANDATORY — discovery happens OFF camera)

**Do NOT start recording yet.** First, walk the described flow once with no
video so you can discover testIDs, navigation paths, and state shapes
without the camera capturing the search.

**Protocol:**

1. Execute the described flow using `device_*` / `cdp_*` calls. If no flow
   description was supplied, ask the user to describe the steps before
   continuing.
2. Fix any discovered drift (wrong testID, missing route, store-path typo).
3. **Generate a Maestro flow** capturing the verified sequence at
   `<test-app>/.rn-agent/actions/<slug>.yaml` (`<test-app>` = the RN
   project's root). Two authoring paths:
   - `maestro_generate(name="<slug>", steps=[...], appId="...")` — writes
     the YAML from structured steps; does NOT emit the M7 metadata header.
   - `cdp_record_test_generate(format="maestro")` — converts the recorder
     buffer to YAML text; M7 fields are not forwarded by the MCP tool
     schema, so the header is not auto-populated.
   In both paths, the agent MUST then PREPEND the 5-key M7 metadata header
   by hand (`id`, `intent`, `tags`, `mutates`, `status`) — see
   `skills/rn-testing/SKILL.md` § "Reusable Action Metadata Schema", and the
   creating-actions skill for the full authoring contract (header validation,
   replay-to-promote).
4. Reset the app state to the same starting screen the recording will use
   (close modals, navigate back, clear in-memory residue if `mutates: true`).
5. Smoke-test the flow once via
   `cdp_run_action({actionId: "<slug>", params: {KEY: "VALUE"}})` — it
   records a RunRecord and a clean pass auto-promotes the action
   `experimental` → `active`. `params` covers `${VAR}` placeholders
   (forwarded as `-e KEY=VALUE`); plain `maestro_run(flowPath=...,
   params={...})` or the `maestro-runner` CLI are equivalent replays
   without the telemetry. The replay must pass end-to-end without a
   single failure.
6. **Retry budget: max 3 fix-and-replay loops.** If the rehearsal still
   fails after 3 attempts, escalate to the user with the failing step,
   the failing assertion, and snapshots from `cdp_navigation_state` /
   `cdp_store_state` — do NOT loop indefinitely.

**Hard gate.** If step 5 fails, fix the flow and repeat (max 3 attempts).
Do not move to Step 3 (start recording) until the replay is clean OR the
inexpressibility carve-out below has been documented.

**Maestro-inexpressibility carve-out.** If the flow genuinely cannot be
expressed in Maestro (custom gestures, native-module side-effects,
Reanimated proof captures via `cdp_set_shared_value`, JS-introspection
mid-flow), document the specific Maestro primitive that is missing in
PROOF.md "Deviations" and proceed to Step 3 — the rehearsal walk via
`device_*` / `cdp_*` becomes the artifact. Choosing the fallback without
naming the inexpressibility is a Red Flag — keep trying to express the
flow until you can name what's missing.

### Step 3: Start recording

After the rehearsal flow has replayed clean, reset the app to the starting
screen one more time, then start recording:

```bash
# iOS
rn-record-proof start ios docs/proof/<slug>/flow-ios.mp4

# Android
rn-record-proof start android docs/proof/<slug>/flow-android.mp4
```

If recording fails to start, warn but continue — screenshots are the primary artifact.

### Step 4: Replay the rehearsed flow

**Preferred path:** with recording running, invoke the Maestro flow generated
in Step 2.5.

```
maestro_run(flowPath="<test-app>/.rn-agent/actions/<slug>.yaml", params={KEY: "VALUE"})
```

`params` covers `${VAR}` placeholders (forwarded to maestro as `-e KEY=VALUE`;
keys match `[A-Z_][A-Z0-9_]*`). Omit it for env-free flows. The
`maestro-runner` CLI with `-e` flags is an equivalent Bash path.

While the flow runs, take numbered screenshots at meaningful state changes:

```bash
device_screenshot(path="docs/proof/<slug>/<NN-stepname>.jpg")
```

For each screenshot, verify the expected state via `cdp_component_tree`,
`cdp_store_state`, or `cdp_navigation_state`.

**Fallback (only if Maestro cannot express the flow):** execute the
rehearsed sequence step-by-step using the same `device_*` / `cdp_*` calls
you confirmed in Step 2.5. Every action must be one you already executed
cleanly during rehearsal — do NOT debug, navigate randomly, or "explore"
on camera.

**If a step fails on camera:** stop recording, rebase the app state, redo
Step 2.5. A failure here means the flow drifted between rehearsal and
recording — that's a flow bug, not a feature bug. Do not "fix it on camera."

### Step 5: Stop recording

```bash
rn-record-proof stop
```

Attempt GIF conversion:
```bash
rn-record-proof convert-gif docs/proof/<slug>/flow-ios.mp4 docs/proof/<slug>/flow-ios.gif
```

### Step 5.5: Label the video (default)

Add timed step labels to the recorded video. Build a JSON array mapping each
step to a time range, then call the label subcommand:

```bash
rn-record-proof label \
  docs/proof/<slug>/flow-ios.mp4 \
  docs/proof/<slug>/flow-ios-labeled.mp4 \
  '[{"start":0,"end":5,"text":"Step 1: <description>"},{"start":5,"end":12,"text":"Step 2: <description>"}]'
```

**How to estimate time ranges:** The recording starts at Step 3 (start recording)
and each interaction step takes ~3-8 seconds including the settle wait. Use the
step execution order and count ~5s per step as a rough guide. The labels don't
need frame-perfect timing — they just need to be close enough that the viewer
understands what's happening.

If `record_proof.sh label` fails (missing ffmpeg or Pillow), warn but continue —
the raw video is still usable, labels are a nice-to-have.

The labeled video replaces the raw video as the primary artifact in PROOF.md.

### Step 6: VALIDATE the recording (CRITICAL)

**Before presenting the video to the user, you MUST verify it captured the
expected feature.** This prevents wasting time on recordings that show the
wrong screen, a blank simulator, or an error state.

Validation checklist:
1. **Video file exists and has reasonable size** (> 10KB for a real recording):
   ```bash
   ls -la docs/proof/<slug>/flow-*.mp4 2>/dev/null
   ```

2. **Final screenshot shows the expected end state** — take a screenshot
   after stopping the recording and verify via `cdp_component_tree` or
   `cdp_navigation_state` that the app is on the expected screen with the
   expected data.

3. **No errors occurred during recording** — call `cdp_error_log` and
   verify no new errors appeared during the flow.

4. **Screenshots match the flow description** — review each numbered
   screenshot file exists and has non-zero size.

If validation fails:
- Report exactly what went wrong
- Ask the user if they want to re-record
- Do NOT present invalid proof as complete

### Step 7: Write PROOF.md

Create `docs/proof/<slug>/PROOF.md` with the standard format:
- Date, device info, method
- Flow table with step/screenshot/action/verification columns
- Key state snapshots
- Deviations section

### Step 8: Generate PR body

```bash
rn-generate-pr-body docs/proof/<slug>/
```

### Step 9: Present results

Show the user:
- Validation results (all checks passed)
- Path to PROOF.md
- Path to PR-BODY.md
- Path to video file(s)
- Path to GIF file(s) if created
- Instruction: "Copy PR-BODY.md content into your PR description.
  Upload video files via GitHub drag-and-drop."

## Prerequisites

- iOS Simulator or Android Emulator running with the app loaded
- Metro dev server running
- ffmpeg required for GIF conversion and video labeling (`brew install ffmpeg`)
- Pillow auto-installed in a venv for label rendering (no manual setup needed)
