---
command: proof-capture
description: Capture PR-ready proof artifacts — video recording, screenshots, and generated PR body for a feature. Validates the recording shows the expected feature before presenting.
argument-hint: <feature-slug> [description of flow to execute]
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, mcp__*cdp__*
---

Capture PR proof artifacts for: $ARGUMENTS

## What This Does

1. Starts video recording on the active simulator/emulator
2. Executes the described user flow (or asks you to perform it)
3. Captures numbered screenshots at each step
4. Stops recording and converts to GIF (if ffmpeg available)
5. **Labels the video** — adds a text bar below the video with step descriptions (default)
6. **Validates the recording** — verifies the feature is actually visible
7. Writes PROOF.md and generates PR-BODY.md

## Protocol

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
   server picker if an agent-device session is open (GH #9). If `cdp_status`
   returns a warning about the picker, call it again after a few seconds.
2. Call `cdp_navigation_state` — verify it returns a valid route name
   (not empty, not "DevClientLauncher", not "ServerPicker"). If still stuck,
   ask the user to select the Metro server manually.
3. Call `cdp_dev_settings(action="disableDevMenu")` — suppress the shake-to-show
   dev menu so it doesn't pop up during recording and ruin the video.
4. Take a baseline screenshot to confirm the starting screen is the actual
   app, not a system dialog or dev client picker.

### Step 3: Start recording

Detect the platform and start recording:

```bash
# iOS
rn-record-proof start ios docs/proof/<slug>/flow-ios.mp4

# Android
rn-record-proof start android docs/proof/<slug>/flow-android.mp4
```

If recording fails to start, warn but continue — screenshots are the primary artifact.

### Step 4: Execute the flow

If a flow description was provided, navigate and interact through the described
flow step by step. At each meaningful state change:

1. Wait 1-2 seconds for the UI to settle
2. Take a numbered screenshot:
   ```bash
   xcrun simctl io booted screenshot --type=jpeg docs/proof/<slug>/01-<description>.jpg
   ```
3. Verify the expected state via `cdp_component_tree`, `cdp_store_state`,
   or `cdp_navigation_state`

If no flow description was provided, ask the user to describe the steps.

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
