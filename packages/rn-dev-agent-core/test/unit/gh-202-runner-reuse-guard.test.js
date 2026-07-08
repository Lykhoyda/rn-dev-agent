import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldReuseRunner } from '../../dist/runners/rn-fast-runner-client.js';

const state = { pid: 1, port: 22088, deviceId: 'UDID-A', bundleId: 'com.x', startedAt: 'now' };

test('GH#202 shouldReuseRunner: reuse only when deviceId matches', () => {
  assert.equal(shouldReuseRunner(state, 'UDID-A'), true);
});

test('GH#202 shouldReuseRunner: never reuse a runner bound to another simulator', () => {
  assert.equal(shouldReuseRunner(state, 'UDID-B'), false);
});

test('GH#202 shouldReuseRunner: never reuse null state', () => {
  assert.equal(shouldReuseRunner(null, 'UDID-A'), false);
});
