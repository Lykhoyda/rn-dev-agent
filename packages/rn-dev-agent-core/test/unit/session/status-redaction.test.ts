import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPassiveStatusHandler } from '../../../dist/tools/status.js';

test('cdp_status projects authority and omits exact target identifiers', async () => {
  const handler = createPassiveStatusHandler(
    () =>
      ({
        isConnected: true,
        metroPort: 8193,
        connectedTarget: {
          id: 'target-secret',
          title: 'device-secret',
          platform: 'ios',
          bundleId: 'app-secret',
        },
      }) as never,
    {
      status: () => ({
        available: true,
        sessionId: 'session-secret',
        sourceKey: 'source-secret',
        worktreeKey: 'worktree-secret',
        appRootKey: 'app-root-secret',
        state: 'ready',
        claimEpoch: 2,
        authorityVersion: 9,
        leaseUntilMs: 100,
        source: { kind: 'git', appRoot: '/private/source' },
        bindings: {
          metroPort: 8193,
          runner: { capability: 'bearer-secret', processBirth: 'birth-secret' },
          device: { platform: 'ios', deviceId: 'device-id-secret' },
        },
        claims: [{ type: 'runner', key: 'claim-secret' }],
        worker: { instanceId: 'worker-secret', pid: 1, birthAvailable: true },
      }),
    } as never,
  );

  const result = await handler({});
  const serialized = result.content[0]?.text ?? '';
  for (const secret of [
    'session-secret',
    'target-secret',
    'device-secret',
    'app-secret',
    'bearer-secret',
    'birth-secret',
    'device-id-secret',
    'claim-secret',
    'worker-secret',
    '/private/source',
  ]) {
    assert.equal(serialized.includes(secret), false);
  }
});

test('cdp_status never projects lost managed Metro authority', async () => {
  const status = {
    sessionId: 'session-a',
    sourceKey: 'source',
    worktreeKey: 'worktree',
    appRootKey: 'app',
    state: 'ready',
    claimEpoch: 1,
    authorityVersion: 3,
    leaseUntilMs: 100,
    source: { kind: 'git' },
    bindings: {
      metroPort: 8341,
      metro: { mode: 'managed', port: 8341, instanceId: 'metro-a' },
    } as Record<string, unknown>,
    claims: [],
    worker: { instanceId: 'worker', pid: 1, birthAvailable: true },
  };
  const runtime = {
    status: () => ({ available: true, ...status }),
    requireAvailable: () => ({
      registry: {
        updateBindings: (_session: unknown, update: { bindings: Record<string, unknown> }) => {
          status.authorityVersion += 1;
          status.bindings = { ...status.bindings, ...update.bindings };
        },
      },
      session: { sessionId: 'session-a', claimEpoch: 1 },
    }),
  };
  const handler = createPassiveStatusHandler(
    () =>
      ({
        isConnected: false,
        metroPort: 8341,
        connectedTarget: null,
      }) as never,
    runtime as never,
    {
      getSignerCapability: () => 'signer',
      inspectManagedMetroLifecycle: () => ({
        status: 'lost',
        code: 'METRO_EVIDENCE_SOCKET_MISSING',
        reason: 'managed Metro runtime evidence socket is missing',
      }),
      now: () => 4567,
    },
  );

  const result = await handler({});
  const envelope = JSON.parse(result.content[0]!.text);

  assert.equal(envelope.data.authority.metroBound, false);
  assert.deepEqual(envelope.data.authority.metroTerminal, {
    code: 'METRO_EVIDENCE_SOCKET_MISSING',
    reason: 'managed Metro runtime evidence socket is missing',
    phase: 'before-bind',
    observedAt: 4567,
  });
});
