#!/usr/bin/env bash
# Auto-restart wrapper for the CDP bridge MCP server.
# Restarts on non-zero exit (crash), stops on exit 0 (clean SIGTERM).
# Max 5 restarts within a 60s window to prevent infinite crash loops.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_SCRIPT="$SCRIPT_DIR/dist/index.js"

# Ensure Android SDK tools are in PATH (agent-device needs adb)
# Honor ANDROID_SDK_ROOT (newer) over ANDROID_HOME (deprecated but still common)
if [ -n "${ANDROID_SDK_ROOT:-}" ] && [ -z "${ANDROID_HOME:-}" ]; then
  export ANDROID_HOME="$ANDROID_SDK_ROOT"
fi
if [ -z "${ANDROID_HOME:-}" ]; then
  for candidate in "$HOME/Library/Android/sdk" "$HOME/Android/Sdk" "/opt/android-sdk"; do
    if [ -d "$candidate" ]; then
      export ANDROID_HOME="$candidate"
      break
    fi
  done
fi
if [ -n "${ANDROID_HOME:-}" ]; then
  [[ ":$PATH:" != *":$ANDROID_HOME/platform-tools:"* ]] && export PATH="$ANDROID_HOME/platform-tools:$PATH"
  [[ ":$PATH:" != *":$ANDROID_HOME/emulator:"* ]] && export PATH="$ANDROID_HOME/emulator:$PATH"
fi

# Pick up ANDROID_SERIAL persisted by ensure-android-ready.sh (SessionStart hook)
SERIAL_FILE="${TMPDIR:-/tmp}/rn-dev-agent-android-serial"
if [ -z "${ANDROID_SERIAL:-}" ] && [ -f "$SERIAL_FILE" ]; then
  export ANDROID_SERIAL
  ANDROID_SERIAL="$(cat "$SERIAL_FILE")"
fi

# Ensure JDK is in PATH (needed for Gradle/Android builds)
if ! command -v java &>/dev/null; then
  for jdk in "/opt/homebrew/opt/openjdk@17" "/opt/homebrew/opt/openjdk"; do
    if [ -x "$jdk/bin/java" ]; then
      export JAVA_HOME="$jdk"
      export PATH="$jdk/bin:$PATH"
      break
    fi
  done
fi

# Forward CLAUDE_USER_CWD so nav-graph findProjectRoot can locate the RN project
# Claude Code sets this to the user's working directory at session start
if [ -z "${CLAUDE_USER_CWD:-}" ] && [ -n "${PWD:-}" ]; then
  export CLAUDE_USER_CWD="$PWD"
fi

if [ ! -d "$SCRIPT_DIR/node_modules" ]; then
  cd "$SCRIPT_DIR" && npm install --production --silent 2>/dev/null
fi

trap 'exit 0' SIGINT

# SIGUSR1 = hot-reload: kill node child → restart loop picks it up
# Usage: kill -USR1 $(cat /tmp/rn-dev-agent-cdp-bridge.pid)
NODE_PID=0
trap 'if [ "$NODE_PID" -ne 0 ]; then echo "CDP bridge: SIGUSR1 received, restarting..." >&2; kill "$NODE_PID" 2>/dev/null; fi' USR1

# Write wrapper PID so other tools can send SIGUSR1
echo $$ > "${TMPDIR:-/tmp}/rn-dev-agent-cdp-bridge.pid"

MAX_RESTARTS=5
CRASH_WINDOW_SECS=60
STABLE_RUN_SECS=30

crash_count=0
window_start=$(date +%s)

while true; do
  run_start=$(date +%s)

  node "$NODE_SCRIPT" &
  NODE_PID=$!
  wait "$NODE_PID"
  exit_code=$?
  NODE_PID=0

  if [ "$exit_code" -eq 0 ]; then
    exit 0
  fi

  run_duration=$(( $(date +%s) - run_start ))

  # SIGUSR1 restarts don't count toward crash budget
  if [ "$exit_code" -eq 143 ] || [ "$exit_code" -eq 130 ]; then
    echo "CDP bridge: signal restart (exit $exit_code), reloading in 1s..." >&2
    sleep 1
    continue
  fi

  if [ "$run_duration" -ge "$STABLE_RUN_SECS" ]; then
    crash_count=0
    window_start=$(date +%s)
  fi

  elapsed=$(( $(date +%s) - window_start ))
  if [ "$elapsed" -gt "$CRASH_WINDOW_SECS" ]; then
    crash_count=0
    window_start=$(date +%s)
  fi

  crash_count=$((crash_count + 1))

  if [ "$crash_count" -gt "$MAX_RESTARTS" ]; then
    echo "CDP bridge: exceeded $MAX_RESTARTS restarts within ${CRASH_WINDOW_SECS}s — giving up" >&2
    rm -f "${TMPDIR:-/tmp}/rn-dev-agent-cdp-bridge.pid"
    exit 1
  fi

  echo "CDP bridge: exited with code $exit_code, restart $crash_count/$MAX_RESTARTS in 2s..." >&2
  sleep 2
done
