// GH #1025: rn_session status and cdp_status must name the running product
// from the live session process, not a separately inspected on-disk install.

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  projectRunningProductVersion,
  readRunningProductVersion,
} from '../../../dist/session/product-version.js';
import { createSessionHandler } from '../../../dist/tools/session.js';
import { createPassiveStatusHandler } from '../../../dist/tools/status.js';

const fixtures: string[] = [];

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

function writeCorePackage(root: string, version: string): void {
  writeJson(join(root, 'rn-dev-agent-core', 'package.json'), {
    name: 'rn-dev-agent-core',
    version,
  });
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
