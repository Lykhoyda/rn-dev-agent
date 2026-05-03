---
command: run-action
description: Execute a learned Maestro flow ("action") by name with optional -e KEY=VALUE parameters. Looks the flow up via scripts/learned-actions.mjs (same inventory as /rn-dev-agent:list-learned-actions), then replays it with maestro-runner. Counterpart to /list-learned-actions — list discovers, run executes.
argument-hint: <action-name> [-e KEY=VALUE ...] [--platform ios|android] [--dry-run]
allowed-tools: Bash, Read, Glob
---

Execute the learned action: $ARGUMENTS

## What this command does

`/rn-dev-agent:list-learned-actions` lists what's available;
`/rn-dev-agent:run-action` actually replays one. Together they implement the
artifact-first protocol from `feedback_execute_artifacts_before_manual.md`:
list → match → run, before composing any `device_*` primitives manually.

The action name is matched against the inventory's `flow` field (filename
without `.yaml`). Substring + case-insensitive — `task-create` will match
`wizard-create-task` if it's the only candidate; ambiguity errors otherwise.

## Argument parsing

The first positional arg is the action name (required). Subsequent args are
passed through to `maestro-runner` verbatim:

- `-e KEY=VALUE` — environment variable for `${KEY}` placeholders in the flow
- `--platform <ios|android>` — target device (auto-detected from booted device if omitted)
- `--dry-run` — print the resolved replay command without executing it

Example calls:

```
/rn-dev-agent:run-action wizard-create-task -e TITLE="Buy milk" -e PRIORITY=high -e TAG=feature -e DESC="Test"
/rn-dev-agent:run-action mark-all-done --platform android
/rn-dev-agent:run-action wizard-create-task --dry-run -e TITLE=foo -e PRIORITY=low -e TAG=bug -e DESC=test
```

## Protocol

1. **Parse arguments.** First word of `$ARGUMENTS` is the action name. Detect
   `--platform`, `--dry-run`, and collect every `-e KEY=VALUE` pair. Treat
   anything else as a passthrough flag.

2. **Resolve the action via the script** (single source of truth — never glob
   `.rn-agent/actions/` directly):
   ```bash
   ACTION_NAME="<first-arg>"
   RESULT=$(node "${CLAUDE_PLUGIN_ROOT}/scripts/learned-actions.mjs" \
     --json --section b \
     --workspace-root "$PWD" --memory-cwd "$PWD" \
     --filter "$ACTION_NAME")
   COUNT=$(echo "$RESULT" | jq '.sections.flows.count')
   ```
   - **0 matches**: stop. Tell the user what they searched for, list the
     closest 5 alternatives by running the script again with a broader filter
     (or no filter), and suggest creating the flow via `/rn-dev-agent:test-feature`.
   - **>1 match**: stop. Print the candidates with their full paths and ask
     the user to disambiguate (e.g. by passing the full filename without
     `.yaml`).
   - **1 match**: continue to step 3.

3. **Pre-flight safety checks** before replay:
   - **Read the flow file** and look for a `mutates: true` or
     `destructive: true` line in the metadata header (per the schema in
     `skills/rn-testing/SKILL.md` "Maestro Flow Standards"). If present,
     **warn the user explicitly** and ask for confirmation before running.
     Mention that destructive flows can create duplicate backend rows when
     replayed multiple times — suggest using a timestamp-suffixed TITLE
     parameter or running with `--dry-run` first.
   - **Check `appId` matches the booted app**: read `appId:` from the flow
     header; verify a device with that bundle is booted. If not, stop and
     suggest running `/rn-dev-agent:setup` or booting the right simulator.
   - **Validate `-e` parameters cover the flow's `${VAR}` placeholders**:
     parse `${...}` from the flow body; report any unset placeholders and
     refuse to run unless the user confirms (Maestro will fail at runtime
     anyway — this catches it earlier with a clearer error).

4. **Detect platform** if not passed:
   ```bash
   IOS_BOOTED=$(xcrun simctl list devices booted 2>/dev/null | grep -c Booted || true)
   ANDROID_BOOTED=$(adb devices 2>/dev/null | grep -c "device$" || true)
   ```
   - If exactly one platform has a booted device, use it.
   - If both are booted, stop and ask the user to pass `--platform`.
   - If neither, stop and tell the user to boot a device.

5. **Build the replay command**:
   ```bash
   FLOW_PATH=$(echo "$RESULT" | jq -r '.sections.flows.items[0].path')
   CMD=(maestro-runner --platform "$PLATFORM" test)
   for KV in "${E_FLAGS[@]}"; do CMD+=(-e "$KV"); done
   CMD+=("$FLOW_PATH")
   ```
   If `--dry-run`, print `${CMD[*]}` and stop. Otherwise execute it.

6. **Execute and report**:
   - Stream the output (don't swallow); capture exit code.
   - On success: report `passed/total` commands and `duration_ms` from the
     report JSON (`reports/<timestamp>/report.json`), plus the full path so
     the user can inspect screenshots and the hierarchy XML.
   - On failure: extract the failing command from the report JSON and the
     associated `assets/flow-000/cmd-NNN-after.png` screenshot path. Diagnose
     in three lines max — point at the most likely cause (stale testID,
     iOS keyboard digraph drop per `feedback_maestro_patterns.md` item 9,
     auth state lost, etc.) — DO NOT auto-edit the flow.

## Output

After execution, summarise:

```
✅ <flow-name> passed (16/16, 18.5s)
Replayed: <command-line>
Report: reports/2026-04-29_HH-MM-SS/report.html
```

Or:

```
❌ <flow-name> failed at step <N> ("tapOn id: ...")
Replayed: <command-line>
Failing screenshot: reports/.../assets/flow-000/cmd-N-after.png
Likely cause: <one-line diagnosis>
Next step: <single concrete suggestion>
```

## Why this command exists separately from list

- `list` is **read-only** discovery — safe to run any time.
- `run` is **side-effecting** execution — gates safety checks (mutates,
  appId match, parameter coverage) that don't apply to a list.
- Splitting them keeps the discovery path fast (no Maestro startup cost
  just to enumerate) and makes the audit trail clearer ("we listed N
  actions, then ran action X with these params").

## Coordination with other commands

| Command | When it calls into `run-action` (conceptually) |
|---|---|
| `/rn-dev-agent:test-feature` | Step 0: if `list-learned-actions` returns a match, the protocol says "run that flow" — equivalent to invoking this command |
| `/rn-dev-agent:debug-screen` | Step 0a: same — replay the matching flow to deterministically reproduce the bug |
| `/rn-dev-agent:proof-capture` | Future: replay an existing flow under recording to produce the proof video without manually walking the UI |

These commands run the underlying script + maestro-runner directly rather
than literally invoking `/rn-dev-agent:run-action` (slash commands cannot
reliably call other slash commands), but the contract is the same.

## Failure modes to flag

- **Multi-app session**: if the flow's `appId` doesn't match the connected
  CDP target, the replay will tap into the wrong app. Always check `appId`
  against `cdp_status.cdp.bundleId` if a CDP session is active.
- **iOS Simulator predictive-keyboard drop**: per
  `feedback_maestro_patterns.md` item 9, Maestro's `inputText` can drop
  characters under load. If a replay fails with a string-mismatch
  assertion, suggest re-running once before assuming a real bug.
- **App relaunch wipes state**: maestro-runner force-stops by default. If
  the flow uses `launchApp: { stopApp: false }` (the self-bootstrap
  pattern from `wizard-create-task.yaml`), in-flight UI state is preserved
  — but most flows still cold-start.

See `commands/list-learned-actions.md` for the discovery counterpart and
`scripts/learned-actions.mjs` for the underlying script (single source of
truth for both commands).
