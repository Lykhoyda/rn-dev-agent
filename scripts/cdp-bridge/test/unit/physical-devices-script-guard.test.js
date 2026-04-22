import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

// M9 / D668 — structural guard for scripts/check-physical-devices.sh.
// Live smoke of the physical-device detection happens at /setup runtime;
// this test pins the script's expected invariants so a refactor doesn't
// silently drop a probe.

const __dirname = dirname(fileURLToPath(import.meta.url));
// Script lives at repo root/scripts/check-physical-devices.sh.
// Test lives at repo root/scripts/cdp-bridge/test/unit/ — go up 3 levels.
const SCRIPT_PATH = join(__dirname, '..', '..', '..', 'check-physical-devices.sh');

test('M9: check-physical-devices.sh exists and is executable', () => {
  const stats = statSync(SCRIPT_PATH);
  assert.ok(stats.isFile(), 'script must be a file');
  assert.ok((stats.mode & 0o111) !== 0, 'script must have executable bit set');
});

test('M9: script has bash shebang', () => {
  const content = readFileSync(SCRIPT_PATH, 'utf-8');
  assert.match(content.split('\n')[0], /^#!\/usr\/bin\/env bash/);
});

test('M9: script probes adb devices + runs adb reverse on port 8081', () => {
  const content = readFileSync(SCRIPT_PATH, 'utf-8');
  assert.match(content, /adb devices/, 'must probe adb devices');
  assert.match(content, /adb .* reverse tcp:8081 tcp:8081/, 'must run adb reverse for port 8081');
});

test('M9: script filters out emulators (only physical Android)', () => {
  const content = readFileSync(SCRIPT_PATH, 'utf-8');
  // The filter pattern excludes "emulator-" prefixed device IDs.
  assert.match(content, /emulator-/, 'must mention the emulator prefix it is filtering out');
});

test('M9: script uses xcrun xctrace for iOS physical detection', () => {
  const content = readFileSync(SCRIPT_PATH, 'utf-8');
  assert.match(content, /xcrun xctrace list devices/, 'must probe xcrun xctrace');
});

test('M9: script filters iOS devices positively (iPhone/iPad/etc) to exclude Mac host', () => {
  const content = readFileSync(SCRIPT_PATH, 'utf-8');
  // Must positively match iOS form factors so the Mac listed under "== Devices ==" is skipped.
  assert.match(content, /iPhone/, 'must filter for iPhone');
  assert.match(content, /iPad/, 'must filter for iPad');
});

test('M9: script checks for idb-companion or idb_companion', () => {
  const content = readFileSync(SCRIPT_PATH, 'utf-8');
  // Both underscore and dash forms exist across idb installs — accept either.
  assert.match(content, /idb[-_]companion/, 'must check for idb-companion presence');
  assert.match(content, /brew install idb-companion/, 'must hint the brew install command when missing');
});

test('M9: script documents WiFi-debugging non-support stance', () => {
  const content = readFileSync(SCRIPT_PATH, 'utf-8');
  assert.match(content, /WiFi/, 'must mention WiFi');
  assert.match(content, /not supported/i, 'must declare WiFi is not supported automatically');
});
