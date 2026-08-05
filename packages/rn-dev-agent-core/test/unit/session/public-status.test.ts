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

test('session status can include its opaque session identity', () => {
  const projected = projectPublicAuthorityStatus(
    {
      available: true,
      sessionId: 'session-exact',
      sourceKey: 'source-secret',
      worktreeKey: 'worktree-secret',
      appRootKey: 'path-secret',
      state: 'ready',
      claimEpoch: 2,
      authorityVersion: 9,
      leaseUntilMs: 100,
      source: { kind: 'git' },
      bindings: {},
      claims: [],
      worker: { instanceId: 'worker-secret', pid: 1, birthAvailable: true },
    },
    { includeSessionId: true },
  );

  assert.equal(projected.sessionId, 'session-exact');
});

test('session status exposes the bounded managed-sandbox tier', () => {
  const base = {
    available: true as const,
    sessionId: 'session',
    sourceKey: 'source',
    worktreeKey: 'worktree',
    appRootKey: 'app',
    state: 'ready' as const,
    claimEpoch: 1,
    authorityVersion: 1,
    leaseUntilMs: 100,
    source: { kind: 'git' },
    claims: [],
    worker: { instanceId: 'worker', pid: 1, birthAvailable: true },
  };

  assert.equal(
    projectPublicAuthorityStatus({
      ...base,
      bindings: { metro: { runtimeEvidenceAuthority: 'managed-sandbox-v1' } },
    }).sandbox,
    'managed-sandbox-v1',
  );
  assert.equal(projectPublicAuthorityStatus({ ...base, bindings: {} }).sandbox, 'unavailable');
});

function blockedStatus(expiresMs: number) {
  return {
    available: true as const,
    sessionId: 'session-secret',
    sourceKey: 'source-secret',
    worktreeKey: 'worktree-secret',
    appRootKey: 'app-secret',
    state: 'blocked' as const,
    claimEpoch: 1,
    authorityVersion: 2,
    leaseUntilMs: 100,
    source: { kind: 'git' },
    bindings: {
      recoveryHandles: {
        handoffRecipient: { token: 'opaque-target', expiresMs },
        adoptStale: {
          token: 'opaque-adopt',
          expiresMs,
          priorSessionId: 'prior-secret',
        },
      },
    },
    claims: [],
    worker: { instanceId: 'worker-secret', pid: 1, birthAvailable: true },
  };
}

test('blocked public status exposes only bounded opaque recovery handles', () => {
  const projected = projectPublicAuthorityStatus(blockedStatus(5000), { now: () => 1000 });

  assert.deepEqual(projected.recovery, {
    handoffRecipientHandle: 'opaque-target',
    handoffRecipientExpiresMs: 5000,
    adoptionRequired: true,
    adoptionHandle: 'opaque-adopt',
    adoptionExpiresMs: 5000,
  });
  assert.equal(JSON.stringify(projected).includes('prior-secret'), false);
});

// GH #672: the reported deadlock — status kept advertising a five-minute handle long
// after it expired, and adopt_stale then refused the very token status had just shown.
test('GH#672: an expired adoption handle is never advertised as usable', () => {
  const projected = projectPublicAuthorityStatus(blockedStatus(5000), { now: () => 5001 });
  const recovery = projected.recovery as Record<string, unknown>;

  assert.equal(recovery.adoptionHandle, undefined);
  assert.equal(recovery.handoffRecipientHandle, undefined);
  assert.equal(recovery.adoptionRequired, true, 'the requirement itself remains visible');
  assert.equal(recovery.adoptionHandleExpired, true);
  assert.match(String(recovery.adoptionRefreshAction), /status/);
  assert.equal(JSON.stringify(projected).includes('opaque-adopt'), false);
});

test('GH#672: status distinguishes adoption, attach, and transport-restart recovery', () => {
  for (const requirement of ['adoption', 'attach', 'transport-restart'] as const) {
    const projected = projectPublicAuthorityStatus(blockedStatus(50_000), {
      now: () => 1000,
      recoveryRequirement: {
        requirement,
        priorOwner: requirement === 'adoption' ? 'stale' : 'live',
        nextAction: `do-${requirement}`,
      },
    });
    assert.deepEqual(projected.recoveryRequirement, {
      requirement,
      priorOwner: requirement === 'adoption' ? 'stale' : 'live',
      nextAction: `do-${requirement}`,
    });
  }
});

test('GH#672: an expired stale-device release offer is reported, not advertised', () => {
  const base = blockedStatus(50_000);
  const projected = projectPublicAuthorityStatus(
    {
      ...base,
      state: 'device_claimed',
      bindings: {
        staleDeviceRelease: {
          token: 'opaque-release',
          expiresMs: 5000,
          platform: 'ios',
          deviceId: 'SECRET-UDID',
          obligations: ['runner'],
        },
      },
    },
    { now: () => 5001 },
  );
  const release = projected.staleDeviceRelease as Record<string, unknown>;

  assert.equal(release.releaseHandle, undefined);
  assert.equal(release.expired, true);
  assert.deepEqual(release.obligations, ['runner']);
  const serialized = JSON.stringify(projected);
  assert.equal(serialized.includes('opaque-release'), false);
  assert.equal(serialized.includes('SECRET-UDID'), false);
});

test('handoff_cleanup public status never exposes recovery tokens or capabilities', () => {
  const projected = projectPublicAuthorityStatus({
    available: true,
    sessionId: 'session-secret',
    sourceKey: 'source-secret',
    worktreeKey: 'worktree-secret',
    appRootKey: 'app-secret',
    state: 'handoff_cleanup',
    claimEpoch: 1,
    authorityVersion: 3,
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
      handoffCleanup: { observe: { port: 7396 } },
    },
    claims: [],
    worker: { instanceId: 'worker-secret', pid: 1, birthAvailable: true },
  });

  assert.equal(projected.recovery, undefined);
  const serialized = JSON.stringify(projected);
  assert.equal(serialized.includes('opaque-adopt'), false);
  assert.equal(serialized.includes('opaque-target'), false);
  assert.equal(serialized.includes('prior-secret'), false);
});
