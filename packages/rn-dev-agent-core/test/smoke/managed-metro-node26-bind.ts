// Exact-head real-device assertion for the managed-Metro descendant-spawn
// convention fix. Drives dist/supervisor.js over MCP stdio against a fresh
// task-owned iOS simulator and asserts that managed Metro binds AND survives a
// proof caller that makes Metro fork a descendant (the NativeWind Tailwind
// pipeline), which is what died before the fix on Node >= 24.19.
//
// Must run under the Node whose convention is being proven — the supervisor
// launches Metro with its own process.execPath.
//
//   MANAGED_METRO_PROOF_APP=/abs/path/to/app \
//   /path/to/node26 packages/rn-dev-agent-core/test/smoke/managed-metro-node26-bind.ts
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// @ts-expect-error -- untyped JS test helper
import { startSupervisor } from '../helpers/supervisor-harness.js';

const APP_ROOT = process.env.MANAGED_METRO_PROOF_APP;
const APP_ID = process.env.MANAGED_METRO_PROOF_APP_ID ?? 'com.rndevagent.testapp';
const DEVICE_TYPE = process.env.MANAGED_METRO_PROOF_DEVICE_TYPE ?? 'iPhone 17';
const RUNTIME = process.env.MANAGED_METRO_PROOF_RUNTIME;
const FLEET_CAP = 5;

if (!APP_ROOT || !existsSync(join(APP_ROOT, 'package.json'))) {
  console.error('MANAGED_METRO_PROOF_APP must point at a React Native app root');
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

function log(step: string, detail = ''): void {
  process.stdout.write(`[proof] ${step}${detail ? ` — ${detail}` : ''}\n`);
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

  const udid = simctl(['create', deviceName, DEVICE_TYPE, runtime]);
  log('created task-owned simulator', `${deviceName} ${udid}`);

  let released = false;
  let integrationApplied = false;
  const supervisor = startSupervisor({ cwd: APP_ROOT, lineTimeoutMs: 180_000 });

  const call = async (name: string, args: Record<string, unknown>) => {
    supervisor.send('tools/call', { name, arguments: args });
    for (;;) {
      const line = await supervisor.nextLine();
      const message = JSON.parse(line);
      if (message.id === undefined) continue;
      const text = message.result?.content?.[0]?.text;
      return text ? JSON.parse(text) : message.result;
    }
  };

  try {
    simctl(['boot', udid]);
    simctl(['bootstatus', udid, '-b']);
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
    assert.equal(bound?.error, undefined, JSON.stringify(bound));
    log('device bound');

    const applied = await call('rn_session', {
      action: 'apply_integration',
      projectRoot: APP_ROOT,
      confirmed: true,
    });
    assert.equal(applied?.error, undefined, JSON.stringify(applied));
    integrationApplied = true;
    log('package integration applied');

    // The supported managed build: native build + install, then the adapter
    // starts managed Metro and completes the build receipt.
    const build = spawnSync('corepack', ['pnpm', 'run', 'ios'], {
      cwd: APP_ROOT,
      encoding: 'utf8',
      timeout: 3_600_000,
      env: { ...process.env },
    });
    assert.equal(
      build.status,
      0,
      `managed build failed:\n${String(build.stdout).slice(-4000)}\n${String(build.stderr).slice(-4000)}`,
    );
    log('native build and install succeeded');

    const afterBuild = await call('rn_session', { action: 'status', projectRoot: APP_ROOT });
    assert.equal(
      afterBuild?.authority?.metroBound,
      true,
      `managed Metro did not bind: ${JSON.stringify(afterBuild?.authority?.metroTerminal ?? afterBuild)}`,
    );
    const metroPort = Number(afterBuild.authority.metroPort);
    assert.ok(Number.isSafeInteger(metroPort), 'no allocated Metro port');
    log('managed Metro bound', `port ${metroPort}`);

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
    assert.equal(bundle.stdout.trim(), '200', `bundle request failed: ${bundle.stdout}`);
    log('bundle request served');

    const afterBundle = await call('rn_session', { action: 'status', projectRoot: APP_ROOT });
    assert.equal(
      afterBundle?.authority?.metroBound,
      true,
      `managed Metro did not survive the proof caller: ${JSON.stringify(afterBundle?.authority?.metroTerminal ?? afterBundle)}`,
    );
    assert.equal(afterBundle?.authority?.metroTerminal ?? null, null);
    log('managed Metro survived the proof caller');
  } finally {
    try {
      await call('rn_session', { action: 'stop_metro', projectRoot: APP_ROOT });
      log('metro stopped');
    } catch (error) {
      log('metro stop failed', String(error));
    }
    if (integrationApplied) {
      try {
        await call('rn_session', {
          action: 'restore_integration',
          projectRoot: APP_ROOT,
          confirmed: true,
        });
        log('integration restored');
      } catch (error) {
        log('integration restore failed', String(error));
      }
    }
    try {
      await call('rn_session', { action: 'release', projectRoot: APP_ROOT, confirmed: true });
      released = true;
      log('session released');
    } catch (error) {
      log('session release failed', String(error));
    }
    supervisor.child.kill('SIGINT');
    try {
      simctl(['shutdown', udid]);
      simctl(['delete', udid]);
      log('task-owned simulator shut down and deleted');
    } catch (error) {
      log('simulator cleanup failed', String(error));
    }
    const after = bootedSimulatorCount();
    log('fleet booted simulators', `${before} before, ${after} after`);
    assert.equal(after, before, 'the task-owned simulator was not cleaned up');
    assert.ok(released, 'the session claim was not released');
  }
  log('PROOF PASSED');
}

await main();
