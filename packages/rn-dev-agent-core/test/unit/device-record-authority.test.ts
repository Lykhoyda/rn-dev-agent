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
    () => ({
      status: 'present',
      birth: { pid: 321, token: 'replacement-birth', source: 'linux-proc' },
    }),
    async (_script, args) => {
      calls.push(args);
      return {
        stdout: args[0] === 'status' ? 'No active recordings\n' : 'Saved: proof.mp4 (42 bytes)\n',
        stderr: '',
      };
    },
  );

  assert.match(output, /Saved: proof\.mp4/);
  assert.deepEqual(
    calls.map((args) => args[0]),
    ['stop', 'status'],
  );
});

test('provisional recorder cleanup capability-aborts an unbound live process', async () => {
  const calls: string[][] = [];
  let statusReads = 0;
  const output = await stopBoundRecorder(
    {
      phase: 'starting',
      script: '/workspace/record_proof.sh',
      scope: 'b'.repeat(64),
    },
    () => {
      throw new Error('unbound capability cleanup must not adopt process identity');
    },
    async (_script, args) => {
      calls.push(args);
      if (args[0] === 'status') {
        statusReads += 1;
        return {
          stdout:
            statusReads === 1
              ? 'ios: pid=654 birth=unbound status=active output=proof.mp4\n'
              : 'No active recordings\n',
          stderr: '',
        };
      }
      return { stdout: '', stderr: '' };
    },
  );

  assert.equal(output, '');
  assert.deepEqual(
    calls.map((args) => args[0]),
    ['status', 'abort', 'status'],
  );
});

test('provisional recorder cleanup capability-aborts a bound starting supervisor', async () => {
  const calls: string[][] = [];
  let statusReads = 0;
  await stopBoundRecorder(
    {
      phase: 'starting',
      script: '/workspace/record_proof.sh',
      scope: 'c'.repeat(64),
    },
    () => {
      throw new Error('starting cleanup must not use process identity');
    },
    async (_script, args) => {
      calls.push(args);
      if (args[0] === 'status') {
        statusReads += 1;
        return {
          stdout:
            statusReads === 1
              ? `ios: pid=765 birth=${'a'.repeat(64)} status=recording output=proof.mp4\n`
              : 'No active recordings\n',
          stderr: '',
        };
      }
      return { stdout: '', stderr: '' };
    },
  );

  assert.deepEqual(
    calls.map((args) => args[0]),
    ['status', 'abort', 'status'],
  );
});

test('synthetic staged deadlines classify as timeouts', () => {
  assert.deepEqual(classifyExecError({ code: 'ETIMEDOUT' }), {
    timedOut: true,
    outputTruncated: false,
  });
});

test('synthetic staged deadlines remain timeouts in action failure parsing', () => {
  assert.deepEqual(
    parseMaestroFailure('prior successful stage', {
      exitClass: 'timed-out',
      failureKind: 'SELECTOR_NOT_FOUND',
      failureSelector: 'stale-selector',
    }),
    {
      kind: 'TIMEOUT',
      selector: 'stale-selector',
      raw: 'prior successful stage',
    },
  );
});

test('a long capture gets a stop budget scaled to its recorded length', async () => {
  const budgets: Array<number | undefined> = [];
  const runRecorder = async (_script: string, args: string[], timeoutMs?: number) => {
    if (args[0] === 'stop') budgets.push(timeoutMs);
    return {
      stdout: args[0] === 'status' ? 'No active recordings\n' : 'Saved: proof.mp4 (42 bytes)\n',
      stderr: '',
    };
  };
  const binding = (startedAt?: number) => ({
    script: '/workspace/record_proof.sh',
    scope: 'c'.repeat(64),
    pid: 321,
    processBirth: 'birth-token',
    ...(startedAt === undefined ? {} : { startedAt }),
  });
  const probe = () => ({
    status: 'present' as const,
    birth: { pid: 321, token: 'replacement-birth', source: 'linux-proc' as const },
  });

  await stopBoundRecorder(binding(Date.now() - 125_000), probe, runRecorder);
  await stopBoundRecorder(binding(Date.now() - 180_000), probe, runRecorder);
  await stopBoundRecorder(binding(), probe, runRecorder);
  await stopBoundRecorder(binding(Date.now() - 2 * 60 * 60_000), probe, runRecorder);
  await stopBoundRecorder(binding(Date.now() - 10 * 24 * 60 * 60_000), probe, runRecorder);

  assert.ok(budgets[0]! >= 60_000 + 3 * 125_000, `125 s capture budget was ${budgets[0]}`);
  assert.ok(budgets[0]! < 60_000 + 3 * 130_000, `125 s capture budget was ${budgets[0]}`);
  assert.ok(budgets[1]! >= 60_000 + 3 * 180_000, `180 s capture budget was ${budgets[1]}`);
  assert.equal(budgets[2], 60_000);

  for (const stale of [budgets[3]!, budgets[4]!]) {
    assert.equal(stale, 15 * 60_000);
    assert.ok(stale <= 2_147_483_647, `stale budget ${stale} would overflow setTimeout`);
  }
});
