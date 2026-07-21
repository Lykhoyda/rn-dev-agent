import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = (rel: string) => readFileSync(resolve(__dirname, '../../src', rel), 'utf8');

const sessionSrc = src('tools/device-session.ts');
const repairSrc = src('tools/repair-action.ts');

// Both recovery paths hold an exact device identity before they re-foreground
// the target app; launching against `booted` there is the #588 wrong-device bug.
test('GH-588: iOS re-foreground recovery never targets the ambiguous booted alias', () => {
  for (const [name, source] of [
    ['device-session.ts', sessionSrc],
    ['repair-action.ts', repairSrc],
  ]) {
    assert.doesNotMatch(
      source,
      /'simctl',\s*'launch',\s*'booted'/,
      `${name} must not launch against the booted alias`,
    );
  }
});

test('GH-588: both re-foreground paths delegate to the exact-device launchApp owner', () => {
  for (const [name, source] of [
    ['device-session.ts', sessionSrc],
    ['repair-action.ts', repairSrc],
  ]) {
    assert.match(source, /app-lifecycle\.js/, `${name} must import the lifecycle owner`);
    // Three arguments = (bundleId, platform, deviceId): the launch is device-scoped.
    assert.match(
      source,
      /launchApp\(\s*[^(),]+,[^(),]+,[^()]+\)/,
      `${name} must launch through launchApp with a device argument`,
    );
  }
});
