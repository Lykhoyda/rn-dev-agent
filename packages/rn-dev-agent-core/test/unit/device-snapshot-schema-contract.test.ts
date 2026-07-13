import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('device_snapshot exposes explicit device selection through MCP', async () => {
  const source = await readFile(resolve(import.meta.dirname, '../../src/index.ts'), 'utf8');
  const start = source.indexOf("trackedTool(\n  'device_snapshot'");
  const end = source.indexOf("trackedTool(\n  'device_find'", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);

  const registration = source.slice(start, end);
  assert.match(registration, /deviceId:\s*z\s*\.string\(\)\s*\.optional\(\)/);
  assert.match(registration, /UDID.*adb serial/);
});
