#!/usr/bin/env bash
set -euo pipefail

PID_PREFIX="/tmp/rn-dev-agent-record"
RAW_PREFIX="/tmp/rn-dev-agent-raw"

usage() {
  cat <<'EOF'
Usage: record_proof.sh <subcommand> [args]

Subcommands:
  start <platform> <output-path> --scope <id>  Start a scoped recording
  bind-identity <scope> <pid> <birth>          Bind process identity
  stop <scope> <pid> <birth>                   Stop one scoped recording
  status <scope>                               Show one scoped recording
  convert-gif <input> <output>     Convert video to GIF (requires ffmpeg)
  label <input> <output> <labels-json>
    Add timed text labels to a recorded video.
    Labels are rendered in a dedicated bar below the video content.
    <labels-json>: JSON array of [{"start": 0, "end": 4, "text": "..."}]
    Requires: ffmpeg + python3 + Pillow (auto-installed in venv if missing)

Platforms: ios, android
EOF
  exit 1
}

pid_file() { echo "${PID_PREFIX}-${1}.pid"; }
path_file() { echo "${PID_PREFIX}-${1}.path"; }
platform_file() { echo "${PID_PREFIX}-${1}.platform"; }
birth_file() { echo "${PID_PREFIX}-${1}.birth"; }

is_alive() {
  local pid="$1"
  kill -0 "$pid" 2>/dev/null
}

cmd_start() {
  local platform="${1:-}"
  local output_path="${2:-}"
  shift 2 2>/dev/null || true

  [[ -z "$platform" || -z "$output_path" ]] && { echo "Error: start requires <platform> <output-path>" >&2; exit 1; }
  [[ "$platform" != "ios" && "$platform" != "android" ]] && { echo "Error: platform must be ios or android" >&2; exit 1; }

  # GH #173 sub-issue 1: optional explicit target identifier for multi-device
  # scenarios. `--udid <UDID>` for iOS (passed verbatim to `simctl io`),
  # `--serial <SERIAL>` for Android (passed to `adb -s`). The TS handler at
  # device-record.ts:resolveTargetDevice does pre-flight ambiguity detection
  # and only forwards an identifier when there are 2+ candidates; the
  # single-device case still uses the implicit `booted`/auto resolver below.
  local target_id=""
  local scope=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --udid|--serial)
        target_id="${2:-}"
        [[ -z "$target_id" ]] && { echo "Error: $1 requires a value" >&2; exit 1; }
        shift 2
        ;;
      --scope)
        scope="${2:-}"
        [[ ! "$scope" =~ ^[a-f0-9]{64}$ ]] && { echo "Error: invalid recording scope" >&2; exit 1; }
        shift 2
        ;;
      *)
        echo "Error: unknown flag '$1' for start" >&2
        exit 1
        ;;
    esac
  done
  [[ -z "$scope" ]] && { echo "Error: start requires --scope" >&2; exit 1; }

  local pf
  pf="$(pid_file "$scope")"
  if [[ -f "$pf" ]] && is_alive "$(cat "$pf")"; then
    echo "Error: Recording already in progress for $platform (PID $(cat "$pf"))" >&2
    exit 1
  fi

  mkdir -p "$(dirname "$output_path")"
  output_path="$(cd "$(dirname "$output_path")" && pwd)/$(basename "$output_path")"

  # Record to temp file in native format; stop will convert to MP4
  local raw_file="${RAW_PREFIX}-${platform}-$$.mov"
  local recorder_log="${PID_PREFIX}-${scope}.log"

  if [[ "$platform" == "ios" ]]; then
    if ! xcrun simctl list devices booted 2>/dev/null | grep -q "Booted"; then
      echo "Error: No iOS simulator booted" >&2
      exit 1
    fi
    local ios_target="${target_id:-booted}"
    xcrun simctl io "$ios_target" recordVideo --force "$raw_file" > "$recorder_log" 2>&1 &
    local rec_pid=$!
  else
    raw_file="${RAW_PREFIX}-${platform}-$$.mp4"
    if ! adb devices 2>/dev/null | grep -q "device$"; then
      echo "Error: No Android device connected" >&2
      exit 1
    fi
    local device_path="/sdcard/rn-dev-agent-proof-$$.mp4"
    local -a adb_args=()
    [[ -n "$target_id" ]] && adb_args+=(-s "$target_id")
    if [[ -n "$(adb "${adb_args[@]+"${adb_args[@]}"}" shell pidof screenrecord 2>/dev/null || true)" ]]; then
      echo "Error: A screenrecord process already owns this device" >&2
      exit 1
    fi
    if [[ -n "$target_id" ]]; then
      adb -s "$target_id" shell screenrecord "$device_path" > "$recorder_log" 2>&1 &
    else
      adb shell screenrecord "$device_path" > "$recorder_log" 2>&1 &
    fi
    local rec_pid=$!
  fi

  sleep 0.5
  if ! is_alive "$rec_pid"; then
    echo "Error: Recording process died immediately" >&2
    [[ -s "$recorder_log" ]] && sed -n '1,20p' "$recorder_log" >&2
    rm -f "$pf" "$(path_file "$scope")" "${PID_PREFIX}-${scope}.device-path" "$recorder_log"
    exit 1
  fi

  echo "$rec_pid" > "$pf"
  echo "$platform" > "$(platform_file "$scope")"
  echo "$output_path" > "$(path_file "$scope")"
  echo "$raw_file" > "${PID_PREFIX}-${scope}.raw-path"
  [[ "$platform" == "android" ]] && echo "$device_path" > "${PID_PREFIX}-${scope}.device-path"
  # Persist the Android serial so the stop path scopes pkill/pull/rm to
  # the same device. Unconditionally write or clear — leaving a stale
  # sidecar from a prior recording would misroute this stop to a now-
  # disconnected device.
  if [[ "$platform" == "android" ]]; then
    if [[ -n "$target_id" ]]; then
      echo "$target_id" > "${PID_PREFIX}-${scope}.serial"
    else
      rm -f "${PID_PREFIX}-${scope}.serial"
    fi
    local remote_pid
    remote_pid="$(adb "${adb_args[@]+"${adb_args[@]}"}" shell pidof screenrecord 2>/dev/null | tr -d '\r' | xargs)"
    [[ ! "$remote_pid" =~ ^[0-9]+$ ]] && { echo "Error: Could not bind the device-side screenrecord PID" >&2; exit 1; }
    echo "$remote_pid" > "${PID_PREFIX}-${scope}.remote-pid"
  fi
  echo "Recording started: platform=$platform pid=$rec_pid output=$output_path"
}

cmd_bind_identity() {
  local scope="${1:-}"
  local pid="${2:-}"
  local birth="${3:-}"
  [[ ! "$scope" =~ ^[a-f0-9]{64}$ || ! "$pid" =~ ^[0-9]+$ || -z "$birth" ]] && {
    echo "Error: bind-identity requires valid <scope> <pid> <birth>" >&2
    exit 1
  }
  [[ ! -f "$(pid_file "$scope")" || "$(cat "$(pid_file "$scope")")" != "$pid" ]] && {
    echo "Error: recording PID does not match scope" >&2
    exit 1
  }
  echo "$birth" > "$(birth_file "$scope")"
}

cmd_stop() {
  local scope="${1:-}"
  local expected_pid="${2:-}"
  local expected_birth="${3:-}"
  [[ ! "$scope" =~ ^[a-f0-9]{64}$ || ! "$expected_pid" =~ ^[0-9]+$ || -z "$expected_birth" ]] && {
    echo "Error: stop requires valid <scope> <pid> <birth>" >&2
    exit 1
  }
  local pf
  pf="$(pid_file "$scope")"
  [[ ! -f "$pf" ]] && { echo "No active recordings found"; return; }
  local pid
  pid="$(cat "$pf")"
  local birth="unbound"
  [[ -f "$(birth_file "$scope")" ]] && birth="$(cat "$(birth_file "$scope")")"
  [[ "$pid" != "$expected_pid" || "$birth" != "$expected_birth" ]] && {
    echo "Error: recording identity does not match scope" >&2
    exit 1
  }
  local platform
  platform="$(cat "$(platform_file "$scope")")"
  local pathf
  pathf="$(path_file "$scope")"
  local output_path=""
  [[ -f "$pathf" ]] && output_path="$(cat "$pathf")"
  local raw_pathf="${PID_PREFIX}-${scope}.raw-path"
  local raw_file=""
  [[ -f "$raw_pathf" ]] && raw_file="$(cat "$raw_pathf")"

  if is_alive "$pid"; then
    kill -INT "$pid"
    local waited=0
    while is_alive "$pid" && [[ $waited -lt 10 ]]; do
      sleep 0.5
      waited=$((waited + 1))
    done
    if is_alive "$pid"; then
      kill -9 "$pid"
      sleep 3
    fi
  fi
  sleep 1

  if [[ "$platform" == "android" ]]; then
    local -a adb_args=()
    local serialf="${PID_PREFIX}-${scope}.serial"
    [[ -f "$serialf" ]] && adb_args+=(-s "$(cat "$serialf")")
    local remote_pidf="${PID_PREFIX}-${scope}.remote-pid"
    if [[ -f "$remote_pidf" ]]; then
      local remote_pid
      remote_pid="$(cat "$remote_pidf")"
      [[ "$remote_pid" =~ ^[0-9]+$ ]] && adb "${adb_args[@]+"${adb_args[@]}"}" shell kill -2 "$remote_pid" 2>/dev/null || true
    fi
    local device_pathf="${PID_PREFIX}-${scope}.device-path"
    if [[ -f "$device_pathf" ]]; then
      local device_path
      device_path="$(cat "$device_pathf")"
      sleep 2
      adb "${adb_args[@]+"${adb_args[@]}"}" pull "$device_path" "$raw_file" >/dev/null 2>&1 || echo "Warning: Failed to pull recording from device" >&2
      adb "${adb_args[@]+"${adb_args[@]}"}" shell rm -f "$device_path" 2>/dev/null || true
    fi
  fi

  output_path="${output_path%.*}.mp4"
  mkdir -p "$(dirname "$output_path")" || true
  if [[ -n "$raw_file" && -f "$raw_file" ]]; then
    if command -v ffmpeg >/dev/null 2>&1; then
      local tmp_mp4="/tmp/rn-dev-agent-convert-$$.mp4"
      if ffmpeg -y -i "$raw_file" -c copy -movflags +faststart "$tmp_mp4" 2>/dev/null; then
        mv "$tmp_mp4" "$output_path"
      else
        mv "$raw_file" "${output_path%.mp4}.mov"
        output_path="${output_path%.mp4}.mov"
        rm -f "$tmp_mp4"
      fi
    elif [[ "$platform" == "ios" ]]; then
      mv "$raw_file" "${output_path%.mp4}.mov"
      output_path="${output_path%.mp4}.mov"
    else
      mv "$raw_file" "$output_path"
    fi
    rm -f "$raw_file"
  fi

  rm -f "${PID_PREFIX}-${scope}".{pid,path,platform,birth,raw-path,log,serial,remote-pid,device-path}
  if [[ -n "$output_path" && -f "$output_path" ]]; then
    local size
    size="$(wc -c < "$output_path" | tr -d ' ')"
    echo "Saved: $output_path ($size bytes)"
  else
    echo "Warning: Recording for $platform may not have saved correctly" >&2
  fi
}

cmd_status() {
  local scope="${1:-}"
  [[ ! "$scope" =~ ^[a-f0-9]{64}$ ]] && { echo "Error: invalid recording scope" >&2; exit 1; }
  local pf
  pf="$(pid_file "$scope")"
  [[ ! -f "$pf" ]] && { echo "No active recordings"; return; }
  local pid
  pid="$(cat "$pf")"
  local platform
  platform="$(cat "$(platform_file "$scope")")"
  local birth="unbound"
  [[ -f "$(birth_file "$scope")" ]] && birth="$(cat "$(birth_file "$scope")")"
  local status="dead"
  is_alive "$pid" && status="recording"
  local output=""
  [[ -f "$(path_file "$scope")" ]] && output="$(cat "$(path_file "$scope")")"
  echo "$platform: pid=$pid birth=$birth status=$status output=$output"
}

cmd_convert_gif() {
  local input="${1:-}"
  local output="${2:-}"

  [[ -z "$input" || -z "$output" ]] && { echo "Error: convert-gif requires <input> <output>" >&2; exit 1; }
  [[ ! -f "$input" ]] && { echo "Error: Input file not found: $input" >&2; exit 1; }

  if ! command -v ffmpeg >/dev/null 2>&1; then
    echo "Warning: ffmpeg not available. Skipping GIF conversion." >&2
    echo "Install: brew install ffmpeg" >&2
    exit 0
  fi

  if ! mkdir -p "$(dirname "$output")" 2>/dev/null; then
    echo "Error: Could not create output directory: $(dirname "$output")" >&2
    exit 1
  fi

  ffmpeg -i "$input" -vf "fps=10,scale=360:-1:flags=lanczos" -y "$output" 2>/dev/null

  local size
  size="$(wc -c < "$output" | tr -d ' ')"
  echo "GIF created: $output ($size bytes)"
}

cmd_label() {
  local input="${1:-}"
  local output="${2:-}"
  local labels_json="${3:-}"

  [[ -z "$input" || -z "$output" || -z "$labels_json" ]] && {
    echo "Error: label requires <input> <output> <labels-json>" >&2
    echo "  labels-json: JSON array of [{\"start\":0,\"end\":4,\"text\":\"...\"}]" >&2
    exit 1
  }
  [[ ! -f "$input" ]] && { echo "Error: Input file not found: $input" >&2; exit 1; }

  if ! command -v ffmpeg >/dev/null 2>&1; then
    echo "Error: ffmpeg required for label. Install: brew install ffmpeg" >&2
    exit 1
  fi

  # Set up Python with Pillow
  local PYTHON=""
  local VENV_DIR="/tmp/rn-dev-agent-pil-venv"

  if python3 -c "from PIL import Image" 2>/dev/null; then
    PYTHON="python3"
  elif [[ -x "$VENV_DIR/bin/python3" ]] && "$VENV_DIR/bin/python3" -c "from PIL import Image" 2>/dev/null; then
    PYTHON="$VENV_DIR/bin/python3"
  else
    echo "Installing Pillow in venv..." >&2
    python3 -m venv "$VENV_DIR" 2>/dev/null
    "$VENV_DIR/bin/pip" install -q pillow 2>/dev/null
    PYTHON="$VENV_DIR/bin/python3"
  fi

  local work_dir
  work_dir="$(mktemp -d)"
  local frames_dir="$work_dir/frames"
  local labeled_dir="$work_dir/labeled"
  mkdir -p "$frames_dir" "$labeled_dir"

  # Get video FPS
  local fps
  fps=$(ffprobe -v quiet -print_format json -show_streams "$input" | \
    python3 -c "import json,sys;d=json.load(sys.stdin);s=[x for x in d['streams'] if x['codec_type']=='video'][0];r=s['r_frame_rate'].split('/');print(int(r[0])//int(r[1]))" 2>/dev/null || echo "30")

  # Use 10fps for processing (smooth enough, fast to process)
  local process_fps=10

  echo "Extracting frames at ${process_fps}fps..." >&2
  ffmpeg -y -i "$input" -vf "fps=$process_fps" "$frames_dir/frame_%04d.png" 2>/dev/null

  local frame_count
  frame_count=$(ls "$frames_dir"/frame_*.png 2>/dev/null | wc -l | tr -d ' ')
  echo "Processing $frame_count frames..." >&2

  "$PYTHON" - "$frames_dir" "$labeled_dir" "$labels_json" "$process_fps" << 'PYEOF'
import sys, os, glob, json
from PIL import Image, ImageDraw, ImageFont

frames_dir = sys.argv[1]
output_dir = sys.argv[2]
labels_json = sys.argv[3]
fps = int(sys.argv[4])

labels = json.loads(labels_json)

# Convert seconds to frame numbers
label_frames = []
for l in labels:
    label_frames.append((
        int(l["start"] * fps),
        int(l["end"] * fps),
        l["text"]
    ))

frames = sorted(glob.glob(f"{frames_dir}/frame_*.png"))
BAR_HEIGHT = 120
BG_COLOR = (24, 24, 32)
TEXT_COLOR = (255, 255, 255)

# Try to load a good font — large size for readability
font = None
for fp in [
    "/System/Library/Fonts/Helvetica.ttc",
    "/System/Library/Fonts/SFNSMono.ttf",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
]:
    try:
        font = ImageFont.truetype(fp, 42)
        break
    except:
        continue
if font is None:
    font = ImageFont.load_default()

for i, fpath in enumerate(frames):
    img = Image.open(fpath).convert("RGB")
    w, h = img.size

    # Create new image with bar at bottom
    new_img = Image.new("RGB", (w, h + BAR_HEIGHT), BG_COLOR)
    new_img.paste(img, (0, 0))

    # Find matching label
    label = None
    for start, end, text in label_frames:
        if start <= i < end:
            label = text
            break

    if label:
        draw = ImageDraw.Draw(new_img)
        bbox = draw.textbbox((0, 0), label, font=font)
        tw = bbox[2] - bbox[0]
        th = bbox[3] - bbox[1]
        tx = (w - tw) // 2
        ty = h + (BAR_HEIGHT - th) // 2
        draw.text((tx, ty), label, fill=TEXT_COLOR, font=font)

    out_path = f"{output_dir}/frame_{i:04d}.png"
    new_img.save(out_path)

print(f"Labeled {len(frames)} frames", file=sys.stderr)
PYEOF

  echo "Assembling labeled video..." >&2
  ffmpeg -y -framerate "$process_fps" -i "$labeled_dir/frame_%04d.png" \
    -c:v libx264 -pix_fmt yuv420p -preset fast "$output" 2>/dev/null

  rm -rf "$work_dir"

  local size
  size="$(wc -c < "$output" | tr -d ' ')"
  echo "Labeled video: $output ($size bytes)"
}

case "${1:-}" in
  start)       shift; cmd_start "$@" ;;
  bind-identity) shift; cmd_bind_identity "$@" ;;
  stop)        shift; cmd_stop "$@" ;;
  status)      shift; cmd_status "$@" ;;
  convert-gif) shift; cmd_convert_gif "$@" ;;
  label)       shift; cmd_label "$@" ;;
  *)           usage ;;
esac
