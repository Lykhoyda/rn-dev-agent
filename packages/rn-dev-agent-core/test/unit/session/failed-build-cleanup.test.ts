import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openSessionRegistry } from '../../../dist/session/registry.js';
import { resolveSourceIdentity } from '../../../dist/session/source-identity.js';
import {
  createAuthorityStateLayout,
  writeSessionSecret,
} from '../../../dist/session/state-root.js';
import { createSessionHandler } from '../../../dist/tools/session.js';
import { closeDeviceSession } from '../../../dist/tools/device-session-close.js';

const cliPath = new URL('../../../dist/rn-session.js', import.meta.url).pathname;

// A build that fails before install must never strand pendingBuild authority or registry residue.

async function allocateFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => resolvePort(port));
    });
  });
}

function createAppFixture(root: string): string {
  const appRoot = join(root, 'app');
  execFileSync('git', ['init', '-q', appRoot]);
  execFileSync('git', ['-C', appRoot, 'config', 'user.email', 'test@example.invalid']);
  execFileSync('git', ['-C', appRoot, 'config', 'user.name', 'Test']);
  writeFileSync(
    join(appRoot, 'package.json'),
    `${JSON.stringify({ scripts: { ios: 'expo run:ios', android: 'expo run:android' } }, null, 2)}\n`,
  );
  writeFileSync(join(appRoot, 'metro.config.js'), 'module.exports = {};\n');
  execFileSync('git', ['-C', appRoot, 'add', 'package.json', 'metro.config.js']);
  execFileSync('git', ['-C', appRoot, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture']);
  return appRoot;
}

function runSessionCli(
  args: readonly string[],
  options: { appRoot: string; stateHome: string; sessionId?: string },
): ReturnType<typeof spawnSync<string>> {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: options.appRoot,
    env: {
      ...process.env,
      XDG_STATE_HOME: options.stateHome,
      ...(options.sessionId ? { RN_DEV_AGENT_SESSION_ID: options.sessionId } : {}),
    },
    encoding: 'utf8',
  });
}

test('prepare-build publishes only against a caller-delivered abort capability', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-prepare-capability-'));
  const stateHome = join(root, 'state');
  const previousStateHome = process.env.XDG_STATE_HOME;
  try {
    const appRoot = createAppFixture(root);
    process.env.XDG_STATE_HOME = stateHome;
    const source = resolveSourceIdentity(appRoot);
    const layout = createAuthorityStateLayout();
    const metroPort = await allocateFreePort();
    const registry = openSessionRegistry(layout.registry, { ownerStatus: () => 'match' });
    const session = registry.createSession({
      sessionId: 'session-prepare',
      sourceKey: source.sourceKey,
      worktreeKey: source.worktreeKey,
      appRootKey: source.appRootKey,
      supervisor: { pid: process.pid, token: 'fixture' },
      source: { ...source },
      bindings: { metroPort },
    });
    registry.updateBindings(session, {
      state: 'device_claimed',
      bindings: {
        device: { platform: 'ios', deviceId: 'SIM-FIXTURE', appId: 'com.rndevagent.testapp' },
        metro: { mode: 'external', instanceId: 'external-metro', port: metroPort },
      },
    });
    registry.close();
    writeSessionSecret(layout, session.sessionId, {
      signerCapability: 'signer',
      observeCapability: 'observe',
      recoveryCapability: 'recovery',
    });
    const cliOptions = { appRoot, stateHome, sessionId: 'session-prepare' };

    for (const args of [
      ['prepare-build', 'ios'],
      ['prepare-build', 'ios', ''],
      ['prepare-build', 'ios', 'not-a-canonical-uuid'],
      ['prepare-build', 'ios', 'ZZZZZZZZ-1111-2222-3333-444444444444'],
    ]) {
      const refused = runSessionCli(args, cliOptions);
      assert.notEqual(refused.status, 0);
      assert.match(refused.stderr, /caller-delivered abort capability/);
    }

    const delivered = runSessionCli(
      ['prepare-build', 'ios', '4f9c2d61-8f4e-4a5b-9c3d-2e1f0a7b6c5d'],
      cliOptions,
    );
    assert.notEqual(delivered.status, 0);
    assert.match(
      delivered.stderr,
      /METRO_AUTHORITY_MISMATCH/,
      'a canonical capability must pass the delivery gate and fail only on later authority checks',
    );

    const verify = openSessionRegistry(layout.registry, { ownerStatus: () => 'match' });
    const status = verify.getSessionStatus('session-prepare');
    verify.close();
    assert.equal(
      status?.bindings.pendingBuild ?? null,
      null,
      'a refused prepare-build must not publish',
    );
    assert.equal(status?.state, 'device_claimed');
  } finally {
    if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousStateHome;
    rmSync(root, { force: true, recursive: true });
  }
});

test('abort-build releases pending build authority only for the exact capability', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-abort-build-'));
  const stateHome = join(root, 'state');
  const previousStateHome = process.env.XDG_STATE_HOME;
  try {
    const appRoot = createAppFixture(root);
    process.env.XDG_STATE_HOME = stateHome;
    const source = resolveSourceIdentity(appRoot);
    const layout = createAuthorityStateLayout();
    const metroPort = await allocateFreePort();
    let registry = openSessionRegistry(layout.registry, { ownerStatus: () => 'match' });
    const session = registry.createSession({
      sessionId: 'session-abort',
      sourceKey: source.sourceKey,
      worktreeKey: source.worktreeKey,
      appRootKey: source.appRootKey,
      supervisor: { pid: process.pid, token: 'fixture' },
      source: { ...source },
      bindings: { metroPort },
    });
    registry.updateBindings(session, {
      state: 'device_claimed',
      bindings: {
        device: { platform: 'ios', deviceId: 'SIM-FIXTURE', appId: 'com.rndevagent.testapp' },
        install: { platform: 'ios', buildGeneration: 2 },
        pendingBuild: { buildToken: 'owned-build-token', platform: 'ios', buildGeneration: 3 },
      },
    });
    registry.close();
    const cliOptions = { appRoot, stateHome, sessionId: 'session-abort' };

    const foreignToken = runSessionCli(['abort-build', 'ios', 'foreign-token'], cliOptions);
    assert.notEqual(foreignToken.status, 0);
    assert.match(foreignToken.stderr, /build abort capability is stale or foreign/);

    const foreignPlatform = runSessionCli(
      ['abort-build', 'android', 'owned-build-token'],
      cliOptions,
    );
    assert.notEqual(foreignPlatform.status, 0);
    assert.match(foreignPlatform.stderr, /build abort capability is stale or foreign/);

    registry = openSessionRegistry(layout.registry, { ownerStatus: () => 'match' });
    const afterRefusals = registry.getSessionStatus('session-abort');
    registry.close();
    assert.deepEqual(afterRefusals?.bindings.pendingBuild, {
      buildToken: 'owned-build-token',
      platform: 'ios',
      buildGeneration: 3,
    });

    const aborted = runSessionCli(['abort-build', 'ios', 'owned-build-token'], cliOptions);
    assert.equal(aborted.status, 0, aborted.stderr);
    assert.deepEqual(JSON.parse(aborted.stdout), {
      aborted: true,
      platform: 'ios',
      buildGeneration: 3,
    });

    registry = openSessionRegistry(layout.registry, { ownerStatus: () => 'match' });
    const afterAbort = registry.getSessionStatus('session-abort');
    registry.close();
    assert.equal(afterAbort?.bindings.pendingBuild, null);
    assert.equal(afterAbort?.state, 'device_claimed');
    assert.deepEqual(afterAbort?.bindings.device, {
      platform: 'ios',
      deviceId: 'SIM-FIXTURE',
      appId: 'com.rndevagent.testapp',
    });
    assert.deepEqual(afterAbort?.bindings.install, { platform: 'ios', buildGeneration: 2 });

    const repeated = runSessionCli(['abort-build', 'ios', 'owned-build-token'], cliOptions);
    assert.equal(repeated.status, 0, repeated.stderr);
    assert.deepEqual(JSON.parse(repeated.stdout), { aborted: false, alreadyClear: true });
  } finally {
    if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousStateHome;
    rmSync(root, { force: true, recursive: true });
  }
});

test('supported cleanup chain is reachable and idempotent after a pre-install build failure', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-failed-build-cleanup-'));
  const stateHome = join(root, 'state');
  const previousStateHome = process.env.XDG_STATE_HOME;
  try {
    const appRoot = createAppFixture(root);
    const packagePath = join(appRoot, 'package.json');
    const metroConfigPath = join(appRoot, 'metro.config.js');
    const manifestPath = join(appRoot, '.rn-agent', 'integration', 'rn-session-integration.json');
    const originalPackage = readFileSync(packagePath, 'utf8');
    const originalMetroConfig = readFileSync(metroConfigPath, 'utf8');
    process.env.XDG_STATE_HOME = stateHome;
    const source = resolveSourceIdentity(appRoot);
    const layout = createAuthorityStateLayout();
    const metroPort = await allocateFreePort();
    let registry = openSessionRegistry(layout.registry, { ownerStatus: () => 'match' });
    const session = registry.createSession({
      sessionId: 'session-failed-build',
      sourceKey: source.sourceKey,
      worktreeKey: source.worktreeKey,
      appRootKey: source.appRootKey,
      supervisor: { pid: process.pid, token: 'fixture' },
      source: { ...source },
      bindings: { metroPort },
    });
    registry.updateBindings(session, {
      state: 'device_claimed',
      bindings: {
        device: { platform: 'ios', deviceId: 'SIM-FIXTURE', appId: 'com.rndevagent.testapp' },
      },
    });
    const handler = createSessionHandler(
      {
        status: () => ({ available: true, ...registry.getSessionStatus('session-failed-build') }),
        requireOperational: () => ({
          registry,
          session: { sessionId: 'session-failed-build', claimEpoch: session.claimEpoch },
        }),
      } as never,
      {
        stopManagedMetroWithEvidence: async () => ({
          authenticated: true,
          stopped: true,
          evidence: {
            complete: true,
            launcher: 'absent',
            listener: 'absent',
            port: { status: 'absent' },
            evidenceSocket: 'absent',
          },
        }),
      } as never,
    );

    const applied = await handler({ action: 'apply_integration', confirmed: true });
    assert.equal(applied.isError, undefined, applied.content[0]!.text);
    assert.equal(existsSync(manifestPath), true);

    // Pre-install failure state: managed Metro bound and pendingBuild recorded, no receipt.
    registry.updateBindings(session, {
      bindings: {
        metro: { mode: 'managed', port: metroPort, instanceId: 'metro-fixture' },
        pendingBuild: { buildToken: 'owned-build-token', platform: 'ios', buildGeneration: 1 },
      },
    });

    const closed = await closeDeviceSession({
      hasActiveSession: () => false,
      closeUnderlyingSession: async () => {
        throw new Error('close must not reach the underlying session without one active');
      },
      clearActiveSession: () => {},
      stopFastRunner: () => {},
      stopAndroidRunner: async () => {},
      finalizeSuccessfulClose: () => {},
      releaseDeviceLock: () => {},
    });
    assert.equal(closed.isError, undefined);
    assert.match(closed.content[0]!.text, /No active session to close/);

    const firstStop = await handler({ action: 'stop_metro' });
    assert.equal(firstStop.isError, undefined, firstStop.content[0]!.text);
    assert.equal(JSON.parse(firstStop.content[0]!.text).data.stopped, true);

    const secondStop = await handler({ action: 'stop_metro' });
    assert.equal(secondStop.isError, undefined, secondStop.content[0]!.text);
    assert.equal(JSON.parse(secondStop.content[0]!.text).data.alreadyStopped, true);

    // A leaked pendingBuild deadlocks restore_integration and release against each other.
    const blockedRestore = await handler({ action: 'restore_integration', confirmed: true });
    assert.equal(blockedRestore.isError, true);
    assert.match(
      blockedRestore.content[0]!.text,
      /restore_integration requires releasing active pendingBuild authority/,
    );
    const blockedRelease = await handler({ action: 'release' });
    assert.equal(blockedRelease.isError, true);
    assert.match(
      blockedRelease.content[0]!.text,
      /package integration must be restored before session release/,
    );

    // The authenticated abort the generated adapter runs on failure clears the fence via the CLI.
    registry.close();
    const cliOptions = { appRoot, stateHome, sessionId: 'session-failed-build' };
    const aborted = runSessionCli(['abort-build', 'ios', 'owned-build-token'], cliOptions);
    assert.equal(aborted.status, 0, aborted.stderr);
    assert.equal(JSON.parse(aborted.stdout).aborted, true);
    registry = openSessionRegistry(layout.registry, { ownerStatus: () => 'match' });

    const restored = await handler({ action: 'restore_integration', confirmed: true });
    assert.equal(restored.isError, undefined, restored.content[0]!.text);
    assert.equal(readFileSync(packagePath, 'utf8'), originalPackage);
    assert.equal(readFileSync(metroConfigPath, 'utf8'), originalMetroConfig);
    assert.equal(
      registry.getSessionStatus('session-failed-build')?.bindings.packageIntegration,
      null,
    );

    const released = await handler({ action: 'release' });
    assert.equal(released.isError, undefined, released.content[0]!.text);
    assert.equal(JSON.parse(released.content[0]!.text).data.released, true);
    const terminal = registry.getSessionStatus('session-failed-build');
    assert.equal(terminal?.state, 'released');
    assert.deepEqual(terminal?.claims, []);
    assert.equal(terminal?.bindings.pendingBuild, null);
    assert.equal(terminal?.bindings.packageIntegration, null);
    assert.deepEqual(registry.findSessionsByWorktree(source.worktreeKey), []);
    registry.close();

    // Zero residue: canonical worktree resolution must find no live session after cleanup.
    const feedback = runSessionCli(['feedback-json'], { appRoot, stateHome });
    assert.notEqual(feedback.status, 0);
    assert.match(feedback.stderr, /no live session matches this canonical worktree and app root/);
  } finally {
    if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousStateHome;
    rmSync(root, { force: true, recursive: true });
  }
});
