#!/bin/bash
# detect-rn-project.sh — SessionStart hook
# Checks if the current directory is a React Native project and outputs a hint message.
# Exit 0 with output = show message. Exit 0 with no output = silent skip.

# Check for react-native or expo in package.json dependencies (not just generic config files)
if [ ! -f "package.json" ]; then
  exit 0
fi

if ! grep -qE '"(react-native|expo)"' package.json 2>/dev/null; then
  exit 0
fi

# Confirm with at least one RN-specific config file
has_rn_config=false
if [ -f "metro.config.js" ] || [ -f "metro.config.ts" ] || \
   [ -f "app.json" ] || [ -f "app.config.js" ] || [ -f "app.config.ts" ]; then
  has_rn_config=true
fi

if [ "$has_rn_config" = true ]; then
  # Resolve plugin root (hooks/ is one level down from plugin root)
  PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

  # Warn if Node.js is not an LTS version (even numbers: 22, 24, ...)
  NODE_MAJOR=$(node -e 'console.log(process.versions.node.split(".")[0])' 2>/dev/null)
  if [ -n "$NODE_MAJOR" ] && [ "$((NODE_MAJOR % 2))" -ne 0 ]; then
    echo "Warning: Node.js v${NODE_MAJOR} is not an LTS release. rn-dev-agent requires Node >= 22 LTS."
  elif [ -n "$NODE_MAJOR" ] && [ "$NODE_MAJOR" -lt 22 ]; then
    echo "Warning: Node.js v${NODE_MAJOR} is below the minimum (22 LTS). Some CDP bridge features may not work."
  fi

  # Ensure CDP bridge dependencies are installed (silent if already present)
  bash "$PLUGIN_ROOT/scripts/ensure-cdp-deps.sh" 2>/dev/null || true

  # Ensure maestro-runner is installed (silent if already present)
  bash "$PLUGIN_ROOT/scripts/ensure-maestro-runner.sh" 2>/dev/null || true

  # Ensure agent-device is installed (silent if already present)
  bash "$PLUGIN_ROOT/scripts/ensure-agent-device.sh" 2>/dev/null || true

  # Ensure ffmpeg for video-to-GIF conversion (silent if already present)
  bash "$PLUGIN_ROOT/scripts/ensure-ffmpeg.sh" 2>/dev/null || true

  # Initialize Experience Engine directory structure (silent if already present)
  bash "$PLUGIN_ROOT/scripts/ensure-experience-engine.sh" 2>/dev/null || true

  # Check Android emulator readiness (if Android device detected)
  bash "$PLUGIN_ROOT/scripts/ensure-android-ready.sh" 2>/dev/null || true

  cat <<'EOF'
React Native project detected. The rn-dev-agent plugin is active with 23 MCP tools.

## How to interact with the running app

ALWAYS use the CDP MCP tools instead of raw bash commands:
- `cdp_status` — check Metro, CDP connection, app health (call this FIRST)
- `cdp_component_tree` — read React component tree by testID
- `cdp_store_state` — read Redux/Zustand/React Query state
- `cdp_evaluate` — run JS in the Hermes runtime
- `cdp_navigate` — navigate to any screen by name
- `cdp_interact` — press buttons, long-press, type text, scroll by testID
- `cdp_error_log` — check for JS errors and unhandled rejections
- `device_screenshot` — capture screen image
- `device_find` / `device_press` / `device_fill` — native UI interaction
- `proof_step` — navigate + wait + verify + screenshot in one call

Do NOT use `xcrun simctl` for app interaction or `curl localhost:8081` for Metro queries.
The CDP tools handle connection, reconnection, and error recovery automatically.

## Commands

  /rn-dev-agent:rn-feature-dev <description> - Full 8-phase feature development pipeline
  /rn-dev-agent:test-feature <description>   - Test a feature end-to-end on device
  /rn-dev-agent:debug-screen                 - Diagnose and fix the current screen
  /rn-dev-agent:check-env                    - Verify environment readiness
  /rn-dev-agent:send-feedback                - Report a bug or request a feature
  /rn-dev-agent:build-and-test <description> - Build app, then test feature

Start with `cdp_status` to connect, then use the tools above.
EOF
fi
