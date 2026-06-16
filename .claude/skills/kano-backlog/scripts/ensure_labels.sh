#!/usr/bin/env bash
# Ensure the Kano + priority label set exists on a GitHub repo (idempotent).
# Usage: ensure_labels.sh [--repo owner/name]
# Uses `gh label create --force`, which creates the label or updates its
# color/description if it already exists — safe to run repeatedly.
set -euo pipefail

REPO_ARG=()
if [[ "${1:-}" == "--repo" && -n "${2:-}" ]]; then
  REPO_ARG=(--repo "$2")
fi

# name|color(hex,no #)|description
LABELS=(
  "kano:must-be|b60205|Kano: basic expectation — absence causes strong dissatisfaction"
  "kano:performance|fbca04|Kano: more/better linearly increases satisfaction"
  "kano:attractive|0e8a16|Kano: delighter — presence wows, absence costs nothing"
  "kano:indifferent|cccccc|Kano: no measurable effect on satisfaction"
  "kano:reverse|5319e7|Kano: some users actively dislike this if added"
  "priority:now|d93f0b|Pick up now (top of refined backlog)"
  "priority:next|fbca04|Up next after current 'now' items"
  "priority:later|0052cc|Valuable but deferred"
)

for entry in "${LABELS[@]}"; do
  IFS='|' read -r name color desc <<<"$entry"
  gh label create "$name" --color "$color" --description "$desc" --force "${REPO_ARG[@]}"
done

echo "Kano + priority labels ensured."
