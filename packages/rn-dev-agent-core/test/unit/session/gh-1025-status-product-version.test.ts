// GH #1025: rn_session status and cdp_status must name the running product
// from the live session process, not a separately inspected on-disk install.

import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  projectRunningProductVersion,
  readRunningProductVersion,
} from '../../../dist/session/product-version.js';
import { createSessionHandler } from '../../../dist/tools/session.js';
import { createPassiveStatusHandler } from '../../../dist/tools/status.js';

const fixtures: string[] = [];
const LAUNCH_HOST_ENV = [
  'RN_DEV_AGENT_CODEX_PLUGIN_ROOT',
  'CODEX_PLUGIN_ROOT',
  'CLAUDE_PLUGIN_ROOT',
] as const;
const savedLaunchHostEnv: Record<(typeof LAUNCH_HOST_ENV)[number], string | undefined> = {
  RN_DEV_AGENT_CODEX_PLUGIN_ROOT: process.env.RN_DEV_AGENT_CODEX_PLUGIN_ROOT,
  CODEX_PLUGIN_ROOT: process.env.CODEX_PLUGIN_ROOT,
  CLAUDE_PLUGIN_ROOT: process.env.CLAUDE_PLUGIN_ROOT,
};

before(() => {
  for (const key of LAUNCH_HOST_ENV) delete process.env[key];
});

after(() => {
  for (const key of LAUNCH_HOST_ENV) {
    if (savedLaunchHostEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedLaunchHostEnv[key];
  }
});

afterEach(() => {
  for (const root of fixtures.splice(0)) rmSync(root, { force: true, recursive: true });
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'rn-product-version-'));
  fixtures.push(root);
  return root;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value)}\n`);
}

function moduleUrl(root: string): string {
  return pathToFileURL(join(root, 'rn-dev-agent-core', 'dist', 'session', 'dummy.js')).href;
}

function hostBundleUrl(root: string, file = 'index.js'): string {
  return pathToFileURL(join(root, 'rn-dev-agent-core', 'dist', file)).href;
}

function writeCorePackage(root: string, version: string): void {
  writeJson(join(root, 'rn-dev-agent-core', 'package.json'), {
    name: 'rn-dev-agent-core',
    version,
    type: 'module',
  });
}

function withLaunchHostEnv(vars: Record<string, string | undefined>, run: () => void): void {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) {
    previous[key] = process.env[key];
    const next = vars[key];
    if (next === undefined) delete process.env[key];
    else process.env[key] = next;
  }
  try {
    run();
  } finally {
    for (const key of Object.keys(vars)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

test('projectRunningProductVersion always names the executing core version', () => {
  assert.deepEqual(projectRunningProductVersion({ coreVersion: '1.0.8', pluginVersion: null }), {
    coreVersion: '1.0.8',
  });
});

test('projectRunningProductVersion omits pluginVersion when it matches core', () => {
  assert.deepEqual(projectRunningProductVersion({ coreVersion: '1.0.8', pluginVersion: '1.0.8' }), {
    coreVersion: '1.0.8',
  });
});

test('projectRunningProductVersion includes pluginVersion only when it differs', () => {
  assert.deepEqual(
    projectRunningProductVersion({ coreVersion: '0.71.7', pluginVersion: '0.76.7' }),
    { coreVersion: '0.71.7', pluginVersion: '0.76.7' },
  );
});

test('projectRunningProductVersion is absent when the executing core version cannot be read', () => {
  assert.equal(projectRunningProductVersion({ coreVersion: null, pluginVersion: '1.0.8' }), null);
});

test('readRunningProductVersion reads the executing core package and a host plugin manifest', () => {
  const root = fixtureRoot();
  writeCorePackage(root, '0.90.0');
  writeJson(join(root, '.claude-plugin', 'plugin.json'), { version: '1.0.8' });

  assert.deepEqual(readRunningProductVersion(moduleUrl(root)), {
    coreVersion: '0.90.0',
    pluginVersion: '1.0.8',
  });
});

test('readRunningProductVersion reads a source-checkout plugin manifest', () => {
  const root = fixtureRoot();
  writeCorePackage(root, '1.0.8');
  writeJson(join(root, 'claude-plugin', '.claude-plugin', 'plugin.json'), { version: '1.0.8' });

  assert.deepEqual(readRunningProductVersion(moduleUrl(root)), { coreVersion: '1.0.8' });
});

test('readRunningProductVersion prefers the host plugin.json over a sibling source checkout', () => {
  const root = fixtureRoot();
  writeCorePackage(root, '0.91.0');
  writeJson(join(root, '.codex-plugin', 'plugin.json'), { version: '1.2.0' });
  writeJson(join(root, 'claude-plugin', '.claude-plugin', 'plugin.json'), { version: '9.9.9' });

  assert.deepEqual(readRunningProductVersion(moduleUrl(root)), {
    coreVersion: '0.91.0',
    pluginVersion: '1.2.0',
  });
});

test('readRunningProductVersion ignores RN_DEV_AGENT_PLUGIN_VERSION', () => {
  const root = fixtureRoot();
  writeCorePackage(root, '1.0.8');
  writeJson(join(root, 'claude-plugin', '.claude-plugin', 'plugin.json'), { version: '1.0.8' });
  const previous = process.env.RN_DEV_AGENT_PLUGIN_VERSION;
  process.env.RN_DEV_AGENT_PLUGIN_VERSION = '9.9.9';
  try {
    assert.deepEqual(readRunningProductVersion(moduleUrl(root)), { coreVersion: '1.0.8' });
  } finally {
    if (previous === undefined) delete process.env.RN_DEV_AGENT_PLUGIN_VERSION;
    else process.env.RN_DEV_AGENT_PLUGIN_VERSION = previous;
  }
});

test('readRunningProductVersion reads the committed host bundle from dist/index.js', () => {
  const root = fixtureRoot();
  writeCorePackage(root, '0.71.7');
  writeJson(join(root, '.claude-plugin', 'plugin.json'), { version: '0.76.7' });

  assert.deepEqual(readRunningProductVersion(hostBundleUrl(root)), {
    coreVersion: '0.71.7',
    pluginVersion: '0.76.7',
  });
});

test('readRunningProductVersion reads the committed host bundle from dist/supervisor.js', () => {
  const root = fixtureRoot();
  writeCorePackage(root, '0.90.0');
  writeJson(join(root, '.codex-plugin', 'plugin.json'), { version: '1.0.8' });

  assert.deepEqual(readRunningProductVersion(hostBundleUrl(root, 'supervisor.js')), {
    coreVersion: '0.90.0',
    pluginVersion: '1.0.8',
  });
});

test('readRunningProductVersion reuses the first read for a module URL', () => {
  const root = fixtureRoot();
  writeCorePackage(root, '1.0.8');
  writeJson(join(root, '.claude-plugin', 'plugin.json'), { version: '1.0.8' });
  const url = hostBundleUrl(root);

  assert.deepEqual(readRunningProductVersion(url), { coreVersion: '1.0.8' });
  writeCorePackage(root, '9.9.9');
  writeJson(join(root, '.claude-plugin', 'plugin.json'), { version: '9.9.9' });
  assert.deepEqual(readRunningProductVersion(url), { coreVersion: '1.0.8' });
});

test('readRunningProductVersion captures the executing module at load, not first status', async () => {
  const root = fixtureRoot();
  writeCorePackage(root, '1.0.8');
  writeJson(join(root, '.claude-plugin', 'plugin.json'), { version: '1.0.8' });
  const destDir = join(root, 'rn-dev-agent-core', 'dist', 'session');
  mkdirSync(destDir, { recursive: true });
  const dest = join(destDir, 'product-version.js');
  copyFileSync(
    fileURLToPath(new URL('../../../dist/session/product-version.js', import.meta.url)),
    dest,
  );
  const loaded = (await import(pathToFileURL(dest).href)) as {
    readRunningProductVersion: () => { coreVersion: string; pluginVersion?: string } | null;
  };
  writeCorePackage(root, '9.9.9');
  writeJson(join(root, '.claude-plugin', 'plugin.json'), { version: '9.9.9' });
  assert.deepEqual(loaded.readRunningProductVersion(), { coreVersion: '1.0.8' });
});

test('readRunningProductVersion reads pluginVersion from the Codex launching host when core is overridden', () => {
  const root = fixtureRoot();
  writeCorePackage(root, '0.71.7');
  writeJson(join(root, 'claude-plugin', '.claude-plugin', 'plugin.json'), { version: '9.9.9' });
  const host = join(root, 'installed-plugin');
  writeJson(join(host, '.codex-plugin', 'plugin.json'), { version: '1.0.8' });

  withLaunchHostEnv({ RN_DEV_AGENT_CODEX_PLUGIN_ROOT: host }, () => {
    assert.deepEqual(readRunningProductVersion(moduleUrl(root)), {
      coreVersion: '0.71.7',
      pluginVersion: '1.0.8',
    });
  });
});

test('readRunningProductVersion snapshots the Codex launching host at module load', async () => {
  const root = fixtureRoot();
  writeCorePackage(root, '0.71.7');
  const host = join(root, 'installed-plugin');
  writeJson(join(host, '.codex-plugin', 'plugin.json'), { version: '1.0.8' });
  const destDir = join(root, 'rn-dev-agent-core', 'dist', 'session');
  mkdirSync(destDir, { recursive: true });
  const dest = join(destDir, 'product-version.js');
  copyFileSync(
    fileURLToPath(new URL('../../../dist/session/product-version.js', import.meta.url)),
    dest,
  );

  process.env.RN_DEV_AGENT_CODEX_PLUGIN_ROOT = host;
  try {
    const loaded = (await import(pathToFileURL(dest).href)) as {
      readRunningProductVersion: () => { coreVersion: string; pluginVersion?: string } | null;
    };
    writeJson(join(host, '.codex-plugin', 'plugin.json'), { version: '9.9.9' });
    delete process.env.RN_DEV_AGENT_CODEX_PLUGIN_ROOT;
    assert.deepEqual(loaded.readRunningProductVersion(), {
      coreVersion: '0.71.7',
      pluginVersion: '1.0.8',
    });
  } finally {
    delete process.env.RN_DEV_AGENT_CODEX_PLUGIN_ROOT;
  }
});

test('readRunningProductVersion reports product for the committed host bundle both hosts install', () => {
  const bundle = fileURLToPath(
    new URL('../../../../claude-plugin/rn-dev-agent-core/dist/index.js', import.meta.url),
  );
  const runtime = JSON.parse(readFileSync(join(bundle, '..', '..', 'package.json'), 'utf8')) as {
    name: string;
    version: string;
  };
  assert.equal(runtime.name, 'rn-dev-agent-core', 'packaged runtime metadata is host-neutral');
  const product = readRunningProductVersion(pathToFileURL(bundle).href);
  assert.equal(product?.coreVersion, runtime.version);
});

function readyRuntime() {
  return {
    status: () => ({
      available: true,
      sessionId: 'session-exact',
      sourceKey: 'source',
      worktreeKey: 'worktree',
      appRootKey: 'app',
      state: 'ready',
      claimEpoch: 1,
      authorityVersion: 1,
      leaseUntilMs: 100,
      source: { kind: 'git' },
      bindings: {},
      claims: [],
      worker: { instanceId: 'worker', pid: 1, birthAvailable: true },
    }),
    refreshRecoveryHandles: () => false,
    inspectRecoveryRequirement: () => undefined,
  };
}

test('rn_session status reports the running product on the envelope', async () => {
  const handler = createSessionHandler(readyRuntime() as never);
  const result = await handler({ action: 'status' });
  const envelope = JSON.parse(result.content[0]!.text);

  assert.deepEqual(envelope.data.product, readRunningProductVersion());
  assert.equal(typeof envelope.data.product.coreVersion, 'string');
  assert.ok(envelope.data.product.coreVersion.length > 0);
});

test('rn_session status still reports product when authority is unavailable', async () => {
  const handler = createSessionHandler({
    status: () => ({ available: false, code: 'SESSION_NOT_INITIALIZED' }),
    refreshRecoveryHandles: () => false,
    inspectRecoveryRequirement: () => undefined,
  } as never);

  const result = await handler({ action: 'status' });
  const envelope = JSON.parse(result.content[0]!.text);

  assert.equal(envelope.data.authority.available, false);
  assert.deepEqual(envelope.data.product, readRunningProductVersion());
});

test('cdp_status reports the same running product as rn_session status', async () => {
  const handler = createPassiveStatusHandler(
    () =>
      ({
        isConnected: false,
        metroPort: 8193,
        connectedTarget: null,
      }) as never,
    readyRuntime() as never,
  );

  const result = await handler({});
  const envelope = JSON.parse(result.content[0]!.text);

  assert.deepEqual(envelope.data.product, readRunningProductVersion());
});

// GH-892: one committed runtime with host-neutral metadata serves both hosts
// from packages/claude-plugin; the launching host still decides the reported
// plugin version.
function writeCommonRoot(root: string, coreVersion: string, pluginVersion: string): void {
  writeCorePackage(root, coreVersion);
  writeJson(join(root, '.claude-plugin', 'plugin.json'), { version: pluginVersion });
  writeJson(join(root, '.codex-plugin', 'plugin.json'), { version: pluginVersion });
}

test('GH-892 neutral common root reports the plugin version under a Claude launch with cleared Codex hints', () => {
  const root = fixtureRoot();
  writeCommonRoot(root, '0.71.7', '1.0.8');
  const staleCodexCache = join(root, 'stale-codex-cache');
  writeJson(join(staleCodexCache, '.codex-plugin', 'plugin.json'), { version: '9.9.9' });
  withLaunchHostEnv(
    {
      CLAUDE_PLUGIN_ROOT: root,
      // Claude's manifest clears these so an inherited Codex root cannot win.
      RN_DEV_AGENT_CODEX_PLUGIN_ROOT: '',
      CODEX_PLUGIN_ROOT: '',
    },
    () => {
      assert.deepEqual(readRunningProductVersion(hostBundleUrl(root)), {
        coreVersion: '0.71.7',
        pluginVersion: '1.0.8',
      });
    },
  );
  withLaunchHostEnv(
    { CLAUDE_PLUGIN_ROOT: root, RN_DEV_AGENT_CODEX_PLUGIN_ROOT: staleCodexCache },
    () => {
      assert.deepEqual(
        readRunningProductVersion(hostBundleUrl(root, 'supervisor.js')),
        { coreVersion: '0.71.7', pluginVersion: '9.9.9' },
        'without the manifest clearing an inherited Codex root would mislead the version',
      );
    },
  );
});

test('GH-892 neutral common root reports the Codex launcher root under a Codex launch', () => {
  const root = fixtureRoot();
  writeCommonRoot(root, '0.71.7', '1.0.8');
  const foreignClaude = join(root, 'foreign-claude');
  writeJson(join(foreignClaude, '.claude-plugin', 'plugin.json'), { version: '9.9.9' });
  withLaunchHostEnv(
    { RN_DEV_AGENT_CODEX_PLUGIN_ROOT: root, CLAUDE_PLUGIN_ROOT: foreignClaude },
    () => {
      assert.deepEqual(readRunningProductVersion(hostBundleUrl(root)), {
        coreVersion: '0.71.7',
        pluginVersion: '1.0.8',
      });
    },
  );
});

test('GH-892 neutral common root without host env resolves its own manifests', () => {
  const root = fixtureRoot();
  writeCommonRoot(root, '1.0.8', '1.0.8');
  withLaunchHostEnv(
    {
      CLAUDE_PLUGIN_ROOT: undefined,
      RN_DEV_AGENT_CODEX_PLUGIN_ROOT: undefined,
      CODEX_PLUGIN_ROOT: undefined,
    },
    () => {
      assert.deepEqual(readRunningProductVersion(hostBundleUrl(root)), { coreVersion: '1.0.8' });
    },
  );
  writeJson(join(root, '.claude-plugin', 'plugin.json'), { version: '1.0.9' });
  writeJson(join(root, '.codex-plugin', 'plugin.json'), { version: '1.0.9' });
  withLaunchHostEnv(
    {
      CLAUDE_PLUGIN_ROOT: undefined,
      RN_DEV_AGENT_CODEX_PLUGIN_ROOT: undefined,
      CODEX_PLUGIN_ROOT: undefined,
    },
    () => {
      assert.deepEqual(readRunningProductVersion(hostBundleUrl(root, 'supervisor.js')), {
        coreVersion: '1.0.8',
        pluginVersion: '1.0.9',
      });
    },
  );
});
