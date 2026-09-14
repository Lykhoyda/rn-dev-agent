#!/usr/bin/env bash
# check-typescript-only.sh — CI guard: all NEW code must be TypeScript.
#
# Repo rule (AGENTS.md > Engineering rules): no new .js/.mjs/.cjs source may
# be added. The 300+ pre-existing JavaScript files (mostly node:test suites
# that import compiled dist/) are grandfathered in scripts/js-migration-baseline.txt
# and tracked for migration; anything not in that baseline fails this check.
#
# Excluded from the rule (generated or vendored, never hand-written):
#   packages/rn-dev-agent-core/dist/ — tsc output (gitignored; generated)
#   packages/claude-plugin/rn-dev-agent-core/dist/ — the one bundled plugin runtime
#   packages/claude-plugin/scripts/ — generated copies of repo scripts
#     (single writer: scripts/build-host-runtimes.ts)
#   packages/codex-plugin/bin/cdp-supervisor.js — Codex launcher source; must be
#     plain .js so `node <file>` works before the runtime support check
#   packages/claude-plugin/bin/ — generated launcher copy and esbuild health
#     output owned by build-host-runtimes.ts (source: packages/codex-plugin)
#   **/web-dist/               — vite bundle output
#   .yarn/releases/            — pinned Yarn binary selected by yarnPath
#   third_party/               — vendored upstream
#   node_modules               — never tracked anyway
#
# Shrinking the baseline (migrating a file to TS) is always allowed; growing
# it requires editing the baseline in the same PR — a visible, reviewable act.
#
# Test seams (scripts/test/check-typescript-only.test.sh):
#   REPO_ROOT      where to scan (default: repo root)
#   BASELINE_FILE  override baseline path
set -uo pipefail

ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
BASELINE="${BASELINE_FILE:-$ROOT/scripts/js-migration-baseline.txt}"

if [ ! -f "$BASELINE" ]; then
  echo "ERROR: baseline missing: $BASELINE"
  exit 1
fi

current="$(git -C "$ROOT" ls-files '*.js' '*.mjs' '*.cjs' |
  grep -v -E '^packages/rn-dev-agent-core/dist/|^packages/claude-plugin/rn-dev-agent-core/dist/|^packages/claude-plugin/scripts/|^packages/codex-plugin/bin/cdp-supervisor\.js$|^packages/claude-plugin/bin/(cdp-supervisor|plugin-health)\.js$|/web-dist/|^\.yarn/releases/|^third_party/|(^|/)node_modules/' || true)"

violations="$(comm -23 <(printf '%s\n' "$current" | sort) <(sort "$BASELINE"))"

if [ -n "$violations" ]; then
  echo "ERROR: new JavaScript files detected — this repo is TypeScript-only for new code."
  echo "Write these as .ts (tests run via node --test with type stripping on Node >= 24),"
  echo "or if this is a deliberate exception, add them to scripts/js-migration-baseline.txt"
  echo "in this PR with a justification in the PR description:"
  printf '  %s\n' $violations
  exit 1
fi

echo "typescript-only: ok ($(printf '%s\n' "$current" | grep -c . ) grandfathered JS files remain — see scripts/js-migration-baseline.txt)"
