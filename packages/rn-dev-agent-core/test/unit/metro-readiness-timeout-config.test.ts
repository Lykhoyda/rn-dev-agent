// GH #992: `.rn-agent/config.json` → `metro.readinessTimeoutMs` is the one
// per-project setting for the managed-Metro readiness budget. Absent → the
// provisional 90 s default; a malformed value is refused with an actionable
// error rather than silently replaced (a quietly ignored timeout is the kind
// of wrongness this fix exists to remove).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_METRO_READINESS_TIMEOUT_MS,
  METRO_ENSURE_CLI_CLEANUP_MARGIN_MS,
  METRO_READINESS_TIMEOUT_MAX_MS,
  SESSION_CLI_TIMEOUT_MS,
  deriveEnsureMetroCliTimeoutMs,
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

test('metro.readinessTimeoutMs: a malformed metro container refuses instead of falling back', () => {
  for (const value of [150_000, '150000', [150_000], null, true, false]) {
    assert.throws(
      () =>
        resolveMetroReadinessTimeout({
          readConfig: () => ({ metro: value as never }),
        }),
      (error: Error) => {
        assert.match(error.message, /^METRO_READINESS_TIMEOUT_INVALID: /);
        assert.match(error.message, /metro must be an object/);
        return true;
      },
      `expected metro=${JSON.stringify(value)} to be refused`,
    );
  }
});

test('ensure-metro CLI timeout is derived from the budget plus cleanup margin, floored at 120 s', () => {
  assert.equal(SESSION_CLI_TIMEOUT_MS, 120_000);
  assert.equal(METRO_ENSURE_CLI_CLEANUP_MARGIN_MS, 25_000);
  const atDefault = deriveEnsureMetroCliTimeoutMs(DEFAULT_METRO_READINESS_TIMEOUT_MS);
  assert.equal(atDefault, 120_000, '90 s + 25 s margin still sits under the 120 s floor');
  assert.ok(atDefault >= DEFAULT_METRO_READINESS_TIMEOUT_MS + METRO_ENSURE_CLI_CLEANUP_MARGIN_MS);
  const configured = deriveEnsureMetroCliTimeoutMs(150_000);
  assert.equal(configured, 175_000);
  assert.equal(
    deriveEnsureMetroCliTimeoutMs(METRO_READINESS_TIMEOUT_MAX_MS),
    METRO_READINESS_TIMEOUT_MAX_MS + METRO_ENSURE_CLI_CLEANUP_MARGIN_MS,
  );
  assert.equal(deriveEnsureMetroCliTimeoutMs(1_000), SESSION_CLI_TIMEOUT_MS);
  for (const budget of [1_000, 90_000, 150_000, 600_000]) {
    const timeout = deriveEnsureMetroCliTimeoutMs(budget);
    assert.ok(timeout >= SESSION_CLI_TIMEOUT_MS);
    assert.ok(timeout >= budget + METRO_ENSURE_CLI_CLEANUP_MARGIN_MS);
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
