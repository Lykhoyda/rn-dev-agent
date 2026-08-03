import assert from 'node:assert/strict';
import { spawn as spawnChild, type ChildProcess } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { spawnManagedProcessGroup } from '../../dist/session/managed-automation.js';

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForFile(path: string): Promise<number> {
  const deadline = Date.now() + 2_000;
  while (!existsSync(path) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return Number(readFileSync(path, 'utf8'));
}

async function waitForChildClose(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null) return;
  await once(child, 'close');
}

test('managed executor removes process-group descendants after timeout', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rn-584-group-'));
  const pidFile = join(dir, 'child.pid');
  try {
    const script = `
      const { spawn } = require('node:child_process');
      const fs = require('node:fs');
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:'ignore'});
      fs.writeFileSync(process.argv[1], String(child.pid));
      setInterval(() => {}, 1000);
    `;
    const pending = spawnManagedProcessGroup(process.execPath, ['-e', script, pidFile], {
      timeoutMs: 150,
      platform: 'ios',
      tool: 'fixture',
    });
    const childPid = await waitForFile(pidFile);
    const result = await pending;
    assert.equal(result.timedOut, true);
    assert.equal(result.cleanupProven, true);
    assert.equal(alive(childPid), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('managed executor escalates a resistant process group to SIGKILL', async () => {
  let child: ChildProcess | null = null;
  let killed = false;
  const result = await spawnManagedProcessGroup(
    process.execPath,
    ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
    { timeoutMs: 100, platform: 'ios', tool: 'resistant' },
    {
      spawn: ((bin, args, options) => {
        child = spawnChild(bin, args, options);
        return child;
      }) as typeof spawnChild,
      signalGroup: (_pgid, signal) => {
        if (signal === 'SIGKILL') {
          child?.kill(signal);
          killed = true;
        } else if (signal === 0 && killed) {
          const error = new Error('absent') as NodeJS.ErrnoException;
          error.code = 'ESRCH';
          throw error;
        }
      },
    },
  );
  await waitForChildClose(child);
  assert.equal(result.cleanupProven, true);
  assert.equal(result.cleanupEscalated, true);
});

test('spawn-before-PID failure returns its own error', async () => {
  const child = Object.assign(new EventEmitter(), {
    pid: undefined,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  const pending = spawnManagedProcessGroup(
    'missing-maestro',
    [],
    { timeoutMs: 1_000, platform: 'ios', deviceId: 'UDID-SPAWN', tool: 'spawn-failure' },
    { spawn: (() => child) as typeof spawnChild },
  );
  setImmediate(() => child.emit('error', new Error('spawn ENOENT')));
  const result = await pending;
  assert.equal(result.error, 'spawn ENOENT');
  assert.equal(result.cleanupProven, true);
  assert.equal(result.cleanupRefusal, undefined);
});

test('unproven cleanup returns manual guidance and refuses the same bridge device', async () => {
  let spawnCalls = 0;
  const child = Object.assign(new EventEmitter(), {
    pid: 4242,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  const spawn = (() => {
    spawnCalls += 1;
    return child;
  }) as typeof spawnChild;
  const signalGroup = (_pgid: number, signal: NodeJS.Signals | 0) => {
    if (signal === 'SIGKILL') return;
    if (signal === 0 && spawnCalls > 0) {
      const error = new Error('unknown') as NodeJS.ErrnoException;
      error.code = 'EPERM';
      throw error;
    }
  };
  const first = spawnManagedProcessGroup(
    'maestro',
    [],
    { timeoutMs: 1_000, platform: 'ios', deviceId: 'UDID-FENCED', tool: 'first' },
    { spawn, signalGroup },
  );
  setImmediate(() => child.emit('close', 1, null));
  const unproven = await first;
  assert.equal(unproven.cleanupProven, false);
  assert.deepEqual(unproven.cleanupRefusal, {
    processGroup: 'owned-process-group',
    manualCommand: 'kill -TERM -4242',
  });

  const refused = await spawnManagedProcessGroup(
    'maestro',
    [],
    { timeoutMs: 1_000, platform: 'ios', deviceId: 'UDID-FENCED', tool: 'second' },
    { spawn, signalGroup },
  );
  assert.equal(refused.cleanupProven, false);
  assert.equal(refused.cleanupRefusal?.manualCommand, 'kill -TERM -4242');
  assert.equal(spawnCalls, 1);
});
