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

test('session status exposes bounded login-prologue evidence without action parameters', () => {
  const projected = projectPublicAuthorityStatus({
    ...operationalStatus('ready'),
    bindings: {
      device: { platform: 'ios', deviceId: 'device-secret', appId: 'dev.example' },
      install: { digest: 'install-secret' },
      metro: { instanceId: 'metro-secret', port: 8193 },
      observe: { instanceId: 'observe-secret' },
      loginPrologue: {
        schemaVersion: 1,
        state: 'LOGIN_PROLOGUE_BLOCKED',
        alias: 'user-login',
        actionId: 'user-login',
        startedAt: '2026-08-21T10:00:00.000Z',
        endedAt: '2026-08-21T10:00:00.100Z',
        elapsedMs: 100,
        steps: [],
        inventory: { count: 1, actionIds: ['user-login'] },
        failure: { code: 'ENGINE_PIN_MISMATCH', detail: 'private runner detail' },
        runRecord: {
          runId: 'login-run-1',
          timestamp: '2026-08-21T10:00:00.100Z',
          durationMs: 100,
          status: 'fail',
          trigger: 'agent',
          failureDetail: 'private action output',
        },
        overrides: [{ tool: 'cdp_evaluate', usedAt: '2026-08-21T10:01:00.000Z' }],
        params: { PASSWORD: 'secret' },
      },
    },
  });

  assert.deepEqual(projected.loginPrologue, {
    role: 'ACTION_LOGIN_HELPER',
    state: 'LOGIN_PROLOGUE_BLOCKED',
    alias: 'user-login',
    actionId: 'user-login',
    startedAt: '2026-08-21T10:00:00.000Z',
    endedAt: '2026-08-21T10:00:00.100Z',
    elapsedMs: 100,
    failureCode: 'ENGINE_PIN_MISMATCH',
    runId: 'login-run-1',
    nextAction:
      'Run device_snapshot with action "open" and attachOnly true on the already-bound app, rerun cdp_login_prologue, then repeat the same attach-only open before device_press or device_fill.',
    overrideCount: 1,
    lastOverride: { tool: 'cdp_evaluate', usedAt: '2026-08-21T10:01:00.000Z' },
  });
  assert.deepEqual(projected.uiControl, {
    mutationReadiness: 'blocked',
    reason: 'The failed deterministic login replay still gates mutating UI tools.',
    nextAction:
      'Run device_snapshot with action "open" and attachOnly true on the already-bound app, rerun cdp_login_prologue, then repeat the same attach-only open before device_press or device_fill.',
  });
  assert.equal(projected.state, 'ready');
  assert.equal(projected.deviceBound, true);
  assert.equal(projected.installBound, true);
  assert.equal(projected.metroBound, true);
  assert.equal(projected.bundleBound, false);
  assert.equal(projected.runnerBound, false);
  assert.equal(JSON.stringify(projected).includes('secret'), false);
  assert.equal(JSON.stringify(projected).includes('private'), false);
});

test('session health never claims that mutating UI control is ready', () => {
  const projected = projectPublicAuthorityStatus(operationalStatus('ready'));

  assert.deepEqual(projected.uiControl, {
    mutationReadiness: 'not-proven',
    evidenceRequired:
      'Authority, device, Metro, Observe, runner, and bundle health do not prove UI control; require the requested MCP mutation result to show that it started and completed.',
  });
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

test('GH#672: an outstanding cleanup journal exposes an identifier-free resume action', () => {
  const base = blockedStatus(50_000);
  const projected = projectPublicAuthorityStatus({
    ...base,
    state: 'device_claimed',
    bindings: {
      staleDeviceCleanup: {
        platform: 'ios',
        deviceId: 'SECRET-UDID',
        runner: { port: 9200, claimKey: 'runner-secret', completedAt: null },
        recorder: { claimKey: 'recorder-secret', completedAt: null },
      },
    },
  });
  const cleanup = projected.staleDeviceCleanup as Record<string, unknown>;

  assert.equal(cleanup.platform, 'ios');
  assert.deepEqual(cleanup.obligations, ['runner', 'recorder']);
  assert.equal(cleanup.nextAction, 'rn_session({ action: "release_stale_device" })');
  const serialized = JSON.stringify(projected);
  for (const secret of ['SECRET-UDID', '9200', 'runner-secret', 'recorder-secret']) {
    assert.equal(serialized.includes(secret), false);
  }
});

function operationalStatus(state: string, bindings: Record<string, unknown> = {}) {
  return {
    available: true as const,
    sessionId: 'session-secret',
    sourceKey: 'source-secret',
    worktreeKey: 'worktree-secret',
    appRootKey: 'app-secret',
    state,
    claimEpoch: 1,
    authorityVersion: 1,
    leaseUntilMs: 100,
    source: { kind: 'git' },
    bindings,
    claims: [],
    worker: { instanceId: 'worker-secret', pid: 1, birthAvailable: true },
  };
}

// ADR §2.3 (L0): the grouped projection appears alongside every legacy field.
test('L0: phase folds pre-install operational states into selected', () => {
  for (const state of ['active', 'source_bound', 'device_claimed', 'metro_bound']) {
    assert.equal(projectPublicAuthorityStatus(operationalStatus(state)).phase, 'selected', state);
  }
});

test('L0: phase reports running for install-complete states', () => {
  for (const state of ['device_bound', 'runtime_bound', 'ready']) {
    assert.equal(projectPublicAuthorityStatus(operationalStatus(state)).phase, 'running', state);
  }
});

test('L0: a pending build projects the building phase for any operational state', () => {
  for (const state of ['device_claimed', 'ready']) {
    const projected = projectPublicAuthorityStatus(
      operationalStatus(state, { pendingBuild: { buildToken: 'build-token-secret' } }),
    );
    assert.equal(projected.phase, 'building', state);
    assert.equal(JSON.stringify(projected).includes('build-token-secret'), false);
  }
});

test('L0: closing wins over a lingering pending build', () => {
  const projected = projectPublicAuthorityStatus(
    operationalStatus('closing', { pendingBuild: { buildToken: 'build-token-secret' } }),
  );
  assert.equal(projected.phase, 'closing');
});

test('L0: non-operational states expose no phase, only their internal name in detail', () => {
  for (const state of ['blocked', 'handoff', 'handoff_cleanup', 'released', 'stale']) {
    const projected = projectPublicAuthorityStatus(operationalStatus(state));
    assert.equal('phase' in projected, false, state);
    assert.equal(projected.detail, state);
    assert.equal(projected.state, state);
  }
});

test('L0: grouped sub-objects mirror the legacy fields without replacing them', () => {
  const projected = projectPublicAuthorityStatus(
    operationalStatus('ready', {
      metroPort: 8193,
      observePort: 7333,
      device: { platform: 'ios', deviceId: 'SECRET-UDID' },
      install: { artifactDigest: 'digest-secret' },
      metro: { runtimeEvidenceAuthority: 'managed-sandbox-v1' },
      metroTerminal: { code: 'METRO_EXITED', reason: 'exit 1', phase: 'serve', observedAt: 5 },
      bundle: { targetId: 'target-secret' },
      runner: { capability: 'bearer-secret' },
      recorder: { claimKey: 'recorder-secret' },
      observe: { port: 7333, cleanupCapability: 'observe-capability-secret' },
      proof: { runId: 'proof-run-secret' },
    }),
  );

  assert.equal(projected.state, 'ready');
  assert.equal(projected.detail, 'ready');
  assert.equal(projected.phase, 'running');
  assert.equal(projected.sourceKind, 'git');
  assert.equal(projected.metroPort, 8193);
  assert.equal(projected.observePort, 7333);
  assert.equal(projected.platform, 'ios');
  assert.equal(projected.deviceBound, true);
  assert.equal(projected.installBound, true);
  assert.equal(projected.metroBound, true);
  assert.equal(projected.sandbox, 'managed-sandbox-v1');
  assert.equal(projected.bundleBound, true);
  assert.equal(projected.runnerBound, true);
  assert.equal(projected.recorderBound, true);

  assert.deepEqual(projected.session, {
    sourceKind: 'git',
    metroPort: 8193,
    observePort: 7333,
    observe: true,
  });
  assert.deepEqual(projected.target, { platform: 'ios', deviceBound: true, installBound: true });
  assert.deepEqual(projected.runtime, {
    metroBound: true,
    bundleBound: true,
    sandbox: 'managed-sandbox-v1',
    metroTerminal: { code: 'METRO_EXITED', reason: 'exit 1', phase: 'serve', observedAt: 5 },
  });
  assert.deepEqual(
    projected.metroTerminal,
    (projected.runtime as Record<string, unknown>).metroTerminal,
  );
  assert.deepEqual(projected.automation, { runnerBound: true, recorderBound: true });
  assert.equal(projected.proof, true);
});

test('L0: an unbound session projects empty groups and inactive child flags', () => {
  const projected = projectPublicAuthorityStatus(operationalStatus('active'));

  assert.equal(projected.phase, 'selected');
  assert.deepEqual(projected.session, {
    sourceKind: 'git',
    metroPort: undefined,
    observePort: undefined,
    observe: false,
  });
  assert.deepEqual(projected.target, {
    platform: undefined,
    deviceBound: false,
    installBound: false,
  });
  assert.deepEqual(projected.runtime, {
    metroBound: false,
    bundleBound: false,
    sandbox: 'unavailable',
  });
  assert.deepEqual(projected.automation, { runnerBound: false, recorderBound: false });
  assert.equal(projected.proof, false);
});

test('L0: the grouped projection redacts child capabilities and identities', () => {
  const projected = projectPublicAuthorityStatus(
    operationalStatus('ready', {
      device: { platform: 'ios', deviceId: 'SECRET-UDID' },
      install: { artifactDigest: 'digest-secret' },
      pendingBuild: { buildToken: 'build-token-secret', buildGeneration: 7, buildKind: 'debug' },
      observe: {
        port: 7333,
        cleanupCapability: 'observe-capability-secret',
        processBirth: 'observe-birth-secret',
        instanceId: 'observe-instance-secret',
      },
      recorder: {
        claimKey: 'recorder-claim-secret',
        output: '/private/recording.mp4',
        processBirth: 'recorder-birth-secret',
      },
      runner: { capability: 'bearer-secret', processBirth: 'runner-birth-secret' },
      proof: { runId: 'proof-run-secret' },
    }),
  );
  const serialized = JSON.stringify(projected);

  for (const secret of [
    'SECRET-UDID',
    'digest-secret',
    'build-token-secret',
    'observe-capability-secret',
    'observe-birth-secret',
    'observe-instance-secret',
    'recorder-claim-secret',
    '/private/recording.mp4',
    'recorder-birth-secret',
    'bearer-secret',
    'runner-birth-secret',
    'proof-run-secret',
  ]) {
    assert.equal(serialized.includes(secret), false, secret);
  }
});

// ADR §5.2 (L3): strict proof is an explicit opt-in overlay outside the four groups.
test('L3: an inactive proof overlay is projected explicitly, not merely absent', () => {
  const projected = projectPublicAuthorityStatus(operationalStatus('ready'));

  assert.deepEqual(projected.proofOverlay, { active: false });
  assert.equal(projected.proof, false);
});

test('L3: an active proof run projects the overlay outside the group sub-objects', () => {
  const projected = projectPublicAuthorityStatus(
    operationalStatus('ready', { proof: { runId: 'proof-run-secret' } }),
  );

  assert.deepEqual(projected.proofOverlay, { active: true });
  assert.equal(projected.proof, true, 'the L0 child flag remains during the window');
  for (const group of ['session', 'target', 'runtime', 'automation'] as const) {
    const sub = projected[group] as Record<string, unknown>;
    assert.equal('proof' in sub, false, group);
    assert.equal('proofOverlay' in sub, false, group);
  }
});

test('L3: the proof overlay never exposes the run identity', () => {
  const projected = projectPublicAuthorityStatus(
    operationalStatus('ready', { proof: { runId: 'proof-run-secret' } }),
  );

  assert.equal(JSON.stringify(projected).includes('proof-run-secret'), false);
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

  const recovery = projected.recovery as Record<string, unknown>;
  assert.equal(recovery.adoptionHandle, undefined);
  assert.equal(recovery.handoffRecipientHandle, undefined);
  assert.equal(recovery.adoptionHandleExpired, true);
  const serialized = JSON.stringify(projected);
  assert.equal(serialized.includes('opaque-adopt'), false);
  assert.equal(serialized.includes('opaque-target'), false);
  assert.equal(serialized.includes('prior-secret'), false);
});
