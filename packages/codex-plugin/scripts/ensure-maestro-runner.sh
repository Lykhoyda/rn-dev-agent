#!/bin/bash
# ensure-maestro-runner.sh — Install or converge the session pin-cache to
# exactly the tested maestro-runner. Never uses PATH, ~/.maestro-runner, or
# the Maestro CLI. SessionStart and /rn-dev-agent:setup invoke this.
#
# Exit codes:
#   0 — pin-cache binary is exactly the tested pin (already or just installed)
#   1 — missing, drifted, checksum mismatch, or unsupported platform
set -euo pipefail

INSTALL_STARTED_SECONDS=$SECONDS
INSTALL_BUDGET_SECONDS=110
if [[ "${RN_DEV_AGENT_TEST_INSTALL_BUDGET_SECONDS:-}" =~ ^[0-9]+$ ]] && [ "$RN_DEV_AGENT_TEST_INSTALL_BUDGET_SECONDS" -ge 12 ] && [ "$RN_DEV_AGENT_TEST_INSTALL_BUDGET_SECONDS" -le "$INSTALL_BUDGET_SECONDS" ]; then
  INSTALL_BUDGET_SECONDS="$RN_DEV_AGENT_TEST_INSTALL_BUDGET_SECONDS"
fi
DOWNLOAD_RESERVE_SECONDS=10
LOCK_MAX_AGE_SECONDS=115

remaining_install_seconds() {
  local elapsed=$((SECONDS - INSTALL_STARTED_SECONDS))
  local remaining=$((INSTALL_BUDGET_SECONDS - elapsed))
  if [ "$remaining" -lt 0 ]; then
    remaining=0
  fi
  echo "$remaining"
}

require_install_time() {
  if [ "$(remaining_install_seconds)" -le 0 ]; then
    echo "ERROR: maestro-runner install deadline expired during $1."
    correction
    exit 1
  fi
}

deadline_run() {
  local remaining
  remaining="$(remaining_install_seconds)"
  if [ "$remaining" -le 0 ]; then
    return 124
  fi
  node -e 'const {spawnSync}=require("node:child_process"); const timeout=Number(process.argv[1])*1000; const result=spawnSync(process.argv[2],process.argv.slice(3),{stdio:"inherit",timeout}); if(result.error?.code==="ETIMEDOUT") process.exit(124); process.exit(result.status ?? 1)' "$remaining" "$@"
}

deadline_capture() {
  local remaining
  remaining="$(remaining_install_seconds)"
  if [ "$remaining" -le 0 ]; then
    return 124
  fi
  node -e 'const {spawnSync}=require("node:child_process"); const timeout=Number(process.argv[1])*1000; const result=spawnSync(process.argv[2],process.argv.slice(3),{encoding:"utf8",timeout}); if(result.error?.code==="ETIMEDOUT") process.exit(124); process.stdout.write(result.stdout ?? ""); process.stderr.write(result.stderr ?? ""); process.exit(result.status ?? 1)' "$remaining" "$@"
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CANONICAL_PIN_MANIFEST="$SCRIPT_DIR/maestro-runner-pin.json"
if [ ! -f "$CANONICAL_PIN_MANIFEST" ]; then
  CANONICAL_PIN_MANIFEST="$SCRIPT_DIR/../packages/rn-dev-agent-core/src/domain/maestro-runner-pin.json"
fi
if [ ! -f "$CANONICAL_PIN_MANIFEST" ]; then
  echo "ERROR: maestro-runner pin manifest is missing."
  exit 1
fi

manifest_value() {
  node -e 'const m=require(process.argv[1]); const v=process.argv[2].split(".").reduce((o,k)=>o?.[k],m); if(typeof v!=="string") process.exit(1); process.stdout.write(v)' "$1" "$2"
}

MAESTRO_RUNNER_PIN_VERSION="$(manifest_value "$CANONICAL_PIN_MANIFEST" version)"

if [ "${1:-}" = "--print-pin-json" ]; then
  node -e 'const m=require(process.argv[1]); process.stdout.write(JSON.stringify(m))' "$CANONICAL_PIN_MANIFEST"
  exit 0
fi

MAESTRO_RUNNER_PIN_SHA256_DARWIN_ARM64="$(manifest_value "$CANONICAL_PIN_MANIFEST" sha256.darwin-arm64)"
MAESTRO_RUNNER_PIN_SHA256_DARWIN_X64="$(manifest_value "$CANONICAL_PIN_MANIFEST" sha256.darwin-x64)"
MAESTRO_RUNNER_PIN_SHA256_LINUX_X64="$(manifest_value "$CANONICAL_PIN_MANIFEST" sha256.linux-x64)"
MAESTRO_RUNNER_PIN_SHA256_LINUX_ARM64="$(manifest_value "$CANONICAL_PIN_MANIFEST" sha256.linux-arm64)"
MAESTRO_RUNNER_ARCHIVE_SHA256_DARWIN_ARM64="$(manifest_value "$CANONICAL_PIN_MANIFEST" archiveSha256.darwin-arm64)"
MAESTRO_RUNNER_ARCHIVE_SHA256_DARWIN_X64="$(manifest_value "$CANONICAL_PIN_MANIFEST" archiveSha256.darwin-x64)"
MAESTRO_RUNNER_ARCHIVE_SHA256_LINUX_X64="$(manifest_value "$CANONICAL_PIN_MANIFEST" archiveSha256.linux-x64)"
MAESTRO_RUNNER_ARCHIVE_SHA256_LINUX_ARM64="$(manifest_value "$CANONICAL_PIN_MANIFEST" archiveSha256.linux-arm64)"

CACHE_PARENT="${RN_DEV_AGENT_RUNNER_CACHE:-$HOME/.cache/rn-dev-agent}"
RUNNER_CACHE_ROOT="$CACHE_PARENT/maestro-runner"
PIN_DIR="$RUNNER_CACHE_ROOT/$MAESTRO_RUNNER_PIN_VERSION"
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

expected_archive_sha() {
  case "$(node_platform_key)" in
    darwin-arm64) echo "$MAESTRO_RUNNER_ARCHIVE_SHA256_DARWIN_ARM64" ;;
    darwin-x64) echo "$MAESTRO_RUNNER_ARCHIVE_SHA256_DARWIN_X64" ;;
    linux-x64) echo "$MAESTRO_RUNNER_ARCHIVE_SHA256_LINUX_X64" ;;
    linux-arm64) echo "$MAESTRO_RUNNER_ARCHIVE_SHA256_LINUX_ARM64" ;;
    *) echo "" ;;
  esac
}

file_sha() {
  if command -v shasum >/dev/null 2>&1; then
    deadline_capture shasum -a 256 "$1" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    deadline_capture sha256sum "$1" | awk '{print $1}'
  else
    echo ""
  fi
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
EXPECTED_ARCHIVE_SHA="$(expected_archive_sha)"
if [ -z "$EXPECTED_SHA" ] || [ -z "$EXPECTED_ARCHIVE_SHA" ]; then
  unsupported_fail
fi

for guarded_path in "$RUNNER_CACHE_ROOT" "$PIN_DIR" "$PIN_DIR/bin" "$BIN"; do
  if [ -L "$guarded_path" ]; then
    echo "ERROR: refusing maestro-runner pin-cache symlink at $guarded_path."
    correction
    exit 1
  fi
done

bin_path_matches_pin() {
  local path="$1"
  if [ ! -x "$path" ]; then
    return 1
  fi
  local got
  got="$(file_sha "$path")"
  if [ -z "$got" ] || [ "$got" != "$EXPECTED_SHA" ]; then
    return 1
  fi
  return 0
}

bin_matches_pin() {
  pin_dir_matches_pin "$PIN_DIR"
}

payload_matches_pin_at() {
  local dir="$1"
  local archive="$dir/.payload.tar.gz"
  local archive_sha verify_dir expected_dir
  if [ ! -f "$archive" ] || [ -L "$archive" ]; then
    return 1
  fi
  archive_sha="$(file_sha "$archive")"
  if [ -z "$archive_sha" ] || [ "$archive_sha" != "$EXPECTED_ARCHIVE_SHA" ]; then
    return 1
  fi
  verify_dir="$(mktemp -d "$RUNNER_CACHE_ROOT/.verify-payload.XXXXXX")"
  if ! deadline_run tar -xzf "$archive" -C "$verify_dir"; then
    rm -rf "$verify_dir"
    return 1
  fi
  if [ -f "$verify_dir/maestro-runner/bin/maestro-runner" ]; then
    expected_dir="$verify_dir/maestro-runner"
  elif [ -f "$verify_dir/bin/maestro-runner" ]; then
    expected_dir="$verify_dir"
  else
    rm -rf "$verify_dir"
    return 1
  fi
  if ! deadline_run diff -qr -x .payload.tar.gz "$expected_dir" "$dir" >/dev/null; then
    rm -rf "$verify_dir"
    return 1
  fi
  rm -rf "$verify_dir"
}

pin_dir_matches_pin() {
  local dir="$1"
  payload_matches_pin_at "$dir" && bin_path_matches_pin "$dir/bin/maestro-runner"
}

report_success() {
  echo "maestro-runner pin ok: ${MAESTRO_RUNNER_PIN_VERSION} (session pin-cache)"
  echo "selectedPath: $BIN"
  echo "provenance: pin-cache"
  echo "pinned: $MAESTRO_RUNNER_PIN_VERSION"
}

if bin_matches_pin; then
  if [ "${1:-}" = "--print-bin" ]; then
    printf '%s\n' "$BIN"
    exit 0
  fi
  report_success
  exit 0
fi

if [ "${1:-}" = "--print-bin" ]; then
  echo "ERROR: pin-cache maestro-runner is not exactly $MAESTRO_RUNNER_PIN_VERSION (missing, version drift, or checksum mismatch)." >&2
  correction >&2
  exit 1
fi

LOCK_FILE="$RUNNER_CACHE_ROOT/.install-${MAESTRO_RUNNER_PIN_VERSION}.lock"
RECLAIM_DIR="$RUNNER_CACHE_ROOT/.install-${MAESTRO_RUNNER_PIN_VERSION}.reclaim"
LOCK_HELD=0
LOCK_OWNER_FILE=""
LOCK_OWNER_BIRTH=""
TEMP_DIR=""

cleanup() {
  if [ -n "$TEMP_DIR" ]; then
    rm -rf "$TEMP_DIR"
  fi
  if [ -n "$LOCK_OWNER_FILE" ]; then
    rm -f "$LOCK_OWNER_FILE"
  fi
  if [ "$LOCK_HELD" = "1" ] && [ -f "$LOCK_FILE" ] && [ ! -L "$LOCK_FILE" ]; then
    local owner owner_birth
    owner="$(sed -n '1p' "$LOCK_FILE" 2>/dev/null || true)"
    owner_birth="$(sed -n '2p' "$LOCK_FILE" 2>/dev/null || true)"
    if [ "$owner" = "$$" ] && [ "$owner_birth" = "$LOCK_OWNER_BIRTH" ]; then
      rm -f "$LOCK_FILE"
    fi
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

lock_age_seconds() {
  node -e 'const fs=require("node:fs"); try { const age=Math.max(0, Math.floor((Date.now()-fs.statSync(process.argv[1]).mtimeMs)/1000)); process.stdout.write(String(age)); } catch { process.stdout.write("0"); }' "$1"
}

process_birth_identity() {
  node - "$1" "$SCRIPT_DIR" <<'NODE'
const { createHash } = require('node:crypto');
const { lstatSync, readFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const { resolve } = require('node:path');
const pid = process.argv[2];
const scriptDir = process.argv[3];
if (!/^\d+$/.test(pid)) process.exit(1);
if (process.platform === 'linux') {
  try {
    const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    if (/^[0-9a-f-]+$/i.test(boot) && fields[19]) {
      process.stdout.write(`linux:${boot.toLowerCase()}:${fields[19]}`);
      process.exit(0);
    }
  } catch {}
}
if (process.platform === 'darwin') {
  const candidates = [
    resolve(scriptDir, '..', 'rn-dev-agent-core', 'dist', 'native', 'darwin-process-birth'),
    resolve(scriptDir, '..', 'packages', 'rn-dev-agent-core', 'native', 'darwin-process-birth'),
  ];
  for (const helper of candidates) {
    const manifestPath = `${helper}.json`;
    try {
      const helperStat = lstatSync(helper);
      const manifestStat = lstatSync(manifestPath);
      if (!helperStat.isFile() || helperStat.isSymbolicLink() || !manifestStat.isFile() || manifestStat.isSymbolicLink()) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      const digest = createHash('sha256').update(readFileSync(helper)).digest('hex');
      if (digest !== manifest.binarySha256) continue;
      const result = spawnSync(helper, [pid], { encoding: 'utf8', timeout: 2000 });
      const identity = result.status === 0 ? result.stdout.trim() : '';
      if (!new RegExp(`^${pid}:[0-9]+:[0-9]+$`).test(identity)) continue;
      process.stdout.write(`darwin:${identity}`);
      process.exit(0);
    } catch {}
  }
}
process.exit(1);
NODE
}

atomic_publish_directories() {
  local mode="$1"
  local left="$2"
  local right="$3"
  local remaining
  remaining="$(remaining_install_seconds)"
  if [ "$remaining" -le 0 ]; then
    return 124
  fi
  node - "$SCRIPT_DIR" "$mode" "$left" "$right" "$TEMP_DIR" "$remaining" <<'NODE'
const { createHash } = require('node:crypto');
const {
  chmodSync,
  constants,
  copyFileSync,
  lstatSync,
  readFileSync,
  unlinkSync,
} = require('node:fs');
const { spawnSync } = require('node:child_process');
const { resolve } = require('node:path');

const scriptDir = process.argv[2];
const mode = process.argv[3];
const left = process.argv[4];
const right = process.argv[5];
const temporaryDirectory = process.argv[6];
const timeout = Number(process.argv[7]) * 1000;
const architecture = process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : null;
const helperName =
  process.platform === 'darwin'
    ? 'darwin-process-birth'
    : process.platform === 'linux' && architecture
      ? `linux-conditional-publication-${architecture}`
      : null;
if (!helperName || !['--exchange', '--rename-no-replace'].includes(mode) || !Number.isFinite(timeout) || timeout <= 0) process.exit(1);
const candidates = [
  resolve(scriptDir, '..', 'rn-dev-agent-core', 'dist', 'native', helperName),
  resolve(scriptDir, '..', 'packages', 'rn-dev-agent-core', 'native', helperName),
];
let helper = null;
let digest = null;
for (const candidate of candidates) {
  try {
    const helperStat = lstatSync(candidate);
    const manifestPath = `${candidate}.json`;
    const manifestStat = lstatSync(manifestPath);
    if (
      !helperStat.isFile() ||
      helperStat.isSymbolicLink() ||
      !manifestStat.isFile() ||
      manifestStat.isSymbolicLink() ||
      (helperStat.mode & 0o022) !== 0 ||
      (manifestStat.mode & 0o022) !== 0
    ) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const observed = createHash('sha256').update(readFileSync(candidate)).digest('hex');
    if (observed !== manifest.binarySha256) continue;
    helper = candidate;
    digest = observed;
    break;
  } catch {}
}
if (!helper || !digest) process.exit(1);
const leftBefore = lstatSync(left);
let rightBefore = null;
try { rightBefore = lstatSync(right); } catch (error) {
  if (error.code !== 'ENOENT') process.exit(1);
}
if (!leftBefore.isDirectory() || leftBefore.isSymbolicLink()) process.exit(1);
if (mode === '--exchange' && (!rightBefore?.isDirectory() || rightBefore.isSymbolicLink() || leftBefore.dev !== rightBefore.dev)) process.exit(1);
if (mode === '--rename-no-replace' && rightBefore !== null) process.exit(10);
const bound = resolve(
  temporaryDirectory,
  `.exchange-helper.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`,
);
copyFileSync(helper, bound, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
chmodSync(bound, 0o700);
try {
  if (createHash('sha256').update(readFileSync(bound)).digest('hex') !== digest) process.exit(1);
  const result = spawnSync(bound, [mode, left, right], {
    stdio: 'ignore',
    timeout,
  });
  if (result.error || result.status !== 0) process.exit(result.status ?? 1);
  const rightAfter = lstatSync(right);
  if (rightAfter.dev !== leftBefore.dev || rightAfter.ino !== leftBefore.ino) process.exit(1);
  if (mode === '--exchange') {
    const leftAfter = lstatSync(left);
    if (leftAfter.dev !== rightBefore.dev || leftAfter.ino !== rightBefore.ino) process.exit(1);
  } else {
    try { lstatSync(left); process.exit(1); } catch (error) {
      if (error.code !== 'ENOENT') process.exit(1);
    }
  }
} finally {
  try { unlinkSync(bound); } catch {}
}
NODE
}

reclaim_stale_lock() {
  if ! mkdir "$RECLAIM_DIR" 2>/dev/null; then
    return
  fi
  local owner="" owner_birth="" current_birth="" age="0"
  if [ -L "$LOCK_FILE" ]; then
    rmdir "$RECLAIM_DIR"
    return
  fi
  if [ -d "$LOCK_FILE" ]; then
    owner="$(sed -n '1p' "$LOCK_FILE/pid" 2>/dev/null || true)"
    owner_birth="$(sed -n '2p' "$LOCK_FILE/pid" 2>/dev/null || true)"
  elif [ -f "$LOCK_FILE" ]; then
    owner="$(sed -n '1p' "$LOCK_FILE" 2>/dev/null || true)"
    owner_birth="$(sed -n '2p' "$LOCK_FILE" 2>/dev/null || true)"
  fi
  age="$(lock_age_seconds "$LOCK_FILE")"
  if [[ "$owner" =~ ^[0-9]+$ ]]; then
    current_birth="$(process_birth_identity "$owner" 2>/dev/null || true)"
  fi
  if [[ "$owner" =~ ^[0-9]+$ ]]; then
    if kill -0 "$owner" 2>/dev/null; then
      if [ -z "$current_birth" ] || [ -z "$owner_birth" ] || [ "$current_birth" = "$owner_birth" ]; then
        :
      elif [ -d "$LOCK_FILE" ]; then
        rm -rf "$LOCK_FILE"
      else
        rm -f "$LOCK_FILE"
      fi
    elif [ -d "$LOCK_FILE" ]; then
      rm -rf "$LOCK_FILE"
    else
      rm -f "$LOCK_FILE"
    fi
  elif [ -z "$owner" ]; then
    if [ "$age" -ge 5 ] || [ "$age" -ge "$LOCK_MAX_AGE_SECONDS" ]; then
      if [ -d "$LOCK_FILE" ]; then
        rm -rf "$LOCK_FILE"
      else
        rm -f "$LOCK_FILE"
      fi
    fi
  fi
  rmdir "$RECLAIM_DIR"
}

try_claim_lock() {
  if ! mkdir "$RECLAIM_DIR" 2>/dev/null; then
    return 1
  fi
  local claimed=0
  if node -e 'const fs=require("node:fs"); try { fs.linkSync(process.argv[1], process.argv[2]); } catch { process.exit(1); }' "$LOCK_OWNER_FILE" "$LOCK_FILE"; then
    claimed=1
  fi
  rmdir "$RECLAIM_DIR"
  [ "$claimed" = "1" ]
}

acquire_install_lock() {
  mkdir -p "$RUNNER_CACHE_ROOT"
  LOCK_OWNER_FILE="$(mktemp "$RUNNER_CACHE_ROOT/.install-owner.XXXXXX")"
  LOCK_OWNER_BIRTH="$(process_birth_identity "$$" 2>/dev/null || true)"
  if [ -z "$LOCK_OWNER_BIRTH" ] || ! printf '%s\n%s\n' "$$" "$LOCK_OWNER_BIRTH" > "$LOCK_OWNER_FILE"; then
    echo "ERROR: failed to create maestro-runner install lock owner record."
    correction
    exit 1
  fi
  local attempts=0
  while ! try_claim_lock; do
    if [ -L "$LOCK_FILE" ]; then
      echo "ERROR: refusing maestro-runner install lock symlink at $LOCK_FILE."
      correction
      exit 1
    fi
    reclaim_stale_lock
    attempts=$((attempts + 1))
    if [ $((attempts % 10)) -eq 0 ] && bin_matches_pin; then
      report_success
      exit 0
    fi
    if [ "$(remaining_install_seconds)" -le "$DOWNLOAD_RESERVE_SECONDS" ]; then
      if bin_matches_pin; then
        report_success
        exit 0
      fi
      echo "ERROR: timed out waiting for maestro-runner pin-cache install lock."
      correction
      exit 1
    fi
    sleep 0.1
  done
  LOCK_HELD=1
  rm -f "$LOCK_OWNER_FILE"
  LOCK_OWNER_FILE=""
}

acquire_install_lock

for guarded_path in "$RUNNER_CACHE_ROOT" "$PIN_DIR" "$PIN_DIR/bin" "$BIN"; do
  if [ -L "$guarded_path" ]; then
    echo "ERROR: refusing maestro-runner pin-cache symlink at $guarded_path."
    correction
    exit 1
  fi
done

if bin_matches_pin; then
  report_success
  exit 0
fi

if [ -x "$BIN" ]; then
  GOT_SHA="$(file_sha "$BIN")"
  echo "NOTE: pin-cache maestro-runner is not exactly $MAESTRO_RUNNER_PIN_VERSION (got sha=${GOT_SHA:-unhashed}). Converging."
fi

ARCHIVE="maestro-runner-${MAESTRO_RUNNER_PIN_VERSION}-${OS}-${ARCH}.tar.gz"
DOWNLOAD_URL="${RN_DEV_AGENT_MAESTRO_DOWNLOAD_URL:-${DOWNLOAD_BASE}/${MAESTRO_RUNNER_PIN_VERSION}/${ARCHIVE}}"

echo "Installing maestro-runner $MAESTRO_RUNNER_PIN_VERSION into the session pin-cache..."
echo "Destination: $PIN_DIR"

TEMP_DIR="$(mktemp -d "$RUNNER_CACHE_ROOT/.install-stage.XXXXXX")"

DOWNLOAD_TIMEOUT_SECONDS=$(($(remaining_install_seconds) - DOWNLOAD_RESERVE_SECONDS))
if [ "$DOWNLOAD_TIMEOUT_SECONDS" -le 0 ]; then
  echo "ERROR: maestro-runner install deadline expired before download."
  correction
  exit 1
fi
if [ "$DOWNLOAD_TIMEOUT_SECONDS" -gt 75 ]; then
  DOWNLOAD_TIMEOUT_SECONDS=75
fi
CONNECT_TIMEOUT_SECONDS=$DOWNLOAD_TIMEOUT_SECONDS
if [ "$CONNECT_TIMEOUT_SECONDS" -gt 10 ]; then
  CONNECT_TIMEOUT_SECONDS=10
fi

if ! curl -fsSL --connect-timeout "$CONNECT_TIMEOUT_SECONDS" --max-time "$DOWNLOAD_TIMEOUT_SECONDS" -o "$TEMP_DIR/$ARCHIVE" "$DOWNLOAD_URL"; then
  echo "ERROR: failed to download $DOWNLOAD_URL"
  correction
  exit 1
fi

GOT_ARCHIVE_SHA="$(file_sha "$TEMP_DIR/$ARCHIVE")"
require_install_time "archive verification"
if [ -z "$GOT_ARCHIVE_SHA" ] || [ "$GOT_ARCHIVE_SHA" != "$EXPECTED_ARCHIVE_SHA" ]; then
  echo "ERROR: downloaded archive checksum does not match the $MAESTRO_RUNNER_PIN_VERSION pin manifest."
  echo "  expected archive sha256: $EXPECTED_ARCHIVE_SHA"
  echo "  got archive sha256:      ${GOT_ARCHIVE_SHA:-unhashed}"
  correction
  exit 1
fi

if [ ! -s "$TEMP_DIR/$ARCHIVE" ]; then
  echo "ERROR: downloaded archive is empty"
  correction
  exit 1
fi

mkdir -p "$TEMP_DIR/extract"
if ! deadline_run tar -xzf "$TEMP_DIR/$ARCHIVE" -C "$TEMP_DIR/extract"; then
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

STAGED_PIN_DIR="$TEMP_DIR/pin"
mkdir -p "$STAGED_PIN_DIR"
if ! deadline_run cp -R "$SRC/." "$STAGED_PIN_DIR/"; then
  echo "ERROR: maestro-runner install deadline expired while staging the payload."
  correction
  exit 1
fi
if ! deadline_run cp "$TEMP_DIR/$ARCHIVE" "$STAGED_PIN_DIR/.payload.tar.gz"; then
  echo "ERROR: maestro-runner install deadline expired while retaining the payload attestation."
  correction
  exit 1
fi
STAGED_BIN="$STAGED_PIN_DIR/bin/maestro-runner"
chmod +x "$STAGED_BIN"
if [ "$(platform_key)" = "darwin" ]; then
  xattr -d com.apple.quarantine "$STAGED_BIN" 2>/dev/null || true
fi

if ! pin_dir_matches_pin "$STAGED_PIN_DIR"; then
  GOT_SHA="$(file_sha "$STAGED_BIN")"
  echo "ERROR: just-installed binary is not exactly $MAESTRO_RUNNER_PIN_VERSION."
  echo "  expected version: $MAESTRO_RUNNER_PIN_VERSION"
  echo "  expected sha256:  $EXPECTED_SHA"
  echo "  got sha256:       ${GOT_SHA:-unhashed}"
  correction
  exit 1
fi

if [ -e "$PIN_DIR" ]; then
  if ! atomic_publish_directories --exchange "$PIN_DIR" "$STAGED_PIN_DIR"; then
    echo "ERROR: failed to atomically publish the validated maestro-runner pin-cache."
    correction
    exit 1
  fi
else
  require_install_time "payload publication"
  if ! atomic_publish_directories --rename-no-replace "$STAGED_PIN_DIR" "$PIN_DIR"; then
    if ! pin_dir_matches_pin "$PIN_DIR"; then
      echo "ERROR: failed to conditionally publish the validated maestro-runner pin-cache."
      correction
      exit 1
    fi
  fi
fi

require_install_time "payload publication"
if ! pin_dir_matches_pin "$PIN_DIR"; then
  echo "ERROR: published maestro-runner pin-cache did not pass final attestation."
  correction
  exit 1
fi
report_success
exit 0
