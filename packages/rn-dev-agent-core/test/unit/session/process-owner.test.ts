import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspectSessionOwner } from '../../../dist/session/process-owner.js';

const owner = { sessionId: 'session-a', pid: 101, token: 'birth-a' };
const present = (token: string) =>
  ({ status: 'present', birth: { pid: 101, source: 'linux-proc', token } }) as const;

test('process owner requires both a live PID and the matching birth token', () => {
  assert.equal(
    inspectSessionOwner(owner, {
      processState: () => 'alive',
      probeBirth: () => present('birth-a'),
    }),
    'match',
  );
  assert.equal(
    inspectSessionOwner(owner, {
      processState: () => 'alive',
      probeBirth: () => present('birth-reused'),
    }),
    'mismatch',
  );
});

test('proven-dead owners are reclaimable while unreadable birth stays conservative', () => {
  assert.equal(
    inspectSessionOwner(owner, {
      processState: () => 'dead',
      probeBirth: () => ({ status: 'unknown' }),
    }),
    'mismatch',
  );
  assert.equal(
    inspectSessionOwner(owner, {
      processState: () => 'alive',
      probeBirth: () => ({ status: 'absent' }),
    }),
    'mismatch',
  );
  assert.equal(
    inspectSessionOwner(owner, {
      processState: () => 'alive',
      probeBirth: () => ({ status: 'unknown' }),
    }),
    'unknown',
  );
  assert.equal(
    inspectSessionOwner(owner, {
      processState: () => 'unknown',
      probeBirth: () => ({ status: 'unknown' }),
    }),
    'unknown',
  );
});
