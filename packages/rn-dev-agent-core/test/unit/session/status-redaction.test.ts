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
