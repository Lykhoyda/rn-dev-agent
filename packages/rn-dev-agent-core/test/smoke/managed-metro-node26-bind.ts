// Exact-head real-device assertion for the managed-Metro descendant-spawn
// convention fix. Drives dist/supervisor.js over MCP stdio against a fresh
// task-owned iOS simulator and asserts that managed Metro binds AND survives a
// proof caller that makes Metro fork a descendant (the NativeWind Tailwind
// pipeline), which is what died before the fix on Node >= 24.19.
//
// Must run under the Node whose convention is being proven. The launcher runs
// under the supervisor's process.execPath, but Metro itself is started through
// the package bin, which pnpm and npm generate as a /bin/sh shim that
// re-resolves `node` from PATH. This proof therefore pins PATH to its own Node
// and asserts the Metro listener's actual executable — without that, the whole
// run passes identically on a PATH Node where the bug does not exist.
//
//   MANAGED_METRO_PROOF_APP=/abs/path/to/app \
//   /path/to/node26 packages/rn-dev-agent-core/test/smoke/managed-metro-node26-bind.ts
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// @ts-expect-error -- untyped JS test helper
import { startSupervisor } from '../helpers/supervisor-harness.js';

const APP_ROOT = process.env.MANAGED_METRO_PROOF_APP;
const APP_ID = process.env.MANAGED_METRO_PROOF_APP_ID ?? 'com.rndevagent.testapp';
const DEVICE_TYPE = process.env.MANAGED_METRO_PROOF_DEVICE_TYPE ?? 'iPhone 17';
const RUNTIME = process.env.MANAGED_METRO_PROOF_RUNTIME;
const FLEET_CAP = 5;
// NOTE: this does NOT isolate the proof from other live sessions. The supervisor
// tool path only forwards RN_DEV_AGENT_STATE_DIR into the integration manifest,
// and resolveAuthorityStateLayout opens — never creates — an explicitly requested
// home, so the supervisor still uses the shared default registry. Run this proof
// only in a window where no other lane owns the app root.
const STATE_DIR =
  process.env.MANAGED_METRO_PROOF_STATE_DIR ??
  mkdtempSync(join(tmpdir(), 'rn-managed-metro-proof-state-'));

if (!APP_ROOT || !existsSync(join(APP_ROOT, 'package.json'))) {
  console.error('MANAGED_METRO_PROOF_APP must point at a React Native app root');
  process.exit(1);
}

// A 200 from /index.bundle only proves Metro answered. This proof is falsifiable
// only if the transform pipeline actually forks a descendant, so the fixture has
// to carry one. NativeWind's Tailwind processor is that descendant; without it
// the run would pass against the pre-fix fence too. The automated falsifiability
// control is test/integration/managed-metro-product-bundle.test.ts, which drives
// the forked-worker transport directly.
if (!existsSync(join(APP_ROOT, 'node_modules', 'nativewind'))) {
  console.error(
    `MANAGED_METRO_PROOF_APP (${APP_ROOT}) has no installed nativewind, so its bundle ` +
      'request would not fork the descendant this proof exists to exercise',
  );
  process.exit(1);
}

function simctl(args: readonly string[], timeout = 180_000): string {
  return execFileSync('xcrun', ['simctl', ...args], {
    encoding: 'utf8',
    timeout,
  }).trim();
}

function bootedSimulatorCount(): number {
  return simctl(['list', 'devices', 'booted'])
    .split('\n')
    .filter((line) => line.includes('(Booted)')).length;
}

// SIGINT then a bounded wait then SIGKILL: the state directory must not be
// removed while the supervisor can still write to it.
async function stopSupervisor(supervisor: {
  child: {
    kill: (signal: string) => boolean;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
  };
}): Promise<boolean> {
  const hasExited = (): boolean =>
    supervisor.child.exitCode !== null || supervisor.child.signalCode !== null;
  const settle = async (budgetMs: number): Promise<boolean> => {
    for (let waited = 0; waited < budgetMs; waited += 100) {
      if (hasExited()) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return hasExited();
  };
  supervisor.child.kill('SIGINT');
  if (await settle(10_000)) return true;
  supervisor.child.kill('SIGKILL');
  return settle(5_000);
}

function log(step: string, detail = ''): void {
  process.stdout.write(`[proof] ${step}${detail ? ` — ${detail}` : ''}\n`);
}

// PATH, not process.execPath, selects the Node that runs Metro behind a /bin/sh
// bin shim. Pinning this Node first is what makes the proof falsifiable.
const PINNED_PATH = [dirname(process.execPath), process.env.PATH].filter(Boolean).join(':');

function metroListenerPid(port: number): number | null {
  try {
    const pid = Number(
      execFileSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' })
        .trim()
        .split('\n')[0],
    );
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

// `ps -o comm=` reports argv[0], which a bin shim's `exec node` leaves as a bare name; the
// first lsof txt descriptor is the actual executable image.
function processExecutable(pid: number): string | null {
  try {
    if (process.platform === 'linux') return realpathSync(`/proc/${pid}/exe`);
    return (
      execFileSync('lsof', ['-p', String(pid), '-a', '-d', 'txt', '-Fn'], { encoding: 'utf8' })
        .split('\n')
        .find((line) => line.startsWith('n/'))
        ?.slice(1) ?? null
    );
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  log('node', process.version);
  const before = bootedSimulatorCount();
  assert.ok(
    before < FLEET_CAP,
    `fleet already has ${before} booted simulators; the cap is ${FLEET_CAP}`,
  );

  const deviceName = `managed-metro-proof-${randomUUID().slice(0, 8)}`;
  const runtime =
    RUNTIME ??
    simctl(['list', 'runtimes'])
      .split('\n')
      .filter((line) => line.includes('iOS') && !line.includes('unavailable'))
      .map((line) => line.trim().split(' - ').pop() ?? '')
      .filter(Boolean)
      .pop() ??
    '';
  assert.ok(runtime, 'no available iOS runtime for the task-owned simulator');

  let stopEnvelope: Record<string, any> | null = null;
  let restoreEnvelope: Record<string, any> | null = null;
  let releaseEnvelope: Record<string, any> | null = null;
  let integrationApplied = false;
  let deviceRemoved = false;
  let primaryError: unknown = null;
  const cleanupFailures: string[] = [];
  const supervisor = startSupervisor({
    cwd: APP_ROOT,
    lineTimeoutMs: 180_000,
    env: { RN_DEV_AGENT_STATE_DIR: STATE_DIR, PATH: PINNED_PATH },
  });

  const call = async (
    name: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, any>> => {
    supervisor.send('tools/call', { name, arguments: args });
    for (;;) {
      const line = await supervisor.nextLine();
      const message = JSON.parse(line);
      if (message.id === undefined) continue;
      const text = message.result?.content?.[0]?.text;
      return text ? JSON.parse(text) : message.result;
    }
  };

  let udid: string;
  try {
    udid = simctl(['create', deviceName, DEVICE_TYPE, runtime]);
  } catch (error) {
    const failures: Error[] = [];
    let supervisorStopped = false;
    try {
      supervisorStopped = await stopSupervisor(supervisor);
    } catch (stopError) {
      failures.push(new Error(`the proof supervisor could not be stopped: ${String(stopError)}`));
    }
    if (!supervisorStopped && failures.length === 0) {
      failures.push(new Error('the proof supervisor did not exit'));
    }
    if (!process.env.MANAGED_METRO_PROOF_STATE_DIR && supervisorStopped) {
      try {
        rmSync(STATE_DIR, { recursive: true, force: true });
      } catch (removeError) {
        failures.push(
          new Error(`the proof state directory was not removed: ${String(removeError)}`),
        );
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(
        [error, ...failures],
        'simulator creation failed and proof cleanup did not complete',
      );
    }
    throw error;
  }
  log('created task-owned simulator', `${deviceName} ${udid}`);

  try {
    // A brand-new simulator's first boot runs data migration; it routinely
    // exceeds the default timeout used for the other simctl calls, and installd
    // stays unsettled afterwards ("Failed to set metadata" on the first
    // install). A full shutdown and second boot settles it deterministically.
    simctl(['boot', udid]);
    simctl(['bootstatus', udid, '-b'], 1_800_000);
    simctl(['shutdown', udid]);
    simctl(['boot', udid]);
    simctl(['bootstatus', udid, '-b'], 1_800_000);
    log('booted task-owned simulator');

    supervisor.send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'managed-metro-proof', version: '1' },
    });
    await supervisor.nextLine();
    supervisor.notify('notifications/initialized');

    const bound = await call('rn_session', {
      action: 'bind_device',
      projectRoot: APP_ROOT,
      platform: 'ios',
      deviceId: udid,
      appId: APP_ID,
    });
    assert.equal(bound?.ok, true, JSON.stringify(bound));
    log('device bound');

    const applied = await call('rn_session', {
      action: 'apply_integration',
      projectRoot: APP_ROOT,
      confirmed: true,
    });
    assert.equal(applied?.ok, true, JSON.stringify(applied));
    integrationApplied = true;
    log('package integration applied');

    // The supported managed build: native build + install, then the adapter
    // starts managed Metro and completes the build receipt.
    const build = spawnSync('corepack', ['pnpm', 'run', 'ios'], {
      cwd: APP_ROOT,
      encoding: 'utf8',
      timeout: 3_600_000,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, RN_DEV_AGENT_STATE_DIR: STATE_DIR, PATH: PINNED_PATH },
    });
    assert.equal(
      build.status,
      0,
      `managed build failed:\n${String(build.stdout).slice(-4000)}\n${String(build.stderr).slice(-4000)}`,
    );
    log('native build and install succeeded');

    const afterBuild = (await call('rn_session', { action: 'status', projectRoot: APP_ROOT }))?.data
      ?.authority;
    assert.equal(
      afterBuild?.metroBound,
      true,
      `managed Metro did not bind: ${JSON.stringify(afterBuild?.metroTerminal ?? afterBuild)}`,
    );
    const metroPort = Number(afterBuild.metroPort);
    assert.ok(Number.isSafeInteger(metroPort), 'no allocated Metro port');
    log('managed Metro bound', `port ${metroPort}`);

    // The axis this proof exists to protect: the descendant fence must be
    // exercised on the Node under test, not on whatever Node PATH happened to
    // resolve. Without this the entire run passes against the pre-fix fence.
    const listenerPid = metroListenerPid(metroPort);
    assert.ok(listenerPid, `could not resolve the Metro listener on port ${metroPort}`);
    const listenerExecutable = processExecutable(listenerPid);
    assert.ok(listenerExecutable, `could not resolve the executable of listener ${listenerPid}`);
    assert.equal(
      realpathSync(listenerExecutable),
      realpathSync(process.execPath),
      `managed Metro must run under the Node this proof pins (${process.version}); it ran under ${listenerExecutable}`,
    );
    log('managed Metro runs the pinned Node', `${process.version} ${listenerExecutable}`);

    // The proof caller: a real bundle request drives Metro's transform pipeline,
    // which forks the NativeWind Tailwind CSS processor. Before the fix that
    // descendant was refused, the refusal escaped as an uncaught exception, and
    // the launcher exited before bundle authority could bind.
    const bundle = spawnSync(
      'curl',
      [
        '--silent',
        '--show-error',
        '--max-time',
        '600',
        '--output',
        '/dev/null',
        '--write-out',
        '%{http_code}',
        `http://127.0.0.1:${metroPort}/index.bundle?platform=ios&dev=true&minify=false`,
      ],
      { encoding: 'utf8', timeout: 660_000 },
    );
    assert.equal(
      bundle.status,
      0,
      `bundle request did not complete: ${bundle.stdout} ${bundle.stderr}`,
    );
    assert.equal(
      bundle.stdout.trim(),
      '200',
      `bundle request failed: ${bundle.stdout} ${bundle.stderr}`,
    );
    log('bundle request served');

    const afterBundle = (await call('rn_session', { action: 'status', projectRoot: APP_ROOT }))
      ?.data?.authority;
    assert.equal(
      afterBundle?.metroBound,
      true,
      `managed Metro did not survive the proof caller: ${JSON.stringify(afterBundle?.metroTerminal ?? afterBundle)}`,
    );
    assert.equal(afterBundle?.metroTerminal ?? null, null);
    log('managed Metro survived the proof caller');
  } catch (error) {
    primaryError = error;
  } finally {
    try {
      stopEnvelope = await call('rn_session', { action: 'stop_metro', projectRoot: APP_ROOT });
      log('metro stopped', `ok=${stopEnvelope?.ok}`);
    } catch (error) {
      log('metro stop failed', String(error));
    }
    if (integrationApplied) {
      try {
        restoreEnvelope = await call('rn_session', {
          action: 'restore_integration',
          projectRoot: APP_ROOT,
          confirmed: true,
        });
        log('integration restored', `ok=${restoreEnvelope?.ok}`);
      } catch (error) {
        log('integration restore failed', String(error));
      }
    } else {
      restoreEnvelope = { ok: true };
    }
    try {
      releaseEnvelope = await call('rn_session', {
        action: 'release',
        projectRoot: APP_ROOT,
        confirmed: true,
      });
      log('session released', `ok=${releaseEnvelope?.ok}`);
    } catch (error) {
      log('session release failed', String(error));
    }
    let supervisorStopped = false;
    try {
      supervisorStopped = await stopSupervisor(supervisor);
      if (!supervisorStopped) cleanupFailures.push('the proof supervisor did not exit');
    } catch (error) {
      cleanupFailures.push(`the proof supervisor could not be stopped: ${String(error)}`);
    }
    try {
      simctl(['shutdown', udid]);
    } catch {
      // already shut down
    }
    try {
      simctl(['delete', udid]);
    } catch (error) {
      log('simulator delete failed', String(error));
    }
    try {
      // Only this task's device is ours to account for; the fleet-wide count moves
      // under concurrent lanes.
      deviceRemoved = !simctl(['list', 'devices']).includes(udid);
      log('task-owned simulator removed', String(deviceRemoved));
    } catch (error) {
      cleanupFailures.push(`the device inventory could not be read: ${String(error)}`);
    }
    if (!process.env.MANAGED_METRO_PROOF_STATE_DIR && supervisorStopped) {
      try {
        rmSync(STATE_DIR, { recursive: true, force: true });
      } catch (error) {
        cleanupFailures.push(`the proof state directory was not removed: ${String(error)}`);
      }
    }
  }
  if (!deviceRemoved) cleanupFailures.push('the task-owned simulator was not deleted');
  if (stopEnvelope?.ok !== true) {
    cleanupFailures.push(`managed Metro was not stopped: ${JSON.stringify(stopEnvelope)}`);
  }
  if (restoreEnvelope?.ok !== true) {
    cleanupFailures.push(
      `the package integration was not restored: ${JSON.stringify(restoreEnvelope)}`,
    );
  }
  if (releaseEnvelope?.ok !== true) {
    cleanupFailures.push(`the session claim was not released: ${JSON.stringify(releaseEnvelope)}`);
  }
  if (primaryError !== null) {
    if (cleanupFailures.length === 0) throw primaryError;
    throw new AggregateError(
      [primaryError, new Error(cleanupFailures.join('; '))],
      'the proof failed and its cleanup did not complete',
    );
  }
  assert.deepEqual(cleanupFailures, [], cleanupFailures.join('; '));
  log('PROOF PASSED');
}

await main();
