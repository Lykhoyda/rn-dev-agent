import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stopBoundObserve, stopBoundRunner } from '../../../dist/session/process-cleanup.js';

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

test('Android runner cleanup proves device-side instrumentation stopped', async () => {
  const adbCalls: string[][] = [];
  await stopBoundRunner(
    {
      platform: 'android',
      deviceId: 'emulator-5554',
      port: 27183,
      pid: 900,
      processBirth: 'runner-birth',
      instanceId: 'runner-a',
      capability: 'runner-capability',
    },
    () => ({ status: 'absent' as const }),
    () => undefined,
    2_000,
    async (args) => {
      adbCalls.push(args);
      return { stdout: '', stderr: '' };
    },
  );

  assert.deepEqual(adbCalls[0], ['-s', 'emulator-5554', 'forward', '--remove', 'tcp:27183']);
  assert.equal(adbCalls.filter((args) => args.includes('force-stop')).length, 2);
  assert.equal(adbCalls.at(-1)?.includes('instrumentation'), true);
});

test('Android runner cleanup refuses release while instrumentation remains', async () => {
  await assert.rejects(
    stopBoundRunner(
      {
        platform: 'android',
        deviceId: 'emulator-5554',
        port: 27183,
        pid: 900,
        processBirth: 'runner-birth',
        instanceId: 'runner-a',
        capability: 'runner-capability',
      },
      () => ({ status: 'absent' as const }),
      () => undefined,
      2_000,
      async (args) => ({
        stdout: args.includes('instrumentation')
          ? 'dev.lykhoyda.rndevagent.androidrunner.test'
          : '',
        stderr: '',
      }),
    ),
    /device-side runner termination is unproven/,
  );
});
