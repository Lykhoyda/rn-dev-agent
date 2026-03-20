#!/bin/bash
# eas_resolve_artifact.sh — Resolve an EAS build artifact for local installation
#
# Given a platform and optional profile, finds a ready-to-install artifact by checking:
#   Tier 1: Local cache (/tmp/rn-eas-builds/)
#   Tier 2: EAS servers (eas build:list + download)
#   Tier 3: Exit with "no artifact" status for manual resolution
#
# Usage: bash scripts/eas_resolve_artifact.sh <platform> [profile] [output_dir]
#   platform:   ios | android
#   profile:    EAS build profile name (optional, auto-selected if unambiguous)
#   output_dir: where to store downloaded artifacts (default: /tmp/rn-eas-builds)
#
# Exit codes:
#   0 — artifact resolved, JSON on stdout
#   1 — general failure
#   2 — ambiguous profiles, JSON with list on stdout
#   3 — eas CLI not available
#   4 — not an EAS project (no eas.json)
#
# Stdout is always valid JSON. Diagnostics go to stderr.

set -euo pipefail

PLATFORM="${1:-}"
PROFILE="${2:-}"
OUTPUT_DIR="${3:-}"
if [ -z "$OUTPUT_DIR" ]; then
  OUTPUT_DIR=$(mktemp -d /tmp/rn-eas-builds.XXXXXX)
  trap 'rm -rf "$OUTPUT_DIR"' EXIT
fi
CACHE_MAX_AGE_HOURS=24

if [ -n "$PROFILE" ]; then
  if ! [[ "$PROFILE" =~ ^[a-zA-Z0-9_-]+$ ]]; then
    printf '{"status":"error","code":1,"message":"Invalid profile name: must match ^[a-zA-Z0-9_-]+$"}\n' >&2
    printf '{"status":"error","code":1,"message":"Invalid profile name: must match ^[a-zA-Z0-9_-]+$"}\n'
    exit 1
  fi
fi

json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  s="${s//$'\t'/\\t}"
  printf '%s' "$s"
}

json_ok() {
  local path; path=$(json_escape "$1")
  local source; source=$(json_escape "$2")
  printf '{"status":"ok","path":"%s","source":"%s"}\n' "$path" "$source"
}

json_error() {
  local msg; msg=$(json_escape "$2")
  printf '{"status":"error","code":%d,"message":"%s"}\n' "$1" "$msg" >&2
  printf '{"status":"error","code":%d,"message":"%s"}\n' "$1" "$msg"
  exit "$1"
}

json_ambiguous() {
  local profiles_json="$1"
  printf '{"status":"ambiguous","platform":"%s","profiles":%s}\n' "$PLATFORM" "$profiles_json"
  exit 2
}

if [ -z "$PLATFORM" ] || { [ "$PLATFORM" != "ios" ] && [ "$PLATFORM" != "android" ]; }; then
  json_error 1 "Usage: eas_resolve_artifact.sh <ios|android> [profile] [output_dir]"
fi

if [ ! -f "eas.json" ]; then
  json_error 4 "No eas.json found in current directory. This is not an EAS project."
fi

mkdir -p "$OUTPUT_DIR"

# --- Profile auto-selection ---
# Writes result to PROFILE global variable directly (not via subshell)
# so that json_error/json_ambiguous output reaches stdout properly.

select_profile() {
  local platform="$1"

  if command -v jq &>/dev/null; then
    local profiles
    if [ "$platform" = "ios" ]; then
      profiles=$(jq -r '.build | to_entries[] | select(.value.ios.simulator == true) | .key' eas.json 2>/dev/null || true)
    else
      profiles=$(jq -r '.build | to_entries[] | select(.value.android.buildType == "apk") | .key' eas.json 2>/dev/null || true)
    fi

    local count
    count=$(echo "$profiles" | grep -c . 2>/dev/null || true)
    count="${count:-0}"

    if [ "$count" -eq 0 ]; then
      if jq -e '.build.development' eas.json >/dev/null 2>&1; then
        PROFILE="development"
        return 0
      fi
      json_error 1 "No matching EAS profile for ${platform}. iOS needs ios.simulator:true, Android needs android.buildType:apk."
    elif [ "$count" -eq 1 ]; then
      PROFILE="$profiles"
      return 0
    else
      local json_arr
      json_arr=$(echo "$profiles" | jq -R -s 'split("\n") | map(select(length > 0))')
      json_ambiguous "$json_arr"
    fi
  elif command -v node &>/dev/null; then
    local result
    result=$(node -e "
      const eas = require('./eas.json');
      const profiles = Object.entries(eas.build || {})
        .filter(([, v]) => '${platform}' === 'ios' ? v.ios?.simulator === true : v.android?.buildType === 'apk')
        .map(([k]) => k);
      if (profiles.length === 0) {
        if (eas.build?.development) { console.log('development'); process.exit(0); }
        process.exit(1);
      }
      if (profiles.length === 1) { console.log(profiles[0]); process.exit(0); }
      console.log('AMBIGUOUS:' + JSON.stringify(profiles));
    " 2>/dev/null) || json_error 1 "No matching EAS profile for ${platform}."

    if [[ "$result" == AMBIGUOUS:* ]]; then
      json_ambiguous "${result#AMBIGUOUS:}"
    fi
    PROFILE="$result"
  else
    json_error 1 "Neither jq nor node found. Cannot parse eas.json."
  fi
}

if [ -z "$PROFILE" ]; then
  select_profile "$PLATFORM"
  echo "Auto-selected EAS profile: $PROFILE" >&2
fi

# --- Tier 1: Local cache ---

check_cache() {
  local ext
  if [ "$PLATFORM" = "ios" ]; then ext="tar.gz"; else ext="apk"; fi

  # Check output dir for cached artifacts matching profile
  local cached
  cached=$(find "$OUTPUT_DIR" -name "*${PROFILE}*.${ext}" -mmin "-$((CACHE_MAX_AGE_HOURS * 60))" -type f -exec stat -f "%m %N" {} + 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2- || true)

  if [ -n "$cached" ]; then
    echo "$cached"
    return 0
  fi

  return 1
}

cached_path=$(check_cache) && {
  echo "Using cached artifact: $cached_path" >&2
  json_ok "$cached_path" "cache"
  exit 0
} || true

# --- Tier 2: EAS server download ---

if ! command -v eas &>/dev/null && ! command -v npx &>/dev/null; then
  json_error 3 "EAS CLI not available. Install: npm install -g eas-cli"
fi

EAS_CMD="eas"
if ! command -v eas &>/dev/null; then
  EAS_CMD="npx eas-cli"
fi

echo "Downloading artifact from EAS (platform=$PLATFORM, profile=$PROFILE)..." >&2

# Determine output filename
if [ "$PLATFORM" = "ios" ]; then
  ARTIFACT_NAME="${PROFILE}-${PLATFORM}.tar.gz"
else
  ARTIFACT_NAME="${PROFILE}-${PLATFORM}.apk"
fi

ARTIFACT_PATH="${OUTPUT_DIR}/${ARTIFACT_NAME}"

# Query EAS for latest finished build
if $EAS_CMD build:list \
  --platform "$PLATFORM" \
  --buildProfile "$PROFILE" \
  --status finished \
  --limit 1 \
  --non-interactive \
  --json > "${OUTPUT_DIR}/build-info.json" 2>"${OUTPUT_DIR}/build-err.log"; then

  # Extract artifact URL and download
  local_build_url=""
  if command -v jq &>/dev/null; then
    local_build_url=$(jq -r '.[0].artifacts.buildUrl // empty' "${OUTPUT_DIR}/build-info.json" 2>/dev/null || true)
  elif command -v node &>/dev/null; then
    local_build_url=$(node -e "
      const d = require('${OUTPUT_DIR}/build-info.json');
      const url = d?.[0]?.artifacts?.buildUrl;
      if (url) console.log(url);
    " 2>/dev/null || true)
  fi

  if [ -n "$local_build_url" ]; then
    echo "Downloading from: $local_build_url" >&2
    if curl -fSL --max-time 300 -o "$ARTIFACT_PATH" "$local_build_url" 2>/dev/null; then
      echo "Downloaded to: $ARTIFACT_PATH" >&2
      json_ok "$ARTIFACT_PATH" "eas"
      exit 0
    else
      echo "Download failed" >&2
    fi
  else
    echo "No finished build found on EAS for profile=$PROFILE platform=$PLATFORM" >&2
  fi
else
  echo "EAS build:list failed or timed out" >&2
fi

# --- Tier 3: No artifact found ---

json_error 1 "No artifact found. Build with: eas build --platform $PLATFORM --profile $PROFILE, or place artifact at ${OUTPUT_DIR}/<name>.$([ "$PLATFORM" = "ios" ] && echo "tar.gz" || echo "apk")"
