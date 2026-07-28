import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { applyPackageIntegration } from '../../dist/session/package-integration.js';
import { stopManagedMetro } from '../../dist/session/managed-metro.js';

const requireFromTest = createRequire(import.meta.url);
const managedMetroModuleUrl = new URL('../../dist/session/managed-metro.js', import.meta.url).href;
const supportedDarwinArchitecture = process.arch === 'arm64' || process.arch === 'x64';

function resolveOxfmtAddonPath(): string {
  if (!supportedDarwinArchitecture) {
    throw new Error(`unsupported Darwin architecture: ${process.arch}`);
  }
  return requireFromTest.resolve(
    `@oxfmt/binding-darwin-${process.arch}/oxfmt.darwin-${process.arch}.node`,
  );
}

async function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('test port unavailable'));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

test(
  'literal pnpm ios starts managed Expo Metro with NativeWind addon evidence',
  { skip: process.platform !== 'darwin' || !supportedDarwinArchitecture, timeout: 45_000 },
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'rn-metro-pnpm-nativewind-')));
    const runtimeRoot = join(root, 'runtime');
    const integrationRoot = join(root, '.rn-agent', 'integration');
    const binRoot = join(root, 'node_modules', '.bin');
    const pnpmRoot = join(root, 'node_modules', '.pnpm');
    const expoRoot = join(pnpmRoot, 'expo@1.0.0', 'node_modules', 'expo');
    const nativeWindRoot = join(pnpmRoot, 'nativewind@1.0.0', 'node_modules', 'nativewind');
    const cssInteropRoot = join(
      pnpmRoot,
      'react-native-css-interop@1.0.0',
      'node_modules',
      'react-native-css-interop',
    );
    const lightningCssRoot = join(pnpmRoot, 'lightningcss@1.0.0', 'node_modules', 'lightningcss');
    const addonPath = join(lightningCssRoot, 'lightningcss.node');
    const bindingPath = join(runtimeRoot, 'binding.json');
    const buildResultPath = join(runtimeRoot, 'build-result.json');
    const sessionCliPath = join(root, 'rn-session-fixture.cjs');
    const port = await availablePort();
    const signerCapability = 'integration-signer';

    try {
      for (const directory of [
        runtimeRoot,
        integrationRoot,
        binRoot,
        join(expoRoot, 'bin'),
        nativeWindRoot,
        cssInteropRoot,
        lightningCssRoot,
      ]) {
        mkdirSync(directory, { recursive: true });
      }
      spawnSync('git', ['init', '-q', root], { encoding: 'utf8' });
      writeFileSync(
        join(root, 'package.json'),
        `${JSON.stringify({
          name: 'managed-metro-pnpm-nativewind-fixture',
          private: true,
          scripts: {
            ios: 'expo run:ios',
            android: 'expo run:android',
          },
          dependencies: {
            expo: '1.0.0',
            nativewind: '1.0.0',
          },
        })}\n`,
      );
      writeFileSync(join(root, 'metro.config.js'), 'module.exports = {};\n');
      for (const [packageRoot, name, source] of [
        [nativeWindRoot, 'nativewind', "module.exports = require('react-native-css-interop');\n"],
        [cssInteropRoot, 'react-native-css-interop', "module.exports = require('lightningcss');\n"],
        [lightningCssRoot, 'lightningcss', "module.exports = require('./lightningcss.node');\n"],
      ] as const) {
        writeFileSync(
          join(packageRoot, 'package.json'),
          JSON.stringify({ name, main: 'index.js' }),
        );
        writeFileSync(join(packageRoot, 'index.js'), source);
        symlinkSync(packageRoot, join(root, 'node_modules', name), 'dir');
      }
      copyFileSync(resolveOxfmtAddonPath(), addonPath);
      writeFileSync(
        join(expoRoot, 'package.json'),
        JSON.stringify({ name: 'expo', version: '1.0.0', bin: { expo: 'bin/cli.cjs' } }),
      );
      writeFileSync(
        join(expoRoot, 'bin', 'cli.cjs'),
        `const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const args = process.argv.slice(2);
if (args.includes('--version')) {
  process.stdout.write('1.0.0\\n');
  process.exit(0);
}
if (args[0] === 'start') {
  require(path.join(process.cwd(), 'metro.config.js'));
  require('nativewind');
  const port = Number(args[args.indexOf('--port') + 1]);
  net.createServer((socket) => {
    socket.end('HTTP/1.1 200 OK\\r\\nContent-Length: 23\\r\\n\\r\\npackager-status:running');
  }).listen(port, '127.0.0.1');
  setInterval(() => {}, 1 << 30);
} else if (args[0] === 'run:ios') {
  const evidence = fs.readFileSync(path.join(process.env.FIXTURE_RUNTIME_ROOT, 'metro-runtime-evidence.jsonl'), 'utf8')
    .trim()
    .split('\\n')
    .map((line) => JSON.parse(line));
  const addon = fs.realpathSync(process.env.FIXTURE_ADDON_PATH);
  const digest = require('node:crypto').createHash('sha256').update(fs.readFileSync(addon)).digest('hex');
  const observed = (kind) => evidence.some((entry) =>
    entry.kind === kind &&
    entry.value === addon &&
    entry.digest === digest &&
    /^[a-f0-9]{64}$/.test(entry.signature || '')
  );
  if (!args.includes('--no-bundler') || !observed('input') || !observed('stability')) process.exit(7);
  const socket = net.createConnection({ host: '127.0.0.1', port: Number(process.env.RCT_METRO_PORT) });
  socket.setTimeout(2000, () => process.exit(8));
  socket.once('error', () => process.exit(9));
  socket.once('connect', () => {
    socket.destroy();
    fs.writeFileSync(process.env.FIXTURE_BUILD_RESULT, JSON.stringify({ port: process.env.RCT_METRO_PORT }));
  });
} else {
  process.exit(10);
}
`,
      );
      const expoExecutable = join(binRoot, 'expo');
      writeFileSync(
        expoExecutable,
        `#!/bin/sh
basedir=$(dirname "$(echo "$0" | sed -e 's,\\\\,/,g')")
exec node "$basedir/../.pnpm/expo@1.0.0/node_modules/expo/bin/cli.cjs" "$@"
`,
      );
      chmodSync(expoExecutable, 0o755);
      writeFileSync(
        sessionCliPath,
        `const fs = require('node:fs');
const path = require('node:path');
const command = process.argv[2];
const bindingPath = process.env.FIXTURE_BINDING_PATH;
const metroModule = ${JSON.stringify(managedMetroModuleUrl)};
(async () => {
  if (command === 'prepare-build') {
    if (!fs.existsSync(bindingPath)) {
      process.stderr.write('live Metro binding is required\\n');
      process.exit(1);
    }
    process.stdout.write(JSON.stringify({
      platform: 'ios',
      deviceId: 'fixture-device',
      appId: 'dev.fixture',
      metroPort: Number(process.env.FIXTURE_METRO_PORT),
      sessionId: 'fixture-session',
      buildToken: 'fixture-build-token'
    }));
    return;
  }
  const { startManagedMetro, stopManagedMetro } = await import(metroModule);
  if (command === 'ensure-metro') {
    const binding = await startManagedMetro({
      appRoot: process.cwd(),
      runtimeRoot: process.env.FIXTURE_RUNTIME_ROOT,
      sourceRoot: process.cwd(),
      sessionId: 'fixture-session',
      port: Number(process.env.FIXTURE_METRO_PORT),
      instanceId: 'fixture-metro',
      buildGeneration: 1,
      signerCapability: ${JSON.stringify(signerCapability)}
    });
    fs.writeFileSync(bindingPath, JSON.stringify(binding));
    return;
  }
  if (command === 'complete-build') {
    const binding = JSON.parse(fs.readFileSync(bindingPath, 'utf8'));
    if (!await stopManagedMetro(binding, {
      sessionId: 'fixture-session',
      signerCapability: ${JSON.stringify(signerCapability)}
    })) process.exit(11);
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
      const result = spawnSync('pnpm', ['ios'], {
        cwd: root,
        encoding: 'utf8',
        timeout: 40_000,
        env: {
          ...process.env,
          FIXTURE_ADDON_PATH: addonPath,
          FIXTURE_BINDING_PATH: bindingPath,
          FIXTURE_BUILD_RESULT: buildResultPath,
          FIXTURE_METRO_PORT: String(port),
          FIXTURE_RUNTIME_ROOT: runtimeRoot,
        },
      });

      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(readFileSync(buildResultPath, 'utf8')), {
        port: String(port),
      });
      const binding = JSON.parse(readFileSync(bindingPath, 'utf8')) as Record<string, unknown>;
      assert.match(
        String(binding.runtimeEvidenceAuthority),
        /^(?:managed-sandbox-v1|reported-v1)$/,
      );
      assert.equal(binding.runtimeEvidenceProtocol, 2);
      const evidence = readFileSync(join(runtimeRoot, 'metro-runtime-evidence.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const canonicalAddon = realpathSync(addonPath);
      const addonDigest = createHash('sha256').update(readFileSync(addonPath)).digest('hex');
      for (const kind of ['input', 'stability']) {
        assert.ok(
          evidence.some(
            (entry) =>
              entry.kind === kind &&
              entry.value === canonicalAddon &&
              entry.digest === addonDigest &&
              typeof entry.signature === 'string' &&
              /^[a-f0-9]{64}$/.test(entry.signature),
          ),
          kind,
        );
      }
    } finally {
      if (existsSync(bindingPath)) {
        try {
          const binding = JSON.parse(readFileSync(bindingPath, 'utf8')) as Record<string, unknown>;
          await stopManagedMetro(binding, {
            sessionId: 'fixture-session',
            signerCapability,
          });
        } catch {}
      }
      rmSync(root, { force: true, recursive: true });
    }
  },
);
