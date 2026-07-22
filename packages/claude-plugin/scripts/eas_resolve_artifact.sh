#!/bin/bash
# eas_resolve_artifact.sh — Resolve an EAS build artifact for local installation
#
# Given a platform and optional profile, finds a ready-to-install artifact by checking:
#   Tier 1: Local cache in a private output directory
#   Tier 2: EAS servers (eas build:list + download)
#   Tier 3: Exit with "no artifact" status for manual resolution
#
# Usage: bash scripts/eas_resolve_artifact.sh <platform> [profile] [output_dir]
#   platform:   ios | android
#   profile:    EAS build profile name (optional, auto-selected if unambiguous)
#   output_dir: private directory for completed artifacts (default: mktemp retained on success)
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
umask 077

PLATFORM="${1:-}"
PROFILE="${2:-}"
OUTPUT_DIR="${3:-}"
CACHE_MAX_AGE_HOURS=24
OWN_OUTPUT_DIR=0
RESOLUTION_SUCCEEDED=0
RUN_DIR=""

cleanup() {
  if [ -n "$RUN_DIR" ]; then
    rm -rf -- "$RUN_DIR" 2>/dev/null || true
  fi
  if [ "$OWN_OUTPUT_DIR" -eq 1 ] && [ "$RESOLUTION_SUCCEEDED" -ne 1 ] && [ -n "$OUTPUT_DIR" ]; then
    rm -rf -- "$OUTPUT_DIR" 2>/dev/null || true
  fi
}
trap cleanup EXIT

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
  RESOLUTION_SUCCEEDED=1
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

validate_profile() {
  local profile="$1"
  if [ -z "$profile" ] || ! [[ "$profile" =~ ^[a-zA-Z0-9_-]+$ ]]; then
    json_error 1 "Invalid profile name: must match ^[a-zA-Z0-9_-]+$"
  fi
}

classify_eas_failure() {
  local file="$1"
  local sample
  sample=$(LC_ALL=C head -c 16384 "$file" 2>/dev/null || true)
  if printf '%s' "$sample" | grep -Eiq 'unauthorized|forbidden|not logged in|authentication|authorization'; then
    printf '%s' 'authentication failed; run eas whoami and authenticate.'
  elif printf '%s' "$sample" | grep -Eiq 'rate[ -]?limit|too many requests|HTTP[[:space:]]*429'; then
    printf '%s' 'rate limit reached; retry later.'
  elif printf '%s' "$sample" | grep -Eiq 'timed? out|timeout|ENOTFOUND|ECONNRESET|EAI_AGAIN|network|socket'; then
    printf '%s' 'network request failed; check connectivity and retry.'
  elif printf '%s' "$sample" | grep -Eiq 'project|build profile|profile.*(invalid|missing|not found|unknown)'; then
    printf '%s' 'project or build profile was rejected; verify EAS configuration.'
  else
    printf '%s' 'build lookup failed; retry with EAS CLI diagnostics.'
  fi
}

if [ -z "$PLATFORM" ] || { [ "$PLATFORM" != "ios" ] && [ "$PLATFORM" != "android" ]; }; then
  json_error 1 "Usage: eas_resolve_artifact.sh <ios|android> [profile] [output_dir]"
fi

if [ -n "$PROFILE" ]; then
  validate_profile "$PROFILE"
fi

if [ ! -f "eas.json" ]; then
  json_error 4 "No eas.json found in current directory. This is not an EAS project."
fi

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
  validate_profile "$PROFILE"
  echo "Auto-selected EAS profile: $PROFILE" >&2
fi

if [ -z "$OUTPUT_DIR" ]; then
  OUTPUT_DIR=$(mktemp -d "${TMPDIR:-/tmp}/rn-eas-builds.XXXXXX") || \
    json_error 1 "Unable to create a private artifact directory."
  OWN_OUTPUT_DIR=1
elif [ ! -e "$OUTPUT_DIR" ]; then
  mkdir -m 700 -- "$OUTPUT_DIR" || json_error 1 "Unable to create artifact directory: $OUTPUT_DIR"
fi

if [ -L "$OUTPUT_DIR" ] || [ ! -d "$OUTPUT_DIR" ]; then
  json_error 1 "Artifact output must be a real directory, not a symlink: $OUTPUT_DIR"
fi

if [ "$(uname)" = "Darwin" ]; then
  OUTPUT_OWNER=$(stat -f '%u' "$OUTPUT_DIR" 2>/dev/null || true)
  OUTPUT_MODE=$(stat -f '%Lp' "$OUTPUT_DIR" 2>/dev/null || true)
else
  OUTPUT_OWNER=$(stat -c '%u' "$OUTPUT_DIR" 2>/dev/null || true)
  OUTPUT_MODE=$(stat -c '%a' "$OUTPUT_DIR" 2>/dev/null || true)
fi
if [ "$OUTPUT_OWNER" != "$(id -u)" ] || [ "$OUTPUT_MODE" != "700" ]; then
  json_error 1 "Artifact output must be owned by the current user with mode 0700: $OUTPUT_DIR"
fi

OUTPUT_DIR=$(cd "$OUTPUT_DIR" && pwd -P)

if [ "$PLATFORM" = "ios" ]; then
  ARTIFACT_SUFFIX=".tar.gz"
else
  ARTIFACT_SUFFIX=".apk"
fi

PROJECT_ROOT=$(pwd -P)
if command -v shasum &>/dev/null; then
  APP_CACHE_KEY=$(printf '%s' "$PROJECT_ROOT" | shasum -a 256 | awk '{print substr($1, 1, 24)}')
elif command -v sha256sum &>/dev/null; then
  APP_CACHE_KEY=$(printf '%s' "$PROJECT_ROOT" | sha256sum | awk '{print substr($1, 1, 24)}')
elif command -v node &>/dev/null; then
  APP_CACHE_KEY=$(node -e "const c=require('node:crypto');process.stdout.write(c.createHash('sha256').update(process.argv[1]).digest('hex').slice(0,24))" "$PROJECT_ROOT")
else
  json_error 1 "Unable to derive a stable application cache key."
fi
if ! [[ "$APP_CACHE_KEY" =~ ^[a-fA-F0-9]{24}$ ]]; then
  json_error 1 "Unable to derive a safe application cache key."
fi

MANIFEST_NAME=".eas-latest-${APP_CACHE_KEY}-${PROFILE}-${PLATFORM}.manifest"
MANIFEST_PATH="${OUTPUT_DIR}/${MANIFEST_NAME}"
if [ "$(dirname "$MANIFEST_PATH")" != "$OUTPUT_DIR" ] || \
  [ "$(basename "$MANIFEST_PATH")" != "$MANIFEST_NAME" ]; then
  json_error 1 "Artifact manifest must be one immediate file child of the output directory."
fi

# --- Tier 1: Local cache ---

private_file_metadata() {
  local path="$1"
  if [ "$(uname)" = "Darwin" ]; then
    FILE_OWNER=$(stat -f '%u' "$path" 2>/dev/null || true)
    FILE_MODE=$(stat -f '%Lp' "$path" 2>/dev/null || true)
  else
    FILE_OWNER=$(stat -c '%u' "$path" 2>/dev/null || true)
    FILE_MODE=$(stat -c '%a' "$path" 2>/dev/null || true)
  fi
}

validate_private_manifest() {
  if [ -L "$MANIFEST_PATH" ] || [ ! -f "$MANIFEST_PATH" ]; then
    json_error 1 "Artifact manifest must be a regular file: $MANIFEST_PATH"
  fi
  private_file_metadata "$MANIFEST_PATH"
  if [ "$FILE_OWNER" != "$(id -u)" ] || [ "$FILE_MODE" != "600" ]; then
    json_error 1 "Artifact manifest must be owned by the current user with mode 0600."
  fi
}

check_cache() {
  CACHED_PATH=""
  if [ ! -e "$MANIFEST_PATH" ] && [ ! -L "$MANIFEST_PATH" ]; then
    return 1
  fi

  validate_private_manifest
  local manifest_size manifest_lines cached_name expected_prefix cached_token cached_path
  manifest_size=$(wc -c < "$MANIFEST_PATH" | tr -d '[:space:]')
  manifest_lines=$(wc -l < "$MANIFEST_PATH" | tr -d '[:space:]')
  if [ -z "$manifest_size" ] || [ "$manifest_size" -gt 256 ] || [ "$manifest_lines" != "1" ]; then
    json_error 1 "Artifact manifest has invalid content."
  fi
  IFS= read -r cached_name < "$MANIFEST_PATH" || json_error 1 "Artifact manifest has invalid content."
  expected_prefix="${PROFILE}-${PLATFORM}-"
  if [[ "$cached_name" != "$expected_prefix"*"$ARTIFACT_SUFFIX" ]]; then
    json_error 1 "Artifact manifest does not match the selected application, profile, and platform."
  fi
  cached_token="${cached_name#"$expected_prefix"}"
  cached_token="${cached_token%"$ARTIFACT_SUFFIX"}"
  if [ -z "$cached_token" ] || ! [[ "$cached_token" =~ ^[a-zA-Z0-9]+$ ]] || \
    [ "$cached_name" != "${expected_prefix}${cached_token}${ARTIFACT_SUFFIX}" ]; then
    json_error 1 "Artifact manifest contains an unsafe artifact name."
  fi

  cached_path="${OUTPUT_DIR}/${cached_name}"
  if [ "$(dirname "$cached_path")" != "$OUTPUT_DIR" ] || \
    [ "$(basename "$cached_path")" != "$cached_name" ]; then
    json_error 1 "Cached artifact must be one immediate file child of the output directory."
  fi
  if [ -L "$cached_path" ] || { [ -e "$cached_path" ] && [ ! -f "$cached_path" ]; }; then
    json_error 1 "Cached artifact must be a regular file: $cached_path"
  fi
  if [ ! -f "$cached_path" ]; then
    return 1
  fi
  private_file_metadata "$cached_path"
  if [ "$FILE_OWNER" != "$(id -u)" ] || [ "$FILE_MODE" != "600" ]; then
    json_error 1 "Cached artifact must be owned by the current user with mode 0600."
  fi
  if [ -z "$(find "$cached_path" -mmin "-$((CACHE_MAX_AGE_HOURS * 60))" -type f -print 2>/dev/null || true)" ]; then
    return 1
  fi

  CACHED_PATH="$cached_path"
  return 0
}

if check_cache; then
  echo "Using cached artifact: $CACHED_PATH" >&2
  json_ok "$CACHED_PATH" "cache"
  exit 0
fi

# --- Tier 2: EAS server download ---

if ! command -v eas &>/dev/null && ! command -v npx &>/dev/null; then
  json_error 3 "EAS CLI not available. Install: npm install -g eas-cli"
fi

EAS_CMD=(eas)
if ! command -v eas &>/dev/null; then
  EAS_CMD=(npx eas-cli)
fi

echo "Downloading artifact from EAS (platform=$PLATFORM, profile=$PROFILE)..." >&2

RUN_DIR=$(mktemp -d "${OUTPUT_DIR}/.resolve.XXXXXX") || \
  json_error 1 "Unable to create a private resolver directory."
RUN_TOKEN="${RUN_DIR##*/}"
RUN_TOKEN="${RUN_TOKEN#.resolve.}"
if [ -z "$RUN_TOKEN" ] || ! [[ "$RUN_TOKEN" =~ ^[a-zA-Z0-9]+$ ]]; then
  json_error 1 "Unable to derive a safe resolver identity."
fi
PUBLISHED_NAME="${PROFILE}-${PLATFORM}-${RUN_TOKEN}${ARTIFACT_SUFFIX}"
PUBLISHED_PATH="${OUTPUT_DIR}/${PUBLISHED_NAME}"
if [ "$(dirname "$PUBLISHED_PATH")" != "$OUTPUT_DIR" ] || \
  [ "$(basename "$PUBLISHED_PATH")" != "$PUBLISHED_NAME" ]; then
  json_error 1 "Published artifact must be one immediate file child of the output directory."
fi
if [ -e "$PUBLISHED_PATH" ] || [ -L "$PUBLISHED_PATH" ]; then
  json_error 1 "Refusing to replace an existing artifact result."
fi
BUILD_INFO="${RUN_DIR}/build-info.json"
BUILD_ERR="${RUN_DIR}/build-err.log"
DOWNLOAD_PATH="${RUN_DIR}/artifact.part"
EAS_DIAGNOSTIC=""

# Query EAS for latest finished build
if "${EAS_CMD[@]}" build:list \
  --platform "$PLATFORM" \
  --buildProfile "$PROFILE" \
  --status finished \
  --limit 1 \
  --non-interactive \
  --json > "$BUILD_INFO" 2>"$BUILD_ERR"; then

  # Extract artifact URL and download
  local_build_url=""
  if command -v jq &>/dev/null; then
    local_build_url=$(jq -r '.[0].artifacts.buildUrl // empty' "$BUILD_INFO" 2>/dev/null || true)
  elif command -v node &>/dev/null; then
    local_build_url=$(node -e "
      const d = require(process.argv[1]);
      const url = d?.[0]?.artifacts?.buildUrl;
      if (url) console.log(url);
    " "$BUILD_INFO" 2>/dev/null || true)
  fi

  if [ -n "$local_build_url" ]; then
    if [[ ! "$local_build_url" =~ ^https?:// ]] || [[ "$local_build_url" =~ [[:cntrl:]] ]]; then
      json_error 1 "EAS returned an invalid artifact URL."
    fi
    curl_config_url="${local_build_url//\\/\\\\}"
    curl_config_url="${curl_config_url//\"/\\\"}"
    echo "Downloading resolved EAS artifact..." >&2
    if printf 'url = "%s"\n' "$curl_config_url" | \
      curl --config - -fSL --max-time 300 -o "$DOWNLOAD_PATH" 2>/dev/null; then
      if [ -e "$PUBLISHED_PATH" ] || [ -L "$PUBLISHED_PATH" ]; then
        json_error 1 "Refusing to replace an existing artifact result."
      fi
      if ! ln "$DOWNLOAD_PATH" "$PUBLISHED_PATH"; then
        json_error 1 "Failed to publish downloaded artifact: $PUBLISHED_PATH"
      fi
      if ! rm -f -- "$DOWNLOAD_PATH"; then
        rm -f -- "$PUBLISHED_PATH" 2>/dev/null || true
        json_error 1 "Failed to finalize downloaded artifact."
      fi
      if [ -L "$PUBLISHED_PATH" ] || [ ! -f "$PUBLISHED_PATH" ]; then
        rm -f -- "$PUBLISHED_PATH" 2>/dev/null || true
        json_error 1 "Published artifact is not a regular file: $PUBLISHED_PATH"
      fi
      private_file_metadata "$PUBLISHED_PATH"
      if [ "$FILE_OWNER" != "$(id -u)" ] || [ "$FILE_MODE" != "600" ]; then
        rm -f -- "$PUBLISHED_PATH" 2>/dev/null || true
        json_error 1 "Published artifact must be owned by the current user with mode 0600."
      fi
      MANIFEST_TMP="${RUN_DIR}/latest.manifest"
      printf '%s\n' "$PUBLISHED_NAME" > "$MANIFEST_TMP"
      chmod 600 "$MANIFEST_TMP"
      if [ -e "$MANIFEST_PATH" ] || [ -L "$MANIFEST_PATH" ]; then
        validate_private_manifest
      fi
      if ! mv -f -- "$MANIFEST_TMP" "$MANIFEST_PATH"; then
        json_error 1 "Failed to publish artifact manifest."
      fi
      echo "Downloaded to: $PUBLISHED_PATH" >&2
      json_ok "$PUBLISHED_PATH" "eas"
      exit 0
    else
      echo "Download failed" >&2
    fi
  else
    echo "No finished build found on EAS for profile=$PROFILE platform=$PLATFORM" >&2
  fi
else
  echo "EAS build:list failed or timed out" >&2
  EAS_DIAGNOSTIC=$(classify_eas_failure "$BUILD_ERR")
fi

# --- Tier 3: No artifact found ---

FAILURE_MESSAGE="No artifact found. Build with: eas build --platform $PLATFORM --profile $PROFILE"
if [ -n "$EAS_DIAGNOSTIC" ]; then
  FAILURE_MESSAGE="$FAILURE_MESSAGE EAS diagnostic: $EAS_DIAGNOSTIC"
fi
json_error 1 "$FAILURE_MESSAGE"
