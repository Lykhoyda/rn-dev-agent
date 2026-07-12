---
command: proof-capture
description: Capture PR-ready proof artifacts — video recording, screenshots, and generated PR body for a feature. Validates the recording shows the expected feature before presenting.
argument-hint: <feature-slug> [description of flow to execute]
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, mcp__*cdp__*
---

Capture PR proof artifacts for: $ARGUMENTS

## Run the capturing-proof protocol INLINE (parent session)

Load the **capturing-proof** skill and execute its Protocol (Steps 1–9) in
this session with `<feature-slug>` = the first argument (ask the user if
missing) and the rest of `$ARGUMENTS` as the flow description.

Do not improvise the process — the skill owns the protocol, including:

- The **rehearsal-before-recording hard gate** (discovery happens OFF camera;
  max 3 fix-and-replay loops, then escalate)
- The **Maestro-inexpressibility carve-out** (must be named in PROOF.md
  "Deviations")
- The **validation checklist** before presenting any artifact
- PROOF.md + PR-BODY.md generation

## Prerequisites

- iOS Simulator or Android Emulator running with the app loaded
- Metro dev server running
- ffmpeg required for GIF conversion and video labeling (`brew install ffmpeg`)
- Pillow auto-installed in a venv for label rendering (no manual setup needed)
