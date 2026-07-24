import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openSessionRegistry } from '../../../dist/session/registry.js';
import { resolveSourceIdentity } from '../../../dist/session/source-identity.js';
import { createAuthorityStateLayout } from '../../../dist/session/state-root.js';

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
