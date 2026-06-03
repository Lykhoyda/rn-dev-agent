import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Audit M3: the tri-state liveness probe (probeFastRunnerLiveness /
// reapStaleFastRunner) existed + was unit-tested but had ZERO production
// callers, so a PID-alive-but-HTTP-wedged runner was still reused and hung
// every command on the full HTTP timeout. ensureFastRunner must now compose
// probe → (stale ? reap) → start instead of the PID-only check.

const __dirname = dirname(fileURLToPath(import.meta.url));
const wrapperSrc = readFileSync(resolve(__dirname, '../../src/agent-device-wrapper.ts'), 'utf8');

// Isolate the ensureFastRunner function body.
const fnMatch = wrapperSrc.match(/export async function ensureFastRunner[\s\S]*?\n}/);
assert.ok(fnMatch, 'ensureFastRunner should be present');
const fnBody = fnMatch[0];

test('M3: ensureFastRunner probes tri-state liveness, not just the PID', () => {
  assert.match(fnBody, /probeFastRunnerLiveness\(/, 'must probe liveness');
  assert.ok(!/if \(isFastRunnerAvailable\(\)\) return;/.test(fnBody), 'must NOT gate solely on the PID-only check');
});

test('M3: ensureFastRunner reaps a stale (wedged) runner before starting fresh', () => {
  assert.match(fnBody, /reapStaleFastRunner\(/, 'must reap a stale runner');
  assert.match(fnBody, /startFastRunner\(/, 'must still start a fresh runner');
});

test('M3: liveness/reap helpers are imported into the wrapper', () => {
  assert.match(wrapperSrc, /probeFastRunnerLiveness/, 'probe imported');
  assert.match(wrapperSrc, /reapStaleFastRunner/, 'reap imported');
});
