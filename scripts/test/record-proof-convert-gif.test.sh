#!/usr/bin/env bash
# Regression test for record_proof.sh cmd_convert_gif (GH#377) — an explicit
# gifPath pointing into a not-yet-existing directory must succeed: the command
# must mkdir -p the output's parent before invoking ffmpeg, mirroring
# cmd_start/cmd_stop. When the parent cannot be created (path component is a
# file), it must fail with an honest error naming the directory.
#
# Uses a PATH-stubbed ffmpeg that mimics the real binary: it can only write
# the output file if the parent directory already exists.
#
# Run: bash scripts/test/record-proof-convert-gif.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RECORD="$SCRIPT_DIR/record_proof.sh"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

mkdir -p "$tmp/bin"
cat > "$tmp/bin/ffmpeg" <<'EOF'
#!/usr/bin/env bash
# Fake ffmpeg: last argument is the output path (record_proof.sh always
# passes it last). Like the real binary, fail if the parent dir is missing.
out=""
for a in "$@"; do out="$a"; done
if [ ! -d "$(dirname "$out")" ]; then
  echo "$out: No such file or directory" >&2
  exit 1
fi
printf 'GIF89a-fake' > "$out"
EOF
chmod +x "$tmp/bin/ffmpeg"
export PATH="$tmp/bin:$PATH"

printf 'fake-video' > "$tmp/input.mov"

fail=0

# Case 1 (GH#377): explicit output path in a fresh, nonexistent directory.
out_gif="$tmp/fresh/nested/clip.gif"
if bash "$RECORD" convert-gif "$tmp/input.mov" "$out_gif" >/dev/null 2>&1 \
  && [ -s "$out_gif" ]; then
  echo "ok: convert-gif creates missing parent dirs for explicit gifPath"
else
  echo "FAIL: convert-gif did not create output in a fresh directory"
  fail=1
fi

# Case 2: existing directory keeps working (the default-gifPath path).
out_gif2="$tmp/clip2.gif"
if bash "$RECORD" convert-gif "$tmp/input.mov" "$out_gif2" >/dev/null 2>&1 \
  && [ -s "$out_gif2" ]; then
  echo "ok: convert-gif still works when the parent dir exists"
else
  echo "FAIL: convert-gif broke for an existing parent dir"
  fail=1
fi

# Case 3: uncreatable parent (a path component is a regular file) must fail
# loudly, naming the directory it could not create.
printf 'blocker' > "$tmp/blocker"
err="$(bash "$RECORD" convert-gif "$tmp/input.mov" "$tmp/blocker/clip.gif" 2>&1 >/dev/null)"
rc=$?
if [ "$rc" -ne 0 ] && printf '%s' "$err" | grep -qF "$tmp/blocker"; then
  echo "ok: uncreatable parent fails with an error naming the directory"
else
  echo "FAIL: uncreatable parent did not produce an honest error (rc=$rc, err=$err)"
  fail=1
fi

if [ "$fail" -eq 0 ]; then
  echo "PASS: record-proof-convert-gif.test.sh"
else
  echo "FAILED: record-proof-convert-gif.test.sh"
fi
exit "$fail"
