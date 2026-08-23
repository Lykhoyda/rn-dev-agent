import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  ExperienceRecorder,
  OWNED_TEST_APP_BUNDLE_ID,
  exportLatestRunnerDiagnosticsBundle,
} from '../../dist/experience/evidence.js';
import type { RunnerDiagnosticsSnapshot } from '../../dist/experience/runner-diagnostics.js';

function trace(params: Record<string, unknown>): RunnerDiagnosticsSnapshot {
  return {
    rootTool: 'cdp_run_action',
    rootParams: params,
    truncated: false,
    events: [
      {
        sequence: 1,
        monotonicMs: 0.2,
        timestamp: '2026-08-23T12:00:00.000Z',
        type: 'payload-verify',
        detail: {
          result: 'passed',
          runnerPinVersion: '1.1.24',
          provenance: 'pin-cache',
          payloadShaPrefix: '123456789abc',
        },
      },
      {
        sequence: 2,
        monotonicMs: 0.4,
        timestamp: '2026-08-23T12:00:00.001Z',
        type: 'cache-provision',
        detail: { result: 'failed', variant: 'symlink', path: 'cache', errno: 'EACCES' },
      },
    ],
  };
}

function recordFailure(
  directory: string,
  params: Record<string, unknown>,
  snapshot = trace(params),
): void {
  const recorder = new ExperienceRecorder({
    directory,
    coreVersion: '0.77.1',
    pluginVersion: '0.77.1',
    schedule: (work) => work(),
  });
  recorder.observe({
    tool: 'cdp_run_action',
    params,
    status: 'FAIL',
    latencyMs: 10,
    error: 'WDA_BOOTSTRAP_FAILED',
    result: { code: 'WDA_BOOTSTRAP_FAILED' },
    runnerDiagnostics: snapshot,
  });
}

function bundles(directory: string): string[] {
  return readdirSync(directory)
    .filter((file) => file.startsWith('runner-diagnostics-'))
    .sort();
}

test('runner diagnostics use a stable salted device hash and redact external bundle IDs', () => {
  const directory = mkdtempSync(join(tmpdir(), 'runner-diagnostics-'));
  const params = {
    platform: 'ios',
    actionId: 'login-en',
    deviceId: 'PRIVATE-DEVICE-ID',
    appId: 'com.external.private',
    sessionId: 'session-a',
    metroPort: 8891,
  };
  recordFailure(directory, params);
  recordFailure(directory, params);

  const values = bundles(directory).map((file) =>
    JSON.parse(readFileSync(join(directory, file), 'utf8')),
  );
  assert.equal(values.length, 2);
  assert.equal(values[0].context.deviceIdHash, values[1].context.deviceIdHash);
  assert.match(values[0].context.deviceIdHash, /^[a-f0-9]{64}$/);
  assert.equal(values[0].context.bundleId, '[BUNDLE_REDACTED]');
  assert.doesNotMatch(JSON.stringify(values), /PRIVATE-DEVICE-ID|com\.external\.private/);
});

test('runner diagnostics retain the owned workspace test-app bundle ID only', () => {
  const directory = mkdtempSync(join(tmpdir(), 'runner-diagnostics-owned-'));
  recordFailure(directory, {
    platform: 'ios',
    appId: OWNED_TEST_APP_BUNDLE_ID,
    sessionId: 'owned-session',
  });
  const value = JSON.parse(readFileSync(join(directory, bundles(directory)[0]), 'utf8'));
  assert.equal(value.context.bundleId, OWNED_TEST_APP_BUNDLE_ID);
});

test('runner diagnostics retain five bounded bundles and export newest without overwrite', () => {
  const directory = mkdtempSync(join(tmpdir(), 'runner-diagnostics-retention-'));
  for (let index = 0; index < 7; index += 1) {
    const params = { platform: 'ios', sessionId: `session-${index}` };
    const snapshot = trace(params);
    snapshot.events = Array.from({ length: 240 }, (_, eventIndex) => ({
      sequence: eventIndex + 1,
      monotonicMs: eventIndex,
      timestamp: '2026-08-23T12:00:00.000Z',
      type: 'typed-failure' as const,
      detail: { code: 'WDA_BOOTSTRAP_FAILED', padding: 'x'.repeat(2048) },
    }));
    recordFailure(directory, params, snapshot);
  }
  assert.equal(bundles(directory).length, 5);
  for (const file of bundles(directory)) {
    const contents = readFileSync(join(directory, file));
    assert.ok(contents.byteLength <= 256 * 1024);
    assert.equal(JSON.parse(contents.toString()).truncated, true);
  }

  const output = join(directory, 'reviewed-runner-diagnostics.json');
  assert.equal(exportLatestRunnerDiagnosticsBundle(output, directory), output);
  assert.equal(existsSync(output), true);
  assert.throws(() => exportLatestRunnerDiagnosticsBundle(output, directory), /EEXIST/);
});
