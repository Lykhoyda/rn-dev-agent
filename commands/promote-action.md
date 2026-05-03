---
command: promote-action
description: Elevate an agent-owned reusable action (.rn-agent/actions/<id>.yaml) into the team's core E2E suite (.maestro/flows/). Strips agent-specific runtime metadata, keeps the M7 contract, marks the file with a one-line provenance comment. One-way gesture — once promoted, the agent treats the file as read-only.
argument-hint: <action-id> [--to <category>/<name>] [--keep-source] [--no-validate]
allowed-tools: Bash, Read, Write
---

# Promote agent action → core E2E test

Run this when an `.rn-agent/actions/<id>.yaml` action has proven valuable
enough to become a regression test in the team's `.maestro/flows/` suite.
This is the explicit human gesture that crosses the L3→core-test boundary
defined in D1206 (three-layer architecture) + D1207 (.rn-agent/ directory
convention).

`$ARGUMENTS`

## What this does

1. **Validates** the agent action is suitable for promotion:
   - status is `active` (not `experimental` or `deprecated`)
   - sidecar shows ≥ 5 successful runs in the last 30 days
   - sidecar shows zero repairs in the last 30 days (or `--no-validate` was passed)

2. **Resolves the destination path:**
   - If `--to <category>/<name>` is supplied: `.maestro/flows/<category>/<name>.yaml`
   - Default: `.maestro/flows/<id>.yaml`

3. **Strips agent-specific metadata** from the YAML header. Keeps the M7
   contract (`id`, `intent`, `tags`, `mutates`); drops `status` (irrelevant
   for core tests), the runtime sidecar, and the agent's `repairHistory`.

4. **Adds a provenance comment** at the top of the YAML body:
   ```
   # promoted-from: .rn-agent/actions/<id>.yaml on YYYY-MM-DD
   # provenance: rn-dev-agent v<version>; revision <N> at promotion
   ```

5. **Moves the file** via `git mv` (preserves blame history) — unless
   `--keep-source` is passed, in which case the agent action stays in
   place but a stub at `.rn-agent/actions/<id>.yaml` is written that
   says "promoted; see .maestro/flows/...".

6. **Removes the sidecar** (`.rn-agent/state/<id>.state.json`). Core tests
   are owned by the team's CI; per-developer runtime state doesn't apply.

7. **Confirms with `git status`** that the move went where you expected.
   Never auto-commits — that's a human review step.

## Protocol

### Step 1: Parse arguments

The first argument is the action id (e.g. `wizard-create-task`). The rest
are flags:

- `--to <category>/<name>` — destination under `.maestro/flows/`. If only
  a name is supplied (no slash), uses the root of `.maestro/flows/`. If
  category-only (`--to critical-paths/`), keeps the original filename.
- `--keep-source` — leave the agent action in place; write a stub instead.
- `--no-validate` — skip the run-history checks. Use for forced promotion
  when you're certain (e.g. you wrote the action yourself).

### Step 2: Read + validate the action

```bash
ACTION_ID="<from-args>"
ACTION_PATH=".rn-agent/actions/${ACTION_ID}.yaml"
SIDECAR_PATH=".rn-agent/state/${ACTION_ID}.state.json"

if [ ! -f "$ACTION_PATH" ]; then
  echo "✗ No action at $ACTION_PATH"
  echo "  Run /list-learned-actions to see available actions."
  exit 1
fi
```

Read the YAML and the sidecar JSON. Check:

- `status: active` in the M7 header
- `stats.successCount >= 5` in the sidecar
- `repairHistory[]` has zero entries from the last 30 days

If any check fails, **report the failure and refuse**. Tell the user how
to proceed:
- "status is experimental — run /run-action first to validate, status auto-promotes on success"
- "only N successful runs — wait until the action is well-exercised before promoting"
- "M repairs in last 30 days — the underlying screen is still in flux; not stable enough for core test"

If `--no-validate` is passed, skip these checks and emit a warning instead.

### Step 3: Resolve destination

```bash
if [ -z "$DEST" ]; then
  DEST=".maestro/flows/${ACTION_ID}.yaml"
elif [[ "$DEST" == *"/" ]]; then
  # Category only — keep the original filename.
  DEST=".maestro/flows/${DEST}${ACTION_ID}.yaml"
elif [[ "$DEST" != *".yaml" ]]; then
  DEST=".maestro/flows/${DEST}.yaml"
else
  DEST=".maestro/flows/${DEST}"
fi

if [ -e "$DEST" ]; then
  echo "✗ Destination already exists: $DEST"
  echo "  Pick a different --to path or rename the existing core test first."
  exit 1
fi
```

### Step 4: Strip + augment YAML

Read `$ACTION_PATH`. Parse the M7 header. Build the promoted YAML:

```yaml
appId: <preserved from source>
---
# promoted-from: <ACTION_PATH> on <YYYY-MM-DD>
# provenance: rn-dev-agent v<version>; revision <N> at promotion
# id: <preserved>
# intent: <preserved>
# tags: [<preserved>]
# mutates: <preserved>
<body — unchanged>
```

Drop the `status:` field (core tests don't have a lifecycle in the agent
sense). Keep `id`, `intent`, `tags`, `mutates`. Keep the body verbatim.

### Step 5: Move

```bash
mkdir -p "$(dirname "$DEST")"
git mv "$ACTION_PATH" "$DEST"
# Apply the YAML rewrite from Step 4 over the moved file.
# (Use Edit/Write to rewrite the header; preserve the body.)

if [ ! "$KEEP_SOURCE" = "1" ]; then
  rm -f "$SIDECAR_PATH"
fi
```

If `--keep-source` was passed, instead write a stub at `$ACTION_PATH`:

```yaml
appId: <same>
---
# id: <same>
# intent: <same>
# status: deprecated
# promoted-to: <DEST> on <YYYY-MM-DD>
- launchApp
# This action was promoted to a core E2E test. See <DEST>.
# Kept here for backward compatibility; do not edit.
```

### Step 6: Confirm

```bash
git status --short
```

Expected output: `R  .rn-agent/actions/<id>.yaml -> .maestro/flows/<...>.yaml`
(or two adds + delete if not via `git mv`).

Print a summary:

```
✓ Promoted: <ACTION_PATH> → <DEST>
  - status field dropped (core tests are CI-owned, not lifecycle-tracked)
  - sidecar removed: <SIDECAR_PATH>
  - provenance: revision <N> at promotion, <YYYY-MM-DD>
  - run `git diff` to review, then commit when ready
```

## Reverse direction (NOT supported by this command)

There is no `/demote-test` companion. Once a flow lives in
`.maestro/flows/`, it's team-owned. If the team decides a core test
should become an agent-managed action again, that's a manual
`git mv` + sidecar regeneration — out of scope for this command.

## Refs

- D1206 (three-layer architecture) — Layer ownership rules
- D1207 (.rn-agent/ directory convention) — agent vs team territory
- `commands/list-learned-actions.md` — discovery
- `commands/run-action.md` — runtime
- `scripts/cdp-bridge/src/domain/action-store.ts` — `actionPathFor()`
