// GH #383 (Task 8 carry-forwards): RUNNER_PROTOCOL_MISMATCH and the transparent
// upgrade note must surface on EVERY entry path, not just runNative. The
// device_snapshot action=open path has no dependency-injection seam for
// ensureRunnerForCommand/startAndroidRunner, so — like the GH #202 wiring
// tests — these are source-text invariants on the open path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sessionSrc = readFileSync(resolve(__dirname, '../../src/tools/device-session.ts'), 'utf8');
const wrapperSrc = readFileSync(resolve(__dirname, '../../src/agent-device-wrapper.ts'), 'utf8');

test('gh-383: iOS open path propagates ready.code (RUNNER_PROTOCOL_MISMATCH) instead of hard-coding RN_FAST_RUNNER_DOWN', () => {
  assert.match(sessionSrc, /failResult\(ready\.message, ready\.code \?\? 'RN_FAST_RUNNER_DOWN'\)/);
  assert.ok(
    !sessionSrc.includes("failResult(ready.message, 'RN_FAST_RUNNER_DOWN')"),
    'the hard-coded RN_FAST_RUNNER_DOWN mapping must be gone',
  );
});

test('gh-383: open success carries the upgrade note (iOS ready.note, Android pending note) via attachMetaNote', () => {
  assert.match(sessionSrc, /upgradeNote = ready\.note/);
  assert.match(sessionSrc, /upgradeNote = consumePendingAndroidUpgradeNote\(\)/);
  assert.match(sessionSrc, /upgradeNote \? attachMetaNote\(result, upgradeNote\) : result/);
});

test('gh-383: Android note is consumed immediately after startAndroidRunner succeeds (never left pending)', () => {
  assert.match(
    sessionSrc,
    /await startAndroidRunner\(deviceId, appId\);\s*\n\s*upgradeNote = consumePendingAndroidUpgradeNote\(\);/,
  );
});

test('gh-383: open catch surfaces RUNNER_PROTOCOL_MISMATCH before the generic runner-down mapping', () => {
  const catchBlock = sessionSrc.slice(
    sessionSrc.indexOf('// Ensure runner + launch.'),
    sessionSrc.indexOf('// Set session LAST'),
  );
  assert.ok(catchBlock.length > 0, 'open try/catch block must be locatable');
  const mismatch = catchBlock.indexOf("msg.startsWith('RUNNER_PROTOCOL_MISMATCH')");
  const generic = catchBlock.indexOf("'RN_ANDROID_RUNNER_DOWN'");
  assert.ok(mismatch !== -1, 'catch must check for RUNNER_PROTOCOL_MISMATCH');
  assert.ok(generic !== -1, 'catch must keep the generic runner-down mapping');
  assert.ok(mismatch < generic, 'mismatch check must run BEFORE the generic mapping');
});

test('gh-383: runNative Android pre-flight failure consumes (discards) the pending upgrade note', () => {
  const preflight = wrapperSrc.slice(
    wrapperSrc.indexOf('await startAndroidRunner(serial, appId);'),
    wrapperSrc.indexOf('rn-android-runner did not start'),
  );
  assert.ok(preflight.length > 0, 'pre-flight catch must be locatable');
  assert.ok(
    preflight.includes('consumePendingAndroidUpgradeNote();'),
    'the failed-start path must discard the pending note so it cannot attach to a later result',
  );
});
