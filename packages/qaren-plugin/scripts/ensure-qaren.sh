#!/usr/bin/env bash
# Verifies and installs the qaren runtime this plugin version vouches for.
#
#   ensure-qaren.sh --print-bin                   offline; prints the installed binary or the
#                                                 install command; always exits 0
#   ensure-qaren.sh --install [--from-file <tgz>] downloads (or takes) the tarball, verifies its
#                                                 sha256 and length against runner-manifest.json,
#                                                 and installs it atomically into ~/.qaren/runtime/<v>/
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MANIFEST="$PLUGIN_ROOT/runner-manifest.json"
RELEASES="https://github.com/Lykhoyda/rn-dev-agent/releases/download"
RUNTIME_ROOT="${HOME:-}/.qaren/runtime"
RECORD=".tarball-sha256"
INSTALL_COMMAND="bash '$PLUGIN_ROOT/scripts/ensure-qaren.sh' --install"

MODE=""
FROM_FILE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --print-bin | --install) MODE="$1" ;;
    --from-file)
      [ $# -ge 2 ] || { echo "ensure-qaren: --from-file needs a path" >&2; exit 2; }
      FROM_FILE="$2"
      shift
      ;;
    *) echo "ensure-qaren: unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done
[ -n "$MODE" ] || { echo "usage: ensure-qaren.sh --print-bin | --install [--from-file <tarball>]" >&2; exit 2; }

# Prints the expected asset as four lines: version, name, sha256, bytes.
# Fails (with a reason on stderr) when this plugin carries no tarball for the host.
expected_asset() {
  local platform
  [ "$(uname -s)" = Darwin ] || { echo "qaren ships a macOS runtime only; this host is $(uname -s)" >&2; return 1; }
  case "$(uname -m)" in
    arm64) platform=darwin-arm64 ;;
    x86_64) platform=darwin-x64 ;;
    *) echo "qaren ships no runtime for $(uname -m)" >&2; return 1 ;;
  esac
  [ -f "$MANIFEST" ] || { echo "this plugin carries no runner-manifest.json" >&2; return 1; }
  command -v node >/dev/null 2>&1 || { echo "qaren needs Node 24 or newer on PATH" >&2; return 1; }
  local out version name sha bytes
  out=$(node -e '
    const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const a = (m.assets && m.assets.qaren && m.assets.qaren[process.argv[2]]) || {};
    console.log([m.version, a.name, a.sha256, a.bytes].map((v) => (v === undefined ? "" : v)).join("\n"));
  ' "$MANIFEST" "$platform") || { echo "runner-manifest.json is unreadable" >&2; return 1; }
  { read -r version; read -r name; read -r sha; read -r bytes; } <<< "$out"
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || { echo "runner-manifest.json has no release version" >&2; return 1; }
  [ -n "$name" ] || { echo "qaren v$version has no $platform tarball in runner-manifest.json" >&2; return 1; }
  [ "$name" = "qaren-$version-$platform.tar.gz" ] || { echo "unexpected qaren asset name: $name" >&2; return 1; }
  [[ "$sha" =~ ^[0-9a-f]{64}$ ]] || { echo "qaren asset $name has no sha256" >&2; return 1; }
  [[ "$bytes" =~ ^[1-9][0-9]*$ ]] || { echo "qaren asset $name has no byte length" >&2; return 1; }
  printf '%s\n%s\n%s\n%s\n' "$version" "$name" "$sha" "$bytes"
}

installed_bin() {
  local dest="$RUNTIME_ROOT/$1" sha="$2"
  [ -x "$dest/bin/qaren" ] && [ -f "$dest/$RECORD" ] && [ "$(cat "$dest/$RECORD")" = "$sha" ] \
    && echo "$dest/bin/qaren"
}

print_bin() {
  local asset version name sha bytes
  if ! asset=$(expected_asset 2>&1); then
    echo "qaren: $asset"
    return 0
  fi
  { read -r version; read -r name; read -r sha; read -r bytes; } <<< "$asset"
  installed_bin "$version" "$sha" && return 0
  echo "qaren v$version is not installed. Install it with: $INSTALL_COMMAND"
}

refuse() { echo "ensure-qaren: $*" >&2; exit 1; }

install() {
  local asset version name sha bytes dest
  asset=$(expected_asset) || exit 1
  { read -r version; read -r name; read -r sha; read -r bytes; } <<< "$asset"
  dest="$RUNTIME_ROOT/$version"
  installed_bin "$version" "$sha" && return 0

  mkdir -p "$RUNTIME_ROOT"
  STAGING=$(mktemp -d "$RUNTIME_ROOT/.install.XXXXXX")
  DEST="$dest"
  # An interrupted replacement puts the previous runtime back before staging is removed.
  trap '[ -e "$STAGING/previous" ] && [ ! -e "$DEST" ] && mv "$STAGING/previous" "$DEST"; rm -rf "$STAGING"' EXIT
  trap 'exit 130' INT TERM
  local tarball="$STAGING/$name" top="${name%.tar.gz}"

  if [ -n "$FROM_FILE" ]; then
    cp "$FROM_FILE" "$tarball" || refuse "cannot read $FROM_FILE"
  else
    command -v curl >/dev/null 2>&1 || refuse "curl is required to download $name"
    curl -fsSL --retry 3 --proto '=https' --proto-redir '=https' --tlsv1.2 -o "$tarball" "$RELEASES/v$version/$name" \
      || refuse "could not download $RELEASES/v$version/$name"
  fi

  local got
  got=$(wc -c < "$tarball" | tr -d ' ')
  [ "$got" = "$bytes" ] || refuse "$name is $got bytes, the manifest vouches for $bytes; nothing installed"
  got=$(shasum -a 256 "$tarball" | cut -d' ' -f1)
  [ "$got" = "$sha" ] || refuse "$name sha256 $got does not match the manifest $sha; nothing installed"

  local entry
  while IFS= read -r entry; do
    case "$entry" in
      /* | .. | ../* | */.. | */../*) refuse "$name carries an unsafe path: $entry" ;;
      "$top" | "$top/" | "$top"/*) ;;
      *) refuse "$name carries an entry outside $top/: $entry" ;;
    esac
  done < <(tar -tzf "$tarball")
  while IFS= read -r entry; do
    case "$entry" in
      [-d]*) ;;
      *) refuse "$name carries a link or special file: $entry" ;;
    esac
  done < <(tar -tvzf "$tarball")

  mkdir "$STAGING/x"
  tar -xzf "$tarball" -C "$STAGING/x" --no-same-owner
  [ -z "$(find "$STAGING/x" ! -type f ! -type d -print -quit)" ] \
    || refuse "$name carries a link or special file; the runtime ships only files and directories"
  [ "$(ls -A "$STAGING/x")" = "$top" ] || refuse "$name does not unpack to exactly $top/"
  [ -x "$STAGING/x/$top/bin/qaren" ] || refuse "$name carries no executable bin/qaren"
  printf '%s\n' "$sha" > "$STAGING/x/$top/$RECORD"

  if [ -e "$dest" ]; then
    mv "$dest" "$STAGING/previous"
  fi
  mv "$STAGING/x/$top" "$dest"
  echo "$dest/bin/qaren"
}

case "$MODE" in
  --print-bin) print_bin || true ;;
  --install) install ;;
esac
