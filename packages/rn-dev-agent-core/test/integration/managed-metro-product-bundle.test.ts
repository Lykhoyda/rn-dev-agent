import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import vm from 'node:vm';
import {
  buildSignedMetroMarker,
  createMetroAuthorityModule,
} from '../../dist/session/metro-authority.js';
import {
  startManagedMetro,
  stopManagedMetro,
  type ManagedMetroBinding,
} from '../../dist/session/managed-metro.js';
import {
  applyPackageIntegration,
  restorePackageIntegrationFiles,
} from '../../dist/session/package-integration.js';
import { resolveSourceIdentity } from '../../dist/session/source-identity.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const fixtureRoot = join(repositoryRoot, 'test-fixtures', 'managed-metro-installed-expo');
const sessionId = 'managed-product-bundle-session';
const instanceId = 'managed-product-bundle-metro';
const appId = 'com.rndevagent.testapp';

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

function prepareFixture(root: string, maxWorkers: number): void {
  cpSync(fixtureRoot, root, { recursive: true });
  writeFileSync(join(root, '.gitignore'), 'node_modules/\nios/\n.expo/\n.rn-agent/runtime/\n');
  writeFileSync(
    join(root, 'metro.config.js'),
    `const { getDefaultConfig } = require('expo/metro-config');
const { withNativeWind } = require('nativewind/metro');
const config = withNativeWind(getDefaultConfig(__dirname), { input: './global.css' });
config.maxWorkers = ${maxWorkers};
module.exports = config;
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
    timeout: 300_000,
    env: { ...process.env, HUSKY: '0' },
  });
  assert.equal(install.status, 0, install.stderr);
}

async function fetchBounded(url: string, timeoutMs: number, headers: Record<string, string> = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    const body = Buffer.from(await response.arrayBuffer());
    return { body, status: response.status };
  } finally {
    clearTimeout(timer);
  }
}

// The managed product bundle must complete for the real installed-Expo fixture, which depends on
// NativeWind's Tailwind CLI child. That child exits on stdin EOF, so a descendant fence that maps
// child stdin to /dev/null stalls every bundle request without any simulator involved.
for (const transport of [
  { maxWorkers: 1, name: 'in-band transform transport' },
  { maxWorkers: 4, name: 'forked worker transform transport' },
]) {
  test(
    `managed Metro serves the product bundle over the ${transport.name}`,
    {
      skip: process.env.RN_DEV_AGENT_MANAGED_PRODUCT_BUNDLE_TEST !== '1',
      timeout: 900_000,
    },
    async () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'rn-managed-product-bundle-')));
      const runtimeRoot = join(root, '.rn-agent', 'runtime');
      const signerCapability = randomBytes(32).toString('base64url');
      const port = await availablePort();
      let binding: ManagedMetroBinding | undefined;
      let integrationApplied = false;
      try {
        prepareFixture(root, transport.maxWorkers);
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
        const manifestHeaders = {
          accept: 'application/expo+json,application/json',
          'expo-platform': 'ios',
        };
        const manifest = await fetchBounded(origin, 60_000, manifestHeaders);
        assert.equal(manifest.status, 200);
        const bundleUrl = (
          JSON.parse(manifest.body.toString('utf8')) as { launchAsset: { url: string } }
        ).launchAsset.url;
        assert.equal(new URL(bundleUrl).port, String(port));

        // Repeat so a lucky first pass cannot hide the race this regression exists to catch.
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const bundle = await fetchBounded(bundleUrl, 300_000);
          assert.equal(bundle.status, 200);
          assert.ok(
            bundle.body.length > 1024 * 1024,
            `managed product bundle was ${bundle.body.length} bytes`,
          );
          const prefix = bundle.body.subarray(0, 512).toString('utf8');
          assert.match(prefix, /__DEV__=true/);
          const bundleText = bundle.body.toString('utf8');
          assert.match(
            bundleText,
            /__RN_DEV_AGENT_AUTHORITY__/,
            'served product bundle must contain authority marker',
          );
          const context = {} as Record<string, unknown>;
          try {
            vm.runInNewContext(bundleText, context, { timeout: 5_000 });
          } catch {}
          const runtimeAuthority = context.__RN_DEV_AGENT_AUTHORITY__ as
            | {
                status?: unknown;
                marker?: { payload?: { sessionId?: unknown } };
              }
            | undefined;
          assert.equal(runtimeAuthority?.status, 'signed');
          assert.equal(runtimeAuthority.marker?.payload?.sessionId, sessionId);
          console.log(
            JSON.stringify({
              attempt: attempt + 1,
              bundleBytes: bundle.body.length,
              markerSessionId: runtimeAuthority.marker.payload.sessionId,
              markerStatus: runtimeAuthority.status,
              transport: transport.name,
            }),
          );
        }

        const evidence = readFileSync(binding.runtimeEvidencePath, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as { kind: string });
        assert.equal(
          evidence.some((entry) => entry.kind === 'violation'),
          false,
        );
        console.log(
          JSON.stringify({
            authorityViolationObserved: false,
            transport: transport.name,
          }),
        );
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
}
