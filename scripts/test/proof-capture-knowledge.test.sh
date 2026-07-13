#!/usr/bin/env bash
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
COMMAND="$REPO_ROOT/packages/shared-agent-knowledge/commands/proof-capture.md"
DOCS="$REPO_ROOT/apps/docs-site/src/content/docs/commands/proof-capture.mdx"

fail=0
ok() { echo "ok: $1"; }
bad() { echo "FAIL: $1"; fail=1; }

require_text() {
  local file="$1"
  local text="$2"
  local description="$3"
  if grep -Fq -- "$text" "$file"; then
    ok "$description"
  else
    bad "$description"
  fi
}

for action in \
  begin_rehearsal \
  finish_rehearsal \
  arm \
  start_recording \
  stop_recording \
  validate \
  finalize
do
  require_text \
    "$COMMAND" \
    "proof_capture(action=\"$action\"" \
    "strict workflow calls proof_capture $action"
done

require_text \
  "$COMMAND" \
  'rehearsing -> rehearsed -> armed -> recording -> validating -> mechanically_accepted -> accepted' \
  "strict workflow names all seven states"
require_text \
  "$COMMAND" \
  'Any video start, stop, path, device, media, or validation failure is a hard stop.' \
  "strict video failure is a hard stop"
require_text \
  "$COMMAND" \
  'Strict mode never asks whether to re-record; discard the rejected capture and begin a fresh rehearsal.' \
  "strict workflow never prompts to re-record"
require_text \
  "$COMMAND" \
  'Screenshots never downgrade or replace the required video.' \
  "strict workflow forbids screenshot-primary downgrade"
require_text \
  "$COMMAND" \
  'Do not provide GitHub drag-and-drop or PR-upload instructions in strict mode.' \
  "strict workflow omits GitHub drag-and-drop guidance"
require_text \
  "$COMMAND" \
  'Declare at least three storyboard steps, each with one result-bound screenshot and one passing assertion.' \
  "strict workflow requires at least three screenshots"
require_text \
  "$COMMAND" \
  'proof-receipt.json' \
  "strict workflow writes the canonical receipt"
require_text \
  "$COMMAND" \
  'minimum = floor(rehearsalDurationMs * 0.8)' \
  "strict workflow documents adaptive minimum duration"
require_text \
  "$COMMAND" \
  'maximum = min(ceil(rehearsalDurationMs * 1.35 + 3000), 60000)' \
  "strict workflow documents adaptive maximum and 60-second ceiling"
require_text \
  "$COMMAND" \
  'autoRepair=false, forceReload=false, proofReplay=true' \
  "strict rehearsal disables action repair and reload"
require_text \
  "$COMMAND" \
  'Repair, reload, restart, reset, Dev Client dismissal, or any other debugging during recording invalidates the capture.' \
  "strict workflow invalidates debugging activity"

require_text "$COMMAND" '- accepted receipt path' "strict result prints receipt path"
require_text "$COMMAND" '- screenshot paths' "strict result prints screenshot paths"
require_text "$COMMAND" '- local video path and SHA-256 hash' "strict result prints local video path and hash"
require_text "$COMMAND" '- contact-sheet path' "strict result prints contact-sheet path"
require_text "$COMMAND" '- action and storyboard SHA-256 hashes' "strict result prints action and storyboard hashes"
require_text "$COMMAND" '- exact invalidation reason on failure' "strict result prints exact failure reason"

require_text \
  "$DOCS" \
  '/rn-dev-agent:proof-capture --strict <feature-slug> [description of flow to execute]' \
  "docs expose strict command usage"
require_text \
  "$DOCS" \
  'Strict mode is fail-closed and produces `proof-receipt.json` only after mechanical validation and independent evidence review.' \
  "docs describe accepted strict receipt"
require_text \
  "$DOCS" \
  'The duration window adapts to rehearsal time and is capped at 60 seconds.' \
  "docs describe adaptive duration ceiling"
require_text \
  "$DOCS" \
  'At least three result-bound screenshots are required; they cannot replace the video.' \
  "docs describe strict screenshot and video requirements"

exit "$fail"
