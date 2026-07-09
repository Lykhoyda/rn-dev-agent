import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePort,
  DEFAULT_OBSERVE_PORT,
  resolveObserveAutostart,
  resolveObservePort,
} from '../../dist/project-config.js';

// Spec 2026-07-02-observe-ui-autostart-design: precedence is
// env > .rn-agent/config.json observe block > default. Config errors fail open.

test('parsePort accepts a valid port and rejects junk / NaN / out-of-range', () => {
  assert.equal(parsePort('51234'), 51234);
  assert.equal(parsePort(undefined), undefined);
  assert.equal(parsePort(''), undefined);
  assert.equal(parsePort('abc'), undefined);
  assert.equal(parsePort('0'), undefined);
  assert.equal(parsePort('70000'), undefined, 'out of range');
});

test('resolveObserveAutostart: env "0"/"false" wins over config true', () => {
  const readConfig = () => ({ observe: { autoStart: true } });
  assert.deepEqual(resolveObserveAutostart({ env: '0', readConfig }), {
    enabled: false,
    source: 'env',
  });
  assert.deepEqual(resolveObserveAutostart({ env: 'false', readConfig }), {
    enabled: false,
    source: 'env',
  });
});

test('resolveObserveAutostart: env "1"/"true" forces on over config false', () => {
  const readConfig = () => ({ observe: { autoStart: false } });
  assert.deepEqual(resolveObserveAutostart({ env: '1', readConfig }), {
    enabled: true,
    source: 'env',
  });
  assert.deepEqual(resolveObserveAutostart({ env: 'true', readConfig }), {
    enabled: true,
    source: 'env',
  });
});

test('resolveObserveAutostart: unset env falls through to config', () => {
  const r = resolveObserveAutostart({
    env: undefined,
    readConfig: () => ({ observe: { autoStart: false } }),
  });
  assert.deepEqual(r, { enabled: false, source: 'config' });
});

test('resolveObserveAutostart: no config / non-boolean value → default true', () => {
  assert.deepEqual(resolveObserveAutostart({ env: undefined, readConfig: () => null }), {
    enabled: true,
    source: 'default',
  });
  assert.deepEqual(
    resolveObserveAutostart({
      env: undefined,
      readConfig: () => ({ observe: { autoStart: 'nope' } }),
    }),
    { enabled: true, source: 'default' },
  );
});

test('resolveObservePort: valid env wins over config', () => {
  const r = resolveObservePort({
    env: '51888',
    readConfig: () => ({ observe: { port: 51999 } }),
  });
  assert.deepEqual(r, { port: 51888, source: 'env' });
});

test('resolveObservePort: invalid env falls through to config', () => {
  const r = resolveObservePort({
    env: 'abc',
    readConfig: () => ({ observe: { port: 51999 } }),
  });
  assert.deepEqual(r, { port: 51999, source: 'config' });
});

test('resolveObservePort: invalid config port falls through to default', () => {
  assert.deepEqual(
    resolveObservePort({ env: undefined, readConfig: () => ({ observe: { port: 0 } }) }),
    { port: DEFAULT_OBSERVE_PORT, source: 'default' },
  );
  assert.deepEqual(
    resolveObservePort({ env: undefined, readConfig: () => ({ observe: { port: 99999 } }) }),
    { port: DEFAULT_OBSERVE_PORT, source: 'default' },
  );
  assert.deepEqual(
    resolveObservePort({ env: undefined, readConfig: () => ({ observe: { port: 7.5 } }) }),
    { port: DEFAULT_OBSERVE_PORT, source: 'default' },
  );
});

test('resolveObservePort: no env, no config → default 7333', () => {
  assert.deepEqual(resolveObservePort({ env: undefined, readConfig: () => null }), {
    port: 7333,
    source: 'default',
  });
  assert.equal(DEFAULT_OBSERVE_PORT, 7333);
});
