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

# A changeset exists — but cdp-bridge ships to users ONLY via the plugin manifest
# (plugin.json / marketplace.json), which is versioned by the synthetic
# `rn-dev-agent-plugin` package. A changeset that bumps only `rn-dev-agent-cdp`
# (the internal package) advances the bundled dist but leaves the manifest pinned,
# so `/plugin update` never delivers the change to installs (#361/#363 delivery
# gap). Require a `rn-dev-agent-plugin` entry so the manifest bumps and ships.
#
# Parse ONLY the frontmatter package keys (the lines strictly between the first
# and second `---`), not the whole file — otherwise a cdp-only changeset whose
# release-note body merely mentions `"rn-dev-agent-plugin"` would falsely pass
# (Codex PR #364 P1). Same frontmatter extraction as validate-changeset-names.sh.
plugin_changeset=""
while IFS= read -r file; do
  [ -n "$file" ] || continue
  frontmatter="$(awk '$0 ~ /^---[[:space:]]*$/ { d++; next } d==1 { print }' "$file")"
  if printf '%s\n' "$frontmatter" | grep -Eq "^[[:space:]]*[\"']?rn-dev-agent-plugin[\"']?[[:space:]]*:"; then
    plugin_changeset="$file"
    break
  fi
done < <(printf '%s\n' "$changesets")

if [ -z "$plugin_changeset" ]; then
  echo "ERROR: this PR changes shippable source but no changeset bumps rn-dev-agent-plugin:" >&2
  printf '%s\n' "$src_changed" | sed 's/^/  /' >&2
  cat >&2 <<'MSG'

A `rn-dev-agent-cdp`-only changeset bumps the internal package but NOT the plugin
manifest (plugin.json / marketplace.json) — so the change ships to main but never
reaches marketplace installs via `/plugin update` (#361/#363 post-mortem: the
cdp-bridge advanced through 0.48→0.49 while the plugin stayed pinned at 0.55.5).

Fix: add a `rn-dev-agent-plugin` entry to a changeset (typically alongside the
`rn-dev-agent-cdp` bump), e.g.:

  ---
  "rn-dev-agent-cdp": patch
  "rn-dev-agent-plugin": patch
  ---
MSG
  exit 1
fi

echo "require-changeset: shippable src changed AND a rn-dev-agent-plugin changeset is present — OK."
printf '%s\n' "$changesets" | sed 's/^/  /'
exit 0
