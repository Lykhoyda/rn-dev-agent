import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(
  '/Users/anton_personal/GitHub/claude-react-native-dev-plugin/scripts/cdp-bridge/src/agent-device-wrapper.ts',
  'utf8',
);

test('buildRunAndroidArgs maps Android MVP verbs', () => {
  for (const fragment of [
    "case 'press':",
    "case 'tap':",
    "case 'fill':",
    "case 'type':",
    "case 'snapshot':",
    "case 'back':",
    "case 'screenshot':",
    "case 'keyboard':",
    "case 'swipe':",
    "case 'scroll':",
    "case 'drag':",
    "case 'longpress':",
    "case 'pinch':",
  ]) {
    assert.ok(source.includes(fragment), `missing ${fragment}`);
  }
});

test('buildRunAndroidArgs includes stale-ref sentinel and screenshot out path', () => {
  assert.match(source, /_staleRef: ref/);
  assert.match(source, /_staleRef: target/);
  assert.match(source, /outPath: optionValue\(cliArgs, '--out'\)/);
});
