#!/usr/bin/env bash
set -euo pipefail

PID_PREFIX="/tmp/rn-dev-agent-record"
RAW_PREFIX="/tmp/rn-dev-agent-raw"
LEGACY_PID_PREFIX="$PID_PREFIX"
RUNTIME_DIR="${PID_PREFIX}.private-$(id -u)"
PID_PREFIX="${RUNTIME_DIR}/record"
SIDECAR_TEMP_DIR="${RUNTIME_DIR}/tmp"

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
incarnation_file() { echo "${PID_PREFIX}-${1}.incarnation"; }

ensure_sidecar_temp_dir() {
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
  for suffix in pid path platform birth raw-path log serial remote-pid remote-birth remote-command remote-args device-path incarnation; do
    sidecar_exists "${PID_PREFIX}-${scope}.${suffix}" && return 0
  done
  return 1
}

LEGACY_INCARNATION=""
LEGACY_SCOPE_PRESENT="false"
USING_LEGACY_SCOPE="false"

validate_legacy_scope() {
  local scope="$1"
  LEGACY_INCARNATION=""
  LEGACY_SCOPE_PRESENT="false"
  local suffix
  local legacy_path
  for suffix in pid path platform birth raw-path log serial remote-pid remote-birth remote-command remote-args device-path incarnation; do
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
  fi
}

select_scope_state() {
  local scope="$1"
  ensure_sidecar_temp_dir
  scope_has_private_sidecars "$scope" && return 0
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
  if [[ "$raw_path" == "$SIDECAR_TEMP_DIR/"* && "$private_tail" =~ ^raw-(ios|android)-[0-9]+\.(mov|mp4)$ ]]; then
    return 0
  fi
  private_tail="${raw_path#"$RUNTIME_DIR"/}"
  if [[ "$raw_path" == "$RUNTIME_DIR/"* && "$private_tail" =~ ^raw-(ios|android)-[0-9]+\.(mov|mp4)$ ]]; then
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

current_incarnation() {
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

remove_recording_sidecars() {
  local scope="$1"
  local incarnation="${2:-}"
  rm -f "${PID_PREFIX}-${scope}".{pid,path,platform,birth,raw-path,log,serial,remote-pid,remote-birth,remote-command,remote-args,device-path}
  rm -f \
    "$(control_token_file "$scope" "$incarnation")" \
    "$(control_request_file "$scope" "$incarnation")" \
    "$(control_response_file "$scope" "$incarnation")" \
    "$(supervisor_state_file "$scope" "$incarnation")" \
    "$(child_pid_file "$scope" "$incarnation")"
  local incarnation_path
  incarnation_path="$(incarnation_file "$scope")"
  if [[ -n "$incarnation" && -s "$incarnation_path" ]] && [[ "$(cat "$incarnation_path")" == "$incarnation" ]]; then
    rm -f "$incarnation_path"
  elif [[ -z "$incarnation" ]]; then
    rm -f "$incarnation_path"
  fi
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
    [[ -x "$helper" ]] || {
      echo "Error: Darwin recorder process-birth helper is unavailable" >&2
      return 1
    }
    local info_before
    local info_after
    local boot_session
    info_before="$("$helper" "$pid" 2>/dev/null)" || {
      is_alive "$pid" || {
        LOCAL_PROCESS_STATE="absent"
        return 0
      }
      echo "Error: recorder process birth is unavailable" >&2
      return 1
    }
    boot_session="$(/usr/sbin/sysctl -n kern.bootsessionuuid 2>/dev/null)" || {
      echo "Error: recorder boot identity is unavailable" >&2
      return 1
    }
    info_after="$("$helper" "$pid" 2>/dev/null)" || {
      is_alive "$pid" || {
        LOCAL_PROCESS_STATE="absent"
        return 0
      }
      echo "Error: recorder process changed during identity capture" >&2
      return 1
    }
    [[ "$info_before" == "$info_after" && "$info_before" =~ ^${pid}:([0-9]+):([0-9]+)$ ]] || {
      echo "Error: recorder process birth identity changed" >&2
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
  if [[ -f "$pf" ]] && is_alive "$(cat "$pf")"; then
    echo "Error: Recording already in progress for $platform (PID $(cat "$pf"))" >&2
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
  [[ -s "$statef" ]] && supervisor_state="$(cat "$statef")"
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
      adb "${adb_args[@]+"${adb_args[@]}"}" shell rm -f "$(cat "${PID_PREFIX}-${scope}.device-path")"
    fi
  fi
  if [[ -f "${PID_PREFIX}-${scope}.raw-path" ]]; then
    local raw_path
    raw_path="$(cat "${PID_PREFIX}-${scope}.raw-path")"
    validate_raw_capture_path "$raw_path"
    rm -f "$raw_path"
  fi
  remove_recording_sidecars "$scope" "$incarnation"
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
  validate_raw_capture_path "$raw_file"
  local supervisor_state=""
  [[ -s "$(supervisor_state_file "$scope" "$incarnation")" ]] && supervisor_state="$(cat "$(supervisor_state_file "$scope" "$incarnation")")"
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

  if [[ -s "$(supervisor_state_file "$scope" "$incarnation")" ]]; then
    supervisor_state="$(cat "$(supervisor_state_file "$scope" "$incarnation")")"
    supervisor_failed="false"
    [[ "$supervisor_state" == failed\ * ]] && supervisor_failed="true"
  fi

  if [[ "$platform" == "android" ]]; then
    local -a adb_args=()
    local serialf="${PID_PREFIX}-${scope}.serial"
    [[ -f "$serialf" ]] && adb_args+=(-s "$(cat "$serialf")")
    stop_android_recorder "$scope"
    local device_pathf="${PID_PREFIX}-${scope}.device-path"
    if [[ -f "$device_pathf" ]]; then
      local device_path
      device_path="$(cat "$device_pathf")"
      if [[ "$supervisor_failed" != "true" ]]; then
        sleep 2
        adb "${adb_args[@]+"${adb_args[@]}"}" pull "$device_path" "$raw_file" >/dev/null 2>&1 || echo "Warning: Failed to pull recording from device" >&2
      fi
      adb "${adb_args[@]+"${adb_args[@]}"}" shell rm -f "$device_path" 2>/dev/null || true
    fi
  fi

  if [[ "$supervisor_failed" == "true" ]]; then
    [[ -n "$raw_file" ]] && rm -f "$raw_file"
    remove_recording_sidecars "$scope" "$incarnation"
    echo "Recorder failed: supervisor terminated unexpectedly"
    return 0
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
  abort)       shift; cmd_abort "$@" ;;
  stop)        shift; cmd_stop "$@" ;;
  status)      shift; cmd_status "$@" ;;
  convert-gif) shift; cmd_convert_gif "$@" ;;
  label)       shift; cmd_label "$@" ;;
  *)           usage ;;
esac
