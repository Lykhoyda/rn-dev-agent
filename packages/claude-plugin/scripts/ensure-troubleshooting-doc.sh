#!/usr/bin/env bash
# ensure-troubleshooting-doc.sh — scaffold the repo-local troubleshooting memory.
# Idempotent; fail-open (never blocks SessionStart). Replaces ensure-experience-engine.sh.
set -uo pipefail

REPO_ROOT="${1:-$PWD}"
LOCAL_DIR="$REPO_ROOT/.rn-agent/local"
DOC="$LOCAL_DIR/troubleshooting.md"
RN_GITIGNORE="$REPO_ROOT/.rn-agent/.gitignore"

mkdir -p "$LOCAL_DIR" 2>/dev/null || exit 0

# Self-contained ignore: ensure .rn-agent/.gitignore covers local/ (no project-root pollution).
if [ -f "$RN_GITIGNORE" ]; then
  grep -qxF 'local/' "$RN_GITIGNORE" 2>/dev/null || printf '\nlocal/\n' >> "$RN_GITIGNORE"
else
  printf '# rn-dev-agent local memory — per-developer, never committed\nlocal/\n' > "$RN_GITIGNORE"
fi

# Scaffold the doc with the two canonical sections if absent.
if [ ! -f "$DOC" ]; then
  cat > "$DOC" <<EOF
# rn-dev-agent — local notes for this repo   (auto-maintained, gitignored)

## Configuration & How-To
<!-- Repo-specific facts the agent needs: Metro start dir, store exposure, testID conventions, auth/deeplink, build quirks. -->

## Troubleshooting
<!-- Failure→resolution gotchas, newest first. Each: ### <symptom>, then Cause / Fix / last seen. -->
EOF
fi

exit 0
