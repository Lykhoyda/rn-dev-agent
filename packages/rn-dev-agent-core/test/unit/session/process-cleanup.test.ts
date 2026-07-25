import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stopBoundObserve } from '../../../dist/session/process-cleanup.js';

const binding = {
  port: 7333,
  pid: 456,
  processBirth: 'observe-birth',
  instanceId: 'observe-a',
  cleanupCapability: 'observe-capability',
};

const listenerProbe = () => ({ status: 'listening' as const, pid: 456 });
const processProbe = () => ({
  status: 'present' as const,
  birth: { pid: 456, token: 'observe-birth', source: 'linux-proc' as const },
});

test('Observe cleanup aborts a stop request within its deadline', async () => {
  let wasAborted = false;
  const request = (_input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener(
        'abort',
        () => {
          wasAborted = true;
          reject(new Error('aborted'));
        },
        { once: true },
      );
    });

  await assert.rejects(
    stopBoundObserve(binding, listenerProbe, processProbe, 20, request),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes('OBSERVE_AUTHORITY_MISMATCH') &&
      error.message.includes('failed or timed out'),
  );
  assert.equal(wasAborted, true);
});

test('Observe cleanup classifies stop-request network failures', async () => {
  const request = async () => {
    throw new Error('connection reset');
  };

  await assert.rejects(
    stopBoundObserve(binding, listenerProbe, processProbe, 2_000, request),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes('OBSERVE_AUTHORITY_MISMATCH') &&
      error.message.includes('failed or timed out'),
  );
});
