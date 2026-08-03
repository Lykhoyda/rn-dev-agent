import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionHandler } from '../../dist/tools/session.js';

function parse(result: { content: Array<{ text: string }> }): Record<string, any> {
  return JSON.parse(result.content[0]!.text) as Record<string, any>;
}

const authority = {
  available: true as const,
  sessionId: 'session-a',
  sourceKey: 'source',
  worktreeKey: 'worktree',
  appRootKey: 'app',
  state: 'ready',
  claimEpoch: 7,
  authorityVersion: 3,
  leaseUntilMs: 100,
  source: { kind: 'git' },
  bindings: {
    device: { platform: 'ios', deviceId: 'UDID-A', appId: 'com.example' },
  },
  claims: [],
  worker: { instanceId: 'worker', pid: 1, birthAvailable: true },
};

test('recover_automation requires confirmation and forwards exact session/device authority', async () => {
  const calls: unknown[] = [];
  const runtime = {
    status: () => authority,
    requireOperational: () => ({
      registry: {},
      session: { sessionId: 'session-a', claimEpoch: 7 },
    }),
  };
  const handler = createSessionHandler(runtime as never, {
    recoverAutomation: async (input) => {
      calls.push(input);
      return { recovered: true, invocationId: 'invocation-a' };
    },
  });
  assert.equal(parse(await handler({ action: 'recover_automation' })).ok, false);
  const recovered = parse(await handler({ action: 'recover_automation', confirmed: true }));
  assert.equal(recovered.ok, true);
  assert.deepEqual(calls, [
    {
      sessionId: 'session-a',
      claimEpoch: 7,
      platform: 'ios',
      deviceId: 'UDID-A',
    },
  ]);
});
