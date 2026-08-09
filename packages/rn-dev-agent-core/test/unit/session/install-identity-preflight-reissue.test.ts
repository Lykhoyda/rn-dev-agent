// QA F3 (PR #680 validation): a transient runner death leaves the app
// reinstalled byte-identically — same artifactDigest, rotated installGeneration.
// Every gated tool then refused APP_INSTALL_IDENTITY_CHANGED with no in-band
// repair. The gate now retries a refused axis-I preflight once behind the
// GH #705 digest proof; foreign or unattestable artifacts still refuse.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAuthorityGate } from '../../../dist/session/authority-gate.js';
import { reissueInstallBinding } from '../../../dist/session/install-reissue.js';
import { SessionAuthorityError } from '../../../dist/session/registry.js';
import { okResult } from '../../../dist/utils.js';

const BOUND_INSTALL = {
  platform: 'ios',
  deviceId: 'device',
  appId: 'dev.example',
  artifactDigest: 'attested-digest',
  installGeneration: 'generation-1',
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

function fixture(installedGeneration: string) {
  const device = { installedGeneration };
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
      authorityVersion: status.authorityVersion,
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
  // Axis I mirrors the real probe: refuse whenever the device's live install
  // generation is not the bound one.
  const probe = async ({ axis, status: probed }: { axis: string; status: typeof status }) => {
    if (axis === 'I') {
      const bound = probed.bindings.install as { installGeneration: string };
      if (device.installedGeneration !== bound.installGeneration) {
        throw new SessionAuthorityError(
          'APP_INSTALL_IDENTITY_CHANGED',
          'installed artifact identity no longer matches the session build',
        );
      }
      return { axis, identity: `I:${bound.installGeneration}` };
    }
    return { axis, identity: `${axis}-identity` };
  };
  return { device, registry, runtime, status, probe };
}

test('a byte-identical reinstall self-heals on any gated tool preflight', async () => {
  const { runtime, status, probe } = fixture('generation-2');
  const gate = createAuthorityGate(runtime, {
    probe,
    reissueInstallBinding: (install: Record<string, unknown> | undefined) =>
      reissueInstallBinding(install, {
        captureInstalled: captureReturning('attested-digest', 'generation-2'),
      }),
  });

  const wrapped = gate.wrap('device_press', async () => okResult({ pressed: true }));
  const envelope = JSON.parse((await wrapped({})).content[0].text);

  assert.equal(envelope.ok, true, envelope.error);
  assert.equal(
    (status.bindings.install as { installGeneration: string }).installGeneration,
    'generation-2',
  );
});

test('a foreign reinstall still refuses gated tools and keeps the binding', async () => {
  const { runtime, status, probe } = fixture('generation-2');
  const gate = createAuthorityGate(runtime, {
    probe,
    reissueInstallBinding: (install: Record<string, unknown> | undefined) =>
      reissueInstallBinding(install, {
        captureInstalled: captureReturning('foreign-digest', 'generation-2'),
      }),
  });

  const wrapped = gate.wrap('device_press', async () => okResult({ pressed: true }));
  const envelope = JSON.parse((await wrapped({})).content[0].text);

  assert.equal(envelope.ok, false);
  assert.equal(envelope.code, 'APP_INSTALL_IDENTITY_CHANGED');
  assert.equal(
    (status.bindings.install as { installGeneration: string }).installGeneration,
    'generation-1',
  );
});

test('an unattestable reinstall still refuses gated tools', async () => {
  const { runtime, probe } = fixture('generation-2');
  const gate = createAuthorityGate(runtime, {
    probe,
    reissueInstallBinding: (install: Record<string, unknown> | undefined) =>
      reissueInstallBinding(install, {
        captureInstalled: () => {
          throw new Error('exact iOS app container was not found');
        },
      }),
  });

  const wrapped = gate.wrap('device_press', async () => okResult({ pressed: true }));
  const envelope = JSON.parse((await wrapped({})).content[0].text);

  assert.equal(envelope.ok, false);
  assert.equal(envelope.code, 'APP_INSTALL_IDENTITY_CHANGED');
});

test('device_snapshot open — the documented recovery — heals the same way', async () => {
  const { runtime, status, probe } = fixture('generation-2');
  const gate = createAuthorityGate(runtime, {
    probe,
    reissueInstallBinding: (install: Record<string, unknown> | undefined) =>
      reissueInstallBinding(install, {
        captureInstalled: captureReturning('attested-digest', 'generation-2'),
      }),
  });

  const wrapped = gate.wrap('device_snapshot', async () => {
    // The real open handler advances authority when it binds the runner.
    status.authorityVersion += 1;
    return okResult({ opened: true });
  });
  const envelope = JSON.parse(
    (
      await wrapped({
        action: 'open',
        platform: 'ios',
        deviceId: 'device',
        appId: 'dev.example',
      })
    ).content[0].text,
  );

  assert.equal(envelope.ok, true, envelope.error);
  assert.equal(
    (status.bindings.install as { installGeneration: string }).installGeneration,
    'generation-2',
  );
});

test('device_snapshot open still requires the handler to advance authority after a heal', async () => {
  const { runtime, probe } = fixture('generation-2');
  const gate = createAuthorityGate(runtime, {
    probe,
    reissueInstallBinding: (install: Record<string, unknown> | undefined) =>
      reissueInstallBinding(install, {
        captureInstalled: captureReturning('attested-digest', 'generation-2'),
      }),
  });

  // A handler that commits nothing must not ride the heal's version bump.
  const wrapped = gate.wrap('device_snapshot', async () => okResult({ opened: true }));
  const envelope = JSON.parse(
    (
      await wrapped({
        action: 'open',
        platform: 'ios',
        deviceId: 'device',
        appId: 'dev.example',
      })
    ).content[0].text,
  );

  assert.equal(envelope.ok, false);
  assert.equal(envelope.code, 'AUTHORITY_LOST_DURING_OPERATION');
});

test('a non-I preflight refusal never attempts a re-issue', async () => {
  const { runtime, probe } = fixture('generation-1');
  let reissued = false;
  const gate = createAuthorityGate(runtime, {
    probe: async (input: { axis: string; status: Record<string, unknown> }) => {
      if (input.axis === 'M') {
        throw new SessionAuthorityError(
          'METRO_INSTANCE_CHANGED',
          'Metro process identity no longer matches the bound instance',
        );
      }
      return probe(input as never);
    },
    reissueInstallBinding: () => {
      reissued = true;
      return { ...BOUND_INSTALL, installGeneration: 'generation-2' };
    },
  });

  const wrapped = gate.wrap('device_press', async () => okResult({ pressed: true }));
  const envelope = JSON.parse((await wrapped({})).content[0].text);

  assert.equal(envelope.ok, false);
  assert.equal(envelope.code, 'METRO_INSTANCE_CHANGED');
  assert.equal(reissued, false);
});

test('a probe refusal with an unchanged install propagates the original error', async () => {
  const { runtime, probe } = fixture('generation-2');
  const gate = createAuthorityGate(runtime, {
    probe,
    // Capture says the device generation equals the binding — nothing to re-issue.
    reissueInstallBinding: (install: Record<string, unknown> | undefined) =>
      reissueInstallBinding(install, {
        captureInstalled: captureReturning('attested-digest', 'generation-1'),
      }),
  });

  const wrapped = gate.wrap('device_press', async () => okResult({ pressed: true }));
  const envelope = JSON.parse((await wrapped({})).content[0].text);

  assert.equal(envelope.ok, false);
  assert.equal(envelope.code, 'APP_INSTALL_IDENTITY_CHANGED');
});
