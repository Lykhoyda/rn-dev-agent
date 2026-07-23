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

  assert.equal(projected.sessionId, 'session-secr');
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
