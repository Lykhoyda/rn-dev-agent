import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  automationStatePath,
  recoverAutomationDuty,
  selectExactDeviceAutomationPids,
  spawnManagedProcessGroup,
} from '../../dist/session/managed-automation.js';
import { writeJsonStateFileAtomic } from '../../dist/util/secure-state-file.js';

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

test('managed executor escalates a SIGTERM-resistant process group to SIGKILL', async () => {
  const script = `
    const { spawn } = require('node:child_process');
    process.on('SIGTERM', () => {});
    spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"], {stdio:'ignore'});
    setInterval(() => {}, 1000);
  `;
  const result = await spawnManagedProcessGroup(process.execPath, ['-e', script], {
    timeoutMs: 150,
    platform: 'ios',
    tool: 'fixture-resistant',
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.cleanupProven, true);
  assert.equal(result.cleanupEscalated, true);
});

test('exact-device attribution excludes unrelated-device and precondition-free lines', () => {
  const ps = [
    '101 xcodebuild test -destination id=UDID-A',
    '102 xcodebuild test -destination id=UDID-B',
    '103 WebDriverAgentRunner-Runner UDID-A',
    '104 unrelated UDID-A',
  ].join('\n');
  assert.deepEqual(selectExactDeviceAutomationPids(ps, 'UDID-A'), [101, 103]);
});

test('authenticated recovery terminates only the matching group and clears proven state', async () => {
  const prior = process.env.XDG_STATE_HOME;
  const dir = mkdtempSync(join(tmpdir(), 'rn-584-recover-'));
  process.env.XDG_STATE_HOME = dir;
  try {
    const path = automationStatePath('ios', 'UDID-A');
    writeJsonStateFileAtomic(path, {
      schemaVersion: 1,
      kind: 'maestro-process-group',
      invocationId: 'invocation-good',
      sessionId: 'session-a',
      claimEpoch: 4,
      platform: 'ios',
      deviceId: 'UDID-A',
      pid: 700,
      pgid: 700,
      processBirth: 'leader-birth',
      startedAt: new Date().toISOString(),
      tool: 'device_pick_date',
      attributedProcesses: [],
    });
    let present = true;
    const signalled: Array<NodeJS.Signals | 0> = [];
    const recovered = await recoverAutomationDuty(
      { sessionId: 'session-a', claimEpoch: 4, platform: 'ios', deviceId: 'UDID-A' },
      {
        signalGroup: (_pgid, signal) => {
          signalled.push(signal);
          if (signal === 0 && !present) {
            const error = new Error('absent') as NodeJS.ErrnoException;
            error.code = 'ESRCH';
            throw error;
          }
          if (signal === 'SIGTERM') present = false;
        },
        probeBirth: (pid) => ({
          status: 'present',
          birth: { pid, source: 'linux-proc', token: 'leader-birth' },
        }),
        sleep: async () => {},
      },
    );
    assert.equal(recovered.recovered, true);
    assert.deepEqual(signalled, [0, 'SIGTERM', 0]);
    assert.equal(existsSync(path), false);
  } finally {
    if (prior === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = prior;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recovery refuses PID-birth mismatch and leaves the authenticated duty intact', async () => {
  const prior = process.env.XDG_STATE_HOME;
  const dir = mkdtempSync(join(tmpdir(), 'rn-584-state-'));
  process.env.XDG_STATE_HOME = dir;
  try {
    const state = {
      schemaVersion: 1,
      kind: 'maestro-process-group',
      invocationId: 'invocation-a',
      sessionId: 'session-a',
      claimEpoch: 4,
      platform: 'ios',
      deviceId: 'UDID-A',
      pid: 700,
      pgid: 700,
      processBirth: 'leader-birth',
      startedAt: new Date().toISOString(),
      tool: 'device_pick_date',
      attributedProcesses: [{ pid: 701, processBirth: 'owned-birth' }],
    } as const;
    const path = automationStatePath('ios', 'UDID-A');
    writeJsonStateFileAtomic(path, state);
    await assert.rejects(
      recoverAutomationDuty(
        { sessionId: 'session-a', claimEpoch: 4, platform: 'ios', deviceId: 'UDID-A' },
        {
          signalGroup: () => {
            const error = new Error('absent') as NodeJS.ErrnoException;
            error.code = 'ESRCH';
            throw error;
          },
          probeBirth: (pid) =>
            pid === 701
              ? { status: 'present', birth: { pid, source: 'linux-proc', token: 'reused-birth' } }
              : { status: 'absent' },
        },
      ),
      /PID birth changed/,
    );
    assert.equal(existsSync(path), true);
  } finally {
    if (prior === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = prior;
    rmSync(dir, { recursive: true, force: true });
  }
});
