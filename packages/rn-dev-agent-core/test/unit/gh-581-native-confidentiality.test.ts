import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const androidDispatcher = new URL(
  '../../../rn-android-runner/app/src/androidTest/java/dev/lykhoyda/rndevagent/androidrunner/CommandDispatcher.kt',
  import.meta.url,
);

test('Android fill uses direct AccessibilityNodeInfo ACTION_SET_TEXT and never UiObject2.setText', async () => {
  const source = await readFile(androidDispatcher, 'utf8');
  assert.match(source, /AccessibilityNodeInfo\.ACTION_SET_TEXT/);
  assert.doesNotMatch(source, /focused\.text\s*=\s*text/);
  assert.doesNotMatch(source, /Setting text to/);
});

test('native fill responses do not echo requested or observed values', async () => {
  const source = await readFile(androidDispatcher, 'utf8');
  assert.doesNotMatch(source, /\.put\("text",\s*requested\)/);
  assert.doesNotMatch(source, /\.put\("observed/);
});
