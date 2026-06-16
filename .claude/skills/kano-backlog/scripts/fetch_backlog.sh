#!/usr/bin/env bash
# Fetch open backlog issues as JSON for Kano analysis.
# Usage: fetch_backlog.sh [--repo owner/name] [--limit N] [--label LABEL] [--search QUERY]
# Emits a JSON array on stdout with the fields the skill needs. Reaction counts
# arrive under reactionGroups; comment count under `comments`. Pull requests are
# excluded automatically by `gh issue list`.
set -euo pipefail

REPO_ARG=()
LIMIT=100
EXTRA=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)   REPO_ARG=(--repo "$2"); shift 2 ;;
    --limit)  LIMIT="$2"; shift 2 ;;
    --label)  EXTRA+=(--label "$2"); shift 2 ;;
    --search) EXTRA+=(--search "$2"); shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

gh issue list \
  "${REPO_ARG[@]}" \
  --state open \
  --limit "$LIMIT" \
  "${EXTRA[@]}" \
  --json number,title,body,labels,createdAt,updatedAt,comments,reactionGroups,assignees,milestone
