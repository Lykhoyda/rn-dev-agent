import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { canonicalAuthorityJson } from '../../../dist/session/authority-json.js';
import { openSessionRegistry } from '../../../dist/session/registry.js';
import { resolveSourceIdentity } from '../../../dist/session/source-identity.js';
import { createAuthorityStateLayout } from '../../../dist/session/state-root.js';
import { writeSessionSecret } from '../../../dist/session/state-root.js';
import { readProcessBirth } from '../../../dist/session/process-birth.js';

const cliPath = new URL('../../../dist/rn-session.js', import.meta.url).pathname;
// GH #706: the CLI resolves live worktree sessions with the real owner probe, so a
// fixture supervisor must carry this process's real birth token, not a placeholder.
const supervisorBirthToken = readProcessBirth(process.pid)?.token ?? 'fixture';

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
    supervisor: { pid: process.pid, token: supervisorBirthToken },
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

test('package-local CLI status persists lost managed Metro reconciliation', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-cli-metro-status-'));
  const appRoot = join(root, 'app');
  const stateHome = join(root, 'state');
  const previousStateHome = process.env.XDG_STATE_HOME;
  try {
    execFileSync('git', ['init', '-q', appRoot]);
    execFileSync('git', ['-C', appRoot, 'config', 'user.email', 'test@example.invalid']);
    execFileSync('git', ['-C', appRoot, 'config', 'user.name', 'Test']);
    writeFileSync(join(appRoot, 'package.json'), '{}\n');
    execFileSync('git', ['-C', appRoot, 'add', 'package.json']);
    execFileSync('git', ['-C', appRoot, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture']);

    process.env.XDG_STATE_HOME = stateHome;
    const source = resolveSourceIdentity(appRoot);
    const layout = createAuthorityStateLayout();
    let registry = openSessionRegistry(layout.registry, { ownerStatus: () => 'match' });
    const session = registry.createSession({
      sessionId: 'session-lost-metro',
      sourceKey: source.sourceKey,
      worktreeKey: source.worktreeKey,
      appRootKey: source.appRootKey,
      supervisor: { pid: process.pid, token: supervisorBirthToken },
      source: { ...source },
      bindings: {
        metroPort: 8193,
        metro: { mode: 'managed', port: 8193, instanceId: 'lost-metro' },
      },
    });
    registry.updateBindings(session, { state: 'device_claimed', bindings: {} });
    registry.close();
    writeSessionSecret(layout, session.sessionId, {
      signerCapability: 'signer',
      observeCapability: 'observe',
      recoveryCapability: 'recovery',
    });

    const result = spawnSync(process.execPath, [cliPath, 'status'], {
      cwd: appRoot,
      env: {
        ...process.env,
        XDG_STATE_HOME: stateHome,
        RN_DEV_AGENT_SESSION_ID: session.sessionId,
      },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const projected = JSON.parse(result.stdout);
    assert.equal(projected.metroBound, false);
    assert.equal(projected.metroTerminal.code, 'METRO_MANAGEMENT_PROOF_INVALID');

    registry = openSessionRegistry(layout.registry, { ownerStatus: () => 'match' });
    const reconciled = registry.getSessionStatus(session.sessionId);
    registry.close();
    assert.equal(reconciled?.bindings.metro, null);
    assert.deepEqual(reconciled?.bindings.metroCleanup, {
      mode: 'managed',
      port: 8193,
      instanceId: 'lost-metro',
    });
  } finally {
    if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousStateHome;
    rmSync(root, { force: true, recursive: true });
  }
});

test('package-local CLI clears authenticated retained cleanup before replacement startup', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-cli-metro-cleanup-'));
  const appRoot = join(root, 'app');
  const stateHome = join(root, 'state');
  const previousStateHome = process.env.XDG_STATE_HOME;
  try {
    execFileSync('git', ['init', '-q', appRoot]);
    execFileSync('git', ['-C', appRoot, 'config', 'user.email', 'test@example.invalid']);
    execFileSync('git', ['-C', appRoot, 'config', 'user.name', 'Test']);
    writeFileSync(join(appRoot, 'package.json'), '{}\n');
    execFileSync('git', ['-C', appRoot, 'add', 'package.json']);
    execFileSync('git', ['-C', appRoot, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture']);
    mkdirSync(join(appRoot, '.rn-agent', 'integration'), { recursive: true });
    writeFileSync(
      join(appRoot, '.rn-agent', 'integration', 'rn-session-integration.json'),
      '{"version":1}\n',
    );

    const portProbe = createServer();
    await new Promise<void>((resolve, reject) => {
      portProbe.once('error', reject);
      portProbe.listen(0, '127.0.0.1', resolve);
    });
    const address = portProbe.address();
    assert.ok(address && typeof address !== 'string');
    await new Promise<void>((resolve) => portProbe.close(() => resolve()));

    process.env.XDG_STATE_HOME = stateHome;
    const source = resolveSourceIdentity(appRoot);
    const layout = createAuthorityStateLayout();
    let registry = openSessionRegistry(layout.registry, {
      ownerStatus: () => 'match',
      listenerStatus: () => 'absent',
    });
    const sessionId = 'session-cleanup';
    const signerCapability = 'signer';
    const cleanupAuthority = {
      port: address.port,
      pid: 2_147_483_646,
      birth: 'listener-birth',
      launcherPid: 2_147_483_646,
      launcherBirth: 'launcher-birth',
      instanceId: 'retained-metro',
      runtimeEvidencePath: join(root, 'runtime-evidence.jsonl'),
      runtimeEvidenceSocket: `/tmp/rn-dev-agent-${'a'.repeat(32)}.sock`,
      runtimeEvidenceAuthority: 'reported-v1',
      runtimeEvidenceProtocol: 2,
      servingRoot: appRoot,
      buildGeneration: 2,
    };
    const metroCleanup = {
      mode: 'managed',
      ...cleanupAuthority,
      managementProof: createHmac('sha256', signerCapability)
        .update(canonicalAuthorityJson({ sessionId, ...cleanupAuthority }))
        .digest('hex'),
    };
    const session = registry.createSession({
      sessionId,
      sourceKey: source.sourceKey,
      worktreeKey: source.worktreeKey,
      appRootKey: source.appRootKey,
      supervisor: { pid: process.pid, token: supervisorBirthToken },
      source: { ...source },
      bindings: {
        metroPort: address.port,
        device: { platform: 'ios', deviceId: 'SIM-1', appId: 'dev.example' },
        metroCleanup,
      },
    });
    registry.updateBindings(session, { state: 'device_claimed', bindings: {} });
    registry.close();
    writeSessionSecret(layout, session.sessionId, {
      signerCapability,
      observeCapability: 'observe',
      recoveryCapability: 'recovery',
    });

    const result = spawnSync(process.execPath, [cliPath, 'ensure-metro'], {
      cwd: appRoot,
      env: {
        ...process.env,
        XDG_STATE_HOME: stateHome,
        RN_DEV_AGENT_SESSION_ID: session.sessionId,
      },
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /project is neither Expo nor bare React Native/);

    registry = openSessionRegistry(layout.registry, {
      ownerStatus: () => 'match',
      listenerStatus: () => 'absent',
    });
    const status = registry.getSessionStatus(session.sessionId);
    registry.close();
    assert.equal(status?.bindings.metroCleanup, null);
    assert.equal(status?.bindings.metro, undefined);
  } finally {
    if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousStateHome;
    rmSync(root, { force: true, recursive: true });
  }
});

test('package-local CLI does not discover a sibling app session in the same worktree', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-cli-monorepo-'));
  const appA = join(root, 'apps', 'a');
  const appB = join(root, 'apps', 'b');
  const stateHome = join(root, 'state');
  mkdirSync(appA, { recursive: true });
  mkdirSync(appB, { recursive: true });
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.invalid']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Test']);
  writeFileSync(join(appA, 'package.json'), '{}\n');
  writeFileSync(join(appB, 'package.json'), '{}\n');
  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', ['-C', root, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture']);

  const previousStateHome = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = stateHome;
  const sourceA = resolveSourceIdentity(appA);
  const layout = createAuthorityStateLayout();
  const registry = openSessionRegistry(layout.registry, { ownerStatus: () => 'match' });
  registry.createSession({
    sessionId: 'session-app-a',
    sourceKey: sourceA.sourceKey,
    worktreeKey: sourceA.worktreeKey,
    appRootKey: sourceA.appRootKey,
    supervisor: { pid: process.pid, token: supervisorBirthToken },
    source: { ...sourceA },
  });
  registry.close();

  const result = spawnSync(process.execPath, [cliPath, 'status'], {
    cwd: appB,
    env: { ...process.env, XDG_STATE_HOME: stateHome },
    encoding: 'utf8',
  });

  if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = previousStateHome;
  rmSync(root, { force: true, recursive: true });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /no live session matches this canonical worktree and app root/);
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
    supervisor: { pid: process.pid, token: supervisorBirthToken },
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
    supervisor: { pid: process.pid, token: supervisorBirthToken },
    source: { ...source },
    bindings: {
      metroPort: 8193,
      device: { platform: 'ios', deviceId: 'SIM-1', appId: 'dev.example' },
    },
  });
  registry.updateBindings(session, { state: 'device_claimed', bindings: {} });
  registry.close();
  writeSessionSecret(layout, session.sessionId, {
    signerCapability: 'signer',
    observeCapability: 'observe',
    recoveryCapability: 'recovery',
  });

  const result = spawnSync(process.execPath, [cliPath, 'ensure-metro'], {
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

test('package-local CLI refuses external Metro for managed startup and builds', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-cli-external-metro-'));
  const appRoot = join(root, 'app');
  const stateHome = join(root, 'state');
  const previousStateHome = process.env.XDG_STATE_HOME;
  let metro: ReturnType<typeof spawn> | undefined;
  try {
    execFileSync('git', ['init', '-q', appRoot]);
    execFileSync('git', ['-C', appRoot, 'config', 'user.email', 'test@example.invalid']);
    execFileSync('git', ['-C', appRoot, 'config', 'user.name', 'Test']);
    writeFileSync(join(appRoot, 'package.json'), '{}\n');
    execFileSync('git', ['-C', appRoot, 'add', 'package.json']);
    execFileSync('git', ['-C', appRoot, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture']);
    mkdirSync(join(appRoot, '.rn-agent', 'integration'), { recursive: true });
    writeFileSync(
      join(appRoot, '.rn-agent', 'integration', 'rn-session-integration.json'),
      '{"version":1}\n',
    );

    metro = spawn(
      process.execPath,
      [
        '-e',
        "require('node:http').createServer((req,res)=>res.end('packager-status:running')).listen(0,'127.0.0.1',function(){process.stdout.write(String(this.address().port)+'\\n')})",
      ],
      { cwd: appRoot, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const port = await new Promise<number>((resolve, reject) => {
      metro!.once('error', reject);
      metro!.stdout!.once('data', (chunk) => resolve(Number(String(chunk).trim())));
    });
    const metroPid = metro.pid;
    assert.ok(metroPid);
    const metroBirth = readProcessBirth(metroPid);
    assert.ok(metroBirth);

    process.env.XDG_STATE_HOME = stateHome;
    const source = resolveSourceIdentity(appRoot);
    const layout = createAuthorityStateLayout();
    const registry = openSessionRegistry(layout.registry, { ownerStatus: () => 'match' });
    const session = registry.createSession({
      sessionId: 'session-external-metro',
      sourceKey: source.sourceKey,
      worktreeKey: source.worktreeKey,
      appRootKey: source.appRootKey,
      supervisor: { pid: process.pid, token: supervisorBirthToken },
      source: { ...source },
      bindings: {
        metroPort: port,
        device: { platform: 'ios', deviceId: 'SIM-1', appId: 'dev.example' },
        metro: {
          mode: 'external',
          port,
          pid: metroPid,
          birth: metroBirth.token,
          instanceId: 'external-metro',
          servingRoot: appRoot,
          buildGeneration: 1,
        },
      },
    });
    registry.updateBindings(session, { state: 'device_claimed', bindings: {} });
    registry.close();
    writeSessionSecret(layout, session.sessionId, {
      signerCapability: 'signer',
      observeCapability: 'observe',
      recoveryCapability: 'recovery',
    });

    for (const args of [
      ['ensure-metro'],
      ['prepare-build', 'ios', 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', 'expo'],
    ]) {
      const result = spawnSync(process.execPath, [cliPath, ...args], {
        cwd: appRoot,
        env: {
          ...process.env,
          XDG_STATE_HOME: stateHome,
          RN_DEV_AGENT_SESSION_ID: session.sessionId,
        },
        encoding: 'utf8',
      });

      assert.notEqual(result.status, 0);
      assert.match(
        result.stderr,
        /authenticated managed authority|lifecycle evidence is not authenticated/,
      );
    }
  } finally {
    if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousStateHome;
    metro?.kill('SIGKILL');
    rmSync(root, { force: true, recursive: true });
  }
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
    supervisor: { pid: process.pid, token: supervisorBirthToken },
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

test('package-local CLI reserves Metro, build, and release operations before cleanup', async () => {
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
    mkdirSync(join(appRoot, '.rn-agent', 'integration'), { recursive: true });
    writeFileSync(
      join(appRoot, '.rn-agent', 'integration', 'rn-session-integration.json'),
      '{"version":1}\n',
    );

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
      supervisor: { pid: process.pid, token: supervisorBirthToken },
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
      ['prepare-build', 'ios', 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', 'expo'],
      ['ensure-metro'],
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
      assert.match(
        result.stderr,
        args[0] === 'prepare-build'
          ? /managed Metro lifecycle evidence is not authenticated/
          : /OPERATION_ALREADY_IN_PROGRESS/,
      );
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
