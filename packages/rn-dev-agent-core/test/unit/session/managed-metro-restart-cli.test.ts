// Reproduces the post-restart pin refusal from the native-origin lifecycle
// report: an authenticated managed-Metro restart used to bump the session
// buildGeneration past the signed install receipt, so `pin_dev_client` could
// never pass its exact-equality gate again without a full rebuild. The CLI
// must keep the receipt generation for a revalidated byte-identical install
// (proven via PATH-shimmed simctl/plutil against a fixture .app) and must
// still bump it when the installed artifact changed.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { canonicalAuthorityJson } from '../../../dist/session/authority-json.js';
import { captureInstalledArtifact } from '../../../dist/session/install-authority.js';
import { verifyMetroAuthorityMarker } from '../../../dist/session/metro-authority.js';
import { openSessionRegistry } from '../../../dist/session/registry.js';
import { resolveSourceIdentity } from '../../../dist/session/source-identity.js';
import {
  createAuthorityStateLayout,
  writeSessionSecret,
} from '../../../dist/session/state-root.js';
import { readProcessBirth } from '../../../dist/session/process-birth.js';

const cliPath = new URL('../../../dist/rn-session.js', import.meta.url).pathname;
const supervisorBirthToken = readProcessBirth(process.pid)?.token ?? 'fixture';

function readSignedMarker(appRoot: string): { payload: Record<string, unknown> } {
  const source = readFileSync(
    join(appRoot, '.rn-agent', 'integration', 'authority-marker.js'),
    'utf8',
  );
  const match = source.match(/__RN_DEV_AGENT_AUTHORITY__=(.*);\n?$/s);
  assert.ok(match, `authority marker module is unparsable: ${source}`);
  const value = JSON.parse(match[1]) as {
    status: string;
    marker: { payload: Record<string, unknown> };
  };
  assert.equal(value.status, 'signed');
  return value.marker;
}

test('ensure-metro preserves a revalidated receipt generation and bumps a changed install', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-cli-restart-'));
  const appRoot = join(root, 'app');
  const stateHome = join(root, 'state');
  const container = join(root, 'container', 'TestApp.app');
  const fakeBin = join(root, 'bin');
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

    mkdirSync(container, { recursive: true });
    writeFileSync(join(container, 'Info.plist'), 'fixture-info-plist\n');
    writeFileSync(join(container, 'TestApp'), 'fixture-executable-bytes\n');
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(
      join(fakeBin, 'xcrun'),
      `#!/bin/sh\nif [ "$1" = "simctl" ] && [ "$2" = "get_app_container" ]; then\n  echo "${container}"\n  exit 0\nfi\nexit 1\n`,
    );
    writeFileSync(join(fakeBin, 'plutil'), '#!/bin/sh\necho "TestApp"\n');
    chmodSync(join(fakeBin, 'xcrun'), 0o755);
    chmodSync(join(fakeBin, 'plutil'), 0o755);

    const shimmedRunText = (command: string, args: readonly string[]): string => {
      if (command === 'xcrun' && args[1] === 'get_app_container') return `${container}\n`;
      if (command === 'plutil') return 'TestApp\n';
      throw new Error(`unexpected fixture command: ${command} ${args.join(' ')}`);
    };
    const installed = captureInstalledArtifact(
      { platform: 'ios', deviceId: 'SIM-RESTART', appId: 'dev.example' },
      { runText: shimmedRunText },
    );

    process.env.XDG_STATE_HOME = stateHome;
    const source = resolveSourceIdentity(appRoot);
    const layout = createAuthorityStateLayout();
    const registry = openSessionRegistry(layout.registry, {
      ownerStatus: () => 'match',
      listenerStatus: () => 'absent',
    });
    const portProbe = createServer();
    await new Promise<void>((resolve, reject) => {
      portProbe.once('error', reject);
      portProbe.listen(0, '127.0.0.1', resolve);
    });
    const probedAddress = portProbe.address();
    assert.ok(probedAddress && typeof probedAddress !== 'string');
    const metroPort = probedAddress.port;
    await new Promise<void>((resolve) => portProbe.close(() => resolve()));
    const sessionId = 'session-restart';
    const signerCapability = 'signer';
    const staleAuthority = {
      port: metroPort,
      pid: 2_147_483_646,
      birth: 'listener-birth',
      launcherPid: 2_147_483_646,
      launcherBirth: 'launcher-birth',
      instanceId: 'stale-metro-instance',
      runtimeEvidencePath: join(root, 'runtime-evidence.jsonl'),
      runtimeEvidenceSocket: `/tmp/rn-dev-agent-${randomBytes(16).toString('hex')}.sock`,
      runtimeEvidenceAuthority: 'reported-v1',
      runtimeEvidenceProtocol: 2,
      servingRoot: appRoot,
      buildGeneration: 7,
    };
    const staleMetro = {
      mode: 'managed',
      ...staleAuthority,
      managementProof: createHmac('sha256', signerCapability)
        .update(canonicalAuthorityJson({ sessionId, ...staleAuthority }))
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
        metroPort,
        device: { platform: 'ios', deviceId: 'SIM-RESTART', appId: 'dev.example' },
        metro: staleMetro,
      },
    });
    registry.updateBindings(session, {
      state: 'device_bound',
      bindings: {
        install: {
          sessionId: session.sessionId,
          sourceKey: source.sourceKey,
          worktreeKey: source.worktreeKey,
          appRootKey: source.appRootKey,
          platform: 'ios',
          deviceId: 'SIM-RESTART',
          appId: 'dev.example',
          metroPort,
          artifactDigest: installed.artifactDigest,
          installGeneration: installed.installGeneration,
          buildGeneration: 4,
          buildKind: 'expo',
        },
      },
    });
    registry.close();
    writeSessionSecret(layout, session.sessionId, {
      signerCapability: 'signer',
      observeCapability: 'observe',
      recoveryCapability: 'recovery',
    });

    const runEnsureMetro = () =>
      spawnSync(process.execPath, [cliPath, 'ensure-metro'], {
        cwd: appRoot,
        env: {
          ...process.env,
          XDG_STATE_HOME: stateHome,
          RN_DEV_AGENT_SESSION_ID: session.sessionId,
          PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        },
        encoding: 'utf8' as const,
      });

    await t.test(
      'a byte-identical receipted install keeps its generation past a stale instance',
      () => {
        const result = runEnsureMetro();
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /project is neither Expo nor bare React Native/);
        const marker = readSignedMarker(appRoot);
        const payload = verifyMetroAuthorityMarker(marker as never, 'signer', {
          sessionId: session.sessionId,
          appId: 'dev.example',
          platform: 'ios',
          buildGeneration: 4,
        });
        assert.equal(payload.buildGeneration, 4);
        assert.notEqual(payload.metroInstanceId, 'stale-metro-instance');
        assert.doesNotMatch(result.stderr, /install receipt generation not preserved/);
      },
    );

    await t.test('a changed installed artifact still gets a bumped generation', () => {
      appendFileSync(join(container, 'TestApp'), 'tampered\n');
      const result = runEnsureMetro();
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /project is neither Expo nor bare React Native/);
      assert.match(
        result.stderr,
        /install receipt generation not preserved \(installed-artifact-changed\)/,
      );
      const marker = readSignedMarker(appRoot);
      const payload = verifyMetroAuthorityMarker(marker as never, 'signer', {
        sessionId: session.sessionId,
        buildGeneration: 5,
      });
      assert.equal(payload.buildGeneration, 5);
    });

    await t.test('an unreachable install probe also falls back to the bump', () => {
      rmSync(container, { force: true, recursive: true });
      const result = runEnsureMetro();
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /project is neither Expo nor bare React Native/);
      assert.match(
        result.stderr,
        /install receipt generation not preserved \(install-capture-failed\)/,
      );
      const payload = readSignedMarker(appRoot).payload as { buildGeneration: number };
      assert.equal(payload.buildGeneration, 5);
    });
  } finally {
    if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousStateHome;
    rmSync(root, { force: true, recursive: true });
  }
});
