#!/usr/bin/env bash
set -uo pipefail

REPO_ROOT="${PROOF_CAPTURE_KNOWLEDGE_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
COMMAND="$REPO_ROOT/packages/shared-agent-knowledge/commands/proof-capture.md"
DOCS="$REPO_ROOT/apps/docs-site/src/content/docs/commands/proof-capture.mdx"
test_tmp="$(mktemp -d)"
trap 'rm -rf "$test_tmp"' EXIT
COMMAND_STRICT="$test_tmp/command-strict.md"
DOCS_STRICT="$test_tmp/docs-strict.mdx"

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

extract_slice() {
  local file="$1"
  local start="$2"
  local end="$3"
  local output="$4"
  awk -v start="$start" -v end="$end" '
    $0 == start { found_start = 1; printing = 1 }
    printing && $0 == end { found_end = 1; exit }
    printing { print }
    END { if (!found_start || !found_end) exit 1 }
  ' "$file" >"$output"
}

forbid_regex() {
  local file="$1"
  local regex="$2"
  local description="$3"
  if node - "$file" "$regex" <<'JS'
const { readFileSync } = require('node:fs');

let text = readFileSync(process.argv[2], 'utf8').replace(/\s+/g, ' ');
const safeNegations = [
  /\b(?:do|must|should)\s+not\s+(?:warn|continue|proceed|carry on)\b/gi,
  /\bnever\s+(?:warn|continue|proceed|carry on)\b/gi,
  /\b(?:do|must|should)\s+not\s+(?:fall back|fallback|switch(?:\s+to)?|use|substitute|downgrade|replace)\b[^.!?]{0,80}?\bscreenshots?\b/gi,
  /\bnever\s+(?:fall back|fallback|switch(?:\s+to)?|use|substitute|downgrade|replace)\b[^.!?]{0,80}?\bscreenshots?\b/gi,
  /\bscreenshots?\b[^.!?]{0,30}?\b(?:cannot|can['’]?t|must not|should not|do not|never)\s+(?:replace|substitute|downgrade|serve as|become|act as)\b[^.!?]{0,50}?\bvideo\b/gi,
  /\b(?:do|must|should)\s+not\s+(?:provide|include|show|print|emit|offer|upload|drag(?:-|\s+)and(?:-|\s+)drop)\b[^.!?]{0,120}?\b(?:github|drag-and-drop|upload(?: instructions?| guidance)?)\b/gi,
  /\bnever\s+(?:provide|include|show|print|emit|offer|upload|drag(?:-|\s+)and(?:-|\s+)drop)\b[^.!?]{0,120}?\b(?:github|drag-and-drop|upload(?: instructions?| guidance)?)\b/gi,
  /\bgithub\b[^.!?]{0,80}?\b(?:do|must|should)\s+not\s+drag(?:-|\s+)and(?:-|\s+)drop\b/gi,
  /\bgithub\b[^.!?]{0,80}?\bnever\s+drag(?:-|\s+)and(?:-|\s+)drop\b/gi,
];
for (const safeNegation of safeNegations) {
  text = text.replace(safeNegation, '');
}
process.exit(new RegExp(process.argv[3], 'i').test(text) ? 1 : 0);
JS
  then
    ok "$description"
  else
    bad "$description"
  fi
}

if extract_slice \
  "$COMMAND" \
  '## Strict Machine Workflow (`--strict`)' \
  '## Interactive Compatibility' \
  "$COMMAND_STRICT"
then
  ok "command strict slice is bounded"
else
  bad "command strict slice is bounded"
fi

if extract_slice \
  "$DOCS" \
  '## Strict Mode' \
  '## Interactive Artifacts' \
  "$DOCS_STRICT"
then
  ok "docs strict slice is bounded"
else
  bad "docs strict slice is bounded"
fi

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
    "$COMMAND_STRICT" \
    "proof_capture(action=\"$action\"" \
    "strict workflow calls proof_capture $action"
done

require_text \
  "$COMMAND_STRICT" \
  'rehearsing -> rehearsed -> armed -> recording -> validating -> mechanically_accepted -> accepted' \
  "strict workflow names all seven states"
require_text \
  "$COMMAND_STRICT" \
  'Any video start, stop, path, device, media, or validation failure is a hard stop.' \
  "strict video failure is a hard stop"
require_text \
  "$COMMAND_STRICT" \
  'Strict mode never asks whether to re-record; discard the rejected capture and begin a fresh rehearsal.' \
  "strict workflow never prompts to re-record"
require_text \
  "$COMMAND_STRICT" \
  'Screenshots never downgrade or replace the required video.' \
  "strict workflow forbids screenshot-primary downgrade"
require_text \
  "$COMMAND_STRICT" \
  'Do not provide GitHub drag-and-drop or PR-upload instructions in strict mode.' \
  "strict workflow omits GitHub drag-and-drop guidance"
require_text \
  "$COMMAND_STRICT" \
  'Declare at least three storyboard steps, each with one result-bound screenshot and one passing assertion.' \
  "strict workflow requires at least three screenshots"
require_text \
  "$COMMAND_STRICT" \
  'proof-receipt.json' \
  "strict workflow writes the canonical receipt"
require_text \
  "$COMMAND_STRICT" \
  'minimum = floor(rehearsalDurationMs * 0.8)' \
  "strict workflow documents adaptive minimum duration"
require_text \
  "$COMMAND_STRICT" \
  'maximum = min(ceil(rehearsalDurationMs * 1.35 + 3000), 60000)' \
  "strict workflow documents adaptive maximum and 60-second ceiling"
require_text \
  "$COMMAND_STRICT" \
  'autoRepair=false, forceReload=false, proofReplay=true' \
  "strict rehearsal disables action repair and reload"
require_text \
  "$COMMAND_STRICT" \
  'Repair, reload, restart, reset, Dev Client dismissal, or any other debugging during recording invalidates the capture.' \
  "strict workflow invalidates debugging activity"

require_text "$COMMAND_STRICT" '- accepted receipt path' "strict result prints receipt path"
require_text "$COMMAND_STRICT" '- screenshot paths' "strict result prints screenshot paths"
require_text "$COMMAND_STRICT" '- local video path and SHA-256 hash' "strict result prints local video path and hash"
require_text "$COMMAND_STRICT" '- contact-sheet path' "strict result prints contact-sheet path"
require_text "$COMMAND_STRICT" '- action and storyboard SHA-256 hashes' "strict result prints action and storyboard hashes"
require_text "$COMMAND_STRICT" '- exact invalidation reason on failure' "strict result prints exact failure reason"

require_text \
  "$DOCS" \
  '/rn-dev-agent:proof-capture --strict <feature-slug> [description of flow to execute]' \
  "docs expose strict command usage"
require_text \
  "$DOCS_STRICT" \
  'Strict mode is fail-closed and produces `proof-receipt.json` only after mechanical validation and independent evidence review.' \
  "docs describe accepted strict receipt"
require_text \
  "$DOCS_STRICT" \
  'The duration window adapts to rehearsal time and is capped at 60 seconds.' \
  "docs describe adaptive duration ceiling"
require_text \
  "$DOCS_STRICT" \
  'At least three result-bound screenshots are required; they cannot replace the video.' \
  "docs describe strict screenshot and video requirements"

video_continue_regex='\b(?:video|recording)\b[^.!?]{0,120}\b(?:fails?|failure|unavailable|error)\b[^.!?]{0,120}\b(?:warn|continue|proceed|carry on)\b|\b(?:warn|continue|proceed|carry on)\b[^.!?]{0,120}\b(?:video|recording)\b[^.!?]{0,120}\b(?:fails?|failure|unavailable|error)\b'
screenshot_downgrade_regex='\bscreenshots?\b(?![^.!?]{0,50}\b(?:never|cannot|can.t)\b)(?![^.!?]{0,50}\b(?:must|do)\s+not\b)[^.!?]{0,100}\b(?:primary|fallback|fall back|substitute|replacement|replace (?:the )?(?:required )?video|instead of (?:the )?(?:required )?video)\b|\b(?:fallback|fall back|downgrade|continue|proceed|switch(?:\s+to)?|use|substitute)\b[^.!?]{0,80}\bscreenshots?\b(?:[^.!?]{0,50}\b(?:instead(?: of video)?|in place of video|for video)\b)?'
rerecord_prompt_regex='(?<!not )(?<!never )\b(?:ask|prompt)\b[^.!?]{0,100}\bre-?record\b|\b(?:offer|provide|show|display)\b[^.!?]{0,100}\bre-?record(?:ing)? prompt\b'
upload_guidance_regex='(?:^|[.!?]\s+|,\s+(?:and|then)\s+|\b(?:also|then)\s+)(?:provide|include|show|print|emit|offer|upload)\b[^.!?]{0,120}\b(?:github|drag-and-drop|upload(?: instructions?| guidance)?)\b|\bdrag(?:-|\s+)and(?:-|\s+)drop\b[^.!?]{0,120}\bgithub\b|\bgithub\b[^.!?]{0,120}\bdrag(?:-|\s+)and(?:-|\s+)drop\b'
timing_output_regex='(?:^|[.!?]\s+)(?:after success,\s*)?(?:also\s+)?(?:print|show|include|emit|provide)\b[^.!?]{0,160}\btim(?:e|ing) estimates?\b|\bstrict (?:result|output)\b[^.!?]{0,80}\b(?:includes?|prints?|shows?|emits?|provides?)\b[^.!?]{0,80}\btim(?:e|ing) estimates?\b'
manual_validation_output_regex='(?:^|[.!?]\s+)(?:after success,\s*)?(?:also\s+)?(?:print|show|include|emit|provide)\b[^.!?]{0,160}\bmanual visual(?:-validation)?(?: claims?)?\b|\bstrict (?:result|output)\b[^.!?]{0,80}\b(?:includes?|prints?|shows?|emits?|provides?)\b[^.!?]{0,80}\bmanual visual(?:-validation)?(?: claims?)?\b'
pr_body_output_regex='(?:^|[.!?]\s+)(?:after success,\s*)?(?:also\s+)?(?:print|show|include|emit|provide)\b[^.!?]{0,160}\bpr[- ]body(?: guidance| instructions?)?\b|\bstrict (?:result|output)\b[^.!?]{0,80}\b(?:includes?|prints?|shows?|emits?|provides?)\b[^.!?]{0,80}\bpr[- ]body(?: guidance| instructions?)?\b'

for strict_slice in "$COMMAND_STRICT" "$DOCS_STRICT"; do
  slice_name="command"
  if [ "$strict_slice" = "$DOCS_STRICT" ]; then slice_name="docs"; fi
  forbid_regex "$strict_slice" "$video_continue_regex" "$slice_name strict slice rejects video warn-and-continue"
  forbid_regex "$strict_slice" "$screenshot_downgrade_regex" "$slice_name strict slice rejects screenshot fallback or downgrade"
  forbid_regex "$strict_slice" "$rerecord_prompt_regex" "$slice_name strict slice rejects re-record prompts"
  forbid_regex "$strict_slice" "$upload_guidance_regex" "$slice_name strict slice rejects GitHub or upload guidance"
  forbid_regex "$strict_slice" "$timing_output_regex" "$slice_name strict result rejects timing output"
  forbid_regex "$strict_slice" "$manual_validation_output_regex" "$slice_name strict result rejects manual-validation output"
  forbid_regex "$strict_slice" "$pr_body_output_regex" "$slice_name strict result rejects PR-body output"
done

if [ "${PROOF_CAPTURE_KNOWLEDGE_SKIP_MUTATIONS:-0}" != "1" ]; then
  mutation_root="$test_tmp/mutations"

  mutation_rejected() {
    local target="$1"
    local marker="$2"
    local mutation="$3"
    local description="$4"
    local expected_failure="$5"
    local fixture="$mutation_root/fixture"
    local log="$mutation_root/mutation.log"

    rm -rf "$fixture"
    mkdir -p \
      "$fixture/packages/shared-agent-knowledge/commands" \
      "$fixture/apps/docs-site/src/content/docs/commands"
    cp "$COMMAND" "$fixture/packages/shared-agent-knowledge/commands/proof-capture.md"
    cp "$DOCS" "$fixture/apps/docs-site/src/content/docs/commands/proof-capture.mdx"

    if ! node - "$fixture/$target" "$marker" "$mutation" <<'JS'
const { readFileSync, writeFileSync } = require('node:fs');

const [path, marker, mutation] = process.argv.slice(2);
const text = readFileSync(path, 'utf8');
if (!text.includes(marker)) {
  throw new Error(`missing mutation marker: ${marker}`);
}
writeFileSync(path, text.replace(marker, `${mutation}\n\n${marker}`));
JS
    then
      bad "$description fixture setup"
      return
    fi

    PROOF_CAPTURE_KNOWLEDGE_ROOT="$fixture" \
      PROOF_CAPTURE_KNOWLEDGE_SKIP_MUTATIONS=1 \
      bash "$0" >"$log" 2>&1
    local mutation_status=$?
    if [ "$mutation_status" -ne 0 ] && grep -Fq "FAIL: $expected_failure" "$log"; then
      ok "$description"
    else
      bad "$description"
    fi
  }

  mutation_accepted() {
    local target="$1"
    local marker="$2"
    local mutation="$3"
    local description="$4"
    local fixture="$mutation_root/safe-fixture"
    local log="$mutation_root/safe-mutation.log"

    rm -rf "$fixture"
    mkdir -p \
      "$fixture/packages/shared-agent-knowledge/commands" \
      "$fixture/apps/docs-site/src/content/docs/commands"
    cp "$COMMAND" "$fixture/packages/shared-agent-knowledge/commands/proof-capture.md"
    cp "$DOCS" "$fixture/apps/docs-site/src/content/docs/commands/proof-capture.mdx"

    if ! node - "$fixture/$target" "$marker" "$mutation" <<'JS'
const { readFileSync, writeFileSync } = require('node:fs');

const [path, marker, mutation] = process.argv.slice(2);
const text = readFileSync(path, 'utf8');
if (!text.includes(marker)) {
  throw new Error(`missing mutation marker: ${marker}`);
}
writeFileSync(path, text.replace(marker, `${mutation}\n\n${marker}`));
JS
    then
      bad "$description fixture setup"
      return
    fi

    PROOF_CAPTURE_KNOWLEDGE_ROOT="$fixture" \
      PROOF_CAPTURE_KNOWLEDGE_SKIP_MUTATIONS=1 \
      bash "$0" >"$log" 2>&1
    local mutation_status=$?
    if [ "$mutation_status" -eq 0 ] && ! grep -q '^FAIL:' "$log"; then
      ok "$description"
    else
      bad "$description"
    fi
  }

  mutation_rejected \
    'packages/shared-agent-knowledge/commands/proof-capture.md' \
    '## Interactive Compatibility' \
    'If video capture fails, warn and continue.' \
    'mutation rejects video warn-and-continue' \
    'command strict slice rejects video warn-and-continue'
  mutation_rejected \
    'packages/shared-agent-knowledge/commands/proof-capture.md' \
    '## Interactive Compatibility' \
    'Use screenshots as the primary artifact when video is unavailable.' \
    'mutation rejects screenshot-primary downgrade' \
    'command strict slice rejects screenshot fallback or downgrade'
  mutation_rejected \
    'packages/shared-agent-knowledge/commands/proof-capture.md' \
    '## Interactive Compatibility' \
    'Fall back to screenshots when video fails.' \
    'mutation rejects screenshot fallback' \
    'command strict slice rejects screenshot fallback or downgrade'
  mutation_rejected \
    'packages/shared-agent-knowledge/commands/proof-capture.md' \
    '## Interactive Compatibility' \
    'Downgrade to screenshots after a recording error.' \
    'mutation rejects explicit screenshot downgrade' \
    'command strict slice rejects screenshot fallback or downgrade'
  mutation_rejected \
    'packages/shared-agent-knowledge/commands/proof-capture.md' \
    '## Interactive Compatibility' \
    'Ask the user whether to re-record.' \
    'mutation rejects re-record prompt' \
    'command strict slice rejects re-record prompts'
  mutation_rejected \
    'packages/shared-agent-knowledge/commands/proof-capture.md' \
    '## Interactive Compatibility' \
    'Provide GitHub drag-and-drop instructions.' \
    'mutation rejects GitHub drag-and-drop guidance' \
    'command strict slice rejects GitHub or upload guidance'
  mutation_rejected \
    'apps/docs-site/src/content/docs/commands/proof-capture.mdx' \
    '## Interactive Artifacts' \
    'Offer upload guidance for the rejected strict capture.' \
    'mutation rejects upload guidance' \
    'docs strict slice rejects GitHub or upload guidance'
  mutation_rejected \
    'packages/shared-agent-knowledge/commands/proof-capture.md' \
    '## Interactive Compatibility' \
    'Also print timing estimates in the strict result.' \
    'mutation rejects timing output' \
    'command strict result rejects timing output'
  mutation_rejected \
    'apps/docs-site/src/content/docs/commands/proof-capture.mdx' \
    '## Interactive Artifacts' \
    'Also print manual visual-validation claims in the strict output.' \
    'mutation rejects manual-validation output' \
    'docs strict result rejects manual-validation output'
  mutation_rejected \
    'packages/shared-agent-knowledge/commands/proof-capture.md' \
    '## Interactive Compatibility' \
    'Also print PR-body guidance in the strict result.' \
    'mutation rejects PR-body output' \
    'command strict result rejects PR-body output'
  mutation_rejected \
    'packages/shared-agent-knowledge/commands/proof-capture.md' \
    '## Interactive Compatibility' \
    'When recording fails, switch to screenshots instead.' \
    'mutation rejects switch-to-screenshots alternate' \
    'command strict slice rejects screenshot fallback or downgrade'
  mutation_rejected \
    'packages/shared-agent-knowledge/commands/proof-capture.md' \
    '## Interactive Compatibility' \
    'Use screenshots instead of video.' \
    'mutation rejects use-screenshots-instead alternate' \
    'command strict slice rejects screenshot fallback or downgrade'
  mutation_rejected \
    'apps/docs-site/src/content/docs/commands/proof-capture.mdx' \
    '## Interactive Artifacts' \
    'Substitute screenshots for video.' \
    'mutation rejects substitute-screenshots-for-video alternate' \
    'docs strict slice rejects screenshot fallback or downgrade'
  mutation_rejected \
    'packages/shared-agent-knowledge/commands/proof-capture.md' \
    '## Interactive Compatibility' \
    'Drag and drop the video into GitHub.' \
    'mutation rejects direct drag-and-drop alternate' \
    'command strict slice rejects GitHub or upload guidance'
  mutation_rejected \
    'apps/docs-site/src/content/docs/commands/proof-capture.mdx' \
    '## Interactive Artifacts' \
    'In GitHub, drag and drop the video.' \
    'mutation rejects GitHub-first drag-and-drop alternate' \
    'docs strict slice rejects GitHub or upload guidance'

  mutation_accepted \
    'packages/shared-agent-knowledge/commands/proof-capture.md' \
    '## Interactive Compatibility' \
    'If video recording fails, do not continue.' \
    'safe fixture accepts do-not-continue negation'
  mutation_accepted \
    'apps/docs-site/src/content/docs/commands/proof-capture.mdx' \
    '## Interactive Artifacts' \
    'If video recording fails, never proceed.' \
    'safe fixture accepts never-proceed negation'
  mutation_accepted \
    'packages/shared-agent-knowledge/commands/proof-capture.md' \
    '## Interactive Compatibility' \
    'Do not fall back to screenshots.' \
    'safe fixture accepts do-not-fall-back negation'
  mutation_accepted \
    'apps/docs-site/src/content/docs/commands/proof-capture.mdx' \
    '## Interactive Artifacts' \
    'Screenshots cannot replace video.' \
    'safe fixture accepts screenshots-cannot-replace negation'
fi

exit "$fail"
