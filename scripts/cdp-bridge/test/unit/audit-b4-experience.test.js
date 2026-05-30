// Audit batch B4 — experience-engine correctness + redaction fixes.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { redact } from '../../dist/experience/redact.js';
import { nextCandidateId } from '../../dist/experience/compact.js';
import { highestImportedIds } from '../../dist/experience/sharing.js';
import { isGhostRetryable } from '../../dist/experience/telemetry.js';

// --- redaction: quoted JSON / generic secrets in string values ---

test('redact catches quoted-JSON secret values inside a string field', () => {
  const out = redact({ error: 'login failed for {"password":"hunter2longpasswordvalue","api_key":"abc123def456ghi789"}' });
  const s = out.error;
  assert.ok(!s.includes('hunter2longpasswordvalue'), 'password value leaked');
  assert.ok(!s.includes('abc123def456ghi789'), 'api_key value leaked');
  assert.ok(s.includes('[REDACTED_SECRET]'));
});

test('redact removes an object-valued auth key without recursing into it', () => {
  const out = redact({ credentials: { user: 'bob', pass: 'supersecretpw99' } });
  assert.equal(out.credentials, '[REDACTED:object]');
});

test('redact removes a scalar auth key', () => {
  const out = redact({ password: 'short' });
  assert.equal(out.password, '[REDACTED:string]');
});

// --- redaction: PII no longer over-redacts bare numbers ---

test('redact does NOT redact bare 9-10 digit numbers (timestamps/latencies/ids)', () => {
  const out = redact({ latency_ms: '1234567890', count: '987654321' });
  assert.equal(out.latency_ms, '1234567890');
  assert.equal(out.count, '987654321');
});

test('redact still redacts formatted phone and SSN', () => {
  const out = redact({ note: 'call 555-123-4567 ssn 123-45-6789' });
  assert.ok(!out.note.includes('555-123-4567'));
  assert.ok(!out.note.includes('123-45-6789'));
  assert.ok(out.note.includes('[PII_REDACTED]'));
});

// --- candidate-id counter matches the real filename shape ---

test('nextCandidateId advances past existing candidate-<rs|fp>-c<n> files', () => {
  assert.equal(nextCandidateId([]), 1);
  assert.equal(nextCandidateId(['candidate-rs-c1.md', 'candidate-fp-c2.md']), 3);
  assert.equal(nextCandidateId(['candidate-rs-c7.md']), 8);
  // The old broken shape (digit right after the dash) never occurs but must not crash.
  assert.equal(nextCandidateId(['candidate-3.md']), 1);
});

// --- imported heuristic ids do not collide across imports ---

test('highestImportedIds returns per-prefix maxima from existing content', () => {
  const content = [
    '## Recovery Shortcuts',
    '### RS-I1: foo',
    '### RS-I3: bar',
    '## Failure Patterns',
    '### FP-I2: baz',
  ].join('\n');
  const c = highestImportedIds(content);
  assert.equal(c.RS, 3);
  assert.equal(c.FP, 2);
  assert.equal(c.PC, 0);
});

test('highestImportedIds is empty for content without imported ids', () => {
  assert.deepEqual(highestImportedIds('### RS-C1: a candidate (not imported)'), { RS: 0, FP: 0, PC: 0 });
});

// --- ghost recovery only re-runs idempotent tools ---

test('isGhostRetryable allows read-only tools and blocks mutating ones', () => {
  for (const t of ['cdp_status', 'cdp_component_tree', 'device_snapshot', 'device_screenshot', 'expect_redux']) {
    assert.equal(isGhostRetryable(t), true, `${t} should be retryable`);
  }
  for (const t of ['device_press', 'device_fill', 'cdp_dispatch', 'device_record', 'cdp_navigate', 'cdp_evaluate', 'cdp_mmkv']) {
    assert.equal(isGhostRetryable(t), false, `${t} must NOT be auto-retried`);
  }
});
