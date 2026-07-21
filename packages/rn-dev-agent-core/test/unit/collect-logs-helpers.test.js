import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockClient } from '../helpers/mock-cdp-client.js';
import { parseEnvelope, expectOk, expectFail } from '../helpers/result-helpers.js';
import {
  buildAndroidLogcatArgs,
  buildIosLogStreamArgs,
  createCollectLogsHandler,
  parseIosAppPid,
} from '../../dist/tools/collect-logs.js';

// collect_logs has three source types: js_console, native_ios, native_android.
// native_ios and native_android spawn xcrun/adb — not testable without those tools.
// We test the js_console path and the orchestration logic.

test('collect_logs: Android logcat is pinned to the selected serial', () => {
  const args = buildAndroidLogcatArgs('emulator-5560');
  assert.deepEqual(args.slice(0, 3), ['-s', 'emulator-5560', 'logcat']);
  assert.equal(args.includes('emulator-5556'), false);
});

test('collect_logs: iOS log stream is pinned to exact device and target-app PID', () => {
  const launchctl = [
    'PID Status Label',
    '555 0 UIKitApplication:com.other.app[abc]',
    '777 0 UIKitApplication:com.rndevagent.testapp[target]',
  ].join('\n');
  assert.equal(parseIosAppPid(launchctl, 'com.rndevagent.testapp'), 777);
  assert.equal(parseIosAppPid(launchctl, 'com.missing.app'), null);
  assert.deepEqual(buildIosLogStreamArgs('exact-udid', 777), [
    'simctl',
    'spawn',
    'exact-udid',
    'log',
    'stream',
    '--style',
    'ndjson',
    '--level',
    'debug',
    '--predicate',
    'processIdentifier == 777',
  ]);
});

// ── js_console source ─────────────────────────────────────────────────

test('collect_logs: js_console returns entries from connected client', async () => {
  const entries = [
    { level: 'log', text: 'hello world', timestamp: '2026-04-13T10:00:00Z' },
    { level: 'error', text: 'crash', timestamp: '2026-04-13T10:00:01Z' },
  ];
  const client = createMockClient({
    evaluate: async () => ({ value: JSON.stringify(entries) }),
  });
  const handler = createCollectLogsHandler(() => client);
  const result = await handler({
    sources: ['js_console'],
    durationMs: 100,
    limit: 50,
  });
  const env = parseEnvelope(result);
  assert.equal(env.ok, true);
  assert.equal(env.data.count, 2);
  assert.equal(env.data.entries[0].source, 'js_console');
});

test('collect_logs: filters entries by text', async () => {
  const entries = [
    { level: 'log', text: 'debug info', timestamp: '2026-04-13T10:00:00Z' },
    { level: 'error', text: 'crash happened', timestamp: '2026-04-13T10:00:01Z' },
  ];
  const client = createMockClient({
    evaluate: async () => ({ value: JSON.stringify(entries) }),
  });
  const handler = createCollectLogsHandler(() => client);
  const result = await handler({
    sources: ['js_console'],
    durationMs: 100,
    limit: 50,
    filter: 'crash',
  });
  const data = expectOk(result);
  assert.equal(data.count, 1);
  assert.match(data.entries[0].text, /crash/);
});

test('collect_logs: filters entries by logLevel', async () => {
  const entries = [
    { level: 'log', text: 'info msg', timestamp: '2026-04-13T10:00:00Z' },
    { level: 'error', text: 'error msg', timestamp: '2026-04-13T10:00:01Z' },
  ];
  const client = createMockClient({
    evaluate: async () => ({ value: JSON.stringify(entries) }),
  });
  const handler = createCollectLogsHandler(() => client);
  const result = await handler({
    sources: ['js_console'],
    durationMs: 100,
    limit: 50,
    logLevel: 'error',
  });
  const data = expectOk(result);
  assert.equal(data.count, 1);
  assert.equal(data.entries[0].level, 'error');
});

test('collect_logs: respects limit with truncation flag', async () => {
  const entries = Array.from({ length: 10 }, (_, i) => ({
    level: 'log',
    text: `msg ${i}`,
    timestamp: `2026-04-13T10:00:${String(i).padStart(2, '0')}Z`,
  }));
  const client = createMockClient({
    evaluate: async () => ({ value: JSON.stringify(entries) }),
  });
  const handler = createCollectLogsHandler(() => client);
  const result = await handler({
    sources: ['js_console'],
    durationMs: 100,
    limit: 3,
  });
  const data = expectOk(result);
  assert.equal(data.count, 3);
  assert.equal(data.total, 10);
  assert.equal(data.truncated, true);
});

test('collect_logs: returns failResult when CDP not connected', async () => {
  const client = createMockClient({ _isConnected: false });
  const handler = createCollectLogsHandler(() => client);
  const result = await handler({
    sources: ['js_console'],
    durationMs: 100,
    limit: 50,
  });
  const env = parseEnvelope(result);
  assert.equal(env.ok, false);
  assert.match(env.error, /CDP not connected/);
});

test('collect_logs: returns failResult for no valid sources', async () => {
  const client = createMockClient();
  const handler = createCollectLogsHandler(() => client);
  const result = await handler({
    sources: [],
    durationMs: 100,
    limit: 50,
  });
  expectFail(result);
});

test('collect_logs: handles empty entries from evaluate', async () => {
  const client = createMockClient({
    evaluate: async () => ({ value: JSON.stringify([]) }),
  });
  const handler = createCollectLogsHandler(() => client);
  const result = await handler({
    sources: ['js_console'],
    durationMs: 100,
    limit: 50,
  });
  const data = expectOk(result);
  assert.equal(data.count, 0);
  assert.equal(data.truncated, false);
});
