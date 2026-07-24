import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspectSessionOwner } from '../../../dist/session/process-owner.js';

const owner = { sessionId: 'session-a', pid: 101, token: 'birth-a' };

test('process owner requires both a live PID and the matching birth token', () => {
  assert.equal(
    inspectSessionOwner(owner, {
      processState: () => 'alive',
      readBirth: () => ({ pid: 101, source: 'darwin-ps', token: 'birth-a' }),
    }),
    'match',
  );
  assert.equal(
    inspectSessionOwner(owner, {
      processState: () => 'alive',
      readBirth: () => ({ pid: 101, source: 'darwin-ps', token: 'birth-reused' }),
    }),
    'mismatch',
  );
});

test('proven-dead owners are reclaimable while unreadable birth stays conservative', () => {
  assert.equal(
    inspectSessionOwner(owner, {
      processState: () => 'dead',
      readBirth: () => null,
    }),
    'mismatch',
  );
  assert.equal(
    inspectSessionOwner(owner, {
      processState: () => 'alive',
      readBirth: () => null,
    }),
    'unknown',
  );
  assert.equal(
    inspectSessionOwner(owner, {
      processState: () => 'unknown',
      readBirth: () => null,
    }),
    'unknown',
  );
});
