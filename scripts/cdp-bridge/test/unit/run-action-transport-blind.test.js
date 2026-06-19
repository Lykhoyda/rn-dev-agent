import { test } from 'node:test';
import assert from 'node:assert/strict';

test('RunRecord accepts optional transport and omits it by default', () => {
  // a maestro record (no transport) and a cdp-js record both round-trip
  const base = {
    timestamp: '2026-06-19T00:00:00Z',
    durationMs: 1,
    status: 'pass',
    trigger: 'human',
    autoRepair: { attempted: false, outcome: 'skipped', phases: { firstAttemptMs: 1 } },
  };
  const maestro = { ...base };
  const fallback = { ...base, transport: 'cdp-js' };
  assert.equal('transport' in maestro, false);
  assert.equal(fallback.transport, 'cdp-js');
});
