#!/usr/bin/env bash
# ensure-cdp-deps.sh — Install CDP bridge node_modules if missing.
# Uses ${CLAUDE_PLUGIN_DATA} for persistent storage when available (D552).
# Persistent deps survive plugin updates — only re-installed when version changes.
# Exit codes: 0 = success, 1 = error (non-fatal, hook continues).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CDP_DIR="$SCRIPT_DIR/cdp-bridge"
CURRENT_VERSION=$(node -e "console.log(require('$CDP_DIR/package.json').version)" 2>/dev/null || echo "unknown")

install_persistent() {
  local PERSISTENT_DIR="$CLAUDE_PLUGIN_DATA/cdp-node_modules"
  local STAMP_FILE="$PERSISTENT_DIR/.version-stamp"

  local needs_install=false
  if [ ! -d "$PERSISTENT_DIR/node_modules" ]; then
    needs_install=true
  elif [ ! -f "$STAMP_FILE" ] || [ "$(cat "$STAMP_FILE" 2>/dev/null)" != "$CURRENT_VERSION" ]; then
    needs_install=true
  fi

  if [ "$needs_install" = true ]; then
    mkdir -p "$PERSISTENT_DIR"
    cp "$CDP_DIR/package.json" "$PERSISTENT_DIR/package.json"
    [ -f "$CDP_DIR/package-lock.json" ] && cp "$CDP_DIR/package-lock.json" "$PERSISTENT_DIR/package-lock.json"
    (cd "$PERSISTENT_DIR" && npm install --production --ignore-scripts --silent 2>/dev/null) || return 1
    echo "$CURRENT_VERSION" > "$STAMP_FILE"
  fi

  if [ -d "$PERSISTENT_DIR/node_modules" ]; then
    # Replace local node_modules with symlink to persistent location
    if [ -L "$CDP_DIR/node_modules" ]; then
      # Already a symlink — update target if needed
      local current_target
      current_target=$(readlink "$CDP_DIR/node_modules" 2>/dev/null || echo "")
      if [ "$current_target" != "$PERSISTENT_DIR/node_modules" ]; then
        ln -sfn "$PERSISTENT_DIR/node_modules" "$CDP_DIR/node_modules"
      fi
    elif [ -d "$CDP_DIR/node_modules" ]; then
      # Real directory exists — replace with symlink
      rm -rf "$CDP_DIR/node_modules"
      ln -sfn "$PERSISTENT_DIR/node_modules" "$CDP_DIR/node_modules"
    else
      # No node_modules at all — create symlink
      ln -sfn "$PERSISTENT_DIR/node_modules" "$CDP_DIR/node_modules"
    fi
    return 0
  fi

  return 1
}

# Prefer persistent storage when CLAUDE_PLUGIN_DATA is available and version is known
# Skip persistent path if version is "unknown" (node unavailable) to avoid stamp flip-flop
if [ -n "${CLAUDE_PLUGIN_DATA:-}" ] && [ "$CURRENT_VERSION" != "unknown" ]; then
  if install_persistent; then
    exit 0
  fi
fi

# Clean up dangling symlink from a previous persistent install
if [ -L "$CDP_DIR/node_modules" ] && [ ! -d "$CDP_DIR/node_modules" ]; then
  rm -f "$CDP_DIR/node_modules"
fi

# Fallback: install locally (no CLAUDE_PLUGIN_DATA or persistent install failed)
if [ ! -d "$CDP_DIR/node_modules" ]; then
  cd "$CDP_DIR" && npm install --production --ignore-scripts --silent 2>/dev/null
fi
