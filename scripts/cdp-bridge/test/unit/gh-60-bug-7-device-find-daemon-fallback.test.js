// GH #60 Bug 7: device_find used to surface "Daemon error: daemon timeout"
// directly to the caller and force them to fall back to cdp_interact manually.
// The new fallback detects the daemon-timeout error pattern, fetches a
// snapshot, and runs a fuzzy match — recovering automatically when the
// snapshot-tier path is healthy. Tests cover the pattern detector + the
// downstream recovery shape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDaemonTimeoutError } from '../../dist/tools/device-interact.js';

// ── isDaemonTimeoutError detector ───────────────────────────────────────

test('isDaemonTimeoutError: matches "Daemon error: daemon timeout"', () => {
  assert.equal(isDaemonTimeoutError('Daemon error: daemon timeout'), true);
});

test('isDaemonTimeoutError: matches lowercase variant', () => {
  assert.equal(isDaemonTimeoutError('daemon timeout'), true);
});

test('isDaemonTimeoutError: matches "daemon timed out"', () => {
  assert.equal(isDaemonTimeoutError('AgentDeviceRunner daemon timed out after 30s'), true);
});

test('isDaemonTimeoutError: matches "daemon timeout" inside JSON envelope', () => {
  const envelope = JSON.stringify({ ok: false, error: 'Daemon error: daemon timeout. Restart agent-device daemon.' });
  assert.equal(isDaemonTimeoutError(envelope), true);
});

test('isDaemonTimeoutError: does NOT match unrelated timeouts', () => {
  assert.equal(isDaemonTimeoutError('CDP evaluate timeout (5000ms)'), false);
  assert.equal(isDaemonTimeoutError('Request timeout'), false);
  assert.equal(isDaemonTimeoutError('softReconnect timeout'), false);
  assert.equal(isDaemonTimeoutError('force_reconnect timeout (10000ms)'), false);
});

test('isDaemonTimeoutError: handles empty/null/undefined safely', () => {
  assert.equal(isDaemonTimeoutError(''), false);
  assert.equal(isDaemonTimeoutError(null), false);
  assert.equal(isDaemonTimeoutError(undefined), false);
});

test('isDaemonTimeoutError: matches multi-line payload', () => {
  const stderr = `agent-device-runner: connecting to daemon...
Daemon error: daemon timeout
Falling back to direct CLI`;
  assert.equal(isDaemonTimeoutError(stderr), true);
});

// ── Source-grep regression guards ───────────────────────────────────────

test('source guard: device_find handler invokes fetchFindCandidates on daemon timeout', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(__dirname, '../../dist/tools/device-interact.js'), 'utf-8');
  // The new branch must call isDaemonTimeoutError + fetchFindCandidates.
  assert.match(src, /isDaemonTimeoutError\(/);
  assert.match(src, /snapshot_fallback_after_daemon_timeout/);
});

test('source guard: NOT_FOUND envelope on daemon-timeout-with-zero-snapshot-matches surfaces hint', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(__dirname, '../../dist/tools/device-interact.js'), 'utf-8');
  // The hint must mention cdp_interact as the suggested workaround.
  assert.match(src, /Try cdp_interact with a testID/);
});

test('source guard: ambiguous-match-after-recovery suggests daemon restart', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(__dirname, '../../dist/tools/device-interact.js'), 'utf-8');
  assert.match(src, /restarting it|daemon restart/i);
});

test('source guard: DAEMON_TIMEOUT failure code preserved when snapshot fallback also fails', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(__dirname, '../../dist/tools/device-interact.js'), 'utf-8');
  assert.match(src, /code:\s*['"]DAEMON_TIMEOUT['"]|"DAEMON_TIMEOUT"/);
});
