#!/bin/bash
# cwd-changed.sh — CwdChanged hook (D554)
# Re-detects RN project when the user changes working directory.
# Exit codes: 0 = success (output shown to agent), 1 = error (logged, non-blocking),
#             2 = block operation (not used here).

# Check for react-native or expo in package.json dependencies
if [ ! -f "package.json" ]; then
  exit 0
fi

if ! grep -qE '"(react-native|expo)"' package.json 2>/dev/null; then
  echo "Working directory changed. No React Native project detected — CDP tools may not work here."
  exit 0
fi

# Confirm with at least one RN-specific config file
has_rn_config=false
if [ -f "metro.config.js" ] || [ -f "metro.config.ts" ] || \
   [ -f "app.json" ] || [ -f "app.config.js" ] || [ -f "app.config.ts" ]; then
  has_rn_config=true
fi

if [ "$has_rn_config" = true ]; then
  echo "Working directory changed. React Native project detected — CDP tools are available. Run cdp_status to check connection."
fi
