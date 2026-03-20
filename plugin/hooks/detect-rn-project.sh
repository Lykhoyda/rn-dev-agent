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

  # Ensure maestro-runner is installed (silent if already present)
  bash "$PLUGIN_ROOT/scripts/ensure-maestro-runner.sh" 2>/dev/null || true

  # Ensure agent-device is installed (silent if already present)
  bash "$PLUGIN_ROOT/scripts/ensure-agent-device.sh" 2>/dev/null || true

  cat <<'EOF'
React Native project detected. The rn-dev-agent plugin is active.

Available commands:
  /rn-dev-agent:test-feature <description>  - Test a feature end-to-end
  /rn-dev-agent:build-and-test <description> - Build app, then test feature
  /rn-dev-agent:debug-screen                - Diagnose and fix the current screen
  /rn-dev-agent:check-env                   - Verify environment is ready
  /rn-dev-agent:rn-feature-dev <description> - Guided feature development (explore, design, implement, verify)

Use build-and-test if the app isn't installed yet. Metro starts automatically.
EOF
fi
