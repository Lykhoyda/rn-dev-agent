#!/usr/bin/env bash
set -euo pipefail

if command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg available: $(ffmpeg -version 2>&1 | head -1)"
  exit 0
fi

if command -v brew >/dev/null 2>&1; then
  echo "Installing ffmpeg via Homebrew..." >&2
  if brew install ffmpeg 2>&1; then
    echo "ffmpeg installed successfully"
    exit 0
  else
    echo "Warning: ffmpeg installation failed. GIF conversion will be skipped." >&2
    exit 1
  fi
fi

echo "Warning: ffmpeg not found and Homebrew not available. GIF conversion will be skipped." >&2
echo "Install manually: brew install ffmpeg" >&2
exit 0
