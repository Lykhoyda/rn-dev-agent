import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  inspectSessionOwner,
  inspectSessionOwnerAttestation,
  ownerRefusalDetails,
} from '../../../dist/session/process-owner.js';

const owner = { sessionId: 'session-a', pid: 101, token: 'birth-a' };
const present = (token: string) =>
  ({ status: 'present', birth: { pid: 101, source: 'linux-proc', token } }) as const;
const unknown = {
  status: 'unknown',
  cause: { pid: 101, step: 'helper', failure: 'timeout', elapsedMs: 2000 },
} as const;

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
      probeBirth: () => unknown,
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
      probeBirth: () => unknown,
    }),
    'unknown',
  );
  assert.equal(
    inspectSessionOwner(owner, {
      processState: () => 'unknown',
      probeBirth: () => unknown,
    }),
    'unknown',
  );
});

test('owner refusal details keep unavailable, mismatch, and absence distinct', () => {
  const unavailable = inspectSessionOwnerAttestation(owner, {
    processState: () => 'alive',
    probeBirth: () => unknown,
  });
  const mismatch = inspectSessionOwnerAttestation(owner, {
    processState: () => 'alive',
    probeBirth: () => present('birth-b'),
  });
  const absent = inspectSessionOwnerAttestation(owner, {
    processState: () => 'alive',
    probeBirth: () => ({ status: 'absent' }),
  });

  assert.equal(unavailable.status, 'unknown');
  assert.equal(mismatch.status, 'mismatch');
  assert.equal(absent.status, 'absent');
  if (unavailable.status !== 'match') {
    assert.deepEqual(ownerRefusalDetails(unavailable), {
      attestation: 'unavailable',
      pid: 101,
      step: 'helper',
      failure: 'timeout',
      elapsedMs: 2000,
      nextAction:
        'Process identity could not be read in time on a loaded host. Reduce host process contention, then retry the original operation; do not reopen or rebind the device.',
    });
  }
  if (mismatch.status !== 'match') {
    assert.equal(ownerRefusalDetails(mismatch).attestation, 'mismatch');
  }
  if (absent.status !== 'match') {
    assert.equal(ownerRefusalDetails(absent).attestation, 'absent');
  }
});
