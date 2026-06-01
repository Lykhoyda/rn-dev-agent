#!/bin/bash
# detect-rn-project.sh — SessionStart hook
# Checks if the current directory is a React Native project and outputs a hint message.
# Exit codes: 0 = success (output shown to agent), 1 = error (logged, non-blocking),
#             2 = block operation (prevents the hooked action — not used here).

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

  # Detect plugin upgrade — warn user to restart Claude Code if MCP server keys may have changed (GH #30, D605)
  PLUGIN_VERSION=$(jq -r '.version // "unknown"' "$PLUGIN_ROOT/.claude-plugin/plugin.json" 2>/dev/null || echo "unknown")
  LAST_VERSION_FILE="${TMPDIR:-/tmp}/rn-dev-agent-last-version"
  if [ -f "$LAST_VERSION_FILE" ]; then
    LAST_VERSION=$(cat "$LAST_VERSION_FILE" 2>/dev/null || echo "")
    if [ -n "$LAST_VERSION" ] && [ "$LAST_VERSION" != "$PLUGIN_VERSION" ]; then
      echo "NOTICE: rn-dev-agent upgraded from v${LAST_VERSION} to v${PLUGIN_VERSION}. If MCP tools fail, restart Claude Code to reinitialize MCP servers."
      echo ""
    fi
  fi
  echo "$PLUGIN_VERSION" > "$LAST_VERSION_FILE" 2>/dev/null || true

  # Warn if Node.js is not an LTS version (even numbers: 22, 24, ...)
  NODE_MAJOR=$(node -e 'console.log(process.versions.node.split(".")[0])' 2>/dev/null)
  if [ -n "$NODE_MAJOR" ] && [ "$((NODE_MAJOR % 2))" -ne 0 ]; then
    echo "WARNING: Node.js v${NODE_MAJOR} is not an LTS release. rn-dev-agent requires Node >= 22 LTS. Some tools may not work."
  elif [ -n "$NODE_MAJOR" ] && [ "$NODE_MAJOR" -lt 22 ]; then
    echo "WARNING: Node.js v${NODE_MAJOR} is below the minimum (22 LTS). Some CDP bridge features may not work."
  fi

  # Track tool installation status for the banner
  INSTALL_WARNINGS=()

  # Ensure CDP bridge dependencies are installed (stderr visible for diagnostics)
  if ! bash "$PLUGIN_ROOT/scripts/ensure-cdp-deps.sh" 2>&1; then
    INSTALL_WARNINGS+=("WARNING: CDP bridge deps failed. Run: cd ${PLUGIN_ROOT}/scripts/cdp-bridge && npm install")
  fi

  # Ensure maestro-runner is installed (stderr visible for diagnostics)
  if ! bash "$PLUGIN_ROOT/scripts/ensure-maestro-runner.sh" 2>&1; then
    INSTALL_WARNINGS+=("WARNING: maestro-runner not installed. Run: npm install -g maestro-runner")
  fi

  # Ensure agent-device is installed — Android targets only (stderr visible for
  # diagnostics). Since D1219/PR #164 iOS device control is owned by the in-tree
  # rn-fast-runner, so agent-device is Android-only. Gate the global npm install
  # on a live Android device/emulator so iOS-only macOS users don't pay for a
  # dependency they never use. Android users without a booted emulator at
  # SessionStart can still install it via /rn-dev-agent:setup.
  if command -v adb &>/dev/null && adb devices 2>/dev/null | grep -q "device$"; then
    if ! bash "$PLUGIN_ROOT/scripts/ensure-agent-device.sh" 2>&1; then
      INSTALL_WARNINGS+=("WARNING: agent-device not installed. Run: npm install -g agent-device")
    fi
  fi

  # GH #59 #3: surface (and optionally auto-install) idb-companion when a
  # physical iOS device is connected. Default behavior: print a one-time
  # warning + brew command. Auto-install is opt-in via
  # RN_DEV_AGENT_AUTO_INSTALL_IDB=1 because brew install can compile from
  # source for several minutes — too long to block SessionStart by default.
  # The script handles its own user-facing output; only bubble up a banner
  # warning when an opt-in install actually failed.
  if ! bash "$PLUGIN_ROOT/scripts/ensure-idb-companion.sh" 2>&1; then
    INSTALL_WARNINGS+=("WARNING: opt-in idb-companion install failed. Run: brew install idb-companion (required for physical iOS device automation)")
  fi

  # Ensure ffmpeg for video-to-GIF conversion (optional — not critical)
  bash "$PLUGIN_ROOT/scripts/ensure-ffmpeg.sh" 2>/dev/null || true

  # Scaffold the repo-local troubleshooting memory (silent if already present)
  bash "$PLUGIN_ROOT/scripts/ensure-troubleshooting-doc.sh" "$PWD" 2>/dev/null || true

  # Check Android emulator readiness (if Android device detected)
  bash "$PLUGIN_ROOT/scripts/ensure-android-ready.sh" 2>/dev/null || true

  # Show any installation warnings BEFORE the banner so they're visible
  if [ ${#INSTALL_WARNINGS[@]} -gt 0 ]; then
    printf '%s\n' "${INSTALL_WARNINGS[@]}"
    echo ""
    echo "Run /rn-dev-agent:setup to install missing dependencies."
    echo ""
  fi

  cat <<'EOF'
React Native project detected. The rn-dev-agent plugin is active with 75 MCP tools.

## How to interact with the running app

ALWAYS use the CDP MCP tools instead of raw bash commands:
- `cdp_status` — check Metro, CDP connection, app health (call this FIRST)
- `cdp_component_tree` — read React component tree by testID
- `cdp_store_state` — read Redux/Zustand/React Query state
- `cdp_evaluate` — run JS in the Hermes runtime
- `cdp_navigate` — navigate to any screen by name
- `cdp_interact` — press buttons, long-press, type text, scroll by testID
- `cdp_error_log` — check for JS errors and unhandled rejections
- `cdp_network_log` / `cdp_network_body` — inspect API requests and response bodies
- `cdp_heap_usage` — check JS memory usage
- `device_screenshot` — capture screen image
- `device_find` / `device_press` / `device_fill` — native UI interaction
- `proof_step` — navigate + wait + verify + screenshot in one call
- `cross_platform_verify` — compare iOS vs Android element-by-element

Do NOT use `xcrun simctl` for app interaction or `curl localhost:8081` for Metro queries.
The CDP tools handle connection, reconnection, and error recovery automatically.

## Commands

  /rn-dev-agent:rn-feature-dev <description> - Full 8-phase feature development pipeline
  /rn-dev-agent:test-feature <description>   - Test a feature end-to-end on device
  /rn-dev-agent:debug-screen                 - Diagnose and fix the current screen
  /rn-dev-agent:check-env                    - Verify environment readiness
  /rn-dev-agent:send-feedback                - Report a bug or request a feature
  /rn-dev-agent:build-and-test <description> - Build app, then test feature

## IMPORTANT: Before live verification

Always run `cdp_status` first. If it fails to connect, run `/rn-dev-agent:check-env`
to diagnose missing dependencies (Metro, simulator, agent-device, etc.).
Do NOT proceed to Phase 5.5 verification without a successful `cdp_status`.
EOF
fi
