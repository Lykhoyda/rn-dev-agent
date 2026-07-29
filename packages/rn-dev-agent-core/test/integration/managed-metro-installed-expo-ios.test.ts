import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { CDPClient } from '../../dist/cdp-client.js';
import { pinExactDevClient } from '../../dist/session/dev-client-authority.js';
import {
  applyPackageIntegration,
  restorePackageIntegrationFiles,
} from '../../dist/session/package-integration.js';
import { metroListenerPid } from '../../dist/session/metro-binding.js';
import { stopManagedMetro, type ManagedMetroBinding } from '../../dist/session/managed-metro.js';
import { readProcessBirth } from '../../dist/session/process-birth.js';
import { resolveSourceIdentity } from '../../dist/session/source-identity.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const fixtureRoot = join(repositoryRoot, 'test-fixtures', 'managed-metro-installed-expo');
const managedMetroModuleUrl = pathToFileURL(
  join(repositoryRoot, 'packages/rn-dev-agent-core/dist/session/managed-metro.js'),
).href;
const metroAuthorityModuleUrl = pathToFileURL(
  join(repositoryRoot, 'packages/rn-dev-agent-core/dist/session/metro-authority.js'),
).href;
const installAuthorityModuleUrl = pathToFileURL(
  join(repositoryRoot, 'packages/rn-dev-agent-core/dist/session/install-authority.js'),
).href;
const sourceIdentityModuleUrl = pathToFileURL(
  join(repositoryRoot, 'packages/rn-dev-agent-core/dist/session/source-identity.js'),
).href;

function runXcrun(args: readonly string[], timeout = 30_000): string {
  return execFileSync('xcrun', [...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout,
  }).trim();
}

function simulatorDefinition(): {
  deviceTypeIdentifier: string;
  runtimeIdentifier: string;
} {
  const runtimes = JSON.parse(runXcrun(['simctl', 'list', '--json', 'runtimes'])) as {
    runtimes: Array<{
      identifier: string;
      isAvailable: boolean;
      name: string;
      version: string;
    }>;
  };
  const deviceTypes = JSON.parse(runXcrun(['simctl', 'list', '--json', 'devicetypes'])) as {
    devicetypes: Array<{ identifier: string; name: string }>;
  };
  const runtime = runtimes.runtimes
    .filter(
      (entry) =>
        entry.isAvailable && entry.identifier.startsWith('com.apple.CoreSimulator.SimRuntime.iOS-'),
    )
    .sort((left, right) => left.version.localeCompare(right.version, undefined, { numeric: true }))
    .at(0);
  const deviceType =
    deviceTypes.devicetypes.find((entry) => entry.name === 'iPhone 16') ??
    deviceTypes.devicetypes.find((entry) => entry.name.startsWith('iPhone'));
  if (!runtime || !deviceType) {
    throw new Error('installed-Expo regression requires an available iOS simulator runtime');
  }
  return {
    deviceTypeIdentifier: deviceType.identifier,
    runtimeIdentifier: runtime.identifier,
  };
}

function createDedicatedSimulator(name: string): string {
  const devices = JSON.parse(runXcrun(['simctl', 'list', '--json', 'devices', 'available'])) as {
    devices: Record<
      string,
      Array<{
        availabilityError?: string;
        isAvailable?: boolean;
        name: string;
        state: string;
        udid: string;
      }>
    >;
  };
  const template = Object.entries(devices.devices)
    .sort(([left], [right]) => left.localeCompare(right, undefined, { numeric: true }))
    .flatMap(([, entries]) => entries)
    .findLast(
      (entry) =>
        entry.state === 'Shutdown' &&
        entry.name.startsWith('iPhone') &&
        entry.isAvailable !== false &&
        !entry.availabilityError,
    );
  if (template) {
    const cloned = spawnSync('xcrun', ['simctl', 'clone', template.udid, name], {
      encoding: 'utf8',
      timeout: 60_000,
    });
    if (cloned.status === 0 && cloned.stdout.trim()) return cloned.stdout.trim();
  }
  const definition = simulatorDefinition();
  return runXcrun([
    'simctl',
    'create',
    name,
    definition.deviceTypeIdentifier,
    definition.runtimeIdentifier,
  ]);
}

async function availablePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('test port unavailable'));
        return;
      }
      server.close((error) => (error ? reject(error) : resolvePort(address.port)));
    });
  });
}

async function waitFor<T>(
  inspect: () => Promise<T | null> | T | null,
  timeout: number,
  description: string,
): Promise<T> {
  const deadline = Date.now() + timeout;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await inspect();
      if (value !== null) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  throw new Error(`timed out waiting for ${description}`, { cause: lastError });
}

async function readEvidenceHead(socketPath: string): Promise<Record<string, unknown>> {
  const challenge = randomBytes(32).toString('hex');
  return new Promise((resolveHead, reject) => {
    const socket = createConnection(socketPath);
    let response = '';
    socket.setEncoding('utf8');
    socket.setTimeout(2_000);
    socket.once('connect', () => socket.write(`${challenge}\n`));
    socket.on('data', (chunk) => {
      response += chunk;
      if (response.length > 4_096) {
        socket.destroy();
        reject(new Error('managed Metro evidence head exceeded its bound'));
      }
    });
    socket.once('end', () => {
      try {
        const head = JSON.parse(response) as Record<string, unknown>;
        assert.equal(head.challenge, challenge);
        resolveHead(head);
      } catch (error) {
        reject(error);
      }
    });
    socket.once('timeout', () => {
      socket.destroy();
      reject(new Error('managed Metro evidence head timed out'));
    });
    socket.once('error', reject);
  });
}

async function bindForeignDefaultMetro(): Promise<{
  close: () => Promise<void>;
  owned: boolean;
}> {
  if (metroListenerPid(8081)) {
    return { owned: false, close: async () => {} };
  }
  const server = createServer((socket) => {
    socket.on('error', () => {});
    socket.end('HTTP/1.1 200 OK\r\nContent-Length: 23\r\n\r\npackager-status:running');
  });
  const owned = await new Promise<boolean>((resolveOwned, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') resolveOwned(false);
      else reject(error);
    });
    server.listen(8081, '127.0.0.1', () => resolveOwned(true));
  });
  return {
    owned,
    close: async () => {
      if (!owned || !server.listening) return;
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    },
  };
}

test(
  'installed Expo and NativeWind remain bound to managed Metro after literal pnpm ios returns',
  {
    skip: process.platform !== 'darwin' || process.env.RN_DEV_AGENT_INSTALLED_EXPO_IOS_TEST !== '1',
    timeout: 1_200_000,
  },
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'rn-managed-metro-installed-expo-')));
    const runtimeRoot = join(root, '.rn-agent', 'runtime');
    const bindingPath = join(runtimeRoot, 'binding.json');
    const completionPath = join(runtimeRoot, 'completion.json');
    const sessionCliPath = join(root, 'rn-session-installed-expo.cjs');
    const simulatorName = `RNDA-installed-expo-${process.pid}-${Date.now()}`;
    const signerCapability = randomBytes(32).toString('base64url');
    const sessionId = 'installed-expo-session';
    const instanceId = 'installed-expo-metro';
    const appId = 'com.rndevagent.testapp';
    const evidencePath = process.env.RN_DEV_AGENT_INSTALLED_EXPO_EVIDENCE_PATH?.trim();
    const port = await availablePort();
    const foreignMetro = await bindForeignDefaultMetro();
    let foreignPid: number | undefined;
    let foreignBirth: ReturnType<typeof readProcessBirth>;
    let simulatorId: string | undefined;
    let binding: ManagedMetroBinding | undefined;
    let client: CDPClient | undefined;
    let integrationApplied = false;

    try {
      foreignPid = await waitFor(
        () => metroListenerPid(8081),
        5_000,
        'the foreign default-port listener identity',
      );
      foreignBirth = readProcessBirth(foreignPid);
      assert.ok(foreignBirth);
      cpSync(fixtureRoot, root, { recursive: true });
      writeFileSync(join(root, '.gitignore'), 'node_modules/\nios/\n.expo/\n.rn-agent/runtime/\n');
      writeFileSync(
        join(root, 'metro.config.js'),
        `const { getDefaultConfig } = require('expo/metro-config');
const { withNativeWind } = require('nativewind/metro');
module.exports = withNativeWind(getDefaultConfig(__dirname), { input: './global.css' });
`,
      );
      writeFileSync(
        join(root, 'tailwind.config.js'),
        `module.exports = {
  content: ['./App.tsx', './index.ts'],
  presets: [require('nativewind/preset')],
  theme: { extend: {} },
  plugins: [],
};
`,
      );
      execFileSync('git', ['init', '-q', root]);
      execFileSync('git', ['-C', root, 'add', '.']);
      execFileSync(
        'git',
        [
          '-C',
          root,
          '-c',
          'user.name=rn-dev-agent',
          '-c',
          'user.email=fixture@rn-dev-agent.invalid',
          'commit',
          '-qm',
          'fixture',
        ],
        { stdio: 'ignore' },
      );
      const install = spawnSync('corepack', ['pnpm', 'install', '--frozen-lockfile'], {
        cwd: root,
        encoding: 'utf8',
        timeout: 180_000,
        env: { ...process.env, HUSKY: '0' },
      });
      assert.equal(install.status, 0, install.stderr);

      simulatorId = createDedicatedSimulator(simulatorName);
      runXcrun(['simctl', 'boot', simulatorId]);
      runXcrun(['simctl', 'bootstatus', simulatorId, '-b'], 300_000);
      const absent = spawnSync(
        'xcrun',
        ['simctl', 'get_app_container', simulatorId, appId, 'app'],
        { encoding: 'utf8' },
      );
      assert.notEqual(
        absent.status,
        0,
        'dedicated simulator unexpectedly contained the fixture app',
      );

      mkdirSync(runtimeRoot, { recursive: true });
      const source = resolveSourceIdentity(root);
      writeFileSync(
        sessionCliPath,
        `const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const path = require('node:path');
const command = process.argv[2];
const bindingPath = ${JSON.stringify(bindingPath)};
const completionPath = ${JSON.stringify(completionPath)};
const signerCapability = ${JSON.stringify(signerCapability)};
const sessionId = ${JSON.stringify(sessionId)};
const instanceId = ${JSON.stringify(instanceId)};
const appId = ${JSON.stringify(appId)};
const simulatorId = ${JSON.stringify(simulatorId)};
const worktreeKey = ${JSON.stringify(source.worktreeKey)};
const port = ${port};
async function writeMarker(buildGeneration) {
  const { buildSignedMetroMarker, createMetroAuthorityModule } = await import(${JSON.stringify(metroAuthorityModuleUrl)});
  const marker = buildSignedMetroMarker({
    sessionId,
    metroInstanceId: instanceId,
    worktreeKey,
    appId,
    platform: 'ios',
    buildGeneration,
  }, signerCapability);
  fs.writeFileSync(
    path.join(process.cwd(), '.rn-agent', 'integration', 'authority-marker.js'),
    createMetroAuthorityModule(marker),
    { mode: 0o600 },
  );
}
(async () => {
  const metro = await import(${JSON.stringify(managedMetroModuleUrl)});
  if (command === 'prepare-build') {
    if (!fs.existsSync(bindingPath)) {
      process.stderr.write('live Metro binding is required\\n');
      process.exit(1);
    }
    const refreshed = metro.refreshManagedMetroBuildGeneration(
      JSON.parse(fs.readFileSync(bindingPath, 'utf8')),
      { sessionId, buildGeneration: 2, signerCapability },
    );
    fs.writeFileSync(bindingPath, JSON.stringify(refreshed));
    await writeMarker(2);
    process.stdout.write(JSON.stringify({
      platform: 'ios',
      deviceId: simulatorId,
      appId,
      metroPort: port,
      sessionId,
      buildToken: 'installed-expo-build',
    }));
    return;
  }
  if (command === 'ensure-metro') {
    await writeMarker(1);
    const binding = await metro.startManagedMetro({
      appRoot: process.cwd(),
      runtimeRoot: path.dirname(bindingPath),
      sourceRoot: process.cwd(),
      sessionId,
      port,
      instanceId,
      buildGeneration: 1,
      signerCapability,
    });
    fs.writeFileSync(bindingPath, JSON.stringify(binding));
    return;
  }
  if (command === 'complete-build') {
    const { captureInstalledArtifact } = await import(${JSON.stringify(installAuthorityModuleUrl)});
    const { resolveSourceIdentity } = await import(${JSON.stringify(sourceIdentityModuleUrl)});
    const source = resolveSourceIdentity(process.cwd());
    const diff = execFileSync('git', ['-C', process.cwd(), 'diff', '--binary', 'HEAD', '--']);
    const status = execFileSync('git', ['-C', process.cwd(), 'status', '--porcelain=v1', '-z']);
    const installed = captureInstalledArtifact({
      platform: 'ios',
      deviceId: simulatorId,
      appId,
    });
    fs.writeFileSync(completionPath, JSON.stringify({
      installed,
      source,
      dirtyDigest: createHash('sha256').update(diff).update(status).digest('hex'),
    }));
    process.stdout.write('{"receipt":true}\\n');
    return;
  }
  process.exit(12);
})().catch((error) => {
  process.stderr.write(String(error && error.stack || error) + '\\n');
  process.exit(1);
});
`,
      );

      applyPackageIntegration({ appRoot: root, sessionCli: sessionCliPath });
      integrationApplied = true;
      const buildEnvironment = {
        ...process.env,
        COREPACK_ENABLE_PROJECT_SPEC: '0',
        HUSKY: '0',
        PATH: `${dirname(process.execPath)}:${process.env.PATH}`,
      };
      delete buildEnvironment.CI;
      const nativeCommand = spawnSync('pnpm', ['ios'], {
        cwd: root,
        encoding: 'utf8',
        timeout: 900_000,
        maxBuffer: 64 * 1024 * 1024,
        env: buildEnvironment,
      });
      assert.equal(nativeCommand.status, 0, `${nativeCommand.stdout}\n${nativeCommand.stderr}`);
      const nativeOutput = `${nativeCommand.stdout}\n${nativeCommand.stderr}`;
      assert.match(
        nativeOutput,
        new RegExp(`(?:127\\.0\\.0\\.1|localhost)(?::|%3A)${port}`),
        'the literal Expo command did not report the allocated managed Metro URL',
      );

      binding = JSON.parse(readFileSync(bindingPath, 'utf8')) as ManagedMetroBinding;
      assert.equal(binding.port, port);
      assert.equal(binding.servingRoot, root);
      assert.equal(binding.buildGeneration, 2);
      assert.equal(readProcessBirth(binding.launcherPid)?.token, binding.launcherBirth);
      assert.equal(readProcessBirth(binding.pid)?.token, binding.birth);
      assert.equal(metroListenerPid(port), binding.pid);
      assert.equal(
        Number(runXcrun(['simctl', 'get_app_container', simulatorId, appId, 'app']).length > 0),
        1,
      );
      assert.equal(
        Number(
          execFileSync('/bin/ps', ['-o', 'pgid=', '-p', String(binding.launcherPid)], {
            encoding: 'utf8',
          }).trim(),
        ),
        binding.launcherPid,
      );
      assert.equal(
        Number(
          execFileSync('/bin/ps', ['-o', 'pgid=', '-p', String(binding.pid)], {
            encoding: 'utf8',
          }).trim(),
        ),
        binding.launcherPid,
      );
      assert.equal(existsSync(binding.runtimeEvidenceSocket), true);
      const evidenceHead = await readEvidenceHead(binding.runtimeEvidenceSocket);
      assert.equal(evidenceHead.sessionId, sessionId);
      assert.equal(evidenceHead.metroInstanceId, instanceId);
      assert.ok(Number(evidenceHead.sequence) > 0);
      assert.match(String(evidenceHead.signature), /^[a-f0-9]{64}$/);

      const bundleResponse = await fetch(
        `http://127.0.0.1:${port}/index.bundle?platform=ios&dev=true&minify=false&modulesOnly=false&runModule=true`,
        { signal: AbortSignal.timeout(300_000) },
      );
      assert.equal(bundleResponse.ok, true);
      const bundleByteLength = (await bundleResponse.arrayBuffer()).byteLength;
      assert.ok(bundleByteLength > 1024 * 1024);

      const target = await waitFor(
        async () => {
          const response = await fetch(`http://127.0.0.1:${port}/json/list`);
          if (!response.ok) return null;
          const targets = (await response.json()) as Array<{
            appId?: string;
            deviceName?: string;
            id: string;
            vm?: string;
            webSocketDebuggerUrl?: string;
          }>;
          const matches = targets.filter(
            (entry) =>
              entry.appId === appId &&
              entry.deviceName === simulatorName &&
              typeof entry.webSocketDebuggerUrl === 'string',
          );
          return matches.length === 1 ? matches[0] : null;
        },
        120_000,
        'the dedicated installed Expo Hermes target',
      );
      assert.equal(target.vm, 'Hermes');
      assert.equal(new URL(target.webSocketDebuggerUrl!).port, String(port));

      client = new CDPClient(port);
      const bundle = await pinExactDevClient(
        {
          sessionId,
          metroInstanceId: instanceId,
          worktreeKey: source.worktreeKey,
          appId,
          platform: 'ios',
          buildGeneration: 2,
          deviceId: simulatorId,
          metroPort: port,
          signerCapability,
        },
        {
          openUrl: async () => {
            throw new Error('installed-Expo regression must not author a deep link');
          },
          launchExactApp: async () => {},
          acceptIosOpenDialog: async () => {},
          connectExact: async () => {
            await client!.autoConnect(port, {
              platform: 'ios',
              bundleId: appId,
              targetId: target.id,
            });
            assert.equal(client!.connectedTarget?.deviceName, simulatorName);
            return {
              targetId: client!.connectedTarget!.id,
              connectionGeneration: client!.connectionGeneration,
              deviceId: simulatorId!,
            };
          },
          readMarker: async () => {
            const result = await client!.evaluate(
              'JSON.stringify(globalThis.__RN_DEV_AGENT_AUTHORITY__ ?? null)',
            );
            assert.equal(typeof result.value, 'string');
            const value = JSON.parse(result.value as string) as {
              status?: string;
              marker?: Parameters<typeof pinExactDevClient>[0];
            };
            return value.status === 'signed' && value.marker
              ? { status: 'signed' as const, marker: value.marker as never }
              : null;
          },
        },
      );
      assert.equal(bundle.targetId, target.id);
      const evaluated = await client.evaluate(
        'JSON.stringify({authority:globalThis.__RN_DEV_AGENT_AUTHORITY__,runtime:globalThis.HermesInternal ? "Hermes" : "unknown"})',
      );
      assert.equal(typeof evaluated.value, 'string');
      const liveAuthority = JSON.parse(evaluated.value as string) as {
        authority: { marker: { payload: { metroInstanceId: string; sessionId: string } } };
        runtime: string;
      };
      assert.equal(liveAuthority.runtime, 'Hermes');
      assert.equal(liveAuthority.authority.marker.payload.sessionId, sessionId);
      assert.equal(liveAuthority.authority.marker.payload.metroInstanceId, instanceId);

      const completion = JSON.parse(readFileSync(completionPath, 'utf8')) as {
        dirtyDigest: string;
        installed: {
          appId: string;
          artifactDigest: string;
          deviceId: string;
          installGeneration: string;
          platform: string;
        };
        source: { head: string; worktreeKey: string };
      };
      assert.equal(completion.installed.platform, 'ios');
      assert.equal(completion.installed.deviceId, simulatorId);
      assert.equal(completion.installed.appId, appId);
      assert.match(completion.installed.artifactDigest, /^[a-f0-9]{64}$/);
      assert.match(completion.installed.installGeneration, /^[a-f0-9]{64}$/);
      assert.equal(completion.source.head, source.head);
      assert.equal(completion.source.worktreeKey, source.worktreeKey);
      assert.match(completion.dirtyDigest, /^[a-f0-9]{64}$/);

      const evidence = readFileSync(binding.runtimeEvidencePath, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      assert.equal(
        evidence.some((entry) => entry.kind === 'violation'),
        false,
        JSON.stringify(evidence.filter((entry) => entry.kind === 'violation')),
      );
      assert.ok(evidence.some((entry) => entry.kind === 'semantics'));
      assert.ok(evidence.some((entry) => entry.kind === 'input'));
      assert.ok(evidence.some((entry) => entry.kind === 'stability'));
      assert.equal(readProcessBirth(binding.launcherPid)?.token, binding.launcherBirth);
      assert.equal(readProcessBirth(binding.pid)?.token, binding.birth);
      assert.equal(metroListenerPid(port), binding.pid);
      assert.equal(existsSync(binding.runtimeEvidenceSocket), true);

      assert.equal(metroListenerPid(8081), foreignPid);
      assert.equal(readProcessBirth(foreignPid)?.token, foreignBirth.token);
      if (evidencePath) {
        writeFileSync(
          evidencePath,
          `${JSON.stringify(
            {
              appId,
              bundleByteLength,
              evidenceKinds: [...new Set(evidence.map((entry) => entry.kind))].sort(),
              foreignMetroPreserved: true,
              installedArtifactDigest: completion.installed.artifactDigest,
              installedDeviceId: completion.installed.deviceId,
              liveAuthority: liveAuthority.authority.marker.payload,
              managedMetroPort: port,
              runtime: liveAuthority.runtime,
              simulatorName,
            },
            null,
            2,
          )}\n`,
          { mode: 0o600 },
        );
      }
    } finally {
      await client?.disconnect().catch(() => {});
      if (binding) {
        await stopManagedMetro(binding, { sessionId, signerCapability }).catch(() => false);
      } else if (existsSync(bindingPath)) {
        try {
          binding = JSON.parse(readFileSync(bindingPath, 'utf8')) as ManagedMetroBinding;
          await stopManagedMetro(binding, { sessionId, signerCapability });
        } catch {}
      }
      if (integrationApplied) {
        try {
          restorePackageIntegrationFiles({ appRoot: root });
        } catch {}
      }
      if (simulatorId) {
        spawnSync('xcrun', ['simctl', 'shutdown', simulatorId], { encoding: 'utf8' });
        spawnSync('xcrun', ['simctl', 'delete', simulatorId], { encoding: 'utf8' });
      }
      if (foreignPid && foreignBirth) {
        assert.equal(metroListenerPid(8081), foreignPid);
        assert.equal(readProcessBirth(foreignPid)?.token, foreignBirth.token);
      }
      await foreignMetro.close();
      rmSync(root, { force: true, recursive: true });
    }
  },
);
