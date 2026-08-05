import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openSessionRegistry } from '../../../dist/session/registry.js';
import { projectPublicAuthorityStatus } from '../../../dist/session/public-status.js';
import { resolveSourceIdentity } from '../../../dist/session/source-identity.js';
import { createAuthorityStateLayout } from '../../../dist/session/state-root.js';
import { createSessionHandler } from '../../../dist/tools/session.js';

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
  const recovery = registry as {
    inspectRecoveryRequirement?: (sessionId: string) => unknown;
  };
  return {
    status: () => ({ available: true, ...(registry.getSessionStatus(ref.sessionId) as object) }),
    requireAvailable: () => ({ registry, session: ref }),
    requireOperational: () => ({ registry, session: ref }),
    requireRecovery: () => ({ registry, session: ref }),
    refreshRecoveryHandles: () => false,
    inspectRecoveryRequirement: () => recovery.inspectRecoveryRequirement?.(ref.sessionId),
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
  omitAdopterAppRoot?: boolean;
}): AdoptionFixture {
  const source = resolveSourceIdentity(input.appRoot);
  const adopterSource = input.adopterAppRoot ? resolveSourceIdentity(input.adopterAppRoot) : source;
  const adopterSessionSource: Record<string, unknown> = { ...adopterSource };
  if (input.omitAdopterAppRoot) delete adopterSessionSource.appRoot;
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
    source: adopterSessionSource,
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

test('r20: adopting a manifest-less legacy binding refuses before transfer even when files are provably unintegrated', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-r20-refuse-unintegrated-'));
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
    const { registry, adopter, handle } = fixture;
    const handler = createSessionHandler(createRuntime(registry, adopter));
    const adopterBefore = registry.getSessionStatus('session-adopter');
    const priorBefore = registry.getSessionStatus('session-prior');

    const refused = await handler({ action: 'adopt_stale', adoptionHandle: handle });
    assert.equal(refused.isError, true);
    const refusal = envelope(refused);
    assert.match(String(refusal.error), /without a SHA-256-verified restoration manifest/);
    assert.match(
      String(refusal.error),
      /unintegrated: no-integration-markers/,
      'an unintegrated verdict is reported as a diagnostic and never authorizes transfer',
    );
    assert.match(
      String((refusal.meta as { nextAction?: string })?.nextAction),
      /version control history/,
    );

    const adopterAfter = registry.getSessionStatus('session-adopter');
    const priorAfter = registry.getSessionStatus('session-prior');
    assert.equal(adopterAfter?.state, 'blocked');
    assert.equal(adopterAfter?.authorityVersion, adopterBefore?.authorityVersion);
    assert.equal(adopterAfter?.bindings.packageIntegration, undefined);
    assert.equal(priorAfter?.state, 'device_claimed');
    assert.equal(priorAfter?.authorityVersion, priorBefore?.authorityVersion);
    assert.deepEqual(priorAfter?.bindings.packageIntegration, R20_LEGACY_BINDING);
    assert.deepEqual(priorAfter?.claims, priorBefore?.claims);
    assert.equal(readFileSync(packagePath, 'utf8'), originalPackage);
    assert.equal(readFileSync(metroConfigPath, 'utf8'), originalMetroConfig);
    registry.close();
  } finally {
    if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousStateHome;
    rmSync(root, { force: true, recursive: true });
  }
});

test('a byte-exact on-disk manifest authorizes only the owner restore, never an adoption transfer', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-manifest-recovery-'));
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
    const fixture = setupStaleAdoption({
      appRoot,
      registryPath: layout.registry,
      priorIntegration: null,
    });
    const { registry, prior, adopter, handle } = fixture;

    const priorHandler = createSessionHandler(createRuntime(registry, prior));
    const applied = await priorHandler({ action: 'apply_integration', confirmed: true });
    assert.equal(applied.isError, undefined, applied.content[0]!.text);
    const manifestPath = join(appRoot, '.rn-agent', 'integration', 'rn-session-integration.json');
    const manifestBytes = readFileSync(manifestPath, 'utf8');
    const digestOnlyBinding = {
      version: 1,
      installedBySessionId: 'session-prior',
      manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
    };
    registry.updateBindings(prior, { bindings: { packageIntegration: digestOnlyBinding } });

    const handler = createSessionHandler(createRuntime(registry, adopter));
    const refused = await handler({ action: 'adopt_stale', adoptionHandle: handle });
    assert.equal(refused.isError, true);
    const refusal = envelope(refused);
    assert.match(
      String(refusal.error),
      /without a SHA-256-verified restoration manifest/,
      'the byte-exact on-disk manifest must not satisfy transfer eligibility',
    );
    assert.match(
      String((refusal.meta as { nextAction?: string })?.nextAction),
      /never authorize a transfer/,
    );
    assert.equal(registry.getSessionStatus('session-adopter')?.state, 'blocked');
    assert.deepEqual(
      registry.getSessionStatus('session-prior')?.bindings.packageIntegration,
      digestOnlyBinding,
    );

    const restored = await priorHandler({ action: 'restore_integration', confirmed: true });
    assert.equal(restored.isError, undefined, restored.content[0]!.text);
    assert.equal(readFileSync(packagePath, 'utf8'), originalPackage);
    assert.equal(readFileSync(metroConfigPath, 'utf8'), originalMetroConfig);
    assert.equal(registry.getSessionStatus('session-prior')?.bindings.packageIntegration, null);

    const adopted = await handler({ action: 'adopt_stale', adoptionHandle: handle });
    assert.equal(adopted.isError, undefined, adopted.content[0]!.text);
    assert.deepEqual(envelope(adopted).data.integrationRestoration, { required: false });
    const released = await handler({ action: 'release' });
    assert.equal(released.isError, undefined, released.content[0]!.text);
    registry.close();
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
    assert.match(String(refusal.error), /without a SHA-256-verified restoration manifest/);
    assert.match(String(refusal.error), /integrated: package-script-ios-adapter/);
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

test('adoption refuses before transfer when the prior binding is manifest-less and the app root is unavailable', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-r20-no-app-root-'));
  const stateHome = join(root, 'state');
  const previousStateHome = process.env.XDG_STATE_HOME;
  try {
    const appRoot = createAppFixture(root);
    const originalPackage = readFileSync(join(appRoot, 'package.json'), 'utf8');
    const originalMetroConfig = readFileSync(join(appRoot, 'metro.config.js'), 'utf8');
    process.env.XDG_STATE_HOME = stateHome;
    const layout = createAuthorityStateLayout();
    const fixture = setupStaleAdoption({
      appRoot,
      registryPath: layout.registry,
      omitAdopterAppRoot: true,
    });
    const { registry, adopter, handle } = fixture;
    const handler = createSessionHandler(createRuntime(registry, adopter));
    const adopterBefore = registry.getSessionStatus('session-adopter');
    const priorBefore = registry.getSessionStatus('session-prior');

    const refused = await handler({ action: 'adopt_stale', adoptionHandle: handle });
    assert.equal(refused.isError, true);
    const refusal = envelope(refused);
    assert.match(String(refusal.error), /without a SHA-256-verified restoration manifest/);
    assert.match(String(refusal.error), /app-root-unavailable/);
    assert.match(
      String((refusal.meta as { nextAction?: string })?.nextAction),
      /version control history/,
    );

    const adopterAfter = registry.getSessionStatus('session-adopter');
    const priorAfter = registry.getSessionStatus('session-prior');
    assert.equal(adopterAfter?.state, 'blocked');
    assert.equal(adopterAfter?.authorityVersion, adopterBefore?.authorityVersion);
    assert.equal(adopterAfter?.bindings.packageIntegration, undefined);
    assert.equal(priorAfter?.state, 'device_claimed');
    assert.equal(priorAfter?.authorityVersion, priorBefore?.authorityVersion);
    assert.deepEqual(priorAfter?.bindings.packageIntegration, R20_LEGACY_BINDING);
    assert.deepEqual(priorAfter?.claims, priorBefore?.claims);
    assert.equal(readFileSync(join(appRoot, 'package.json'), 'utf8'), originalPackage);
    assert.equal(readFileSync(join(appRoot, 'metro.config.js'), 'utf8'), originalMetroConfig);
    registry.close();
  } finally {
    if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousStateHome;
    rmSync(root, { force: true, recursive: true });
  }
});

test('restore_integration preserves a manifest-less binding and refuses deterministically', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-manifestless-restore-'));
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

    const versionBefore = registry.getSessionStatus('session-reconcile')?.authorityVersion;
    const refused = await handler({ action: 'restore_integration', confirmed: true });
    assert.equal(refused.isError, true);
    const refusal = envelope(refused);
    assert.match(String(refusal.error), /requires a SHA-256-verified manifest/);
    assert.match(
      String(refusal.error),
      /unintegrated: no-integration-markers/,
      'an unintegrated verdict is diagnostic only and never clears the binding',
    );
    assert.match(
      String((refusal.meta as { nextAction?: string })?.nextAction),
      /version control history/,
    );
    assert.deepEqual(
      registry.getSessionStatus('session-reconcile')?.bindings.packageIntegration,
      R20_LEGACY_BINDING,
    );
    assert.equal(registry.getSessionStatus('session-reconcile')?.authorityVersion, versionBefore);
    assert.equal(readFileSync(packagePath, 'utf8'), originalPackage);
    assert.equal(readFileSync(metroConfigPath, 'utf8'), originalMetroConfig);

    const repeated = await handler({ action: 'restore_integration', confirmed: true });
    assert.equal(repeated.isError, true);
    assert.match(String(envelope(repeated).error), /requires a SHA-256-verified manifest/);
    assert.deepEqual(
      registry.getSessionStatus('session-reconcile')?.bindings.packageIntegration,
      R20_LEGACY_BINDING,
    );
    assert.equal(readFileSync(packagePath, 'utf8'), originalPackage);

    const blockedRelease = await handler({ action: 'release' });
    assert.equal(blockedRelease.isError, true);
    assert.match(
      blockedRelease.content[0]!.text,
      /package integration must be restored before session release/,
    );
    registry.close();
  } finally {
    if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousStateHome;
    rmSync(root, { force: true, recursive: true });
  }
});

test('manifest-less restoration refuses integrated, partially integrated, and ambiguous canonical files', async () => {
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
      assert.match(String(refusal.error), /requires a SHA-256-verified manifest/, scenario.name);
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
    const durableManifestSource = '{"version":1,"adapter":"rn-session-adapter"}\n';
    const durableBinding = {
      version: 1,
      installedBySessionId: R20_LEGACY_BINDING.installedBySessionId,
      manifestSha256: createHash('sha256').update(durableManifestSource).digest('hex'),
      manifestSource: durableManifestSource,
    };
    const fixture = setupStaleAdoption({
      appRoot,
      registryPath: layout.registry,
      adopterAppRoot: foreignRoot,
      priorIntegration: durableBinding,
    });
    const { registry, adopter, handle } = fixture;
    const handler = createSessionHandler(createRuntime(registry, adopter));

    const refused = await handler({ action: 'adopt_stale', adoptionHandle: handle });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0]!.text, /SOURCE_WORKTREE_MISMATCH/);
    assert.deepEqual(
      registry.getSessionStatus('session-prior')?.bindings.packageIntegration,
      durableBinding,
      'a foreign adopter must never transfer or clear the binding',
    );
    assert.equal(registry.getSessionStatus('session-prior')?.state, 'device_claimed');

    registry.updateBindings(fixture.prior, {
      bindings: { packageIntegration: { ...R20_LEGACY_BINDING } },
    });
    const manifestless = await handler({ action: 'adopt_stale', adoptionHandle: handle });
    assert.equal(manifestless.isError, true);
    assert.match(manifestless.content[0]!.text, /SOURCE_WORKTREE_MISMATCH/);
    assert.doesNotMatch(
      manifestless.content[0]!.text,
      /SHA-256|rn-session-integration/,
      'a foreign worktree must not learn the manifest state of the stale binding',
    );
    assert.deepEqual(
      registry.getSessionStatus('session-prior')?.bindings.packageIntegration,
      R20_LEGACY_BINDING,
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
              effectiveOwnerSessionId: string;
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
    assert.equal(diagnostic.binding?.effectiveOwnerSessionId, 'session-adopter');
    assert.equal(
      diagnostic.binding?.ownedByThisSession,
      true,
      'the adopter now holds restoration authority even though it never installed',
    );
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
    assert.match(String(refusal.error), /without a SHA-256-verified restoration manifest/);
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

test('adoption refuses corrupt in-flight sources even when files are provably unintegrated', async () => {
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
    const root = mkdtempSync(join(tmpdir(), `rn-session-corrupt-${shape.name}-refused-`));
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

      const refused = await handler({ action: 'adopt_stale', adoptionHandle: handle });
      assert.equal(refused.isError, true, shape.name);
      const refusal = envelope(refused);
      assert.match(
        String(refusal.error),
        /without a SHA-256-verified restoration manifest/,
        shape.name,
      );
      assert.match(
        String(refusal.error),
        /unintegrated: no-integration-markers/,
        `${shape.name}: the unintegrated diagnostic must never authorize transfer or clearing`,
      );
      assert.equal(registry.getSessionStatus('session-adopter')?.state, 'blocked', shape.name);
      assert.deepEqual(
        registry.getSessionStatus('session-prior')?.bindings.packageIntegration,
        shape.priorIntegration,
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
      assert.match(
        String(refusal.error),
        /without a SHA-256-verified restoration manifest/,
        shape.name,
      );
      assert.match(String(refusal.error), /integrated: package-script-ios-adapter/, shape.name);
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

test('restore_integration refuses a corrupt on-disk manifest and preserves the binding', async () => {
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
    assert.match(String(refusal.error), /requires a SHA-256-verified manifest/);
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
      nextAction: /version control history/,
    },
    {
      name: 'corrupt installation in-flight source',
      binding: {
        ...R20_LEGACY_BINDING,
        installation: { phase: 'started', manifestSource: CORRUPT_MANIFEST_SOURCE },
      },
      installed: false,
      manifestAvailable: false,
      nextAction: /version control history/,
    },
    {
      name: 'corrupt restoration in-flight source',
      binding: {
        ...R20_LEGACY_BINDING,
        restoration: { phase: 'started', manifestSource: CORRUPT_MANIFEST_SOURCE },
      },
      installed: false,
      manifestAvailable: false,
      nextAction: /version control history/,
    },
    {
      name: 'missing digest',
      binding: {
        version: 1,
        installedBySessionId: R20_LEGACY_BINDING.installedBySessionId,
      },
      installed: false,
      manifestAvailable: false,
      nextAction: /No trusted manifest digest is recorded/,
    },
    {
      name: 'malformed digest',
      binding: {
        version: 1,
        installedBySessionId: R20_LEGACY_BINDING.installedBySessionId,
        manifestSha256: R20_LEGACY_BINDING.manifestSha256.toUpperCase(),
      },
      installed: false,
      manifestAvailable: false,
      nextAction: /session-state-plus-manifest backup/,
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
        /manifestSource|manifestSha256|tampered|rn-session-adapter|\.rn-agent|rn-session-integration/,
        `${scenario.name}: status must not expose manifest bytes, digests, or manifest paths`,
      );
      const recordedDigest = scenario.binding.manifestSha256;
      if (typeof recordedDigest === 'string') {
        assert.equal(
          statusResult.content[0]!.text.includes(recordedDigest),
          false,
          `${scenario.name}: status must not expose the recorded digest value`,
        );
      }
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
              effectiveOwnerSessionId: string;
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
    assert.equal(diagnostic.binding?.effectiveOwnerSessionId, 'session-status');
    assert.equal(
      diagnostic.binding?.ownedByThisSession,
      true,
      'the session carrying the binding owns its recovery lifecycle',
    );
    assert.equal(diagnostic.binding?.manifestAvailable, false);
    assert.match(String(diagnostic.binding?.nextAction), /restore_integration/);
    assert.doesNotMatch(
      statusResult.content[0]!.text,
      /manifestSource|\.rn-agent|rn-session-integration/,
    );

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

test('adoption refuses a stale registry generation between preflight and transfer', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-proof-generation-'));
  const stateHome = join(root, 'state');
  const previousStateHome = process.env.XDG_STATE_HOME;
  try {
    const appRoot = createAppFixture(root);
    process.env.XDG_STATE_HOME = stateHome;
    const layout = createAuthorityStateLayout();
    const fixture = setupStaleAdoption({
      appRoot,
      registryPath: layout.registry,
      priorIntegration: null,
    });
    const { registry, adopter, handle } = fixture;
    const provenVersion = registry.getSessionStatus('session-adopter')!.authorityVersion;

    assert.throws(
      () =>
        registry.adoptStaleWithHandle(adopter, handle, 'recovery-worker', {
          expectedTargetAuthorityVersion: provenVersion - 1,
        }),
      /authority version changed after the adoption preflight proof/,
    );
    assert.equal(registry.getSessionStatus('session-adopter')?.state, 'blocked');
    assert.equal(registry.getSessionStatus('session-prior')?.state, 'device_claimed');

    registry.adoptStaleWithHandle(adopter, handle, 'recovery-worker', {
      expectedTargetAuthorityVersion: provenVersion,
    });
    assert.notEqual(registry.getSessionStatus('session-adopter')?.state, 'blocked');
    assert.equal(registry.getSessionStatus('session-prior')?.state, 'stale');
    registry.close();
  } finally {
    if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousStateHome;
    rmSync(root, { force: true, recursive: true });
  }
});

test('resumed cleanup refuses before any mutation when the transferred binding loses its verified manifest', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-resume-manifestless-'));
  const stateHome = join(root, 'state');
  const previousStateHome = process.env.XDG_STATE_HOME;
  try {
    const appRoot = createAppFixture(root);
    const packagePath = join(appRoot, 'package.json');
    const metroConfigPath = join(appRoot, 'metro.config.js');
    const originalPackage = readFileSync(packagePath, 'utf8');
    const originalMetro = readFileSync(metroConfigPath, 'utf8');
    process.env.XDG_STATE_HOME = stateHome;
    const layout = createAuthorityStateLayout();
    const fixture = setupStaleAdoption({
      appRoot,
      registryPath: layout.registry,
      priorIntegration: null,
    });
    const { prior, adopter, handle } = fixture;
    let registry = fixture.registry;

    const priorHandler = createSessionHandler(createRuntime(registry, prior));
    const applied = await priorHandler({ action: 'apply_integration', confirmed: true });
    assert.equal(applied.isError, undefined, applied.content[0]!.text);
    const manifestPath = join(appRoot, '.rn-agent', 'integration', 'rn-session-integration.json');
    registry.updateBindings(prior, { bindings: { observe: { port: 7396 } } });
    const durableBinding = registry.getSessionStatus('session-prior')?.bindings
      .packageIntegration as Record<string, unknown>;
    assert.equal(typeof durableBinding.manifestSource, 'string');

    const rewriteTransferredBinding = (packageIntegration: Record<string, unknown>) => {
      registry.close();
      const db = new DatabaseSync(layout.registry);
      const row = db
        .prepare('SELECT bindings_json FROM sessions WHERE session_id = ?')
        .get('session-adopter') as { bindings_json: string };
      const bindings = JSON.parse(row.bindings_json) as Record<string, unknown>;
      bindings.packageIntegration = packageIntegration;
      db.prepare('UPDATE sessions SET bindings_json = ? WHERE session_id = ?').run(
        JSON.stringify(bindings),
        'session-adopter',
      );
      db.close();
      registry = fixture.reopen();
    };

    let observeStops = 0;
    let failObserveStop = true;
    const createHandler = () =>
      createSessionHandler(createRuntime(registry, adopter), {
        stopHandoffObserve: async () => {
          if (failObserveStop) throw new Error('observe stop unavailable');
          observeStops += 1;
        },
      });
    let handler = createHandler();

    const crashed = await handler({ action: 'adopt_stale', adoptionHandle: handle });
    assert.equal(crashed.isError, true);
    assert.equal(registry.getSessionStatus('session-adopter')?.state, 'handoff_cleanup');
    assert.deepEqual(
      registry.getSessionStatus('session-adopter')?.bindings.packageIntegration,
      durableBinding,
      'a binding with durable restoration material transfers unchanged',
    );
    failObserveStop = false;

    const wrongHandle = await handler({ action: 'adopt_stale', adoptionHandle: 'wrong-handle' });
    assert.equal(wrongHandle.isError, true);
    assert.match(
      String(envelope(wrongHandle).error),
      /resumption requires the original adoption capability/,
    );
    assert.equal(observeStops, 0);

    rewriteTransferredBinding({
      version: durableBinding.version,
      installedBySessionId: durableBinding.installedBySessionId,
      manifestSha256: durableBinding.manifestSha256,
    });
    handler = createHandler();
    assert.equal(readFileSync(manifestPath, 'utf8').length > 0, true);
    const versionBeforeRefusal = registry.getSessionStatus('session-adopter')?.authorityVersion;
    const refused = await handler({ action: 'adopt_stale', adoptionHandle: handle });
    assert.equal(refused.isError, true);
    assert.match(
      String(envelope(refused).error),
      /without a SHA-256-verified restoration manifest/,
      'a byte-exact on-disk manifest must not satisfy resumed cleanup eligibility',
    );
    assert.equal(observeStops, 0, 'no cleanup may run for a manifest-less binding');
    assert.equal(registry.getSessionStatus('session-adopter')?.state, 'handoff_cleanup');
    assert.equal(
      registry.getSessionStatus('session-adopter')?.authorityVersion,
      versionBeforeRefusal,
      'no registry transition may happen for a manifest-less binding',
    );
    assert.ok(registry.getSessionStatus('session-adopter')?.bindings.packageIntegration);

    rewriteTransferredBinding(durableBinding);
    handler = createHandler();
    unlinkSync(manifestPath);
    const resumed = await handler({ action: 'adopt_stale', adoptionHandle: handle });
    assert.equal(resumed.isError, undefined, resumed.content[0]!.text);
    assert.equal(observeStops, 1);
    assert.deepEqual(envelope(resumed).data.integrationRestoration, {
      required: true,
      action: 'restore_integration',
      installedBySessionId: 'session-prior',
    });
    assert.equal(registry.getSessionStatus('session-adopter')?.state, 'source_bound');
    assert.ok(registry.getSessionStatus('session-adopter')?.bindings.packageIntegration);

    const restored = await handler({ action: 'restore_integration', confirmed: true });
    assert.equal(restored.isError, undefined, restored.content[0]!.text);
    assert.equal(readFileSync(packagePath, 'utf8'), originalPackage);
    assert.equal(readFileSync(metroConfigPath, 'utf8'), originalMetro);
    assert.equal(registry.getSessionStatus('session-adopter')?.bindings.packageIntegration, null);
    registry.close();
  } finally {
    if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousStateHome;
    rmSync(root, { force: true, recursive: true });
  }
});

test('a replacement recovery worker resumes a stale adoption with the preserved capability', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-resume-rebind-'));
  const stateHome = join(root, 'state');
  const previousStateHome = process.env.XDG_STATE_HOME;
  try {
    const appRoot = createAppFixture(root);
    process.env.XDG_STATE_HOME = stateHome;
    const layout = createAuthorityStateLayout();
    const fixture = setupStaleAdoption({
      appRoot,
      registryPath: layout.registry,
      priorIntegration: null,
    });
    const { registry, prior, adopter, handle } = fixture;
    registry.updateBindings(prior, { bindings: { observe: { port: 7396 } } });
    let failObserveStop = true;
    const handler = createSessionHandler(createRuntime(registry, adopter), {
      stopHandoffObserve: async () => {
        if (failObserveStop) throw new Error('observe stop unavailable');
      },
    });
    const crashed = await handler({ action: 'adopt_stale', adoptionHandle: handle });
    assert.equal(crashed.isError, true);
    failObserveStop = false;

    registry.bindRecoveryWorker(
      adopter,
      { instanceId: 'recovery-worker-2', pid: process.pid, token: 'recovery-birth-2' },
      'recovery-capability',
    );
    const statusResult = await handler({ action: 'status' });
    const reboundHandle = (
      envelope(statusResult).data.authority as {
        recovery?: { adoptionHandle?: unknown };
      }
    ).recovery?.adoptionHandle;
    assert.equal(typeof reboundHandle, 'string');
    assert.notEqual(reboundHandle, handle);
    assert.equal(
      statusResult.content[0]!.text.includes(handle),
      false,
      'public status must never redisclose the adoption capability',
    );

    const resumed = await handler({ action: 'adopt_stale', adoptionHandle: handle });
    assert.equal(resumed.isError, undefined, resumed.content[0]!.text);
    assert.equal(registry.getSessionStatus('session-adopter')?.state, 'source_bound');
    assert.equal(registry.getSessionStatus('session-adopter')?.bindings.packageIntegration, null);
    registry.close();
  } finally {
    if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousStateHome;
    rmSync(root, { force: true, recursive: true });
  }
});

test('restore_integration reports that no trusted manifest digest exists when the binding lacks one', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-untrusted-digest-'));
  const stateHome = join(root, 'state');
  const previousStateHome = process.env.XDG_STATE_HOME;
  try {
    const appRoot = createAppFixture(root);
    process.env.XDG_STATE_HOME = stateHome;
    const source = resolveSourceIdentity(appRoot);
    const layout = createAuthorityStateLayout();
    const registry = openSessionRegistry(layout.registry, { ownerStatus: () => 'match' });
    const session = registry.createSession({
      sessionId: 'session-untrusted-digest',
      sourceKey: source.sourceKey,
      worktreeKey: source.worktreeKey,
      appRootKey: source.appRootKey,
      supervisor: { pid: process.pid, token: 'fixture' },
      source: { ...source },
      bindings: { metroPort: 8248 },
    });
    const untrustedBinding = {
      version: 1,
      installedBySessionId: R20_LEGACY_BINDING.installedBySessionId,
      manifestSha256: R20_LEGACY_BINDING.manifestSha256.toUpperCase(),
    };
    registry.updateBindings(session, {
      state: 'device_claimed',
      bindings: { packageIntegration: untrustedBinding },
    });
    const handler = createSessionHandler(createRuntime(registry, session));

    const refused = await handler({ action: 'restore_integration', confirmed: true });
    assert.equal(refused.isError, true);
    const refusal = envelope(refused);
    assert.match(String(refusal.error), /requires a SHA-256-verified manifest/);
    const nextAction = String((refusal.meta as { nextAction?: string })?.nextAction);
    assert.match(nextAction, /No trusted manifest SHA-256 digest is recorded/);
    assert.match(nextAction, /session-state-plus-manifest backup/);
    assert.doesNotMatch(nextAction, /version control history/);
    assert.deepEqual(
      registry.getSessionStatus('session-untrusted-digest')?.bindings.packageIntegration,
      untrustedBinding,
    );
    registry.close();
  } finally {
    if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousStateHome;
    rmSync(root, { force: true, recursive: true });
  }
});

test('initial accept_handoff refuses a manifest-less donor binding before any reservation or transfer', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-accept-manifestless-'));
  const stateHome = join(root, 'state');
  const previousStateHome = process.env.XDG_STATE_HOME;
  try {
    const appRoot = createAppFixture(root);
    const packagePath = join(appRoot, 'package.json');
    const metroConfigPath = join(appRoot, 'metro.config.js');
    const originalPackage = readFileSync(packagePath, 'utf8');
    const originalMetro = readFileSync(metroConfigPath, 'utf8');
    process.env.XDG_STATE_HOME = stateHome;
    const source = resolveSourceIdentity(appRoot);
    const layout = createAuthorityStateLayout();
    const registry = openSessionRegistry(layout.registry, { ownerStatus: () => 'match' });
    const donor = registry.createSession({
      sessionId: 'session-donor',
      sourceKey: source.sourceKey,
      worktreeKey: source.worktreeKey,
      appRootKey: source.appRootKey,
      supervisor: { pid: process.pid, token: 'donor-supervisor' },
      source: { ...source },
      bindings: { metroPort: 8248, observePort: 7396 },
    });
    registry.claimResources(donor, [
      { type: 'source', key: source.worktreeKey },
      { type: 'device', key: 'ios:54B03A8D-C9A7-4F97-8656-75E81DC3A68C' },
    ]);
    registry.updateBindings(donor, {
      state: 'device_claimed',
      bindings: {
        packageIntegration: { ...R20_LEGACY_BINDING },
        observe: { port: 7396 },
      },
    });
    const recipient = registry.createSession({
      sessionId: 'session-recipient',
      sourceKey: source.sourceKey,
      worktreeKey: source.worktreeKey,
      appRootKey: source.appRootKey,
      supervisor: { pid: process.pid, token: 'recipient-supervisor' },
      source: { ...source },
      bindings: { metroPort: 8248, observePort: 7396 },
    });
    registry.updateBindings(recipient, {
      state: 'blocked',
      bindings: {
        recoveryCapabilityHash: createHash('sha256').update('recovery-capability').digest('hex'),
      },
    });
    registry.bindRecoveryWorker(
      recipient,
      { instanceId: 'recovery-worker', pid: process.pid, token: 'recovery-birth' },
      'recovery-capability',
    );
    const recipientHandle = (
      registry.getSessionStatus('session-recipient')?.bindings.recoveryHandles as
        | { handoffRecipient?: { token?: string } }
        | undefined
    )?.handoffRecipient?.token;
    assert.ok(typeof recipientHandle === 'string' && recipientHandle.length > 0);
    const capability = registry.prepareHandoffForHandle(donor, { targetHandle: recipientHandle });

    let cleanupCalls = 0;
    const handler = createSessionHandler(createRuntime(registry, recipient), {
      stopHandoffObserve: async () => {
        cleanupCalls += 1;
      },
      stopHandoffRunner: async () => {
        cleanupCalls += 1;
      },
      stopHandoffRecorder: async () => {
        cleanupCalls += 1;
      },
      stopManagedMetro: async () => {
        cleanupCalls += 1;
        return true;
      },
      getSignerCapability: () => 'signer',
    });
    const donorBefore = registry.getSessionStatus('session-donor');
    const recipientBefore = registry.getSessionStatus('session-recipient');

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const refused = await handler({
        action: 'accept_handoff',
        handoffId: capability.handoffId,
        token: capability.token,
      });
      assert.equal(refused.isError, true, `attempt ${attempt}`);
      const refusal = envelope(refused);
      assert.match(
        String(refusal.error),
        /without a SHA-256-verified restoration manifest/,
        `attempt ${attempt}`,
      );
      assert.match(
        String(refusal.error),
        /unintegrated: no-integration-markers/,
        `attempt ${attempt}`,
      );
      assert.match(
        String((refusal.meta as { nextAction?: string })?.nextAction),
        /version control history/,
        `attempt ${attempt}`,
      );
    }

    assert.equal(cleanupCalls, 0);
    const donorAfter = registry.getSessionStatus('session-donor');
    const recipientAfter = registry.getSessionStatus('session-recipient');
    assert.equal(donorAfter?.state, 'handoff');
    assert.equal(donorAfter?.authorityVersion, donorBefore?.authorityVersion);
    assert.deepEqual(donorAfter?.bindings.packageIntegration, R20_LEGACY_BINDING);
    assert.deepEqual(donorAfter?.claims, donorBefore?.claims);
    assert.equal(recipientAfter?.state, 'blocked');
    assert.equal(recipientAfter?.authorityVersion, recipientBefore?.authorityVersion);
    assert.equal(recipientAfter?.bindings.packageIntegration, undefined);
    assert.equal(recipientAfter?.bindings.handoffCleanup, undefined);
    assert.equal(registry.getHandoffOwner(capability.handoffId), 'session-donor');
    assert.equal(readFileSync(packagePath, 'utf8'), originalPackage);
    assert.equal(readFileSync(metroConfigPath, 'utf8'), originalMetro);
    registry.close();
  } finally {
    if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousStateHome;
    rmSync(root, { force: true, recursive: true });
  }
});

test('a byte-exact on-disk donor manifest never authorizes handoff acceptance', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-accept-ondisk-only-'));
  const stateHome = join(root, 'state');
  const previousStateHome = process.env.XDG_STATE_HOME;
  try {
    const appRoot = createAppFixture(root);
    process.env.XDG_STATE_HOME = stateHome;
    const source = resolveSourceIdentity(appRoot);
    const layout = createAuthorityStateLayout();
    const registry = openSessionRegistry(layout.registry, { ownerStatus: () => 'match' });
    const donor = registry.createSession({
      sessionId: 'session-donor',
      sourceKey: source.sourceKey,
      worktreeKey: source.worktreeKey,
      appRootKey: source.appRootKey,
      supervisor: { pid: process.pid, token: 'donor-supervisor' },
      source: { ...source },
      bindings: { metroPort: 8248, observePort: 7396 },
    });
    registry.claimResources(donor, [
      { type: 'source', key: source.worktreeKey },
      { type: 'device', key: 'ios:54B03A8D-C9A7-4F97-8656-75E81DC3A68C' },
    ]);
    registry.updateBindings(donor, {
      state: 'device_claimed',
      bindings: {
        device: {
          platform: 'ios',
          deviceId: '54B03A8D-C9A7-4F97-8656-75E81DC3A68C',
          appId: 'com.rndevagent.testapp',
        },
      },
    });
    const donorHandler = createSessionHandler(createRuntime(registry, donor));
    const applied = await donorHandler({ action: 'apply_integration', confirmed: true });
    assert.equal(applied.isError, undefined, applied.content[0]!.text);
    const manifestPath = join(appRoot, '.rn-agent', 'integration', 'rn-session-integration.json');
    const manifestBytes = readFileSync(manifestPath, 'utf8');
    const digestOnlyBinding = {
      version: 1,
      installedBySessionId: 'session-donor',
      manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
    };
    registry.updateBindings(donor, { bindings: { packageIntegration: digestOnlyBinding } });

    const recipient = registry.createSession({
      sessionId: 'session-recipient',
      sourceKey: source.sourceKey,
      worktreeKey: source.worktreeKey,
      appRootKey: source.appRootKey,
      supervisor: { pid: process.pid, token: 'recipient-supervisor' },
      source: { ...source },
      bindings: { metroPort: 8248, observePort: 7396 },
    });
    registry.updateBindings(recipient, {
      state: 'blocked',
      bindings: {
        recoveryCapabilityHash: createHash('sha256').update('recovery-capability').digest('hex'),
      },
    });
    registry.bindRecoveryWorker(
      recipient,
      { instanceId: 'recovery-worker', pid: process.pid, token: 'recovery-birth' },
      'recovery-capability',
    );
    const recipientHandle = (
      registry.getSessionStatus('session-recipient')?.bindings.recoveryHandles as
        | { handoffRecipient?: { token?: string } }
        | undefined
    )?.handoffRecipient?.token;
    assert.ok(typeof recipientHandle === 'string' && recipientHandle.length > 0);
    const capability = registry.prepareHandoffForHandle(donor, { targetHandle: recipientHandle });

    let cleanupCalls = 0;
    const handler = createSessionHandler(createRuntime(registry, recipient), {
      stopHandoffObserve: async () => {
        cleanupCalls += 1;
      },
      stopHandoffRunner: async () => {
        cleanupCalls += 1;
      },
      stopManagedMetro: async () => {
        cleanupCalls += 1;
        return true;
      },
      getSignerCapability: () => 'signer',
    });
    const donorBefore = registry.getSessionStatus('session-donor');

    const refused = await handler({
      action: 'accept_handoff',
      handoffId: capability.handoffId,
      token: capability.token,
    });
    assert.equal(refused.isError, true);
    const refusal = envelope(refused);
    assert.match(
      String(refusal.error),
      /without a SHA-256-verified restoration manifest/,
      'the byte-exact on-disk manifest must not satisfy handoff transfer eligibility',
    );
    assert.match(
      String((refusal.meta as { nextAction?: string })?.nextAction),
      /never authorize a transfer/,
    );
    assert.equal(cleanupCalls, 0);
    const donorAfter = registry.getSessionStatus('session-donor');
    assert.equal(donorAfter?.state, 'handoff');
    assert.equal(donorAfter?.authorityVersion, donorBefore?.authorityVersion);
    assert.deepEqual(donorAfter?.bindings.packageIntegration, digestOnlyBinding);
    assert.equal(registry.getSessionStatus('session-recipient')?.state, 'blocked');
    assert.equal(registry.getHandoffOwner(capability.handoffId), 'session-donor');
    assert.equal(readFileSync(manifestPath, 'utf8'), manifestBytes);
    registry.close();
  } finally {
    if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousStateHome;
    rmSync(root, { force: true, recursive: true });
  }
});

test('an invalid handoff token returns only the canonical refusal without donor or file diagnostics', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-accept-bad-token-'));
  const stateHome = join(root, 'state');
  const previousStateHome = process.env.XDG_STATE_HOME;
  try {
    const appRoot = createAppFixture(root);
    writeFileSync(
      join(appRoot, 'package.json'),
      `${JSON.stringify({ scripts: { ...ADAPTER_SENTINELS } }, null, 2)}\n`,
    );
    writeFileSync(join(appRoot, 'metro.config.js'), METRO_INTEGRATED);
    process.env.XDG_STATE_HOME = stateHome;
    const source = resolveSourceIdentity(appRoot);
    const layout = createAuthorityStateLayout();
    const registry = openSessionRegistry(layout.registry, { ownerStatus: () => 'match' });
    const donor = registry.createSession({
      sessionId: 'session-donor',
      sourceKey: source.sourceKey,
      worktreeKey: source.worktreeKey,
      appRootKey: source.appRootKey,
      supervisor: { pid: process.pid, token: 'donor-supervisor' },
      source: { ...source },
      bindings: { metroPort: 8248, observePort: 7396 },
    });
    registry.updateBindings(donor, {
      state: 'device_claimed',
      bindings: {
        packageIntegration: { ...R20_LEGACY_BINDING },
        observe: { port: 7396 },
      },
    });
    const recipient = registry.createSession({
      sessionId: 'session-recipient',
      sourceKey: source.sourceKey,
      worktreeKey: source.worktreeKey,
      appRootKey: source.appRootKey,
      supervisor: { pid: process.pid, token: 'recipient-supervisor' },
      source: { ...source },
      bindings: { metroPort: 8248, observePort: 7396 },
    });
    registry.updateBindings(recipient, {
      state: 'blocked',
      bindings: {
        recoveryCapabilityHash: createHash('sha256').update('recovery-capability').digest('hex'),
      },
    });
    registry.bindRecoveryWorker(
      recipient,
      { instanceId: 'recovery-worker', pid: process.pid, token: 'recovery-birth' },
      'recovery-capability',
    );
    const recipientHandle = (
      registry.getSessionStatus('session-recipient')?.bindings.recoveryHandles as
        | { handoffRecipient?: { token?: string } }
        | undefined
    )?.handoffRecipient?.token;
    assert.ok(typeof recipientHandle === 'string');
    const capability = registry.prepareHandoffForHandle(donor, { targetHandle: recipientHandle });

    let cleanupCalls = 0;
    const handler = createSessionHandler(createRuntime(registry, recipient), {
      stopHandoffObserve: async () => {
        cleanupCalls += 1;
      },
      getSignerCapability: () => 'signer',
    });
    const donorBefore = registry.getSessionStatus('session-donor');
    const recipientBefore = registry.getSessionStatus('session-recipient');

    const refused = await handler({
      action: 'accept_handoff',
      handoffId: capability.handoffId,
      token: 'not-the-capability-token',
    });
    assert.equal(refused.isError, true);
    const refusal = envelope(refused);
    assert.match(String(refusal.error), /handoff capability is invalid/);
    const disclosed = refused.content[0]!.text;
    assert.doesNotMatch(disclosed, /SHA-256|integrated|package-script|rn-session-integration/);
    assert.doesNotMatch(disclosed, /session-donor/);
    assert.equal(cleanupCalls, 0);
    assert.equal(
      registry.getSessionStatus('session-donor')?.authorityVersion,
      donorBefore?.authorityVersion,
    );
    assert.equal(
      registry.getSessionStatus('session-recipient')?.authorityVersion,
      recipientBefore?.authorityVersion,
    );
    assert.equal(registry.getHandoffOwner(capability.handoffId), 'session-donor');

    const eligible = await handler({
      action: 'accept_handoff',
      handoffId: capability.handoffId,
      token: capability.token,
    });
    assert.equal(eligible.isError, true);
    assert.match(
      String(envelope(eligible).error),
      /without a SHA-256-verified restoration manifest/,
      'the valid capability must still reach the unchanged eligibility gate',
    );
    registry.close();
  } finally {
    if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousStateHome;
    rmSync(root, { force: true, recursive: true });
  }
});

test('interrupted handoff cleanup refuses resumption without the original handoff capability', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-resume-handoff-token-'));
  const stateHome = join(root, 'state');
  const previousStateHome = process.env.XDG_STATE_HOME;
  try {
    const appRoot = createAppFixture(root);
    process.env.XDG_STATE_HOME = stateHome;
    const source = resolveSourceIdentity(appRoot);
    const layout = createAuthorityStateLayout();
    const registry = openSessionRegistry(layout.registry, { ownerStatus: () => 'match' });
    const donor = registry.createSession({
      sessionId: 'session-donor',
      sourceKey: source.sourceKey,
      worktreeKey: source.worktreeKey,
      appRootKey: source.appRootKey,
      supervisor: { pid: process.pid, token: 'donor-supervisor' },
      source: { ...source },
      bindings: { metroPort: 8248, observePort: 7396 },
    });
    registry.claimResources(donor, [
      { type: 'source', key: source.worktreeKey },
      { type: 'observe-port', key: '7396' },
      { type: 'device', key: 'ios:54B03A8D-C9A7-4F97-8656-75E81DC3A68C' },
    ]);
    registry.updateBindings(donor, {
      state: 'device_claimed',
      bindings: { observe: { port: 7396 } },
    });
    const recipient = registry.createSession({
      sessionId: 'session-recipient',
      sourceKey: source.sourceKey,
      worktreeKey: source.worktreeKey,
      appRootKey: source.appRootKey,
      supervisor: { pid: process.pid, token: 'recipient-supervisor' },
      source: { ...source },
      bindings: { metroPort: 8248, observePort: 7396 },
    });
    registry.updateBindings(recipient, {
      state: 'blocked',
      bindings: {
        recoveryCapabilityHash: createHash('sha256').update('recovery-capability').digest('hex'),
      },
    });
    registry.bindRecoveryWorker(
      recipient,
      { instanceId: 'recovery-worker', pid: process.pid, token: 'recovery-birth' },
      'recovery-capability',
    );
    const recipientHandle = (
      registry.getSessionStatus('session-recipient')?.bindings.recoveryHandles as
        | { handoffRecipient?: { token?: string } }
        | undefined
    )?.handoffRecipient?.token;
    assert.ok(typeof recipientHandle === 'string');
    const capability = registry.prepareHandoffForHandle(donor, { targetHandle: recipientHandle });

    let observeStops = 0;
    let failObserveStop = true;
    const handler = createSessionHandler(createRuntime(registry, recipient), {
      stopHandoffObserve: async () => {
        if (failObserveStop) throw new Error('observe stop unavailable');
        observeStops += 1;
      },
    });

    const crashed = await handler({
      action: 'accept_handoff',
      handoffId: capability.handoffId,
      token: capability.token,
    });
    assert.equal(crashed.isError, true);
    assert.equal(registry.getSessionStatus('session-recipient')?.state, 'handoff_cleanup');
    failObserveStop = false;
    const versionAfterCrash = registry.getSessionStatus('session-recipient')?.authorityVersion;

    const wrongToken = await handler({
      action: 'accept_handoff',
      handoffId: capability.handoffId,
      token: 'not-the-capability-token',
    });
    assert.equal(wrongToken.isError, true);
    assert.match(
      String(envelope(wrongToken).error),
      /resumption requires the original handoff capability/,
    );
    assert.doesNotMatch(
      wrongToken.content[0]!.text,
      /SHA-256|integrated|package-script|rn-session-integration|session-donor/,
    );

    const wrongHandoff = await handler({
      action: 'accept_handoff',
      handoffId: 'some-other-handoff',
      token: capability.token,
    });
    assert.equal(wrongHandoff.isError, true);
    assert.match(
      String(envelope(wrongHandoff).error),
      /resumption requires the original handoff capability/,
    );

    assert.equal(observeStops, 0, 'no cleanup may run for an unproven capability');
    assert.equal(registry.getSessionStatus('session-recipient')?.state, 'handoff_cleanup');
    assert.equal(
      registry.getSessionStatus('session-recipient')?.authorityVersion,
      versionAfterCrash,
      'refused resumption must not mutate the registry',
    );

    registry.bindRecoveryWorker(
      recipient,
      { instanceId: 'recovery-worker-2', pid: process.pid, token: 'recovery-birth-2' },
      'recovery-capability',
    );
    const resumed = await handler({
      action: 'accept_handoff',
      handoffId: capability.handoffId,
      token: capability.token,
    });
    assert.equal(resumed.isError, undefined, resumed.content[0]!.text);
    assert.equal(observeStops, 1);
    assert.equal(registry.getSessionStatus('session-recipient')?.state, 'source_bound');
    registry.close();
  } finally {
    if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousStateHome;
    rmSync(root, { force: true, recursive: true });
  }
});

test('resumed handoff cleanup validates the capability before manifest diagnostics', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-resume-handoff-manifest-'));
  const stateHome = join(root, 'state');
  const previousStateHome = process.env.XDG_STATE_HOME;
  try {
    const appRoot = createAppFixture(root);
    process.env.XDG_STATE_HOME = stateHome;
    const source = resolveSourceIdentity(appRoot);
    const layout = createAuthorityStateLayout();
    let registry = openSessionRegistry(layout.registry, { ownerStatus: () => 'match' });
    const donor = registry.createSession({
      sessionId: 'session-donor',
      sourceKey: source.sourceKey,
      worktreeKey: source.worktreeKey,
      appRootKey: source.appRootKey,
      supervisor: { pid: process.pid, token: 'donor-supervisor' },
      source: { ...source },
      bindings: { metroPort: 8248, observePort: 7396 },
    });
    registry.claimResources(donor, [
      { type: 'source', key: source.worktreeKey },
      { type: 'observe-port', key: '7396' },
      { type: 'device', key: 'ios:54B03A8D-C9A7-4F97-8656-75E81DC3A68C' },
    ]);
    registry.updateBindings(donor, {
      state: 'device_claimed',
      bindings: {
        device: {
          platform: 'ios',
          deviceId: '54B03A8D-C9A7-4F97-8656-75E81DC3A68C',
          appId: 'com.rndevagent.testapp',
        },
      },
    });
    const donorHandler = createSessionHandler(createRuntime(registry, donor));
    const applied = await donorHandler({ action: 'apply_integration', confirmed: true });
    assert.equal(applied.isError, undefined, applied.content[0]!.text);
    registry.updateBindings(donor, { bindings: { observe: { port: 7396 } } });
    const durableBinding = registry.getSessionStatus('session-donor')?.bindings
      .packageIntegration as Record<string, unknown>;
    assert.equal(typeof durableBinding.manifestSource, 'string');

    const recipient = registry.createSession({
      sessionId: 'session-recipient',
      sourceKey: source.sourceKey,
      worktreeKey: source.worktreeKey,
      appRootKey: source.appRootKey,
      supervisor: { pid: process.pid, token: 'recipient-supervisor' },
      source: { ...source },
      bindings: { metroPort: 8248, observePort: 7396 },
    });
    registry.updateBindings(recipient, {
      state: 'blocked',
      bindings: {
        recoveryCapabilityHash: createHash('sha256').update('recovery-capability').digest('hex'),
      },
    });
    registry.bindRecoveryWorker(
      recipient,
      { instanceId: 'recovery-worker', pid: process.pid, token: 'recovery-birth' },
      'recovery-capability',
    );
    const recipientHandle = (
      registry.getSessionStatus('session-recipient')?.bindings.recoveryHandles as
        | { handoffRecipient?: { token?: string } }
        | undefined
    )?.handoffRecipient?.token;
    assert.ok(typeof recipientHandle === 'string');
    const capability = registry.prepareHandoffForHandle(donor, { targetHandle: recipientHandle });

    const rewriteTransferredBinding = (packageIntegration: Record<string, unknown>) => {
      registry.close();
      const db = new DatabaseSync(layout.registry);
      const row = db
        .prepare('SELECT bindings_json FROM sessions WHERE session_id = ?')
        .get('session-recipient') as { bindings_json: string };
      const bindings = JSON.parse(row.bindings_json) as Record<string, unknown>;
      bindings.packageIntegration = packageIntegration;
      db.prepare('UPDATE sessions SET bindings_json = ? WHERE session_id = ?').run(
        JSON.stringify(bindings),
        'session-recipient',
      );
      db.close();
      registry = openSessionRegistry(layout.registry, { ownerStatus: () => 'match' });
    };

    let observeStops = 0;
    let failObserveStop = true;
    const createHandler = () =>
      createSessionHandler(createRuntime(registry, recipient), {
        stopHandoffObserve: async () => {
          if (failObserveStop) throw new Error('observe stop unavailable');
          observeStops += 1;
        },
      });
    let handler = createHandler();

    const crashed = await handler({
      action: 'accept_handoff',
      handoffId: capability.handoffId,
      token: capability.token,
    });
    assert.equal(crashed.isError, true);
    assert.equal(registry.getSessionStatus('session-recipient')?.state, 'handoff_cleanup');
    failObserveStop = false;

    rewriteTransferredBinding({
      version: durableBinding.version,
      installedBySessionId: durableBinding.installedBySessionId,
      manifestSha256: durableBinding.manifestSha256,
    });
    handler = createHandler();
    const versionBeforeRefusal = registry.getSessionStatus('session-recipient')?.authorityVersion;

    const wrongToken = await handler({
      action: 'accept_handoff',
      handoffId: capability.handoffId,
      token: 'not-the-capability-token',
    });
    assert.equal(wrongToken.isError, true);
    assert.match(
      String(envelope(wrongToken).error),
      /resumption requires the original handoff capability/,
    );
    assert.doesNotMatch(
      wrongToken.content[0]!.text,
      /SHA-256|restoration manifest|integrated|package-script|rn-session-integration/,
      'an unproven capability must not observe manifest or file diagnostics',
    );

    const manifestless = await handler({
      action: 'accept_handoff',
      handoffId: capability.handoffId,
      token: capability.token,
    });
    assert.equal(manifestless.isError, true);
    assert.match(
      String(envelope(manifestless).error),
      /without a SHA-256-verified restoration manifest/,
      'the proven capability still meets the unchanged manifest eligibility gate',
    );
    assert.equal(observeStops, 0);
    assert.equal(registry.getSessionStatus('session-recipient')?.state, 'handoff_cleanup');
    assert.equal(
      registry.getSessionStatus('session-recipient')?.authorityVersion,
      versionBeforeRefusal,
    );

    rewriteTransferredBinding(durableBinding);
    handler = createHandler();
    const resumed = await handler({
      action: 'accept_handoff',
      handoffId: capability.handoffId,
      token: capability.token,
    });
    assert.equal(resumed.isError, undefined, resumed.content[0]!.text);
    assert.equal(observeStops, 1);
    assert.equal(registry.getSessionStatus('session-recipient')?.state, 'source_bound');
    assert.deepEqual(envelope(resumed).data.integrationRestoration, {
      required: true,
      action: 'restore_integration',
      ownerSessionId: 'session-recipient',
      installedBySessionId: 'session-donor',
    });
    registry.close();
  } finally {
    if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousStateHome;
    rmSync(root, { force: true, recursive: true });
  }
});

test('an invalid adoption handle returns only the canonical refusal without prior-session diagnostics', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-adopt-bad-handle-'));
  const stateHome = join(root, 'state');
  const previousStateHome = process.env.XDG_STATE_HOME;
  try {
    const appRoot = createAppFixture(root);
    writeFileSync(
      join(appRoot, 'package.json'),
      `${JSON.stringify({ scripts: { ...ADAPTER_SENTINELS } }, null, 2)}\n`,
    );
    writeFileSync(join(appRoot, 'metro.config.js'), METRO_INTEGRATED);
    process.env.XDG_STATE_HOME = stateHome;
    const layout = createAuthorityStateLayout();
    const fixture = setupStaleAdoption({ appRoot, registryPath: layout.registry });
    const { registry, adopter, handle } = fixture;
    const handler = createSessionHandler(createRuntime(registry, adopter));
    const adopterBefore = registry.getSessionStatus('session-adopter');
    const priorBefore = registry.getSessionStatus('session-prior');

    const refused = await handler({ action: 'adopt_stale', adoptionHandle: 'wrong-handle' });
    assert.equal(refused.isError, true);
    const refusal = envelope(refused);
    assert.match(String(refusal.error), /stale adoption capability is invalid or expired/);
    const disclosed = refused.content[0]!.text;
    assert.doesNotMatch(disclosed, /SHA-256|integrated|package-script|rn-session-integration/);
    assert.equal(
      registry.getSessionStatus('session-adopter')?.authorityVersion,
      adopterBefore?.authorityVersion,
    );
    assert.equal(
      registry.getSessionStatus('session-prior')?.authorityVersion,
      priorBefore?.authorityVersion,
    );
    assert.equal(registry.getSessionStatus('session-adopter')?.state, 'blocked');

    const eligible = await handler({ action: 'adopt_stale', adoptionHandle: handle });
    assert.equal(eligible.isError, true);
    assert.match(
      String(envelope(eligible).error),
      /without a SHA-256-verified restoration manifest/,
      'the valid capability must still reach the unchanged eligibility gate',
    );
    registry.close();
  } finally {
    if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousStateHome;
    rmSync(root, { force: true, recursive: true });
  }
});

test('stale adoption revokes the consumed handoff capability for resumed cleanup', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-adopted-handoff-revoked-'));
  const stateHome = join(root, 'state');
  const previousStateHome = process.env.XDG_STATE_HOME;
  try {
    const appRoot = createAppFixture(root);
    process.env.XDG_STATE_HOME = stateHome;
    const source = resolveSourceIdentity(appRoot);
    const layout = createAuthorityStateLayout();
    const ownerStates = new Map<string, string>();
    const registry = openSessionRegistry(layout.registry, {
      ownerStatus: ({ sessionId }) => ownerStates.get(sessionId) ?? 'match',
    });
    const donor = registry.createSession({
      sessionId: 'session-donor',
      sourceKey: source.sourceKey,
      worktreeKey: source.worktreeKey,
      appRootKey: source.appRootKey,
      supervisor: { pid: process.pid, token: 'donor-supervisor' },
      source: { ...source },
      bindings: { metroPort: 8248, observePort: 7396 },
    });
    registry.claimResources(donor, [
      { type: 'source', key: source.worktreeKey },
      { type: 'observe-port', key: '7396' },
      { type: 'device', key: 'ios:54B03A8D-C9A7-4F97-8656-75E81DC3A68C' },
    ]);
    registry.updateBindings(donor, {
      state: 'device_claimed',
      bindings: { observe: { port: 7396 } },
    });
    const recipient = registry.createSession({
      sessionId: 'session-recipient',
      sourceKey: source.sourceKey,
      worktreeKey: source.worktreeKey,
      appRootKey: source.appRootKey,
      supervisor: { pid: process.pid, token: 'recipient-supervisor' },
      source: { ...source },
      bindings: { metroPort: 8248, observePort: 7396 },
    });
    registry.updateBindings(recipient, {
      state: 'blocked',
      bindings: {
        recoveryCapabilityHash: createHash('sha256').update('recovery-capability').digest('hex'),
      },
    });
    registry.bindRecoveryWorker(
      recipient,
      { instanceId: 'recovery-worker', pid: process.pid, token: 'recovery-birth' },
      'recovery-capability',
    );
    const recipientHandle = (
      registry.getSessionStatus('session-recipient')?.bindings.recoveryHandles as
        | { handoffRecipient?: { token?: string } }
        | undefined
    )?.handoffRecipient?.token;
    assert.ok(typeof recipientHandle === 'string');
    const capability = registry.prepareHandoffForHandle(donor, { targetHandle: recipientHandle });

    const recipientHandler = createSessionHandler(createRuntime(registry, recipient), {
      stopHandoffObserve: async () => {
        throw new Error('observe stop unavailable');
      },
    });
    const crashed = await recipientHandler({
      action: 'accept_handoff',
      handoffId: capability.handoffId,
      token: capability.token,
    });
    assert.equal(crashed.isError, true);
    assert.equal(registry.getSessionStatus('session-recipient')?.state, 'handoff_cleanup');

    const recipientPublic = JSON.stringify(
      projectPublicAuthorityStatus(
        {
          available: true,
          ...(registry.getSessionStatus('session-recipient') as object),
        } as never,
        { includeSessionId: true },
      ),
    );
    assert.doesNotMatch(recipientPublic, /targetSessionId|targetClaimEpoch|handoffCleanup/);
    assert.equal(recipientPublic.includes(capability.handoffId), false);
    assert.equal(recipientPublic.includes(capability.token), false);

    ownerStates.set('session-recipient', 'mismatch');
    const contender = registry.createSession({
      sessionId: 'session-contender',
      sourceKey: source.sourceKey,
      worktreeKey: source.worktreeKey,
      appRootKey: source.appRootKey,
      supervisor: { pid: process.pid, token: 'contender-supervisor' },
      source: { ...source },
      bindings: { metroPort: 8248, observePort: 7396 },
    });
    registry.updateBindings(contender, {
      state: 'blocked',
      bindings: {
        recoveryCapabilityHash: createHash('sha256').update('contender-capability').digest('hex'),
        adoptionRequired: { sessionId: 'session-recipient', claimEpoch: recipient.claimEpoch },
      },
    });
    registry.bindRecoveryWorker(
      contender,
      { instanceId: 'contender-worker', pid: process.pid, token: 'contender-birth' },
      'contender-capability',
    );
    const adoptionHandle = (
      registry.getSessionStatus('session-contender')?.bindings.recoveryHandles as
        | { adoptStale?: { token?: string } }
        | undefined
    )?.adoptStale?.token;
    assert.ok(typeof adoptionHandle === 'string');

    let observeStops = 0;
    let failObserveStop = true;
    const contenderHandler = createSessionHandler(createRuntime(registry, contender), {
      stopHandoffObserve: async () => {
        if (failObserveStop) throw new Error('observe stop unavailable');
        observeStops += 1;
      },
    });
    const interrupted = await contenderHandler({
      action: 'adopt_stale',
      adoptionHandle,
    });
    assert.equal(interrupted.isError, true);
    assert.equal(registry.getSessionStatus('session-contender')?.state, 'handoff_cleanup');
    const transferredPlan = registry.getSessionStatus('session-contender')?.bindings
      .handoffCleanup as { handoffId?: string; targetSessionId?: string } | undefined;
    assert.equal(transferredPlan?.handoffId, capability.handoffId);
    assert.equal(transferredPlan?.targetSessionId, 'session-recipient');
    failObserveStop = false;
    const versionAfterTransfer = registry.getSessionStatus('session-contender')?.authorityVersion;

    const replayed = await contenderHandler({
      action: 'accept_handoff',
      handoffId: capability.handoffId,
      token: capability.token,
    });
    assert.equal(replayed.isError, true);
    assert.match(
      String(envelope(replayed).error),
      /resumption requires the original handoff capability/,
    );
    assert.doesNotMatch(
      replayed.content[0]!.text,
      /SHA-256|integrated|package-script|rn-session-integration|session-donor/,
    );
    assert.equal(observeStops, 0, 'a transplanted handoff capability must not drive cleanup');
    assert.equal(registry.getSessionStatus('session-contender')?.state, 'handoff_cleanup');
    assert.equal(
      registry.getSessionStatus('session-contender')?.authorityVersion,
      versionAfterTransfer,
      'refused resumption must not mutate the registry',
    );

    const resumed = await contenderHandler({
      action: 'adopt_stale',
      adoptionHandle,
    });
    assert.equal(resumed.isError, undefined, resumed.content[0]!.text);
    assert.equal(observeStops, 1);
    assert.notEqual(registry.getSessionStatus('session-contender')?.state, 'handoff_cleanup');
    assert.doesNotMatch(resumed.content[0]!.text, /targetSessionId|targetClaimEpoch/);
    registry.close();
  } finally {
    if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousStateHome;
    rmSync(root, { force: true, recursive: true });
  }
});
