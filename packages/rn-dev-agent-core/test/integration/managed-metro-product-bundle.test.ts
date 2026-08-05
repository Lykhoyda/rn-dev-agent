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

function prepareFixture(
  root: string,
  maxWorkers: number,
  metroConfig: 'default' | 'nativewind',
): void {
  cpSync(fixtureRoot, root, { recursive: true });
  writeFileSync(join(root, '.gitignore'), 'node_modules/\nios/\n.expo/\n.rn-agent/runtime/\n');
  if (metroConfig === 'default') {
    writeFileSync(
      join(root, 'App.tsx'),
      `import { Text, View } from 'react-native';

export default function App() {
  return <View><Text>Managed Metro is ready</Text></View>;
}
`,
    );
  }
  writeFileSync(
    join(root, 'metro.config.js'),
    metroConfig === 'nativewind'
      ? `const { getDefaultConfig } = require('expo/metro-config');
const { withNativeWind } = require('nativewind/metro');
const config = withNativeWind(getDefaultConfig(__dirname), { input: './global.css' });
config.maxWorkers = ${maxWorkers};
module.exports = config;
`
      : `const { getDefaultConfig } = require('expo/metro-config');
const config = getDefaultConfig(__dirname);
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

function productRuntimeContext(bundleUrl: string): {
  context: Record<string, unknown>;
  errors: string[];
} {
  const constants: Record<string, Record<string, unknown>> = {
    Appearance: { colorScheme: 'light' },
    DeviceInfo: {
      Dimensions: {
        screenPhysicalPixels: {
          width: 1179,
          height: 2556,
          scale: 3,
          fontScale: 1,
          densityDpi: 460,
        },
        windowPhysicalPixels: {
          width: 1179,
          height: 2556,
          scale: 3,
          fontScale: 1,
          densityDpi: 460,
        },
      },
    },
    I18nManager: {
      doLeftAndRightSwapInRTL: true,
      isRTL: false,
      swapLeftAndRightInRTL: true,
    },
    PlatformConstants: {
      forceTouchAvailable: false,
      interfaceIdiom: 'phone',
      isTesting: true,
      osVersion: '18.0',
      reactNativeVersion: { major: 0, minor: 85, patch: 3 },
      systemName: 'iOS',
    },
    SettingsManager: { settings: { AppleLocale: 'en_US', AppleLanguages: ['en-US'] } },
    SourceCode: { scriptURL: bundleUrl },
  };
  const modules = new Map<PropertyKey, object>();
  const nativeModuleProxy = new Proxy(
    {},
    {
      get: (_target, moduleName) => {
        if (moduleName === 'EXDevLauncher') return undefined;
        const cached = modules.get(moduleName);
        if (cached) return cached;
        const module = new Proxy(
          {
            getConstants: () => constants[String(moduleName)] ?? {},
          },
          {
            get: (target, property) => {
              if (property in target) return target[property as keyof typeof target];
              return () => null;
            },
          },
        );
        modules.set(moduleName, module);
        return module;
      },
    },
  );
  class ExpoEventEmitter {
    readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>();

    addListener(eventName: string, listener: (...args: unknown[]) => void) {
      const listeners = this.listeners.get(eventName) ?? new Set();
      listeners.add(listener);
      this.listeners.set(eventName, listeners);
      return { remove: () => this.removeListener(eventName, listener) };
    }

    removeListener(eventName: string, listener: (...args: unknown[]) => void) {
      this.listeners.get(eventName)?.delete(listener);
    }

    removeAllListeners(eventName: string) {
      this.listeners.delete(eventName);
    }

    emit(eventName: string, ...args: unknown[]) {
      for (const listener of this.listeners.get(eventName) ?? []) listener(...args);
    }

    listenerCount(eventName: string) {
      return this.listeners.get(eventName)?.size ?? 0;
    }
  }
  class ExpoNativeModule extends ExpoEventEmitter {}
  class ExpoSharedObject extends ExpoEventEmitter {
    release() {}
  }
  class ExpoSharedRef extends ExpoSharedObject {
    nativeRefType = 'unknown';
  }
  const errors: string[] = [];
  const runtimeConsole = Object.create(console) as Console;
  runtimeConsole.error = (...values: unknown[]) => {
    errors.push(
      values
        .map((value) =>
          value && typeof value === 'object' && 'stack' in value
            ? String(value.stack)
            : String(value),
        )
        .join(' '),
    );
  };
  const context: Record<string, unknown> = {
    AbortController,
    TextDecoder,
    TextEncoder,
    URL,
    URLSearchParams,
    cancelAnimationFrame: clearTimeout,
    clearImmediate,
    clearInterval,
    clearTimeout,
    console: runtimeConsole,
    expo: {
      EventEmitter: ExpoEventEmitter,
      NativeModule: ExpoNativeModule,
      SharedObject: ExpoSharedObject,
      SharedRef: ExpoSharedRef,
      modules: new Proxy(
        {},
        { get: (_target, moduleName) => Reflect.get(nativeModuleProxy, moduleName) },
      ),
    },
    nativeLoggingHook: () => {},
    nativeModuleProxy,
    navigator: { product: 'ReactNative' },
    performance,
    queueMicrotask,
    requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
    setImmediate,
    setInterval,
    setTimeout,
  };
  context.window = context;
  return { context, errors };
}

// The managed product bundle must complete for the real installed-Expo fixture, which depends on
// NativeWind's Tailwind CLI child. That child exits on stdin EOF, so a descendant fence that maps
// child stdin to /dev/null stalls every bundle request without any simulator involved.
for (const transport of [
  { maxWorkers: 4, metroConfig: 'default', name: 'default Expo config' },
  { maxWorkers: 1, metroConfig: 'nativewind', name: 'NativeWind in-band transform transport' },
  {
    maxWorkers: 4,
    metroConfig: 'nativewind',
    name: 'NativeWind forked worker transform transport',
  },
] as const) {
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
        prepareFixture(root, transport.maxWorkers, transport.metroConfig);
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
        const devClientBundleUrl = new URL(bundleUrl);
        devClientBundleUrl.searchParams.set('lazy', 'true');

        // Repeat so a lucky first pass cannot hide the race this regression exists to catch.
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const bundle = await fetchBounded(devClientBundleUrl.toString(), 300_000);
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
          const definedModuleIds = new Set(
            [...bundleText.matchAll(/__d\([^]*?,\s*(\d+),\s*\[/g)].map((match) => match[1]),
          );
          const runModuleIds = [...bundleText.matchAll(/__r\((\d+)\);/g)].map((match) => match[1]);
          assert.ok(runModuleIds.length > 0, 'served product bundle must run its main module');
          for (const moduleId of runModuleIds) {
            assert.equal(
              definedModuleIds.has(moduleId),
              true,
              `bundle must not require phantom module ${moduleId}`,
            );
          }
          const runtime = productRuntimeContext(devClientBundleUrl.toString());
          vm.runInNewContext(bundleText, runtime.context, { timeout: 5_000 });
          const errorLine = /hermes-stable:(\d+):\d+/.exec(runtime.errors[0] ?? '')?.[1];
          const bundleLines = bundleText.split('\n');
          const errorContext = errorLine
            ? bundleLines
                .slice(Math.max(0, Number(errorLine) - 4), Number(errorLine) + 2)
                .join('\n')
            : '';
          assert.deepEqual(
            runtime.errors,
            [],
            `product runtime emitted an error${errorContext ? `:\n${errorContext}` : ''}`,
          );
          const context = runtime.context;
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
