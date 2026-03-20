#!/bin/bash
# ensure-maestro-runner.sh — Check for maestro-runner and install if missing
#
# Called from SessionStart hook. Silent if already installed.
# Stdout is shown to the user. Diagnostics go to stderr.
#
# Exit codes:
#   0 — maestro-runner available (already installed or just installed)
#   1 — installation failed

set -euo pipefail

# Check if maestro-runner is already in PATH
if command -v maestro-runner &>/dev/null; then
  exit 0
fi

# Check common install location
if [ -x "$HOME/.maestro-runner/bin/maestro-runner" ]; then
  echo "maestro-runner found at ~/.maestro-runner/bin/ but not in PATH."
  echo "Add to PATH: export PATH=\"\$HOME/.maestro-runner/bin:\$PATH\""
  exit 0
fi

# Not installed — ask before installing
echo ""
echo "maestro-runner is not installed. It enables full E2E testing:"
echo "  - Tap buttons, type in inputs, swipe, scroll via testIDs"
echo "  - Assert UI visibility before CDP state checks"
echo "  - Generate CI-ready Maestro YAML test files"
echo ""
echo "Installing maestro-runner (~24MB)..."

if curl -fsSL https://open.devicelab.dev/install/maestro-runner | bash 2>&1; then
  echo ""
  echo "maestro-runner installed successfully."
  # Verify
  if [ -x "$HOME/.maestro-runner/bin/maestro-runner" ]; then
    VERSION=$("$HOME/.maestro-runner/bin/maestro-runner" --version 2>&1 | head -1 || echo "unknown")
    echo "Version: $VERSION"
    echo "Location: $HOME/.maestro-runner/bin/maestro-runner"
    if ! command -v maestro-runner &>/dev/null; then
      echo ""
      echo "NOTE: Add to your shell profile: export PATH=\"\$HOME/.maestro-runner/bin:\$PATH\""
    fi
  fi
  exit 0
else
  echo "maestro-runner installation failed. You can install manually:"
  echo "  curl -fsSL https://open.devicelab.dev/install/maestro-runner | bash"
  echo ""
  echo "Or use Maestro CLI as fallback: brew install maestro"
  exit 1
fi
