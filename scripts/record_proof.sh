#!/usr/bin/env bash
set -euo pipefail

PID_PREFIX="/tmp/rn-dev-agent-record"

usage() {
  cat <<'EOF'
Usage: record_proof.sh <subcommand> [args]

Subcommands:
  start <platform> <output-path>   Start background video recording
  stop                             Stop all active recordings
  status                           Show active recordings
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

is_alive() {
  local pid="$1"
  kill -0 "$pid" 2>/dev/null
}

cmd_start() {
  local platform="${1:-}"
  local output_path="${2:-}"

  [[ -z "$platform" || -z "$output_path" ]] && { echo "Error: start requires <platform> <output-path>" >&2; exit 1; }
  [[ "$platform" != "ios" && "$platform" != "android" ]] && { echo "Error: platform must be ios or android" >&2; exit 1; }

  local pf
  pf="$(pid_file "$platform")"
  if [[ -f "$pf" ]] && is_alive "$(cat "$pf")"; then
    echo "Error: Recording already in progress for $platform (PID $(cat "$pf"))" >&2
    exit 1
  fi

  mkdir -p "$(dirname "$output_path")"
  output_path="$(cd "$(dirname "$output_path")" && pwd)/$(basename "$output_path")"

  if [[ "$platform" == "ios" ]]; then
    if ! xcrun simctl list devices booted 2>/dev/null | grep -q "Booted"; then
      echo "Error: No iOS simulator booted" >&2
      exit 1
    fi
    xcrun simctl io booted recordVideo --force "$output_path" &
    local rec_pid=$!
  else
    if ! adb devices 2>/dev/null | grep -q "device$"; then
      echo "Error: No Android device connected" >&2
      exit 1
    fi
    local device_path="/sdcard/rn-dev-agent-proof-$$.mp4"
    adb shell screenrecord "$device_path" &
    local rec_pid=$!
  fi

  sleep 0.5
  if ! is_alive "$rec_pid"; then
    echo "Error: Recording process died immediately" >&2
    rm -f "$pf" "$(path_file "$platform")" "${PID_PREFIX}-${platform}.device-path"
    exit 1
  fi

  echo "$rec_pid" > "$pf"
  echo "$output_path" > "$(path_file "$platform")"
  [[ "$platform" == "android" ]] && echo "$device_path" > "${PID_PREFIX}-${platform}.device-path"
  echo "Recording started: platform=$platform pid=$rec_pid output=$output_path"
}

cmd_stop() {
  local found=false
  local saved_paths=()

  for pf in "${PID_PREFIX}"-*.pid; do
    [[ -f "$pf" ]] || continue
    found=true

    local platform
    platform="$(basename "$pf" .pid | sed "s/^$(basename "$PID_PREFIX")-//")"
    local pid
    pid="$(cat "$pf")"
    local output_path=""
    local pathf
    pathf="$(path_file "$platform")"
    [[ -f "$pathf" ]] && output_path="$(cat "$pathf")"

    if is_alive "$pid"; then
      kill -INT "$pid" 2>/dev/null || true

      local waited=0
      while is_alive "$pid" && [[ $waited -lt 10 ]]; do
        sleep 0.5
        waited=$((waited + 1))
      done

      if is_alive "$pid"; then
        echo "Warning: Recording process $pid did not stop gracefully, force killing" >&2
        kill -9 "$pid" 2>/dev/null || true
        wait "$pid" 2>/dev/null || true
        sleep 3
      fi
    fi

    if [[ "$platform" == "android" && -n "$output_path" ]]; then
      local device_pathf="${PID_PREFIX}-${platform}.device-path"
      if [[ -f "$device_pathf" ]]; then
        local device_path
        device_path="$(cat "$device_pathf")"
        sleep 2
        adb pull "$device_path" "$output_path" 2>/dev/null || echo "Warning: Failed to pull recording from device" >&2
        adb shell rm -f "$device_path" 2>/dev/null || true
        rm -f "$device_pathf"
      fi
    fi

    rm -f "$pf" "$pathf"

    if [[ -n "$output_path" && -f "$output_path" ]]; then
      local size
      size="$(wc -c < "$output_path" | tr -d ' ')"
      echo "Saved: $output_path ($size bytes)"
      saved_paths+=("$output_path")
    else
      echo "Warning: Recording for $platform may not have saved correctly" >&2
    fi
  done

  if [[ "$found" == "false" ]]; then
    echo "No active recordings found"
  fi

  for p in "${saved_paths[@]+"${saved_paths[@]}"}"; do
    echo "$p"
  done
}

cmd_status() {
  local found=false
  for pf in "${PID_PREFIX}"-*.pid; do
    [[ -f "$pf" ]] || continue
    found=true
    local platform
    platform="$(basename "$pf" .pid | sed "s/^$(basename "$PID_PREFIX")-//")"
    local pid
    pid="$(cat "$pf")"
    local status="dead"
    is_alive "$pid" && status="recording"
    local pathf
    pathf="$(path_file "$platform")"
    local output=""
    [[ -f "$pathf" ]] && output="$(cat "$pathf")"
    echo "$platform: pid=$pid status=$status output=$output"
  done
  [[ "$found" == "false" ]] && echo "No active recordings"
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
  local VENV_DIR="${TMPDIR:-/tmp}/rn-dev-agent-pil-venv"

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
BAR_HEIGHT = 70
BG_COLOR = (24, 24, 32)
TEXT_COLOR = (255, 255, 255)

# Try to load a good font
font = None
for fp in [
    "/System/Library/Fonts/Helvetica.ttc",
    "/System/Library/Fonts/SFNSMono.ttf",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
]:
    try:
        font = ImageFont.truetype(fp, 26)
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
  stop)        cmd_stop ;;
  status)      cmd_status ;;
  convert-gif) shift; cmd_convert_gif "$@" ;;
  label)       shift; cmd_label "$@" ;;
  *)           usage ;;
esac
