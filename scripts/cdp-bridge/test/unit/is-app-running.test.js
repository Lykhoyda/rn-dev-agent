import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAppRunning } from '../../dist/tools/device-session.js';

// B112/D641: isAppRunning dispatches to platform-specific probes. Probes
// are injectable so tests don't spawn subprocesses.

test('isAppRunning routes to iOS probe by default', async () => {
  let called = null;
  const result = await isAppRunning('ios', 'com.foo.app', {
    ios: async (id) => { called = id; return true; },
    android: async () => { throw new Error('should not reach android'); },
  });
  assert.equal(called, 'com.foo.app');
  assert.equal(result, true);
});

test('isAppRunning routes to Android probe for android platform', async () => {
  let called = null;
  const result = await isAppRunning('android', 'com.foo.app', {
    ios: async () => { throw new Error('should not reach ios'); },
    android: async (id) => { called = id; return true; },
  });
  assert.equal(called, 'com.foo.app');
  assert.equal(result, true);
});

test('isAppRunning defaults to iOS when platform is undefined', async () => {
  const result = await isAppRunning(undefined, 'com.foo.app', {
    ios: async () => true,
    android: async () => false,
  });
  assert.equal(result, true);
});

test('isAppRunning returns false when the iOS probe says no', async () => {
  const result = await isAppRunning('ios', 'com.missing.app', {
    ios: async () => false,
  });
  assert.equal(result, false);
});

test('isAppRunning returns false when the Android probe says no', async () => {
  const result = await isAppRunning('android', 'com.missing.app', {
    android: async () => false,
  });
  assert.equal(result, false);
});

test('isAppRunning is case-insensitive on platform', async () => {
  const resultUpper = await isAppRunning('ANDROID', 'com.foo', {
    android: async () => true,
  });
  const resultMixed = await isAppRunning('iOS', 'com.foo', {
    ios: async () => true,
  });
  assert.equal(resultUpper, true);
  assert.equal(resultMixed, true);
});
