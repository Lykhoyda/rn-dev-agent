import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { applyPackageIntegration } from '../../dist/session/package-integration.js';
import { applyInheritance } from '../../dist/session/worktree-inheritance.js';
import { startSupervisor } from '../helpers/supervisor-harness.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CORE_ROOT = join(HERE, '..', '..');
const REPAIR_CLI = join(CORE_ROOT, 'dist', 'worktree-inheritance.js');
const HISTORICAL_RELINK = join(CORE_ROOT, 'test', 'fixtures', 'gh-802-historical-relink.ts');

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return String(result.stdout).trim();
}

async function handshake(supervisor: ReturnType<typeof startSupervisor>): Promise<void> {
  const id = supervisor.send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'gh802-client', version: '0.0.0' },
  });
  const reply = JSON.parse(await supervisor.nextLine());
  assert.equal(reply.id, id);
  supervisor.notify('notifications/initialized');
}

async function sessionStatus(supervisor: ReturnType<typeof startSupervisor>) {
  const id = supervisor.send('tools/call', {
    name: 'rn_session',
    arguments: { action: 'status' },
  });
  const reply = JSON.parse(await supervisor.nextLine());
  assert.equal(reply.id, id);
  return JSON.parse(reply.result?.content?.[0]?.text ?? '{}');
}

async function stop(supervisor: ReturnType<typeof startSupervisor>): Promise<void> {
  const exited = new Promise<void>((resolve) => supervisor.child.once('exit', () => resolve()));
  supervisor.child.kill('SIGTERM');
  await exited;
}

function runPackageScript(appRoot: string, platform: 'ios' | 'android', binRoot: string) {
  return spawnSync('npm', ['run', platform, '--silent'], {
    cwd: appRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${binRoot}:${process.env.PATH ?? ''}`,
      RN_FIXTURE_NATIVE_LOG: join(appRoot, 'native-invocations.log'),
    },
  });
}

function requireMetro(appRoot: string) {
  return spawnSync(process.execPath, ['-e', "require('./metro.config.js')"], {
    cwd: appRoot,
    encoding: 'utf8',
  });
}

function runSessionStartHook(appRoot: string, fixtureRoot: string) {
  const pluginRoot = join(fixtureRoot, 'session-start-plugin');
  const hooks = join(pluginRoot, 'hooks');
  const scripts = join(pluginRoot, 'scripts');
  mkdirSync(hooks, { recursive: true });
  mkdirSync(scripts, { recursive: true });
  copyFileSync(
    join(CORE_ROOT, '..', 'claude-plugin', 'hooks', 'detect-rn-project.sh'),
    join(hooks, 'detect-rn-project.sh'),
  );
  mkdirSync(join(pluginRoot, '.claude-plugin'));
  writeFileSync(join(pluginRoot, '.claude-plugin', 'plugin.json'), '{"version":"fixture"}\n');
  symlinkSync(CORE_ROOT, join(pluginRoot, 'rn-dev-agent-core'), 'dir');
  for (const name of [
    'ensure-cdp-deps.sh',
    'ensure-maestro-runner.sh',
    'ensure-idb-companion.sh',
    'ensure-ffmpeg.sh',
    'ensure-idb.sh',
    'ensure-android-ready.sh',
  ]) {
    writeFileSync(join(scripts, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  }
  writeFileSync(
    join(scripts, 'ensure-troubleshooting-doc.sh'),
    '#!/bin/sh\nmkdir -p "$1/.rn-agent/local"\nprintf MUTATED > "$1/.rn-agent/local/session-start-mutated"\n',
    { mode: 0o755 },
  );
  writeFileSync(join(scripts, 'mcp-bridge-probe.mjs'), '');
  return spawnSync('bash', [join(hooks, 'detect-rn-project.sh')], {
    cwd: appRoot,
    encoding: 'utf8',
    env: { ...process.env, TMPDIR: join(fixtureRoot, 'session-start-tmp') },
  });
}

test(
  'GH#802: reconnect detects historical root relink and explicit repair restores package integration',
  { timeout: 180_000 },
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'rn-agent-gh802-')));
    const primary = join(root, 'primary');
    const linked = join(root, 'linked');
    const stateHome = join(root, 'same-reconnect-state');
    const previousStateHome = process.env.XDG_STATE_HOME;
    let supervisor: ReturnType<typeof startSupervisor> | null = null;
    try {
      process.env.XDG_STATE_HOME = stateHome;
      mkdirSync(primary);
      git(root, ['init', '-q', primary]);
      git(primary, ['config', 'user.email', 'fixture@example.test']);
      git(primary, ['config', 'user.name', 'fixture']);
      git(primary, ['config', 'commit.gpgsign', 'false']);
      writeFileSync(
        join(primary, 'package.json'),
        `${JSON.stringify({
          name: 'gh802-app',
          version: '0.0.0',
          scripts: {
            ios: 'npx react-native run-ios',
            android: 'npx react-native run-android',
          },
          dependencies: { 'react-native': '0.76.0' },
        })}\n`,
      );
      writeFileSync(join(primary, 'metro.config.js'), 'module.exports = {};\n');
      writeFileSync(join(primary, '.gitignore'), '/.rn-agent\n');
      writeFileSync(
        join(primary, 'fake-session.cjs'),
        "const a=process.argv.slice(2);if(a[0]==='prepare-build'){process.stdout.write(JSON.stringify({platform:a[1],deviceId:a[1]==='ios'?'ios-sim':'android-device',appId:'dev.fixture',metroPort:8341,sessionId:'session',buildToken:a[2],simulator:a[1]==='ios'}))}else if(a[0]==='abort-build'){process.stdout.write('{\"aborted\":true}')}else{process.stdout.write('{\"receipt\":true}')}\n",
      );
      mkdirSync(join(primary, 'fixture-bin'));
      writeFileSync(
        join(primary, 'fixture-bin', 'npx'),
        '#!/bin/sh\nprintf "%s\\n" "$*" >> "$RN_FIXTURE_NATIVE_LOG"\nexit 0\n',
      );
      chmodSync(join(primary, 'fixture-bin', 'npx'), 0o755);
      git(primary, ['add', '-A']);
      git(primary, ['commit', '-qm', 'fixture']);

      mkdirSync(join(primary, '.rn-agent', 'actions'), { recursive: true });
      writeFileSync(join(primary, '.rn-agent', 'actions', 'shared.yaml'), 'appId: fixture\n');
      git(primary, ['worktree', 'add', '-q', linked, '-b', 'linked']);
      const inheritance = applyInheritance({
        cwd: linked,
        appRoot: linked,
        host: 'claude',
      });
      assert.equal(inheritance.applied, 1, JSON.stringify(inheritance));
      mkdirSync(join(linked, '.rn-agent', 'local'), { recursive: true });
      writeFileSync(join(linked, '.rn-agent', 'local', 'troubleshooting.md'), 'KEEP-LOCAL\n');
      applyPackageIntegration({
        appRoot: linked,
        sessionCli: join(linked, 'fake-session.cjs'),
        stateDir: join(stateHome, 'rn-dev-agent'),
      });

      assert.equal(requireMetro(linked).status, 0);
      for (const platform of ['ios', 'android'] as const) {
        const result = runPackageScript(linked, platform, join(linked, 'fixture-bin'));
        assert.equal(result.status, 0, `${platform}: ${result.stderr}`);
      }

      for (let attempt = 0; attempt < 2; attempt += 1) {
        supervisor = startSupervisor({
          cwd: linked,
          env: { XDG_STATE_HOME: stateHome },
          lineTimeoutMs: 30_000,
        });
        await handshake(supervisor);
        const status = await sessionStatus(supervisor);
        assert.equal(status.ok, true, JSON.stringify(status));
        assert.equal(lstatSync(join(linked, '.rn-agent')).isSymbolicLink(), false);
        await stop(supervisor);
        supervisor = null;
      }

      const relink = spawnSync(process.execPath, [HISTORICAL_RELINK, primary, linked], {
        cwd: linked,
        encoding: 'utf8',
      });
      assert.equal(relink.status, 0, relink.stderr);
      assert.equal(lstatSync(join(linked, '.rn-agent')).isSymbolicLink(), true);
      assert.equal(existsSync(join(linked, '.rn-agent.bak', 'integration')), true);

      assert.notEqual(requireMetro(linked).status, 0);
      for (const platform of ['ios', 'android'] as const) {
        const result = runPackageScript(linked, platform, join(linked, 'fixture-bin'));
        assert.notEqual(result.status, 0);
        assert.match(
          `${result.stdout}\n${result.stderr}`,
          /rn-session-adapter\.cjs|MODULE_NOT_FOUND/,
        );
      }

      mkdirSync(join(root, 'session-start-tmp'));
      const sessionStart = runSessionStartHook(linked, root);
      assert.equal(sessionStart.status, 0, sessionStart.stderr);
      assert.match(sessionStart.stdout, /RN_AGENT_LEGACY_ROOT_REPAIR_REQUIRED/);
      assert.equal(existsSync(join(primary, '.rn-agent', 'local', 'session-start-mutated')), false);
      assert.equal(
        readFileSync(join(linked, '.rn-agent.bak', 'local', 'troubleshooting.md'), 'utf8'),
        'KEEP-LOCAL\n',
      );

      supervisor = startSupervisor({
        cwd: linked,
        env: { XDG_STATE_HOME: stateHome },
        lineTimeoutMs: 30_000,
      });
      await handshake(supervisor);
      const damagedStatus = await sessionStatus(supervisor);
      assert.match(JSON.stringify(damagedStatus), /SESSION_INTEGRATION_PATH_UNSAFE/);
      assert.match(supervisor.stderrText(), /RN_AGENT_LEGACY_ROOT_REPAIR_REQUIRED/);
      assert.equal(lstatSync(join(linked, '.rn-agent')).isSymbolicLink(), true);
      await stop(supervisor);
      supervisor = null;

      const repair = spawnSync(
        process.execPath,
        [REPAIR_CLI, 'repair', '--app-root', linked, '--json'],
        { cwd: linked, encoding: 'utf8' },
      );
      assert.equal(repair.status, 0, repair.stderr);
      assert.equal(JSON.parse(repair.stdout).code, 'RN_AGENT_LEGACY_ROOT_REPAIR_COMPLETED');
      assert.equal(lstatSync(join(linked, '.rn-agent')).isSymbolicLink(), false);
      assert.equal(lstatSync(join(linked, '.rn-agent', 'integration')).isSymbolicLink(), false);
      assert.equal(lstatSync(join(linked, '.rn-agent', 'local')).isSymbolicLink(), false);
      assert.equal(
        readFileSync(join(linked, '.rn-agent', 'local', 'troubleshooting.md'), 'utf8'),
        'KEEP-LOCAL\n',
      );
      assert.equal(
        realpathSync(join(linked, '.rn-agent', 'actions')),
        realpathSync(join(primary, '.rn-agent', 'actions')),
      );

      assert.equal(requireMetro(linked).status, 0);
      for (const platform of ['ios', 'android'] as const) {
        const result = runPackageScript(linked, platform, join(linked, 'fixture-bin'));
        assert.equal(result.status, 0, `${platform}: ${result.stderr}`);
      }

      const repeated = spawnSync(
        process.execPath,
        [REPAIR_CLI, 'repair', '--app-root', linked, '--json'],
        { cwd: linked, encoding: 'utf8' },
      );
      assert.equal(repeated.status, 0, repeated.stderr);
      assert.equal(JSON.parse(repeated.stdout).status, 'unchanged');

      writeFileSync(join(primary, '.rn-agent', 'actions', 'after-repair.yaml'), 'appId: fixture\n');
      assert.equal(
        readFileSync(join(linked, '.rn-agent', 'actions', 'after-repair.yaml'), 'utf8'),
        'appId: fixture\n',
      );

      supervisor = startSupervisor({
        cwd: linked,
        env: { XDG_STATE_HOME: stateHome },
        lineTimeoutMs: 30_000,
      });
      await handshake(supervisor);
      const repairedStatus = await sessionStatus(supervisor);
      assert.equal(repairedStatus.ok, true, JSON.stringify(repairedStatus));
    } finally {
      if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = previousStateHome;
      supervisor?.child.kill('SIGTERM');
      try {
        git(primary, ['worktree', 'remove', '--force', linked]);
      } catch {
        // The isolated repository is removed below.
      }
      rmSync(root, { recursive: true, force: true });
    }
  },
);
