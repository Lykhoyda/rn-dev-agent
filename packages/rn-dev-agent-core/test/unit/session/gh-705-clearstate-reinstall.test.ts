// GH #705: a `launchApp: clearState: true` flow makes Maestro reinstall the
// app, which rotates every inode/mtime and so rotates the installGeneration
// axis I pins. Re-issuing the receipt is allowed ONLY for the session's own
// attested artifact — proven by the artifactDigest, which hashes file bytes.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAuthorityGate } from '../../../dist/session/authority-gate.js';
import { reissueInstallBinding } from '../../../dist/session/install-reissue.js';
import { okResult } from '../../../dist/utils.js';

const BOUND_INSTALL = {
  platform: 'ios',
  deviceId: 'device',
  appId: 'dev.example',
  artifactDigest: 'attested-digest',
  installGeneration: 'generation-1',
  buildGeneration: 3,
};

function captureReturning(artifactDigest: string, installGeneration: string) {
  return () => ({
    platform: 'ios' as const,
    deviceId: 'device',
    appId: 'dev.example',
    artifactDigest,
    installGeneration,
  });
}

test('GH#705 the session artifact re-issues the receipt with the new generation', () => {
  const reissued = reissueInstallBinding(BOUND_INSTALL, {
    captureInstalled: captureReturning('attested-digest', 'generation-2'),
  });
  assert.deepEqual(reissued, { ...BOUND_INSTALL, installGeneration: 'generation-2' });
});

test('GH#705 a foreign artifact is refused, never re-issued', () => {
  assert.throws(
    () =>
      reissueInstallBinding(BOUND_INSTALL, {
        captureInstalled: captureReturning('foreign-digest', 'generation-2'),
      }),
    /APP_INSTALL_IDENTITY_CHANGED/,
  );
});

test('GH#705 an unchanged install re-issues nothing', () => {
  assert.equal(
    reissueInstallBinding(BOUND_INSTALL, {
      captureInstalled: captureReturning('attested-digest', 'generation-1'),
    }),
    null,
  );
});

test('GH#705 an unattestable install is refused', () => {
  assert.throws(
    () =>
      reissueInstallBinding(BOUND_INSTALL, {
        captureInstalled: () => {
          throw new Error('exact iOS app container was not found');
        },
      }),
    /APP_INSTALL_IDENTITY_CHANGED/,
  );
  assert.throws(
    () => reissueInstallBinding({ platform: 'ios', deviceId: 'device' }, {}),
    /APP_INSTALL_IDENTITY_CHANGED/,
  );
});

function gateFixture() {
  const status = {
    available: true,
    sessionId: 'session-a',
    sourceKey: 'source',
    worktreeKey: 'worktree',
    appRootKey: 'app',
    state: 'ready',
    claimEpoch: 4,
    authorityVersion: 9,
    leaseUntilMs: 1000,
    source: { kind: 'git', appRoot: process.cwd() },
    bindings: {
      install: { ...BOUND_INSTALL },
      metro: { instanceId: 'metro', port: 8193 },
      bundle: null,
      device: { platform: 'ios', deviceId: 'device', appId: 'dev.example' },
      runner: { instanceId: 'runner' },
      observe: null,
      proof: null,
    } as Record<string, unknown>,
    claims: [],
    worker: { instanceId: 'worker', pid: 1, birthAvailable: true },
  };
  const registry = {
    beginOperation: (_session: unknown, input: { operationId: string }) => ({
      operationId: input.operationId,
      sessionId: 'session-a',
      claimEpoch: 4,
      authorityVersion: 9,
    }),
    getClaim: () => null,
    verifyOperation: () => {},
    operationHasAxis: () => true,
    runWithOperation: async (_operation: unknown, callback: () => unknown) => callback(),
    commitPlatformAuthorityReceipts: () => {},
    endOperation: () => {},
    cancelOperation: () => {},
    refreshOperation: (operation: { authorityVersion: number }) => ({
      ...operation,
      authorityVersion: status.authorityVersion,
    }),
    replaceBindingsDuringOperation: (
      operation: { authorityVersion: number },
      input: { bindings: Record<string, unknown> },
    ) => {
      status.bindings = { ...status.bindings, ...input.bindings };
      status.authorityVersion += 1;
      return { ...operation, authorityVersion: operation.authorityVersion + 1 };
    },
  };
  const runtime = {
    requireAvailable: () => ({ registry, session: { sessionId: 'session-a', claimEpoch: 4 } }),
    status: () => status,
  };
  // Axis I's identity is derived from the bound receipt, exactly as the real
  // probe does — so a re-issued binding MUST move the postflight identity.
  const probe = async ({ axis, status: probed }: { axis: string; status: typeof status }) => ({
    axis,
    identity:
      axis === 'I'
        ? `I:${(probed.bindings.install as { installGeneration: string }).installGeneration}`
        : `${axis}-identity`,
  });
  return { registry, runtime, status, probe };
}

test('GH#705 maestro_run keeps axis I after re-issuing its own reinstall', async () => {
  const { runtime, status, probe } = gateFixture();
  const gate = createAuthorityGate(runtime, {
    probe,
    reissueInstallBinding: (install: Record<string, unknown> | undefined) =>
      reissueInstallBinding(install, {
        captureInstalled: captureReturning('attested-digest', 'generation-2'),
      }),
  });

  const wrapped = gate.wrap('maestro_run', async (args: Record<string, unknown>) => {
    const { reissueManagedInstallAuthority } =
      await import('../../../dist/session/authority-gate.js');
    await reissueManagedInstallAuthority(args);
    return okResult({ passed: true });
  });

  const envelope = JSON.parse((await wrapped({})).content[0].text);
  assert.equal(envelope.ok, true, envelope.error);
  assert.equal(
    (status.bindings.install as { installGeneration: string }).installGeneration,
    'generation-2',
  );
});

test('GH#705 a foreign reinstall still refuses maestro_run with axis I', async () => {
  const { runtime, status, probe } = gateFixture();
  const gate = createAuthorityGate(runtime, {
    probe,
    reissueInstallBinding: (install: Record<string, unknown> | undefined) =>
      reissueInstallBinding(install, {
        captureInstalled: captureReturning('foreign-digest', 'generation-2'),
      }),
  });

  const wrapped = gate.wrap('maestro_run', async (args: Record<string, unknown>) => {
    const { reissueManagedInstallAuthority } =
      await import('../../../dist/session/authority-gate.js');
    await reissueManagedInstallAuthority(args);
    return okResult({ passed: true });
  });

  const envelope = JSON.parse((await wrapped({})).content[0].text);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.code, 'APP_INSTALL_IDENTITY_CHANGED');
  assert.equal(
    (status.bindings.install as { installGeneration: string }).installGeneration,
    'generation-1',
  );
});

test('GH#705 axis I moving without a re-issue is still lost authority', async () => {
  const { runtime, status, probe } = gateFixture();
  const gate = createAuthorityGate(runtime, { probe });

  const wrapped = gate.wrap('maestro_run', async () => {
    // An out-of-band reinstall: nothing proved the artifact, nothing re-issued.
    (status.bindings.install as { installGeneration: string }).installGeneration = 'generation-9';
    return okResult({ passed: true });
  });

  const envelope = JSON.parse((await wrapped({})).content[0].text);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.code, 'AUTHORITY_LOST_DURING_OPERATION');
});

test('GH#705 tools without the re-issue profile cannot reach the capability', async () => {
  const { runtime, probe } = gateFixture();
  let reissued = false;
  const gate = createAuthorityGate(runtime, {
    probe,
    reissueInstallBinding: () => {
      reissued = true;
      return { ...BOUND_INSTALL, installGeneration: 'generation-2' };
    },
  });

  const wrapped = gate.wrap('device_press', async (args: Record<string, unknown>) => {
    const { hasManagedInstallReissueAuthority, reissueManagedInstallAuthority } =
      await import('../../../dist/session/authority-gate.js');
    assert.equal(hasManagedInstallReissueAuthority(args), false);
    await reissueManagedInstallAuthority(args);
    return okResult({ pressed: true });
  });

  const envelope = JSON.parse((await wrapped({})).content[0].text);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.code, 'APP_INSTALL_IDENTITY_CHANGED');
  assert.equal(reissued, false);
});
