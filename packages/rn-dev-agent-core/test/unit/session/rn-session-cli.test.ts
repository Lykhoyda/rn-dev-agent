import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openSessionRegistry } from '../../../dist/session/registry.js';
import { resolveSourceIdentity } from '../../../dist/session/source-identity.js';
import { createAuthorityStateLayout } from '../../../dist/session/state-root.js';
import { writeSessionSecret } from '../../../dist/session/state-root.js';
import { readProcessBirth } from '../../../dist/session/process-birth.js';

const cliPath = new URL('../../../dist/rn-session.js', import.meta.url).pathname;

test('package-local CLI resolves one exact worktree session for literal build scripts', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-cli-'));
  const appRoot = join(root, 'app');
  const stateHome = join(root, 'state');
  execFileSync('git', ['init', '-q', appRoot]);
  execFileSync('git', ['-C', appRoot, 'config', 'user.email', 'test@example.invalid']);
  execFileSync('git', ['-C', appRoot, 'config', 'user.name', 'Test']);
  writeFileSync(join(appRoot, 'package.json'), '{}\n');
  execFileSync('git', ['-C', appRoot, 'add', 'package.json']);
  execFileSync('git', ['-C', appRoot, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture']);

  const previousStateHome = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = stateHome;
  const source = resolveSourceIdentity(appRoot);
  const layout = createAuthorityStateLayout();
  const registry = openSessionRegistry(layout.registry, { ownerStatus: () => 'match' });
  const session = registry.createSession({
    sessionId: 'session-cli',
    sourceKey: source.sourceKey,
    worktreeKey: source.worktreeKey,
    appRootKey: source.appRootKey,
    supervisor: { pid: process.pid, token: 'fixture' },
    source: { ...source },
    bindings: { metroPort: 8193 },
  });
  registry.updateBindings(session, {
    state: 'device_claimed',
    bindings: {
      device: { platform: 'ios', deviceId: 'SIM-1', appId: 'dev.example' },
    },
  });
  registry.close();

  const result = spawnSync(process.execPath, [cliPath, 'build-json'], {
    cwd: appRoot,
    env: { ...process.env, XDG_STATE_HOME: stateHome },
    encoding: 'utf8',
  });

  if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = previousStateHome;
  rmSync(root, { force: true, recursive: true });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    platform: 'ios',
    deviceId: 'SIM-1',
    appId: 'dev.example',
    metroPort: 8193,
    sessionId: 'session-cli',
  });
});

test('package-local CLI rejects an explicit session from another worktree', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-cli-foreign-'));
  const appRoot = join(root, 'app');
  const stateHome = join(root, 'state');
  execFileSync('git', ['init', '-q', appRoot]);
  execFileSync('git', ['-C', appRoot, 'config', 'user.email', 'test@example.invalid']);
  execFileSync('git', ['-C', appRoot, 'config', 'user.name', 'Test']);
  writeFileSync(join(appRoot, 'package.json'), '{}\n');
  execFileSync('git', ['-C', appRoot, 'add', 'package.json']);
  execFileSync('git', ['-C', appRoot, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture']);

  const previousStateHome = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = stateHome;
  const source = resolveSourceIdentity(appRoot);
  const layout = createAuthorityStateLayout();
  const registry = openSessionRegistry(layout.registry, { ownerStatus: () => 'match' });
  registry.createSession({
    sessionId: 'foreign-session',
    sourceKey: source.sourceKey,
    worktreeKey: 'foreign-worktree',
    appRootKey: source.appRootKey,
    supervisor: { pid: process.pid, token: 'fixture' },
    source: { ...source, worktreeKey: 'foreign-worktree' },
  });
  registry.close();

  const result = spawnSync(process.execPath, [cliPath, 'status'], {
    cwd: appRoot,
    env: {
      ...process.env,
      XDG_STATE_HOME: stateHome,
      RN_DEV_AGENT_SESSION_ID: 'foreign-session',
    },
    encoding: 'utf8',
  });

  if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = previousStateHome;
  rmSync(root, { force: true, recursive: true });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /explicit session belongs to a different canonical worktree/);
});

test('package-local CLI refuses marker writes through a replaced .rn-agent symlink', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-cli-marker-'));
  const appRoot = join(root, 'app');
  const external = join(root, 'external');
  const stateHome = join(root, 'state');
  execFileSync('git', ['init', '-q', appRoot]);
  execFileSync('git', ['-C', appRoot, 'config', 'user.email', 'test@example.invalid']);
  execFileSync('git', ['-C', appRoot, 'config', 'user.name', 'Test']);
  writeFileSync(join(appRoot, 'package.json'), '{}\n');
  execFileSync('git', ['-C', appRoot, 'add', 'package.json']);
  execFileSync('git', ['-C', appRoot, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture']);
  mkdirSync(join(external, 'integration'), { recursive: true });
  symlinkSync(external, join(appRoot, '.rn-agent'));

  const previousStateHome = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = stateHome;
  const source = resolveSourceIdentity(appRoot);
  const layout = createAuthorityStateLayout();
  const registry = openSessionRegistry(layout.registry, { ownerStatus: () => 'match' });
  const session = registry.createSession({
    sessionId: 'session-marker',
    sourceKey: source.sourceKey,
    worktreeKey: source.worktreeKey,
    appRootKey: source.appRootKey,
    supervisor: { pid: process.pid, token: 'fixture' },
    source: { ...source },
    bindings: {
      metroPort: 8193,
      device: { platform: 'ios', deviceId: 'SIM-1', appId: 'dev.example' },
      metro: { instanceId: 'metro-a', buildGeneration: 1 },
    },
  });
  registry.updateBindings(session, { state: 'device_claimed', bindings: {} });
  registry.close();
  writeSessionSecret(layout, session.sessionId, {
    signerCapability: 'signer',
    observeCapability: 'observe',
    recoveryCapability: 'recovery',
  });

  const result = spawnSync(process.execPath, [cliPath, 'prepare-build', 'ios'], {
    cwd: appRoot,
    env: {
      ...process.env,
      XDG_STATE_HOME: stateHome,
      RN_DEV_AGENT_SESSION_ID: session.sessionId,
    },
    encoding: 'utf8',
  });

  if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = previousStateHome;
  const wroteExternalMarker = existsSync(join(external, 'integration', 'authority-marker.js'));
  rmSync(root, { force: true, recursive: true });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SESSION_INTEGRATION_PATH_UNSAFE/);
  assert.equal(wroteExternalMarker, false);
});

test('package-local CLI retains claims when managed Metro cleanup is unproven', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-cli-release-'));
  const appRoot = join(root, 'app');
  const stateHome = join(root, 'state');
  execFileSync('git', ['init', '-q', appRoot]);
  execFileSync('git', ['-C', appRoot, 'config', 'user.email', 'test@example.invalid']);
  execFileSync('git', ['-C', appRoot, 'config', 'user.name', 'Test']);
  writeFileSync(join(appRoot, 'package.json'), '{}\n');
  execFileSync('git', ['-C', appRoot, 'add', 'package.json']);
  execFileSync('git', ['-C', appRoot, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture']);

  const previousStateHome = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = stateHome;
  const source = resolveSourceIdentity(appRoot);
  const layout = createAuthorityStateLayout();
  let registry = openSessionRegistry(layout.registry, { ownerStatus: () => 'match' });
  const session = registry.createSession({
    sessionId: 'session-release',
    sourceKey: source.sourceKey,
    worktreeKey: source.worktreeKey,
    appRootKey: source.appRootKey,
    supervisor: { pid: process.pid, token: 'fixture' },
    source: { ...source },
    bindings: {
      metroPort: 8193,
      metro: { mode: 'managed' },
    },
  });
  registry.updateBindings(session, { state: 'source_bound', bindings: {} });
  registry.close();
  writeSessionSecret(layout, session.sessionId, {
    signerCapability: 'signer',
    observeCapability: 'observe',
    recoveryCapability: 'recovery',
  });

  const result = spawnSync(process.execPath, [cliPath, 'release'], {
    cwd: appRoot,
    env: {
      ...process.env,
      XDG_STATE_HOME: stateHome,
      RN_DEV_AGENT_SESSION_ID: session.sessionId,
      RN_DEV_AGENT_CLAIM_EPOCH: String(session.claimEpoch),
    },
    encoding: 'utf8',
  });
  registry = openSessionRegistry(layout.registry, { ownerStatus: () => 'match' });
  const status = registry.getSessionStatus(session.sessionId);
  registry.close();

  if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = previousStateHome;
  rmSync(root, { force: true, recursive: true });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /METRO_AUTHORITY_MISMATCH/);
  assert.equal(status?.state, 'source_bound');
});

test('package-local CLI reserves build and release operations before runner cleanup', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-cli-operation-'));
  const appRoot = join(root, 'app');
  const stateHome = join(root, 'state');
  const previousStateHome = process.env.XDG_STATE_HOME;
  const runner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  await new Promise<void>((resolve, reject) => {
    runner.once('spawn', resolve);
    runner.once('error', reject);
  });
  try {
    execFileSync('git', ['init', '-q', appRoot]);
    execFileSync('git', ['-C', appRoot, 'config', 'user.email', 'test@example.invalid']);
    execFileSync('git', ['-C', appRoot, 'config', 'user.name', 'Test']);
    writeFileSync(join(appRoot, 'package.json'), '{}\n');
    execFileSync('git', ['-C', appRoot, 'add', 'package.json']);
    execFileSync('git', ['-C', appRoot, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture']);

    const runnerPid = runner.pid;
    const runnerBirth = runnerPid === undefined ? null : readProcessBirth(runnerPid);
    assert.ok(runnerPid);
    assert.ok(runnerBirth);
    process.env.XDG_STATE_HOME = stateHome;
    const source = resolveSourceIdentity(appRoot);
    const layout = createAuthorityStateLayout();
    let registry = openSessionRegistry(layout.registry, { ownerStatus: () => 'match' });
    const session = registry.createSession({
      sessionId: 'session-operation',
      sourceKey: source.sourceKey,
      worktreeKey: source.worktreeKey,
      appRootKey: source.appRootKey,
      supervisor: { pid: process.pid, token: 'fixture' },
      source: { ...source },
      bindings: {
        metroPort: 8193,
        device: { platform: 'ios', deviceId: 'SIM-1', appId: 'dev.example' },
        metro: { instanceId: 'metro-a', buildGeneration: 1 },
        runner: {
          platform: 'ios',
          deviceId: 'SIM-1',
          port: 9100,
          pid: runnerPid,
          processBirth: runnerBirth.token,
          instanceId: 'runner-a',
          capability: 'runner-capability',
        },
      },
    });
    registry.claimResources(session, [{ type: 'runner', key: 'ios:SIM-1:9100' }]);
    registry.updateBindings(session, { state: 'device_claimed', bindings: {} });
    const operation = registry.beginOperation(session, {
      operationId: 'active-operation',
      tool: 'device_interact',
      profile: 'native',
    });
    registry.close();
    writeSessionSecret(layout, session.sessionId, {
      signerCapability: 'signer',
      observeCapability: 'observe',
      recoveryCapability: 'recovery',
    });

    for (const args of [
      ['prepare-build', 'ios'],
      ['release'],
    ]) {
      const result = spawnSync(process.execPath, [cliPath, ...args], {
        cwd: appRoot,
        env: {
          ...process.env,
          XDG_STATE_HOME: stateHome,
          RN_DEV_AGENT_SESSION_ID: session.sessionId,
          RN_DEV_AGENT_CLAIM_EPOCH: String(session.claimEpoch),
        },
        encoding: 'utf8',
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /OPERATION_ALREADY_IN_PROGRESS/);
      assert.doesNotThrow(() => process.kill(runnerPid, 0));
    }

    registry = openSessionRegistry(layout.registry, { ownerStatus: () => 'match' });
    registry.cancelOperation(operation);
    registry.close();
  } finally {
    if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousStateHome;
    runner.kill('SIGKILL');
    rmSync(root, { force: true, recursive: true });
  }
});
