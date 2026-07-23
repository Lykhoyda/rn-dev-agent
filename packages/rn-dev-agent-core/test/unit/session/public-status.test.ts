import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectPublicAuthorityStatus } from '../../../dist/session/public-status.js';

test('public authority status excludes capabilities and literal authority identities', () => {
  const projected = projectPublicAuthorityStatus({
    available: true,
    sessionId: 'session-secret-identity',
    sourceKey: 'source-secret',
    worktreeKey: 'worktree-secret',
    appRootKey: 'path-secret',
    state: 'ready',
    claimEpoch: 2,
    authorityVersion: 9,
    leaseUntilMs: 100,
    source: { kind: 'git', appRoot: '/private/app' },
    bindings: {
      metroPort: 8193,
      device: { platform: 'ios', deviceId: 'SECRET-UDID' },
      runner: { capability: 'bearer-secret', processBirth: 'birth-secret' },
      bundle: { targetId: 'target-secret' },
    },
    claims: [{ type: 'runner', key: 'claim-secret' }],
    worker: { instanceId: 'worker-secret', pid: 1, birthAvailable: true },
  });
  const serialized = JSON.stringify(projected);

  assert.equal('sessionId' in projected, false);
  assert.equal('claimEpoch' in projected, false);
  assert.equal('authorityVersion' in projected, false);
  for (const secret of [
    'bearer-secret',
    'birth-secret',
    'claim-secret',
    'SECRET-UDID',
    'target-secret',
    '/private/app',
    'worker-secret',
  ]) {
    assert.equal(serialized.includes(secret), false);
  }
});

test('blocked public status exposes only bounded opaque recovery handles', () => {
  const projected = projectPublicAuthorityStatus({
    available: true,
    sessionId: 'session-secret',
    sourceKey: 'source-secret',
    worktreeKey: 'worktree-secret',
    appRootKey: 'app-secret',
    state: 'blocked',
    claimEpoch: 1,
    authorityVersion: 2,
    leaseUntilMs: 100,
    source: { kind: 'git' },
    bindings: {
      recoveryHandles: {
        handoffRecipient: { token: 'opaque-target', expiresMs: 5000 },
        adoptStale: {
          token: 'opaque-adopt',
          expiresMs: 5000,
          priorSessionId: 'prior-secret',
        },
      },
    },
    claims: [],
    worker: { instanceId: 'worker-secret', pid: 1, birthAvailable: true },
  });

  assert.deepEqual(projected.recovery, {
    handoffRecipientHandle: 'opaque-target',
    handoffRecipientExpiresMs: 5000,
    adoptionRequired: true,
    adoptionHandle: 'opaque-adopt',
    adoptionExpiresMs: 5000,
  });
  assert.equal(JSON.stringify(projected).includes('prior-secret'), false);
});
