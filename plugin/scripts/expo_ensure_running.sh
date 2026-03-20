#!/bin/bash
# expo_ensure_running.sh — Ensure the app is installed, launched, and Metro is running
#
# Handles three modes:
#   1. No artifact_path: trigger local dev build (npx expo run:ios/android)
#   2. .tar.gz artifact: extract .app, install on iOS simulator, launch
#   3. .apk artifact: install on Android emulator, launch
#
# In all modes, ensures Metro is running (starts it if not).
#
# Usage: bash scripts/expo_ensure_running.sh <platform> [OPTIONS]
#   --artifact <path>     Path to .tar.gz (iOS) or .apk (Android)
#   --bundle-id <id>      App bundle ID (auto-read from app.json if omitted)
#   --metro-port <port>   Metro port override (default: auto-detect)
#   --start-metro         Start Metro if not running (default: true)
#
# Exit codes:
#   0 — app running with Metro attached
#   1 — no booted simulator/emulator found
#   2 — Metro failed to start within timeout
#   3 — install failed (artifact corrupt or incompatible)
#   4 — local build failed
#
# Stdout is always valid JSON. Diagnostics go to stderr.

set -euo pipefail

PLATFORM="${1:-}"
shift || true
ARTIFACT_PATH=""
BUNDLE_ID=""
METRO_PORT=""
START_METRO="true"

METRO_PORTS=(8081 8082 19000 19006)
METRO_TIMEOUT_S=30
METRO_POLL_INTERVAL_S=2
TMP_DIR=$(mktemp -d /tmp/rn-dev-agent.XXXXXX)
trap 'rm -rf "$TMP_DIR"' EXIT

json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  s="${s//$'\t'/\\t}"
  printf '%s' "$s"
}

json_ok() {
  local port="${1:-0}"
  local installed="${2:-false}"
  printf '{"status":"ok","metro_port":%d,"platform":"%s","installed_fresh":%s}\n' "$port" "$PLATFORM" "$installed"
}

json_error() {
  local msg; msg=$(json_escape "$2")
  printf '{"status":"error","code":%d,"message":"%s"}\n' "$1" "$msg" >&2
  printf '{"status":"error","code":%d,"message":"%s"}\n' "$1" "$msg"
  exit "$1"
}

# --- Argument parsing ---

while [[ $# -gt 0 ]]; do
  case "$1" in
    --artifact) ARTIFACT_PATH="$2"; shift 2 ;;
    --bundle-id) BUNDLE_ID="$2"; shift 2 ;;
    --metro-port) METRO_PORT="$2"; shift 2 ;;
    --start-metro) START_METRO="$2"; shift 2 ;;
    *) shift ;;
  esac
done

if [ -n "$BUNDLE_ID" ]; then
  if ! [[ "$BUNDLE_ID" =~ ^[a-zA-Z][a-zA-Z0-9_.]*$ ]]; then
    json_error 1 "Invalid bundle ID '$BUNDLE_ID': must match ^[a-zA-Z][a-zA-Z0-9_.]*$"
  fi
fi

if [ -z "$PLATFORM" ] || { [ "$PLATFORM" != "ios" ] && [ "$PLATFORM" != "android" ]; }; then
  json_error 1 "Usage: expo_ensure_running.sh <ios|android> [--artifact <path>] [--bundle-id <id>]"
fi

mkdir -p "$TMP_DIR"

# --- Bundle ID resolution ---

resolve_bundle_id() {
  if [ -n "$BUNDLE_ID" ]; then return 0; fi

  if [ -f "app.json" ]; then
    if command -v jq &>/dev/null; then
      if [ "$PLATFORM" = "ios" ]; then
        BUNDLE_ID=$(jq -r '.expo.ios.bundleIdentifier // .ios.bundleIdentifier // empty' app.json 2>/dev/null || true)
      else
        BUNDLE_ID=$(jq -r '.expo.android.package // .android.package // empty' app.json 2>/dev/null || true)
      fi
    elif command -v node &>/dev/null; then
      BUNDLE_ID=$(node -e "
        const a = require('./app.json');
        const p = '${PLATFORM}';
        const id = p === 'ios'
          ? (a.expo?.ios?.bundleIdentifier || a.ios?.bundleIdentifier)
          : (a.expo?.android?.package || a.android?.package);
        if (id) console.log(id);
      " 2>/dev/null || true)
    fi
  fi

  if [ -z "$BUNDLE_ID" ] && { [ -f "app.config.js" ] || [ -f "app.config.ts" ]; }; then
    echo "Warning: Cannot auto-parse app.config.js/ts. Pass --bundle-id explicitly." >&2
  fi

  if [ -z "$BUNDLE_ID" ]; then
    echo "Warning: Could not resolve bundle ID. Some operations may fail." >&2
  fi
}

# --- Platform detection ---

detect_device() {
  if [ "$PLATFORM" = "ios" ]; then
    if ! xcrun simctl list devices booted 2>/dev/null | grep -q "Booted"; then
      json_error 1 "No booted iOS simulator found. Run: xcrun simctl boot 'iPhone 16 Pro'"
    fi
  else
    if ! adb devices 2>/dev/null | grep -q "device$"; then
      json_error 1 "No connected Android emulator/device found. Start an emulator from Android Studio."
    fi
    # Handle multiple devices
    local device_count
    device_count=$(adb devices 2>/dev/null | grep -c "device$" || true)
    if [ "$device_count" -gt 1 ] && [ -z "${ANDROID_SERIAL:-}" ]; then
      export ANDROID_SERIAL
      ANDROID_SERIAL=$(adb devices | grep -m1 "device$" | awk '{print $1}')
      echo "Warning: Multiple Android devices ($device_count). Auto-selecting $ANDROID_SERIAL." >&2
    fi
  fi
}

# --- Metro management ---

find_metro_port() {
  local ports_to_check=("${METRO_PORTS[@]}")
  if [ -n "$METRO_PORT" ]; then
    ports_to_check=("$METRO_PORT" "${METRO_PORTS[@]}")
  fi

  for port in "${ports_to_check[@]}"; do
    if curl -sf "http://127.0.0.1:${port}/status" 2>/dev/null | grep -q "packager-status:running"; then
      echo "$port"
      return 0
    fi
  done
  return 1
}

start_metro() {
  echo "Starting Metro bundler..." >&2
  local port="${METRO_PORT:-8081}"

  npx expo start --port "$port" > "$TMP_DIR/metro.log" 2>&1 &
  local metro_pid=$!
  echo "$metro_pid" > "$TMP_DIR/metro.pid"
  echo "Metro started (PID $metro_pid), waiting for readiness..." >&2

  local elapsed=0
  while [ "$elapsed" -lt "$METRO_TIMEOUT_S" ]; do
    if curl -sf "http://127.0.0.1:${port}/status" 2>/dev/null | grep -q "packager-status:running"; then
      echo "Metro is ready on port $port" >&2
      echo "$port"
      return 0
    fi
    sleep "$METRO_POLL_INTERVAL_S"
    elapsed=$((elapsed + METRO_POLL_INTERVAL_S))
  done

  echo "Metro startup log (last 20 lines):" >&2
  tail -20 "$TMP_DIR/metro.log" >&2 2>/dev/null || true
  return 1
}

ensure_metro() {
  if [ "$START_METRO" != "true" ]; then return 0; fi

  local port
  port=$(find_metro_port) && {
    echo "Metro already running on port $port" >&2
    METRO_PORT="$port"
    return 0
  }

  METRO_PORT=$(start_metro) || json_error 2 "Metro failed to start within ${METRO_TIMEOUT_S}s. Check $TMP_DIR/metro.log"
}

# --- Artifact installation ---

install_ios_artifact() {
  local artifact="$1"
  local app_dir="$TMP_DIR/ios-app-$$"
  rm -rf "$app_dir" && mkdir -p "$app_dir"

  echo "Extracting iOS artifact: $artifact" >&2

  if [[ "$artifact" == *.tar.gz ]] || [[ "$artifact" == *.tgz ]]; then
    local bad_entries
    bad_entries=$(tar -tzf "$artifact" 2>/dev/null | grep -E '(^\.\.|/\.\.|^/)' || true)
    if [ -n "$bad_entries" ]; then
      json_error 3 "Artifact rejected: contains unsafe paths (path traversal or absolute): $artifact"
    fi
    tar -xzf "$artifact" -C "$app_dir" 2>/dev/null || json_error 3 "Failed to extract .tar.gz: $artifact"
    while IFS= read -r -d '' link; do
      local target
      target=$(readlink "$link")
      if [[ "$target" == /* ]] || [[ "$target" == ../* ]] || [[ "$target" == */../* ]] || [[ "$target" == .. ]]; then
        json_error 3 "Artifact rejected: symlink escapes extraction dir: $link -> $target"
      fi
    done < <(find "$app_dir" -type l -print0 2>/dev/null)
  elif [[ "$artifact" == *.app ]]; then
    cp -R "$artifact" "$app_dir/"
  else
    json_error 3 "Unsupported iOS artifact format: $artifact. Expected .tar.gz or .app"
  fi

  local app_path
  app_path=$(find "$app_dir" -maxdepth 2 -name "*.app" -type d | head -1)

  if [ -z "$app_path" ]; then
    json_error 3 "No .app bundle found inside artifact: $artifact"
  fi

  echo "Installing $app_path on simulator..." >&2
  xcrun simctl install booted "$app_path" || json_error 3 "simctl install failed for $app_path"

  if [ -n "$BUNDLE_ID" ]; then
    echo "Launching $BUNDLE_ID..." >&2
    xcrun simctl launch booted "$BUNDLE_ID" 2>/dev/null || {
      echo "Warning: simctl launch failed for $BUNDLE_ID. App may need manual launch." >&2
    }
  else
    echo "Warning: No bundle ID resolved. Cannot auto-launch app." >&2
  fi

  rm -rf "$app_dir"
}

install_android_artifact() {
  local artifact="$1"

  if [[ "$artifact" != *.apk ]]; then
    json_error 3 "Unsupported Android artifact: $artifact. Expected .apk (AAB cannot be sideloaded)."
  fi

  echo "Installing $artifact on emulator..." >&2
  adb install -r "$artifact" || json_error 3 "adb install failed for $artifact"

  if [ -n "$BUNDLE_ID" ]; then
    echo "Launching $BUNDLE_ID..." >&2
    adb shell am start -n "${BUNDLE_ID}/.MainActivity" 2>/dev/null || \
      adb shell monkey -p "$BUNDLE_ID" -c android.intent.category.LAUNCHER 1 2>/dev/null || {
        echo "Warning: Failed to launch $BUNDLE_ID. App may need manual launch." >&2
      }
  else
    echo "Warning: No bundle ID resolved. Cannot auto-launch app." >&2
  fi
}

# --- Local dev build ---

local_dev_build() {
  echo "Running local dev build for $PLATFORM..." >&2

  if [ "$PLATFORM" = "ios" ]; then
    npx expo run:ios 2>&1 | tee "$TMP_DIR/build-ios.log" >&2 || {
      echo "iOS build failed. Last 20 lines:" >&2
      tail -20 "$TMP_DIR/build-ios.log" >&2 2>/dev/null || true
      json_error 4 "Local iOS build failed. Check $TMP_DIR/build-ios.log"
    }
  else
    npx expo run:android 2>&1 | tee "$TMP_DIR/build-android.log" >&2 || {
      echo "Android build failed. Last 20 lines:" >&2
      tail -20 "$TMP_DIR/build-android.log" >&2 2>/dev/null || true
      json_error 4 "Local Android build failed. Check $TMP_DIR/build-android.log"
    }
  fi
}

# --- Main flow ---

resolve_bundle_id
detect_device
ensure_metro

INSTALLED_FRESH="false"

if [ -n "$ARTIFACT_PATH" ]; then
  # EAS artifact path — install provided artifact
  if [ ! -f "$ARTIFACT_PATH" ] && [ ! -d "$ARTIFACT_PATH" ]; then
    json_error 3 "Artifact not found: $ARTIFACT_PATH"
  fi

  if [ "$PLATFORM" = "ios" ]; then
    install_ios_artifact "$ARTIFACT_PATH"
  else
    install_android_artifact "$ARTIFACT_PATH"
  fi
  INSTALLED_FRESH="true"
else
  # Local dev build path — build from source
  local_dev_build
  INSTALLED_FRESH="true"
fi

json_ok "${METRO_PORT:-8081}" "$INSTALLED_FRESH"
