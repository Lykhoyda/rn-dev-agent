import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OWNED_PACKAGES,
  isProtectedPid,
} from '../../dist/runners/release-android-slot.js';

test('GH#237 OWNED_PACKAGES: exactly our two in-tree runner packages', () => {
  assert.deepEqual(OWNED_PACKAGES, [
    'dev.lykhoyda.rndevagent.androidrunner.test',
    'dev.lykhoyda.rndevagent.androidrunner',
  ]);
});

test('GH#237 isProtectedPid: true for our own pid or parent pid', () => {
  assert.equal(isProtectedPid(4242, 4242, 9), true);   // == self
  assert.equal(isProtectedPid(9, 4242, 9), true);      // == parent
  assert.equal(isProtectedPid(777, 4242, 9), false);   // unrelated
});
