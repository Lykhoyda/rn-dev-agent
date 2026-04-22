import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockClient } from '../helpers/mock-cdp-client.js';
import { parseEnvelope, expectOk, expectFail } from '../helpers/result-helpers.js';
import { createStatusHandler } from '../../dist/tools/status.js';
import { narrowArchitecture } from '../../dist/tools/status.js';
import { createCpuProfileHandler, OLD_ARCH_PROFILER_HINT } from '../../dist/tools/profiling.js';

// M10 / D667 — integration tests for cdp_status.app.architecture wiring
// plus the cdp_cpu_profile failure hint when architecture is 'old'.

// ── narrowArchitecture helper ────────────────────────────────────────

test('M10 narrow: passes through "new" unchanged', () => {
  assert.equal(narrowArchitecture('new'), 'new');
});

test('M10 narrow: passes through "old" unchanged', () => {
  assert.equal(narrowArchitecture('old'), 'old');
});

test('M10 narrow: collapses anything else to "unknown"', () => {
  assert.equal(narrowArchitecture(undefined), 'unknown');
  assert.equal(narrowArchitecture(null), 'unknown');
  assert.equal(narrowArchitecture('fabric'), 'unknown');
  assert.equal(narrowArchitecture(42), 'unknown');
  assert.equal(narrowArchitecture({}), 'unknown');
});

// ── cdp_status handler integration ───────────────────────────────────

function buildStatusProbeResult(appInfo) {
  return JSON.stringify({
    appInfo,
    errorCount: 0,
    fiberTree: true,
    hasRedBox: false,
    helpersLoaded: true,
  });
}

test('M10 status: app.architecture="new" when probe returns new', async () => {
  const client = createMockClient({
    evaluate: async () => ({ value: buildStatusProbeResult({ __DEV__: true, architecture: 'new' }) }),
  });
  const handler = createStatusHandler(() => client, () => {}, () => client);
  const data = expectOk(await handler({}));
  assert.equal(data.app.architecture, 'new');
});

test('M10 status: app.architecture="old" when probe returns old', async () => {
  const client = createMockClient({
    evaluate: async () => ({ value: buildStatusProbeResult({ __DEV__: true, architecture: 'old' }) }),
  });
  const handler = createStatusHandler(() => client, () => {}, () => client);
  const data = expectOk(await handler({}));
  assert.equal(data.app.architecture, 'old');
});

test('M10 status: app.architecture="unknown" when probe omits the field', async () => {
  const client = createMockClient({
    evaluate: async () => ({ value: buildStatusProbeResult({ __DEV__: true }) }),
  });
  const handler = createStatusHandler(() => client, () => {}, () => client);
  const data = expectOk(await handler({}));
  assert.equal(data.app.architecture, 'unknown');
});

test('M10 status: unexpected architecture string is narrowed to "unknown"', async () => {
  const client = createMockClient({
    evaluate: async () => ({ value: buildStatusProbeResult({ __DEV__: true, architecture: 'bridgeless-interop' }) }),
  });
  const handler = createStatusHandler(() => client, () => {}, () => client);
  const data = expectOk(await handler({}));
  assert.equal(data.app.architecture, 'unknown');
});

// ── cdp_cpu_profile error-path hint ──────────────────────────────────

test('M10 profiler: failure on old architecture includes meta.hint', async () => {
  let evaluateCalls = 0;
  const client = createMockClient({
    _profilerAvailable: true,
    async send(method) {
      if (method === 'Profiler.enable') return {};
      if (method === 'Profiler.start') throw new Error('Profiler.start timed out');
      if (method === 'Profiler.disable') return {};
      return {};
    },
    async evaluate(expr) {
      evaluateCalls++;
      // safeProbeArchitecture calls helperExpr('getAppInfo()') — return 'old'
      if (expr.includes('getAppInfo')) {
        return { value: JSON.stringify({ architecture: 'old' }) };
      }
      return { value: 13 };
    },
    get profilerAvailable() { return true; },
  });
  const handler = createCpuProfileHandler(() => client);
  const result = await handler({ durationMs: 500 });
  const envelope = parseEnvelope(result);
  assert.equal(envelope.ok, false);
  assert.match(envelope.error, /CPU profiling failed/);
  assert.ok(envelope.meta, 'meta should be attached when architecture is old');
  assert.equal(envelope.meta.hint, OLD_ARCH_PROFILER_HINT);
  assert.equal(envelope.meta.architecture, 'old');
  assert.ok(evaluateCalls >= 1, 'safeProbeArchitecture should have fired');
});

test('M10 profiler: failure on new architecture omits meta.hint', async () => {
  const client = createMockClient({
    _profilerAvailable: true,
    async send(method) {
      if (method === 'Profiler.enable') return {};
      if (method === 'Profiler.start') throw new Error('Profiler.start timed out');
      if (method === 'Profiler.disable') return {};
      return {};
    },
    async evaluate(expr) {
      if (expr.includes('getAppInfo')) {
        return { value: JSON.stringify({ architecture: 'new' }) };
      }
      return { value: 13 };
    },
    get profilerAvailable() { return true; },
  });
  const handler = createCpuProfileHandler(() => client);
  const result = await handler({ durationMs: 500 });
  const envelope = parseEnvelope(result);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.meta?.hint, undefined, 'no hint on new architecture');
});

test('M10 profiler: failure when safeProbeArchitecture itself throws — no hint', async () => {
  const client = createMockClient({
    _profilerAvailable: true,
    async send(method) {
      if (method === 'Profiler.enable') return {};
      if (method === 'Profiler.start') throw new Error('Profiler.start timed out');
      if (method === 'Profiler.disable') return {};
      return {};
    },
    async evaluate(expr) {
      if (expr.includes('getAppInfo')) throw new Error('evaluate broken');
      return { value: 13 };
    },
    get profilerAvailable() { return true; },
  });
  const handler = createCpuProfileHandler(() => client);
  const result = await handler({ durationMs: 500 });
  const envelope = parseEnvelope(result);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.meta?.hint, undefined, 'probe failure collapses to unknown, no hint');
});
