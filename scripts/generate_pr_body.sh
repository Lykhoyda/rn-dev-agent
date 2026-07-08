#!/usr/bin/env bash
set -euo pipefail

PROOF_DIR="${1:-}"
BASE_BRANCH="${2:-main}"

if [[ -z "$PROOF_DIR" ]]; then
  echo "Usage: generate_pr_body.sh <proof-dir> [base-branch]" >&2
  exit 1
fi

if [[ ! -f "$PROOF_DIR/PROOF.md" ]]; then
  echo "Error: PROOF.md not found in $PROOF_DIR" >&2
  exit 1
fi

OUTPUT="$PROOF_DIR/PR-BODY.md"

title="$(grep -m1 '^# ' "$PROOF_DIR/PROOF.md" | sed 's/^# //')"
[[ -z "$title" ]] && title="Feature Implementation"

summary=""
in_summary=false
while IFS= read -r line; do
  if [[ "$in_summary" == "false" && "$line" =~ ^#\  ]]; then
    in_summary=true
    continue
  fi
  if [[ "$in_summary" == "true" ]]; then
    [[ "$line" =~ ^## ]] && break
    [[ "$line" =~ ^\*\* ]] && continue
    [[ -n "$line" ]] && summary+="$line "
  fi
done < "$PROOF_DIR/PROOF.md"
summary="$(echo "$summary" | sed 's/ $//')"

get_device_info() {
  local info=""
  if xcrun simctl list devices booted -j 2>/dev/null | python3 -c "
import json,sys
data = json.load(sys.stdin)
for runtime, devices in data.get('devices',{}).items():
  for d in devices:
    if d.get('state') == 'Booted':
      rt = runtime.split('.')[-1] if '.' in runtime else runtime
      print(f\"{d['name']}|{rt}\")
      sys.exit(0)
" 2>/dev/null; then
    :
  fi

  if adb devices 2>/dev/null | grep -q "device$"; then
    local model
    model="$(adb shell getprop ro.product.model 2>/dev/null || echo 'Unknown')"
    local version
    version="$(adb shell getprop ro.build.version.release 2>/dev/null || echo 'Unknown')"
    echo "${model}|Android ${version}"
  fi
}

device_lines="$(get_device_info)"

screenshots=()
while IFS= read -r -d '' f; do
  screenshots+=("$(basename "$f")")
done < <(find "$PROOF_DIR" -maxdepth 1 \( -name "*.jpg" -o -name "*.jpeg" -o -name "*.png" \) -print0 2>/dev/null | sort -z)

videos=()
while IFS= read -r -d '' f; do
  videos+=("$(basename "$f")")
done < <(find "$PROOF_DIR" -maxdepth 1 \( -name "*.mov" -o -name "*.mp4" -o -name "*.gif" \) -print0 2>/dev/null | sort -z)

diff_stat=""
if git rev-parse --git-dir >/dev/null 2>&1; then
  diff_stat="$(git diff --stat "${BASE_BRANCH}...HEAD" 2>/dev/null || echo '(no diff available)')"
fi

{
  echo "## Summary"
  echo ""
  if [[ -n "$summary" ]]; then
    echo "$summary"
  else
    echo "$title"
  fi
  echo ""

  if [[ ${#screenshots[@]} -gt 0 ]]; then
    echo "### Screenshots"
    echo ""
    for s in "${screenshots[@]}"; do
      _desc="$(echo "$s" | sed 's/\.[^.]*$//' | tr '-' ' ' | tr '_' ' ' | tr '|' ' ')"
      echo "| $_desc |"
    done | (echo "| Preview |"; echo "|---------|"; cat)
    echo ""
    for s in "${screenshots[@]}"; do
      _desc="$(echo "$s" | sed 's/\.[^.]*$//' | tr '-' ' ' | tr '_' ' ' | tr '|' ' ')"
      echo "<details><summary>$_desc</summary>"
      echo ""
      echo "![$_desc]($s)"
      echo ""
      echo "</details>"
      echo ""
    done
  fi

  if [[ ${#videos[@]} -gt 0 ]]; then
    echo "### Demo Video"
    echo ""
    for v in "${videos[@]}"; do
      if [[ "$v" == *.gif ]]; then
        echo "![Demo]($v)"
      else
        echo "<!-- Drag $v here to upload the demo video -->"
        echo "_Video: \`$v\` — upload via GitHub drag-and-drop_"
      fi
      echo ""
    done
  fi

  if [[ -n "$device_lines" ]]; then
    echo "### Device Info"
    echo ""
    echo "| Property | Value |"
    echo "|----------|-------|"
    while IFS= read -r line; do
      [[ -z "$line" ]] && continue
      _name="${line%%|*}"
      _runtime="${line#*|}"
      echo "| Device | $_name |"
      echo "| OS | $_runtime |"
    done <<< "$device_lines"
    echo ""
  fi

  if [[ -n "$diff_stat" ]]; then
    echo "### Files Changed"
    echo ""
    echo '```'
    echo "$diff_stat"
    echo '```'
    echo ""
  fi

  echo "### Verification"
  echo ""
  echo "E2E proof captured with rn-dev-agent. See [PROOF.md](PROOF.md) for the full verification flow."
  echo ""
  echo "---"
  echo "_Generated with [rn-dev-agent](https://github.com/Lykhoyda/rn-dev-agent)_"
} > "$OUTPUT"

echo "PR body generated: $OUTPUT"
