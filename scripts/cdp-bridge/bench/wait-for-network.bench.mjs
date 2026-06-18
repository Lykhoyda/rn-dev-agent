// Benchmark for cdp_wait_for_network — GH #65 P3 / D682.
//
// Three layers of measurement:
//   A. Helper microbenchmarks — pure JS, deterministic
//   B. Buffer scan latency vs buffer size — Phase 1 retroactive scan
//   C. End-to-end handler timing — Phase 1 hit, poll hit, timeout
//
// Run from scripts/cdp-bridge:
//   node bench/wait-for-network.bench.mjs
//
// Output: stdout summary + benchmark.json (machine-readable for trend tracking
// per feedback_always_record_timing.md).

import { performance } from 'node:perf_hooks';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  normalizeSince,
  buildMatchPredicate,
  isComplete,
  createWaitForNetworkHandler,
} from '../dist/tools/wait-for-network.js';
import { DeviceBufferManager } from '../dist/ring-buffer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Shared fixtures ─────────────────────────────────────────────────────────

function makeEntry(i, opts = {}) {
  return {
    id: `req-${i}`,
    method: opts.method ?? (i % 5 === 0 ? 'POST' : 'GET'),
    url: opts.url ?? (i % 7 === 0 ? '/api/cart/add' : `/api/items/${i}`),
    timestamp: opts.timestamp ?? new Date(Date.now() - (1000 - i)).toISOString(),
    status: opts.status ?? 200,
    duration_ms: opts.duration_ms ?? 50,
  };
}

function makeBuffer(entryCount, opts = {}) {
  const buf = new DeviceBufferManager({
    capacityPerDevice: 100,
    maxDevices: 10,
    indexKey: (e) => e.id,
    timestampOf: (e) => new Date(e.timestamp).getTime(),
  });
  const deviceCount = opts.devices ?? 1;
  for (let i = 0; i < entryCount; i++) {
    const deviceKey = `8081-page${(i % deviceCount) + 1}`;
    buf.push(deviceKey, makeEntry(i, opts.entryOpts));
  }
  return buf;
}

function makeFakeClient(buffer, deviceKey = '8081-page1') {
  return {
    isConnected: true,
    helpersInjected: true,
    connectionGeneration: 1,
    activeDeviceKey: deviceKey,
    networkBufferManager: buffer,
    async evaluate() {
      return { value: 13 };
    },
    async reinjectHelpers() {
      return true;
    },
  };
}

function timeIt(fn, iterations) {
  // Warm up JIT
  for (let i = 0; i < Math.min(iterations, 1000); i++) fn();
  const start = performance.now();
  for (let i = 0; i < iterations; i++) fn();
  const elapsed = performance.now() - start;
  return {
    iterations,
    total_ms: +elapsed.toFixed(3),
    ns_per_op: Math.round((elapsed * 1e6) / iterations),
    ops_per_sec: Math.round(iterations / (elapsed / 1000)),
  };
}

async function timeAsync(fn, iterations) {
  // Warm up
  for (let i = 0; i < Math.min(iterations, 3); i++) await fn();
  const samples = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    await fn();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  return {
    iterations,
    min_ms: +samples[0].toFixed(3),
    p50_ms: +samples[Math.floor(samples.length / 2)].toFixed(3),
    p95_ms: +samples[Math.floor(samples.length * 0.95)].toFixed(3),
    max_ms: +samples[samples.length - 1].toFixed(3),
    mean_ms: +(samples.reduce((s, x) => s + x, 0) / samples.length).toFixed(3),
  };
}

// ── A. Helper microbenchmarks ──────────────────────────────────────────────

console.log('\n=== A. Helper microbenchmarks (1M iterations each) ===\n');

const helperResults = {
  normalizeSince_alreadyZ: timeIt(() => normalizeSince('2026-04-27T08:00:00.000Z'), 1_000_000),
  normalizeSince_withOffset: timeIt(() => normalizeSince('2026-04-27T10:00:00+02:00'), 1_000_000),
  normalizeSince_unparseable: timeIt(() => normalizeSince('not-a-date'), 1_000_000),
  buildMatchPredicate_construction: timeIt(
    () => buildMatchPredicate('/api/cart', 'POST', '2026-04-27T08:00:00.000Z'),
    1_000_000,
  ),
};

const sampleEntry = makeEntry(0);
const samplePredicate = buildMatchPredicate('/api/cart', 'POST', '2020-01-01T00:00:00.000Z');
helperResults.predicate_eval_match = timeIt(
  () => samplePredicate({ ...sampleEntry, url: '/api/cart/add', method: 'POST' }),
  1_000_000,
);
helperResults.predicate_eval_miss_url = timeIt(() => samplePredicate(sampleEntry), 1_000_000);
helperResults.isComplete_true = timeIt(() => isComplete(sampleEntry), 1_000_000);
const inflightEntry = { ...sampleEntry };
delete inflightEntry.status;
helperResults.isComplete_false = timeIt(() => isComplete(inflightEntry), 1_000_000);

for (const [name, r] of Object.entries(helperResults)) {
  console.log(
    `  ${name.padEnd(38)} ${String(r.ns_per_op).padStart(6)} ns/op  (${r.ops_per_sec.toLocaleString()} ops/s)`,
  );
}

// ── B. Buffer scan latency vs buffer size ──────────────────────────────────

console.log('\n=== B. Buffer scan latency (Phase 1 retroactive scan) ===\n');

const bufferScanResults = {};
const sizes = [
  { name: 'empty', entries: 0, devices: 1 },
  { name: 'small_10', entries: 10, devices: 1 },
  { name: 'full_100', entries: 100, devices: 1 },
  { name: 'cross_device_all_500', entries: 500, devices: 5 },
];

for (const { name, entries, devices } of sizes) {
  const buf = makeBuffer(entries, { devices });
  const scope = devices === 1 ? '8081-page1' : 'all';
  const predicate = buildMatchPredicate('/api/cart', 'POST', undefined);

  const r = timeIt(() => buf.filter(scope, predicate), 10_000);
  bufferScanResults[name] = { entries, devices, ...r };
  console.log(
    `  scope=${scope.padEnd(13)} entries=${String(entries).padStart(3)} devices=${devices}  →  ${r.ns_per_op.toLocaleString().padStart(8)} ns/op  (${(r.ns_per_op / 1000).toFixed(2)} µs/op)`,
  );
}

// ── C. End-to-end handler timing ───────────────────────────────────────────

console.log('\n=== C. End-to-end handler timing ===\n');

const handlerResults = {};

// C1. Phase 1 retroactive hit — completed entry already in buffer
{
  const buf = makeBuffer(50);
  // Ensure at least one entry matches our pattern: '/api/cart/add' with POST
  buf.push('8081-page1', makeEntry(999, { url: '/api/cart/add', method: 'POST', status: 201 }));
  const client = makeFakeClient(buf);
  const handler = createWaitForNetworkHandler(() => client);

  handlerResults.retroactive_hit = await timeAsync(
    () => handler({ url_pattern: '/api/cart/add', method: 'POST' }),
    50,
  );
  console.log(`  C1. Phase 1 hit (50-entry buf, completed match present)`);
  console.log(
    `      min=${handlerResults.retroactive_hit.min_ms}ms  p50=${handlerResults.retroactive_hit.p50_ms}ms  p95=${handlerResults.retroactive_hit.p95_ms}ms  max=${handlerResults.retroactive_hit.max_ms}ms`,
  );
}

// C2. Poll hit — entry mutates from in-flight to complete during poll window
{
  // Each iteration needs a fresh in-flight entry that we mutate to complete
  // mid-poll. Track elapsed time per iteration and compute stats.
  const iterations = 10;
  const samples = [];
  for (let i = 0; i < iterations; i++) {
    const buf = makeBuffer(10);
    const inflight = makeEntry(1000 + i, { url: '/api/profile/save', method: 'PUT' });
    delete inflight.status;
    buf.push('8081-page1', inflight);
    const client = makeFakeClient(buf);
    const handler = createWaitForNetworkHandler(() => client);

    // Mutate the entry to complete after ~75ms (one poll tick at default 100ms,
    // so the second tick should catch it).
    setTimeout(() => {
      inflight.status = 200;
      inflight.duration_ms = 60;
    }, 75);

    const start = performance.now();
    await handler({
      url_pattern: '/api/profile/save',
      method: 'PUT',
      timeout_ms: 1000,
      poll_interval_ms: 50,
    });
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  handlerResults.poll_hit_50ms = {
    iterations,
    min_ms: +samples[0].toFixed(3),
    p50_ms: +samples[Math.floor(iterations / 2)].toFixed(3),
    p95_ms: +samples[Math.floor(iterations * 0.95)].toFixed(3),
    max_ms: +samples[samples.length - 1].toFixed(3),
    mean_ms: +(samples.reduce((s, x) => s + x, 0) / samples.length).toFixed(3),
    note: 'entry completes at +75ms; poll cadence 50ms',
  };
  console.log(`  C2. Poll hit (entry completes mid-poll, cadence=50ms)`);
  console.log(
    `      min=${handlerResults.poll_hit_50ms.min_ms}ms  p50=${handlerResults.poll_hit_50ms.p50_ms}ms  p95=${handlerResults.poll_hit_50ms.p95_ms}ms  max=${handlerResults.poll_hit_50ms.max_ms}ms`,
  );
}

// C3. Timeout — no match, full timeout window
{
  const buf = makeBuffer(50);
  const client = makeFakeClient(buf);
  const handler = createWaitForNetworkHandler(() => client);

  handlerResults.timeout_500ms = await timeAsync(
    () =>
      handler({
        url_pattern: '/never-fires-' + Math.random(),
        timeout_ms: 500,
        poll_interval_ms: 100,
      }),
    5,
  );
  console.log(`  C3. Timeout (no match, 500ms timeout, 100ms poll)`);
  console.log(
    `      min=${handlerResults.timeout_500ms.min_ms}ms  p50=${handlerResults.timeout_500ms.p50_ms}ms  p95=${handlerResults.timeout_500ms.p95_ms}ms  max=${handlerResults.timeout_500ms.max_ms}ms`,
  );
}

// C4. Disconnect mid-poll — connection drops, handler should bail early
{
  const iterations = 5;
  const samples = [];
  for (let i = 0; i < iterations; i++) {
    const buf = makeBuffer(10);
    const client = makeFakeClient(buf);
    let connected = true;
    Object.defineProperty(client, 'isConnected', {
      get() {
        return connected;
      },
    });
    const handler = createWaitForNetworkHandler(() => client);

    setTimeout(() => {
      connected = false;
    }, 75);

    const start = performance.now();
    await handler({ url_pattern: '/never-fires', timeout_ms: 5000, poll_interval_ms: 50 });
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  handlerResults.disconnect_bail = {
    iterations,
    min_ms: +samples[0].toFixed(3),
    p50_ms: +samples[Math.floor(iterations / 2)].toFixed(3),
    max_ms: +samples[samples.length - 1].toFixed(3),
    mean_ms: +(samples.reduce((s, x) => s + x, 0) / samples.length).toFixed(3),
    note: 'connection drops at +75ms; timeout was 5000ms — should short-circuit',
  };
  console.log(`  C4. Disconnect bail-out (timeout=5000ms, connection drops at +75ms)`);
  console.log(
    `      min=${handlerResults.disconnect_bail.min_ms}ms  p50=${handlerResults.disconnect_bail.p50_ms}ms  max=${handlerResults.disconnect_bail.max_ms}ms`,
  );
}

// ── Persist machine-readable results ───────────────────────────────────────

const benchmark = {
  tool: 'cdp_wait_for_network',
  issue: '#65 P3',
  decision: 'D682',
  date: new Date().toISOString(),
  node_version: process.version,
  platform: `${process.platform} ${process.arch}`,
  timings: {
    helpers: helperResults,
    buffer_scan: bufferScanResults,
    handler: handlerResults,
  },
  notes: [
    'Benchmark imports compiled tool from dist/, exercising real DeviceBufferManager and helpers.',
    'No live MCP transport in scope — envelope serialization adds <100us per call (well below poll cadence).',
    'C2 (poll_hit_50ms) timing dominated by setTimeout granularity; expect mean ≈ entry-mutation-delay + poll cadence.',
    'C3 (timeout_500ms) target = 500ms exact; mean reflects setTimeout drift on the test runner.',
    'C4 (disconnect_bail) verifies the in-poll isConnected guard short-circuits well before timeout.',
  ],
};

const outPath = resolve(__dirname, 'wait-for-network.benchmark.json');
await writeFile(outPath, JSON.stringify(benchmark, null, 2));
console.log(`\n→ Wrote ${outPath}\n`);
