#!/usr/bin/env bash
# Four-branch exit contract for scripts/ensure-ffmpeg.sh.
# An optional first argument selects another packaged copy of the helper.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="${1:-$SCRIPT_DIR/ensure-ffmpeg.sh}"
LABEL="${2:-source}"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/ensure-ffmpeg.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

make_stub() {
  local directory="$1"
  local name="$2"
  local body="$3"
  printf '#!/bin/sh\n%s\n' "$body" > "$directory/$name"
  chmod +x "$directory/$name"
}

run_case() {
  local name="$1"
  local expected_status="$2"
  local ffmpeg_body="$3"
  local brew_body="$4"
  local expect_skip="$5"
  local stubs="$TMP/$name/stubs"
  local stdout="$TMP/$name/stdout"
  local stderr="$TMP/$name/stderr"
  local actual_status

  mkdir -p "$stubs"
  # The isolated PATH masks any host ffmpeg/Homebrew while retaining only the
  # head utility needed by the pre-installed branch.
  make_stub "$stubs" head 'exec /usr/bin/head "$@"'
  if [ -n "$ffmpeg_body" ]; then
    make_stub "$stubs" ffmpeg "$ffmpeg_body"
  fi
  if [ -n "$brew_body" ]; then
    make_stub "$stubs" brew "$brew_body"
  fi

  env PATH="$stubs" /bin/bash "$SCRIPT" >"$stdout" 2>"$stderr"
  actual_status=$?

  [ "$actual_status" -eq "$expected_status" ] ||
    fail "$name: expected exit $expected_status, got $actual_status; stderr: $(cat "$stderr")"

  if [ "$expect_skip" = true ]; then
    grep -Fq "GIF conversion will be skipped" "$stderr" ||
      fail "$name: missing skip-GIF guidance on stderr"
  elif grep -Fq "GIF conversion will be skipped" "$stderr"; then
    fail "$name: unexpected skip-GIF guidance"
  fi

  CASE_RECEIPTS="${CASE_RECEIPTS}${CASE_RECEIPTS:+,}{\"case\":\"$name\",\"expectedExit\":$expected_status,\"actualExit\":$actual_status}"
}

[ -f "$SCRIPT" ] || fail "helper not found: $SCRIPT"

CASE_RECEIPTS=""
run_case "pre-installed" 0 'echo "ffmpeg version test"; exit 0' '' false
run_case "homebrew-install-success" 0 '' '[ "$1" = install ] && [ "$2" = ffmpeg ]; exit $?' false
run_case "homebrew-install-failure" 1 '' 'exit 42' true
run_case "homebrew-absent" 1 '' '' true

printf '{"status":"passed","helper":"%s","cases":[%s]}\n' "$LABEL" "$CASE_RECEIPTS"
