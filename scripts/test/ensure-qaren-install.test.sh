#!/usr/bin/env bash
# ensure-qaren.sh --install --from-file: a verified tarball installs atomically,
# and anything that differs from the plugin's runner-manifest.json or could
# write outside the runtime directory is refused with nothing installed.
#
# Run: bash scripts/test/ensure-qaren-install.test.sh

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="$ROOT/packages/qaren-plugin/scripts/ensure-qaren.sh"
VERSION=9.8.7
NAME="qaren-$VERSION-darwin-arm64.tar.gz"
TOP="qaren-$VERSION-darwin-arm64"

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

mkdir -p "$tmp/stubs" "$tmp/plugin/scripts"
cp "$SCRIPT" "$tmp/plugin/scripts/ensure-qaren.sh"
printf '#!/bin/sh\ncase "$1" in -s) echo Darwin ;; -m) echo arm64 ;; *) echo Darwin ;; esac\n' > "$tmp/stubs/uname"
# sleep records its pid so the parked children of killed installers can be cleaned up.
printf '#!/bin/sh\necho $$ >> "%s/sleep-pids"\nexec "%s" "$@"\n' "$tmp" "$(command -v sleep)" > "$tmp/stubs/sleep"
chmod +x "$tmp/stubs/uname" "$tmp/stubs/sleep"
export PATH="$tmp/stubs:$PATH"
REQUIRED_TOOLS="uname dirname cat tar shasum wc cut tr head du mktemp mkdir mv cp rm find ls sleep perl"

# make_tarball <out> <kind>: good | dotdot | absolute | symlink | stray | bomb | manyfiles
make_tarball() {
  python3 - "$1" "$2" "$TOP" "$tmp" <<'PY'
import io, sys, tarfile
out, kind, top, tmp = sys.argv[1:]
class Zeros:
    def read(self, n=-1):
        return b"\0" * (n if n and n > 0 else 1 << 20)
def add(tar, name, data=b"", mode=0o644, kind=tarfile.REGTYPE, link=""):
    info = tarfile.TarInfo(name)
    info.type, info.mode, info.size, info.linkname = kind, mode, len(data), link
    tar.addfile(info, io.BytesIO(data) if kind == tarfile.REGTYPE else None)
with tarfile.open(out, "w:gz", format=tarfile.USTAR_FORMAT, compresslevel=1) as tar:
    add(tar, f"{top}/", kind=tarfile.DIRTYPE, mode=0o755)
    add(tar, f"{top}/bin/", kind=tarfile.DIRTYPE, mode=0o755)
    add(tar, f"{top}/bin/qaren", b"#!/bin/sh\necho qaren\n", 0o755)
    add(tar, f"{top}/runtime/qa/walk.js", b"// walk\n" * 4096)
    if kind == "dotdot":
        add(tar, f"{top}/../escaped", b"x")
    elif kind == "absolute":
        add(tar, f"{tmp}/abs-escaped", b"x")
    elif kind == "symlink":
        add(tar, f"{top}/runtime/out", kind=tarfile.SYMTYPE, link=f"{tmp}/link-escaped")
        add(tar, f"{top}/runtime/out/file", b"x")
    elif kind == "stray":
        add(tar, "elsewhere/file", b"x")
    elif kind == "bomb":
        info = tarfile.TarInfo(f"{top}/runtime/zeros")
        info.size = 1 << 30
        tar.addfile(info, Zeros())
    elif kind == "manyfiles":
        for i in range(300):
            add(tar, f"{top}/runtime/many/{i}", b"x")
PY
}

# write_manifest <tarball> [<byte delta>]
write_manifest() {
  local sha bytes
  sha=$(shasum -a 256 "$1" | cut -d' ' -f1)
  bytes=$(( $(wc -c < "$1" | tr -d ' ') + ${2:-0} ))
  printf '{"version":"%s","assets":{"ios":[],"android":[],"qaren":{"darwin-arm64":{"name":"%s","sha256":"%s","bytes":%s}}}}\n' \
    "$VERSION" "$NAME" "$sha" "$bytes" > "$tmp/plugin/runner-manifest.json"
}

run_install() {
  HOME="$tmp/home" bash "$tmp/plugin/scripts/ensure-qaren.sh" --install --from-file "$1" 2>"$tmp/stderr"
}

leftovers() {
  find "$tmp/home/.qaren/runtime" -mindepth 1 -maxdepth 1 -name '.staging-*' 2>/dev/null | wc -l | tr -d ' '
}

LOCKFILE_PATH() { echo "$tmp/home/.qaren/runtime/.lock-$VERSION"; }

# 0 when nothing holds this version's install lock (a fresh open can take it at once).
lock_free() {
  [ -e "$(LOCKFILE_PATH)" ] || { echo yes; return; }
  perl -MFcntl=:flock -e 'open(F, ">>", $ARGV[0]) or exit 2; exit(flock(F, LOCK_EX | LOCK_NB) ? 0 : 1)' "$(LOCKFILE_PATH)" \
    && echo yes || echo no
}

runtime_snapshot() { (cd "$DEST" 2>/dev/null && find . | sort && cat bin/qaren .tarball-sha256) 2>&1; }

# start_paused <stage>: runs an install that parks at <stage>; sets PAUSED_PID.
start_paused() {
  rm -f "$tmp/paused"
  QAREN_TEST_MODE=1 QAREN_TEST_PAUSE_AT="$1" QAREN_TEST_PAUSE_FILE="$tmp/paused" \
    HOME="$tmp/home" bash "$tmp/plugin/scripts/ensure-qaren.sh" --install --from-file "$tmp/good.tgz" \
    >/dev/null 2>"$tmp/paused-stderr" &
  PAUSED_PID=$!
  local waited=0
  while [ ! -e "$tmp/paused" ] && [ "$waited" -lt 200 ]; do
    sleep 0.05
    waited=$((waited + 1))
  done
  [ -e "$tmp/paused" ] || echo "FAIL: installer never reached $1: $(cat "$tmp/paused-stderr")"
}

kill_paused() {
  kill -9 "$PAUSED_PID" 2>/dev/null
  wait "$PAUSED_PID" 2>/dev/null
}

reset_home() { rm -rf "$tmp/home"; mkdir -p "$tmp/home"; }

DEST="$tmp/home/.qaren/runtime/$VERSION"

# A good tarball installs and records its digest.
reset_home
make_tarball "$tmp/good.tgz" good
write_manifest "$tmp/good.tgz"
out=$(run_install "$tmp/good.tgz"); rc=$?
check "good tarball installs" 0 "$rc"
check "prints the installed binary" "$DEST/bin/qaren" "$out"
check "installed binary runs" qaren "$("$DEST/bin/qaren")"
check "digest is recorded" "$(shasum -a 256 "$tmp/good.tgz" | cut -d' ' -f1)" "$(cat "$DEST/.tarball-sha256")"
check "no staging left behind" 0 "$(leftovers)"

# Re-install is idempotent and needs no tarball at all.
before=$(ls -lTR "$DEST" 2>/dev/null || ls -l --full-time -R "$DEST")
out=$(run_install "$tmp/does-not-exist.tgz"); rc=$?
check "re-install exits 0" 0 "$rc"
check "re-install prints the same binary" "$DEST/bin/qaren" "$out"
check "re-install leaves the runtime untouched" "$before" "$(ls -lTR "$DEST" 2>/dev/null || ls -l --full-time -R "$DEST")"

# A tampered byte is refused and nothing is installed.
reset_home
cp "$tmp/good.tgz" "$tmp/tampered.tgz"
printf '\x00' | dd of="$tmp/tampered.tgz" bs=1 seek=100 conv=notrunc 2>/dev/null
write_manifest "$tmp/good.tgz"
run_install "$tmp/tampered.tgz" >/dev/null; rc=$?
check "tampered tarball is refused" 1 "$rc"
check "tampered refusal names the digest" yes "$(grep -q 'sha256' "$tmp/stderr" && echo yes || echo no)"
check "tampered: nothing installed" no "$([ -e "$DEST" ] && echo yes || echo no)"
check "tampered: no staging left behind" 0 "$(leftovers)"

# A wrong byte count is refused.
reset_home
write_manifest "$tmp/good.tgz" 1
run_install "$tmp/good.tgz" >/dev/null; rc=$?
check "wrong length is refused" 1 "$rc"
check "wrong length: nothing installed" no "$([ -e "$DEST" ] && echo yes || echo no)"

# Paths and links that could write outside the runtime are refused.
for kind in dotdot absolute symlink stray; do
  reset_home
  make_tarball "$tmp/$kind.tgz" "$kind"
  write_manifest "$tmp/$kind.tgz"
  run_install "$tmp/$kind.tgz" >/dev/null; rc=$?
  check "$kind entry is refused" 1 "$rc"
  check "$kind: nothing installed" no "$([ -e "$DEST" ] && echo yes || echo no)"
  escaped=no
  for path in "$tmp/home/.qaren/runtime/escaped" "$tmp/home/.qaren/escaped" "$tmp/abs-escaped" "$tmp/link-escaped"; do
    [ -e "$path" ] || [ -L "$path" ] && escaped="yes: $path"
  done
  check "$kind: nothing escaped" no "$escaped"
  check "$kind: no staging left behind" 0 "$(leftovers)"
done

# Killing the install during extraction leaves no partial runtime.
reset_home
write_manifest "$tmp/good.tgz"
real_tar=$(command -v tar)
cat > "$tmp/stubs/tar" <<SH
#!/bin/sh
case "\$1" in
  -xzf) "$real_tar" "\$@"; kill -TERM \$PPID; sleep 5 ;;
  *) exec "$real_tar" "\$@" ;;
esac
SH
chmod +x "$tmp/stubs/tar"
run_install "$tmp/good.tgz" >/dev/null; rc=$?
rm -f "$tmp/stubs/tar"
check "killed install does not succeed" yes "$([ "$rc" -ne 0 ] && echo yes || echo no)"
check "killed install: no runtime" no "$([ -e "$DEST" ] && echo yes || echo no)"
check "killed install: no staging left behind" 0 "$(leftovers)"

# A runtime whose recorded digest differs from the manifest is replaced as a whole.
stale_runtime() {
  reset_home
  mkdir -p "$DEST/bin"
  printf '#!/bin/sh\necho stale\n' > "$DEST/bin/qaren"
  chmod +x "$DEST/bin/qaren"
  printf 'stale\n' > "$DEST/stale-file"
  printf '%s\n' "$(printf 0%.0s $(seq 64))" > "$DEST/.tarball-sha256"
}
stale_runtime
out=$(run_install "$tmp/good.tgz"); rc=$?
check "mismatched runtime is replaced" 0 "$rc"
check "replaced runtime runs the new binary" qaren "$("$DEST/bin/qaren")"
check "replaced runtime records the new digest" "$(shasum -a 256 "$tmp/good.tgz" | cut -d' ' -f1)" "$(cat "$DEST/.tarball-sha256")"
check "replaced runtime drops stale files" no "$([ -e "$DEST/stale-file" ] && echo yes || echo no)"
check "replaced runtime: no staging left behind" 0 "$(leftovers)"

# Interrupting between moving the previous runtime aside and publishing the new one restores it.
stale_runtime
real_mv=$(command -v mv)
cat > "$tmp/stubs/mv" <<SH
#!/bin/sh
case "\$1" in
  */x/$TOP) kill -TERM \$PPID; exit 143 ;;
esac
exec "$real_mv" "\$@"
SH
chmod +x "$tmp/stubs/mv"
run_install "$tmp/good.tgz" >/dev/null; rc=$?
rm -f "$tmp/stubs/mv"
check "interrupted replacement does not succeed" yes "$([ "$rc" -ne 0 ] && echo yes || echo no)"
check "interrupted replacement keeps the previous runtime" stale "$("$DEST/bin/qaren")"
check "interrupted replacement keeps the previous files" yes "$([ -e "$DEST/stale-file" ] && echo yes || echo no)"
check "interrupted replacement: no staging left behind" 0 "$(leftovers)"

# A live installer holds the lock: a concurrent install of the same version is refused.
reset_home
start_paused download
run_install "$tmp/good.tgz" >/dev/null; rc=$?
check "a live install lock refuses" 1 "$rc"
check "live lock: names the running install" yes "$(grep -q 'install is running' "$tmp/stderr" && echo yes || echo no)"
check "live lock: nothing installed" no "$([ -e "$DEST" ] && echo yes || echo no)"
kill_paused
check "SIGKILL releases the lock although the installer's child still runs" yes "$(lock_free)"
out=$(run_install "$tmp/good.tgz"); rc=$?
check "after SIGKILL of the holder the install succeeds" 0 "$rc"
check "after SIGKILL: the runtime is complete" "$(shasum -a 256 "$tmp/good.tgz" | cut -d' ' -f1)" "$(cat "$DEST/.tarball-sha256")"
check "the lock file is never removed" yes "$([ -f "$(LOCKFILE_PATH)" ] && echo yes || echo no)"
check "the lock is released after an install" yes "$(lock_free)"

# SIGKILL at every stage, upgrading (no runtime yet) and replacing (a stale runtime): the next
# install heals what the killed one left and finishes, with no staging and the lock free.
GOOD_SHA=$(shasum -a 256 "$tmp/good.tgz" | cut -d' ' -f1)
for mode in upgrade replace; do
  for stage in download verify extract move1 move2-before move2-after; do
    if [ "$mode" = replace ]; then stale_runtime; else reset_home; fi
    write_manifest "$tmp/good.tgz"
    start_paused "$stage"
    kill_paused
    label="SIGKILL $mode at $stage"
    check "$label: lock free while the parked child lives" yes "$(lock_free)"
    # A loaded host can blow the hook's Node budget; that answer says nothing about recovery.
    for attempt in 1 2 3; do
      hint=$(HOME="$tmp/home" bash "$tmp/plugin/scripts/ensure-qaren.sh" --print-bin)
      grep -q 'did not finish in time' <<< "$hint" || break
    done
    if [ "$mode" = replace ] && [ "$stage" = move2-before ]; then
      check "$label: print-bin reports the interrupted install" yes \
        "$(grep -q 'interrupted qaren v'"$VERSION"' install was found' <<< "$hint" && echo yes || echo "no: $hint")"
    else
      check "$label: print-bin claims no interrupted install" no \
        "$(grep -q 'interrupted' <<< "$hint" && echo "yes: $hint" || echo no)"
    fi
    out=$(run_install "$tmp/good.tgz"); rc=$?
    check "$label: the next install succeeds" 0 "$rc"
    check "$label: the runtime is complete" "$GOOD_SHA" "$(cat "$DEST/.tarball-sha256" 2>&1)"
    check "$label: the runtime runs" qaren "$("$DEST/bin/qaren" 2>&1)"
    check "$label: no staging left behind" 0 "$(leftovers)"
    check "$label: the lock is free" yes "$(lock_free)"
  done
done

# State this script does not create is refused and left exactly as found.
reset_home
mkdir -p "$tmp/home/.qaren/runtime" "$tmp/elsewhere"
printf 'keep\n' > "$tmp/elsewhere/file"
ln -s "$tmp/elsewhere" "$tmp/home/.qaren/runtime/.staging-$VERSION.evil"
run_install "$tmp/good.tgz" >/dev/null; rc=$?
check "symlinked staging is refused" 1 "$rc"
check "symlinked staging: named" yes "$(grep -q "unexpected install state at .*staging-$VERSION.evil" "$tmp/stderr" && echo yes || echo no)"
check "symlinked staging: left in place" yes "$([ -L "$tmp/home/.qaren/runtime/.staging-$VERSION.evil" ] && echo yes || echo no)"
check "symlinked staging: its target untouched" keep "$(cat "$tmp/elsewhere/file")"
check "symlinked staging: nothing installed" no "$([ -e "$DEST" ] && echo yes || echo no)"

reset_home
mkdir -p "$tmp/home/.qaren/runtime/.staging-$VERSION.odd"
ln -s "$tmp/elsewhere" "$tmp/home/.qaren/runtime/.staging-$VERSION.odd/previous"
run_install "$tmp/good.tgz" >/dev/null; rc=$?
check "a symlinked previous runtime is refused" 1 "$rc"
check "symlinked previous: left in place" yes "$([ -L "$tmp/home/.qaren/runtime/.staging-$VERSION.odd/previous" ] && echo yes || echo no)"
check "symlinked previous: never moved into place" no "$([ -e "$DEST" ] || [ -L "$DEST" ] && echo yes || echo no)"

reset_home
mkdir -p "$tmp/home/.qaren/runtime"
ln -s "$tmp/elsewhere/lock-target" "$(LOCKFILE_PATH)"
run_install "$tmp/good.tgz" >/dev/null; rc=$?
check "a symlinked lock is refused" 1 "$rc"
check "symlinked lock: its target is never created" no "$([ -e "$tmp/elsewhere/lock-target" ] && echo yes || echo no)"

reset_home
mkdir -p "$tmp/home/.qaren/runtime"
ln -s "$tmp/elsewhere" "$DEST"
run_install "$tmp/good.tgz" >/dev/null; rc=$?
check "a symlinked runtime directory is refused" 1 "$rc"
check "symlinked runtime: its target untouched" keep "$(cat "$tmp/elsewhere/file")"

# The unpacked size is bounded before extraction and checked again on disk after it.
stale_runtime
before=$(runtime_snapshot)
make_tarball "$tmp/bomb.tgz" bomb
write_manifest "$tmp/bomb.tgz"
run_install "$tmp/bomb.tgz" >/dev/null; rc=$?
check "a 1 GiB entry is refused" 1 "$rc"
check "1 GiB entry: names the ceiling" yes "$(grep -q 'above the unpacked-size ceiling' "$tmp/stderr" && echo yes || echo no)"
check "1 GiB entry: refused before extraction" yes "$(grep -q 'would unpack to more than' "$tmp/stderr" && echo yes || echo no)"
check "1 GiB entry: the prior runtime is byte-identical" "$before" "$(runtime_snapshot)"
check "1 GiB entry: no staging left behind" 0 "$(leftovers)"
rm -f "$tmp/bomb.tgz"

make_tarball "$tmp/many.tgz" manyfiles
write_manifest "$tmp/many.tgz"
QAREN_TEST_MODE=1 QAREN_MAX_UNPACKED_BYTES=200000 HOME="$tmp/home" \
  bash "$tmp/plugin/scripts/ensure-qaren.sh" --install --from-file "$tmp/many.tgz" >/dev/null 2>"$tmp/stderr"; rc=$?
check "on-disk size above the ceiling is refused after extraction" 1 "$rc"
check "on-disk size: named" yes "$(grep -q 'bytes on disk, above the unpacked-size ceiling' "$tmp/stderr" && echo yes || echo no)"
check "on-disk size: the prior runtime is byte-identical" "$before" "$(runtime_snapshot)"
check "on-disk size: no staging left behind" 0 "$(leftovers)"

# Every required tool is checked before anything is read, locked or written.
write_manifest "$tmp/good.tgz"
mkdir -p "$tmp/toolbox"
ln -sf "$tmp/stubs/uname" "$tmp/toolbox/uname"
for t in $REQUIRED_TOOLS node; do
  [ "$t" = uname ] || ln -sf "$(PATH="${PATH#"$tmp/stubs:"}" command -v "$t")" "$tmp/toolbox/$t"
done
for t in $REQUIRED_TOOLS; do
  stale_runtime
  before=$(runtime_snapshot)
  mv "$tmp/toolbox/$t" "$tmp/toolbox/.$t"
  out=$(HOME="$tmp/home" PATH="$tmp/toolbox" "$BASH" "$tmp/plugin/scripts/ensure-qaren.sh" --install --from-file "$tmp/good.tgz" 2>&1); rc=$?
  hook_out=$(HOME="$tmp/home" PATH="$tmp/toolbox" "$BASH" "$tmp/plugin/scripts/ensure-qaren.sh" --print-bin 2>&1); hook_rc=$?
  mv "$tmp/toolbox/.$t" "$tmp/toolbox/$t"
  check "no $t: install refused" "1 ensure-qaren: required tool not found: $t" "$rc $out"
  check "no $t: print-bin says so and exits 0" "0 qaren: required tool not found: $t" "$hook_rc $hook_out"
  check "no $t: the prior runtime is byte-identical" "$before" "$(runtime_snapshot)"
  check "no $t: no staging and no lock taken" "0 no" "$(leftovers) $([ -e "$(LOCKFILE_PATH)" ] && echo yes || echo no)"
done

# Without an absolute HOME there is nowhere safe to install.
out=$(HOME= bash "$tmp/plugin/scripts/ensure-qaren.sh" --install --from-file "$tmp/good.tgz" 2>&1); rc=$?
check "empty HOME refuses the install" 1 "$rc"
check "empty HOME names the reason" yes "$(grep -q 'HOME is not an absolute path' <<< "$out" && echo yes || echo no)"

# No qaren asset for this host refuses the install.
reset_home
printf '{"version":"%s","assets":{"ios":[],"android":[]}}\n' "$VERSION" > "$tmp/plugin/runner-manifest.json"
run_install "$tmp/good.tgz" >/dev/null; rc=$?
check "no asset for this host refuses" 1 "$rc"
check "no asset: nothing installed" no "$([ -e "$DEST" ] && echo yes || echo no)"

[ -f "$tmp/sleep-pids" ] && kill $(cat "$tmp/sleep-pids") 2>/dev/null
exit "$fail"
