#!/usr/bin/env bash
# CI guard (GH #189 / v0.44.45 post-mortem): a PR that changes shippable MCP
# source MUST include a changeset, so the change earns a version bump + release.
# Without this, behavior fixes merge to main unversioned and never reach
# marketplace installs — #188 shipped the runFlow fix with no bump, so users
# never got it and it was re-reported as #189. Runs on pull_request; see
# .github/workflows/ci.yml.
#
# Test seams (scripts/test/require-changeset.test.sh):
#   CHANGED_FILES  newline-separated changed paths (overrides git diff)
#   REPO_ROOT      where to look for .changeset/ (default: repo root)
#   BASE_REF       git diff base when CHANGED_FILES is unset (default origin/main)
set -uo pipefail

ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
BASE_REF="${BASE_REF:-origin/main}"
# Shippable MCP source. Tests, docs, CI, and the .claude-plugin manifest (which
# IS the changeset output) are intentionally excluded.
WATCHED='^scripts/cdp-bridge/src/'

if [ -n "${CHANGED_FILES+x}" ]; then
  changed="$CHANGED_FILES"
else
  changed="$(git -C "$ROOT" diff --name-only "${BASE_REF}...HEAD")"
fi

src_changed="$(printf '%s\n' "$changed" | grep -E "$WATCHED" || true)"

if [ -z "$src_changed" ]; then
  echo "require-changeset: no shippable src changes — changeset not required."
  exit 0
fi

changesets="$(find "$ROOT/.changeset" -maxdepth 1 -type f -name '*.md' ! -name 'README.md' 2>/dev/null || true)"

if [ -z "$changesets" ]; then
  echo "ERROR: this PR changes shippable source but has NO changeset:" >&2
  printf '%s\n' "$src_changed" | sed 's/^/  /' >&2
  cat >&2 <<'MSG'

A behavior change without a changeset ships to main unversioned and is
undeliverable to marketplace installs (GH #189 / v0.44.45 post-mortem).

Fix: run `npx changeset`, describe the change, and commit the generated
.changeset/*.md file. Docs / test / CI-only PRs do not need one.
MSG
  exit 1
fi

echo "require-changeset: shippable src changed AND a changeset is present — OK."
printf '%s\n' "$changesets" | sed 's/^/  /'
exit 0
