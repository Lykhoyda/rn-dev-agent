import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ExperienceRecorder,
  OWNED_TEST_APP_BUNDLE_ID,
  exportLatestRunnerDiagnosticsBundle,
  writeRunnerDiagnosticsBundle,
} from '../../dist/experience/evidence.js';
import {
  recordRunnerDiagnostic,
  snapshotRunnerDiagnostics,
  withRunnerDiagnosticsContext,
  type RunnerDiagnosticsSnapshot,
} from '../../dist/experience/runner-diagnostics.js';
import { createCollectLogsHandler } from '../../dist/tools/collect-logs.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

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
  sessionId = 'authenticated-session',
): void {
  const recorder = new ExperienceRecorder({
    directory,
    coreVersion: '0.77.1',
    pluginVersion: '0.77.1',
    sessionId,
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
    sessionId: 'spoofed-public-session',
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
  assert.equal(values[0].context.runtime, process.version);
  assert.equal(values[0].context.sessionId, 'authenticated-session');
  assert.doesNotMatch(JSON.stringify(values), /PRIVATE-DEVICE-ID|com\.external\.private/);
});

test('runner diagnostics retain terminal lifecycle events after the event cap', async () => {
  let snapshot: RunnerDiagnosticsSnapshot | undefined;
  await withRunnerDiagnosticsContext('maestro_test_all', { platform: 'ios' }, async () => {
    recordRunnerDiagnostic('spawn-begin');
    recordRunnerDiagnostic('payload-verify');
    recordRunnerDiagnostic('cache-provision');
    for (let index = 0; index < 205; index += 1) {
      recordRunnerDiagnostic('runner-exec-begin', { index });
    }
    recordRunnerDiagnostic('wda-bootstrap-begin');
    recordRunnerDiagnostic('typed-failure', { code: 'WDA_BOOTSTRAP_FAILED' });
    recordRunnerDiagnostic('cleanup', { snapshotRemoved: true, cacheRemoved: true });
    recordRunnerDiagnostic('tool-outcome', { status: 'FAIL' });
    snapshot = snapshotRunnerDiagnostics();
  });

  assert.equal(snapshot?.events.length, 200);
  assert.equal(snapshot?.truncated, true);
  assert.deepEqual(
    snapshot?.events.slice(-3).map((event) => event.type),
    ['typed-failure', 'cleanup', 'tool-outcome'],
  );
  assert.ok(snapshot?.events.some((event) => event.type === 'spawn-begin'));
  assert.ok(snapshot?.events.some((event) => event.type === 'payload-verify'));
  assert.ok(
    snapshot?.events.every(
      (event, index, events) => index === 0 || event.sequence > events[index - 1]!.sequence,
    ),
  );
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
    snapshot.events = Array.from({ length: 240 }, (_, eventIndex) => {
      const type =
        eventIndex === 238
          ? ('cleanup' as const)
          : eventIndex === 239
            ? ('tool-outcome' as const)
            : ('typed-failure' as const);
      return {
        sequence: eventIndex + 1,
        monotonicMs: eventIndex,
        timestamp: '2026-08-23T12:00:00.000Z',
        type,
        detail: { code: 'WDA_BOOTSTRAP_FAILED', padding: 'x'.repeat(2048) },
      };
    });
    recordFailure(directory, params, snapshot, 'retained-session');
  }
  assert.equal(bundles(directory).length, 5);
  for (const file of bundles(directory)) {
    const contents = readFileSync(join(directory, file));
    assert.ok(contents.byteLength <= 256 * 1024);
    const parsed = JSON.parse(contents.toString());
    assert.equal(parsed.truncated, true);
    assert.ok(parsed.events.some((event: { type: string }) => event.type === 'cleanup'));
    assert.ok(parsed.events.some((event: { type: string }) => event.type === 'tool-outcome'));
  }

  const output = join(directory, 'reviewed-runner-diagnostics.json');
  assert.equal(exportLatestRunnerDiagnosticsBundle(output, 'retained-session', directory), output);
  assert.equal(existsSync(output), true);
  assert.throws(
    () => exportLatestRunnerDiagnosticsBundle(output, 'retained-session', directory),
    /EEXIST/,
  );
});

test('runner diagnostics bound metadata before enforcing the absolute byte cap', () => {
  const sourceDirectory = mkdtempSync(join(tmpdir(), 'runner-diagnostics-metadata-source-'));
  const targetDirectory = mkdtempSync(join(tmpdir(), 'runner-diagnostics-metadata-target-'));
  recordFailure(sourceDirectory, { platform: 'ios', actionId: 'login-en' });
  const bundle = JSON.parse(
    readFileSync(join(sourceDirectory, bundles(sourceDirectory)[0]), 'utf8'),
  );
  bundle.candidate.pluginVersion = 'p'.repeat(300_000);
  bundle.candidate.releaseCommit = 'r'.repeat(300_000);
  bundle.context.runtime = 'n'.repeat(300_000);

  const path = writeRunnerDiagnosticsBundle(targetDirectory, bundle);
  const contents = readFileSync(path);
  const bounded = JSON.parse(contents.toString());
  assert.ok(contents.byteLength <= 256 * 1024);
  assert.equal(bounded.truncated, true);
  assert.match(bounded.candidate.pluginVersion, /\[TRUNCATED\]$/);
  assert.match(bounded.candidate.releaseCommit, /\[TRUNCATED\]$/);
  assert.match(bounded.context.runtime, /\[TRUNCATED\]$/);
});

test('diagnostics exports select only the exact authenticated session', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'runner-diagnostics-session-filter-'));
  const previousDirectory = process.env.RN_DEV_AGENT_EXPERIENCE_DIR;
  const previousSession = process.env.RN_DEV_AGENT_SESSION_ID;
  try {
    recordFailure(directory, { platform: 'ios', actionId: 'owned-action' }, undefined, 'owned');
    recordFailure(directory, { platform: 'ios', actionId: 'foreign-action' }, undefined, 'foreign');

    const directOutput = join(directory, 'direct-export.json');
    exportLatestRunnerDiagnosticsBundle(directOutput, 'owned', directory);
    assert.equal(JSON.parse(readFileSync(directOutput, 'utf8')).context.actionId, 'owned-action');
    assert.throws(
      () =>
        exportLatestRunnerDiagnosticsBundle(
          join(directory, 'missing-export.json'),
          'missing',
          directory,
        ),
      /exact session/,
    );

    process.env.RN_DEV_AGENT_EXPERIENCE_DIR = directory;
    process.env.RN_DEV_AGENT_SESSION_ID = 'owned';
    const collectOutput = join(directory, 'collect-logs-export.json');
    const collectLogs = createCollectLogsHandler(
      () =>
        ({
          isConnected: true,
          helpersInjected: true,
          bridgeDetected: false,
          evaluate: async () => ({ value: '[]' }),
        }) as never,
    );
    const result = await collectLogs({
      sources: ['js_console'],
      durationMs: 0,
      limit: 1,
      runnerDiagnosticsOutputPath: collectOutput,
    });
    const envelope = JSON.parse(result.content[0].text);
    assert.equal(envelope.ok, true);
    assert.equal(JSON.parse(readFileSync(collectOutput, 'utf8')).context.actionId, 'owned-action');

    delete process.env.RN_DEV_AGENT_SESSION_ID;
    const refused = await collectLogs({
      sources: ['js_console'],
      durationMs: 0,
      limit: 1,
      runnerDiagnosticsOutputPath: join(directory, 'unbound-export.json'),
    });
    const refusedEnvelope = JSON.parse(refused.content[0].text);
    assert.equal(refusedEnvelope.ok, false);
    assert.match(refusedEnvelope.error, /Exact authenticated session identity/);
    process.env.RN_DEV_AGENT_SESSION_ID = 'owned';

    const fakeHome = mkdtempSync(join(tmpdir(), 'runner-diagnostics-feedback-home-'));
    const collector = join(repositoryRoot, 'scripts', 'collect-feedback.sh');
    const collected = spawnSync('bash', [collector], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: fakeHome,
        RN_PROJECT_ROOT: repositoryRoot,
        RN_DEV_AGENT_EXPERIENCE_DIR: directory,
        RN_DEV_AGENT_SESSION_ID: 'owned',
      },
    });
    assert.equal(collected.status, 0, collected.stderr);
    const feedback = JSON.parse(collected.stdout);
    assert.equal(feedback.runner_diagnostics.context.actionId, 'owned-action');
    assert.equal(feedback.runner_diagnostics_status, 'attached for review');
    rmSync(fakeHome, { recursive: true, force: true });
  } finally {
    if (previousDirectory === undefined) delete process.env.RN_DEV_AGENT_EXPERIENCE_DIR;
    else process.env.RN_DEV_AGENT_EXPERIENCE_DIR = previousDirectory;
    if (previousSession === undefined) delete process.env.RN_DEV_AGENT_SESSION_ID;
    else process.env.RN_DEV_AGENT_SESSION_ID = previousSession;
    rmSync(directory, { recursive: true, force: true });
  }
});
