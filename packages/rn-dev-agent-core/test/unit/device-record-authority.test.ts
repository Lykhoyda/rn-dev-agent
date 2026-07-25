import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyExecError } from '../../dist/domain/maestro-step-parser.js';
import { parseMaestroFailure } from '../../dist/domain/maestro-error-parser.js';
import { stopBoundRecorder } from '../../dist/session/process-cleanup.js';
import { bindRecorderSession } from '../../dist/tools/device-record.js';

test('nested recorder calls inherit the active session and exact device', () => {
  const args = { action: 'status' as const };
  const registry = {};
  const session = { sessionId: 'session-a', claimEpoch: 7 };
  const runtime = {
    requireAvailable: () => ({ registry, session }),
    status: () => ({
      available: true,
      sessionId: 'session-a',
      claimEpoch: 7,
      bindings: { device: { platform: 'ios', deviceId: 'device-a' } },
    }),
  };

  bindRecorderSession(runtime as never, args);

  assert.deepEqual(args, {
    action: 'status',
    platform: 'ios',
    deviceId: 'device-a',
    sessionId: 'session-a',
    claimEpoch: 7,
  });
});

test('an exited recorder remains safely finalizable', async () => {
  const calls: string[][] = [];
  const output = await stopBoundRecorder(
    {
      script: '/workspace/record_proof.sh',
      scope: 'a'.repeat(64),
      pid: 321,
      processBirth: 'birth-token',
    },
    () => ({ status: 'absent' }),
    async (_script, args) => {
      calls.push(args);
      return {
        stdout: args[0] === 'status' ? 'No active recordings\n' : 'Saved: proof.mp4 (42 bytes)\n',
        stderr: '',
      };
    },
  );

  assert.match(output, /Saved: proof\.mp4/);
  assert.deepEqual(calls.map((args) => args[0]), ['stop', 'status']);
});

test('provisional recorder cleanup refuses a live process without bound birth identity', async () => {
  const calls: string[][] = [];
  await assert.rejects(
    stopBoundRecorder(
      {
        phase: 'starting',
        script: '/workspace/record_proof.sh',
        scope: 'b'.repeat(64),
      },
      () => ({
        status: 'present',
        birth: { pid: 654, source: 'darwin-libproc', token: 'exact-birth' },
      }),
      async (_script, args) => {
        calls.push(args);
        return {
          stdout: 'ios: pid=654 birth=unbound status=active output=proof.mp4\n',
          stderr: '',
        };
      },
    ),
    /process identity was never bound/,
  );

  assert.deepEqual(calls, [['status', 'b'.repeat(64)]]);
});

test('synthetic staged deadlines classify as timeouts', () => {
  assert.deepEqual(classifyExecError({ code: 'ETIMEDOUT' }), {
    timedOut: true,
    outputTruncated: false,
  });
});

test('synthetic staged deadlines remain timeouts in action failure parsing', () => {
  assert.deepEqual(parseMaestroFailure('prior successful stage', { exitClass: 'timed-out' }), {
    kind: 'TIMEOUT',
    selector: null,
    raw: 'prior successful stage',
  });
});
