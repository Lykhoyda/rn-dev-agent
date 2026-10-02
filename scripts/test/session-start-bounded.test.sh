#!/usr/bin/env bash
# The SessionStart hook runs ensure-qaren.sh --print-bin: it never touches the
# network, never changes an installed runtime, always exits 0 and returns
# within 2 s, printing either the verified binary or the exact install command.
#
# Run: bash scripts/test/session-start-bounded.test.sh

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="$ROOT/packages/qaren-plugin/scripts/ensure-qaren.sh"
VERSION=9.8.7
SHA=$(printf 'a%.0s' $(seq 64))

fail=0
check() {
  if [ "$2" = "$3" ]; then
    echo "ok: $1"
  else
    echo "FAIL: $1 — expected '$2', got '$3'"
    fail=1
  fi
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

mkdir -p "$tmp/plugin/scripts" "$tmp/bin" "$tmp/home"
cp "$SCRIPT" "$tmp/plugin/scripts/ensure-qaren.sh"
printf '#!/bin/sh\ncase "$1" in -s) echo "${FAKE_OS:-Darwin}" ;; -m) echo arm64 ;; esac\n' > "$tmp/bin/uname"
printf '#!/bin/sh\necho "network touched" >> "%s/network"\nexit 7\n' "$tmp" > "$tmp/bin/curl"
chmod +x "$tmp/bin/uname" "$tmp/bin/curl"
# Only the tools the hook may use; curl is a tripwire, not a real client.
for tool in bash cat cut dirname node shasum tr wc; do
  ln -sf "$(command -v "$tool")" "$tmp/bin/$tool"
done

write_manifest() {
  printf '{"version":"%s","assets":{"ios":[],"android":[],"qaren":{"darwin-arm64":{"name":"qaren-%s-darwin-arm64.tar.gz","sha256":"%s","bytes":1234}}}}\n' \
    "$VERSION" "$VERSION" "$SHA" > "$tmp/plugin/runner-manifest.json"
}

now_ms() { node -p 'Date.now()'; }

contains() { case "$1" in *"$2"*) echo yes ;; *) echo "no: $1" ;; esac; }

# hook [PATH]: runs --print-bin like the SessionStart hook; sets out, rc, ms.
hook() {
  local start
  start=$(now_ms)
  out=$(HOME="$tmp/home" PATH="${1:-$tmp/bin}" "$tmp/bin/bash" "$tmp/plugin/scripts/ensure-qaren.sh" --print-bin 2>&1)
  rc=$?
  ms=$(( $(now_ms) - start ))
}

bounded() {
  check "$1: exits 0" 0 "$rc"
  check "$1: within 2 s" yes "$([ "$ms" -lt 2000 ] && echo yes || echo "no (${ms} ms)")"
}

DEST="$tmp/home/.qaren/runtime/$VERSION"

write_manifest
hook
bounded "missing runtime"
check "missing runtime: prints the install command" yes "$(contains "$out" "ensure-qaren.sh' --install")"

hook "$(dirname "$(command -v node)"):$tmp/no-such-dir"
bounded "no curl on PATH"

mkdir -p "$DEST/bin"
printf '#!/bin/sh\n' > "$DEST/bin/qaren"
chmod +x "$DEST/bin/qaren"
printf '%s\n' "$(printf 'b%.0s' $(seq 64))" > "$DEST/.tarball-sha256"
snapshot() { (cd "$DEST" && find . -print0 | sort -z | xargs -0 ls -ld; cat .tarball-sha256 bin/qaren) 2>&1; }
before=$(snapshot)
hook
bounded "mismatched runtime"
check "mismatched runtime: prints the install command" yes "$(contains "$out" "--install")"
check "mismatched runtime stays byte-identical" "$before" "$(snapshot)"

printf '%s\n' "$SHA" > "$DEST/.tarball-sha256"
hook
bounded "verified runtime"
check "verified runtime: prints the binary" "$DEST/bin/qaren" "$out"

printf '{"version":"%s","assets":{"ios":[],"android":[]}}\n' "$VERSION" > "$tmp/plugin/runner-manifest.json"
hook
bounded "no qaren asset"
check "no qaren asset: says so" yes "$(contains "$out" "no darwin-arm64 tarball")"

rm -f "$tmp/plugin/runner-manifest.json"
hook
bounded "no manifest"

write_manifest
FAKE_OS=Linux hook
bounded "not macOS"
check "not macOS: says so" yes "$(contains "$out" "macOS runtime only")"

rm "$tmp/bin/node"
hook
bounded "no node on PATH"
check "no node: names the prerequisite" yes "$(contains "$out" "Node 24")"

check "the network was never touched" no "$([ -e "$tmp/network" ] && echo yes || echo no)"

exit "$fail"
