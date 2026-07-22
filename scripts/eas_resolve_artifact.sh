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
export LC_ALL=C

PLATFORM="${1:-}"
PROFILE="${2:-}"
OUTPUT_DIR="${3:-}"
CACHE_MAX_AGE_HOURS=24
OWN_OUTPUT_DIR=0
RESOLUTION_SUCCEEDED=0
RUN_DIR=""
PUBLISHED_PATH=""
PUBLISHED_OWNED=0
PUBLISHED_SIDECAR_PATH=""
PUBLISHED_SIDECAR_OWNED=0
PAIR_COMMITTED=0

cleanup() {
  if [ -n "$RUN_DIR" ]; then
    rm -rf -- "$RUN_DIR" 2>/dev/null || true
  fi
  if [ "$PUBLISHED_SIDECAR_OWNED" -eq 1 ] && [ "$PAIR_COMMITTED" -ne 1 ] && [ -n "$PUBLISHED_SIDECAR_PATH" ]; then
    rm -f -- "$PUBLISHED_SIDECAR_PATH" 2>/dev/null || true
  fi
  if [ "$PUBLISHED_OWNED" -eq 1 ] && [ "$PAIR_COMMITTED" -ne 1 ] && [ -n "$PUBLISHED_PATH" ]; then
    rm -f -- "$PUBLISHED_PATH" 2>/dev/null || true
  fi
  if [ "$OWN_OUTPUT_DIR" -eq 1 ] && [ "$RESOLUTION_SUCCEEDED" -ne 1 ] && [ "$PAIR_COMMITTED" -ne 1 ] && [ -n "$OUTPUT_DIR" ]; then
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
  printf '{"status":"ok","path":"%s","source":"%s"}\n' "$path" "$source"
  RESOLUTION_SUCCEEDED=1
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

read_json_string() {
  local path="$1"
  local key="$2"
  if command -v jq &>/dev/null; then
    jq -er --arg key "$key" '.[$key] | select(type == "string")' "$path" 2>/dev/null
  else
    node -e '
      const fs = require("node:fs");
      const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))[process.argv[2]];
      if (typeof value !== "string") process.exit(1);
      process.stdout.write(value);
    ' "$path" "$key" 2>/dev/null
  fi
}

read_static_project_id() {
  local config id resolved=""
  for config in app.config.js app.config.cjs app.config.mjs app.config.ts; do
    if [ -e "$config" ] || [ -L "$config" ]; then
      return 1
    fi
  done
  for config in app.json app.config.json; do
    [ -f "$config" ] || continue
    if command -v jq &>/dev/null; then
      jq -e . "$config" >/dev/null 2>&1 || return 1
      id=$(jq -r '(.expo.extra.eas.projectId // .extra.eas.projectId // empty) | select(type == "string")' "$config" 2>/dev/null) || return 1
    else
      id=$(node -e '
        const fs = require("node:fs");
        const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
        const id = value?.expo?.extra?.eas?.projectId ?? value?.extra?.eas?.projectId;
        if (id !== undefined && typeof id !== "string") process.exit(1);
        if (id !== undefined) process.stdout.write(id);
      ' "$config" 2>/dev/null) || return 1
    fi
    [ -n "$id" ] || continue
    if ! [[ "$id" =~ ^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$ ]]; then
      return 1
    fi
    id=$(printf '%s' "$id" | tr '[:upper:]' '[:lower:]')
    if [ -n "$resolved" ] && [ "$resolved" != "$id" ]; then
      return 1
    fi
    resolved="$id"
  done
  [ -n "$resolved" ] || return 1
  printf '%s' "$resolved"
}

timestamp_sort_key() {
  local timestamp="$1"
  local fraction
  if ! [[ "$timestamp" =~ ^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(\.([0-9]{1,9}))?Z$ ]]; then
    return 1
  fi
  if [ $((10#${BASH_REMATCH[2]})) -lt 1 ] || [ $((10#${BASH_REMATCH[2]})) -gt 12 ] || \
    [ $((10#${BASH_REMATCH[3]})) -lt 1 ] || [ $((10#${BASH_REMATCH[3]})) -gt 31 ] || \
    [ $((10#${BASH_REMATCH[4]})) -gt 23 ] || [ $((10#${BASH_REMATCH[5]})) -gt 59 ] || \
    [ $((10#${BASH_REMATCH[6]})) -gt 59 ]; then
    return 1
  fi
  fraction="${BASH_REMATCH[8]:-}"
  while [ "${#fraction}" -lt 9 ]; do fraction="${fraction}0"; done
  printf '%s%s%s%s%s%s%s' \
    "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}" \
    "${BASH_REMATCH[4]}" "${BASH_REMATCH[5]}" "${BASH_REMATCH[6]}" "$fraction"
}

check_cache() {
  CACHED_PATH=""
  [ "$CACHE_REUSE_ENABLED" -eq 1 ] || return 1

  local sidecar sidecar_name token sidecar_size
  local sidecar_project sidecar_platform sidecar_profile sidecar_build_id
  local sidecar_timestamp sidecar_artifact timestamp_key candidate_key
  local cached_path best_key=""
  local sidecars=()
  shopt -s nullglob
  sidecars=("$OUTPUT_DIR"/".eas-cache-${PROJECT_ID}-${PROFILE}-${PLATFORM}-"*.json)
  shopt -u nullglob
  if [ "${#sidecars[@]}" -eq 0 ]; then
    return 1
  fi

  for sidecar in "${sidecars[@]}"; do
    sidecar_name=$(basename "$sidecar")
    token="${sidecar_name#".eas-cache-${PROJECT_ID}-${PROFILE}-${PLATFORM}-"}"
    token="${token%.json}"
    if [ -z "$token" ] || ! [[ "$token" =~ ^[a-zA-Z0-9]+$ ]] || \
      [ "$sidecar_name" != ".eas-cache-${PROJECT_ID}-${PROFILE}-${PLATFORM}-${token}.json" ]; then
      json_error 1 "Artifact cache sidecar has an unsafe name."
    fi
    if [ -L "$sidecar" ] || [ ! -f "$sidecar" ]; then
      json_error 1 "Artifact cache sidecar must be a regular file: $sidecar"
    fi
    private_file_metadata "$sidecar"
    if [ "$FILE_OWNER" != "$(id -u)" ] || [ "$FILE_MODE" != "600" ]; then
      json_error 1 "Artifact cache sidecar must be owned by the current user with mode 0600."
    fi
    sidecar_size=$(wc -c < "$sidecar" | tr -d '[:space:]')
    if [ -z "$sidecar_size" ] || [ "$sidecar_size" -gt 4096 ]; then
      json_error 1 "Artifact cache sidecar has invalid content."
    fi
    sidecar_project=$(read_json_string "$sidecar" projectId) || json_error 1 "Artifact cache sidecar has invalid content."
    sidecar_platform=$(read_json_string "$sidecar" platform) || json_error 1 "Artifact cache sidecar has invalid content."
    sidecar_profile=$(read_json_string "$sidecar" profile) || json_error 1 "Artifact cache sidecar has invalid content."
    sidecar_build_id=$(read_json_string "$sidecar" buildId) || json_error 1 "Artifact cache sidecar has invalid content."
    sidecar_timestamp=$(read_json_string "$sidecar" buildTimestamp) || json_error 1 "Artifact cache sidecar has invalid content."
    sidecar_artifact=$(read_json_string "$sidecar" artifact) || json_error 1 "Artifact cache sidecar has invalid content."
    if [ "$sidecar_project" != "$PROJECT_ID" ] || [ "$sidecar_platform" != "$PLATFORM" ] || \
      [ "$sidecar_profile" != "$PROFILE" ] || \
      ! [[ "$sidecar_build_id" =~ ^[a-zA-Z0-9_-]{1,128}$ ]]; then
      json_error 1 "Artifact cache sidecar does not match the selected project, profile, and platform."
    fi
    timestamp_key=$(timestamp_sort_key "$sidecar_timestamp") || json_error 1 "Artifact cache sidecar has an invalid build timestamp."
    if [ "$sidecar_artifact" != "${PROFILE}-${PLATFORM}-${token}${ARTIFACT_SUFFIX}" ]; then
      json_error 1 "Artifact cache sidecar names an unexpected artifact."
    fi
    cached_path="${OUTPUT_DIR}/${sidecar_artifact}"
    if [ "$(dirname "$cached_path")" != "$OUTPUT_DIR" ] || [ "$(basename "$cached_path")" != "$sidecar_artifact" ]; then
      json_error 1 "Cached artifact must be one immediate file child of the output directory."
    fi
    if [ -L "$cached_path" ] || { [ -e "$cached_path" ] && [ ! -f "$cached_path" ]; }; then
      json_error 1 "Cached artifact must be a regular file: $cached_path"
    fi
    [ -f "$cached_path" ] || json_error 1 "Artifact cache sidecar references a missing artifact."
    [ -s "$cached_path" ] || json_error 1 "Cached artifact must be nonempty: $cached_path"
    private_file_metadata "$cached_path"
    if [ "$FILE_OWNER" != "$(id -u)" ] || [ "$FILE_MODE" != "600" ]; then
      json_error 1 "Cached artifact must be owned by the current user with mode 0600."
    fi
    if [ -z "$(find "$cached_path" -mmin "-$((CACHE_MAX_AGE_HOURS * 60))" -type f -print 2>/dev/null || true)" ]; then
      continue
    fi
    candidate_key="${timestamp_key}|${sidecar_build_id}|${sidecar_artifact}"
    if [ -z "$best_key" ] || [[ "$candidate_key" > "$best_key" ]]; then
      best_key="$candidate_key"
      CACHED_PATH="$cached_path"
    fi
  done
  [ -n "$CACHED_PATH" ] || return 1
  return 0
}

PROJECT_ID=""
CACHE_REUSE_ENABLED=0
if PROJECT_ID=$(read_static_project_id); then
  CACHE_REUSE_ENABLED=1
else
  echo "Skipping local EAS cache: exact Expo project ID is not statically provable." >&2
fi

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

  local_build_url=""
  remote_project_id=""
  build_id=""
  build_timestamp=""
  if command -v jq &>/dev/null; then
    local_build_url=$(jq -r '.[0].artifacts.buildUrl // empty' "$BUILD_INFO" 2>/dev/null || true)
    remote_project_id=$(jq -r '.[0].project.id // .[0].projectId // empty' "$BUILD_INFO" 2>/dev/null || true)
    build_id=$(jq -r '.[0].id // empty' "$BUILD_INFO" 2>/dev/null || true)
    build_timestamp=$(jq -r '.[0].completedAt // .[0].finishedAt // .[0].createdAt // empty' "$BUILD_INFO" 2>/dev/null || true)
  elif command -v node &>/dev/null; then
    build_fields=$(node -e "
      const d = require(process.argv[1]);
      const build = d?.[0];
      const fields = [
        build?.artifacts?.buildUrl,
        build?.project?.id ?? build?.projectId,
        build?.id,
        build?.completedAt ?? build?.finishedAt ?? build?.createdAt,
      ];
      if (!fields.every((value) => typeof value === 'string')) process.exit(1);
      process.stdout.write(fields.join('\n'));
    " "$BUILD_INFO" 2>/dev/null || true)
    if [ -n "$build_fields" ]; then
      local_build_url=$(printf '%s\n' "$build_fields" | sed -n '1p')
      remote_project_id=$(printf '%s\n' "$build_fields" | sed -n '2p')
      build_id=$(printf '%s\n' "$build_fields" | sed -n '3p')
      build_timestamp=$(printf '%s\n' "$build_fields" | sed -n '4p')
    fi
  fi

  if [ -n "$local_build_url" ]; then
    if ! [[ "$remote_project_id" =~ ^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$ ]] || \
      ! [[ "$build_id" =~ ^[a-zA-Z0-9_-]{1,128}$ ]] || \
      ! timestamp_sort_key "$build_timestamp" >/dev/null; then
      json_error 1 "EAS returned incomplete or invalid build identity metadata."
    fi
    remote_project_id=$(printf '%s' "$remote_project_id" | tr '[:upper:]' '[:lower:]')
    if [ -n "$PROJECT_ID" ] && [ "$PROJECT_ID" != "$remote_project_id" ]; then
      json_error 1 "EAS build project ID does not match the current Expo project."
    fi
    if [[ ! "$local_build_url" =~ ^https?:// ]] || [[ "$local_build_url" =~ [[:cntrl:]] ]]; then
      json_error 1 "EAS returned an invalid artifact URL."
    fi
    curl_config_url="${local_build_url//\\/\\\\}"
    curl_config_url="${curl_config_url//\"/\\\"}"
    echo "Downloading resolved EAS artifact..." >&2
    if printf 'url = "%s"\n' "$curl_config_url" | \
      curl --config - -fSL --max-time 300 -o "$DOWNLOAD_PATH" 2>/dev/null; then
      if [ -L "$DOWNLOAD_PATH" ] || [ ! -f "$DOWNLOAD_PATH" ] || [ ! -s "$DOWNLOAD_PATH" ]; then
        json_error 1 "Downloaded artifact must be a nonempty regular file."
      fi
      if [ -e "$PUBLISHED_PATH" ] || [ -L "$PUBLISHED_PATH" ]; then
        json_error 1 "Refusing to replace an existing artifact result."
      fi
      if ! ln "$DOWNLOAD_PATH" "$PUBLISHED_PATH"; then
        json_error 1 "Failed to publish downloaded artifact: $PUBLISHED_PATH"
      fi
      PUBLISHED_OWNED=1
      if ! rm -f -- "$DOWNLOAD_PATH"; then
        rm -f -- "$PUBLISHED_PATH" 2>/dev/null || true
        json_error 1 "Failed to finalize downloaded artifact."
      fi
      if [ -L "$PUBLISHED_PATH" ] || [ ! -f "$PUBLISHED_PATH" ] || [ ! -s "$PUBLISHED_PATH" ]; then
        rm -f -- "$PUBLISHED_PATH" 2>/dev/null || true
        json_error 1 "Published artifact must be a nonempty regular file: $PUBLISHED_PATH"
      fi
      private_file_metadata "$PUBLISHED_PATH"
      if [ "$FILE_OWNER" != "$(id -u)" ] || [ "$FILE_MODE" != "600" ]; then
        rm -f -- "$PUBLISHED_PATH" 2>/dev/null || true
        json_error 1 "Published artifact must be owned by the current user with mode 0600."
      fi
      PUBLISHED_SIDECAR_NAME=".eas-cache-${remote_project_id}-${PROFILE}-${PLATFORM}-${RUN_TOKEN}.json"
      PUBLISHED_SIDECAR_PATH="${OUTPUT_DIR}/${PUBLISHED_SIDECAR_NAME}"
      if [ "$(dirname "$PUBLISHED_SIDECAR_PATH")" != "$OUTPUT_DIR" ] || \
        [ "$(basename "$PUBLISHED_SIDECAR_PATH")" != "$PUBLISHED_SIDECAR_NAME" ]; then
        json_error 1 "Artifact cache sidecar must be one immediate file child of the output directory."
      fi
      if [ -e "$PUBLISHED_SIDECAR_PATH" ] || [ -L "$PUBLISHED_SIDECAR_PATH" ]; then
        json_error 1 "Refusing to replace an existing artifact cache sidecar."
      fi
      SIDECAR_TMP="${RUN_DIR}/cache-sidecar.json"
      if ! printf '{"projectId":"%s","platform":"%s","profile":"%s","buildId":"%s","buildTimestamp":"%s","artifact":"%s"}\n' \
        "$remote_project_id" "$PLATFORM" "$PROFILE" "$build_id" "$build_timestamp" "$PUBLISHED_NAME" > "$SIDECAR_TMP" || \
        ! chmod 600 "$SIDECAR_TMP"; then
        json_error 1 "Failed to create artifact cache sidecar."
      fi
      if [ -L "$SIDECAR_TMP" ] || [ ! -f "$SIDECAR_TMP" ] || [ ! -s "$SIDECAR_TMP" ]; then
        json_error 1 "Artifact cache sidecar must be a nonempty regular file before publication."
      fi
      private_file_metadata "$SIDECAR_TMP"
      if [ "$FILE_OWNER" != "$(id -u)" ] || [ "$FILE_MODE" != "600" ]; then
        json_error 1 "Artifact cache sidecar must be owned by the current user with mode 0600 before publication."
      fi
      if ! ln "$SIDECAR_TMP" "$PUBLISHED_SIDECAR_PATH"; then
        json_error 1 "Failed to publish artifact cache sidecar."
      fi
      PUBLISHED_SIDECAR_OWNED=1
      PAIR_COMMITTED=1
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
