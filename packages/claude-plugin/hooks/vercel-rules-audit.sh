#!/bin/bash
# vercel-rules-audit.sh — PostToolUse hook for Edit/Write/MultiEdit.
# Runs the Vercel rule checker against the just-edited file and injects
# violations into Claude's context via additionalContext.
#
# Skips silently when:
#   - tool_input.file_path is missing (not a file edit)
#   - file extension is not .tsx/.jsx/.ts/.js
#   - file is a .d.ts, test, spec, or config
#   - file is not inside an RN project (no react-native dep in nearest package.json)
#
# Output:
#   - On violations: JSON envelope with hookSpecificOutput.additionalContext
#     (PostToolUse hooks must use this format; plain stdout goes to debug
#     log only, not to LLM context)
#   - On no violations: silent exit 0
#
# Cap: ~1.5 KB to additionalContext (well under the 10 KB hook output limit).

set -uo pipefail

input=$(cat)
file_path=$(echo "$input" | jq -r '.tool_input.file_path // ""' 2>/dev/null || echo "")

if [[ -z "$file_path" ]]; then
  exit 0
fi

# File-extension filter
if [[ ! "$file_path" =~ \.(tsx?|jsx?)$ ]]; then
  exit 0
fi
if [[ "$file_path" =~ \.d\.ts$ ]]; then
  exit 0
fi
if [[ "$file_path" =~ (__tests__|\.test\.|\.spec\.|\.config\.) ]]; then
  exit 0
fi

# RN-project guard: walk up from the file looking for a package.json that
# declares "react-native" as a dependency key. Saves cycles and prevents
# false positives in non-RN repos.
is_rn_project=false
check_dir=$(dirname "$file_path")
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if [[ -f "$check_dir/package.json" ]]; then
    if grep -qE '"react-native"[[:space:]]*:' "$check_dir/package.json" 2>/dev/null; then
      is_rn_project=true
    fi
    break
  fi
  [[ "$check_dir" == "/" || -z "$check_dir" ]] && break
  check_dir="${check_dir%/*}"
  [[ -z "$check_dir" ]] && check_dir="/"
done

if [[ "$is_rn_project" != "true" ]]; then
  exit 0
fi

# Resolve plugin root (the same way detect-rn-project.sh does).
PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Package-local checker ships with the plugin (build-host-runtimes.ts);
# repo scripts/ is the dev-checkout fallback.
checker="$PLUGIN_ROOT/scripts/check-vercel-rules.mjs"
if [[ ! -f "$checker" ]]; then
  checker="$PLUGIN_ROOT/../../scripts/check-vercel-rules.mjs"
fi

if [[ ! -f "$checker" ]]; then
  exit 0  # Sync not run yet — silent skip
fi

# Run checker on the edited file. Baseline path is project-relative; we
# look for it under the project root the same way we found the package.json.
baseline_path="$check_dir/.rn-agent/vercel-rules-baseline.json"
if [[ -f "$baseline_path" ]]; then
  audit_output=$(node "$checker" --changed --baseline "$baseline_path" --format hook -- "$file_path" 2>/dev/null)
else
  audit_output=$(node "$checker" --changed --format hook -- "$file_path" 2>/dev/null)
fi

if [[ -z "$audit_output" ]]; then
  exit 0  # No violations — silent
fi

# Trim to ~1.5 KB to stay under hook output limits with safe margin.
# (The 10 KB cap is on the JSON envelope; the inner additionalContext
# can use most of that, but tighter caps reduce noise.)
audit_output=$(echo "$audit_output" | head -c 1500)

# Emit PostToolUse JSON envelope. Plain stdout would be sent to the debug
# log only — Claude needs hookSpecificOutput to surface in context.
jq -n \
  --arg ctx "$audit_output" \
  '{hookSpecificOutput: {hookEventName: "PostToolUse", additionalContext: $ctx}}' \
  2>/dev/null

exit 0
