import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { probeProcessBirth } from '../../../dist/session/process-birth.js';
import { stopBoundRunner } from '../../../dist/session/process-cleanup.js';
import { authorityProfileFor } from '../../../dist/session/tool-profiles.js';
import { createRestartHandler } from '../../../dist/tools/restart.js';

const supported = process.platform === 'darwin' || process.platform === 'linux';

// A stand-in for the bound iOS runner: `xcodebuild test-without-building` does
// not exit on a single polite SIGTERM, and once it does die its parent has not
// reaped it yet, so the pid lingers as a zombie. Both states must still let the
// owning session prove the stop.
interface StubbornRunner {
  pid: number;
  processBirth: string;
  dispose: () => void;
}

async function spawnStubbornRunner(): Promise<StubbornRunner> {
  const runnerCode = `
    process.on('SIGTERM', () => {});
    process.stdout.write('ready');
    setInterval(() => {}, 1_000);
  `;
  // Block the holder's event loop after the child is ready so it cannot reap the killed child.
  const holderCode = `
    const { spawn } = require('node:child_process');
    const { writeSync } = require('node:fs');
    const runner = spawn(process.execPath, ['-e', ${JSON.stringify(runnerCode)}], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    runner.stdout.once('data', () => {
      writeSync(1, String(runner.pid));
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
    });
  `;
  const holder = spawn(process.execPath, ['-e', holderCode], {
    stdio: ['ignore', 'pipe', 'ignore'],
    detached: true,
  });
  let out = '';
  holder.stdout.setEncoding('utf8');
  const pid = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('runner stub did not report its pid')), 5_000);
    holder.stdout.on('data', (chunk: string) => {
      out += chunk;
      const parsed = Number(out.trim());
      if (Number.isSafeInteger(parsed) && parsed > 0) {
        clearTimeout(timer);
        resolve(parsed);
      }
    });
  });
  const birth = probeProcessBirth(pid);
  assert.equal(birth.status, 'present', 'runner stub identity must be provable before the stop');
  return {
    pid,
    processBirth: birth.status === 'present' ? birth.birth.token : '',
    dispose: () => {
      try {
        process.kill(-holder.pid!, 'SIGKILL');
      } catch {
        /* already gone */
      }
      holder.stdout.destroy();
    },
  };
}

function runnerBinding(runner: StubbornRunner): Record<string, unknown> {
  return {
    platform: 'ios',
    deviceId: 'A1B2C3D4-1111-2222-3333-444455556666',
    pid: runner.pid,
    port: 9207,
    processBirth: runner.processBirth,
    instanceId: 'runner-707',
    capability: 'runner-capability-707',
  };
}

test(
  'GH #707: the owning session can stop a runner that ignores SIGTERM and then lingers unreaped',
  { skip: supported ? false : 'process-birth probes are POSIX-only here' },
  async () => {
    const runner = await spawnStubbornRunner();
    try {
      await stopBoundRunner(runnerBinding(runner));
    } finally {
      runner.dispose();
    }
  },
);

test('GH #707: escalation never SIGKILLs a pid that no longer carries this binding’s birth', async () => {
  const binding = {
    platform: 'ios',
    deviceId: 'A1B2C3D4-1111-2222-3333-444455556666',
    pid: 4242,
    port: 9207,
    processBirth: 'birth-mine',
    instanceId: 'runner-707',
    capability: 'runner-capability-707',
  };
  const escalate = async (birthAfterGrace: string): Promise<string[]> => {
    const signals: string[] = [];
    let probes = 0;
    // A zero grace makes the poll schedule exact: probe 1 admits the binding,
    // probe 2 closes the grace window, probe 3 IS the escalation re-probe.
    const probe = (): { status: 'present'; birth: { token: string } } => {
      probes += 1;
      return {
        status: 'present',
        birth: { token: probes <= 2 ? 'birth-mine' : birthAfterGrace },
      };
    };
    await stopBoundRunner(
      binding,
      probe as never,
      (_pid: number, signal: NodeJS.Signals) => signals.push(signal),
      300,
      async () => ({ stdout: '', stderr: '' }),
      0,
    ).catch(() => {});
    return signals;
  };

  assert.deepEqual(
    await escalate('birth-mine'),
    ['SIGTERM', 'SIGKILL'],
    'a runner still proven to be mine may be escalated',
  );
  assert.deepEqual(
    await escalate('birth-someone-else'),
    ['SIGTERM'],
    'a pid recycled inside the grace window must never be killed',
  );
});

test(
  'GH #707: hardReset has a reachable cold start — the runner-bound state must not refuse it',
  { skip: supported ? false : 'process-birth probes are POSIX-only here' },
  async () => {
    // The authority gate refuses hardReset outright when R is unbound, so the
    // runner-bound state is the only candidate. If it refuses too, the
    // operation has no reachable state at all — the #707 deadlock.
    const profile = authorityProfileFor('cdp_restart', { hardReset: true, platform: 'ios' });
    assert.ok(
      profile.axes.includes('R'),
      'hardReset still requires R; the runner-unbound state cannot be the reachable one',
    );

    const runner = await spawnStubbornRunner();
    const binding = runnerBinding(runner);
    const client = {
      metroPort: 8081,
      isConnected: false,
      connectedTarget: { platform: 'ios' },
      disconnect: async () => {},
      connectExact: async function (this: { isConnected: boolean }) {
        this.isConnected = true;
      },
    };
    let unbound = false;
    const restart = createRestartHandler(
      () => client as never,
      () => {},
      () => client as never,
      {
        // Covers the stopBoundRunner half of index.ts's stopFastRunner wiring;
        // clearFastRunnerAfterVerifiedStop is omitted to keep this test off
        // persisted runner state.
        stopFastRunner: async () => {
          await stopBoundRunner(binding);
        },
        unbindRunner: () => {
          unbound = true;
        },
        execFile: async () => ({ stdout: '', stderr: '' }),
        sleep: async () => {},
        probeAppInstalled: async () => true,
        resetDetachedBudget: () => {},
        resolveExactTargetId: async () => 'target-707',
      },
    );

    let envelope: { content: Array<{ text: string }> };
    try {
      envelope = (await restart({
        hardReset: true,
        platform: 'ios',
        deviceId: binding.deviceId as string,
        appId: 'com.example.app',
        metroPort: 8081,
      })) as { content: Array<{ text: string }> };
    } finally {
      runner.dispose();
    }
    const result = JSON.parse(envelope.content[0]!.text) as { ok?: boolean; error?: string };

    assert.equal(
      result.ok,
      true,
      `hardReset refused the only reachable runner state: ${result.error ?? 'unknown'}`,
    );
    assert.equal(unbound, true, 'a completed hardReset must release the runner it stopped');
  },
);
