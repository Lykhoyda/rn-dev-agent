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
chmod +x "$tmp/stubs/uname"
export PATH="$tmp/stubs:$PATH"

# make_tarball <out> <kind>: good | dotdot | absolute | symlink | stray
make_tarball() {
  python3 - "$1" "$2" "$TOP" "$tmp" <<'PY'
import io, sys, tarfile
out, kind, top, tmp = sys.argv[1:]
def add(tar, name, data=b"", mode=0o644, kind=tarfile.REGTYPE, link=""):
    info = tarfile.TarInfo(name)
    info.type, info.mode, info.size, info.linkname = kind, mode, len(data), link
    tar.addfile(info, io.BytesIO(data) if kind == tarfile.REGTYPE else None)
with tarfile.open(out, "w:gz", format=tarfile.USTAR_FORMAT) as tar:
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
  find "$tmp/home/.qaren/runtime" -mindepth 1 -maxdepth 1 -name '.install.*' 2>/dev/null | wc -l | tr -d ' '
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

# No qaren asset for this host refuses the install.
reset_home
printf '{"version":"%s","assets":{"ios":[],"android":[]}}\n' "$VERSION" > "$tmp/plugin/runner-manifest.json"
run_install "$tmp/good.tgz" >/dev/null; rc=$?
check "no asset for this host refuses" 1 "$rc"
check "no asset: nothing installed" no "$([ -e "$DEST" ] && echo yes || echo no)"

exit "$fail"
