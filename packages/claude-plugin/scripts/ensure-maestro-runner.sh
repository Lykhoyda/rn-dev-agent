#!/bin/bash
# ensure-maestro-runner.sh — Install or converge the session pin-cache to
# exactly the tested maestro-runner. Never uses PATH, ~/.maestro-runner, or
# the Maestro CLI. SessionStart and /rn-dev-agent:setup invoke this.
#
# Exit codes:
#   0 — pin-cache binary is exactly the tested pin (already or just installed)
#   1 — missing, drifted, checksum mismatch, or unsupported platform
set -euo pipefail

# GH #397: install exactly the TESTED engine version. Kept in sync with
# packages/rn-dev-agent-core/src/domain/engine-pin.ts by gh-397-pin-sync.test.ts.
MAESTRO_RUNNER_PIN_VERSION="1.1.24"
MAESTRO_RUNNER_PIN_SHA256_DARWIN_ARM64="170f12521de83322823dd5fc0ce16e48abeba9952cdbb242670592566c2fd1f3"
MAESTRO_RUNNER_PIN_SHA256_DARWIN_X64="af7f5ea044afc72ea780c835f05b32203e443d2e26d310a864bfb2bc84959bf6"
MAESTRO_RUNNER_PIN_SHA256_LINUX_X64="e9bdef6f08f855ca1a884f99b54a519a1eae0a342917181a53eb414a5b00d6d8"
MAESTRO_RUNNER_PIN_SHA256_LINUX_ARM64="8d8a6483ad04da2109636b7192398750657801b8a8d512688d1be3b033a105b8"

CACHE_PARENT="${RN_DEV_AGENT_RUNNER_CACHE:-$HOME/.cache/rn-dev-agent}"
PIN_DIR="$CACHE_PARENT/maestro-runner/$MAESTRO_RUNNER_PIN_VERSION"
BIN="$PIN_DIR/bin/maestro-runner"
DOWNLOAD_BASE="https://open.devicelab.dev/download/maestro-runner"

OS_NAME="${RN_DEV_AGENT_UNAME_S:-$(uname -s)}"
ARCH_NAME="${RN_DEV_AGENT_UNAME_M:-$(uname -m)}"

platform_key() {
  case "$OS_NAME" in
    Darwin|darwin) echo "darwin" ;;
    Linux|linux) echo "linux" ;;
    *) echo "unsupported" ;;
  esac
}

archive_arch() {
  case "$ARCH_NAME" in
    x86_64|amd64) echo "amd64" ;;
    aarch64|arm64) echo "arm64" ;;
    *) echo "unsupported" ;;
  esac
}

node_platform_key() {
  local os arch
  os="$(platform_key)"
  arch="$(archive_arch)"
  if [ "$os" = "unsupported" ] || [ "$arch" = "unsupported" ]; then
    echo "unsupported"
    return
  fi
  if [ "$arch" = "amd64" ]; then
    echo "${os}-x64"
  else
    echo "${os}-arm64"
  fi
}

expected_sha() {
  case "$(node_platform_key)" in
    darwin-arm64) echo "$MAESTRO_RUNNER_PIN_SHA256_DARWIN_ARM64" ;;
    darwin-x64) echo "$MAESTRO_RUNNER_PIN_SHA256_DARWIN_X64" ;;
    linux-x64) echo "$MAESTRO_RUNNER_PIN_SHA256_LINUX_X64" ;;
    linux-arm64) echo "$MAESTRO_RUNNER_PIN_SHA256_LINUX_ARM64" ;;
    *) echo "" ;;
  esac
}

file_sha() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    echo ""
  fi
}

installed_version() {
  perl -e 'alarm 5; exec @ARGV' -- "$1" --version 2>&1 | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' || echo ""
}

correction() {
  echo "Install exactly $MAESTRO_RUNNER_PIN_VERSION with: bash \"${BASH_SOURCE[0]}\""
  echo "Session runner is the pin-cache at $BIN — never PATH, ~/.maestro-runner, or brew maestro."
}

unsupported_fail() {
  echo "ERROR: maestro-runner $MAESTRO_RUNNER_PIN_VERSION is unsupported on ${OS_NAME}/${ARCH_NAME}."
  echo "Supported platforms: macOS/Linux arm64 and x64 (darwin-arm64, darwin-x64, linux-x64, linux-arm64)."
  correction
  exit 1
}

if [ "$(platform_key)" = "unsupported" ] || [ "$(archive_arch)" = "unsupported" ]; then
  unsupported_fail
fi

OS="$(platform_key)"
ARCH="$(archive_arch)"
EXPECTED_SHA="$(expected_sha)"
if [ -z "$EXPECTED_SHA" ]; then
  unsupported_fail
fi

bin_matches_pin() {
  if [ ! -x "$BIN" ]; then
    return 1
  fi
  local v got
  got="$(file_sha "$BIN")"
  if [ -z "$got" ] || [ "$got" != "$EXPECTED_SHA" ]; then
    return 1
  fi
  v="$(installed_version "$BIN")"
  if [ "$v" != "$MAESTRO_RUNNER_PIN_VERSION" ]; then
    return 1
  fi
  return 0
}

report_success() {
  local v
  v="$(installed_version "$BIN")"
  echo "maestro-runner pin ok: ${v} (session pin-cache)"
  echo "selectedPath: $BIN"
  echo "provenance: pin-cache"
  echo "pinned: $MAESTRO_RUNNER_PIN_VERSION"
}

if bin_matches_pin; then
  report_success
  exit 0
fi

if [ -x "$BIN" ]; then
  GOT_V="$(installed_version "$BIN")"
  GOT_SHA="$(file_sha "$BIN")"
  echo "NOTE: pin-cache maestro-runner is not exactly $MAESTRO_RUNNER_PIN_VERSION (got version=${GOT_V:-unknown} sha=${GOT_SHA:-unhashed}). Converging."
fi

ARCHIVE="maestro-runner-${MAESTRO_RUNNER_PIN_VERSION}-${OS}-${ARCH}.tar.gz"
DOWNLOAD_URL="${RN_DEV_AGENT_MAESTRO_DOWNLOAD_URL:-${DOWNLOAD_BASE}/${MAESTRO_RUNNER_PIN_VERSION}/${ARCHIVE}}"

echo "Installing maestro-runner $MAESTRO_RUNNER_PIN_VERSION into the session pin-cache..."
echo "Destination: $PIN_DIR"

TEMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$TEMP_DIR"
}
trap cleanup EXIT INT TERM

if ! curl -fsSL --connect-timeout 10 --max-time 180 -o "$TEMP_DIR/$ARCHIVE" "$DOWNLOAD_URL"; then
  echo "ERROR: failed to download $DOWNLOAD_URL"
  correction
  exit 1
fi

if [ ! -s "$TEMP_DIR/$ARCHIVE" ]; then
  echo "ERROR: downloaded archive is empty"
  correction
  exit 1
fi

mkdir -p "$TEMP_DIR/extract"
if ! tar -xzf "$TEMP_DIR/$ARCHIVE" -C "$TEMP_DIR/extract"; then
  echo "ERROR: failed to extract maestro-runner archive"
  correction
  exit 1
fi

SRC=""
if [ -x "$TEMP_DIR/extract/maestro-runner/bin/maestro-runner" ]; then
  SRC="$TEMP_DIR/extract/maestro-runner"
elif [ -x "$TEMP_DIR/extract/bin/maestro-runner" ]; then
  SRC="$TEMP_DIR/extract"
else
  echo "ERROR: archive did not contain bin/maestro-runner"
  correction
  exit 1
fi

mkdir -p "$PIN_DIR"
rm -rf "$PIN_DIR/bin" "$PIN_DIR/drivers"
cp -R "$SRC/." "$PIN_DIR/"
chmod +x "$BIN"
if [ "$(platform_key)" = "darwin" ]; then
  xattr -d com.apple.quarantine "$BIN" 2>/dev/null || true
fi

if ! bin_matches_pin; then
  GOT_V="$(installed_version "$BIN")"
  GOT_SHA="$(file_sha "$BIN")"
  echo "ERROR: just-installed binary is not exactly $MAESTRO_RUNNER_PIN_VERSION."
  echo "  expected version: $MAESTRO_RUNNER_PIN_VERSION"
  echo "  got version:      ${GOT_V:-unknown}"
  echo "  expected sha256:  $EXPECTED_SHA"
  echo "  got sha256:       ${GOT_SHA:-unhashed}"
  rm -f "$BIN"
  correction
  exit 1
fi

report_success
exit 0
