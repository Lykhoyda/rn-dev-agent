#!/usr/bin/env bash
# Builds the iOS contract fixture as an unsigned simulator .app — no Xcode
# project needed (single-file SwiftUI app compiled with swiftc).
set -euo pipefail
cd "$(dirname "$0")"
ARCH="${FIXTURE_ARCH:-$(uname -m)}"
OUT=build/Fixture.app
rm -rf build
mkdir -p "$OUT"
xcrun -sdk iphonesimulator swiftc \
  -parse-as-library -O \
  -target "$ARCH-apple-ios16.0-simulator" \
  Sources/FixtureApp.swift \
  -o "$OUT/Fixture"
cp Info.plist "$OUT/Info.plist"
codesign --force --sign - "$OUT"
echo "built $OUT"
