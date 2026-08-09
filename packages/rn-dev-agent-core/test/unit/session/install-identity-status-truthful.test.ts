// QA F3: while every gated tool refused APP_INSTALL_IDENTITY_CHANGED,
// rn_session status kept reporting state:"ready"/installBound:true and
// cdp_status kept reporting a healthy session. Status surfaces now evaluate
// the bound install receipt and stop claiming ready when gated tools refuse.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspectInstallIdentity } from '../../../dist/session/install-identity-inspection.js';
import { projectPublicAuthorityStatus } from '../../../dist/session/public-status.js';
import { createSessionHandler } from '../../../dist/tools/session.js';
import { createPassiveStatusHandler } from '../../../dist/tools/status.js';

const BOUND_INSTALL = {
  platform: 'ios',
  deviceId: 'device',
  appId: 'dev.example',
  artifactDigest: 'attested-digest',
  installGeneration: 'generation-1',
};

function authorityStatus() {
  return {
    available: true as const,
    sessionId: 'session-a',
    sourceKey: 'source',
    worktreeKey: 'worktree',
    appRootKey: 'app',
    state: 'ready',
    claimEpoch: 4,
    authorityVersion: 9,
    leaseUntilMs: 1000,
    source: { kind: 'git' },
    bindings: { install: { ...BOUND_INSTALL } } as Record<string, unknown>,
    claims: [],
    worker: { instanceId: 'worker', pid: 1, birthAvailable: true },
  };
}

test('inspectInstallIdentity classifies the four live states', () => {
  assert.equal(inspectInstallIdentity(null), null);
  assert.equal(inspectInstallIdentity(undefined), null);

  assert.deepEqual(
    inspectInstallIdentity(BOUND_INSTALL, { captureGeneration: () => 'generation-1' }),
    { verdict: 'verified' },
  );

  assert.deepEqual(
    inspectInstallIdentity(BOUND_INSTALL, {
      captureGeneration: () => 'generation-2',
      captureInstalled: () => ({ ...BOUND_INSTALL, installGeneration: 'generation-2' }),
    }),
    { verdict: 'reissue-pending' },
  );

  assert.equal(
    inspectInstallIdentity(BOUND_INSTALL, {
      captureGeneration: () => 'generation-2',
      captureInstalled: () => ({
        ...BOUND_INSTALL,
        artifactDigest: 'foreign-digest',
        installGeneration: 'generation-2',
      }),
    })?.verdict,
    'changed',
  );

  assert.equal(
    inspectInstallIdentity(BOUND_INSTALL, {
      captureGeneration: () => {
        throw new Error('exact iOS app container was not found');
      },
    })?.verdict,
    'changed',
  );

  assert.equal(inspectInstallIdentity({ platform: 'ios' })?.verdict, 'changed');
});

test('a changed install identity stops the projection from claiming ready', () => {
  const projected = projectPublicAuthorityStatus(authorityStatus(), {
    installIdentity: { verdict: 'changed', reason: 'not the attested session build' },
  });

  assert.equal(projected.state, 'install_identity_changed');
  assert.equal(projected.installIdentity, 'changed');
  assert.equal(projected.detail, 'not the attested session build');
  assert.match(String(projected.nextAction), /no longer the attested session build/);
  assert.equal(projected.installBound, true);
});

test('verified and reissue-pending identities keep the ready projection', () => {
  const verified = projectPublicAuthorityStatus(authorityStatus(), {
    installIdentity: { verdict: 'verified' },
  });
  assert.equal(verified.state, 'ready');
  assert.equal(verified.installIdentity, 'verified');

  const pending = projectPublicAuthorityStatus(authorityStatus(), {
    installIdentity: { verdict: 'reissue-pending' },
  });
  assert.equal(pending.state, 'ready');
  assert.equal(pending.installIdentity, 'reissue-pending');

  const uninspected = projectPublicAuthorityStatus(authorityStatus());
  assert.equal(uninspected.state, 'ready');
  assert.equal('installIdentity' in uninspected, false);
});

test('rn_session status reports the changed install identity truthfully', async () => {
  const status = authorityStatus();
  const handler = createSessionHandler(
    {
      status: () => status,
      refreshRecoveryHandles: () => false,
      inspectRecoveryRequirement: () => undefined,
    } as never,
    {
      inspectInstallIdentity: () => ({
        verdict: 'changed',
        reason: 'not the attested session build',
      }),
    },
  );

  const envelope = JSON.parse((await handler({ action: 'status' })).content[0]!.text);
  assert.equal(envelope.data.authority.state, 'install_identity_changed');
  assert.equal(envelope.data.authority.installIdentity, 'changed');
  assert.ok(envelope.data.authority.nextAction);
});

test('cdp_status reports the changed install identity truthfully', async () => {
  const status = authorityStatus();
  const handler = createPassiveStatusHandler(
    () =>
      ({
        connectedTarget: null,
        metroPort: 8193,
        isConnected: true,
      }) as never,
    { status: () => status } as never,
    {
      inspectInstallIdentity: () => ({
        verdict: 'changed',
        reason: 'not the attested session build',
      }),
    },
  );

  const envelope = JSON.parse((await handler({})).content[0]!.text);
  assert.equal(envelope.data.authority.state, 'install_identity_changed');
  assert.equal(envelope.data.authority.installIdentity, 'changed');
});

test('status surfaces skip the live probe when no install is bound', async () => {
  const status = { ...authorityStatus(), bindings: {} as Record<string, unknown> };
  let probed = false;
  const handler = createSessionHandler(
    {
      status: () => status,
      refreshRecoveryHandles: () => false,
      inspectRecoveryRequirement: () => undefined,
    } as never,
    {
      inspectInstallIdentity: (install: Record<string, unknown> | null | undefined) => {
        probed = install != null;
        return inspectInstallIdentity(install, {
          captureGeneration: () => {
            probed = true;
            throw new Error('must not be reached');
          },
        });
      },
    },
  );

  const envelope = JSON.parse((await handler({ action: 'status' })).content[0]!.text);
  assert.equal(envelope.data.authority.state, 'ready');
  assert.equal(probed, false);
});
