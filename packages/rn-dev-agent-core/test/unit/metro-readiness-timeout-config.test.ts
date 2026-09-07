// GH #992: `.rn-agent/config.json` → `metro.readinessTimeoutMs` is the one
// per-project setting for the managed-Metro readiness budget. Absent → the
// provisional 90 s default; a malformed value is refused with an actionable
// error rather than silently replaced (a quietly ignored timeout is the kind
// of wrongness this fix exists to remove).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_METRO_READINESS_TIMEOUT_MS,
  resolveMetroReadinessTimeout,
} from '../../dist/project-config.js';

test('metro.readinessTimeoutMs: absent → 90 s default', () => {
  assert.equal(DEFAULT_METRO_READINESS_TIMEOUT_MS, 90_000);
  assert.deepEqual(resolveMetroReadinessTimeout({ readConfig: () => null }), {
    timeoutMs: 90_000,
    source: 'default',
  });
  assert.deepEqual(resolveMetroReadinessTimeout({ readConfig: () => ({}) }), {
    timeoutMs: 90_000,
    source: 'default',
  });
  assert.deepEqual(resolveMetroReadinessTimeout({ readConfig: () => ({ metro: {} }) }), {
    timeoutMs: 90_000,
    source: 'default',
  });
});

test('metro.readinessTimeoutMs: a sane integer is used verbatim', () => {
  for (const value of [1_000, 20_000, 150_000, 600_000]) {
    assert.deepEqual(
      resolveMetroReadinessTimeout({
        readConfig: () => ({ metro: { readinessTimeoutMs: value } }),
      }),
      { timeoutMs: value, source: 'config' },
    );
  }
});

test('metro.readinessTimeoutMs: a malformed value refuses instead of falling back', () => {
  for (const value of ['90000', 999, 600_001, 0, -1, 1.5, null, true, Number.NaN, Infinity]) {
    assert.throws(
      () =>
        resolveMetroReadinessTimeout({
          readConfig: () => ({ metro: { readinessTimeoutMs: value as never } }),
        }),
      (error: Error) => {
        assert.match(error.message, /^METRO_READINESS_TIMEOUT_INVALID: /);
        assert.match(
          error.message,
          /metro\.readinessTimeoutMs must be an integer between 1000 and 600000 milliseconds/,
        );
        assert.match(error.message, /fix or remove the key to use the 90000 ms default/);
        return true;
      },
      `expected ${String(value)} to be refused`,
    );
  }
});
