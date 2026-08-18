import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, test } from 'node:test';
import { createSessionHandler } from '../../../dist/tools/session.js';
import { SessionAuthorityError } from '../../../dist/session/registry.js';
import { resolveSourceIdentity } from '../../../dist/session/source-identity.js';
import { declaredSourceContractFromEnv } from '../../../dist/session/declared-source-contract.js';
import {
  consumeSuccessorSourceDeclaration,
  resolveSuccessorMintSource,
  resolveWorkerSpawnCwd,
  resolveWorkerSpawnRootEnvironment,
  successorSourceDeclarationPath,
  writeSuccessorSourceDeclaration,
} from '../../../dist/session/successor-source.js';

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop()!, { force: true, recursive: true });
  }
});

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return (result.stdout ?? '').trim();
}

function makeRepoWithWorktree(): { primary: string; linked: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'rn-gh776-')));
  roots.push(root);
  const primary = join(root, 'primary');
  mkdirSync(primary, { recursive: true });
  git(root, ['init', '-q', primary]);
  git(primary, ['config', 'user.email', 'fixture@example.test']);
  git(primary, ['config', 'user.name', 'fixture']);
  git(primary, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(
    join(primary, 'package.json'),
    JSON.stringify({ name: 'app', dependencies: { 'react-native': '0.76.0' } }),
  );
  git(primary, ['add', '-A']);
  git(primary, ['commit', '-qm', 'init']);
  const linked = join(root, 'linked');
  git(primary, ['worktree', 'add', '-q', linked, '-b', 'linked']);
  return { primary, linked };
}

function makeMonorepoApps(): { mobile: string; other: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'rn-gh776-monorepo-')));
  roots.push(root);
  git(root, ['init', '-q', '.']);
  git(root, ['config', 'user.email', 'fixture@example.test']);
  git(root, ['config', 'user.name', 'fixture']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  const mobile = join(root, 'apps', 'mobile');
  const other = join(root, 'apps', 'other');
  for (const app of [mobile, other]) {
    mkdirSync(app, { recursive: true });
    writeFileSync(
      join(app, 'package.json'),
      JSON.stringify({ name: app, dependencies: { 'react-native': '0.76.0' } }),
    );
  }
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'init']);
  return { mobile, other };
}

function makeForeignRepo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'rn-gh776-foreign-')));
  roots.push(root);
  git(root, ['init', '-q', '.']);
  git(root, ['config', 'user.email', 'fixture@example.test']);
  git(root, ['config', 'user.name', 'fixture']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'foreign' }));
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'init']);
  return root;
}

function makeLayout(): { root: string; registry: string } {
  const stateRoot = realpathSync(mkdtempSync(join(tmpdir(), 'rn-gh776-state-')));
  roots.push(stateRoot);
  const root = join(stateRoot, 'v2');
  mkdirSync(join(root, 'sessions'), { recursive: true });
  return {
    root,
    registry: join(root, 'registry.sqlite3'),
    sessions: join(root, 'sessions'),
    runners: join(root, 'runners'),
    observe: join(root, 'observe'),
    migrations: join(root, 'migrations'),
  } as never;
}

test('successor source declarations are consumed exactly once for the declaring session', () => {
  const layout = makeLayout();
  const runtime = join(layout.root, 'sessions', 'session-1', 'runtime');
  mkdirSync(runtime, { recursive: true });
  writeSuccessorSourceDeclaration(runtime, {
    version: 1,
    projectRoot: '/tmp/declared-root',
    sourceKey: 'shared-source',
    sessionId: 'session-1',
    declaredAtMs: 123,
  });
  assert.equal(existsSync(successorSourceDeclarationPath(runtime)), true);
  const consumed = consumeSuccessorSourceDeclaration(layout as never, 'session-1');
  assert.equal(consumed?.projectRoot, '/tmp/declared-root');
  assert.equal(existsSync(successorSourceDeclarationPath(runtime)), false);
  assert.equal(consumeSuccessorSourceDeclaration(layout as never, 'session-1'), null);
});

test('a declaration written for another session is rejected and removed', () => {
  const layout = makeLayout();
  const runtime = join(layout.root, 'sessions', 'session-2', 'runtime');
  mkdirSync(runtime, { recursive: true });
  writeSuccessorSourceDeclaration(runtime, {
    version: 1,
    projectRoot: '/tmp/declared-root',
    sourceKey: 'shared-source',
    sessionId: 'other-session',
    declaredAtMs: 123,
  });
  assert.equal(consumeSuccessorSourceDeclaration(layout as never, 'session-2'), null);
  assert.equal(existsSync(successorSourceDeclarationPath(runtime)), false);
});

test('the successor mints on a declared linked worktree of the same repository', () => {
  const { primary, linked } = makeRepoWithWorktree();
  const layout = makeLayout();
  const terminalSource = resolveSourceIdentity(primary);
  const runtime = join(layout.root, 'sessions', 'terminal', 'runtime');
  mkdirSync(runtime, { recursive: true });
  writeSuccessorSourceDeclaration(runtime, {
    version: 1,
    projectRoot: linked,
    sourceKey: terminalSource.sourceKey,
    sessionId: 'terminal',
    declaredAtMs: Date.now(),
  });
  const minted = resolveSuccessorMintSource({
    terminal: {
      layout: layout as never,
      session: { sessionId: 'terminal' },
      source: terminalSource,
    },
    bootSource: terminalSource,
    resolveIdentity: (root) => resolveSourceIdentity(root),
  });
  assert.equal(minted.appRoot, realpathSync(linked));
  assert.equal(minted.sourceKey, terminalSource.sourceKey);
  assert.notEqual(minted.worktreeKey, terminalSource.worktreeKey);
});

test('a foreign-repository declaration is ignored and the terminal source is inherited', () => {
  const { primary } = makeRepoWithWorktree();
  const foreign = makeForeignRepo();
  const layout = makeLayout();
  const terminalSource = resolveSourceIdentity(primary);
  const runtime = join(layout.root, 'sessions', 'terminal', 'runtime');
  mkdirSync(runtime, { recursive: true });
  writeSuccessorSourceDeclaration(runtime, {
    version: 1,
    projectRoot: foreign,
    sourceKey: resolveSourceIdentity(foreign).sourceKey,
    sessionId: 'terminal',
    declaredAtMs: Date.now(),
  });
  const diagnostics: string[] = [];
  const minted = resolveSuccessorMintSource({
    terminal: {
      layout: layout as never,
      session: { sessionId: 'terminal' },
      source: terminalSource,
    },
    bootSource: terminalSource,
    resolveIdentity: (root) => resolveSourceIdentity(root),
    diagnostic: (message) => diagnostics.push(message),
  });
  assert.equal(minted.worktreeKey, terminalSource.worktreeKey);
  assert.equal(diagnostics.length, 1);
});

test('a released session source stays sticky for the successor without a declaration', () => {
  const { linked } = makeRepoWithWorktree();
  const layout = makeLayout();
  const worktreeSource = resolveSourceIdentity(linked);
  const bootSource = { ...worktreeSource, worktreeKey: 'boot-worktree', appRoot: '/boot' };
  const minted = resolveSuccessorMintSource({
    terminal: {
      layout: layout as never,
      session: { sessionId: 'terminal' },
      source: worktreeSource,
    },
    bootSource: bootSource as never,
    resolveIdentity: (root) => resolveSourceIdentity(root),
  });
  assert.equal(minted.worktreeKey, worktreeSource.worktreeKey);
  assert.equal(minted.appRoot, realpathSync(linked));
});

test('a declared-root successor mints on the declared app root through the env contract', () => {
  const contentRoot = realpathSync(mkdtempSync(join(tmpdir(), 'rn-gh776-declared-mint-')));
  roots.push(contentRoot);
  writeFileSync(join(contentRoot, 'package.json'), JSON.stringify({ name: 'declared-workspace' }));
  const mobile = join(contentRoot, 'apps', 'mobile');
  const other = join(contentRoot, 'apps', 'other');
  for (const app of [mobile, other]) mkdirSync(app, { recursive: true });
  const env = {
    RN_DEV_AGENT_DECLARED_ROOT: contentRoot,
    RN_DEV_AGENT_DECLARED_MANIFESTS: 'package.json',
  };
  const contract = declaredSourceContractFromEnv(env as never);
  const terminalSource = resolveSourceIdentity(mobile, contract);
  const layout = makeLayout();
  const runtime = join(layout.root, 'sessions', 'terminal', 'runtime');
  mkdirSync(runtime, { recursive: true });
  writeSuccessorSourceDeclaration(runtime, {
    version: 1,
    projectRoot: other,
    sourceKey: terminalSource.sourceKey,
    sessionId: 'terminal',
    declaredAtMs: Date.now(),
  });

  const diagnostics: string[] = [];
  const minted = resolveSuccessorMintSource({
    terminal: {
      layout: layout as never,
      session: { sessionId: 'terminal' },
      source: terminalSource,
    },
    bootSource: terminalSource,
    resolveIdentity: (root) => resolveSourceIdentity(root, contract),
    diagnostic: (message) => diagnostics.push(message),
  });

  assert.deepEqual(diagnostics, []);
  assert.equal(minted.appRoot, realpathSync(other));
  assert.notEqual(minted.appRootKey, terminalSource.appRootKey);
});

interface HandlerHarness {
  handler: ReturnType<typeof createSessionHandler>;
  calls: string[];
  declared: Record<string, unknown>[];
}

function makeBindSourceHarness(
  primary: string,
  extraBindings: Record<string, unknown> = {},
  overrides: Record<string, unknown> = {},
): HandlerHarness {
  const source = resolveSourceIdentity(primary);
  const status = {
    sessionId: 'session-776',
    sourceKey: source.sourceKey,
    worktreeKey: source.worktreeKey,
    appRootKey: source.appRootKey,
    state: 'source_bound',
    claimEpoch: 1,
    authorityVersion: 1,
    leaseUntilMs: 100,
    source: { ...source },
    bindings: { ...extraBindings },
    claims: [],
    worker: { instanceId: 'worker', pid: 1, birthAvailable: true },
  };
  const calls: string[] = [];
  const declared: Record<string, unknown>[] = [];
  const handler = createSessionHandler(
    {
      status: () => ({ available: true, ...status }),
      requireOperational: () => ({
        registry: {
          getSessionStatus: () => status,
          releaseSession: () => calls.push('release'),
        },
        session: { sessionId: 'session-776', claimEpoch: 1 },
      }),
    } as never,
    {
      releaseDeadSourceOwner: async () => {
        calls.push('prior-owner-cleanup');
        return { status: 'clean', released: [] } as never;
      },
      declareSuccessorSource: (declaration) => {
        declared.push(declaration as never);
        calls.push('declare');
      },
      requestWorkerRecycle: () => {
        calls.push('recycle');
        return true;
      },
      ...overrides,
    },
  );
  return { handler, calls, declared };
}

test('bind_source declares the linked worktree and releases toward a recycled successor', async () => {
  const { primary, linked } = makeRepoWithWorktree();
  const { handler, calls, declared } = makeBindSourceHarness(primary);

  const result = await handler({ action: 'bind_source', projectRoot: linked } as never);
  const body = JSON.parse(result.content[0]!.text);

  assert.equal(result.isError, undefined, result.content[0]!.text);
  assert.deepEqual(calls, ['prior-owner-cleanup', 'declare', 'release', 'recycle']);
  assert.equal(declared[0]!.projectRoot, realpathSync(linked));
  assert.equal(declared[0]!.sessionId, 'session-776');
  assert.equal(body.data.released, true);
  assert.equal(body.data.successorRoot, realpathSync(linked));
  assert.equal(body.data.recycleRequested, true);
  assert.match(body.data.nextAction, /minted automatically for/);
  assert.ok(String(body.data.nextAction).includes(realpathSync(linked)));
});

test('bind_source on the already-bound root is a no-op', async () => {
  const { primary } = makeRepoWithWorktree();
  const { handler, calls } = makeBindSourceHarness(primary);

  const result = await handler({ action: 'bind_source', projectRoot: primary } as never);
  const body = JSON.parse(result.content[0]!.text);

  assert.equal(result.isError, undefined, result.content[0]!.text);
  assert.equal(body.data.alreadyBound, true);
  assert.deepEqual(calls, []);
});

test('bind_source refuses a foreign repository naming both paths', async () => {
  const { primary } = makeRepoWithWorktree();
  const foreign = makeForeignRepo();
  const { handler, calls } = makeBindSourceHarness(primary);

  const result = await handler({ action: 'bind_source', projectRoot: foreign } as never);
  const body = JSON.parse(result.content[0]!.text);

  assert.equal(body.code, 'SOURCE_ROOT_DIVERGENCE');
  assert.ok(String(body.error).includes(realpathSync(foreign)));
  assert.ok(String(body.error).includes(realpathSync(primary)));
  assert.match(String(body.meta?.nextAction ?? ''), /never attaches to a foreign tree/);
  assert.deepEqual(calls, []);
});

test('bind_source refuses while package integration is applied in the bound tree', async () => {
  const { primary, linked } = makeRepoWithWorktree();
  const { handler, calls } = makeBindSourceHarness(primary, {
    packageIntegration: { version: 1 },
  });

  const result = await handler({ action: 'bind_source', projectRoot: linked } as never);
  const body = JSON.parse(result.content[0]!.text);

  assert.equal(body.code, 'SOURCE_ROOT_DIVERGENCE');
  assert.match(String(body.error), /restore it before rebinding/);
  assert.ok(String(body.error).includes(realpathSync(primary)));
  assert.deepEqual(calls, []);
});

test('bind_source releases a proven-dead owner of the declared root before it declares', async () => {
  const { primary, linked } = makeRepoWithWorktree();
  const cleaned: string[] = [];
  const { handler, calls } = makeBindSourceHarness(
    primary,
    {},
    {
      releaseDeadSourceOwner: async (source: { appRoot: string }) => {
        cleaned.push(source.appRoot);
        return { status: 'clean', released: ['dead-predecessor'] } as never;
      },
    },
  );

  const result = await handler({ action: 'bind_source', projectRoot: linked } as never);

  assert.equal(result.isError, undefined, result.content[0]!.text);
  assert.deepEqual(cleaned, [realpathSync(linked)]);
  assert.deepEqual(calls, ['declare', 'release', 'recycle']);
});

test('bind_source refuses while the declared root is still owned by a live session', async () => {
  const { primary, linked } = makeRepoWithWorktree();
  const { handler, calls } = makeBindSourceHarness(
    primary,
    {},
    {
      releaseDeadSourceOwner: async () =>
        ({
          status: 'refused',
          released: [],
          refusal: {
            code: 'RESOURCE_CLAIM_CONFLICT',
            message: 'another live rn-dev-agent supervisor owns this worktree',
            nextAction: 'Close the other session, then retry bind_source.',
          },
        }) as never,
    },
  );

  const result = await handler({ action: 'bind_source', projectRoot: linked } as never);
  const body = JSON.parse(result.content[0]!.text);

  assert.equal(body.code, 'RESOURCE_CLAIM_CONFLICT');
  assert.ok(String(body.error).includes(realpathSync(linked)));
  assert.match(String(body.error), /another live rn-dev-agent supervisor/);
  assert.match(String(body.meta?.nextAction ?? ''), /Close the other session/);
  assert.deepEqual(calls, []);
});

test('a failed release withdraws the successor declaration it just wrote', async () => {
  const { primary, linked } = makeRepoWithWorktree();
  const source = resolveSourceIdentity(primary);
  const status = {
    sessionId: 'session-776',
    sourceKey: source.sourceKey,
    worktreeKey: source.worktreeKey,
    appRootKey: source.appRootKey,
    state: 'metro_bound',
    claimEpoch: 1,
    authorityVersion: 1,
    leaseUntilMs: 100,
    source: { ...source },
    bindings: { metro: { mode: 'managed', port: 8081 } },
    claims: [],
    worker: { instanceId: 'worker', pid: 1, birthAvailable: true },
  };
  const calls: string[] = [];
  const handler = createSessionHandler(
    {
      status: () => ({ available: true, ...status }),
      requireOperational: () => ({
        registry: {
          getSessionStatus: () => status,
          releaseSession: () => calls.push('release'),
        },
        session: { sessionId: 'session-776', claimEpoch: 1 },
      }),
    } as never,
    {
      releaseDeadSourceOwner: async () => ({ status: 'clean', released: [] }) as never,
      declareSuccessorSource: () => calls.push('declare'),
      withdrawSuccessorSource: () => calls.push('withdraw'),
      getSignerCapability: () => undefined as never,
      requestWorkerRecycle: () => {
        calls.push('recycle');
        return true;
      },
    },
  );

  const result = await handler({ action: 'bind_source', projectRoot: linked } as never);
  const body = JSON.parse(result.content[0]!.text);

  assert.equal(result.isError, true);
  assert.equal(body.code, 'SESSION_AUTHORITY_REQUIRED');
  assert.deepEqual(calls, ['declare', 'withdraw']);
});

test('integration actions refuse a declared root from a different app package of the same worktree', async () => {
  const { mobile, other } = makeMonorepoApps();
  const source = resolveSourceIdentity(mobile);
  const status = {
    sessionId: 'session-776',
    sourceKey: source.sourceKey,
    worktreeKey: source.worktreeKey,
    appRootKey: source.appRootKey,
    state: 'source_bound',
    claimEpoch: 1,
    authorityVersion: 1,
    leaseUntilMs: 100,
    source: { ...source },
    bindings: {},
    claims: [],
    worker: { instanceId: 'worker', pid: 1, birthAvailable: true },
  };
  const handler = createSessionHandler(
    {
      status: () => ({ available: true, ...status }),
      requireOperational: () => ({
        registry: { getSessionStatus: () => status },
        session: { sessionId: 'session-776', claimEpoch: 1 },
      }),
    } as never,
    {},
  );

  const result = await handler({
    action: 'preview_integration',
    projectRoot: other,
  } as never);
  const body = JSON.parse(result.content[0]!.text);

  assert.equal(body.code, 'SOURCE_ROOT_DIVERGENCE');
  assert.ok(String(body.error).includes(realpathSync(other)));
  assert.ok(String(body.error).includes(realpathSync(mobile)));
  assert.match(String(body.meta?.nextAction ?? ''), /bind_source/);
});

test('a relative projectRoot is anchored to the bound app root, not the worker cwd', async () => {
  const { mobile, other } = makeMonorepoApps();
  const source = resolveSourceIdentity(mobile);
  const status = {
    sessionId: 'session-776',
    sourceKey: source.sourceKey,
    worktreeKey: source.worktreeKey,
    appRootKey: source.appRootKey,
    state: 'source_bound',
    claimEpoch: 1,
    authorityVersion: 1,
    leaseUntilMs: 100,
    source: { ...source },
    bindings: { metroPort: 8081 },
    claims: [],
    worker: { instanceId: 'worker', pid: 1, birthAvailable: true },
  };
  const handler = createSessionHandler(
    {
      status: () => ({ available: true, ...status }),
      requireOperational: () => ({
        registry: { getSessionStatus: () => status },
        session: { sessionId: 'session-776', claimEpoch: 1 },
      }),
    } as never,
    { deviceExists: () => false },
  );
  const bindDevice = async (projectRoot: string) => {
    const result = await handler({
      action: 'bind_device',
      platform: 'android',
      deviceId: 'emulator-5554',
      appId: 'com.example.app',
      projectRoot,
    } as never);
    return JSON.parse(result.content[0]!.text);
  };

  const bound = await bindDevice('.');
  assert.equal(bound.code, 'DEVICE_NOT_FOUND', JSON.stringify(bound));

  const sibling = await bindDevice(join('..', 'other'));
  assert.equal(sibling.code, 'SOURCE_ROOT_DIVERGENCE');
  assert.ok(String(sibling.error).includes(realpathSync(other)));
  assert.ok(String(sibling.error).includes(realpathSync(mobile)));
});

test('integration actions refuse a declared root from a different worktree naming both paths', async () => {
  const { primary, linked } = makeRepoWithWorktree();
  const source = resolveSourceIdentity(primary);
  const status = {
    sessionId: 'session-776',
    sourceKey: source.sourceKey,
    worktreeKey: source.worktreeKey,
    appRootKey: source.appRootKey,
    state: 'source_bound',
    claimEpoch: 1,
    authorityVersion: 1,
    leaseUntilMs: 100,
    source: { ...source },
    bindings: {},
    claims: [],
    worker: { instanceId: 'worker', pid: 1, birthAvailable: true },
  };
  const handler = createSessionHandler(
    {
      status: () => ({ available: true, ...status }),
      requireOperational: () => ({
        registry: { getSessionStatus: () => status },
        session: { sessionId: 'session-776', claimEpoch: 1 },
      }),
    } as never,
    {},
  );

  const result = await handler({
    action: 'preview_integration',
    projectRoot: linked,
  } as never);
  const body = JSON.parse(result.content[0]!.text);

  assert.equal(body.code, 'SOURCE_ROOT_DIVERGENCE');
  assert.ok(String(body.error).includes(realpathSync(linked)));
  assert.ok(String(body.error).includes(realpathSync(primary)));
  assert.match(String(body.meta?.nextAction ?? ''), /bind_source/);
});

test('bind_device yields an autostarted Observe binding instead of refusing', async () => {
  const calls: string[] = [];
  const observeBinding = {
    port: 7333,
    pid: 456,
    processBirth: 'observe-birth',
    instanceId: 'observe',
    cleanupCapability: 'capability',
    autostarted: true,
  };
  const status: Record<string, unknown> = {
    sessionId: 'session-776',
    state: 'source_bound',
    claimEpoch: 1,
    authorityVersion: 5,
    leaseUntilMs: 100,
    source: { kind: 'git' },
    bindings: { observe: observeBinding, observePort: 7333, metroPort: 8081 },
    claims: [
      {
        type: 'observe-port',
        key: '7333',
        sessionId: 'session-776',
        claimEpoch: 1,
      },
    ],
    worker: { instanceId: 'worker', pid: 1, birthAvailable: true },
  };
  let replacement: Record<string, unknown> | undefined;
  const handler = createSessionHandler(
    {
      status: () => ({ available: true, ...status }),
      requireOperational: () => ({
        registry: {
          getSessionStatus: () => status,
          updateBindings: (_session: unknown, update: { bindings: Record<string, unknown> }) => {
            assert.deepEqual(update.bindings, { observe: null });
            (status.bindings as Record<string, unknown>).observe = null;
            calls.push('clear-observe');
          },
          inspectDeviceAuthorityAvailability: () => {},
          replaceDeviceAuthority: (_session: unknown, input: Record<string, unknown>) => {
            replacement = input;
            calls.push('replace-device');
          },
        },
        session: { sessionId: 'session-776', claimEpoch: 1 },
      }),
    } as never,
    {
      stopHandoffObserve: async (binding) => {
        assert.equal(binding.port, 7333);
        calls.push('stop-observe');
      },
      deviceExists: () => true,
    },
  );

  const result = await handler({
    action: 'bind_device',
    platform: 'android',
    deviceId: 'emulator-5554',
    appId: 'com.example.app',
  } as never);

  assert.equal(result.isError, undefined, result.content[0]!.text);
  assert.deepEqual(calls, ['stop-observe', 'clear-observe', 'replace-device']);
  assert.equal(
    (replacement?.device as Record<string, unknown> | undefined)?.deviceId,
    'emulator-5554',
  );
  const body = JSON.parse(result.content[0]!.text);
  assert.equal(body.data.observeYielded, true);
  assert.equal(body.data.observePort, 7333);
  assert.match(String(body.data.observeNextAction), /observe action "start"/);
});

test('an explicitly started Observe refuses the device axis instead of being stopped', async () => {
  const calls: string[] = [];
  const status: Record<string, unknown> = {
    sessionId: 'session-776',
    state: 'source_bound',
    claimEpoch: 1,
    authorityVersion: 5,
    leaseUntilMs: 100,
    source: { kind: 'git' },
    bindings: {
      observe: {
        port: 7333,
        pid: 456,
        processBirth: 'observe-birth',
        instanceId: 'observe',
        cleanupCapability: 'capability',
        autostarted: false,
      },
      observePort: 7333,
      metroPort: 8081,
    },
    claims: [{ type: 'observe-port', key: '7333', sessionId: 'session-776', claimEpoch: 1 }],
    worker: { instanceId: 'worker', pid: 1, birthAvailable: true },
  };
  const handler = createSessionHandler(
    {
      status: () => ({ available: true, ...status }),
      requireOperational: () => ({
        registry: {
          getSessionStatus: () => status,
          updateBindings: () => calls.push('clear-observe'),
          inspectDeviceAuthorityAvailability: () => {},
          replaceDeviceAuthority: () => calls.push('replace-device'),
        },
        session: { sessionId: 'session-776', claimEpoch: 1 },
      }),
    } as never,
    {
      stopHandoffObserve: async () => {
        calls.push('stop-observe');
      },
      deviceExists: () => true,
    },
  );

  const result = await handler({
    action: 'bind_device',
    platform: 'android',
    deviceId: 'emulator-5554',
    appId: 'com.example.app',
  } as never);
  const body = JSON.parse(result.content[0]!.text);

  assert.equal(body.code, 'DEVICE_AUTHORITY_MISMATCH');
  assert.match(String(body.error), /explicitly started Observe/);
  assert.match(String(body.meta?.nextAction ?? ''), /observe action "stop"/);
  assert.deepEqual(calls, []);
  assert.equal((status.bindings as Record<string, unknown>).observe != null, true);
});

test('a refused bind_device leaves the autostarted Observe binding running', async () => {
  const calls: string[] = [];
  const status: Record<string, unknown> = {
    sessionId: 'session-776',
    state: 'source_bound',
    claimEpoch: 1,
    authorityVersion: 5,
    leaseUntilMs: 100,
    source: { kind: 'git' },
    bindings: {
      observe: {
        port: 7333,
        pid: 456,
        processBirth: 'observe-birth',
        instanceId: 'observe',
        cleanupCapability: 'capability',
        autostarted: true,
      },
      observePort: 7333,
      metroPort: 8081,
    },
    claims: [
      {
        type: 'observe-port',
        key: '7333',
        sessionId: 'session-776',
        claimEpoch: 1,
      },
    ],
    worker: { instanceId: 'worker', pid: 1, birthAvailable: true },
  };
  const handler = createSessionHandler(
    {
      status: () => ({ available: true, ...status }),
      requireOperational: () => ({
        registry: {
          getSessionStatus: () => status,
          updateBindings: () => calls.push('clear-observe'),
          inspectDeviceAuthorityAvailability: () => {},
          replaceDeviceAuthority: () => calls.push('replace-device'),
        },
        session: { sessionId: 'session-776', claimEpoch: 1 },
      }),
    } as never,
    {
      stopHandoffObserve: async () => {
        calls.push('stop-observe');
      },
      deviceExists: () => false,
    },
  );

  const result = await handler({
    action: 'bind_device',
    platform: 'android',
    deviceId: 'emulator-9999',
    appId: 'com.example.app',
  } as never);
  const body = JSON.parse(result.content[0]!.text);

  assert.equal(body.code, 'DEVICE_NOT_FOUND');
  assert.deepEqual(calls, []);
  assert.equal((status.bindings as Record<string, unknown>).observe != null, true);
});

test('an unconfirmed stale-device refusal leaves the autostarted Observe binding running', async () => {
  const calls: string[] = [];
  const status: Record<string, unknown> = {
    sessionId: 'session-776',
    state: 'source_bound',
    claimEpoch: 1,
    authorityVersion: 5,
    leaseUntilMs: 100,
    source: { kind: 'git' },
    bindings: {
      observe: {
        port: 7333,
        pid: 456,
        processBirth: 'observe-birth',
        instanceId: 'observe',
        cleanupCapability: 'capability',
        autostarted: true,
      },
      observePort: 7333,
      metroPort: 8081,
    },
    claims: [
      {
        type: 'observe-port',
        key: '7333',
        sessionId: 'session-776',
        claimEpoch: 1,
      },
    ],
    worker: { instanceId: 'worker', pid: 1, birthAvailable: true },
  };
  const handler = createSessionHandler(
    {
      status: () => ({ available: true, ...status }),
      requireOperational: () => ({
        registry: {
          getSessionStatus: () => status,
          updateBindings: () => calls.push('clear-observe'),
          inspectDeviceAuthorityAvailability: () => {
            calls.push('inspect-availability');
            throw new SessionAuthorityError(
              'SESSION_AUTHORITY_REQUIRED',
              'a proven-stale device owner requires explicit adopt_stale before rebinding',
              { sessionId: 'dead-session', claimEpoch: 2 },
            );
          },
          inspectStaleDeviceRelease: () => ({
            priorSessionId: 'dead-session',
            priorClaimEpoch: 2,
            obligations: ['runner'],
          }),
          replaceDeviceAuthority: () => calls.push('replace-device'),
        },
        session: { sessionId: 'session-776', claimEpoch: 1 },
      }),
    } as never,
    {
      stopHandoffObserve: async () => {
        calls.push('stop-observe');
      },
      deviceExists: () => true,
    },
  );

  const result = await handler({
    action: 'bind_device',
    platform: 'android',
    deviceId: 'emulator-5554',
    appId: 'com.example.app',
  } as never);
  const body = JSON.parse(result.content[0]!.text);

  assert.equal(body.code, 'STALE_DEVICE_RELEASE_REQUIRED');
  assert.deepEqual(calls, ['inspect-availability']);
  assert.equal((status.bindings as Record<string, unknown>).observe != null, true);
});

test('the Observe yield clears the surviving binding on the authority version its stop advanced', async () => {
  const calls: string[] = [];
  const status: Record<string, unknown> = {
    sessionId: 'session-776',
    state: 'source_bound',
    claimEpoch: 1,
    authorityVersion: 5,
    leaseUntilMs: 100,
    source: { kind: 'git' },
    bindings: {
      observe: {
        port: 7333,
        pid: 456,
        processBirth: 'observe-birth',
        instanceId: 'observe',
        cleanupCapability: 'capability',
        autostarted: true,
      },
      observePort: 7333,
      metroPort: 8081,
    },
    claims: [{ type: 'observe-port', key: '7333', sessionId: 'session-776', claimEpoch: 1 }],
    worker: { instanceId: 'worker', pid: 1, birthAvailable: true },
  };
  const handler = createSessionHandler(
    {
      status: () => ({ available: true, ...status }),
      requireOperational: () => ({
        registry: {
          getSessionStatus: () => status,
          updateBindings: (
            _session: unknown,
            update: { bindings: Record<string, unknown>; expectedAuthorityVersion?: number },
          ) => {
            if (
              update.expectedAuthorityVersion !== undefined &&
              update.expectedAuthorityVersion !== status.authorityVersion
            ) {
              throw new SessionAuthorityError(
                'AUTHORITY_LOST_DURING_OPERATION',
                'session authority version changed before binding commit',
              );
            }
            Object.assign(status.bindings as Record<string, unknown>, update.bindings);
            status.authorityVersion = (status.authorityVersion as number) + 1;
            calls.push('clear-observe');
          },
          inspectDeviceAuthorityAvailability: () => {},
          replaceDeviceAuthority: () => calls.push('replace-device'),
        },
        session: { sessionId: 'session-776', claimEpoch: 1 },
      }),
    } as never,
    {
      // The stop owner's own unbind is rejected by the operation fence, so the
      // binding survives the stop — but the version it CASes on has moved.
      stopHandoffObserve: async () => {
        status.authorityVersion = (status.authorityVersion as number) + 1;
        calls.push('stop-observe');
      },
      deviceExists: () => true,
    },
  );

  const result = await handler({
    action: 'bind_device',
    platform: 'android',
    deviceId: 'emulator-5554',
    appId: 'com.example.app',
  } as never);
  const body = JSON.parse(result.content[0]!.text);

  assert.equal(result.isError, undefined, result.content[0]!.text);
  assert.deepEqual(calls, ['stop-observe', 'clear-observe', 'replace-device']);
  assert.equal((status.bindings as Record<string, unknown>).observe, null);
  assert.equal(body.data.observeYielded, true);
  assert.equal(body.data.observePort, 7333);
});

test('the Observe yield skips the clearing CAS when the stop path already unbound', async () => {
  const calls: string[] = [];
  const status: Record<string, unknown> = {
    sessionId: 'session-776',
    state: 'source_bound',
    claimEpoch: 1,
    authorityVersion: 5,
    leaseUntilMs: 100,
    source: { kind: 'git' },
    bindings: {
      observe: {
        port: 7333,
        pid: 456,
        processBirth: 'observe-birth',
        instanceId: 'observe',
        cleanupCapability: 'capability',
        autostarted: true,
      },
      observePort: 7333,
      metroPort: 8081,
    },
    claims: [{ type: 'observe-port', key: '7333', sessionId: 'session-776', claimEpoch: 1 }],
    worker: { instanceId: 'worker', pid: 1, birthAvailable: true },
  };
  const handler = createSessionHandler(
    {
      status: () => ({ available: true, ...status }),
      requireOperational: () => ({
        registry: {
          getSessionStatus: () => status,
          updateBindings: (
            _session: unknown,
            update: { bindings: Record<string, unknown>; expectedAuthorityVersion?: number },
          ) => {
            if (
              update.expectedAuthorityVersion !== undefined &&
              update.expectedAuthorityVersion !== status.authorityVersion
            ) {
              throw new SessionAuthorityError(
                'AUTHORITY_LOST_DURING_OPERATION',
                'session authority version changed before binding commit',
              );
            }
            Object.assign(status.bindings as Record<string, unknown>, update.bindings);
            status.authorityVersion = (status.authorityVersion as number) + 1;
            calls.push('clear-observe');
          },
          inspectDeviceAuthorityAvailability: () => {},
          replaceDeviceAuthority: () => calls.push('replace-device'),
        },
        session: { sessionId: 'session-776', claimEpoch: 1 },
      }),
    } as never,
    {
      // A stop owner reached outside the operation fence commits its own unbind.
      stopHandoffObserve: async () => {
        (status.bindings as Record<string, unknown>).observe = null;
        status.authorityVersion = (status.authorityVersion as number) + 1;
        calls.push('stop-observe');
      },
      deviceExists: () => true,
    },
  );

  const result = await handler({
    action: 'bind_device',
    platform: 'android',
    deviceId: 'emulator-5554',
    appId: 'com.example.app',
  } as never);
  const body = JSON.parse(result.content[0]!.text);

  assert.equal(result.isError, undefined, result.content[0]!.text);
  assert.deepEqual(calls, ['stop-observe', 'replace-device']);
  assert.equal(body.data.observeYielded, true);
  assert.equal(body.data.observePort, 7333);
});

test('an explicitly started Observe refuses before any bind_device step mutates state', async () => {
  const calls: string[] = [];
  const status: Record<string, unknown> = {
    sessionId: 'session-776',
    state: 'device_bound',
    claimEpoch: 1,
    authorityVersion: 5,
    leaseUntilMs: 100,
    source: { kind: 'git' },
    bindings: {
      observe: {
        port: 7333,
        pid: 456,
        processBirth: 'observe-birth',
        instanceId: 'observe',
        cleanupCapability: 'capability',
        autostarted: false,
      },
      observePort: 7333,
      metroPort: 8081,
      androidMetroReverse: {
        platform: 'android',
        deviceId: 'emulator-5556',
        metroPort: 8081,
        local: 'tcp:8081',
        remote: 'tcp:8081',
      },
      staleDeviceCleanup: { platform: 'android', deviceId: 'emulator-5554' },
    },
    claims: [{ type: 'observe-port', key: '7333', sessionId: 'session-776', claimEpoch: 1 }],
    worker: { instanceId: 'worker', pid: 1, birthAvailable: true },
  };
  const handler = createSessionHandler(
    {
      status: () => ({ available: true, ...status }),
      requireOperational: () => ({
        registry: {
          getSessionStatus: () => status,
          updateBindings: () => calls.push('update-bindings'),
          beginConfirmedStaleDeviceRelease: () => {
            calls.push('begin-stale-release');
            return {};
          },
          finishStaleResourceRelease: () => calls.push('finish-stale-release'),
          inspectDeviceAuthorityAvailability: () => {},
          replaceDeviceAuthority: () => calls.push('replace-device'),
        },
        session: { sessionId: 'session-776', claimEpoch: 1 },
      }),
    } as never,
    {
      stopHandoffObserve: async () => calls.push('stop-observe'),
      removeAndroidMetroReverse: () => calls.push('remove-reverse'),
      deviceExists: () => true,
    },
  );

  const result = await handler({
    action: 'bind_device',
    platform: 'android',
    deviceId: 'emulator-5554',
    appId: 'com.example.app',
  } as never);
  const body = JSON.parse(result.content[0]!.text);

  assert.equal(body.code, 'DEVICE_AUTHORITY_MISMATCH');
  assert.match(String(body.error), /explicitly started Observe/);
  assert.deepEqual(calls, []);
  assert.equal((status.bindings as Record<string, unknown>).staleDeviceCleanup != null, true);
  assert.equal((status.bindings as Record<string, unknown>).androidMetroReverse != null, true);
});

test('the projectRoot fence accepts the bound root of a declared-root session', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'rn-gh776-declared-')));
  roots.push(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'declared-app' }));
  const declaredSource = resolveSourceIdentity(root, {
    declaredRoot: root,
    declaredManifests: ['package.json'],
  });
  assert.equal(declaredSource.kind, 'declared-root');
  const status = {
    sessionId: 'session-776',
    sourceKey: declaredSource.sourceKey,
    worktreeKey: declaredSource.worktreeKey,
    appRootKey: declaredSource.appRootKey,
    state: 'source_bound',
    claimEpoch: 1,
    authorityVersion: 1,
    leaseUntilMs: 100,
    source: { ...declaredSource },
    bindings: { metroPort: 8081 },
    claims: [],
    worker: { instanceId: 'worker', pid: 1, birthAvailable: true },
  };
  const handler = createSessionHandler(
    {
      status: () => ({ available: true, ...status }),
      requireOperational: () => ({
        registry: { getSessionStatus: () => status },
        session: { sessionId: 'session-776', claimEpoch: 1 },
      }),
    } as never,
    { deviceExists: () => false },
  );

  const result = await handler({
    action: 'bind_device',
    platform: 'android',
    deviceId: 'emulator-5554',
    appId: 'com.example.app',
    projectRoot: root,
  } as never);
  const body = JSON.parse(result.content[0]!.text);

  assert.equal(body.code, 'DEVICE_NOT_FOUND', result.content[0]!.text);
});

for (const blocking of [
  { name: 'runner', bindings: { runner: { platform: 'android' } } },
  { name: 'proof', bindings: { proof: { runId: 'proof-a' } } },
]) {
  test(`bind_device still refuses while ${blocking.name} authority is bound`, async () => {
    const status = {
      sessionId: 'session-776',
      state: 'ready',
      claimEpoch: 1,
      authorityVersion: 1,
      leaseUntilMs: 100,
      source: { kind: 'git' },
      bindings: { ...blocking.bindings },
      claims: [],
      worker: { instanceId: 'worker', pid: 1, birthAvailable: true },
    };
    const handler = createSessionHandler(
      {
        status: () => ({ available: true, ...status }),
        requireOperational: () => ({
          registry: { getSessionStatus: () => status },
          session: { sessionId: 'session-776', claimEpoch: 1 },
        }),
      } as never,
      {},
    );

    const result = await handler({
      action: 'bind_device',
      platform: 'android',
      deviceId: 'emulator-5554',
      appId: 'com.example.app',
    } as never);
    const body = JSON.parse(result.content[0]!.text);

    assert.equal(body.code, 'DEVICE_AUTHORITY_MISMATCH');
    assert.match(String(body.error), /runner or proof authority/);
  });
}

test('release names the root the successor will bind instead of "this worktree"', async () => {
  const status = {
    sessionId: 'session-776',
    state: 'source_bound',
    claimEpoch: 1,
    authorityVersion: 1,
    leaseUntilMs: 100,
    source: { kind: 'git', appRoot: '/repo/linked-worktree' },
    bindings: {},
    claims: [],
    worker: { instanceId: 'worker', pid: 1, birthAvailable: true },
  };
  const handler = createSessionHandler(
    {
      status: () => ({ available: true, ...status }),
      requireOperational: () => ({
        registry: {
          getSessionStatus: () => status,
          releaseSession: () => {},
        },
        session: { sessionId: 'session-776', claimEpoch: 1 },
      }),
    } as never,
    { requestWorkerRecycle: () => true },
  );

  const result = await handler({ action: 'release' } as never);
  const body = JSON.parse(result.content[0]!.text);

  assert.equal(body.data.recycleRequested, true);
  assert.match(body.data.nextAction, /minted automatically for \/repo\/linked-worktree/);
  assert.doesNotMatch(body.data.nextAction, /on this worktree/);
  assert.match(body.data.nextAction, /bind_source/);
});

test('resolveWorkerSpawnCwd returns the bound linked worktree, not the boot cwd', () => {
  const { primary, linked } = makeRepoWithWorktree();
  const bound = resolveSourceIdentity(linked);
  const cwd = resolveWorkerSpawnCwd({
    authoritySource: bound,
    fallbackCwd: primary,
    resolveIdentity: (root) => resolveSourceIdentity(root),
  });
  assert.equal(cwd, linked);
});

test('a missing bound source root refuses with a typed error naming both paths', () => {
  const { primary, linked } = makeRepoWithWorktree();
  const bound = resolveSourceIdentity(linked);
  rmSync(linked, { force: true, recursive: true });
  assert.throws(
    () =>
      resolveWorkerSpawnCwd({
        authoritySource: bound,
        fallbackCwd: primary,
        resolveIdentity: (root) => resolveSourceIdentity(root),
      }),
    (error: Error) => {
      assert.match(error.message, /^SOURCE_ROOT_UNAVAILABLE/);
      assert.ok(error.message.includes(linked), 'names the bound root');
      assert.ok(error.message.includes(primary), 'names the refused fallback');
      return true;
    },
  );
});

test('a foreign tree recreated at the bound path refuses instead of spawning there', () => {
  const { primary, linked } = makeRepoWithWorktree();
  const bound = resolveSourceIdentity(linked);
  rmSync(linked, { force: true, recursive: true });
  mkdirSync(linked, { recursive: true });
  git(linked, ['init', '-q', '.']);
  git(linked, ['config', 'user.email', 'fixture@example.test']);
  git(linked, ['config', 'user.name', 'fixture']);
  git(linked, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(linked, 'package.json'), JSON.stringify({ name: 'imposter' }));
  git(linked, ['add', '-A']);
  git(linked, ['commit', '-qm', 'imposter']);
  assert.throws(
    () =>
      resolveWorkerSpawnCwd({
        authoritySource: bound,
        fallbackCwd: primary,
        resolveIdentity: (root) => resolveSourceIdentity(root),
      }),
    (error: Error) => {
      assert.match(error.message, /^SOURCE_WORKTREE_MISMATCH/);
      assert.ok(error.message.includes(linked), 'names the bound root');
      assert.ok(error.message.includes(primary), 'names the refused fallback');
      return true;
    },
  );
});

test('a symlink to a sibling worktree of the same repository refuses instead of transferring', () => {
  const { primary, linked } = makeRepoWithWorktree();
  const bound = resolveSourceIdentity(linked);
  const sibling = join(dirname(linked), 'sibling');
  git(primary, ['worktree', 'add', '-q', sibling, '-b', 'sibling']);
  rmSync(linked, { force: true, recursive: true });
  symlinkSync(sibling, linked);
  assert.throws(
    () =>
      resolveWorkerSpawnCwd({
        authoritySource: bound,
        fallbackCwd: primary,
        resolveIdentity: (root) => resolveSourceIdentity(root),
      }),
    (error: Error) => {
      assert.match(error.message, /^SOURCE_WORKTREE_MISMATCH/);
      assert.ok(error.message.includes(linked), 'names the bound root');
      assert.ok(error.message.includes(sibling), 'names the tree it now resolves to');
      return true;
    },
  );
});

test('an absent authority source keeps the worker in the boot cwd', () => {
  const cwd = resolveWorkerSpawnCwd({
    authoritySource: undefined,
    fallbackCwd: '/supervisor/boot-cwd',
    resolveIdentity: () => {
      throw new Error('must not resolve without a bound source');
    },
  });
  assert.equal(cwd, '/supervisor/boot-cwd');
});

test('a transient identity probe failure retries instead of poisoning the session', () => {
  const { primary, linked } = makeRepoWithWorktree();
  const bound = resolveSourceIdentity(linked);
  let calls = 0;
  const cwd = resolveWorkerSpawnCwd({
    authoritySource: bound,
    fallbackCwd: primary,
    resolveIdentity: (root) => {
      calls += 1;
      if (calls === 1) {
        const error: NodeJS.ErrnoException = new Error('git rev-parse timed out');
        error.code = 'ETIMEDOUT';
        throw error;
      }
      return resolveSourceIdentity(root);
    },
  });
  assert.equal(calls, 2, 'the probe is retried once before any verdict');
  assert.equal(cwd, linked);
});

test('an unprovable identity probe keeps the worker in the bound root, never the boot cwd', () => {
  const { primary, linked } = makeRepoWithWorktree();
  const bound = resolveSourceIdentity(linked);
  const diagnostics: string[] = [];
  const cwd = resolveWorkerSpawnCwd({
    authoritySource: bound,
    fallbackCwd: primary,
    resolveIdentity: () => {
      const error: NodeJS.ErrnoException = new Error('git rev-parse timed out');
      error.code = 'ETIMEDOUT';
      throw error;
    },
    diagnostic: (message) => diagnostics.push(message),
  });
  assert.equal(cwd, linked, 'a blown probe budget must not redirect the worker');
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0]!, /could not be re-proven/);
});

test('the spawn environment rewrites a stale user cwd to the bound worktree', () => {
  const { primary, linked } = makeRepoWithWorktree();
  const environment = resolveWorkerSpawnRootEnvironment({
    workerCwd: linked,
    bootCwd: primary,
    inherited: { CLAUDE_USER_CWD: primary, RN_PROJECT_ROOT: primary },
  });
  assert.equal(environment.set.PWD, linked);
  assert.equal(environment.set.CLAUDE_USER_CWD, linked);
  assert.deepEqual(environment.unset, ['RN_PROJECT_ROOT']);
});

test('a user cwd inside the bound worktree survives the recycle', () => {
  const { primary, linked } = makeRepoWithWorktree();
  const nested = join(linked, 'src');
  mkdirSync(nested, { recursive: true });
  const environment = resolveWorkerSpawnRootEnvironment({
    workerCwd: linked,
    bootCwd: primary,
    inherited: { CLAUDE_USER_CWD: nested, RN_PROJECT_ROOT: linked },
  });
  assert.equal(environment.set.PWD, linked);
  assert.equal(environment.set.CLAUDE_USER_CWD, undefined, 'a contained user cwd is preserved');
  assert.deepEqual(environment.unset, []);
});

test('a first boot only gains an accurate PWD', () => {
  const { primary } = makeRepoWithWorktree();
  const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'rn-gh776-user-')));
  roots.push(elsewhere);
  const environment = resolveWorkerSpawnRootEnvironment({
    workerCwd: primary,
    bootCwd: primary,
    inherited: { CLAUDE_USER_CWD: elsewhere, RN_PROJECT_ROOT: elsewhere },
  });
  assert.deepEqual(environment, { set: { PWD: primary }, unset: [] });
});

// findProjectRoot() is the shared cwd-default resolver behind cdp_run_e2e_suite,
// cdp_lock_e2e_test, cdp_nav_graph, the test recorder and the Metro serving-root
// pin; it is executed here in a real child process started exactly the way the
// supervisor starts a recycled worker.
function probeProjectRoot(cwd: string, environment: NodeJS.ProcessEnv): string | null {
  const probe = join(realpathSync(mkdtempSync(join(tmpdir(), 'rn-gh776-probe-'))), 'probe.mjs');
  roots.push(dirname(probe));
  const storage = new URL('../../../dist/nav-graph/storage.js', import.meta.url).href;
  writeFileSync(
    probe,
    `import { findProjectRoot } from ${JSON.stringify(storage)};\n` +
      'process.stdout.write(JSON.stringify(findProjectRoot() ?? null));\n',
  );
  const result = spawnSync(process.execPath, [probe], { cwd, env: environment, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`probe failed: ${result.stderr}`);
  return JSON.parse(result.stdout) as string | null;
}

test('cwd-default handlers resolve the bound worktree after a bind_source recycle', () => {
  const { primary, linked } = makeRepoWithWorktree();
  const inherited = { ...process.env, CLAUDE_USER_CWD: primary, RN_PROJECT_ROOT: primary };

  assert.equal(
    probeProjectRoot(linked, inherited),
    primary,
    'inheriting the harness startup roots resolves the wrong tree',
  );

  const environment = resolveWorkerSpawnRootEnvironment({
    workerCwd: linked,
    bootCwd: primary,
    inherited: {
      CLAUDE_USER_CWD: inherited.CLAUDE_USER_CWD,
      RN_PROJECT_ROOT: inherited.RN_PROJECT_ROOT,
    },
  });
  const spawned: NodeJS.ProcessEnv = { ...inherited, ...environment.set };
  for (const key of environment.unset) delete spawned[key];

  assert.equal(probeProjectRoot(linked, spawned), linked);
});
