#!/usr/bin/env bash
set -euo pipefail

PID_PREFIX="/tmp/rn-dev-agent-record"
RAW_PREFIX="/tmp/rn-dev-agent-raw"
LEGACY_PID_PREFIX="$PID_PREFIX"
PRIOR_RUNTIME_DIR="${LEGACY_PID_PREFIX}.private-$(id -u)"
PRIOR_PID_PREFIX="${PRIOR_RUNTIME_DIR}/record"
RUNTIME_ROOT="${XDG_RUNTIME_DIR:-${TMPDIR:-${HOME:-}}}"
RUNTIME_DIR="${RUNTIME_ROOT%/}/rn-dev-agent-record"
PID_PREFIX="${RUNTIME_DIR}/record"
SIDECAR_TEMP_DIR="${RUNTIME_DIR}/tmp"
PENDING_PULL_FILE=""
PENDING_PULL_MANIFEST=""
PENDING_STAGE_FILE=""

usage() {
  cat <<'EOF'
Usage: record_proof.sh <subcommand> [args]

Subcommands:
  start <platform> <output-path> --scope <id>  Start a scoped recording
  abort <scope>                                Abort an uncommitted start
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
remote_birth_file() { echo "${PID_PREFIX}-${1}.remote-birth"; }
remote_command_file() { echo "${PID_PREFIX}-${1}.remote-command"; }
remote_args_file() { echo "${PID_PREFIX}-${1}.remote-args"; }
raw_identity_file() { echo "${PID_PREFIX}-${1}.raw-identity"; }
pull_manifest_file() { echo "${PID_PREFIX}-${1}.pull-manifest"; }
finalized_path_file() { echo "${PID_PREFIX}-${1}.finalized-path"; }
finalized_identity_file() { echo "${PID_PREFIX}-${1}.finalized-identity"; }
cleanup_pending_file() { echo "${PID_PREFIX}-${1}.cleanup-pending"; }
incarnation_file() { echo "${PID_PREFIX}-${1}.incarnation"; }

ensure_sidecar_temp_dir() {
  if ! python3 - "$RUNTIME_ROOT" <<'PY'
import os
import stat
import sys

runtime_root = sys.argv[1]
if not runtime_root or not os.path.isabs(runtime_root):
    raise SystemExit(1)
try:
    root_metadata = os.lstat(runtime_root)
except OSError:
    raise SystemExit(1)
if (
    not stat.S_ISDIR(root_metadata.st_mode)
    or root_metadata.st_uid != os.getuid()
    or root_metadata.st_mode & 0o022
):
    raise SystemExit(1)
PY
  then
    local candidate
    RUNTIME_ROOT=""
    for candidate in "${XDG_RUNTIME_DIR:-}" "${TMPDIR:-}" "${HOME:-}"; do
      [[ -n "$candidate" ]] || continue
      if python3 - "$candidate" <<'PY'
import os
import stat
import sys

path = sys.argv[1]
if not os.path.isabs(path):
    raise SystemExit(1)
try:
    metadata = os.lstat(path)
except OSError:
    raise SystemExit(1)
if (
    not stat.S_ISDIR(metadata.st_mode)
    or metadata.st_uid != os.getuid()
    or metadata.st_mode & 0o022
):
    raise SystemExit(1)
PY
      then
        RUNTIME_ROOT="$candidate"
        RUNTIME_DIR="${RUNTIME_ROOT%/}/rn-dev-agent-record"
        PID_PREFIX="${RUNTIME_DIR}/record"
        SIDECAR_TEMP_DIR="${RUNTIME_DIR}/tmp"
        break
      fi
    done
    [[ -n "$RUNTIME_ROOT" ]] || {
      echo "Error: recorder runtime root is unavailable" >&2
      return 1
    }
  fi

  python3 - "$RUNTIME_DIR" "$SIDECAR_TEMP_DIR" <<'PY'
import os
import stat
import sys

for index, path in enumerate(sys.argv[1:]):
    try:
        os.mkdir(path, 0o700)
    except FileExistsError:
        pass
    metadata = os.lstat(path)
    if (
        not stat.S_ISDIR(metadata.st_mode)
        or metadata.st_uid != os.getuid()
        or stat.S_IMODE(metadata.st_mode) != 0o700
    ):
        kind = "runtime" if index == 0 else "temporary"
        raise RuntimeError(f"recorder {kind} directory is not private")
PY
}

secure_publish() {
  local path="$1"
  local value="$2"
  ensure_sidecar_temp_dir
  local temporary
  temporary="$(mktemp "${SIDECAR_TEMP_DIR}/sidecar.XXXXXX")"
  chmod 600 "$temporary"
  if ! printf '%s' "$value" > "$temporary"; then
    rm -f "$temporary"
    return 1
  fi
  if ! mv -f "$temporary" "$path"; then
    rm -f "$temporary"
    return 1
  fi
}

secure_write_sidecar() {
  secure_publish "$1" "${2}"$'\n'
}

create_private_capture_file() {
  ensure_sidecar_temp_dir
  local capture
  capture="$(mktemp "${SIDECAR_TEMP_DIR}/raw-android-pull.XXXXXX")"
  chmod 600 "$capture"
  printf '%s' "$capture"
}

cleanup_pending_pull() {
  if [[ -n "$PENDING_PULL_FILE" ]]; then
    local pull_committed="false"
    if [[ -n "$PENDING_PULL_MANIFEST" && -s "$PENDING_PULL_MANIFEST" ]]; then
      [[ "$(sed -n '2p' "$PENDING_PULL_MANIFEST")" == "$PENDING_PULL_FILE" ]] &&
        pull_committed="true"
    fi
    [[ "$pull_committed" == "true" ]] || rm -f "$PENDING_PULL_FILE"
    PENDING_PULL_FILE=""
    PENDING_PULL_MANIFEST=""
  fi
  if [[ -n "$PENDING_STAGE_FILE" ]]; then
    rm -f "$PENDING_STAGE_FILE"
    PENDING_STAGE_FILE=""
  fi
}

legacy_sidecar_file() {
  local scope="$1"
  local suffix="$2"
  local incarnation="${3:-}"
  if [[ -n "$incarnation" ]]; then
    echo "${LEGACY_PID_PREFIX}-${scope}-${incarnation}.${suffix}"
  else
    echo "${LEGACY_PID_PREFIX}-${scope}.${suffix}"
  fi
}

sidecar_exists() {
  [[ -e "$1" || -L "$1" ]]
}

validate_legacy_sidecar() {
  python3 - "$1" <<'PY'
import os
import stat
import sys

metadata = os.lstat(sys.argv[1])
if (
    not stat.S_ISREG(metadata.st_mode)
    or metadata.st_uid != os.getuid()
    or metadata.st_mode & 0o022
):
    raise RuntimeError("legacy recorder sidecar is not owned regular state")
PY
}

scope_has_private_sidecars() {
  local scope="$1"
  local suffix
  for suffix in pid path platform birth raw-path raw-identity pull-manifest log serial remote-pid remote-birth remote-command remote-args device-path finalized-path finalized-identity cleanup-pending incarnation; do
    sidecar_exists "${PID_PREFIX}-${scope}.${suffix}" && return 0
  done
  return 1
}

scope_has_sidecars_at_prefix() {
  local prefix="$1"
  local scope="$2"
  local suffix
  for suffix in pid path platform birth raw-path raw-identity pull-manifest log serial remote-pid remote-birth remote-command remote-args device-path finalized-path finalized-identity cleanup-pending incarnation; do
    sidecar_exists "${prefix}-${scope}.${suffix}" && return 0
  done
  return 1
}

private_directory_is_owned() {
  python3 - "$1" <<'PY'
import os
import stat
import sys

try:
    metadata = os.lstat(sys.argv[1])
except OSError:
    raise SystemExit(1)
if (
    not stat.S_ISDIR(metadata.st_mode)
    or metadata.st_uid != os.getuid()
    or stat.S_IMODE(metadata.st_mode) != 0o700
):
    raise SystemExit(1)
PY
}

validate_private_scope() {
  local prefix="$1"
  local scope="$2"
  local suffix
  local path
  local incarnation=""
  for suffix in pid path platform birth raw-path raw-identity pull-manifest log serial remote-pid remote-birth remote-command remote-args device-path finalized-path finalized-identity cleanup-pending incarnation; do
    path="${prefix}-${scope}.${suffix}"
    if sidecar_exists "$path"; then
      validate_legacy_sidecar "$path"
    fi
  done
  path="${prefix}-${scope}.incarnation"
  if [[ -s "$path" ]]; then
    incarnation="$(cat "$path")"
    [[ "$incarnation" =~ ^[a-f0-9]{32}$ ]] || {
      echo "Error: prior recorder supervisor incarnation is invalid" >&2
      return 1
    }
  fi
  for suffix in control-token control-request control-response supervisor-state child-pid; do
    if [[ -n "$incarnation" ]]; then
      path="${prefix}-${scope}-${incarnation}.${suffix}"
    else
      path="${prefix}-${scope}.${suffix}"
    fi
    sidecar_exists "$path" && validate_legacy_sidecar "$path"
  done
  return 0
}

LEGACY_INCARNATION=""
LEGACY_SCOPE_PRESENT="false"
USING_LEGACY_SCOPE="false"
USING_PRIOR_SCOPE="false"

validate_legacy_scope() {
  local scope="$1"
  LEGACY_INCARNATION=""
  LEGACY_SCOPE_PRESENT="false"
  local suffix
  local legacy_path
  for suffix in pid path platform birth raw-path raw-identity pull-manifest log serial remote-pid remote-birth remote-command remote-args device-path finalized-path finalized-identity cleanup-pending incarnation; do
    legacy_path="$(legacy_sidecar_file "$scope" "$suffix")"
    if sidecar_exists "$legacy_path"; then
      LEGACY_SCOPE_PRESENT="true"
      validate_legacy_sidecar "$legacy_path"
    fi
  done
  legacy_path="$(legacy_sidecar_file "$scope" "incarnation")"
  if [[ -s "$legacy_path" ]]; then
    LEGACY_INCARNATION="$(cat "$legacy_path")"
    [[ "$LEGACY_INCARNATION" =~ ^[a-f0-9]{32}$ ]] || {
      echo "Error: legacy recorder supervisor incarnation is invalid" >&2
      return 1
    }
    for suffix in control-token control-request control-response supervisor-state child-pid; do
      legacy_path="$(legacy_sidecar_file "$scope" "$suffix" "$LEGACY_INCARNATION")"
      if sidecar_exists "$legacy_path"; then
        LEGACY_SCOPE_PRESENT="true"
        validate_legacy_sidecar "$legacy_path"
      fi
    done
  else
    for suffix in control-token control-request control-response supervisor-state child-pid; do
      legacy_path="$(legacy_sidecar_file "$scope" "$suffix")"
      if sidecar_exists "$legacy_path"; then
        LEGACY_SCOPE_PRESENT="true"
        validate_legacy_sidecar "$legacy_path"
      fi
    done
  fi
}

select_scope_state() {
  local scope="$1"
  ensure_sidecar_temp_dir
  scope_has_private_sidecars "$scope" && return 0
  if private_directory_is_owned "$PRIOR_RUNTIME_DIR" &&
    scope_has_sidecars_at_prefix "$PRIOR_PID_PREFIX" "$scope"; then
    validate_private_scope "$PRIOR_PID_PREFIX" "$scope"
    PID_PREFIX="$PRIOR_PID_PREFIX"
    SIDECAR_TEMP_DIR="${PRIOR_RUNTIME_DIR}/tmp"
    USING_PRIOR_SCOPE="true"
    return 0
  fi
  validate_legacy_scope "$scope"
  if [[ "$LEGACY_SCOPE_PRESENT" == "true" ]]; then
    PID_PREFIX="$LEGACY_PID_PREFIX"
    USING_LEGACY_SCOPE="true"
  fi
}

validate_raw_capture_path() {
  local raw_path="$1"
  [[ -z "$raw_path" ]] && return 0
  local private_tail="${raw_path#"$SIDECAR_TEMP_DIR"/}"
  if [[ "$raw_path" == "$SIDECAR_TEMP_DIR/"* ]] && [[
    "$private_tail" =~ ^raw-(ios|android)-[0-9]+\.(mov|mp4)$ ||
      "$private_tail" =~ ^raw-android-pull\.[A-Za-z0-9]+$
  ]]; then
    return 0
  fi
  private_tail="${raw_path#"$RUNTIME_DIR"/}"
  if [[ "$raw_path" == "$RUNTIME_DIR/"* ]] && [[
    "$private_tail" =~ ^raw-(ios|android)-[0-9]+\.(mov|mp4)$ ||
      "$private_tail" =~ ^raw-android-pull\.[A-Za-z0-9]+$
  ]]; then
    return 0
  fi
  private_tail="${raw_path#"$PRIOR_RUNTIME_DIR"/}"
  if [[ "$raw_path" == "$PRIOR_RUNTIME_DIR/"* && "$private_tail" =~ ^(tmp/)?raw-(ios|android)-[0-9]+\.(mov|mp4)$ ]]; then
    return 0
  fi
  local legacy_tail="${raw_path#"$RAW_PREFIX"-}"
  if [[ "$raw_path" == "$RAW_PREFIX"-* && "$legacy_tail" =~ ^(ios|android)-[0-9]+\.(mov|mp4)$ ]]; then
    if sidecar_exists "$raw_path"; then
      validate_legacy_sidecar "$raw_path"
    fi
    return 0
  fi
  echo "Error: recorder raw path is outside owned runtime storage" >&2
  return 1
}

capture_file_identity() {
  python3 - "$1" <<'PY'
import hashlib
import os
import stat
import sys

path = sys.argv[1]
metadata = os.lstat(path)
if (
    not stat.S_ISREG(metadata.st_mode)
    or metadata.st_uid != os.getuid()
    or metadata.st_mode & 0o022
    or metadata.st_size <= 0
):
    raise SystemExit(1)
flags = os.O_RDONLY
if hasattr(os, "O_NOFOLLOW"):
    flags |= os.O_NOFOLLOW
descriptor = os.open(path, flags)
try:
    opened = os.fstat(descriptor)
    if (
        not stat.S_ISREG(opened.st_mode)
        or opened.st_dev != metadata.st_dev
        or opened.st_ino != metadata.st_ino
    ):
        raise SystemExit(1)
    digest = hashlib.sha256()
    while True:
        chunk = os.read(descriptor, 1024 * 1024)
        if not chunk:
            break
        digest.update(chunk)
    after = os.fstat(descriptor)
    if (
        after.st_dev != opened.st_dev
        or after.st_ino != opened.st_ino
        or after.st_size != opened.st_size
        or after.st_mtime_ns != opened.st_mtime_ns
        or after.st_ctime_ns != opened.st_ctime_ns
    ):
        raise SystemExit(1)
    print(
        f"{opened.st_dev}:{opened.st_ino}:{opened.st_size}:"
        f"{opened.st_mtime_ns}:{opened.st_ctime_ns}:{digest.hexdigest()}"
    )
finally:
    os.close(descriptor)
PY
}

validate_file_identity() {
  local path="$1"
  local expected="$2"
  local actual
  actual="$(capture_file_identity "$path")" || return 1
  [[ "$actual" == "$expected" ]]
}

publish_capture_copy() {
  local source="$1"
  local destination="$2"
  python3 - "$source" "$destination" <<'PY'
import os
import secrets
import stat
import sys

source, destination = sys.argv[1:]
trusted_uids = {0, os.getuid()}

def validate_directory(metadata):
    if (
        not stat.S_ISDIR(metadata.st_mode)
        or metadata.st_uid not in trusted_uids
        or metadata.st_mode & 0o022 and not metadata.st_mode & stat.S_ISVTX
    ):
        raise RuntimeError("recording output directory is unsafe")

def validate_directory_path(directory, allow_symlinks):
    current = os.sep
    validate_directory(os.stat(current))
    for component in directory.split(os.sep)[1:]:
        if not component:
            continue
        parent = os.stat(current)
        validate_directory(parent)
        candidate = os.path.join(current, component)
        entry = os.lstat(candidate)
        if (
            entry.st_uid not in trusted_uids
            or not (
                stat.S_ISDIR(entry.st_mode)
                or allow_symlinks and stat.S_ISLNK(entry.st_mode)
            )
        ):
            raise RuntimeError("recording output directory is unsafe")
        current = candidate
    validate_directory(os.stat(current))

def open_destination_directory(path):
    if not os.path.isabs(path):
        raise RuntimeError("recording output path is not absolute")
    directory = os.path.dirname(os.path.normpath(path))
    validate_directory_path(directory, True)
    resolved = os.path.realpath(directory)
    validate_directory_path(resolved, False)
    directory_flags = os.O_RDONLY
    if hasattr(os, "O_DIRECTORY"):
        directory_flags |= os.O_DIRECTORY
    if hasattr(os, "O_NOFOLLOW"):
        directory_flags |= os.O_NOFOLLOW
    descriptor = os.open(resolved, directory_flags)
    validate_directory(os.fstat(descriptor))
    destination_name = os.path.basename(path)
    try:
        existing = os.stat(
            destination_name,
            dir_fd=descriptor,
            follow_symlinks=False,
        )
    except FileNotFoundError:
        pass
    else:
        if existing.st_uid != os.getuid():
            os.close(descriptor)
            raise RuntimeError("recording output path is unsafe")
    return descriptor, destination_name

source_flags = os.O_RDONLY
if hasattr(os, "O_NOFOLLOW"):
    source_flags |= os.O_NOFOLLOW
source_descriptor = os.open(source, source_flags)
destination_descriptor = -1
temporary_descriptor = -1
temporary_path = ""
try:
    source_before = os.fstat(source_descriptor)
    if (
        not stat.S_ISREG(source_before.st_mode)
        or source_before.st_uid != os.getuid()
        or source_before.st_mode & 0o022
        or source_before.st_size <= 0
    ):
        raise RuntimeError("recording source is unsafe")
    destination_descriptor, destination_name = open_destination_directory(destination)
    temporary_flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        temporary_flags |= os.O_NOFOLLOW
    for _ in range(128):
        temporary_path = f".rn-dev-agent-record.{secrets.token_hex(16)}"
        try:
            temporary_descriptor = os.open(
                temporary_path,
                temporary_flags,
                0o600,
                dir_fd=destination_descriptor,
            )
            break
        except FileExistsError:
            continue
    if temporary_descriptor < 0:
        raise RuntimeError("recording publication temporary is unavailable")
    os.fchmod(temporary_descriptor, 0o600)
    while True:
        chunk = os.read(source_descriptor, 1024 * 1024)
        if not chunk:
            break
        view = memoryview(chunk)
        while view:
            written = os.write(temporary_descriptor, view)
            view = view[written:]
    os.fsync(temporary_descriptor)
    source_after = os.fstat(source_descriptor)
    if (
        source_after.st_dev != source_before.st_dev
        or source_after.st_ino != source_before.st_ino
        or source_after.st_size != source_before.st_size
        or source_after.st_mtime_ns != source_before.st_mtime_ns
        or source_after.st_ctime_ns != source_before.st_ctime_ns
    ):
        raise RuntimeError("recording source changed during publication")
    temporary_before = os.fstat(temporary_descriptor)
    temporary_path_before = os.stat(
        temporary_path,
        dir_fd=destination_descriptor,
        follow_symlinks=False,
    )
    if (
        temporary_path_before.st_dev != temporary_before.st_dev
        or temporary_path_before.st_ino != temporary_before.st_ino
    ):
        raise RuntimeError("recording publication temporary changed")
    os.replace(
        temporary_path,
        destination_name,
        src_dir_fd=destination_descriptor,
        dst_dir_fd=destination_descriptor,
    )
    temporary_path = ""
    destination_after = os.stat(
        destination_name,
        dir_fd=destination_descriptor,
        follow_symlinks=False,
    )
    if (
        destination_after.st_dev != temporary_before.st_dev
        or destination_after.st_ino != temporary_before.st_ino
    ):
        raise RuntimeError("recording publication destination changed")
    os.close(temporary_descriptor)
    temporary_descriptor = -1
finally:
    os.close(source_descriptor)
    if temporary_descriptor >= 0:
        os.close(temporary_descriptor)
    if temporary_path and destination_descriptor >= 0:
        try:
            os.unlink(temporary_path, dir_fd=destination_descriptor)
        except FileNotFoundError:
            pass
    if destination_descriptor >= 0:
        os.close(destination_descriptor)
PY
}

write_cleanup_receipt() {
  local path="$1"
  local pid="$2"
  local birth="$3"
  local output="$4"
  local output_identity="$5"
  local size="$6"
  shift 6
  local artifact_count=$(($# / 2))
  local receipt=$'v2\n'"$pid"$'\n'"$birth"$'\n'"$output"$'\n'"$output_identity"$'\n'"$size"$'\n'"$artifact_count"
  while [[ $# -gt 0 ]]; do
    receipt+=$'\n'"$1"$'\n'"$2"
    shift 2
  done
  secure_write_sidecar "$path" "$receipt"
}

load_cleanup_receipt() {
  local path="$1"
  local expected_pid="$2"
  local expected_birth="$3"
  CLEANUP_VERSION="$(sed -n '1p' "$path")"
  CLEANUP_PID="$(sed -n '2p' "$path")"
  CLEANUP_BIRTH="$(sed -n '3p' "$path")"
  CLEANUP_OUTPUT="$(sed -n '4p' "$path")"
  CLEANUP_OUTPUT_IDENTITY="$(sed -n '5p' "$path")"
  CLEANUP_SIZE="$(sed -n '6p' "$path")"
  CLEANUP_ARTIFACT_PATHS=()
  CLEANUP_ARTIFACT_IDENTITIES=()
  [[
    "$CLEANUP_PID" == "$expected_pid" &&
      "$CLEANUP_BIRTH" == "$expected_birth" &&
      "$CLEANUP_SIZE" =~ ^[1-9][0-9]*$ &&
      -n "$CLEANUP_OUTPUT" &&
      -n "$CLEANUP_OUTPUT_IDENTITY"
  ]] || return 1
  if [[ "$CLEANUP_VERSION" == "v1" ]]; then
    return 0
  fi
  [[ "$CLEANUP_VERSION" == "v2" ]] || return 1
  local artifact_count
  artifact_count="$(sed -n '7p' "$path")"
  [[ "$artifact_count" =~ ^[0-2]$ ]] || return 1
  local index
  for ((index = 0; index < artifact_count; index++)); do
    local path_line=$((8 + index * 2))
    local identity_line=$((path_line + 1))
    CLEANUP_ARTIFACT_PATHS+=("$(sed -n "${path_line}p" "$path")")
    CLEANUP_ARTIFACT_IDENTITIES+=("$(sed -n "${identity_line}p" "$path")")
  done
}

migrate_v1_cleanup_receipt() {
  local scope="$1"
  local cleanup_path="$2"
  local pull_manifest
  pull_manifest="$(pull_manifest_file "$scope")"
  CLEANUP_ARTIFACT_PATHS=()
  CLEANUP_ARTIFACT_IDENTITIES=()
  if [[ -s "$pull_manifest" ]]; then
    validate_legacy_sidecar "$pull_manifest"
    [[ "$(sed -n '1p' "$pull_manifest")" == "v1" ]] || return 1
    local index
    for index in 0 1; do
      local path_line=$((2 + index * 2))
      local identity_line=$((path_line + 1))
      local artifact_path
      local artifact_identity
      artifact_path="$(sed -n "${path_line}p" "$pull_manifest")"
      artifact_identity="$(sed -n "${identity_line}p" "$pull_manifest")"
      [[ -n "$artifact_path" ]] || continue
      validate_raw_capture_path "$artifact_path"
      if sidecar_exists "$artifact_path"; then
        [[ -n "$artifact_identity" ]] &&
          validate_file_identity "$artifact_path" "$artifact_identity" || return 1
        CLEANUP_ARTIFACT_PATHS+=("$artifact_path")
        CLEANUP_ARTIFACT_IDENTITIES+=("$artifact_identity")
      fi
    done
  else
    local raw_path_sidecar="${PID_PREFIX}-${scope}.raw-path"
    local raw_identity_sidecar
    raw_identity_sidecar="$(raw_identity_file "$scope")"
    if [[ -s "$raw_path_sidecar" ]]; then
      validate_legacy_sidecar "$raw_path_sidecar"
      local artifact_path
      artifact_path="$(cat "$raw_path_sidecar")"
      validate_raw_capture_path "$artifact_path"
      if sidecar_exists "$artifact_path"; then
        [[ -s "$raw_identity_sidecar" ]] || return 1
        validate_legacy_sidecar "$raw_identity_sidecar"
        local artifact_identity
        artifact_identity="$(cat "$raw_identity_sidecar")"
        validate_file_identity "$artifact_path" "$artifact_identity" || return 1
        CLEANUP_ARTIFACT_PATHS+=("$artifact_path")
        CLEANUP_ARTIFACT_IDENTITIES+=("$artifact_identity")
      fi
    fi
  fi
  local -a artifacts=()
  local index
  for ((index = 0; index < ${#CLEANUP_ARTIFACT_PATHS[@]}; index++)); do
    artifacts+=(
      "${CLEANUP_ARTIFACT_PATHS[$index]}"
      "${CLEANUP_ARTIFACT_IDENTITIES[$index]}"
    )
  done
  write_cleanup_receipt \
    "$cleanup_path" \
    "$CLEANUP_PID" \
    "$CLEANUP_BIRTH" \
    "$CLEANUP_OUTPUT" \
    "$CLEANUP_OUTPUT_IDENTITY" \
    "$CLEANUP_SIZE" \
    "${artifacts[@]}"
  CLEANUP_VERSION="v2"
}

complete_cleanup_receipt() {
  local scope="$1"
  local incarnation="$2"
  local cleanup_path="$3"
  if [[ "$CLEANUP_VERSION" == "v1" ]]; then
    migrate_v1_cleanup_receipt "$scope" "$cleanup_path" || {
      echo "Error: legacy recorder cleanup recovery state is invalid" >&2
      return 1
    }
  fi
  local recovery_artifact=""
  local recovery_identity=""
  local index
  for ((index = 0; index < ${#CLEANUP_ARTIFACT_PATHS[@]}; index++)); do
    local artifact_path="${CLEANUP_ARTIFACT_PATHS[$index]}"
    local artifact_identity="${CLEANUP_ARTIFACT_IDENTITIES[$index]}"
    validate_raw_capture_path "$artifact_path"
    if sidecar_exists "$artifact_path"; then
      validate_file_identity "$artifact_path" "$artifact_identity" || {
        echo "Error: cleanup artifact identity changed" >&2
        return 1
      }
      if [[ -z "$recovery_artifact" ]]; then
        recovery_artifact="$artifact_path"
        recovery_identity="$artifact_identity"
      fi
    fi
  done
  if ! validate_file_identity "$CLEANUP_OUTPUT" "$CLEANUP_OUTPUT_IDENTITY"; then
    [[ -n "$recovery_artifact" ]] || {
      echo "Error: finalized recording output identity changed" >&2
      return 1
    }
    publish_capture_copy "$recovery_artifact" "$CLEANUP_OUTPUT"
    CLEANUP_OUTPUT_IDENTITY="$(capture_file_identity "$CLEANUP_OUTPUT")" || return 1
    CLEANUP_SIZE="$(wc -c < "$CLEANUP_OUTPUT" | tr -d ' ')"
    local -a artifacts=()
    for ((index = 0; index < ${#CLEANUP_ARTIFACT_PATHS[@]}; index++)); do
      artifacts+=(
        "${CLEANUP_ARTIFACT_PATHS[$index]}"
        "${CLEANUP_ARTIFACT_IDENTITIES[$index]}"
      )
    done
    write_cleanup_receipt \
      "$cleanup_path" \
      "$CLEANUP_PID" \
      "$CLEANUP_BIRTH" \
      "$CLEANUP_OUTPUT" \
      "$CLEANUP_OUTPUT_IDENTITY" \
      "$CLEANUP_SIZE" \
      "${artifacts[@]}"
  fi
  for ((index = 0; index < ${#CLEANUP_ARTIFACT_PATHS[@]}; index++)); do
    local artifact_path="${CLEANUP_ARTIFACT_PATHS[$index]}"
    local artifact_identity="${CLEANUP_ARTIFACT_IDENTITIES[$index]}"
    if [[ "$artifact_path" != "$recovery_artifact" ]] && sidecar_exists "$artifact_path"; then
      remove_owned_state_path "$artifact_path"
    fi
  done
  remove_recording_sidecars "$scope" "$incarnation" "true"
  if ! validate_file_identity "$CLEANUP_OUTPUT" "$CLEANUP_OUTPUT_IDENTITY"; then
    [[ -n "$recovery_artifact" ]] || {
      echo "Error: finalized recording output identity changed" >&2
      return 1
    }
    validate_file_identity "$recovery_artifact" "$recovery_identity" || {
      echo "Error: cleanup recovery artifact identity changed" >&2
      return 1
    }
    publish_capture_copy "$recovery_artifact" "$CLEANUP_OUTPUT"
    CLEANUP_OUTPUT_IDENTITY="$(capture_file_identity "$CLEANUP_OUTPUT")" || return 1
    CLEANUP_SIZE="$(wc -c < "$CLEANUP_OUTPUT" | tr -d ' ')"
    write_cleanup_receipt \
      "$cleanup_path" \
      "$CLEANUP_PID" \
      "$CLEANUP_BIRTH" \
      "$CLEANUP_OUTPUT" \
      "$CLEANUP_OUTPUT_IDENTITY" \
      "$CLEANUP_SIZE" \
      "$recovery_artifact" \
      "$recovery_identity"
  fi
  if [[ -n "$recovery_artifact" ]]; then
    remove_owned_state_path "$recovery_artifact"
  fi
  release_cleanup_claim "$scope"
  echo "Saved: $CLEANUP_OUTPUT ($CLEANUP_SIZE bytes)"
}

current_incarnation() {
  if [[ "$USING_LEGACY_SCOPE" == "true" ]]; then
    printf '%s' "$LEGACY_INCARNATION"
    return
  fi
  local file
  file="$(incarnation_file "$1")"
  [[ -s "$file" ]] || return 0
  local incarnation
  incarnation="$(cat "$file")"
  [[ "$incarnation" =~ ^[a-f0-9]{32}$ ]] || {
    echo "Error: recorder supervisor incarnation is invalid" >&2
    return 1
  }
  printf '%s' "$incarnation"
}

supervisor_sidecar_file() {
  local scope="$1"
  local suffix="$2"
  local incarnation="${3:-}"
  [[ -n "$incarnation" ]] || incarnation="$(current_incarnation "$scope")"
  if [[ -n "$incarnation" ]]; then
    echo "${PID_PREFIX}-${scope}-${incarnation}.${suffix}"
  else
    echo "${PID_PREFIX}-${scope}.${suffix}"
  fi
}

control_token_file() { supervisor_sidecar_file "$1" "control-token" "${2:-}"; }
control_request_file() { supervisor_sidecar_file "$1" "control-request" "${2:-}"; }
control_response_file() { supervisor_sidecar_file "$1" "control-response" "${2:-}"; }
supervisor_state_file() { supervisor_sidecar_file "$1" "supervisor-state" "${2:-}"; }
child_pid_file() { supervisor_sidecar_file "$1" "child-pid" "${2:-}"; }

assert_current_incarnation() {
  local current
  current="$(current_incarnation "$1")"
  [[ -n "$current" && "$current" == "$2" ]] || {
    echo "Error: recorder supervisor incarnation changed during startup" >&2
    return 1
  }
}

supervisor_state_is_authenticated() {
  [[ "$USING_LEGACY_SCOPE" != "true" || -n "$LEGACY_INCARNATION" ]]
}

remove_owned_state_path() {
  local path="$1"
  if [[ "$USING_LEGACY_SCOPE" != "true" ]]; then
    rm -f "$path"
    return
  fi
  python3 - "$path" <<'PY'
import os
import stat
import sys

path = sys.argv[1]
try:
    metadata = os.lstat(path)
except FileNotFoundError:
    raise SystemExit(0)
if (
    stat.S_ISREG(metadata.st_mode)
    and metadata.st_uid == os.getuid()
    and not metadata.st_mode & 0o022
):
    os.unlink(path)
PY
}

remove_recording_sidecars() {
  local scope="$1"
  local incarnation="${2:-}"
  local preserve_cleanup="${3:-false}"
  local path
  for path in "${PID_PREFIX}-${scope}".{path,platform,raw-path,raw-identity,pull-manifest,log,serial,remote-pid,remote-birth,remote-command,remote-args,device-path,finalized-path,finalized-identity}; do
    remove_owned_state_path "$path"
  done
  local cleanup_path
  cleanup_path="$(cleanup_pending_file "$scope")"
  if [[ "$preserve_cleanup" != "true" && -s "$cleanup_path" ]]; then
    remove_owned_state_path "$(birth_file "$scope")"
    remove_owned_state_path "$(pid_file "$scope")"
  fi
  for path in \
    "$(control_token_file "$scope" "$incarnation")" \
    "$(control_request_file "$scope" "$incarnation")" \
    "$(control_response_file "$scope" "$incarnation")" \
    "$(supervisor_state_file "$scope" "$incarnation")" \
    "$(child_pid_file "$scope" "$incarnation")"; do
    remove_owned_state_path "$path"
  done
  local incarnation_path
  incarnation_path="$(incarnation_file "$scope")"
  if [[ -n "$incarnation" && -s "$incarnation_path" ]] && [[ "$(cat "$incarnation_path")" == "$incarnation" ]]; then
    remove_owned_state_path "$incarnation_path"
  elif [[ -z "$incarnation" ]]; then
    remove_owned_state_path "$incarnation_path"
  fi
  if [[ "$preserve_cleanup" == "true" ]]; then
    return
  fi
  if [[ ! -s "$cleanup_path" ]]; then
    remove_owned_state_path "$(birth_file "$scope")"
    remove_owned_state_path "$(pid_file "$scope")"
  fi
  remove_owned_state_path "$cleanup_path"
}

release_cleanup_claim() {
  local scope="$1"
  remove_owned_state_path "$(birth_file "$scope")"
  remove_owned_state_path "$(pid_file "$scope")"
  remove_owned_state_path "$(cleanup_pending_file "$scope")"
}

is_alive() {
  local pid="$1"
  kill -0 "$pid" 2>/dev/null
}

hash_process_identity() {
  {
    local index=0
    local part
    for part in "$@"; do
      [[ $index -gt 0 ]] && printf '\0'
      printf '%s' "$part"
      index=$((index + 1))
    done
  } |
    if command -v shasum >/dev/null 2>&1; then
      shasum -a 256
    else
      sha256sum
    fi |
    awk '{print $1}'
}

LOCAL_PROCESS_STATE="unknown"
LOCAL_PROCESS_BIRTH=""
LOCAL_PROCESS_MARKER_MATCH="false"

darwin_process_birth_info() {
  local helper="$1"
  local pid="$2"
  local requirement="$3"
  /bin/zsh -f -c '
    set -euo pipefail
    helper_pid=
    cleanup() {
      if [[ -n "$helper_pid" ]]; then
        /bin/kill -CONT "$helper_pid" 2>/dev/null || true
        /bin/kill -KILL "$helper_pid" 2>/dev/null || true
        wait "$helper_pid" 2>/dev/null || true
      fi
    }
    trap cleanup EXIT HUP INT TERM
    coproc "$1" "$2" --hold
    helper_pid=$!
    IFS= read -r -p result
    /usr/bin/codesign --verify --strict --requirement "$3" "+$helper_pid" >/dev/null 2>&1
    /bin/kill -CONT "$helper_pid"
    attempt=0
    while (( attempt < 100 )); do
      state=$(/bin/ps -p "$helper_pid" -o state= 2>/dev/null || true)
      [[ -z "$state" || "$state" == Z* ]] && break
      /bin/sleep 0.01
      (( attempt += 1 ))
    done
    [[ -z "$state" || "$state" == Z* ]]
    wait "$helper_pid" 2>/dev/null || true
    helper_pid=
    trap - EXIT HUP INT TERM
    print -r -- "$result"
  ' rn-process-birth "$helper" "$pid" "$requirement"
}

probe_local_process() {
  local pid="$1"
  local marker="$2"
  LOCAL_PROCESS_STATE="unknown"
  LOCAL_PROCESS_BIRTH=""
  LOCAL_PROCESS_MARKER_MATCH="false"
  if ! is_alive "$pid"; then
    LOCAL_PROCESS_STATE="absent"
    return 0
  fi

  local command
  command="$(ps -ww -p "$pid" -o command= 2>/dev/null)" || {
    is_alive "$pid" || {
      LOCAL_PROCESS_STATE="absent"
      return 0
    }
    echo "Error: recorder command identity is unavailable" >&2
    return 1
  }
  [[ "$command" == *"$marker"* ]] && LOCAL_PROCESS_MARKER_MATCH="true"

  local platform
  platform="$(uname -s)"
  if [[ "$platform" == "Darwin" ]]; then
    local helper="${RN_DEV_AGENT_PROCESS_BIRTH_HELPER:-}"
    local requirement="${RN_DEV_AGENT_PROCESS_BIRTH_REQUIREMENT:-}"
    [[ -x "$helper" && -n "$requirement" ]] || {
      echo "Error: Darwin recorder process-birth helper is unavailable" >&2
      return 1
    }
    local info
    local boot_session
    boot_session="$(/usr/sbin/sysctl -n kern.bootsessionuuid 2>/dev/null)" || {
      echo "Error: recorder boot identity is unavailable" >&2
      return 1
    }
    info="$(darwin_process_birth_info "$helper" "$pid" "$requirement" 2>/dev/null)" || {
      is_alive "$pid" || {
        LOCAL_PROCESS_STATE="absent"
        return 0
      }
      echo "Error: recorder process birth is unavailable" >&2
      return 1
    }
    [[ "$info" =~ ^${pid}:([0-9]+):([0-9]+)$ ]] || {
      echo "Error: recorder process birth identity is invalid" >&2
      return 1
    }
    LOCAL_PROCESS_BIRTH="$(
      hash_process_identity "darwin" "$(printf '%s' "$boot_session" | tr '[:upper:]' '[:lower:]')" "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}"
    )"
  elif [[ "$platform" == "Linux" ]]; then
    local stat_before
    local stat_after
    local boot_id
    stat_before="$(cat "/proc/$pid/stat" 2>/dev/null)" || {
      [[ ! -e "/proc/$pid" ]] && {
        LOCAL_PROCESS_STATE="absent"
        return 0
      }
      echo "Error: recorder process birth is unavailable" >&2
      return 1
    }
    boot_id="$(cat /proc/sys/kernel/random/boot_id 2>/dev/null)" || {
      echo "Error: recorder boot identity is unavailable" >&2
      return 1
    }
    stat_after="$(cat "/proc/$pid/stat" 2>/dev/null)" || {
      [[ ! -e "/proc/$pid" ]] && {
        LOCAL_PROCESS_STATE="absent"
        return 0
      }
      echo "Error: recorder process changed during identity capture" >&2
      return 1
    }
    local before_tail="${stat_before##*) }"
    local after_tail="${stat_after##*) }"
    local start_before
    local start_after
    start_before="$(printf '%s\n' "$before_tail" | awk '{print $20}')"
    start_after="$(printf '%s\n' "$after_tail" | awk '{print $20}')"
    [[ "$start_before" =~ ^[0-9]+$ && "$start_before" == "$start_after" ]] || {
      echo "Error: recorder process birth identity changed" >&2
      return 1
    }
    LOCAL_PROCESS_BIRTH="$(hash_process_identity "linux" "$boot_id" "$start_before")"
  else
    echo "Error: recorder process birth is unsupported on $platform" >&2
    return 1
  fi

  local command_after
  command_after="$(ps -ww -p "$pid" -o command= 2>/dev/null)" || {
    is_alive "$pid" || {
      LOCAL_PROCESS_STATE="absent"
      return 0
    }
    echo "Error: recorder command changed during identity capture" >&2
    return 1
  }
  [[ "$command_after" == *"$marker"* ]] || LOCAL_PROCESS_MARKER_MATCH="false"
  [[ "$LOCAL_PROCESS_BIRTH" =~ ^[a-f0-9]{64}$ ]] || {
    echo "Error: recorder process birth token is invalid" >&2
    return 1
  }
  LOCAL_PROCESS_STATE="present"
}

SUPERVISOR_PID=""
SUPERVISOR_BIRTH=""

start_supervised_recorder() {
  local scope="$1"
  local recorder_log="$2"
  local process_marker="$3"
  shift 3
  local token
  local incarnation
  token="$(python3 -c 'import secrets; print(secrets.token_hex(32))')"
  incarnation="$(python3 -c 'import secrets; print(secrets.token_hex(16))')"
  local request_path
  local response_path
  local state_path
  local child_path
  local token_path
  request_path="$(control_request_file "$scope" "$incarnation")"
  response_path="$(control_response_file "$scope" "$incarnation")"
  state_path="$(supervisor_state_file "$scope" "$incarnation")"
  child_path="$(child_pid_file "$scope" "$incarnation")"
  token_path="$(control_token_file "$scope" "$incarnation")"
  rm -f "$token_path" "$request_path" "$response_path" "$state_path" "$child_path"
  secure_write_sidecar "$(incarnation_file "$scope")" "$incarnation"
  assert_current_incarnation "$scope" "$incarnation"
  secure_publish "$recorder_log" ""

  python3 - "$@" 3< <(printf '%s\0' "$token" "$request_path" "$response_path" "$state_path" "$child_path" "$recorder_log" "$SIDECAR_TEMP_DIR") >> "$recorder_log" 2>&1 <<'PY' &
import os
import signal
import subprocess
import sys
import tempfile
import time

with os.fdopen(3, "rb") as config_file:
    config = config_file.read().split(b"\0")
if config[-1] == b"":
    config.pop()
if len(config) != 7:
    raise RuntimeError("invalid recorder supervisor configuration")
token, request_path, response_path, state_path, child_path, log_path, temp_dir = (
    value.decode("utf-8") for value in config
)
command = sys.argv[1:]
os.umask(0o077)

def write_atomic(path, value):
    descriptor, temporary = tempfile.mkstemp(prefix="sidecar.", dir=temp_dir, text=True)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(value)
        os.replace(temporary, path)
    except BaseException:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise

child = None
terminal_state_written = False
stop_requested = False
try:
    with open(log_path, "ab", buffering=0) as log:
        write_atomic(state_path, "starting\n")
        last_nonce = None
        startup_deadline = time.monotonic() + 5

        while child is None and not terminal_state_written:
            try:
                with open(request_path, encoding="utf-8") as handle:
                    parts = handle.read().split()
            except FileNotFoundError:
                parts = []

            if len(parts) == 3 and parts[0] == token and parts[1] != last_nonce:
                nonce, action = parts[1], parts[2]
                last_nonce = nonce
                if action == "START":
                    child = subprocess.Popen(
                        command,
                        stdin=subprocess.DEVNULL,
                        stdout=log,
                        stderr=subprocess.STDOUT,
                    )
                    write_atomic(child_path, f"{child.pid}\n")
                    write_atomic(state_path, "running\n")
                    result = "started"
                elif action == "ABORT":
                    write_atomic(state_path, "exited 0\n")
                    terminal_state_written = True
                    result = "gone"
                else:
                    result = "rejected"
                write_atomic(response_path, f"{nonce} {result}\n")

            if child is None and not terminal_state_written:
                if time.monotonic() >= startup_deadline:
                    raise TimeoutError("recorder supervisor start was not authorized")
                time.sleep(0.05)

        while child is not None and not terminal_state_written:
            try:
                with open(request_path, encoding="utf-8") as handle:
                    parts = handle.read().split()
            except FileNotFoundError:
                parts = []

            if len(parts) == 3 and parts[0] == token and parts[1] != last_nonce:
                nonce, action = parts[1], parts[2]
                last_nonce = nonce
                if action not in {"INT", "KILL", "ABORT"}:
                    result = "rejected"
                elif (return_code := child.poll()) is not None:
                    result = "gone"
                    state = (
                        f"exited {return_code}\n"
                        if return_code == 0
                        else f"failed {return_code}\n"
                    )
                    write_atomic(state_path, state)
                    terminal_state_written = True
                else:
                    try:
                        os.kill(
                            child.pid,
                            signal.SIGINT if action == "INT" else signal.SIGKILL,
                        )
                        result = "signaled"
                        stop_requested = True
                    except ProcessLookupError:
                        result = "gone"
                write_atomic(response_path, f"{nonce} {result}\n")
                if action == "ABORT" and not terminal_state_written:
                    return_code = child.wait()
                    write_atomic(state_path, f"exited {return_code}\n")
                    terminal_state_written = True

            return_code = child.poll()
            if return_code is not None and not terminal_state_written:
                state = (
                    f"exited {return_code}\n"
                    if stop_requested or return_code == 0
                    else f"failed {return_code}\n"
                )
                write_atomic(state_path, state)
                terminal_state_written = True
            time.sleep(0.05)
finally:
    if child is not None:
        if child.poll() is None:
            child.kill()
        child.wait()
    if not terminal_state_written:
        try:
            write_atomic(state_path, "failed supervisor\n")
        except OSError:
            pass
PY
  SUPERVISOR_PID=$!

  assert_current_incarnation "$scope" "$incarnation"
  secure_write_sidecar "$token_path" "$token"
  secure_write_sidecar "$(pid_file "$scope")" "$SUPERVISOR_PID"
  probe_local_process "$SUPERVISOR_PID" "$process_marker"
  [[ "$LOCAL_PROCESS_STATE" == "present" && "$LOCAL_PROCESS_MARKER_MATCH" == "true" ]] || {
    echo "Error: recorder supervisor died before identity capture" >&2
    return 1
  }
  SUPERVISOR_BIRTH="$LOCAL_PROCESS_BIRTH"
  secure_write_sidecar "$(birth_file "$scope")" "$SUPERVISOR_BIRTH"
  assert_current_incarnation "$scope" "$incarnation"
  request_supervisor_signal "$scope" "START" "$incarnation"

  local waited=0
  while [[ $waited -lt 40 ]]; do
    if [[ -s "$child_path" && -s "$state_path" ]] && [[ "$(cat "$state_path")" == "running" ]]; then
      return 0
    fi
    is_alive "$SUPERVISOR_PID" || break
    sleep 0.05
    waited=$((waited + 1))
  done
  echo "Error: recorder supervisor failed to start" >&2
  [[ -s "$recorder_log" ]] && sed -n '1,20p' "$recorder_log" >&2
  return 1
}

SUPERVISOR_TERMINAL_STATE=""

wait_for_supervisor_terminal() {
  local scope="$1"
  local incarnation="${2:-}"
  local state_path
  state_path="$(supervisor_state_file "$scope" "$incarnation")"
  local waited=0
  while [[ $waited -lt 100 ]]; do
    if [[ -s "$state_path" ]]; then
      local state
      state="$(cat "$state_path")"
      if [[ "$state" == exited\ * || "$state" == failed\ * ]]; then
        SUPERVISOR_TERMINAL_STATE="$state"
        return 0
      fi
    fi
    sleep 0.05
    waited=$((waited + 1))
  done
  echo "Error: recorder supervisor termination is unproven" >&2
  return 1
}

SUPERVISOR_RESPONSE=""

request_supervisor_signal() {
  local scope="$1"
  local action="$2"
  local incarnation="${3:-}"
  local token_path
  local request_path
  local response_path
  local state_path
  token_path="$(control_token_file "$scope" "$incarnation")"
  request_path="$(control_request_file "$scope" "$incarnation")"
  response_path="$(control_response_file "$scope" "$incarnation")"
  state_path="$(supervisor_state_file "$scope" "$incarnation")"
  [[ -s "$token_path" ]] || {
    echo "Error: recorder supervisor capability is unavailable" >&2
    return 1
  }
  local token
  local nonce
  token="$(cat "$token_path")"
  nonce="$$-${RANDOM}-${RANDOM}"
  secure_write_sidecar "$request_path" "$token $nonce $action"

  local waited=0
  while [[ $waited -lt 100 ]]; do
    if [[ -s "$response_path" ]]; then
      local response_nonce
      local response_result
      read -r response_nonce response_result < "$response_path"
      if [[ "$response_nonce" == "$nonce" ]]; then
        [[
          "$response_result" == "signaled" ||
            "$response_result" == "gone" ||
            ( "$action" == "START" && "$response_result" == "started" )
        ]] || {
          echo "Error: recorder supervisor rejected $action request" >&2
          return 1
        }
        SUPERVISOR_RESPONSE="$response_result"
        return 0
      fi
    fi
    if [[ -s "$state_path" ]]; then
      local supervisor_state
      supervisor_state="$(cat "$state_path")"
      if [[ "$supervisor_state" == exited\ * ]]; then
        SUPERVISOR_RESPONSE="gone"
        return 0
      fi
      if [[ "$supervisor_state" == failed\ * ]]; then
        echo "Error: recorder supervisor failed while handling $action request" >&2
        return 1
      fi
    fi
    sleep 0.05
    waited=$((waited + 1))
  done
  echo "Error: recorder supervisor did not acknowledge $action request" >&2
  return 1
}

android_adb() {
  local serial="$1"
  shift
  if [[ -n "$serial" ]]; then
    adb -s "$serial" "$@"
  else
    adb "$@"
  fi
}

require_android_device() {
  local serial="$1"
  local state
  state="$(android_adb "$serial" get-state 2>/dev/null | tr -d '\r')" || {
    echo "Error: Android device is unreachable" >&2
    return 1
  }
  [[ "$state" == "device" ]] || {
    echo "Error: Android device is not online" >&2
    return 1
  }
}

ANDROID_SCREENRECORD_PIDS=""

read_android_screenrecord_pids() {
  local serial="$1"
  require_android_device "$serial" || return 1
  ANDROID_SCREENRECORD_PIDS="$(
    android_adb "$serial" shell "pidof screenrecord || true" 2>/dev/null |
      tr -d '\r' |
      xargs
  )" || {
    echo "Error: Android screenrecord lookup failed" >&2
    return 1
  }
  require_android_device "$serial" || return 1
}

ANDROID_PROCESS_STATE="unknown"
ANDROID_PROCESS_BIRTH=""
ANDROID_PROCESS_COMMAND=""
ANDROID_PROCESS_ARGS=""

classify_android_identity_failure() {
  local serial="$1"
  local pid="$2"
  local message="$3"
  require_android_device "$serial" || return 1
  if android_adb "$serial" shell test ! -e "/proc/$pid" >/dev/null 2>&1; then
    ANDROID_PROCESS_STATE="absent"
    return 0
  fi
  require_android_device "$serial" || return 1
  echo "Error: $message" >&2
  return 1
}

probe_android_process() {
  local serial="$1"
  local pid="$2"
  ANDROID_PROCESS_STATE="unknown"
  ANDROID_PROCESS_BIRTH=""
  ANDROID_PROCESS_COMMAND=""
  ANDROID_PROCESS_ARGS=""
  require_android_device "$serial" || return 1

  local stat_before
  if ! stat_before="$(android_adb "$serial" shell cat "/proc/$pid/stat" 2>/dev/null | tr -d '\r')"; then
    classify_android_identity_failure "$serial" "$pid" "Android process identity is unavailable"
    return $?
  fi

  local boot_id
  boot_id="$(
    android_adb "$serial" shell cat /proc/sys/kernel/random/boot_id 2>/dev/null |
      tr -d '\r'
  )" || {
    classify_android_identity_failure "$serial" "$pid" "Android boot identity is unavailable"
    return $?
  }
  local command
  command="$(android_adb "$serial" shell readlink "/proc/$pid/exe" 2>/dev/null | tr -d '\r')" || {
    classify_android_identity_failure "$serial" "$pid" "Android process command identity is unavailable"
    return $?
  }
  local args
  args="$(android_adb "$serial" shell cat "/proc/$pid/cmdline" 2>/dev/null | tr '\000\r' '  ')" || {
    classify_android_identity_failure "$serial" "$pid" "Android process arguments are unavailable"
    return $?
  }
  local stat_after
  stat_after="$(android_adb "$serial" shell cat "/proc/$pid/stat" 2>/dev/null | tr -d '\r')" || {
    classify_android_identity_failure "$serial" "$pid" "Android process changed during identity capture"
    return $?
  }
  require_android_device "$serial" || return 1

  local before_tail="${stat_before##*) }"
  local after_tail="${stat_after##*) }"
  local start_before
  local start_after
  start_before="$(printf '%s\n' "$before_tail" | awk '{print $20}')"
  start_after="$(printf '%s\n' "$after_tail" | awk '{print $20}')"
  [[ "$boot_id" =~ ^[0-9a-fA-F-]{36}$ && "$start_before" =~ ^[0-9]+$ ]] || {
    echo "Error: Android process birth identity is invalid" >&2
    return 1
  }
  [[ "$start_before" == "$start_after" && -n "$command" ]] || {
    echo "Error: Android process identity changed or has no command" >&2
    return 1
  }
  ANDROID_PROCESS_STATE="present"
  ANDROID_PROCESS_BIRTH="${boot_id}:${start_before}"
  ANDROID_PROCESS_COMMAND="$command"
  ANDROID_PROCESS_ARGS="$args"
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
  select_scope_state "$scope"

  local pf
  pf="$(pid_file "$scope")"
  if scope_has_private_sidecars "$scope"; then
    if [[ -f "$pf" ]] && is_alive "$(cat "$pf")"; then
      echo "Error: Recording already in progress for $platform (PID $(cat "$pf"))" >&2
    else
      echo "Error: recorder state requires authenticated cleanup before restart" >&2
    fi
    exit 1
  fi
  if [[ "$USING_LEGACY_SCOPE" == "true" ]]; then
    echo "Error: legacy recording state requires authenticated cleanup before restart" >&2
    exit 1
  fi

  mkdir -p "$(dirname "$output_path")"
  output_path="$(cd "$(dirname "$output_path")" && pwd)/$(basename "$output_path")"

  ensure_sidecar_temp_dir
  local raw_file="${SIDECAR_TEMP_DIR}/raw-${platform}-$$.mov"
  local recorder_log="${PID_PREFIX}-${scope}.log"
  local rec_pid
  local -a recorder_command=()

  if [[ "$platform" == "ios" ]]; then
    if ! xcrun simctl list devices booted 2>/dev/null | grep -q "Booted"; then
      echo "Error: No iOS simulator booted" >&2
      exit 1
    fi
    local ios_target="${target_id:-booted}"
    secure_write_sidecar "$(platform_file "$scope")" "$platform"
    secure_write_sidecar "$(path_file "$scope")" "$output_path"
    secure_write_sidecar "${PID_PREFIX}-${scope}.raw-path" "$raw_file"
    recorder_command=(xcrun simctl io "$ios_target" recordVideo --force "$raw_file")
  else
    raw_file="${SIDECAR_TEMP_DIR}/raw-${platform}-$$.mp4"
    if ! adb devices 2>/dev/null | grep -q "device$"; then
      echo "Error: No Android device connected" >&2
      exit 1
    fi
    local device_path="/sdcard/rn-dev-agent-proof-$$.mp4"
    read_android_screenrecord_pids "$target_id"
    if [[ -n "$ANDROID_SCREENRECORD_PIDS" ]]; then
      echo "Error: A screenrecord process already owns this device" >&2
      exit 1
    fi
    secure_write_sidecar "$(platform_file "$scope")" "$platform"
    secure_write_sidecar "$(path_file "$scope")" "$output_path"
    secure_write_sidecar "${PID_PREFIX}-${scope}.raw-path" "$raw_file"
    secure_write_sidecar "${PID_PREFIX}-${scope}.device-path" "$device_path"
    if [[ -n "$target_id" ]]; then
      secure_write_sidecar "${PID_PREFIX}-${scope}.serial" "$target_id"
    else
      rm -f "${PID_PREFIX}-${scope}.serial"
    fi
    if [[ -n "$target_id" ]]; then
      recorder_command=(adb -s "$target_id" shell screenrecord "$device_path")
    else
      recorder_command=(adb shell screenrecord "$device_path")
    fi
  fi

  local process_marker="$raw_file"
  [[ "$platform" == "android" ]] && process_marker="$device_path"
  start_supervised_recorder "$scope" "$recorder_log" "$process_marker" "${recorder_command[@]}"
  rec_pid="$SUPERVISOR_PID"
  local rec_birth="$SUPERVISOR_BIRTH"
  sleep 0.5
  probe_local_process "$rec_pid" "$process_marker"
  if [[
    "$LOCAL_PROCESS_STATE" != "present" ||
      "$LOCAL_PROCESS_BIRTH" != "$rec_birth" ||
      "$LOCAL_PROCESS_MARKER_MATCH" != "true"
  ]]; then
    echo "Error: Recording process died immediately" >&2
    [[ -s "$recorder_log" ]] && sed -n '1,20p' "$recorder_log" >&2
    exit 1
  fi

  if [[ "$platform" == "android" ]]; then
    read_android_screenrecord_pids "$target_id"
    local remote_pid="$ANDROID_SCREENRECORD_PIDS"
    [[ ! "$remote_pid" =~ ^[0-9]+$ ]] && { echo "Error: Could not bind the device-side screenrecord PID" >&2; exit 1; }
    probe_android_process "$target_id" "$remote_pid"
    [[
      "$ANDROID_PROCESS_STATE" == "present" &&
        "$ANDROID_PROCESS_COMMAND" == */screenrecord &&
        "$ANDROID_PROCESS_ARGS" == *"$device_path"*
    ]] || {
      echo "Error: Could not prove the device-side screenrecord identity" >&2
      exit 1
    }
    secure_write_sidecar "${PID_PREFIX}-${scope}.remote-pid" "$remote_pid"
    secure_write_sidecar "$(remote_birth_file "$scope")" "$ANDROID_PROCESS_BIRTH"
    secure_write_sidecar "$(remote_command_file "$scope")" "$ANDROID_PROCESS_COMMAND"
    secure_write_sidecar "$(remote_args_file "$scope")" "$ANDROID_PROCESS_ARGS"
  fi
  echo "Recording started: platform=$platform pid=$rec_pid birth=$rec_birth output=$output_path"
}

stop_android_recorder() {
  local scope="$1"
  local serialf="${PID_PREFIX}-${scope}.serial"
  local serial=""
  [[ -f "$serialf" ]] && serial="$(cat "$serialf")"
  local remote_pidf="${PID_PREFIX}-${scope}.remote-pid"
  if [[ ! -f "$remote_pidf" ]]; then
    read_android_screenrecord_pids "$serial"
    [[ -z "$ANDROID_SCREENRECORD_PIDS" ]] || {
      echo "Error: unbound device-side screenrecord remains active" >&2
      exit 1
    }
    return
  fi
  local remote_pid
  remote_pid="$(cat "$remote_pidf")"
  [[ ! "$remote_pid" =~ ^[0-9]+$ ]] && {
    echo "Error: invalid device-side screenrecord PID" >&2
    exit 1
  }
  local expected_birth=""
  local expected_command=""
  local expected_args=""
  [[ -f "$(remote_birth_file "$scope")" ]] && expected_birth="$(cat "$(remote_birth_file "$scope")")"
  [[ -f "$(remote_command_file "$scope")" ]] && expected_command="$(cat "$(remote_command_file "$scope")")"
  [[ -f "$(remote_args_file "$scope")" ]] && expected_args="$(cat "$(remote_args_file "$scope")")"
  local device_path=""
  [[ -f "${PID_PREFIX}-${scope}.device-path" ]] && device_path="$(cat "${PID_PREFIX}-${scope}.device-path")"
  [[
    "$expected_birth" =~ ^[0-9a-fA-F-]{36}:[0-9]+$ &&
      "$expected_command" == */screenrecord &&
      -n "$device_path" &&
      "$expected_args" == *"$device_path"*
  ]] || {
    echo "Error: device-side screenrecord identity is incomplete" >&2
    exit 1
  }
  probe_android_process "$serial" "$remote_pid"
  [[ "$ANDROID_PROCESS_STATE" == "absent" ]] && return
  [[ "$ANDROID_PROCESS_BIRTH" != "$expected_birth" ]] && return
  [[
    "$ANDROID_PROCESS_COMMAND" == "$expected_command" &&
      "$ANDROID_PROCESS_ARGS" == "$expected_args"
  ]] || {
    echo "Error: device-side screenrecord command identity changed" >&2
    exit 1
  }
  android_adb "$serial" shell kill -2 "$remote_pid" >/dev/null 2>&1 || {
    probe_android_process "$serial" "$remote_pid"
    [[ "$ANDROID_PROCESS_STATE" == "absent" ]] && return
    echo "Error: failed to signal device-side screenrecord PID $remote_pid" >&2
    exit 1
  }
  local waited=0
  while [[ $waited -lt 20 ]]; do
    sleep 0.5
    probe_android_process "$serial" "$remote_pid"
    if [[ "$ANDROID_PROCESS_STATE" == "absent" || "$ANDROID_PROCESS_BIRTH" != "$expected_birth" ]]; then
      return
    fi
    waited=$((waited + 1))
  done
  echo "Error: device-side screenrecord PID $remote_pid did not stop" >&2
  exit 1
}

cmd_abort() {
  local scope="${1:-}"
  [[ ! "$scope" =~ ^[a-f0-9]{64}$ ]] && { echo "Error: invalid recording scope" >&2; exit 1; }
  select_scope_state "$scope"
  local incarnation
  incarnation="$(current_incarnation "$scope")"
  local pf
  local tokenf
  local statef
  pf="$(pid_file "$scope")"
  tokenf="$(control_token_file "$scope" "$incarnation")"
  statef="$(supervisor_state_file "$scope" "$incarnation")"
  local supervisor_state=""
  if supervisor_state_is_authenticated && [[ -s "$statef" ]]; then
    supervisor_state="$(cat "$statef")"
  fi
  if [[ -s "$tokenf" && ( "$supervisor_state" == "starting" || "$supervisor_state" == "running" ) ]]; then
    local abort_failed="false"
    request_supervisor_signal "$scope" "ABORT" "$incarnation" || abort_failed="true"
    wait_for_supervisor_terminal "$scope" "$incarnation"
    if [[ "$abort_failed" == "true" && "$SUPERVISOR_TERMINAL_STATE" != failed\ * ]]; then
      echo "Error: recorder supervisor rejected authenticated abort" >&2
      exit 1
    fi
  elif [[ "$supervisor_state" == "starting" ]]; then
    wait_for_supervisor_terminal "$scope" "$incarnation"
  elif [[ "$supervisor_state" == "running" ]]; then
    echo "Error: recorder supervisor capability is unavailable" >&2
    exit 1
  elif [[ -z "$supervisor_state" && -f "$pf" ]]; then
    local pid
    pid="$(cat "$pf")"
    if [[ "$pid" =~ ^[0-9]+$ ]] && is_alive "$pid"; then
      echo "Error: refusing unauthenticated abort of live recorder PID $pid" >&2
      exit 1
    fi
  fi
  if [[ -f "$(platform_file "$scope")" ]] && [[ "$(cat "$(platform_file "$scope")")" == "android" ]]; then
    stop_android_recorder "$scope"
    local -a adb_args=()
    [[ -f "${PID_PREFIX}-${scope}.serial" ]] && adb_args+=(-s "$(cat "${PID_PREFIX}-${scope}.serial")")
    if [[ -f "${PID_PREFIX}-${scope}.device-path" ]]; then
      remove_android_device_capture \
        "$(cat "${PID_PREFIX}-${scope}.device-path")" \
        "${adb_args[@]+"${adb_args[@]}"}"
    fi
  fi
  if [[ -f "${PID_PREFIX}-${scope}.raw-path" ]]; then
    local raw_path
    raw_path="$(cat "${PID_PREFIX}-${scope}.raw-path")"
    validate_raw_capture_path "$raw_path"
    remove_owned_state_path "$raw_path"
  fi
  remove_recording_sidecars "$scope" "$incarnation"
}

remove_android_device_capture() {
  local device_path="$1"
  shift
  adb "$@" shell rm -f "$device_path" >/dev/null 2>&1 &&
    adb "$@" shell test ! -e "$device_path" >/dev/null 2>&1
}

validate_finalized_output_path() {
  local finalized_output="$1"
  local requested_output="$2"
  local expected_mp4="${requested_output%.*}.mp4"
  local expected_mov="${expected_mp4%.mp4}.mov"
  [[
    "$finalized_output" == "$expected_mp4" || "$finalized_output" == "$expected_mov"
  ]] || {
    echo "Error: finalized recording output is missing or invalid" >&2
    return 1
  }
}

cmd_stop() {
  local scope="${1:-}"
  local expected_pid="${2:-}"
  local expected_birth="${3:-}"
  [[ ! "$scope" =~ ^[a-f0-9]{64}$ || ! "$expected_pid" =~ ^[0-9]+$ || -z "$expected_birth" ]] && {
    echo "Error: stop requires valid <scope> <pid> <birth>" >&2
    exit 1
  }
  select_scope_state "$scope"
  local incarnation
  incarnation="$(current_incarnation "$scope")"
  local cleanup_path
  cleanup_path="$(cleanup_pending_file "$scope")"
  if [[ -s "$cleanup_path" ]]; then
    validate_legacy_sidecar "$cleanup_path"
    load_cleanup_receipt "$cleanup_path" "$expected_pid" "$expected_birth" || {
      echo "Error: pending recorder cleanup identity does not match scope" >&2
      exit 1
    }
    complete_cleanup_receipt "$scope" "$incarnation" "$cleanup_path"
    return
  fi
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
  local requested_output_path="$output_path"
  local finalized_pathf
  finalized_pathf="$(finalized_path_file "$scope")"
  local finalized_identityf
  finalized_identityf="$(finalized_identity_file "$scope")"
  local finalized_output=""
  local finalized_identity=""
  if [[ "$platform" == "android" && -s "$finalized_pathf" ]]; then
    finalized_output="$(cat "$finalized_pathf")"
    validate_finalized_output_path "$finalized_output" "$requested_output_path"
    if [[ -s "$finalized_identityf" ]]; then
      finalized_identity="$(cat "$finalized_identityf")"
      if validate_file_identity "$finalized_output" "$finalized_identity"; then
        output_path="$finalized_output"
      else
        finalized_output=""
        finalized_identity=""
      fi
    else
      finalized_output=""
    fi
  fi
  local raw_pathf="${PID_PREFIX}-${scope}.raw-path"
  local raw_identityf
  raw_identityf="$(raw_identity_file "$scope")"
  local pull_manifestf
  pull_manifestf="$(pull_manifest_file "$scope")"
  local raw_file=""
  local raw_identity=""
  local retained_raw_file=""
  local retained_raw_identity=""
  local pull_manifest_ready="false"
  [[ -f "$raw_pathf" ]] && raw_file="$(cat "$raw_pathf")"
  validate_raw_capture_path "$raw_file"
  if [[ -s "$pull_manifestf" ]]; then
    validate_legacy_sidecar "$pull_manifestf"
    [[ "$(sed -n '1p' "$pull_manifestf")" == "v1" ]] || {
      echo "Error: completed pull manifest is invalid" >&2
      exit 1
    }
    raw_file="$(sed -n '2p' "$pull_manifestf")"
    raw_identity="$(sed -n '3p' "$pull_manifestf")"
    validate_raw_capture_path "$raw_file"
    if sidecar_exists "$raw_file"; then
      validate_file_identity "$raw_file" "$raw_identity" || {
        echo "Error: completed pull identity changed" >&2
        exit 1
      }
      pull_manifest_ready="true"
    elif [[ -z "$finalized_output" ]]; then
      echo "Error: completed pull artifact is missing" >&2
      exit 1
    fi
    retained_raw_file="$(sed -n '4p' "$pull_manifestf")"
    retained_raw_identity="$(sed -n '5p' "$pull_manifestf")"
    if [[ -n "$retained_raw_file" ]]; then
      validate_raw_capture_path "$retained_raw_file"
      if sidecar_exists "$retained_raw_file"; then
        validate_file_identity "$retained_raw_file" "$retained_raw_identity" || {
          echo "Error: prior completed pull identity changed" >&2
          exit 1
        }
      fi
    fi
  elif [[ -s "$raw_identityf" ]]; then
    raw_identity="$(cat "$raw_identityf")"
    validate_file_identity "$raw_file" "$raw_identity" || raw_identity=""
  elif [[ -n "$raw_file" ]] && sidecar_exists "$raw_file"; then
    if raw_identity="$(capture_file_identity "$raw_file")"; then
      secure_write_sidecar "$raw_identityf" "$raw_identity"
    else
      raw_identity=""
    fi
  fi
  local supervisor_state=""
  if supervisor_state_is_authenticated && [[ -s "$(supervisor_state_file "$scope" "$incarnation")" ]]; then
    supervisor_state="$(cat "$(supervisor_state_file "$scope" "$incarnation")")"
  fi
  local supervisor_failed="false"
  [[ "$supervisor_state" == failed\ * ]] && supervisor_failed="true"
  local supervisor_terminal="false"
  [[ "$supervisor_state" == exited\ * || "$supervisor_state" == failed\ * ]] && supervisor_terminal="true"

  if [[ "$supervisor_terminal" == "true" ]]; then
    :
  elif is_alive "$pid"; then
    local process_marker="$raw_file"
    if [[ "$platform" == "android" && -f "${PID_PREFIX}-${scope}.device-path" ]]; then
      process_marker="$(cat "${PID_PREFIX}-${scope}.device-path")"
    fi
    probe_local_process "$pid" "$process_marker"
    [[
      "$LOCAL_PROCESS_STATE" == "present" &&
        "$LOCAL_PROCESS_BIRTH" == "$expected_birth" &&
        "$LOCAL_PROCESS_MARKER_MATCH" == "true"
    ]] || {
      echo "Error: recorder process identity changed before stop" >&2
      exit 1
    }
    request_supervisor_signal "$scope" "INT" "$incarnation"
    local waited=0
    local recorder_stopped="false"
    while [[ $waited -lt 10 ]]; do
      sleep 0.5
      probe_local_process "$pid" "$process_marker"
      if [[
        "$LOCAL_PROCESS_STATE" == "absent" ||
          "$LOCAL_PROCESS_BIRTH" != "$expected_birth"
      ]]; then
        recorder_stopped="true"
        break
      fi
      [[ "$LOCAL_PROCESS_MARKER_MATCH" == "true" ]] || {
        echo "Error: recorder command identity changed during stop" >&2
        exit 1
      }
      waited=$((waited + 1))
    done
    if [[ "$recorder_stopped" != "true" ]]; then
      probe_local_process "$pid" "$process_marker"
      if [[
        "$LOCAL_PROCESS_STATE" == "absent" ||
          "$LOCAL_PROCESS_BIRTH" != "$expected_birth"
      ]]; then
        recorder_stopped="true"
      else
        [[ "$LOCAL_PROCESS_MARKER_MATCH" == "true" ]] || {
          echo "Error: recorder command identity changed before force stop" >&2
          exit 1
        }
        request_supervisor_signal "$scope" "KILL" "$incarnation"
        local force_waited=0
        while [[ $force_waited -lt 6 ]]; do
          probe_local_process "$pid" "$process_marker"
          if [[
            "$LOCAL_PROCESS_STATE" == "absent" ||
              "$LOCAL_PROCESS_BIRTH" != "$expected_birth"
          ]]; then
            recorder_stopped="true"
            break
          fi
          [[ "$LOCAL_PROCESS_MARKER_MATCH" == "true" ]] || {
            echo "Error: recorder command identity changed after force stop" >&2
            exit 1
          }
          sleep 0.5
          force_waited=$((force_waited + 1))
        done
      fi
    fi
    [[ "$recorder_stopped" == "true" ]] || {
      echo "Error: authenticated recorder process termination is unproven" >&2
      exit 1
    }
  elif [[ "$supervisor_state" == "starting" || "$supervisor_state" == "running" ]]; then
    echo "Error: authenticated recorder supervisor disappeared before termination proof" >&2
    exit 1
  fi
  sleep 1

  if supervisor_state_is_authenticated && [[ -s "$(supervisor_state_file "$scope" "$incarnation")" ]]; then
    supervisor_state="$(cat "$(supervisor_state_file "$scope" "$incarnation")")"
    supervisor_failed="false"
    [[ "$supervisor_state" == failed\ * ]] && supervisor_failed="true"
  fi

  local -a adb_args=()
  local device_path=""
  local android_pull_failed="false"
  if [[ "$platform" == "android" ]]; then
    local serialf="${PID_PREFIX}-${scope}.serial"
    [[ -f "$serialf" ]] && adb_args+=(-s "$(cat "$serialf")")
    stop_android_recorder "$scope"
    local device_pathf="${PID_PREFIX}-${scope}.device-path"
    if [[ -f "$device_pathf" ]]; then
      device_path="$(cat "$device_pathf")"
      if [[
        "$supervisor_failed" != "true" &&
          -z "$finalized_output" &&
          "$pull_manifest_ready" != "true"
      ]]; then
        sleep 2
        local prior_raw_file="$raw_file"
        local prior_raw_identity="$raw_identity"
        local prior_raw_was_present="false"
        [[ -n "$prior_raw_file" ]] && sidecar_exists "$prior_raw_file" &&
          prior_raw_was_present="true"
        local pull_file
        pull_file="$(create_private_capture_file)"
        PENDING_PULL_FILE="$pull_file"
        PENDING_PULL_MANIFEST="$pull_manifestf"
        if adb "${adb_args[@]+"${adb_args[@]}"}" pull "$device_path" "$pull_file" >/dev/null 2>&1; then
          local pulled_identity
          pulled_identity="$(capture_file_identity "$pull_file")" || {
            echo "Warning: Pulled recording is empty or unstable" >&2
            pulled_identity=""
          }
          if [[ -n "$pulled_identity" ]]; then
            local prior_manifest_tail=""
            if [[
              -n "$prior_raw_file" &&
                "$prior_raw_file" != "$pull_file" &&
                -n "$prior_raw_identity"
            ]] && validate_file_identity "$prior_raw_file" "$prior_raw_identity"; then
              prior_manifest_tail=$'\n'"$prior_raw_file"$'\n'"$prior_raw_identity"
              retained_raw_file="$prior_raw_file"
              retained_raw_identity="$prior_raw_identity"
            fi
            secure_write_sidecar \
              "$pull_manifestf" \
              $'v1\n'"$pull_file"$'\n'"$pulled_identity""$prior_manifest_tail"
            raw_file="$pull_file"
            raw_identity="$pulled_identity"
            PENDING_PULL_FILE=""
            PENDING_PULL_MANIFEST=""
          else
            rm -f "$pull_file"
            raw_file="$prior_raw_file"
            raw_identity="$prior_raw_identity"
          fi
        else
          rm -f "$pull_file"
          PENDING_PULL_FILE=""
          PENDING_PULL_MANIFEST=""
          raw_file="$prior_raw_file"
          raw_identity="$prior_raw_identity"
        fi
        if [[ "$raw_file" == "$prior_raw_file" ]]; then
          if [[
            -n "$raw_file" &&
              -n "$prior_raw_identity"
          ]] && validate_file_identity "$raw_file" "$prior_raw_identity"; then
            echo "Warning: Failed to pull replacement recording; using completed existing capture" >&2
          else
            android_pull_failed="true"
            echo "Warning: Failed to pull recording from device" >&2
          fi
        fi
        if [[
          "$android_pull_failed" != "true" &&
            "$prior_raw_was_present" == "true" &&
            -n "$prior_raw_file" &&
            "$prior_raw_file" != "$raw_file"
        ]]; then
          [[
            "$retained_raw_file" == "$prior_raw_file" &&
              "$retained_raw_identity" == "$prior_raw_identity"
          ]] || {
            echo "Error: prior recording capture was not retained in the pull manifest" >&2
            return 1
          }
        fi
      fi
    fi
  fi

  if [[ "$supervisor_failed" == "true" ]]; then
    if [[ -n "$raw_file" && -n "$raw_identity" ]] &&
      validate_file_identity "$raw_file" "$raw_identity"; then
      remove_owned_state_path "$raw_file"
    fi
    if [[
      -n "$retained_raw_file" &&
        "$retained_raw_file" != "$raw_file" &&
        -n "$retained_raw_identity"
    ]] && validate_file_identity "$retained_raw_file" "$retained_raw_identity"; then
      remove_owned_state_path "$retained_raw_file"
    fi
    PENDING_PULL_FILE=""
    if [[ "$platform" == "android" && -n "$device_path" ]]; then
      remove_android_device_capture "$device_path" "${adb_args[@]+"${adb_args[@]}"}" || {
        echo "Error: failed to remove recording from device" >&2
        return 1
      }
    fi
    remove_recording_sidecars "$scope" "$incarnation"
    echo "Recorder failed: supervisor terminated unexpectedly"
    return 0
  fi
  if [[ "$android_pull_failed" == "true" ]]; then
    echo "Error: recording remains on device for retry" >&2
    return 1
  fi

  if [[ "$platform" == "android" ]]; then
    if [[ -z "$finalized_output" ]]; then
      output_path="${output_path%.*}.mp4"
      mkdir -p "$(dirname "$output_path")" || true
      [[ -n "$raw_file" && -n "$raw_identity" ]] &&
        validate_file_identity "$raw_file" "$raw_identity" || {
        echo "Error: completed recording capture is unavailable" >&2
        return 1
      }
      local staged_output="$raw_file"
      local staged_identity="$raw_identity"
      if command -v ffmpeg >/dev/null 2>&1; then
        local staged_mp4
        staged_mp4="$(create_private_capture_file)"
        PENDING_STAGE_FILE="$staged_mp4"
        if ffmpeg \
          -y \
          -i "$raw_file" \
          -c copy \
          -movflags +faststart \
          -f mp4 \
          "$staged_mp4" 2>/dev/null; then
          staged_output="$staged_mp4"
          staged_identity="$(capture_file_identity "$staged_output")" || {
            echo "Error: converted recording output is unstable" >&2
            return 1
          }
        else
          rm -f "$staged_mp4"
          PENDING_STAGE_FILE=""
          output_path="${output_path%.mp4}.mov"
        fi
      fi
      validate_file_identity "$staged_output" "$staged_identity" || {
        echo "Error: staged recording output identity changed" >&2
        return 1
      }
      publish_capture_copy "$staged_output" "$output_path"
      finalized_identity="$(capture_file_identity "$output_path")" || {
        echo "Error: finalized recording output identity is unsafe" >&2
        return 1
      }
      secure_write_sidecar "$finalized_identityf" "$finalized_identity"
      secure_write_sidecar "$finalized_pathf" "$output_path"
      finalized_output="$output_path"
      if [[ "$staged_output" != "$raw_file" ]]; then
        remove_owned_state_path "$staged_output"
        PENDING_STAGE_FILE=""
      fi
    fi
    if [[ -n "$device_path" ]]; then
      remove_android_device_capture "$device_path" "${adb_args[@]+"${adb_args[@]}"}" || {
        echo "Error: failed to remove recording from device" >&2
        return 1
      }
    fi
    local -a cleanup_artifacts=()
    if [[ -n "$raw_file" && -n "$raw_identity" ]] &&
      validate_file_identity "$raw_file" "$raw_identity"; then
      cleanup_artifacts+=("$raw_file" "$raw_identity")
    fi
    if [[
      -n "$retained_raw_file" &&
        "$retained_raw_file" != "$raw_file" &&
        -n "$retained_raw_identity"
    ]] && validate_file_identity "$retained_raw_file" "$retained_raw_identity"; then
      cleanup_artifacts+=("$retained_raw_file" "$retained_raw_identity")
    fi
    local size
    size="$(wc -c < "$output_path" | tr -d ' ')"
    write_cleanup_receipt \
      "$cleanup_path" \
      "$pid" \
      "$birth" \
      "$output_path" \
      "$finalized_identity" \
      "$size" \
      "${cleanup_artifacts[@]+"${cleanup_artifacts[@]}"}"
    load_cleanup_receipt "$cleanup_path" "$pid" "$birth" || {
      echo "Error: pending recorder cleanup identity is invalid" >&2
      return 1
    }
    complete_cleanup_receipt "$scope" "$incarnation" "$cleanup_path"
    PENDING_PULL_FILE=""
    PENDING_PULL_MANIFEST=""
    return
  else
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
      else
        mv "$raw_file" "${output_path%.mp4}.mov"
        output_path="${output_path%.mp4}.mov"
      fi
      rm -f "$raw_file"
      PENDING_PULL_FILE=""
    fi
  fi
  if [[ -n "$output_path" && -f "$output_path" ]]; then
    local size
    size="$(wc -c < "$output_path" | tr -d ' ')"
  fi
  remove_recording_sidecars "$scope" "$incarnation"
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
  select_scope_state "$scope"
  local cleanup_path
  cleanup_path="$(cleanup_pending_file "$scope")"
  if [[ -s "$cleanup_path" ]]; then
    validate_legacy_sidecar "$cleanup_path"
    local cleanup_pid
    local cleanup_birth
    local cleanup_output
    cleanup_pid="$(sed -n '2p' "$cleanup_path")"
    cleanup_birth="$(sed -n '3p' "$cleanup_path")"
    cleanup_output="$(sed -n '4p' "$cleanup_path")"
    echo "android: pid=$cleanup_pid birth=$cleanup_birth status=cleanup output=$cleanup_output"
    return
  fi
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

trap cleanup_pending_pull EXIT

case "${1:-}" in
  start)       shift; cmd_start "$@" ;;
  abort)       shift; cmd_abort "$@" ;;
  stop)        shift; cmd_stop "$@" ;;
  status)      shift; cmd_status "$@" ;;
  convert-gif) shift; cmd_convert_gif "$@" ;;
  label)       shift; cmd_label "$@" ;;
  *)           usage ;;
esac
