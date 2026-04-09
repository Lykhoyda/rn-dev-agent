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
  cd "$SCRIPT_DIR" && npm install --production --ignore-scripts --silent 2>/dev/null
fi

# exec replaces the bash process with node — stdin/stdout pass through
# directly to the MCP JSON-RPC transport. The previous background-job
# pattern (`node ... &; wait`) broke non-interactive bash because
# background processes get stdin redirected from /dev/null.
# Claude Code manages MCP server lifecycle (restart on crash), so
# a wrapper restart loop is unnecessary.
exec node "$NODE_SCRIPT"
