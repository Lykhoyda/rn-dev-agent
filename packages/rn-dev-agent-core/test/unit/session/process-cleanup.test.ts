import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  runRecordProofScript,
  stopBoundObserve,
  stopBoundRunner,
} from '../../../dist/session/process-cleanup.js';

const binding = {
  port: 7333,
  pid: 456,
  processBirth: 'observe-birth',
  instanceId: 'observe-a',
  cleanupCapability: 'observe-capability',
};
const cleanupSource = readFileSync(
  new URL('../../../src/session/process-cleanup.ts', import.meta.url),
  'utf8',
);

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

test('Darwin recorder scripts receive the pinned live-process requirement', async () => {
  let observedOptions;
  const result = await runRecordProofScript('record_proof.sh', ['status', 'scope'], 1_000, {
    platform: 'darwin',
    withHelper: async (callback) =>
      callback({
        path: '/trusted/darwin-process-birth',
        requirement: 'cdhash H"trusted"',
      }),
    execute: async (_script, _args, options) => {
      observedOptions = options;
      return { stdout: 'ok', stderr: '' };
    },
  });

  assert.deepEqual(result, { stdout: 'ok', stderr: '' });
  assert.equal(
    observedOptions.env.RN_DEV_AGENT_PROCESS_BIRTH_HELPER,
    '/trusted/darwin-process-birth',
  );
  assert.equal(observedOptions.env.RN_DEV_AGENT_PROCESS_BIRTH_REQUIREMENT, 'cdhash H"trusted"');
});

test('recorder timeout waits for confirmed descendant termination after escalation', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'record-proof-timeout-'));
  const descendantPath = join(directory, 'descendant.pid');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const descendantCode = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1_000);";
  const parentCode = `
    const { spawn } = require('node:child_process');
    const { writeFileSync } = require('node:fs');
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendantCode)}], {
      stdio: 'ignore',
    });
    writeFileSync(${JSON.stringify(descendantPath)}, String(child.pid));
    process.on('SIGTERM', () => process.exit(0));
    setInterval(() => {}, 1_000);
  `;
  const startedAt = Date.now();
  await assert.rejects(
    runRecordProofScript(process.execPath, ['-e', parentCode], 500, { platform: 'linux' }),
    /timed out after 500ms/,
  );

  assert.ok(Date.now() - startedAt >= 700);
  const descendantPid = Number(readFileSync(descendantPath, 'utf8'));
  assert.throws(
    () => process.kill(descendantPid, 0),
    (error: unknown) => (error as NodeJS.ErrnoException).code === 'ESRCH',
  );
});

test('recorder timeout bounds post-kill process-group confirmation', () => {
  assert.match(cleanupSource, /RECORDER_POST_KILL_CONFIRM_MS = 2_000/);
  assert.match(
    cleanupSource,
    /groupExitDeadline !== undefined[\s\S]*?process-group termination is unconfirmed/,
  );
});
