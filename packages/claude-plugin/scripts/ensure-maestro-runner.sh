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

# GH #397: install exactly the TESTED engine version. Kept in sync with
# packages/rn-dev-agent-core/src/domain/engine-pin.ts by gh-397-pin-sync.test.ts.
MAESTRO_RUNNER_PIN_VERSION="1.0.9"
MAESTRO_RUNNER_PIN_SHA256_DARWIN_ARM64="7d3777a67f8cc3d5e3927f498ddda8a56c424a10158f7cd4fa494ecc3ed97923"

BIN="$HOME/.maestro-runner/bin/maestro-runner"

installed_version() {
  # perl alarm bounds the probe (macOS has no `timeout`; alarm survives exec) —
  # a hung binary must not stall SessionStart
  perl -e 'alarm 5; exec @ARGV' -- "$1" --version 2>&1 | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' || echo ""
}

drift_note() {
  echo "NOTE: maestro-runner $1 is installed but the plugin was tested against $MAESTRO_RUNNER_PIN_VERSION."
  echo "Untested drift can change replay behavior silently (B223-class)."
  echo "To install the pinned version: curl -fsSL https://open.devicelab.dev/install/maestro-runner | bash -s -- --version $MAESTRO_RUNNER_PIN_VERSION"
}

# Check if maestro-runner is already in PATH
if command -v maestro-runner &>/dev/null; then
  V=$(installed_version "$(command -v maestro-runner)")
  if [ -n "$V" ] && [ "$V" != "$MAESTRO_RUNNER_PIN_VERSION" ]; then
    drift_note "$V"
  fi
  exit 0
fi

# Check common install location
if [ -x "$BIN" ]; then
  echo "maestro-runner found at ~/.maestro-runner/bin/ but not in PATH."
  echo "Add to PATH: export PATH=\"\$HOME/.maestro-runner/bin:\$PATH\""
  V=$(installed_version "$BIN")
  if [ -n "$V" ] && [ "$V" != "$MAESTRO_RUNNER_PIN_VERSION" ]; then
    drift_note "$V"
  fi
  exit 0
fi

# Not installed — install the pinned version
echo ""
echo "maestro-runner is not installed. It enables full E2E testing:"
echo "  - Tap buttons, type in inputs, swipe, scroll via testIDs"
echo "  - Assert UI visibility before CDP state checks"
echo "  - Generate CI-ready Maestro YAML test files"
echo ""
echo "Installing maestro-runner $MAESTRO_RUNNER_PIN_VERSION (pinned, ~24MB)..."

if curl -fsSL --connect-timeout 10 --max-time 90 https://open.devicelab.dev/install/maestro-runner | bash -s -- --version "$MAESTRO_RUNNER_PIN_VERSION" 2>&1; then
  echo ""
  echo "maestro-runner installed successfully."
  if [ -x "$BIN" ]; then
    VERSION=$(installed_version "$BIN")
    echo "Version: ${VERSION:-unknown}"
    echo "Location: $BIN"
    # Checksum verification (darwin-arm64 only; other platforms report
    # 'unverified' TS-side). FAIL CLOSED on a fresh download: a just-installed
    # binary that doesn't match the pin is exactly what the hash exists to
    # catch, and failing an install is actionable. (Runtime detection of a
    # pre-existing binary stays warn-only.)
    if [ "$(uname -s)-$(uname -m)" = "Darwin-arm64" ] && command -v shasum &>/dev/null; then
      GOT=$(shasum -a 256 "$BIN" | cut -d' ' -f1)
      if [ "$GOT" != "$MAESTRO_RUNNER_PIN_SHA256_DARWIN_ARM64" ]; then
        echo "ERROR: just-installed binary checksum does not match the pin manifest."
        echo "  expected: $MAESTRO_RUNNER_PIN_SHA256_DARWIN_ARM64"
        echo "  got:      $GOT"
        echo "Removing the binary. Possible upstream re-release under the pinned version;"
        echo "verify upstream, then update the pin (engine-pin.ts + this script) if legitimate."
        rm -f "$BIN"
        exit 1
      fi
    fi
    if ! command -v maestro-runner &>/dev/null; then
      echo ""
      echo "NOTE: Add to your shell profile: export PATH=\"\$HOME/.maestro-runner/bin:\$PATH\""
    fi
  fi
  exit 0
else
  echo "maestro-runner installation failed. You can install manually:"
  echo "  curl -fsSL https://open.devicelab.dev/install/maestro-runner | bash -s -- --version $MAESTRO_RUNNER_PIN_VERSION"
  echo ""
  echo "Or use Maestro CLI as fallback: brew install maestro"
  exit 1
fi
