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
zombie_sightings=0 zombie_gaps=0 running_survivors=0
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
  local pid kind
  if [ -s "$tmp/check-pids" ]; then
    while read -r pid kind; do kill -KILL "$pid" 2>/dev/null || true; done < "$tmp/check-pids"
  fi
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
timed_hook() {
  "$PERL" -MTime::HiRes=clock_gettime,CLOCK_MONOTONIC -e '
    my $record = shift @ARGV;
    my $start = clock_gettime(CLOCK_MONOTONIC);
    my $pid = fork();
    defined($pid) or die "fork: $!";
    if (!$pid) { alarm 5; exec @ARGV; die "exec: $!"; }
    my $killed_at;
    if ($ENV{TEST_KILL_HOOK}) {
      open(my $h, ">", "$record.pid") or die $!;
      print $h $pid; close $h;
      Time::HiRes::sleep(0.2);
      $killed_at = clock_gettime(CLOCK_MONOTONIC);
      kill 9, $pid;
    }
    waitpid($pid, 0);
    my $status = $?;
    my $ms = (clock_gettime(CLOCK_MONOTONIC) - $start) * 1000;
    my $snapshot = sub {
      my @states;
      my %seen;
      if (open(my $p, "<", $ENV{TEST_CHECK_PIDS})) {
        while (<$p>) {
          my ($child, $kind) = split;
          next unless $child =~ /^\d+$/ && !$seen{$child}++;
          my $state = `/bin/ps -o stat= -p $child 2>/dev/null`;
          $state =~ s/^\s+|\s+$//g;
          push @states, [$child, $kind, $state];
        }
      }
      return @states;
    };
    my @states = $snapshot->();
    if ($ENV{TEST_KILL_HOOK}) {
      my $deadline = $killed_at + 1.5;
      while (grep { $_->[2] ne "" && $_->[2] !~ /^Z/ } @states) {
        last if clock_gettime(CLOCK_MONOTONIC) >= $deadline;
        Time::HiRes::sleep(0.05);
        @states = $snapshot->();
      }
    }
    if ($ENV{TEST_KILL_HOOK}) {
      open(my $elapsed, ">", "$record.cleanup-ms") or die $!;
      printf $elapsed "%.0f\n", (clock_gettime(CLOCK_MONOTONIC) - $killed_at) * 1000;
      close $elapsed;
    }
    for my $entry (@states) {
      $entry->[2] ||= "-";
      next unless $entry->[2] =~ /^Z/;
      my $deadline = clock_gettime(CLOCK_MONOTONIC) + 0.5;
      my $state = $entry->[2];
      for (1..10) {
        last if clock_gettime(CLOCK_MONOTONIC) + 0.05 > $deadline;
        Time::HiRes::sleep(0.05);
        $state = `/bin/ps -o stat= -p $entry->[0] 2>/dev/null`;
        $state =~ s/^\s+|\s+$//g;
        last unless $state =~ /^Z/;
      }
      push @$entry, $state || "-";
    }
    open(my $states, ">", "$record.states") or die $!;
    print $states join(" ", @$_), "\n" for @states;
    close $states;
    open(my $f, ">", $record) or die "timing record: $!";
    printf $f "%.0f\n", $ms;
    exit(($status & 127) ? 128 + ($status & 127) : $status >> 8);
  ' "$tmp/hook-ms" "$@"
}

export TEST_CHECK_PIDS="$tmp/check-pids"
SLEEP=$(command -v sleep)
printf '#!/bin/sh\nprintf "%%s sleep\\n" "$$" >> "$TEST_CHECK_PIDS"\n/bin/ps -o ppid= -p $$ | while read -r pid; do printf "%%s watchdog\\n" "$pid" >> "$TEST_CHECK_PIDS"; done\nexec "%s" "$@"\n' "$SLEEP" > "$tmp/record-sleep"
chmod +x "$tmp/record-sleep"
ln -sf "$tmp/record-sleep" "$tmp/bin/sleep"

child_states() {
  local pid kind state final
  while read -r pid kind state final; do
    case "$state" in
      ""|-) ;;
      Z*)
        zombie_sightings=$((zombie_sightings + 1))
        case "$final" in
          Z*) zombie_gaps=$((zombie_gaps + 1)); echo "GAP: $1: $kind pid $pid remains zombie after bounded 0.5 s poll" ;;
          -) ;;
          *) running_survivors=$((running_survivors + 1)); fail=1; echo "FAIL: $1: $kind pid $pid running ($final)"; kill -KILL "$pid" 2>/dev/null || true ;;
        esac
        ;;
      *) running_survivors=$((running_survivors + 1)); fail=1; echo "FAIL: $1: $kind pid $pid running at return ($state)"; kill -KILL "$pid" 2>/dev/null || true ;;
    esac
  done < "$tmp/hook-ms.states"
}

recorded_stall() {
  local pid kind node=0 watchdog=0 sleep=0 check_pid=0
  while read -r pid kind; do
    case "$kind" in
      node) node=1 ;;
      watchdog) watchdog=1 ;;
      sleep) sleep=1 ;;
      check) check_pid=1 ;;
    esac
  done < "$TEST_CHECK_PIDS"
  check "$1: Node, check and watchdog sleep were recorded" 1111 "$node$check_pid$watchdog$sleep"
}

contains() { case "$1" in *"$2"*) echo yes ;; *) echo "no: $1" ;; esac; }

# hook [PATH]: runs --print-bin like the SessionStart hook; sets out, rc, ms.
# perl's alarm kills a hook that hangs, so a regression fails instead of stalling the suite.
hook() {
  : > "$TEST_CHECK_PIDS"
  out=$(HOME="$tmp/home" PATH="${1:-$tmp/bin}" timed_hook \
    "$tmp/bin/bash" "$tmp/plugin/scripts/ensure-qaren.sh" --print-bin 2>&1)
  rc=$?
  ms=$(cat "$tmp/hook-ms")
  child_states "hook"
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
: > "$TEST_CHECK_PIDS"
out=$(HOME="$tmp/home" PATH="$tmp/bin" CLAUDE_PLUGIN_ROOT="$tmp/plugin with space" \
  timed_hook /bin/sh -c "$hook_command" 2>&1)
rc=$?
ms=$(cat "$tmp/hook-ms")
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
      "$STALL_PERL" -e 'open(my $f, ">", $ENV{STALL_PID}) or die $!; print $f $$; close $f; open(my $p, ">>", $ENV{TEST_CHECK_PIDS}) or die $!; print $p "$$ root\n", getpgrp(), " check\n"; close $p; sleep 30'
      ;;
    *) builtin cd "$@" ;;
  esac
}
SH
BASH_ENV="$tmp/stall-root.bash" STALL_PERL="$PERL" STALL_PID="$tmp/slow-root.pid" hook
bounded "stalled root resolution"
check "stalled root resolution: names the install command" yes "$(contains "$out" "did not finish in time")"
check "stalled root resolution: child started" yes "$([ -s "$tmp/slow-root.pid" ] && echo yes || echo no)"

printf '#!/bin/sh\nprintf "%%s node\\n" "$$" >> "$TEST_CHECK_PIDS"\n/bin/ps -o pgid= -p $$ | while read -r pid; do printf "%%s check\\n" "$pid" >> "$TEST_CHECK_PIDS"; done\necho "$$" > "%s/slow-perl.pid"\nexec "%s" -e '\''process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'\''\n' "$tmp" "$NODE" > "$tmp/slow-perl"
chmod +x "$tmp/slow-perl"
ln -sf "$tmp/slow-perl" "$tmp/bin/perl"
hook
bounded "stalled digest reader"
check "stalled digest reader: names the install command" yes "$(contains "$out" "did not finish in time")"
check "stalled digest reader: child started" yes "$([ -s "$tmp/slow-perl.pid" ] && echo yes || echo no)"
ln -sf "$PERL" "$tmp/bin/perl"

mkdir -p "$tmp/owned"
printf '#!/bin/sh\n' > "$tmp/owned/qaren"
chmod +x "$tmp/owned/qaren"
printf '%s\n' "$SHA" > "$tmp/owned/record"
mv "$DEST/bin/qaren" "$tmp/real-qaren"
ln -s "$tmp/owned/qaren" "$DEST/bin/qaren"
hook
bounded "linked bin/qaren"
check "linked bin/qaren: prints the install command" yes "$(contains "$out" "is not installed. Install it with:")"
rm "$DEST/bin/qaren"
mv "$tmp/real-qaren" "$DEST/bin/qaren"
mv "$DEST/bin" "$tmp/real-bin"
ln -s "$tmp/owned" "$DEST/bin"
hook
bounded "linked bin/"
check "linked bin/: prints the install command" yes "$(contains "$out" "is not installed. Install it with:")"
rm "$DEST/bin"
mv "$tmp/real-bin" "$DEST/bin"
rm "$DEST/.tarball-sha256"
ln -s "$tmp/owned/record" "$DEST/.tarball-sha256"
hook
bounded "linked digest record"
check "linked digest record: prints the install command" yes "$(contains "$out" "is not installed. Install it with:")"
rm "$DEST/.tarball-sha256"
printf '%s\n' "$SHA" > "$DEST/.tarball-sha256"

printf '#!/bin/sh\nprintf "%%s node\\n" "$$" >> "$TEST_CHECK_PIDS"\nsleep 0.3\nexec "%s" "$@"\n' "$NODE" > "$tmp/cold-node"
chmod +x "$tmp/cold-node"
ln -sf "$tmp/cold-node" "$tmp/bin/node"
cold_bin=0 cold_min=2000 cold_max=0
for _ in $(seq 100); do
  hook
  [ "$rc" = 0 ] && [ "$ms" -lt 2000 ] && [ "$out" = "$REAL_DEST/bin/qaren" ] && cold_bin=$((cold_bin + 1))
  [ "$ms" -ge "$cold_min" ] || cold_min=$ms
  [ "$ms" -le "$cold_max" ] || cold_max=$ms
done
check "Node with 0.3 s startup: 100 of 100 calls print the binary within 2 s" 100 "$cold_bin"
echo "timings: 0.3 s startup ${cold_min}-${cold_max} ms"
ln -sf "$NODE" "$tmp/bin/node"
healthy_bin=0 healthy_min=2000 healthy_max=0
for _ in $(seq 200); do
  hook
  [ "$rc" = 0 ] && [ "$ms" -lt 2000 ] && [ "$out" = "$REAL_DEST/bin/qaren" ] && healthy_bin=$((healthy_bin + 1))
  [ "$ms" -ge "$healthy_min" ] || healthy_min=$ms
  [ "$ms" -le "$healthy_max" ] || healthy_max=$ms
done
check "normal Node: 200 calls print the binary with zero timeouts" 200 "$healthy_bin"
echo "timings: healthy ${healthy_min}-${healthy_max} ms"

printf '#!/bin/sh\nprintf "%%s node\\n" "$$" >> "$TEST_CHECK_PIDS"\n/bin/ps -o pgid= -p $$ | while read -r pid; do printf "%%s check\\n" "$pid" >> "$TEST_CHECK_PIDS"; done\necho "$$" > "%s/slow-node.pid"\nexec "%s" "$@"\n' "$tmp" "$NODE" > "$tmp/debug-node"
chmod +x "$tmp/debug-node"
ln -sf "$tmp/debug-node" "$tmp/bin/node"
NODE_OPTIONS=--inspect-brk=127.0.0.1:0 hook
recorded_stall "debugger stall"
bounded "real Node paused by the debugger"
check "real Node paused by the debugger: names the install command" yes "$(contains "$out" "did not finish in time; run:")"
check "real Node paused by the debugger: at least 1000 ms" yes "$([ "$ms" -ge 1000 ] && echo yes || echo "no (${ms} ms)")"
echo "timings: debugger stall $ms ms"
check "real Node paused by the debugger: child started" yes "$([ -s "$tmp/slow-node.pid" ] && echo yes || echo no)"

printf '#!/bin/sh\nprintf "%%s node\\n" "$$" >> "$TEST_CHECK_PIDS"\n/bin/ps -o pgid= -p $$ | while read -r pid; do printf "%%s check\\n" "$pid" >> "$TEST_CHECK_PIDS"; done\necho "$$" > "%s/slow-node.pid"\nexec "%s" -e '\''process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'\''\n' "$tmp" "$NODE" > "$tmp/slow-node"
chmod +x "$tmp/slow-node"
ln -sf "$tmp/slow-node" "$tmp/bin/node"
printf '#!/bin/sh\nprintf "%%s sleep\\n" "$$" >> "$TEST_CHECK_PIDS"\n/bin/ps -o ppid= -p $$ | while read -r pid; do printf "%%s watchdog\\n" "$pid" >> "$TEST_CHECK_PIDS"; done\n"%s" 0.15\nexec "%s" "$@"\n' "$SLEEP" "$SLEEP" > "$tmp/slow-sleep"
chmod +x "$tmp/slow-sleep"
ln -sf "$tmp/slow-sleep" "$tmp/bin/sleep"
hook
recorded_stall "slow timer startup"
bounded "stalled check with slow timer startup"
echo "timings: slow timer startup $ms ms"
check "stalled check with slow timer startup: names the install command" yes "$(contains "$out" "did not finish in time; run:")"
ln -sf "$tmp/record-sleep" "$tmp/bin/sleep"

ln -sf "$tmp/debug-node" "$tmp/bin/node"
TEST_KILL_HOOK=1 NODE_OPTIONS=--inspect-brk=127.0.0.1:0 hook
recorded_stall "external SIGKILL"
check "external SIGKILL: zero running survivors" 0 "$running_survivors"
check "external SIGKILL: hook was killed" 137 "$rc"
cleanup_ms=$(cat "$tmp/hook-ms.cleanup-ms")
check "external SIGKILL: zero running children within 1.5 s" yes "$([ "$cleanup_ms" -le 1500 ] && echo yes || echo "no (${cleanup_ms} ms)")"
echo "timings: external SIGKILL cleanup $cleanup_ms ms"
check "external SIGKILL: recorded hook pid" yes "$([ -s "$tmp/hook-ms.pid" ] && echo yes || echo no)"
check "external SIGKILL: recorded children started" yes "$([ -s "$TEST_CHECK_PIDS" ] && echo yes || echo no)"

ln -sf "$tmp/slow-node" "$tmp/bin/node"

quiet=0 one_line=0 in_time=0 recorded=0 stalled_min=2000 stalled_max=0
for _ in $(seq 200); do
  : > "$TEST_CHECK_PIDS"
  rm -f "$tmp/slow-node.pid"
  HOME="$tmp/home" PATH="$tmp/bin" timed_hook \
    "$tmp/bin/bash" "$tmp/plugin/scripts/ensure-qaren.sh" --print-bin >"$tmp/hook-stdout" 2>"$tmp/hook-stderr"
  rc=$?
  child_states "stalled check"
  node=0 watchdog=0 sleep=0 check_pid=0
  while read -r pid kind; do
    case "$kind" in node) node=1 ;; watchdog) watchdog=1 ;; sleep) sleep=1 ;; check) check_pid=1 ;; esac
  done < "$TEST_CHECK_PIDS"
  [ "$node$check_pid$watchdog$sleep" != 1111 ] || recorded=$((recorded + 1))
  ms=$(cat "$tmp/hook-ms")
  [ "$ms" -ge "$stalled_min" ] || stalled_min=$ms
  [ "$ms" -le "$stalled_max" ] || stalled_max=$ms
  [ ! -s "$tmp/hook-stderr" ] && quiet=$((quiet + 1))
  [ "$(wc -l < "$tmp/hook-stdout" | tr -d ' ')" = 1 ] && grep -q 'did not finish in time' "$tmp/hook-stdout" \
    && one_line=$((one_line + 1))
  if [ "$rc" = 0 ] && [ "$ms" -ge 1000 ] && [ "$ms" -lt 2000 ]; then
    in_time=$((in_time + 1))
  else
    echo "FAIL: stalled check took $ms ms and exited $rc"
  fi
done
check "200 stalled checks: every Node, check and watchdog sleep recorded" 200 "$recorded"
check "200 stalled checks: stderr is empty every time" 200 "$quiet"
check "200 stalled checks: stdout is exactly one line every time" 200 "$one_line"
check "200 stalled checks: each exits 0 within 2 s" 200 "$in_time"
check "200 stalled checks: zero running survivors" 0 "$running_survivors"
echo "timings: stalled ${stalled_min}-${stalled_max} ms"
ln -sf "$NODE" "$tmp/bin/node"

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

printf '#!/bin/sh\nprintf "%%s node\\n" "$$" >> "$TEST_CHECK_PIDS"\n/bin/ps -o pgid= -p $$ | while read -r pid; do printf "%%s check\\n" "$pid" >> "$TEST_CHECK_PIDS"; done\necho "$$" > "%s/slow-node.pid"\nexec "%s" -e '\''process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'\''\n' "$tmp" "$NODE" > "$tmp/slow-node"
chmod +x "$tmp/slow-node"
ln -sf "$tmp/slow-node" "$tmp/bin/node"
hook
bounded "Node that never starts"
check "Node that never starts: names the install command" yes "$(contains "$out" "did not finish in time")"
check "Node that never starts: child started" yes "$([ -s "$tmp/slow-node.pid" ] && echo yes || echo no)"

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

echo "lifecycle: $zombie_sightings zombie sightings, $zombie_gaps persistent zombie gaps, $running_survivors running survivors"
exit "$fail"
