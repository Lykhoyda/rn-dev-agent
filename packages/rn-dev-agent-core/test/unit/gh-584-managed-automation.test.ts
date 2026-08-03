import assert from 'node:assert/strict';
import {
  spawn as spawnChild,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import {
  automationStatePath,
  inspectAutomationDuty,
  readPersistedAutomationState,
  recoverAutomationDuty,
  selectExactDeviceAutomationPids,
  spawnManagedProcessGroup,
  type AutomationDuty,
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

async function waitForChildClose(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null) return;
  if (child.signalCode !== null && child.stdout?.closed && child.stderr?.closed) return;
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

test('managed executor escalates a SIGTERM-resistant process group to SIGKILL', async () => {
  const script = `
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1000);
  `;
  let resistantChild: ChildProcess | null = null;
  let killed = false;
  const result = await spawnManagedProcessGroup(
    process.execPath,
    ['-e', script],
    {
      timeoutMs: 150,
      platform: 'ios',
      tool: 'fixture-resistant',
    },
    {
      spawn: ((bin, args, options) => {
        resistantChild = spawnChild(bin, args, options);
        return resistantChild;
      }) as typeof spawnChild,
      signalGroup: (_pgid, signal) => {
        if (signal === 'SIGKILL') {
          resistantChild?.kill(signal);
          killed = true;
          return;
        }
        if (signal === 0 && killed) {
          const error = new Error('absent') as NodeJS.ErrnoException;
          error.code = 'ESRCH';
          throw error;
        }
      },
    },
  );
  await waitForChildClose(resistantChild);
  assert.equal(result.timedOut, true);
  assert.equal(result.cleanupProven, true);
  assert.equal(result.cleanupEscalated, true);
});

test('managed executor terminates the process group when ownership state cannot persist', async () => {
  let managedPid = 0;
  let managedChild: ChildProcess | null = null;
  let terminated = false;
  const result = await spawnManagedProcessGroup(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1000)'],
    {
      timeoutMs: 10_000,
      platform: 'ios',
      deviceId: 'UDID-A',
      tool: 'fixture-state-failure',
      env: {
        ...process.env,
        RN_DEV_AGENT_SESSION_ID: 'session-a',
        RN_DEV_AGENT_CLAIM_EPOCH: '4',
      },
    },
    {
      spawn: ((bin, args, options) => {
        managedChild = spawnChild(bin, args, options);
        return managedChild;
      }) as typeof spawnChild,
      readBirth: (pid) => {
        managedPid = pid;
        return { pid, source: 'linux-proc', token: 'leader-birth' };
      },
      writeState: () => {
        throw new Error('state volume is read-only');
      },
      signalGroup: (_pgid, signal) => {
        if (signal === 'SIGTERM') {
          managedChild?.kill('SIGKILL');
          terminated = true;
        }
        if (signal === 0 && terminated) {
          const error = new Error('absent') as NodeJS.ErrnoException;
          error.code = 'ESRCH';
          throw error;
        }
      },
    },
  );
  await waitForChildClose(managedChild);
  assert.match(result.error ?? '', /Failed to persist managed automation state/);
  assert.equal(result.cleanupProven, true);
  assert.equal(alive(managedPid), false);
});

test('failed state persistence retains an authenticated fence until recovery', async () => {
  const prior = process.env.XDG_STATE_HOME;
  const dir = mkdtempSync(join(tmpdir(), 'rn-584-memory-fence-'));
  process.env.XDG_STATE_HOME = dir;
  let cleanupUnknown = false;
  const durable = { duty: null as AutomationDuty | null };
  const authorityStore = {
    read: () => durable.duty,
    write: (duty: AutomationDuty | null) => {
      durable.duty = duty;
    },
  };
  const managedChild = Object.assign(new EventEmitter(), {
    pid: 700,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: () => true,
  }) as unknown as ChildProcessWithoutNullStreams;
  try {
    const result = await spawnManagedProcessGroup(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      {
        timeoutMs: 10_000,
        platform: 'ios',
        deviceId: 'UDID-FENCED',
        tool: 'fixture-unproven-state-failure',
        env: {
          ...process.env,
          RN_DEV_AGENT_SESSION_ID: 'session-fenced',
          RN_DEV_AGENT_CLAIM_EPOCH: '7',
        },
      },
      {
        spawn: (() => managedChild) as typeof spawnChild,
        readBirth: (pid) => ({ pid, source: 'linux-proc', token: 'fenced-birth' }),
        writeState: () => {
          throw new Error('state volume is read-only');
        },
        signalGroup: (_pgid, signal) => {
          if (signal === 'SIGKILL') cleanupUnknown = true;
          if (signal === 0 && cleanupUnknown) {
            const error = new Error('unknown') as NodeJS.ErrnoException;
            error.code = 'EPERM';
            throw error;
          }
        },
        sleep: async () => {},
        authorityStore,
      },
    );
    assert.equal(result.cleanupProven, false);
    assert.equal(durable.duty?.kind, 'maestro-process-group');
    const duty = inspectAutomationDuty('ios', 'UDID-FENCED', {
      signalGroup: () => {},
      authorityStore,
    });
    assert.equal(duty?.kind, 'maestro-process-group');
    if (duty?.kind !== 'maestro-process-group') assert.fail('expected recoverable duty');
    assert.equal(duty?.processBirth, 'fenced-birth');
    assert.equal(duty?.pid, managedChild?.pid);

    let present = true;
    const recovered = await recoverAutomationDuty(
      {
        sessionId: 'session-fenced',
        claimEpoch: 7,
        platform: 'ios',
        deviceId: 'UDID-FENCED',
      },
      {
        signalGroup: (_pgid, signal) => {
          if (signal === 0 && !present) {
            const error = new Error('absent') as NodeJS.ErrnoException;
            error.code = 'ESRCH';
            throw error;
          }
          if (signal === 'SIGTERM') {
            present = false;
          }
        },
        probeBirth: (pid) => ({
          status: 'present',
          birth: { pid, source: 'linux-proc', token: 'fenced-birth' },
        }),
        sleep: async () => {},
        authorityStore,
      },
    );
    assert.equal(recovered.recovered, true);
    assert.equal(durable.duty, null);
    assert.equal(inspectAutomationDuty('ios', 'UDID-FENCED', { authorityStore }), null);
  } finally {
    if (prior === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = prior;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('missing process birth retains a durable refusal-only duty when cleanup is unproven', async () => {
  const durable = { duty: null as AutomationDuty | null };
  const authorityStore = {
    read: () => durable.duty,
    write: (duty: AutomationDuty | null) => {
      durable.duty = duty;
    },
  };
  const child = Object.assign(new EventEmitter(), {
    pid: 702,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: () => true,
  }) as unknown as ChildProcessWithoutNullStreams;
  let killing = false;
  const result = await spawnManagedProcessGroup(
    'maestro',
    [],
    {
      timeoutMs: 10_000,
      platform: 'ios',
      deviceId: 'UDID-NO-BIRTH',
      tool: 'fixture-no-birth',
      env: {
        ...process.env,
        RN_DEV_AGENT_SESSION_ID: 'session-no-birth',
        RN_DEV_AGENT_CLAIM_EPOCH: '8',
      },
    },
    {
      spawn: (() => child) as typeof spawnChild,
      readBirth: () => null,
      authorityStore,
      signalGroup: (_pgid, signal) => {
        if (signal === 'SIGKILL') killing = true;
        if (signal === 0 && killing) {
          const error = new Error('unknown') as NodeJS.ErrnoException;
          error.code = 'EPERM';
          throw error;
        }
      },
      sleep: async () => {},
    },
  );
  assert.equal(result.cleanupProven, false);
  assert.equal(durable.duty?.kind, 'maestro-cleanup-refusal');
  await assert.rejects(
    recoverAutomationDuty(
      {
        sessionId: 'session-no-birth',
        claimEpoch: 8,
        platform: 'ios',
        deviceId: 'UDID-NO-BIRTH',
      },
      { authorityStore },
    ),
    /without PID-birth recovery authority/,
  );
});

test('asynchronous spawn errors are observed before PID validation', async () => {
  const result = await spawnManagedProcessGroup('/definitely/missing/rn-maestro', [], {
    timeoutMs: 1_000,
    platform: 'ios',
    tool: 'fixture-spawn-error',
  });
  assert.equal(result.cleanupProven, true);
  assert.match(result.error ?? '', /ENOENT/);
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

test('residual attribution reaches the state file when the authority update fails', async () => {
  const prior = process.env.XDG_STATE_HOME;
  const dir = mkdtempSync(join(tmpdir(), 'rn-584-residual-persistence-'));
  process.env.XDG_STATE_HOME = dir;
  const child = Object.assign(new EventEmitter(), {
    pid: 730,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: () => true,
  }) as unknown as ChildProcessWithoutNullStreams;
  let authorityWrites = 0;
  let processScans = 0;
  try {
    const pending = spawnManagedProcessGroup(
      'maestro',
      [],
      {
        timeoutMs: 10_000,
        platform: 'ios',
        deviceId: 'UDID-RESIDUAL',
        tool: 'fixture-residual-persistence',
        env: {
          ...process.env,
          RN_DEV_AGENT_SESSION_ID: 'session-residual',
          RN_DEV_AGENT_CLAIM_EPOCH: '11',
        },
      },
      {
        spawn: (() => child) as typeof spawnChild,
        readBirth: (pid) => ({ pid, source: 'linux-proc', token: 'leader-birth' }),
        probeBirth: (pid) => ({
          status: 'present',
          birth: { pid, source: 'linux-proc', token: 'escaped-birth' },
        }),
        listProcesses: () => {
          processScans += 1;
          return processScans === 1 ? '' : '731 xcodebuild test -destination id=UDID-RESIDUAL';
        },
        authorityStore: {
          read: () => null,
          write: () => {
            authorityWrites += 1;
            if (authorityWrites === 3) throw new Error('registry unavailable');
          },
        },
        signalGroup: (_pgid, signal) => {
          if (signal === 0) {
            const error = new Error('unknown') as NodeJS.ErrnoException;
            error.code = 'EPERM';
            throw error;
          }
        },
      },
    );
    setImmediate(() => child.emit('close', 1, null));
    const result = await pending;
    assert.equal(result.cleanupProven, false);
    assert.deepEqual(
      readPersistedAutomationState('ios', 'UDID-RESIDUAL')?.attributedProcesses,
      [{ pid: 731, processBirth: 'escaped-birth' }],
    );
    assert.equal(authorityWrites, 3);
  } finally {
    inspectAutomationDuty('ios', 'UDID-RESIDUAL', {
      authorityStore: null,
      signalGroup: () => {
        const error = new Error('absent') as NodeJS.ErrnoException;
        error.code = 'ESRCH';
        throw error;
      },
      probeBirth: () => ({ status: 'absent' }),
    });
    if (prior === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = prior;
    rmSync(dir, { recursive: true, force: true });
  }
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

test('inspection retains the duty when an attributed identity probe is unknown', () => {
  const prior = process.env.XDG_STATE_HOME;
  const dir = mkdtempSync(join(tmpdir(), 'rn-584-unknown-descendant-'));
  process.env.XDG_STATE_HOME = dir;
  try {
    const path = automationStatePath('ios', 'UDID-UNKNOWN');
    writeJsonStateFileAtomic(path, {
      schemaVersion: 1,
      kind: 'maestro-process-group',
      invocationId: 'invocation-unknown',
      sessionId: 'session-unknown',
      claimEpoch: 9,
      platform: 'ios',
      deviceId: 'UDID-UNKNOWN',
      pid: 710,
      pgid: 710,
      processBirth: 'leader-birth',
      startedAt: new Date().toISOString(),
      tool: 'device_pick_date',
      attributedProcesses: [{ pid: 711, processBirth: 'descendant-birth' }],
    });
    const duty = inspectAutomationDuty('ios', 'UDID-UNKNOWN', {
      signalGroup: () => {
        const error = new Error('absent') as NodeJS.ErrnoException;
        error.code = 'ESRCH';
        throw error;
      },
      probeBirth: () => ({ status: 'unknown' }),
      authorityStore: null,
    });
    assert.equal(duty?.kind, 'maestro-process-group');
    assert.equal(existsSync(path), true);
  } finally {
    if (prior === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = prior;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recovery verifies attributed identities after terminating a present group', async () => {
  const prior = process.env.XDG_STATE_HOME;
  const dir = mkdtempSync(join(tmpdir(), 'rn-584-group-descendant-'));
  process.env.XDG_STATE_HOME = dir;
  try {
    const path = automationStatePath('ios', 'UDID-GROUP-DESCENDANT');
    writeJsonStateFileAtomic(path, {
      schemaVersion: 1,
      kind: 'maestro-process-group',
      invocationId: 'invocation-group-descendant',
      sessionId: 'session-group-descendant',
      claimEpoch: 10,
      platform: 'ios',
      deviceId: 'UDID-GROUP-DESCENDANT',
      pid: 720,
      pgid: 720,
      processBirth: 'leader-birth',
      startedAt: new Date().toISOString(),
      tool: 'device_pick_date',
      attributedProcesses: [{ pid: 721, processBirth: 'escaped-birth' }],
    });
    let groupPresent = true;
    let descendantPresent = true;
    const processSignals: Array<[number, NodeJS.Signals]> = [];
    const recovered = await recoverAutomationDuty(
      {
        sessionId: 'session-group-descendant',
        claimEpoch: 10,
        platform: 'ios',
        deviceId: 'UDID-GROUP-DESCENDANT',
      },
      {
        authorityStore: null,
        signalGroup: (_pgid, signal) => {
          if (signal === 0 && !groupPresent) {
            const error = new Error('absent') as NodeJS.ErrnoException;
            error.code = 'ESRCH';
            throw error;
          }
          if (signal === 'SIGTERM') groupPresent = false;
        },
        probeBirth: (pid) => {
          if (pid === 720) {
            return {
              status: 'present',
              birth: { pid, source: 'linux-proc', token: 'leader-birth' },
            };
          }
          return descendantPresent
            ? {
                status: 'present',
                birth: { pid, source: 'linux-proc', token: 'escaped-birth' },
              }
            : { status: 'absent' };
        },
        signalProcess: (pid, signal) => {
          processSignals.push([pid, signal]);
          descendantPresent = false;
        },
        sleep: async () => {},
      },
    );
    assert.equal(recovered.recovered, true);
    assert.deepEqual(processSignals, [[721, 'SIGTERM']]);
    assert.equal(existsSync(path), false);
  } finally {
    if (prior === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = prior;
    rmSync(dir, { recursive: true, force: true });
  }
});
