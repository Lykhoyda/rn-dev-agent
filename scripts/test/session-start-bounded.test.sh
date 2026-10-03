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
cleanup() {
  local pidfile
  for pidfile in "$tmp/slow-root.pid" "$tmp/slow-perl.pid" "$tmp/slow-node.pid"; do
    [ ! -s "$pidfile" ] || kill -KILL "$(cat "$pidfile")" 2>/dev/null || true
  done
  rm -rf "$tmp"
}
trap cleanup EXIT

mkdir -p "$tmp/plugin/scripts" "$tmp/bin" "$tmp/home"
cp "$SCRIPT" "$tmp/plugin/scripts/ensure-qaren.sh"
printf '#!/bin/sh\ncase "$1" in -s) echo "${FAKE_OS:-Darwin}" ;; -m) echo arm64 ;; esac\n' > "$tmp/bin/uname"
printf '#!/bin/sh\necho "network touched" >> "%s/network"\nexit 7\n' "$tmp" > "$tmp/bin/curl"
chmod +x "$tmp/bin/uname" "$tmp/bin/curl"
# The installer's required tools plus node; curl is a tripwire, not a real client.
for tool in bash cat cut dirname du find gzip head ls mkdir mktemp mv node cp perl rm shasum sleep tar tr wc; do
  ln -sf "$(command -v "$tool")" "$tmp/bin/$tool"
done
# The same toolbox without even the curl tripwire.
cp -R "$tmp/bin" "$tmp/bin-no-curl"
rm "$tmp/bin-no-curl/curl"

write_manifest() {
  printf '{"version":"%s","assets":{"ios":[],"android":[],"qaren":{"darwin-arm64":{"name":"qaren-%s-darwin-arm64.tar.gz","sha256":"%s","bytes":1234}}}}\n' \
    "$VERSION" "$VERSION" "$SHA" > "$tmp/plugin/runner-manifest.json"
}

PERL=$(command -v perl)
NODE=$(command -v node)
now_ms() { "$PERL" -MTime::HiRes=time -e 'printf "%.0f\n", time() * 1000'; }

contains() { case "$1" in *"$2"*) echo yes ;; *) echo "no: $1" ;; esac; }

# hook [PATH]: runs --print-bin like the SessionStart hook; sets out, rc, ms.
# perl's alarm kills a hook that hangs, so a regression fails instead of stalling the suite.
hook() {
  local start
  start=$(now_ms)
  out=$(HOME="$tmp/home" PATH="${1:-$tmp/bin}" "$PERL" -e 'alarm 5; exec @ARGV' \
    "$tmp/bin/bash" "$tmp/plugin/scripts/ensure-qaren.sh" --print-bin 2>&1)
  rc=$?
  ms=$(( $(now_ms) - start ))
}

bounded() {
  check "$1: exits 0" 0 "$rc"
  check "$1: within 2 s" yes "$([ "$ms" -lt 2000 ] && echo yes || echo "no (${ms} ms)")"
}

DEST="$tmp/home/.qaren/runtime/$VERSION"
# The installer resolves the runtime root to its real path (/var is /private/var on macOS).
REAL_DEST="$(cd -P "$tmp" && pwd -P)/home/.qaren/runtime/$VERSION"

write_manifest
hook
bounded "missing runtime"
check "missing runtime: prints the install command" yes "$(contains "$out" "ensure-qaren.sh --install")"

cp -R "$ROOT/packages/qaren-plugin" "$tmp/plugin with space"
cp "$tmp/plugin/runner-manifest.json" "$tmp/plugin with space/runner-manifest.json"
hook_command=$("$NODE" -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).hooks.SessionStart[0].hooks[0].command' "$tmp/plugin with space/hooks/hooks.json")
start=$(now_ms)
out=$(HOME="$tmp/home" PATH="$tmp/bin" CLAUDE_PLUGIN_ROOT="$tmp/plugin with space" \
  "$PERL" -e 'alarm 5; exec @ARGV' /bin/sh -c "$hook_command" 2>&1)
rc=$?
ms=$(( $(now_ms) - start ))
bounded "hook command with a space in the plugin path"
check "hook command with a space: prints the exact install command" \
  "qaren v$VERSION is not installed. Install it with: bash $(printf %q "$tmp/plugin with space/scripts/ensure-qaren.sh") --install" "$out"

hook "$tmp/bin-no-curl"
bounded "no curl on PATH"
check "no curl on PATH: prints the install command" yes "$(contains "$out" "ensure-qaren.sh --install")"

# A runtime moved aside by a killed replacement is reported as repairable, read-only.
mkdir -p "$tmp/home/.qaren/runtime/.staging-$VERSION.abc123/previous/bin"
staged_before=$(cd "$tmp/home/.qaren/runtime" && find . | sort)
hook
bounded "interrupted install"
check "interrupted install: names the repair command" yes "$(contains "$out" "interrupted qaren v$VERSION install was found; repair it with:")"
check "interrupted install: nothing is touched" "$staged_before" "$(cd "$tmp/home/.qaren/runtime" && find . | sort)"
rm -rf "$tmp/home/.qaren/runtime/.staging-$VERSION.abc123"

for tool in tar perl du; do
  rm "$tmp/bin/$tool"
  hook
  bounded "no $tool on PATH"
  check "no $tool on PATH: names it" "qaren: required tool not found: $tool" "$out"
  ln -sf "$(command -v "$tool")" "$tmp/bin/$tool"
done

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
check "verified runtime: prints the binary" "$REAL_DEST/bin/qaren" "$out"

rm "$DEST/bin/qaren"
mkdir "$DEST/bin/qaren"
hook
bounded "directory at bin/qaren"
check "directory at bin/qaren: prints the install command" yes "$(contains "$out" "--install")"
rmdir "$DEST/bin/qaren"
printf '#!/bin/sh\n' > "$DEST/bin/qaren"
chmod +x "$DEST/bin/qaren"

"$NODE" -e 'require("fs").writeFileSync(process.argv[1], "a".repeat(8 * 1024 * 1024))' "$DEST/.tarball-sha256"
hook
bounded "oversized digest record"
check "oversized digest record: prints the install command" yes "$(contains "$out" "--install")"
printf '%s\n' "$SHA" > "$DEST/.tarball-sha256"

cat > "$tmp/stall-root.bash" <<'SH'
cd() {
  case "$*" in
    *"/.qaren/runtime")
      "$STALL_PERL" -e 'open(my $f, ">", $ENV{STALL_PID}) or die $!; print $f $$; close $f; sleep 30'
      ;;
    *) builtin cd "$@" ;;
  esac
}
SH
BASH_ENV="$tmp/stall-root.bash" STALL_PERL="$PERL" STALL_PID="$tmp/slow-root.pid" hook
bounded "stalled root resolution"
check "stalled root resolution: names the install command" yes "$(contains "$out" "did not finish in time")"
check "stalled root resolution: child started" yes "$([ -s "$tmp/slow-root.pid" ] && echo yes || echo no)"
if [ -s "$tmp/slow-root.pid" ]; then
  check "stalled root resolution: child is gone" no "$(kill -0 "$(cat "$tmp/slow-root.pid")" 2>/dev/null && echo yes || echo no)"
fi

printf '#!/bin/sh\necho "$$" > "%s/slow-perl.pid"\nexec "%s" -e '\''process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'\''\n' "$tmp" "$NODE" > "$tmp/slow-perl"
chmod +x "$tmp/slow-perl"
ln -sf "$tmp/slow-perl" "$tmp/bin/perl"
hook
bounded "stalled digest reader"
check "stalled digest reader: names the install command" yes "$(contains "$out" "did not finish in time")"
check "stalled digest reader: child started" yes "$([ -s "$tmp/slow-perl.pid" ] && echo yes || echo no)"
if [ -s "$tmp/slow-perl.pid" ]; then
  check "stalled digest reader: child is gone" no "$(kill -0 "$(cat "$tmp/slow-perl.pid")" 2>/dev/null && echo yes || echo no)"
fi
ln -sf "$PERL" "$tmp/bin/perl"

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

printf '#!/bin/sh\necho "$$" > "%s/slow-node.pid"\nexec "%s" -e '\''process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'\''\n' "$tmp" "$NODE" > "$tmp/slow-node"
chmod +x "$tmp/slow-node"
ln -sf "$tmp/slow-node" "$tmp/bin/node"
hook
bounded "Node that never starts"
check "Node that never starts: names the install command" yes "$(contains "$out" "did not finish in time")"
check "Node that never starts: child started" yes "$([ -s "$tmp/slow-node.pid" ] && echo yes || echo no)"
if [ -s "$tmp/slow-node.pid" ]; then
  check "Node that never starts: child is gone" no "$(kill -0 "$(cat "$tmp/slow-node.pid")" 2>/dev/null && echo yes || echo no)"
fi

printf '#!/bin/sh\nexec "%s" --import "data:text/javascript,Object.defineProperty(process.versions,\\"node\\",{value:\\"22.1.0\\"})" "$@"\n' "$NODE" > "$tmp/old-node"
chmod +x "$tmp/old-node"
ln -sf "$tmp/old-node" "$tmp/bin/node"
hook
bounded "Node 22"
check "Node 22: names the Node 24 prerequisite" yes "$(contains "$out" "needs Node 24 or newer; found")"

rm "$tmp/bin/node"
hook
bounded "no node on PATH"
check "no node: names the prerequisite" yes "$(contains "$out" "Node 24")"

check "the network was never touched" no "$([ -e "$tmp/network" ] && echo yes || echo no)"

exit "$fail"
