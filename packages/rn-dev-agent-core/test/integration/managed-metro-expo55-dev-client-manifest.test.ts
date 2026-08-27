import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { parseExpoManifestBody } from '../../dist/session/expo-manifest.js';
import {
  buildSignedMetroMarker,
  createMetroAuthorityModule,
} from '../../dist/session/metro-authority.js';
import {
  startManagedMetro,
  stopManagedMetro,
  type ManagedMetroBinding,
} from '../../dist/session/managed-metro.js';
import { metroListenerPid } from '../../dist/session/metro-binding.js';
import {
  applyPackageIntegration,
  restorePackageIntegrationFiles,
} from '../../dist/session/package-integration.js';
import { resolveSourceIdentity } from '../../dist/session/source-identity.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const fixtureRoot = join(repositoryRoot, 'test-fixtures', 'managed-metro-expo55-dev-client');
const sessionId = 'expo55-dev-client-manifest-session';
const instanceId = 'expo55-dev-client-manifest-metro';
const appId = 'com.rndevagent.expo55devclient';

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

function prepareFixture(root: string): void {
  cpSync(fixtureRoot, root, { recursive: true });
  writeFileSync(join(root, '.gitignore'), 'node_modules/\nios/\n.expo/\n.rn-agent/runtime/\n');
  writeFileSync(
    join(root, 'metro.config.js'),
    `const { getDefaultConfig } = require('expo/metro-config');
const config = getDefaultConfig(__dirname);
config.maxWorkers = 2;
module.exports = config;
`,
  );
  const install = spawnSync('corepack', ['pnpm', 'install', '--frozen-lockfile'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 600_000,
    env: { ...process.env, HUSKY: '0' },
  });
  assert.equal(install.status, 0, install.stderr);

  // The reported defect only reaches the runtime-version branch through a native Dev Client
  // project, so the regression prebuilds one instead of using a managed-workflow fixture.
  const prebuild = spawnSync(
    process.execPath,
    [
      join(root, 'node_modules', 'expo', 'bin', 'cli'),
      'prebuild',
      '--platform',
      'ios',
      '--no-install',
    ],
    {
      cwd: root,
      encoding: 'utf8',
      timeout: 600_000,
      env: { ...process.env, CI: '1', EXPO_NO_TELEMETRY: '1' },
    },
  );
  assert.equal(prebuild.status, 0, prebuild.stderr);
  assert.ok(existsSync(join(root, 'ios')), 'Expo 55 regression requires a native iOS project');

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
}

async function fetchBounded(url: string, timeoutMs: number, headers: Record<string, string> = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    const body = Buffer.from(await response.arrayBuffer());
    return {
      body,
      headers: Object.fromEntries(response.headers.entries()),
      status: response.status,
    };
  } finally {
    clearTimeout(timer);
  }
}

test(
  'managed Metro serves the Expo 55 Dev Client manifest without granting bundle authority',
  {
    skip: process.env.RN_DEV_AGENT_EXPO_DEV_CLIENT_MANIFEST_TEST !== '1',
    timeout: 1_800_000,
  },
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'rn-expo55-dev-client-manifest-')));
    const runtimeRoot = join(root, '.rn-agent', 'runtime');
    const signerCapability = randomBytes(32).toString('base64url');
    const port = await availablePort();
    let binding: ManagedMetroBinding | undefined;
    let integrationApplied = false;
    try {
      prepareFixture(root);
      const metroConfigBefore = readFileSync(join(root, 'metro.config.js'), 'utf8');
      const packageJsonBefore = readFileSync(join(root, 'package.json'), 'utf8');
      mkdirSync(runtimeRoot, { recursive: true });
      const source = resolveSourceIdentity(root);
      applyPackageIntegration({ appRoot: root, sessionCli: join(root, 'rn-session.cjs') });
      integrationApplied = true;
      writeFileSync(
        join(root, '.rn-agent', 'integration', 'authority-marker.js'),
        createMetroAuthorityModule(
          buildSignedMetroMarker(
            {
              sessionId,
              metroInstanceId: instanceId,
              worktreeKey: source.worktreeKey,
              appId,
              platform: 'ios',
              buildGeneration: 1,
            },
            signerCapability,
          ),
        ),
        { mode: 0o600 },
      );
      binding = await startManagedMetro({
        appRoot: root,
        runtimeRoot,
        sourceRoot: root,
        sessionId,
        port,
        instanceId,
        buildGeneration: 1,
        signerCapability,
      });

      const origin = `http://127.0.0.1:${port}`;
      const manifestRequests = [
        {
          name: 'expo-json',
          headers: { accept: 'application/expo+json,application/json', 'expo-platform': 'ios' },
        },
        {
          name: 'dev-client-multipart',
          headers: {
            accept: 'multipart/mixed,application/expo+json,application/json',
            'expo-platform': 'ios',
            'expo-protocol-version': '1',
            'expo-api-version': '1',
            'expo-updates-environment': 'DEVELOPMENT',
            'expo-json-error': 'true',
          },
        },
      ];
      let launchAssetUrl = '';
      for (const request of manifestRequests) {
        const manifest = await fetchBounded(origin, 300_000, request.headers);
        assert.equal(
          manifest.status,
          200,
          `${request.name} manifest failed: ${manifest.body.toString('utf8').slice(0, 400)}`,
        );
        const parsed = parseExpoManifestBody(manifest.body.toString('utf8'));
        assert.ok(parsed);
        launchAssetUrl = (parsed.launchAsset as { url: string }).url;
        console.log(
          JSON.stringify({
            request: request.name,
            manifestStatus: manifest.status,
            launchAssetPort: new URL(launchAssetUrl).port,
            runtimeVersion: parsed.runtimeVersion,
          }),
        );
      }

      // Exact bundle/target evidence retained for the separate #674 revalidation.
      const bundle = await fetchBounded(launchAssetUrl, 900_000);
      assert.equal(bundle.status, 200);
      const bundleText = bundle.body.toString('utf8');
      assert.match(
        bundleText,
        /__RN_DEV_AGENT_AUTHORITY__/,
        'the manifest launch asset must carry the signed authority marker',
      );
      console.log(
        JSON.stringify({
          launchAssetUrl,
          bundleBytes: bundle.body.length,
          bundleSha256: createHash('sha256').update(bundle.body).digest('hex'),
          markerModulePresent: bundleText.includes('authority-marker.js'),
          markerGlobalPresent: bundleText.includes('__RN_DEV_AGENT_AUTHORITY__'),
        }),
      );

      const evidence = readFileSync(binding.runtimeEvidencePath, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { kind: string; value: string });
      assert.equal(
        evidence.some((entry) => entry.kind === 'violation'),
        false,
      );
      const utilities = evidence
        .filter((entry) => entry.kind === 'unattested-utility')
        .map((entry) => JSON.parse(entry.value) as { command: string; proofBearing: boolean });
      assert.ok(
        utilities.some((entry) => entry.command.includes('expo-updates')),
        'the manifest runtime-version utility must run outside bundle authority',
      );
      assert.equal(
        utilities.every((entry) => entry.proofBearing === false),
        true,
      );
      const attestedLaunches = evidence
        .filter((entry) => entry.kind === 'launch')
        .map((entry) => JSON.parse(entry.value) as { semantics: string });
      assert.equal(
        attestedLaunches.length > 0,
        true,
        'Metro transform descendants must still be attested',
      );
      console.log(
        JSON.stringify({
          attestedDescendants: attestedLaunches.length,
          unattestedUtilities: utilities.length,
          authorityViolationObserved: false,
        }),
      );

      const stopped = await stopManagedMetro(binding, { sessionId, signerCapability });
      binding = undefined;
      assert.equal(stopped, true, 'managed Metro cleanup must be proven');
      assert.equal(metroListenerPid(port), null, 'the managed Metro port must be released');

      restorePackageIntegrationFiles({ appRoot: root });
      integrationApplied = false;
      assert.equal(readFileSync(join(root, 'metro.config.js'), 'utf8'), metroConfigBefore);
      assert.equal(readFileSync(join(root, 'package.json'), 'utf8'), packageJsonBefore);
      assert.deepEqual(readdirSync(join(root, '.rn-agent', 'integration')), []);
    } finally {
      if (binding) {
        await stopManagedMetro(binding, { sessionId, signerCapability }).catch(() => false);
      }
      if (integrationApplied) {
        try {
          restorePackageIntegrationFiles({ appRoot: root });
        } catch {}
      }
      rmSync(root, { force: true, recursive: true });
    }
  },
);
