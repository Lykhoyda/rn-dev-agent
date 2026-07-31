import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openSessionRegistry } from '../../../dist/session/registry.js';
import { resolveSourceIdentity } from '../../../dist/session/source-identity.js';
import { createAuthorityStateLayout } from '../../../dist/session/state-root.js';
import { createSessionHandler } from '../../../dist/tools/session.js';

const cliPath = new URL('../../../dist/rn-session.js', import.meta.url).pathname;

// r20: a durable packageIntegration binding must never outlive the only copy of
// its restoration manifest, and a transferred legacy binding without a manifest
// must be reconciled or refused instead of silently fencing apply and release.

const R20_LEGACY_BINDING = {
  version: 1,
  installedBySessionId: '5032b61f-1b78-44b3-8677-f6e4c585ec21',
  manifestSha256: 'f2c170169a0f5ebe75f3398cd82fbb7fc2a64363647c2f1644ca661be6378ea2',
};

const ADAPTER_SENTINELS = {
  ios: 'node .rn-agent/integration/rn-session-adapter.cjs ios',
  android: 'node .rn-agent/integration/rn-session-adapter.cjs android',
};

const METRO_INTEGRATED = `module.exports = {};

// rn-dev-agent session integration: begin
module.exports = require('./.rn-agent/integration/rn-session-metro.cjs')(module.exports);
// rn-dev-agent session integration: end
`;

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

function createRuntime(
  registry: { getSessionStatus: (sessionId: string) => unknown },
  ref: { sessionId: string; claimEpoch: number },
): never {
  return {
    status: () => ({ available: true, ...(registry.getSessionStatus(ref.sessionId) as object) }),
    requireAvailable: () => ({ registry, session: ref }),
    requireOperational: () => ({ registry, session: ref }),
    requireRecovery: () => ({ registry, session: ref }),
  } as never;
}

function envelope(result: { content: Array<{ text: string }> }): {
  ok: boolean;
  data: Record<string, never>;
  error?: string;
  meta?: Record<string, never>;
} {
  return JSON.parse(result.content[0]!.text);
}

interface AdoptionFixture {
  registry: ReturnType<typeof openSessionRegistry>;
  prior: { sessionId: string; claimEpoch: number };
  adopter: { sessionId: string; claimEpoch: number };
  handle: string;
  source: ReturnType<typeof resolveSourceIdentity>;
  reopen: () => ReturnType<typeof openSessionRegistry>;
}

function setupStaleAdoption(input: {
  appRoot: string;
  registryPath: string;
  priorIntegration?: Record<string, unknown> | null;
  adopterAppRoot?: string;
}): AdoptionFixture {
  const source = resolveSourceIdentity(input.appRoot);
  const adopterSource = input.adopterAppRoot ? resolveSourceIdentity(input.adopterAppRoot) : source;
  const ownerStatus = ({ sessionId }: { sessionId: string }) =>
    sessionId === 'session-prior' ? 'mismatch' : 'match';
  const registry = openSessionRegistry(input.registryPath, { ownerStatus });
  const prior = registry.createSession({
    sessionId: 'session-prior',
    sourceKey: source.sourceKey,
    worktreeKey: source.worktreeKey,
    appRootKey: source.appRootKey,
    supervisor: { pid: process.pid, token: 'prior-supervisor' },
    source: { ...source },
    bindings: { metroPort: 8248, observePort: 7396 },
  });
  registry.claimResources(prior, [
    { type: 'source', key: source.worktreeKey },
    { type: 'metro-port', key: '8248' },
    { type: 'observe-port', key: '7396' },
    { type: 'device', key: 'ios:54B03A8D-C9A7-4F97-8656-75E81DC3A68C' },
  ]);
  registry.updateBindings(prior, {
    state: 'device_claimed',
    bindings: {
      device: {
        platform: 'ios',
        deviceId: '54B03A8D-C9A7-4F97-8656-75E81DC3A68C',
        appId: 'com.rndevagent.testapp',
      },
      packageIntegration:
        input.priorIntegration === undefined ? { ...R20_LEGACY_BINDING } : input.priorIntegration,
    },
  });
  const adopter = registry.createSession({
    sessionId: 'session-adopter',
    sourceKey: adopterSource.sourceKey,
    worktreeKey: adopterSource.worktreeKey,
    appRootKey: adopterSource.appRootKey,
    supervisor: { pid: process.pid, token: 'adopter-supervisor' },
    source: { ...adopterSource },
    bindings: { metroPort: 8248, observePort: 7396 },
  });
  registry.updateBindings(adopter, {
    state: 'blocked',
    bindings: {
      recoveryCapabilityHash: createHash('sha256').update('recovery-capability').digest('hex'),
      adoptionRequired: { sessionId: prior.sessionId, claimEpoch: prior.claimEpoch },
    },
  });
  registry.bindRecoveryWorker(
    adopter,
    { instanceId: 'recovery-worker', pid: process.pid, token: 'recovery-birth' },
    'recovery-capability',
  );
  const status = registry.getSessionStatus(adopter.sessionId);
  const handle = (
    status?.bindings.recoveryHandles as { adoptStale?: { token?: string } } | undefined
  )?.adoptStale?.token;
  assert.ok(typeof handle === 'string' && handle.length > 0, 'adoption handle must be minted');
  return {
    registry,
    prior,
    adopter,
    handle,
    source,
    reopen: () => openSessionRegistry(input.registryPath, { ownerStatus }),
  };
}

test('apply_integration publishes a durable manifest that survives restart and manifest-file loss', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-durable-manifest-'));
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
    let registry = openSessionRegistry(layout.registry, { ownerStatus: () => 'match' });
    const session = registry.createSession({
      sessionId: 'session-durable',
      sourceKey: source.sourceKey,
      worktreeKey: source.worktreeKey,
      appRootKey: source.appRootKey,
      supervisor: { pid: process.pid, token: 'fixture' },
      source: { ...source },
      bindings: { metroPort: 8248 },
    });
    registry.updateBindings(session, { state: 'device_claimed', bindings: {} });
    let handler = createSessionHandler(createRuntime(registry, session));

    const applied = await handler({ action: 'apply_integration', confirmed: true });
    assert.equal(applied.isError, undefined, applied.content[0]!.text);
    const binding = registry.getSessionStatus('session-durable')?.bindings.packageIntegration as {
      manifestSha256?: string;
      manifestSource?: string;
    };
    assert.equal(typeof binding.manifestSource, 'string');
    assert.equal(
      createHash('sha256').update(binding.manifestSource!).digest('hex'),
      binding.manifestSha256,
      'the durable binding must carry its own sha-verified manifest copy',
    );
    assert.equal(binding.manifestSource, readFileSync(manifestPath, 'utf8'));

    // Simulate a worker restart plus out-of-band loss of the on-disk manifest.
    registry.close();
    unlinkSync(manifestPath);
    registry = openSessionRegistry(layout.registry, { ownerStatus: () => 'match' });
    handler = createSessionHandler(createRuntime(registry, session));

    const restored = await handler({ action: 'restore_integration', confirmed: true });
    assert.equal(restored.isError, undefined, restored.content[0]!.text);
    assert.equal(readFileSync(packagePath, 'utf8'), originalPackage);
    assert.equal(readFileSync(metroConfigPath, 'utf8'), originalMetroConfig);
    assert.equal(existsSync(manifestPath), false);
    assert.equal(registry.getSessionStatus('session-durable')?.bindings.packageIntegration, null);

    const released = await handler({ action: 'release' });
    assert.equal(released.isError, undefined, released.content[0]!.text);
    const terminal = registry.getSessionStatus('session-durable');
    assert.equal(terminal?.state, 'released');
    assert.deepEqual(terminal?.claims, []);
    registry.close();
  } finally {
    if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousStateHome;
    rmSync(root, { force: true, recursive: true });
  }
});

test('normal apply and restore with the on-disk manifest is unchanged', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-normal-restore-'));
  const stateHome = join(root, 'state');
  const previousStateHome = process.env.XDG_STATE_HOME;
  try {
    const appRoot = createAppFixture(root);
    const packagePath = join(appRoot, 'package.json');
    const metroConfigPath = join(appRoot, 'metro.config.js');
    const originalPackage = readFileSync(packagePath, 'utf8');
    const originalMetroConfig = readFileSync(metroConfigPath, 'utf8');
    process.env.XDG_STATE_HOME = stateHome;
    const source = resolveSourceIdentity(appRoot);
    const layout = createAuthorityStateLayout();
    const registry = openSessionRegistry(layout.registry, { ownerStatus: () => 'match' });
    const session = registry.createSession({
      sessionId: 'session-normal',
      sourceKey: source.sourceKey,
      worktreeKey: source.worktreeKey,
      appRootKey: source.appRootKey,
      supervisor: { pid: process.pid, token: 'fixture' },
      source: { ...source },
      bindings: { metroPort: 8248 },
    });
    registry.updateBindings(session, { state: 'device_claimed', bindings: {} });
    const handler = createSessionHandler(createRuntime(registry, session));

    const applied = await handler({ action: 'apply_integration', confirmed: true });
    assert.equal(applied.isError, undefined, applied.content[0]!.text);
    const restored = await handler({ action: 'restore_integration', confirmed: true });
    assert.equal(restored.isError, undefined, restored.content[0]!.text);
    assert.equal(envelope(restored).data.restored, true);
    assert.equal(readFileSync(packagePath, 'utf8'), originalPackage);
    assert.equal(readFileSync(metroConfigPath, 'utf8'), originalMetroConfig);
    assert.equal(registry.getSessionStatus('session-normal')?.bindings.packageIntegration, null);
    const released = await handler({ action: 'release' });
    assert.equal(released.isError, undefined, released.content[0]!.text);
    registry.close();
  } finally {
    if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousStateHome;
    rmSync(root, { force: true, recursive: true });
  }
});

test('r20: adopting a manifest-less legacy binding reconciles a provably unintegrated app to zero residue', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-r20-reconcile-'));
  const stateHome = join(root, 'state');
  const previousStateHome = process.env.XDG_STATE_HOME;
  try {
    const appRoot = createAppFixture(root);
    const packagePath = join(appRoot, 'package.json');
    const metroConfigPath = join(appRoot, 'metro.config.js');
    const originalPackage = readFileSync(packagePath, 'utf8');
    const originalMetroConfig = readFileSync(metroConfigPath, 'utf8');
    process.env.XDG_STATE_HOME = stateHome;
    const layout = createAuthorityStateLayout();
    const fixture = setupStaleAdoption({ appRoot, registryPath: layout.registry });
    const { registry, adopter, handle, source } = fixture;
    const handler = createSessionHandler(createRuntime(registry, adopter));
    const allocationProbe = await new Promise<number>((resolvePort, reject) => {
      const server = createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const port = (server.address() as { port: number }).port;
        server.close(() => resolvePort(port));
      });
    });
    const allocatedPort = registry.allocatePort({
      service: 'metro',
      worktreeKey: source.worktreeKey,
      uid: 'r20-fixture',
      base: allocationProbe,
      span: 1,
    });
    assert.equal(allocatedPort, allocationProbe);

    // Public status before adoption must already expose the fence it is about to inherit.
    const priorStatusBinding = (
      registry.getSessionStatus('session-prior')?.bindings.packageIntegration as {
        installedBySessionId?: string;
      } | null
    )?.installedBySessionId;
    assert.equal(priorStatusBinding, R20_LEGACY_BINDING.installedBySessionId);

    const adoptedResult = await handler({ action: 'adopt_stale', adoptionHandle: handle });
    assert.equal(adoptedResult.isError, undefined, adoptedResult.content[0]!.text);
    const adoptedEnvelope = envelope(adoptedResult);
    assert.deepEqual(adoptedEnvelope.data.integrationReconciled, {
      cleared: true,
      verdict: 'unintegrated',
      priorInstalledBySessionId: R20_LEGACY_BINDING.installedBySessionId,
      reason:
        'transferred integration binding had no recoverable manifest and canonical files are provably unintegrated',
    });
    assert.equal(
      registry.getSessionStatus('session-adopter')?.bindings.packageIntegration,
      null,
      'the impossible binding must not survive adoption',
    );

    // Status honesty: no phantom fence, and installed=false remains accurate.
    const statusResult = await handler({ action: 'status' });
    const statusEnvelope = envelope(statusResult);
    const integrationDiagnostic = (
      statusEnvelope.data.authority as {
        migration: { packageIntegration: { installed: boolean; binding: unknown } };
      }
    ).migration.packageIntegration;
    assert.equal(integrationDiagnostic.installed, false);
    assert.equal(integrationDiagnostic.binding, null);

    // The r20 blocker: apply after safe reconciliation now succeeds.
    const applied = await handler({ action: 'apply_integration', confirmed: true });
    assert.equal(applied.isError, undefined, applied.content[0]!.text);

    const restored = await handler({ action: 'restore_integration', confirmed: true });
    assert.equal(restored.isError, undefined, restored.content[0]!.text);
    assert.equal(readFileSync(packagePath, 'utf8'), originalPackage);
    assert.equal(readFileSync(metroConfigPath, 'utf8'), originalMetroConfig);

    const released = await handler({ action: 'release' });
    assert.equal(released.isError, undefined, released.content[0]!.text);

    // Zero residue: adopter released with no claims, prior fenced stale, worktree empty.
    const terminal = registry.getSessionStatus('session-adopter');
    assert.equal(terminal?.state, 'released');
    assert.deepEqual(terminal?.claims, []);
    assert.equal(registry.getSessionStatus('session-prior')?.state, 'stale');
    assert.deepEqual(registry.getSessionStatus('session-prior')?.claims, []);
    assert.deepEqual(registry.findSessionsByWorktree(source.worktreeKey), []);

    // The worktree's port allocation is no longer fenced: a different worktree
    // reclaims it as an orphan once no live session remains.
    assert.equal(
      registry.allocatePort({
        service: 'metro',
        worktreeKey: 'other-worktree-key',
        uid: 'r20-fixture',
        base: allocationProbe,
        span: 1,
      }),
      allocationProbe,
    );
    registry.close();

    // Zero residue at the canonical CLI boundary as well.
    const feedback = spawnSync(process.execPath, [cliPath, 'feedback-json'], {
      cwd: appRoot,
      env: { ...process.env, XDG_STATE_HOME: stateHome },
      encoding: 'utf8',
    });
    assert.notEqual(feedback.status, 0);
    assert.match(feedback.stderr, /no live session matches this canonical worktree and app root/);
  } finally {
    if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousStateHome;
    rmSync(root, { force: true, recursive: true });
  }
});

test('adoption refuses before transfer when the manifest is gone but files still carry integration', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-r20-integrated-'));
  const stateHome = join(root, 'state');
  const previousStateHome = process.env.XDG_STATE_HOME;
  try {
    const appRoot = createAppFixture(root);
    writeFileSync(
      join(appRoot, 'package.json'),
      `${JSON.stringify({ scripts: { ...ADAPTER_SENTINELS } }, null, 2)}\n`,
    );
    writeFileSync(join(appRoot, 'metro.config.js'), METRO_INTEGRATED);
    const integratedPackage = readFileSync(join(appRoot, 'package.json'), 'utf8');
    const integratedMetro = readFileSync(join(appRoot, 'metro.config.js'), 'utf8');
    process.env.XDG_STATE_HOME = stateHome;
    const layout = createAuthorityStateLayout();
    const fixture = setupStaleAdoption({ appRoot, registryPath: layout.registry });
    const { registry, adopter, handle } = fixture;
    const handler = createSessionHandler(createRuntime(registry, adopter));

    const refused = await handler({ action: 'adopt_stale', adoptionHandle: handle });
    assert.equal(refused.isError, true);
    const refusal = envelope(refused);
    assert.match(String(refusal.error), /not provably unintegrated/);
    assert.match(String(refusal.error), /integrated/);
    assert.match(
      String((refusal.meta as { nextAction?: string })?.nextAction),
      /version control history/,
    );

    // No misleading lifecycle was created and no user bytes were touched.
    assert.equal(registry.getSessionStatus('session-adopter')?.state, 'blocked');
    assert.equal(registry.getSessionStatus('session-prior')?.state, 'device_claimed');
    assert.deepEqual(
      registry.getSessionStatus('session-prior')?.bindings.packageIntegration,
      R20_LEGACY_BINDING,
    );
    assert.equal(readFileSync(join(appRoot, 'package.json'), 'utf8'), integratedPackage);
    assert.equal(readFileSync(join(appRoot, 'metro.config.js'), 'utf8'), integratedMetro);
    registry.close();
  } finally {
    if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousStateHome;
    rmSync(root, { force: true, recursive: true });
  }
});

test('restore_integration reconciliation is authenticated, deterministic, and idempotent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-reconcile-restore-'));
  const stateHome = join(root, 'state');
  const previousStateHome = process.env.XDG_STATE_HOME;
  try {
    const appRoot = createAppFixture(root);
    const packagePath = join(appRoot, 'package.json');
    const metroConfigPath = join(appRoot, 'metro.config.js');
    const originalPackage = readFileSync(packagePath, 'utf8');
    const originalMetroConfig = readFileSync(metroConfigPath, 'utf8');
    process.env.XDG_STATE_HOME = stateHome;
    const source = resolveSourceIdentity(appRoot);
    const layout = createAuthorityStateLayout();
    const registry = openSessionRegistry(layout.registry, { ownerStatus: () => 'match' });
    const session = registry.createSession({
      sessionId: 'session-reconcile',
      sourceKey: source.sourceKey,
      worktreeKey: source.worktreeKey,
      appRootKey: source.appRootKey,
      supervisor: { pid: process.pid, token: 'fixture' },
      source: { ...source },
      bindings: { metroPort: 8248 },
    });
    registry.updateBindings(session, {
      state: 'device_claimed',
      bindings: { packageIntegration: { ...R20_LEGACY_BINDING } },
    });
    const handler = createSessionHandler(createRuntime(registry, session));

    const reconciled = await handler({ action: 'restore_integration', confirmed: true });
    assert.equal(reconciled.isError, undefined, reconciled.content[0]!.text);
    const reconciledEnvelope = envelope(reconciled);
    assert.equal(reconciledEnvelope.data.restored, false);
    assert.equal(reconciledEnvelope.data.reconciled, true);
    assert.equal(reconciledEnvelope.data.verdict, 'unintegrated');
    assert.equal(registry.getSessionStatus('session-reconcile')?.bindings.packageIntegration, null);
    assert.equal(readFileSync(packagePath, 'utf8'), originalPackage);
    assert.equal(readFileSync(metroConfigPath, 'utf8'), originalMetroConfig);

    // Repeating the recovery action mutates nothing and points at release.
    const repeated = await handler({ action: 'restore_integration', confirmed: true });
    assert.equal(repeated.isError, true);
    const repeatedEnvelope = envelope(repeated);
    assert.match(String(repeatedEnvelope.error), /unavailable for restoration/);
    assert.match(
      String((repeatedEnvelope.meta as { nextAction?: string })?.nextAction),
      /proceed to release/,
    );
    assert.equal(registry.getSessionStatus('session-reconcile')?.bindings.packageIntegration, null);
    assert.equal(readFileSync(packagePath, 'utf8'), originalPackage);

    const released = await handler({ action: 'release' });
    assert.equal(released.isError, undefined, released.content[0]!.text);
    registry.close();
  } finally {
    if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousStateHome;
    rmSync(root, { force: true, recursive: true });
  }
});

test('reconciliation refuses integrated, partially integrated, and ambiguous canonical files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-reconcile-refusals-'));
  const stateHome = join(root, 'state');
  const previousStateHome = process.env.XDG_STATE_HOME;
  try {
    const appRoot = createAppFixture(root);
    process.env.XDG_STATE_HOME = stateHome;
    const source = resolveSourceIdentity(appRoot);
    const layout = createAuthorityStateLayout();
    const registry = openSessionRegistry(layout.registry, { ownerStatus: () => 'match' });
    const session = registry.createSession({
      sessionId: 'session-refusals',
      sourceKey: source.sourceKey,
      worktreeKey: source.worktreeKey,
      appRootKey: source.appRootKey,
      supervisor: { pid: process.pid, token: 'fixture' },
      source: { ...source },
      bindings: { metroPort: 8248 },
    });
    registry.updateBindings(session, {
      state: 'device_claimed',
      bindings: { packageIntegration: { ...R20_LEGACY_BINDING } },
    });
    const handler = createSessionHandler(createRuntime(registry, session));

    const scenarios: Array<{
      name: string;
      packageJson: Record<string, unknown>;
      metroConfig: string;
      expected: RegExp;
    }> = [
      {
        name: 'fully integrated',
        packageJson: { scripts: { ...ADAPTER_SENTINELS } },
        metroConfig: METRO_INTEGRATED,
        expected: /integrated: package-script-ios-adapter/,
      },
      {
        name: 'partial: only the ios script is wrapped',
        packageJson: { scripts: { ios: ADAPTER_SENTINELS.ios, android: 'expo run:android' } },
        metroConfig: 'module.exports = {};\n',
        expected: /partial: package-script-ios-adapter/,
      },
      {
        name: 'ambiguous: corrupt metro sentinel pair',
        packageJson: { scripts: { ios: 'expo run:ios', android: 'expo run:android' } },
        metroConfig: 'module.exports = {};\n// rn-dev-agent session integration: begin\n',
        expected: /partial: metro-sentinel-begin/,
      },
      {
        name: 'ambiguous: stray adapter reference',
        packageJson: {
          scripts: {
            ios: 'expo run:ios',
            android: 'expo run:android',
            start: 'node .rn-agent/integration/rn-session-adapter.cjs start',
          },
        },
        metroConfig: 'module.exports = {};\n',
        expected: /partial: package-script-adapter-reference/,
      },
    ];
    for (const scenario of scenarios) {
      writeFileSync(
        join(appRoot, 'package.json'),
        `${JSON.stringify(scenario.packageJson, null, 2)}\n`,
      );
      writeFileSync(join(appRoot, 'metro.config.js'), scenario.metroConfig);
      const packageBefore = readFileSync(join(appRoot, 'package.json'), 'utf8');
      const metroBefore = readFileSync(join(appRoot, 'metro.config.js'), 'utf8');

      const refused = await handler({ action: 'restore_integration', confirmed: true });
      assert.equal(refused.isError, true, scenario.name);
      const refusal = envelope(refused);
      assert.match(String(refusal.error), /not provably unintegrated/, scenario.name);
      assert.match(String(refusal.error), scenario.expected, scenario.name);
      assert.match(
        String((refusal.meta as { nextAction?: string })?.nextAction),
        /version control history/,
        scenario.name,
      );
      assert.deepEqual(
        registry.getSessionStatus('session-refusals')?.bindings.packageIntegration,
        R20_LEGACY_BINDING,
        scenario.name,
      );
      assert.equal(readFileSync(join(appRoot, 'package.json'), 'utf8'), packageBefore);
      assert.equal(readFileSync(join(appRoot, 'metro.config.js'), 'utf8'), metroBefore);

      const blockedRelease = await handler({ action: 'release' });
      assert.equal(blockedRelease.isError, true, scenario.name);
      assert.match(
        blockedRelease.content[0]!.text,
        /package integration must be restored before session release/,
        scenario.name,
      );
    }
    registry.close();
  } finally {
    if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousStateHome;
    rmSync(root, { force: true, recursive: true });
  }
});

test('a foreign worktree cannot adopt or reconcile the stale binding', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-foreign-adopter-'));
  const stateHome = join(root, 'state');
  const previousStateHome = process.env.XDG_STATE_HOME;
  try {
    const appRoot = createAppFixture(root);
    const foreignRoot = join(root, 'foreign');
    execFileSync('git', ['init', '-q', foreignRoot]);
    execFileSync('git', ['-C', foreignRoot, 'config', 'user.email', 'test@example.invalid']);
    execFileSync('git', ['-C', foreignRoot, 'config', 'user.name', 'Test']);
    writeFileSync(
      join(foreignRoot, 'package.json'),
      `${JSON.stringify({ scripts: { ios: 'expo run:ios', android: 'expo run:android' } }, null, 2)}\n`,
    );
    writeFileSync(join(foreignRoot, 'metro.config.js'), 'module.exports = {};\n');
    execFileSync('git', ['-C', foreignRoot, 'add', 'package.json', 'metro.config.js']);
    execFileSync('git', [
      '-C',
      foreignRoot,
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-qm',
      'foreign',
    ]);
    process.env.XDG_STATE_HOME = stateHome;
    const layout = createAuthorityStateLayout();
    const fixture = setupStaleAdoption({
      appRoot,
      registryPath: layout.registry,
      adopterAppRoot: foreignRoot,
    });
    const { registry, adopter, handle } = fixture;
    const handler = createSessionHandler(createRuntime(registry, adopter));

    const refused = await handler({ action: 'adopt_stale', adoptionHandle: handle });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0]!.text, /SOURCE_WORKTREE_MISMATCH/);
    assert.deepEqual(
      registry.getSessionStatus('session-prior')?.bindings.packageIntegration,
      R20_LEGACY_BINDING,
      'a foreign adopter must never transfer or clear the binding',
    );
    assert.equal(registry.getSessionStatus('session-prior')?.state, 'device_claimed');
    registry.close();
  } finally {
    if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousStateHome;
    rmSync(root, { force: true, recursive: true });
  }
});

test('adoption of a restorable transferred binding reports the restoration duty', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-restorable-adoption-'));
  const stateHome = join(root, 'state');
  const previousStateHome = process.env.XDG_STATE_HOME;
  try {
    const appRoot = createAppFixture(root);
    const packagePath = join(appRoot, 'package.json');
    const metroConfigPath = join(appRoot, 'metro.config.js');
    const originalPackage = readFileSync(packagePath, 'utf8');
    const originalMetroConfig = readFileSync(metroConfigPath, 'utf8');
    process.env.XDG_STATE_HOME = stateHome;
    const source = resolveSourceIdentity(appRoot);
    const layout = createAuthorityStateLayout();

    // A prior session applies integration for real, then goes stale; its binding
    // now carries the durable manifest and must adopt as restorable.
    const installer = openSessionRegistry(layout.registry, { ownerStatus: () => 'match' });
    const installerSession = installer.createSession({
      sessionId: 'session-installer',
      sourceKey: source.sourceKey,
      worktreeKey: source.worktreeKey,
      appRootKey: source.appRootKey,
      supervisor: { pid: process.pid, token: 'installer-supervisor' },
      source: { ...source },
      bindings: { metroPort: 8248 },
    });
    installer.updateBindings(installerSession, { state: 'device_claimed', bindings: {} });
    const installerHandler = createSessionHandler(createRuntime(installer, installerSession));
    const applied = await installerHandler({ action: 'apply_integration', confirmed: true });
    assert.equal(applied.isError, undefined, applied.content[0]!.text);
    const installedBinding = installer.getSessionStatus('session-installer')?.bindings
      .packageIntegration as Record<string, unknown>;
    installer.close();

    const registryPath = layout.registry;
    const ownerStatus = ({ sessionId }: { sessionId: string }) =>
      sessionId === 'session-installer' ? 'mismatch' : 'match';
    const registry = openSessionRegistry(registryPath, { ownerStatus });
    const adopter = registry.createSession({
      sessionId: 'session-adopter',
      sourceKey: source.sourceKey,
      worktreeKey: source.worktreeKey,
      appRootKey: source.appRootKey,
      supervisor: { pid: process.pid, token: 'adopter-supervisor' },
      source: { ...source },
      bindings: { metroPort: 8248 },
    });
    registry.updateBindings(adopter, {
      state: 'blocked',
      bindings: {
        recoveryCapabilityHash: createHash('sha256').update('recovery-capability').digest('hex'),
        adoptionRequired: { sessionId: 'session-installer', claimEpoch: 1 },
      },
    });
    registry.bindRecoveryWorker(
      adopter,
      { instanceId: 'recovery-worker', pid: process.pid, token: 'recovery-birth' },
      'recovery-capability',
    );
    const handle = (
      registry.getSessionStatus('session-adopter')?.bindings.recoveryHandles as {
        adoptStale?: { token?: string };
      }
    )?.adoptStale?.token;
    assert.ok(typeof handle === 'string');
    const handler = createSessionHandler(createRuntime(registry, adopter));

    const adopted = await handler({ action: 'adopt_stale', adoptionHandle: handle });
    assert.equal(adopted.isError, undefined, adopted.content[0]!.text);
    const adoptedEnvelope = envelope(adopted);
    assert.deepEqual(adoptedEnvelope.data.integrationRestoration, {
      required: true,
      action: 'restore_integration',
      installedBySessionId: 'session-installer',
    });
    assert.match(String(adoptedEnvelope.data.nextAction), /restore_integration/);
    assert.deepEqual(
      registry.getSessionStatus('session-adopter')?.bindings.packageIntegration,
      installedBinding,
      'a restorable binding transfers unchanged',
    );

    // Status now names the effective durable fence honestly.
    const statusResult = await handler({ action: 'status' });
    const diagnostic = (
      envelope(statusResult).data.authority as {
        migration: {
          packageIntegration: {
            installed: boolean;
            binding: {
              installedBySessionId: string;
              ownedByThisSession: boolean;
              manifestAvailable: boolean;
              nextAction: string;
            } | null;
          };
        };
      }
    ).migration.packageIntegration;
    assert.equal(diagnostic.installed, true);
    assert.equal(diagnostic.binding?.installedBySessionId, 'session-installer');
    assert.equal(diagnostic.binding?.ownedByThisSession, false);
    assert.equal(diagnostic.binding?.manifestAvailable, true);
    assert.match(String(diagnostic.binding?.nextAction), /restore_integration/);

    const restored = await handler({ action: 'restore_integration', confirmed: true });
    assert.equal(restored.isError, undefined, restored.content[0]!.text);
    assert.equal(readFileSync(packagePath, 'utf8'), originalPackage);
    assert.equal(readFileSync(metroConfigPath, 'utf8'), originalMetroConfig);
    const released = await handler({ action: 'release' });
    assert.equal(released.isError, undefined, released.content[0]!.text);
    registry.close();
  } finally {
    if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousStateHome;
    rmSync(root, { force: true, recursive: true });
  }
});

const CORRUPT_MANIFEST_SOURCE = '{"version":1,"tampered":true}\n';

function writeOnDiskManifest(appRoot: string, contents: string): string {
  const integrationDir = join(appRoot, '.rn-agent', 'integration');
  mkdirSync(integrationDir, { recursive: true });
  const manifestPath = join(integrationDir, 'rn-session-integration.json');
  writeFileSync(manifestPath, contents);
  return manifestPath;
}

test('adoption refuses a corrupt on-disk manifest instead of claiming it restorable', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-corrupt-disk-manifest-'));
  const stateHome = join(root, 'state');
  const previousStateHome = process.env.XDG_STATE_HOME;
  try {
    const appRoot = createAppFixture(root);
    const manifestPath = writeOnDiskManifest(appRoot, CORRUPT_MANIFEST_SOURCE);
    const packageBefore = readFileSync(join(appRoot, 'package.json'), 'utf8');
    const metroBefore = readFileSync(join(appRoot, 'metro.config.js'), 'utf8');
    process.env.XDG_STATE_HOME = stateHome;
    const layout = createAuthorityStateLayout();
    const fixture = setupStaleAdoption({ appRoot, registryPath: layout.registry });
    const { registry, adopter, handle } = fixture;
    const handler = createSessionHandler(createRuntime(registry, adopter));

    const refused = await handler({ action: 'adopt_stale', adoptionHandle: handle });
    assert.equal(refused.isError, true);
    const refusal = envelope(refused);
    assert.match(String(refusal.error), /not provably unintegrated/);
    assert.match(String(refusal.error), /integration-file:rn-session-integration\.json/);
    assert.match(
      String((refusal.meta as { nextAction?: string })?.nextAction),
      /version control history/,
    );

    // The mismatching manifest never becomes restoration authority and nothing transfers.
    assert.equal(registry.getSessionStatus('session-adopter')?.state, 'blocked');
    assert.equal(registry.getSessionStatus('session-prior')?.state, 'device_claimed');
    assert.deepEqual(
      registry.getSessionStatus('session-prior')?.bindings.packageIntegration,
      R20_LEGACY_BINDING,
    );
    assert.equal(readFileSync(manifestPath, 'utf8'), CORRUPT_MANIFEST_SOURCE);
    assert.equal(readFileSync(join(appRoot, 'package.json'), 'utf8'), packageBefore);
    assert.equal(readFileSync(join(appRoot, 'metro.config.js'), 'utf8'), metroBefore);
    registry.close();
  } finally {
    if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousStateHome;
    rmSync(root, { force: true, recursive: true });
  }
});

test('adoption reconciles corrupt in-flight sources when files are provably unintegrated', async () => {
  const inflightShapes: Array<{ name: string; priorIntegration: Record<string, unknown> }> = [
    {
      name: 'installation',
      priorIntegration: {
        ...R20_LEGACY_BINDING,
        installation: { phase: 'started', manifestSource: CORRUPT_MANIFEST_SOURCE },
      },
    },
    {
      name: 'restoration',
      priorIntegration: {
        ...R20_LEGACY_BINDING,
        restoration: { phase: 'started', manifestSource: CORRUPT_MANIFEST_SOURCE },
      },
    },
  ];
  for (const shape of inflightShapes) {
    const root = mkdtempSync(join(tmpdir(), `rn-session-corrupt-${shape.name}-reconcile-`));
    const stateHome = join(root, 'state');
    const previousStateHome = process.env.XDG_STATE_HOME;
    try {
      const appRoot = createAppFixture(root);
      const packageBefore = readFileSync(join(appRoot, 'package.json'), 'utf8');
      const metroBefore = readFileSync(join(appRoot, 'metro.config.js'), 'utf8');
      process.env.XDG_STATE_HOME = stateHome;
      const layout = createAuthorityStateLayout();
      const fixture = setupStaleAdoption({
        appRoot,
        registryPath: layout.registry,
        priorIntegration: shape.priorIntegration,
      });
      const { registry, adopter, handle } = fixture;
      const handler = createSessionHandler(createRuntime(registry, adopter));

      const adopted = await handler({ action: 'adopt_stale', adoptionHandle: handle });
      assert.equal(adopted.isError, undefined, `${shape.name}: ${adopted.content[0]!.text}`);
      const adoptedEnvelope = envelope(adopted);
      assert.deepEqual(
        adoptedEnvelope.data.integrationReconciled,
        {
          cleared: true,
          verdict: 'unintegrated',
          priorInstalledBySessionId: R20_LEGACY_BINDING.installedBySessionId,
          reason:
            'transferred integration binding had no recoverable manifest and canonical files are provably unintegrated',
        },
        shape.name,
      );
      assert.equal(
        registry.getSessionStatus('session-adopter')?.bindings.packageIntegration,
        null,
        `${shape.name}: a mismatching in-flight source must never survive as restoration authority`,
      );
      assert.equal(readFileSync(join(appRoot, 'package.json'), 'utf8'), packageBefore, shape.name);
      assert.equal(readFileSync(join(appRoot, 'metro.config.js'), 'utf8'), metroBefore, shape.name);
      registry.close();
    } finally {
      if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = previousStateHome;
      rmSync(root, { force: true, recursive: true });
    }
  }
});

test('adoption refuses corrupt in-flight sources before transfer when files carry integration', async () => {
  const inflightShapes: Array<{ name: string; priorIntegration: Record<string, unknown> }> = [
    {
      name: 'installation',
      priorIntegration: {
        ...R20_LEGACY_BINDING,
        installation: { phase: 'started', manifestSource: CORRUPT_MANIFEST_SOURCE },
      },
    },
    {
      name: 'restoration',
      priorIntegration: {
        ...R20_LEGACY_BINDING,
        restoration: { phase: 'started', manifestSource: CORRUPT_MANIFEST_SOURCE },
      },
    },
  ];
  for (const shape of inflightShapes) {
    const root = mkdtempSync(join(tmpdir(), `rn-session-corrupt-${shape.name}-refuse-`));
    const stateHome = join(root, 'state');
    const previousStateHome = process.env.XDG_STATE_HOME;
    try {
      const appRoot = createAppFixture(root);
      writeFileSync(
        join(appRoot, 'package.json'),
        `${JSON.stringify({ scripts: { ...ADAPTER_SENTINELS } }, null, 2)}\n`,
      );
      writeFileSync(join(appRoot, 'metro.config.js'), METRO_INTEGRATED);
      const integratedPackage = readFileSync(join(appRoot, 'package.json'), 'utf8');
      const integratedMetro = readFileSync(join(appRoot, 'metro.config.js'), 'utf8');
      process.env.XDG_STATE_HOME = stateHome;
      const layout = createAuthorityStateLayout();
      const fixture = setupStaleAdoption({
        appRoot,
        registryPath: layout.registry,
        priorIntegration: shape.priorIntegration,
      });
      const { registry, adopter, handle } = fixture;
      const handler = createSessionHandler(createRuntime(registry, adopter));

      const refused = await handler({ action: 'adopt_stale', adoptionHandle: handle });
      assert.equal(refused.isError, true, shape.name);
      const refusal = envelope(refused);
      assert.match(String(refusal.error), /not provably unintegrated/, shape.name);
      assert.match(String(refusal.error), /integrated/, shape.name);
      assert.match(
        String((refusal.meta as { nextAction?: string })?.nextAction),
        /version control history/,
        shape.name,
      );

      assert.equal(registry.getSessionStatus('session-adopter')?.state, 'blocked', shape.name);
      assert.equal(registry.getSessionStatus('session-prior')?.state, 'device_claimed', shape.name);
      assert.deepEqual(
        registry.getSessionStatus('session-prior')?.bindings.packageIntegration,
        shape.priorIntegration,
        `${shape.name}: the prior binding must survive the refusal untouched`,
      );
      assert.equal(
        readFileSync(join(appRoot, 'package.json'), 'utf8'),
        integratedPackage,
        shape.name,
      );
      assert.equal(
        readFileSync(join(appRoot, 'metro.config.js'), 'utf8'),
        integratedMetro,
        shape.name,
      );
      registry.close();
    } finally {
      if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = previousStateHome;
      rmSync(root, { force: true, recursive: true });
    }
  }
});

test('restore_integration routes a corrupt on-disk manifest to reconciliation refusal', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-corrupt-restore-'));
  const stateHome = join(root, 'state');
  const previousStateHome = process.env.XDG_STATE_HOME;
  try {
    const appRoot = createAppFixture(root);
    const manifestPath = writeOnDiskManifest(appRoot, CORRUPT_MANIFEST_SOURCE);
    const packageBefore = readFileSync(join(appRoot, 'package.json'), 'utf8');
    const metroBefore = readFileSync(join(appRoot, 'metro.config.js'), 'utf8');
    process.env.XDG_STATE_HOME = stateHome;
    const source = resolveSourceIdentity(appRoot);
    const layout = createAuthorityStateLayout();
    const registry = openSessionRegistry(layout.registry, { ownerStatus: () => 'match' });
    const session = registry.createSession({
      sessionId: 'session-corrupt-restore',
      sourceKey: source.sourceKey,
      worktreeKey: source.worktreeKey,
      appRootKey: source.appRootKey,
      supervisor: { pid: process.pid, token: 'fixture' },
      source: { ...source },
      bindings: { metroPort: 8248 },
    });
    registry.updateBindings(session, {
      state: 'device_claimed',
      bindings: { packageIntegration: { ...R20_LEGACY_BINDING } },
    });
    const handler = createSessionHandler(createRuntime(registry, session));

    const refused = await handler({ action: 'restore_integration', confirmed: true });
    assert.equal(refused.isError, true);
    const refusal = envelope(refused);
    assert.match(String(refusal.error), /not provably unintegrated/);
    assert.match(String(refusal.error), /integration-file:rn-session-integration\.json/);
    assert.match(
      String((refusal.meta as { nextAction?: string })?.nextAction),
      /version control history/,
    );

    // The mismatching manifest was never treated as restoration authority.
    assert.deepEqual(
      registry.getSessionStatus('session-corrupt-restore')?.bindings.packageIntegration,
      R20_LEGACY_BINDING,
    );
    assert.equal(readFileSync(manifestPath, 'utf8'), CORRUPT_MANIFEST_SOURCE);
    assert.equal(readFileSync(join(appRoot, 'package.json'), 'utf8'), packageBefore);
    assert.equal(readFileSync(join(appRoot, 'metro.config.js'), 'utf8'), metroBefore);
    registry.close();
  } finally {
    if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousStateHome;
    rmSync(root, { force: true, recursive: true });
  }
});

test('status manifestAvailable requires a sha-verified manifest candidate', async () => {
  const VERIFIED_MANIFEST_SOURCE = '{"version":1,"adapter":"rn-session-adapter"}\n';
  const verifiedSha = createHash('sha256').update(VERIFIED_MANIFEST_SOURCE).digest('hex');
  const scenarios: Array<{
    name: string;
    onDiskManifest?: string;
    binding: Record<string, unknown>;
    installed: boolean;
    manifestAvailable: boolean;
    nextAction: RegExp;
  }> = [
    {
      name: 'corrupt on-disk manifest',
      onDiskManifest: CORRUPT_MANIFEST_SOURCE,
      binding: { ...R20_LEGACY_BINDING },
      installed: true,
      manifestAvailable: false,
      nextAction: /provably unintegrated/,
    },
    {
      name: 'corrupt installation in-flight source',
      binding: {
        ...R20_LEGACY_BINDING,
        installation: { phase: 'started', manifestSource: CORRUPT_MANIFEST_SOURCE },
      },
      installed: false,
      manifestAvailable: false,
      nextAction: /provably unintegrated/,
    },
    {
      name: 'corrupt restoration in-flight source',
      binding: {
        ...R20_LEGACY_BINDING,
        restoration: { phase: 'started', manifestSource: CORRUPT_MANIFEST_SOURCE },
      },
      installed: false,
      manifestAvailable: false,
      nextAction: /provably unintegrated/,
    },
    {
      name: 'verified restoration in-flight source',
      binding: {
        version: 1,
        installedBySessionId: R20_LEGACY_BINDING.installedBySessionId,
        manifestSha256: verifiedSha,
        restoration: { phase: 'started', manifestSource: VERIFIED_MANIFEST_SOURCE },
      },
      installed: false,
      manifestAvailable: true,
      nextAction: /restore canonical files/,
    },
    {
      name: 'verified durable binding source',
      binding: {
        version: 1,
        installedBySessionId: R20_LEGACY_BINDING.installedBySessionId,
        manifestSha256: verifiedSha,
        manifestSource: VERIFIED_MANIFEST_SOURCE,
      },
      installed: false,
      manifestAvailable: true,
      nextAction: /restore canonical files/,
    },
  ];
  for (const scenario of scenarios) {
    const root = mkdtempSync(join(tmpdir(), 'rn-session-status-verified-'));
    const stateHome = join(root, 'state');
    const previousStateHome = process.env.XDG_STATE_HOME;
    try {
      const appRoot = createAppFixture(root);
      if (scenario.onDiskManifest !== undefined) {
        writeOnDiskManifest(appRoot, scenario.onDiskManifest);
      }
      process.env.XDG_STATE_HOME = stateHome;
      const source = resolveSourceIdentity(appRoot);
      const layout = createAuthorityStateLayout();
      const registry = openSessionRegistry(layout.registry, { ownerStatus: () => 'match' });
      const session = registry.createSession({
        sessionId: 'session-status-verified',
        sourceKey: source.sourceKey,
        worktreeKey: source.worktreeKey,
        appRootKey: source.appRootKey,
        supervisor: { pid: process.pid, token: 'fixture' },
        source: { ...source },
        bindings: { metroPort: 8248 },
      });
      registry.updateBindings(session, {
        state: 'device_claimed',
        bindings: { packageIntegration: scenario.binding },
      });
      const handler = createSessionHandler(createRuntime(registry, session));

      const statusResult = await handler({ action: 'status' });
      const diagnostic = (
        envelope(statusResult).data.authority as {
          migration: {
            packageIntegration: {
              installed: boolean;
              binding: { manifestAvailable: boolean; nextAction: string } | null;
            };
          };
        }
      ).migration.packageIntegration;
      assert.equal(diagnostic.installed, scenario.installed, scenario.name);
      assert.equal(
        diagnostic.binding?.manifestAvailable,
        scenario.manifestAvailable,
        scenario.name,
      );
      assert.match(String(diagnostic.binding?.nextAction), scenario.nextAction, scenario.name);
      assert.doesNotMatch(
        statusResult.content[0]!.text,
        /manifestSource|manifestSha256|tampered|rn-session-adapter/,
        `${scenario.name}: status must not expose manifest bytes or digests`,
      );
      registry.close();
    } finally {
      if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = previousStateHome;
      rmSync(root, { force: true, recursive: true });
    }
  }
});

test('status exposes a manifest-less binding fence with its recovery action', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-status-fence-'));
  const stateHome = join(root, 'state');
  const previousStateHome = process.env.XDG_STATE_HOME;
  try {
    const appRoot = createAppFixture(root);
    process.env.XDG_STATE_HOME = stateHome;
    const source = resolveSourceIdentity(appRoot);
    const layout = createAuthorityStateLayout();
    const registry = openSessionRegistry(layout.registry, { ownerStatus: () => 'match' });
    const session = registry.createSession({
      sessionId: 'session-status',
      sourceKey: source.sourceKey,
      worktreeKey: source.worktreeKey,
      appRootKey: source.appRootKey,
      supervisor: { pid: process.pid, token: 'fixture' },
      source: { ...source },
      bindings: { metroPort: 8248 },
    });
    registry.updateBindings(session, {
      state: 'device_claimed',
      bindings: { packageIntegration: { ...R20_LEGACY_BINDING } },
    });
    const handler = createSessionHandler(createRuntime(registry, session));

    const statusResult = await handler({ action: 'status' });
    const diagnostic = (
      envelope(statusResult).data.authority as {
        migration: {
          packageIntegration: {
            installed: boolean;
            binding: {
              installedBySessionId: string;
              ownedByThisSession: boolean;
              manifestAvailable: boolean;
              nextAction: string;
            } | null;
          };
        };
      }
    ).migration.packageIntegration;
    assert.equal(diagnostic.installed, false);
    assert.equal(diagnostic.binding?.installedBySessionId, R20_LEGACY_BINDING.installedBySessionId);
    assert.equal(diagnostic.binding?.ownedByThisSession, false);
    assert.equal(diagnostic.binding?.manifestAvailable, false);
    assert.match(String(diagnostic.binding?.nextAction), /restore_integration/);
    assert.doesNotMatch(statusResult.content[0]!.text, /manifestSource/);

    // The r20 apply refusal now names the supported recovery instead of a dead end.
    const refusedApply = await handler({ action: 'apply_integration', confirmed: true });
    assert.equal(refusedApply.isError, true);
    const applyRefusal = envelope(refusedApply);
    assert.match(String(applyRefusal.error), /already owned by an active session lifecycle/);
    assert.match(
      String((applyRefusal.meta as { nextAction?: string })?.nextAction),
      /restore_integration/,
    );
    registry.close();
  } finally {
    if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousStateHome;
    rmSync(root, { force: true, recursive: true });
  }
});
