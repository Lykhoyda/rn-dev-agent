import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultSelfPpid } from '../../dist/lifecycle/lockfile.js';

// Live-gate finding (2026-06-11, B200): Node has NO process.getppid() — the
// API is the `process.ppid` PROPERTY. The old feature-detect fell back to 0
// at runtime, so every lock recorded ppid:0 and isLockLive's orphan check
// (livePpid !== body.ppid) reclaimed ANY live holder's lock; the parent-death
// watch never fired (0 === 0 forever). This test runs against the REAL
// process: a fallback-to-0 implementation fails it.
test('GH#264/B200 defaultSelfPpid returns the real parent pid at runtime', () => {
  assert.equal(defaultSelfPpid(), process.ppid);
  assert.ok(defaultSelfPpid() > 0, 'must not fall back to 0 on a normal process');
});
