import assert from 'node:assert/strict';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync, fork, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  applyPackageIntegration,
  previewMetroIntegration,
  previewPackageIntegration,
  readPackageIntegrationInputs,
  readRegularFileNoFollow,
  renderMetroIntegrationAdapter,
  renderProjectAdapter,
  restoreMetroIntegration,
  restorePackageIntegrationFiles,
  restorePackageIntegration,
} from '../../../dist/session/package-integration.js';
import {
  casBoundDirectoryFiles,
  closeBoundDirectories,
  closeBoundDirectory,
  openBoundDirectory,
  openBoundSubdirectory,
  openOptionalBoundSubdirectory,
  readBoundDirectoryFiles,
  writeBoundDirectoryFile,
} from '../../../dist/session/bound-directory.js';

const packageJson = {
  name: 'fixture-app',
  scripts: {
    ios: 'expo run:ios',
    android: 'npx react-native run-android --mode debug',
    test: 'jest',
  },
};

function metroPolicyEnvironment(adapterPath: string): NodeJS.ProcessEnv {
  const runtimeLoads = join(dirname(adapterPath), 'metro-runtime-loads.jsonl');
  writeFileSync(runtimeLoads, '');
  return {
    ...process.env,
    NODE_OPTIONS: `--require=${JSON.stringify(adapterPath)}`,
    RN_DEV_AGENT_SESSION_ID: 'session',
    RN_DEV_AGENT_METRO_INSTANCE_ID: 'metro',
    RN_DEV_AGENT_METRO_POLICY_CAPABILITY: 'capability',
    RN_DEV_AGENT_METRO_AUTHORITY_PRELOAD: adapterPath,
    RN_DEV_AGENT_METRO_BASE_NODE_OPTIONS: '',
    RN_DEV_AGENT_METRO_RUNTIME_LOADS: runtimeLoads,
  };
}

test('integration preview is reversible and preserves unrelated scripts', () => {
  const preview = previewPackageIntegration(packageJson);

  assert.deepEqual(preview.packageJson.scripts, {
    ios: 'node .rn-agent/integration/rn-session-adapter.cjs ios',
    android: 'node .rn-agent/integration/rn-session-adapter.cjs android',
    test: 'jest',
  });
  assert.deepEqual(preview.manifest.originalScripts, {
    ios: ['expo', 'run:ios'],
    android: ['npx', 'react-native', 'run-android', '--mode', 'debug'],
  });
  assert.deepEqual(restorePackageIntegration(preview.packageJson, preview.manifest), packageJson);
});

test('integration preview is idempotent for its own sentinel scripts', () => {
  const first = previewPackageIntegration(packageJson);
  const second = previewPackageIntegration(first.packageJson, first.manifest);

  assert.deepEqual(second, first);
});

test('integration preview refreshes the session CLI without replacing original scripts', () => {
  const first = previewPackageIntegration(packageJson, undefined, '/old/rn-session.js');
  const second = previewPackageIntegration(first.packageJson, first.manifest, '/new/rn-session.js');

  assert.equal(second.manifest.sessionCli, '/new/rn-session.js');
  assert.deepEqual(second.manifest.originalScripts, first.manifest.originalScripts);
});

test('copied adapter fails closed when its persisted session CLI no longer exists', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-missing-cli-'));
  try {
    const integrationRoot = join(root, '.rn-agent', 'integration');
    mkdirSync(integrationRoot, { recursive: true });
    const adapterPath = join(integrationRoot, 'rn-session-adapter.cjs');
    writeFileSync(adapterPath, renderProjectAdapter());
    writeFileSync(
      join(integrationRoot, 'rn-session-integration.json'),
      JSON.stringify({
        version: 1,
        adapter: '.rn-agent/integration/rn-session-adapter.cjs',
        sessionCli: join(root, 'removed-plugin', 'rn-session.js'),
        originalScripts: {
          ios: ['node', '-e', 'process.exit(0)'],
          android: ['expo', 'run:android'],
        },
      }),
    );

    const result = spawnSync(process.execPath, [adapterPath, 'ios'], {
      cwd: root,
      encoding: 'utf8',
    });

    assert.equal(result.status, 2);
    assert.match(result.stderr, /reapply integration/i);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('Metro integration composes object and promise configs and is reversible', async () => {
  const original = 'const base = { serializer: {} };\nmodule.exports = base;\n';
  const integrated = previewMetroIntegration(original);
  assert.equal(previewMetroIntegration(integrated), integrated);
  assert.equal(restoreMetroIntegration(integrated), original);

  const root = mkdtempSync(join(tmpdir(), 'rn-session-metro-'));
  try {
    const adapterPath = join(root, 'rn-session-metro.cjs');
    writeFileSync(adapterPath, renderMetroIntegrationAdapter());
    const compose = await import(`${pathToFileURL(adapterPath).href}?v=${Date.now()}`);
    const prior = () => ['/existing-before-main.js'];
    const object = compose.default({ serializer: { getModulesRunBeforeMainModule: prior } });
    assert.deepEqual(object.serializer.getModulesRunBeforeMainModule('index.js').slice(1), [
      '/existing-before-main.js',
    ]);
    const promised = await compose.default(Promise.resolve({ serializer: {} }));
    assert.match(
      promised.serializer.getModulesRunBeforeMainModule('index.js')[0],
      /authority-marker/,
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('Metro integration records external and custom resolver inputs', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-metro-policy-'));
  try {
    execFileSync('git', ['init', '-q', root]);
    const integration = join(root, '.rn-agent', 'integration');
    mkdirSync(integration, { recursive: true });
    const adapterPath = join(integration, 'rn-session-metro.cjs');
    writeFileSync(adapterPath, renderMetroIntegrationAdapter());
    const result = spawnSync(
      process.execPath,
      [
        '-e',
        `const compose = require(${JSON.stringify(adapterPath)}); compose({ resolver: { resolveRequest() {}, nodeModulesPaths: [${JSON.stringify(tmpdir())}] } });`,
      ],
      {
        cwd: root,
        env: metroPolicyEnvironment(adapterPath),
        encoding: 'utf8',
      },
    );

    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(
      readFileSync(join(integration, 'metro-runtime-policy.json'), 'utf8'),
    );
    assert.ok(receipt.violations.some((entry: string) => entry.includes('custom Metro resolvers')));
    assert.ok(receipt.runtimeInputs.includes(realpathSync(tmpdir())));
    assert.match(receipt.signature, /^[a-f0-9]{64}$/);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('Metro integration rejects external executable modules', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-metro-executable-'));
  const external = mkdtempSync(join(tmpdir(), 'rn-session-metro-external-module-'));
  try {
    execFileSync('git', ['init', '-q', root]);
    const integration = join(root, '.rn-agent', 'integration');
    mkdirSync(integration, { recursive: true });
    const adapterPath = join(integration, 'rn-session-metro.cjs');
    const transformerPath = join(external, 'transformer.cjs');
    const trackedTransformerPath = join(root, 'tracked-transformer.cjs');
    writeFileSync(adapterPath, renderMetroIntegrationAdapter());
    writeFileSync(transformerPath, 'module.exports = {};\n');
    writeFileSync(trackedTransformerPath, 'module.exports = {};\n');
    const result = spawnSync(
      process.execPath,
      [
        '-e',
        `const compose = require(${JSON.stringify(adapterPath)}); compose({ transformerPath: ${JSON.stringify(trackedTransformerPath)}, transformer: { babelTransformerPath: ${JSON.stringify(transformerPath)} } });`,
      ],
      {
        cwd: root,
        env: metroPolicyEnvironment(adapterPath),
        encoding: 'utf8',
      },
    );

    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(
      readFileSync(join(integration, 'metro-runtime-policy.json'), 'utf8'),
    );
    assert.ok(
      receipt.violations.some((entry: string) =>
        entry.includes('must resolve to Git-authenticated source'),
      ),
    );
    assert.ok(
      receipt.violations.some(
        (entry: string) =>
          entry.includes('babelTransformerPath') &&
          entry.includes('must resolve to Git-authenticated source'),
      ),
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
    rmSync(external, { force: true, recursive: true });
  }
});

test('Metro integration accepts React Native and Expo executable modules', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-metro-local-worker-'));
  try {
    execFileSync('git', ['init', '-q', root]);
    const integration = join(root, '.rn-agent', 'integration');
    mkdirSync(integration, { recursive: true });
    const adapterPath = join(integration, 'rn-session-metro.cjs');
    writeFileSync(adapterPath, renderMetroIntegrationAdapter());
    const modulePaths = Object.fromEntries(
      ['metro-transform-worker', '@react-native/metro-babel-transformer'].map((name) => {
        const moduleRoot = join(root, 'node_modules', name);
        const modulePath = join(moduleRoot, 'index.cjs');
        mkdirSync(moduleRoot, { recursive: true });
        writeFileSync(
          join(moduleRoot, 'package.json'),
          JSON.stringify({ name, main: 'index.cjs' }),
        );
        writeFileSync(modulePath, 'module.exports = {};\n');
        return [name, modulePath];
      }),
    );
    const expoRoot = join(root, 'node_modules', '@expo', 'metro-config');
    mkdirSync(expoRoot, { recursive: true });
    writeFileSync(
      join(expoRoot, 'package.json'),
      JSON.stringify({ name: '@expo/metro-config', main: 'index.cjs' }),
    );
    writeFileSync(join(expoRoot, 'index.cjs'), 'module.exports = {};\n');
    const expoTransformer = join(expoRoot, 'transform-worker.cjs');
    const expoBabelTransformer = join(expoRoot, 'babel-transformer.cjs');
    writeFileSync(expoTransformer, 'module.exports = {};\n');
    writeFileSync(expoBabelTransformer, 'module.exports = {};\n');
    const result = spawnSync(
      process.execPath,
      [
        '-e',
        `const compose = require(${JSON.stringify(adapterPath)}); compose({ transformerPath: ${JSON.stringify(modulePaths['metro-transform-worker'])}, transformer: { babelTransformerPath: ${JSON.stringify(modulePaths['@react-native/metro-babel-transformer'])} } }); const customSerializer = Object.assign(() => 'bundle', { __originalSerializer: null }); const expo = compose({ transformerPath: ${JSON.stringify(expoTransformer)}, transformer: { babelTransformerPath: ${JSON.stringify(expoBabelTransformer)} }, serializer: { customSerializer } }); if (expo.serializer.customSerializer() !== 'bundle') process.exit(1);`,
      ],
      {
        cwd: root,
        env: metroPolicyEnvironment(adapterPath),
        encoding: 'utf8',
      },
    );

    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(
      readFileSync(join(integration, 'metro-runtime-policy.json'), 'utf8'),
    );
    assert.deepEqual(receipt.violations, []);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('Metro integration preserves standard null defaults and authenticates bundle modules', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-metro-defaults-'));
  try {
    execFileSync('git', ['init', '-q', root]);
    const integration = join(root, '.rn-agent', 'integration');
    const moduleRoot = join(root, 'node_modules', 'fixture-runtime');
    const assetRegistryRoot = join(root, 'node_modules', '@react-native', 'assets-registry');
    mkdirSync(integration, { recursive: true });
    mkdirSync(moduleRoot, { recursive: true });
    mkdirSync(assetRegistryRoot, { recursive: true });
    const adapterPath = join(integration, 'rn-session-metro.cjs');
    const assetRegistryPath = join(assetRegistryRoot, 'asset-registry.cjs');
    const polyfillPath = join(moduleRoot, 'polyfill.cjs');
    writeFileSync(adapterPath, renderMetroIntegrationAdapter());
    writeFileSync(
      join(assetRegistryRoot, 'package.json'),
      JSON.stringify({ name: '@react-native/assets-registry', main: 'asset-registry.cjs' }),
    );
    writeFileSync(assetRegistryPath, 'module.exports = {};\n');
    writeFileSync(polyfillPath, 'module.exports = {};\n');
    const result = spawnSync(
      process.execPath,
      [
        '-e',
        `const compose = require(${JSON.stringify(adapterPath)}); const config = compose({ resolver: { resolveRequest: null }, transformer: { assetRegistryPath: ${JSON.stringify(assetRegistryPath)} }, serializer: { customSerializer: null, experimentalSerializerHook() {}, polyfillModuleNames: [${JSON.stringify(polyfillPath)}] } }); config.serializer.experimentalSerializerHook({});`,
      ],
      {
        cwd: root,
        env: metroPolicyEnvironment(adapterPath),
        encoding: 'utf8',
      },
    );

    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(
      readFileSync(join(integration, 'metro-runtime-policy.json'), 'utf8'),
    );
    assert.equal(
      receipt.violations.some(
        (entry: string) =>
          entry.includes('custom Metro resolvers') || entry.includes('custom Metro serializers'),
      ),
      false,
    );
    assert.ok(receipt.runtimeInputs.includes(realpathSync(assetRegistryPath)));
    assert.ok(receipt.runtimeInputs.includes(realpathSync(polyfillPath)));
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('Metro integration rejects arbitrary executable closures', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-metro-custom-worker-'));
  try {
    execFileSync('git', ['init', '-q', root]);
    const integration = join(root, '.rn-agent', 'integration');
    const transformerRoot = join(root, 'node_modules', 'fixture-transformer');
    mkdirSync(integration, { recursive: true });
    mkdirSync(transformerRoot, { recursive: true });
    const adapterPath = join(integration, 'rn-session-metro.cjs');
    const transformerPath = join(transformerRoot, 'index.cjs');
    writeFileSync(adapterPath, renderMetroIntegrationAdapter());
    writeFileSync(transformerPath, 'module.exports = {};\n');
    const result = spawnSync(
      process.execPath,
      [
        '-e',
        `const compose = require(${JSON.stringify(adapterPath)}); compose({ transformerPath: ${JSON.stringify(transformerPath)} });`,
      ],
      {
        cwd: root,
        env: metroPolicyEnvironment(adapterPath),
        encoding: 'utf8',
      },
    );

    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(
      readFileSync(join(integration, 'metro-runtime-policy.json'), 'utf8'),
    );
    assert.equal(
      receipt.violations.some((entry: string) => entry.includes('transformerPath')),
      true,
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('Metro integration rejects spoofed supported package metadata', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-metro-spoofed-worker-'));
  try {
    execFileSync('git', ['init', '-q', root]);
    const integration = join(root, '.rn-agent', 'integration');
    const canonicalRoot = join(root, 'node_modules', 'metro-transform-worker');
    const spoofedRoot = join(root, 'spoofed-transformer');
    mkdirSync(integration, { recursive: true });
    mkdirSync(canonicalRoot, { recursive: true });
    mkdirSync(spoofedRoot, { recursive: true });
    const adapterPath = join(integration, 'rn-session-metro.cjs');
    const canonicalPath = join(canonicalRoot, 'index.cjs');
    const spoofedPath = join(spoofedRoot, 'index.cjs');
    writeFileSync(adapterPath, renderMetroIntegrationAdapter());
    writeFileSync(
      join(canonicalRoot, 'package.json'),
      JSON.stringify({ name: 'metro-transform-worker', main: 'index.cjs' }),
    );
    writeFileSync(
      join(spoofedRoot, 'package.json'),
      JSON.stringify({ name: 'metro-transform-worker', main: 'index.cjs' }),
    );
    writeFileSync(canonicalPath, 'module.exports = {};\n');
    writeFileSync(spoofedPath, 'module.exports = {};\n');
    const result = spawnSync(
      process.execPath,
      [
        '-e',
        `const compose = require(${JSON.stringify(adapterPath)}); compose({ transformerPath: ${JSON.stringify(spoofedPath)} });`,
      ],
      {
        cwd: root,
        env: metroPolicyEnvironment(adapterPath),
        encoding: 'utf8',
      },
    );

    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(
      readFileSync(join(integration, 'metro-runtime-policy.json'), 'utf8'),
    );
    assert.ok(
      receipt.violations.some((entry: string) =>
        entry.includes('not a supported Metro executable module'),
      ),
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('Metro preload records child-process and worker-thread module loads', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-metro-worker-preload-'));
  const external = mkdtempSync(join(tmpdir(), 'rn-session-metro-worker-inputs-'));
  let evidenceDescriptor: number | undefined;
  try {
    execFileSync('git', ['init', '-q', root]);
    const integration = join(root, '.rn-agent', 'integration');
    mkdirSync(integration, { recursive: true });
    const adapterPath = join(integration, 'rn-session-metro.cjs');
    const childModule = join(external, 'child.cjs');
    const childEntry = join(external, 'child-entry.cjs');
    const threadModule = join(external, 'thread.cjs');
    const threadEntry = join(external, 'thread-entry.cjs');
    const postWorkerModule = join(external, 'post-worker.cjs');
    writeFileSync(adapterPath, renderMetroIntegrationAdapter());
    writeFileSync(childModule, 'module.exports = {};\n');
    writeFileSync(childEntry, `require(${JSON.stringify(childModule)});\n`);
    writeFileSync(threadModule, 'module.exports = {};\n');
    writeFileSync(threadEntry, `require(${JSON.stringify(threadModule)});\n`);
    writeFileSync(postWorkerModule, 'module.exports = {};\n');
    const environment = metroPolicyEnvironment(adapterPath);
    environment.RN_DEV_AGENT_METRO_BASE_NODE_OPTIONS = '--conditions=react_native';
    environment.NODE_OPTIONS = `--conditions=react_native --require=${JSON.stringify(adapterPath)}`;
    const runtimeLoads = join(integration, 'metro-runtime-loads.jsonl');
    evidenceDescriptor = openSync(runtimeLoads, 'a');
    environment.RN_DEV_AGENT_METRO_EVIDENCE_FD = '9';
    const result = spawnSync(
      process.execPath,
      [
        '-e',
        `(async () => { const compose = require(${JSON.stringify(adapterPath)}); compose({ maxWorkers: 4 }); const childProcess = require('node:child_process'); const childEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => ['path', 'systemroot'].includes(key.toLowerCase()))); let rejected; try { childProcess.spawnSync('unauthenticated-descendant', []); } catch (error) { rejected = error; } if (rejected?.code !== 'RN_DEV_AGENT_UNSUPPORTED_DESCENDANT_EXECUTION') process.exit(3); for (const args of [['-e', 'process.exit(0)'], ['--eval=process.exit(0)'], ['--no-warnings'], ['--', '-'], ['--enable-source-maps'], ['--run=unsafe', ${JSON.stringify(childEntry)}], ['--env-file=unsafe.env', ${JSON.stringify(childEntry)}], ['--require=${childModule}', ${JSON.stringify(childEntry)}]]) { try { childProcess.spawnSync(process.execPath, args); process.exit(4); } catch (error) { if (error?.code !== 'RN_DEV_AGENT_UNSUPPORTED_DESCENDANT_EXECUTION') throw error; } } const child = childProcess.spawnSync(process.execPath, ['--conditions=react_native', '--no-warnings', ${JSON.stringify(childEntry)}, '-profile'], { env: childEnv }); if (child.status !== 0) process.exit(child.status || 1); try { childProcess.fork(${JSON.stringify(childEntry)}, [], { env: childEnv, execArgv: ['-e', 'process.exit(0)'] }); process.exit(7); } catch (error) { if (error?.code !== 'RN_DEV_AGENT_UNSUPPORTED_DESCENDANT_EXECUTION') throw error; } const forked = childProcess.fork(${JSON.stringify(childEntry)}, [], { env: childEnv, execArgv: ['--no-warnings'] }); if (forked.stdout !== null) process.exit(6); await new Promise((resolve, reject) => { forked.once('error', reject); forked.once('exit', (code) => code === 0 ? resolve() : reject(new Error('fork failed'))); }); const workerThreads = require('node:worker_threads'); for (const options of [{ eval: true }, { execArgv: ['--require', ${JSON.stringify(childModule)}] }]) { try { new workerThreads.Worker('void 0', options); process.exit(5); } catch (error) { if (error?.code !== 'RN_DEV_AGENT_UNSUPPORTED_DESCENDANT_EXECUTION') throw error; } } const worker = new workerThreads.Worker(${JSON.stringify(threadEntry)}, { execArgv: ['--no-warnings'] }); await new Promise((resolve, reject) => { worker.once('error', reject); worker.once('exit', (code) => code === 0 ? resolve() : reject(new Error('worker failed'))); }); require(${JSON.stringify(postWorkerModule)}); })().catch((error) => { console.error(error); process.exit(1); });`,
      ],
      {
        cwd: root,
        env: environment,
        encoding: 'utf8',
        stdio: [
          'pipe',
          'pipe',
          'pipe',
          'ignore',
          'ignore',
          'ignore',
          'ignore',
          'ignore',
          'ignore',
          evidenceDescriptor,
        ],
      },
    );

    assert.equal(result.status, 0, result.stderr);
    const observations = readFileSync(join(integration, 'metro-runtime-loads.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.ok(
      observations.some(
        (entry) =>
          entry.kind === 'input' &&
          entry.value === realpathSync(childModule) &&
          entry.digest === createHash('sha256').update(readFileSync(childModule)).digest('hex'),
      ),
    );
    assert.ok(
      observations.some(
        (entry) => entry.kind === 'input' && entry.value === realpathSync(threadModule),
      ),
    );
    assert.ok(
      observations.some(
        (entry) => entry.kind === 'input' && entry.value === realpathSync(postWorkerModule),
      ),
    );
    assert.ok(
      observations.some(
        (entry) =>
          entry.kind === 'semantics' &&
          entry.value.includes('"mode":"sync"') &&
          entry.value.includes('"--conditions=react_native"'),
      ),
    );
    assert.ok(
      observations.some(
        (entry) =>
          entry.kind === 'semantics' &&
          entry.value ===
            JSON.stringify({
              mode: 'metro',
              nodeOptions: ['--conditions=react_native'],
            }),
      ),
    );
    const launches = new Set(
      observations.filter((entry) => entry.kind === 'launch').map((entry) => entry.value),
    );
    const attestations = new Set(
      observations.filter((entry) => entry.kind === 'attestation').map((entry) => entry.value),
    );
    assert.equal(launches.size, 3);
    assert.deepEqual(launches, attestations);
  } finally {
    if (evidenceDescriptor !== undefined) closeSync(evidenceDescriptor);
    rmSync(root, { force: true, recursive: true });
    rmSync(external, { force: true, recursive: true });
  }
});

test('Metro descendant semantics bind arguments and Worker inputs', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-metro-invocation-semantics-'));
  let evidenceDescriptor: number | undefined;
  try {
    execFileSync('git', ['init', '-q', root]);
    const integration = join(root, '.rn-agent', 'integration');
    mkdirSync(integration, { recursive: true });
    const adapterPath = join(integration, 'rn-session-metro.cjs');
    const childEntry = join(root, 'child.cjs');
    const workerEntry = join(root, 'worker.cjs');
    const lifecycleEntry = join(root, 'lifecycle.cjs');
    const canonicalWorkerEntry = join(root, 'canonical-worker.cjs');
    const alternateWorkerEntry = join(root, 'alternate-worker.cjs');
    writeFileSync(adapterPath, renderMetroIntegrationAdapter());
    writeFileSync(
      childEntry,
      "if (process.send) process.once('message', () => process.disconnect());",
    );
    writeFileSync(
      workerEntry,
      "const { MessagePort, parentPort } = require('node:worker_threads'); parentPort.once('message', () => { MessagePort.prototype.postMessage.call(parentPort, { acknowledged: true }); parentPort.close(); });",
    );
    writeFileSync(lifecycleEntry, 'setInterval(() => {}, 1000);\n');
    writeFileSync(canonicalWorkerEntry, 'process.exit(0);\n');
    writeFileSync(alternateWorkerEntry, 'process.exit(17);\n');
    const environment = metroPolicyEnvironment(adapterPath);
    const runtimeLoads = join(integration, 'metro-runtime-loads.jsonl');
    evidenceDescriptor = openSync(runtimeLoads, 'a');
    environment.RN_DEV_AGENT_METRO_EVIDENCE_FD = '9';
    const result = spawnSync(
      process.execPath,
      [
        '-e',
        `(async () => { const compose = require(${JSON.stringify(adapterPath)}); compose({}); const childProcess = require('node:child_process'); const unsupported = (run) => { try { run(); throw new Error('unsupported execution was accepted'); } catch (error) { if (error.code !== 'RN_DEV_AGENT_UNSUPPORTED_DESCENDANT_EXECUTION') throw error; } }; unsupported(() => childProcess.execFile(process.execPath, [${JSON.stringify(childEntry)}])); unsupported(() => childProcess.spawn(process.execPath, [${JSON.stringify(childEntry)}], { stdio: ['ignore', 'pipe', 'pipe', 'pipe'] })); unsupported(() => childProcess.spawnSync(process.execPath, [${JSON.stringify(childEntry)}], { stdio: 'inherit' })); unsupported(() => childProcess.spawnSync(process.execPath, [${JSON.stringify(childEntry)}], { stdio: [0, 'pipe', 'pipe'] })); const inputChild = childProcess.spawnSync(process.execPath, [${JSON.stringify(childEntry)}], { input: 'authenticated' }); if (inputChild.status !== 0) process.exit(inputChild.status || 1); const ordinaryChild = childProcess.spawn(process.execPath, [${JSON.stringify(childEntry)}]); if (ordinaryChild.send !== undefined) throw new Error('non-IPC child exposed send'); await new Promise((resolve, reject) => { ordinaryChild.once('error', reject); ordinaryChild.once('exit', (code) => code === 0 ? resolve() : reject(new Error('spawn failed'))); }); for (const value of ['red', 'blue']) { let environmentReads = 0; const env = {}; Object.defineProperty(env, 'COLOR', { enumerable: true, get: () => { environmentReads += 1; return value; } }); const child = childProcess.spawnSync(process.execPath, [${JSON.stringify(childEntry)}, 'same'], { argv0: 'node-' + value, env, timeout: value === 'red' ? 1000 : 2000, windowsVerbatimArguments: false }); if (child.status !== 0 || environmentReads !== 1) process.exit(child.status || 1); } for (const color of ['red', 'blue']) { const child = childProcess.fork(${JSON.stringify(childEntry)}, [], { execArgv: ['--no-warnings'], serialization: color === 'red' ? 'json' : 'advanced' }); childProcess.ChildProcess.prototype.send.call(child, { color }); await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code) => code === 0 ? resolve() : reject(new Error('fork failed'))); }); } const workerThreads = require('node:worker_threads'); const { MessageChannel, Worker } = workerThreads; unsupported(() => new workerThreads.BroadcastChannel('unsupported')); if (typeof workerThreads.postMessageToThread === 'function') unsupported(() => workerThreads.postMessageToThread(1, { color: 'red' })); unsupported(() => workerThreads.setEnvironmentData('color', 'red')); const messageChannel = new MessageChannel(); unsupported(() => messageChannel.port1.postMessage({ color: 'red' })); messageChannel.port1.close(); messageChannel.port2.close(); unsupported(() => new Worker(${JSON.stringify(workerEntry)}, { execArgv: ['--no-warnings'], stdin: true })); const mutableWorkerUrl = require('node:url').pathToFileURL(${JSON.stringify(canonicalWorkerEntry)}); const mutableWorkerEnv = {}; Object.defineProperty(mutableWorkerEnv, 'COLOR', { enumerable: true, get: () => { mutableWorkerUrl.pathname = require('node:url').pathToFileURL(${JSON.stringify(alternateWorkerEntry)}).pathname; return 'canonical'; } }); const canonicalWorker = new Worker(mutableWorkerUrl, { env: mutableWorkerEnv, execArgv: ['--no-warnings'] }); await new Promise((resolve, reject) => { canonicalWorker.once('error', reject); canonicalWorker.once('exit', (code) => code === 0 ? resolve() : reject(new Error('mutable Worker entrypoint was used'))); }); for (const color of ['red', 'blue']) { const workerData = {}; Object.defineProperty(workerData, 'color', { enumerable: true, get: () => color }); let environmentReads = 0; const env = {}; Object.defineProperty(env, 'COLOR', { enumerable: true, get: () => { environmentReads += 1; return color; } }); const worker = new Worker(${JSON.stringify(workerEntry)}, { env, execArgv: ['--no-warnings'], workerData }); Worker.prototype.postMessage.call(worker, { color }); await new Promise((resolve, reject) => { worker.once('error', reject); worker.once('message', resolve); worker.once('exit', (code) => code === 0 ? resolve() : reject(new Error('worker failed'))); }); if (environmentReads !== 1) throw new Error('Worker environment was read more than once'); } const killedChild = childProcess.spawn(process.execPath, [${JSON.stringify(lifecycleEntry)}]); await new Promise((resolve, reject) => { killedChild.once('error', reject); killedChild.once('spawn', resolve); }); const killedExit = new Promise((resolve) => killedChild.once('exit', resolve)); killedChild.kill('SIGTERM'); await killedExit; const processKilledChild = childProcess.spawn(process.execPath, [${JSON.stringify(lifecycleEntry)}]); await new Promise((resolve, reject) => { processKilledChild.once('error', reject); processKilledChild.once('spawn', resolve); }); const processKilledExit = new Promise((resolve) => processKilledChild.once('exit', resolve)); process.kill(processKilledChild.pid, 'SIGTERM'); await processKilledExit; const terminatedWorker = new Worker(${JSON.stringify(lifecycleEntry)}, { execArgv: ['--no-warnings'] }); await new Promise((resolve, reject) => { terminatedWorker.once('error', reject); terminatedWorker.once('online', resolve); }); await terminatedWorker.terminate(); })().catch((error) => { console.error(error); process.exit(1); });`,
      ],
      {
        cwd: root,
        env: environment,
        encoding: 'utf8',
        stdio: [
          'pipe',
          'pipe',
          'pipe',
          'ignore',
          'ignore',
          'ignore',
          'ignore',
          'ignore',
          'ignore',
          evidenceDescriptor,
        ],
      },
    );

    assert.equal(result.status, 0, result.stderr);
    const semantics = readFileSync(runtimeLoads, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.kind === 'semantics')
      .map((entry) => JSON.parse(entry.value));
    const syncSemantics = semantics.filter((entry) => entry.mode === 'sync');
    const workerSemantics = semantics.filter((entry) => entry.mode === 'worker');
    const forkMessageSemantics = semantics.filter((entry) => entry.mode === 'fork-message');
    const workerMessageSemantics = semantics.filter((entry) => entry.mode === 'worker-message');
    assert.equal(syncSemantics.length, 3);
    assert.equal(workerSemantics.length, 4, JSON.stringify(semantics));
    assert.equal(forkMessageSemantics.length, 2);
    assert.equal(workerMessageSemantics.length, 4);
    assert.equal(new Set(forkMessageSemantics.map((entry) => entry.recipient)).size, 2);
    assert.equal(new Set(workerMessageSemantics.map((entry) => entry.recipient)).size, 4);
    assert.ok(
      [...forkMessageSemantics, ...workerMessageSemantics].every(
        (entry) => entry.sequence === 1,
      ),
    );
    assert.notEqual(syncSemantics[0].invocationDigest, syncSemantics[1].invocationDigest);
    assert.notEqual(workerSemantics[0].invocationDigest, workerSemantics[1].invocationDigest);
    const lifecycleSemantics = semantics.filter((entry) =>
      ['child-lifecycle', 'worker-lifecycle'].includes(entry.mode),
    );
    assert.deepEqual(
      lifecycleSemantics.map((entry) => entry.mode),
      [
        'child-lifecycle',
        'child-lifecycle',
        'child-lifecycle',
        'child-lifecycle',
        'worker-lifecycle',
      ],
    );
  } finally {
    if (evidenceDescriptor !== undefined) closeSync(evidenceDescriptor);
    rmSync(root, { force: true, recursive: true });
  }
});

test('Metro preload linearizes evidence head barriers through the owner pipe', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-metro-barrier-'));
  try {
    const integration = join(root, '.rn-agent', 'integration');
    mkdirSync(integration, { recursive: true });
    const adapterPath = join(integration, 'rn-session-metro.cjs');
    const childEntry = join(root, 'child.cjs');
    writeFileSync(adapterPath, renderMetroIntegrationAdapter());
    writeFileSync(childEntry, "process.send?.('ready'); setInterval(() => {}, 1000);\n");
    const challenge = 'ab'.repeat(32);
    const environment = metroPolicyEnvironment(adapterPath);
    environment.RN_DEV_AGENT_METRO_EVIDENCE_FD = '9';
    const child = fork(childEntry, [], {
      env: environment,
      execArgv: ['--require', adapterPath],
      silent: true,
      stdio: [
        'ignore',
        'pipe',
        'pipe',
        'ipc',
        'ignore',
        'ignore',
        'ignore',
        'ignore',
        'ignore',
        'pipe',
      ],
    });
    const evidence = child.stdio[9]!;
    evidence.setEncoding('utf8');
    let childStderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk) => {
      childStderr += chunk;
    });
    const observed = new Promise<string>((resolve, reject) => {
      let buffered = '';
      evidence.on('data', (chunk) => {
        buffered += chunk;
        let newline;
        while ((newline = buffered.indexOf('\n')) >= 0) {
          const line = buffered.slice(0, newline);
          buffered = buffered.slice(newline + 1);
          if (line && JSON.parse(line).kind === 'barrier') resolve(line);
        }
      });
      child.once('error', reject);
    });
    await new Promise<void>((resolve, reject) => {
      child.once('message', (message) => {
        if (message === 'ready') resolve();
      });
      child.once('exit', (code) => {
        reject(new Error(`barrier fixture exited ${code}: ${childStderr}`));
      });
    });
    child.send({ type: 'rn-dev-agent:evidence-barrier', challenge });
    const payload = JSON.parse(await observed);
    assert.equal(payload.kind, 'barrier');
    assert.equal(payload.value, challenge);
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill();
    await exited;
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('Metro preload ignores caught optional module misses', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-metro-optional-module-'));
  try {
    execFileSync('git', ['init', '-q', root]);
    const integration = join(root, '.rn-agent', 'integration');
    mkdirSync(integration, { recursive: true });
    const adapterPath = join(integration, 'rn-session-metro.cjs');
    writeFileSync(adapterPath, renderMetroIntegrationAdapter());
    const result = spawnSync(
      process.execPath,
      [
        '-e',
        `const compose = require(${JSON.stringify(adapterPath)}); compose({}); try { require('absent-optional-package'); } catch {}`,
      ],
      {
        cwd: root,
        env: metroPolicyEnvironment(adapterPath),
        encoding: 'utf8',
      },
    );

    assert.equal(result.status, 0, result.stderr);
    const observations = readFileSync(join(integration, 'metro-runtime-loads.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.equal(
      observations.some(
        (entry) => entry.kind === 'violation' && entry.value.includes('module resolution failed'),
      ),
      false,
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('Metro preload rejects native addons from strict proof', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-metro-native-addon-'));
  try {
    execFileSync('git', ['init', '-q', root]);
    const integration = join(root, '.rn-agent', 'integration');
    mkdirSync(integration, { recursive: true });
    const adapterPath = join(integration, 'rn-session-metro.cjs');
    const addonPath = join(root, 'fixture.node');
    writeFileSync(adapterPath, renderMetroIntegrationAdapter());
    writeFileSync(addonPath, 'fixture native addon bytes');
    const env = metroPolicyEnvironment(adapterPath);
    env.NODE_OPTIONS = '';
    const result = spawnSync(
      process.execPath,
      [
        '--experimental-addon-modules',
        '-e',
        `const moduleApi = require('node:module'); const addonUrl = ${JSON.stringify(pathToFileURL(addonPath).href)}; moduleApi.registerHooks({ load(url, context, nextLoad) { if (url === addonUrl) return { format: 'addon', source: null, shortCircuit: true }; return nextLoad(url, context); } }); const compose = require(${JSON.stringify(adapterPath)}); compose({}); import(addonUrl).catch(() => {});`,
      ],
      {
        cwd: root,
        env,
        encoding: 'utf8',
      },
    );

    assert.equal(result.status, 0, result.stderr);
    const observations = readFileSync(join(integration, 'metro-runtime-loads.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.ok(
      observations.some(
        (entry) =>
          entry.kind === 'violation' &&
          entry.value.includes('native addons are unsupported for strict proof'),
      ),
    );
    assert.equal(
      observations.some(
        (entry) => entry.kind === 'input' && entry.value === realpathSync(addonPath),
      ),
      false,
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('Metro preload fences direct native addon loading', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-metro-direct-native-addon-'));
  try {
    execFileSync('git', ['init', '-q', root]);
    const integration = join(root, '.rn-agent', 'integration');
    mkdirSync(integration, { recursive: true });
    const adapterPath = join(integration, 'rn-session-metro.cjs');
    const addonPath = join(root, 'fixture.node');
    writeFileSync(adapterPath, renderMetroIntegrationAdapter());
    writeFileSync(addonPath, 'fixture native addon bytes');
    const result = spawnSync(
      process.execPath,
      [
        '-e',
        `const compose = require(${JSON.stringify(adapterPath)}); compose({}); const guardedDlopen = process.dlopen; let error; try { process.dlopen({}, ${JSON.stringify(addonPath)}); } catch (caught) { error = caught; } if (error?.code !== 'RN_DEV_AGENT_UNSUPPORTED_NATIVE_ADDON') process.exit(1); try { process.dlopen = () => {}; } catch {} if (process.dlopen !== guardedDlopen || require('node:process').dlopen !== guardedDlopen) process.exit(2);`,
      ],
      {
        cwd: root,
        env: metroPolicyEnvironment(adapterPath),
        encoding: 'utf8',
      },
    );

    assert.equal(result.status, 0, result.stderr);
    const observations = readFileSync(join(integration, 'metro-runtime-loads.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.ok(
      observations.some(
        (entry) =>
          entry.kind === 'violation' &&
          entry.value.includes('native addons are unsupported for strict proof'),
      ),
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('Metro preload rejects later module hook registration', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-metro-late-hook-'));
  try {
    execFileSync('git', ['init', '-q', root]);
    const integration = join(root, '.rn-agent', 'integration');
    mkdirSync(integration, { recursive: true });
    const adapterPath = join(integration, 'rn-session-metro.cjs');
    writeFileSync(adapterPath, renderMetroIntegrationAdapter());
    const result = spawnSync(
      process.execPath,
      [
        '-e',
        `const compose = require(${JSON.stringify(adapterPath)}); compose({}); const moduleApi = require('node:module'); for (const method of ['registerHooks', 'register']) { try { moduleApi[method]({ load(url, context, nextLoad) { return nextLoad(url, context); } }); throw new Error('hook registration unexpectedly succeeded'); } catch (error) { if (error.message !== 'RN_DEV_AGENT_UNSUPPORTED_MODULE_HOOK') throw error; } }`,
      ],
      {
        cwd: root,
        env: metroPolicyEnvironment(adapterPath),
        encoding: 'utf8',
      },
    );

    assert.equal(result.status, 0, result.stderr);
    const observations = readFileSync(join(integration, 'metro-runtime-loads.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.ok(
      observations.some(
        (entry) =>
          entry.kind === 'violation' &&
          entry.value.includes('additional Metro runtime loader hooks'),
      ),
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('Metro integration refreshes policy after executable callbacks', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-metro-callback-'));
  const external = mkdtempSync(join(tmpdir(), 'rn-session-metro-callback-module-'));
  try {
    execFileSync('git', ['init', '-q', root]);
    const integration = join(root, '.rn-agent', 'integration');
    mkdirSync(integration, { recursive: true });
    const adapterPath = join(integration, 'rn-session-metro.cjs');
    const callbackModule = join(external, 'callback.cjs');
    writeFileSync(adapterPath, renderMetroIntegrationAdapter());
    writeFileSync(callbackModule, 'module.exports = {};\n');
    const result = spawnSync(
      process.execPath,
      [
        '-e',
        `const compose = require(${JSON.stringify(adapterPath)}); const config = compose({ transformer: { async getTransformOptions() { require(${JSON.stringify(callbackModule)}); return {}; } } }); config.transformer.getTransformOptions();`,
      ],
      {
        cwd: root,
        env: metroPolicyEnvironment(adapterPath),
        encoding: 'utf8',
      },
    );

    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(
      readFileSync(join(integration, 'metro-runtime-policy.json'), 'utf8'),
    );
    assert.ok(receipt.runtimeInputs.includes(realpathSync(callbackModule)));
  } finally {
    rmSync(root, { force: true, recursive: true });
    rmSync(external, { force: true, recursive: true });
  }
});

test('Metro integration records ESM loader evidence when a callback rejects', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-metro-rejected-callback-'));
  const external = mkdtempSync(join(tmpdir(), 'rn-session-metro-esm-input-'));
  try {
    execFileSync('git', ['init', '-q', root]);
    const integration = join(root, '.rn-agent', 'integration');
    mkdirSync(integration, { recursive: true });
    const adapterPath = join(integration, 'rn-session-metro.cjs');
    const callbackModule = join(external, 'callback.mjs');
    writeFileSync(adapterPath, renderMetroIntegrationAdapter());
    writeFileSync(callbackModule, 'export default {};\n');
    const result = spawnSync(
      process.execPath,
      [
        '-e',
        `const compose = require(${JSON.stringify(adapterPath)}); let first = true; const config = compose({ transformer: { async getTransformOptions() { await import(${JSON.stringify(pathToFileURL(callbackModule).href)}); if (first) { first = false; throw new Error('expected'); } return {}; } } }); (async () => { try { await config.transformer.getTransformOptions(); } catch (error) { if (error.message !== 'expected') throw error; } await config.transformer.getTransformOptions(); })().catch((error) => { console.error(error); process.exitCode = 1; });`,
      ],
      {
        cwd: root,
        env: metroPolicyEnvironment(adapterPath),
        encoding: 'utf8',
      },
    );

    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(
      readFileSync(join(integration, 'metro-runtime-policy.json'), 'utf8'),
    );
    assert.ok(receipt.runtimeInputs.includes(realpathSync(callbackModule)));
  } finally {
    rmSync(root, { force: true, recursive: true });
    rmSync(external, { force: true, recursive: true });
  }
});

test('Metro integration accumulates callback evidence monotonically', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-metro-callback-evidence-'));
  const external = mkdtempSync(join(tmpdir(), 'rn-session-metro-callback-inputs-'));
  try {
    execFileSync('git', ['init', '-q', root]);
    const integration = join(root, '.rn-agent', 'integration');
    mkdirSync(integration, { recursive: true });
    const adapterPath = join(integration, 'rn-session-metro.cjs');
    const polyfill = join(external, 'polyfill.cjs');
    const beforeMain = join(external, 'before-main.cjs');
    const laterCallbackModule = join(external, 'later.cjs');
    writeFileSync(adapterPath, renderMetroIntegrationAdapter());
    writeFileSync(join(integration, 'authority-marker.js'), '');
    writeFileSync(polyfill, '');
    writeFileSync(beforeMain, '');
    writeFileSync(laterCallbackModule, '');
    const result = spawnSync(
      process.execPath,
      [
        '-e',
        `const compose = require(${JSON.stringify(adapterPath)}); const config = compose({ serializer: { getPolyfills() { return [${JSON.stringify(polyfill)}]; }, getModulesRunBeforeMainModule() { return [${JSON.stringify(beforeMain)}]; } }, transformer: { async getTransformOptions() { require(${JSON.stringify(laterCallbackModule)}); return {}; } } }); config.serializer.getPolyfills({}); config.serializer.getModulesRunBeforeMainModule('index.js'); config.transformer.getTransformOptions();`,
      ],
      {
        cwd: root,
        env: metroPolicyEnvironment(adapterPath),
        encoding: 'utf8',
      },
    );

    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(
      readFileSync(join(integration, 'metro-runtime-policy.json'), 'utf8'),
    );
    assert.ok(receipt.runtimeInputs.includes(realpathSync(polyfill)));
    assert.ok(receipt.runtimeInputs.includes(realpathSync(beforeMain)));
    assert.ok(receipt.runtimeInputs.includes(realpathSync(laterCallbackModule)));
    assert.ok(
      receipt.violations.some((entry: string) => entry.includes('Metro callback runtime input')),
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
    rmSync(external, { force: true, recursive: true });
  }
});

test('Metro integration refreshes every supported serializer callback', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-metro-serializer-callbacks-'));
  const external = mkdtempSync(join(tmpdir(), 'rn-session-metro-serializer-modules-'));
  try {
    execFileSync('git', ['init', '-q', root]);
    const integration = join(root, '.rn-agent', 'integration');
    mkdirSync(integration, { recursive: true });
    const adapterPath = join(integration, 'rn-session-metro.cjs');
    const modules = ['factory', 'module-id', 'filter', 'run', 'third-party'].map((name) =>
      join(external, `${name}.cjs`),
    );
    writeFileSync(adapterPath, renderMetroIntegrationAdapter());
    modules.forEach((entry) => writeFileSync(entry, 'module.exports = {};\n'));
    const result = spawnSync(
      process.execPath,
      [
        '-e',
        `const compose = require(${JSON.stringify(adapterPath)}); const paths = ${JSON.stringify(modules)}; const config = compose({ serializer: { createModuleIdFactory() { require(paths[0]); return () => { require(paths[1]); return 1; }; }, processModuleFilter() { require(paths[2]); return true; }, getRunModuleStatement() { require(paths[3]); return ''; }, isThirdPartyModule() { require(paths[4]); return false; } } }); const moduleId = config.serializer.createModuleIdFactory(); moduleId('entry.js'); config.serializer.processModuleFilter({}); config.serializer.getRunModuleStatement(1, ''); config.serializer.isThirdPartyModule({ path: 'entry.js' });`,
      ],
      {
        cwd: root,
        env: metroPolicyEnvironment(adapterPath),
        encoding: 'utf8',
      },
    );

    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(
      readFileSync(join(integration, 'metro-runtime-policy.json'), 'utf8'),
    );
    modules.forEach((entry) => assert.ok(receipt.runtimeInputs.includes(realpathSync(entry))));
  } finally {
    rmSync(root, { force: true, recursive: true });
    rmSync(external, { force: true, recursive: true });
  }
});

test('Metro callback refresh uses a constant-time loader epoch', () => {
  const adapter = renderMetroIntegrationAdapter();
  assert.equal(adapter.match(/Object\.keys\(require\.cache\)/g)?.length, 1);
  assert.match(adapter, /loaderEpochBefore/);
});

test('Metro integration preserves non-Git development configs', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-metro-non-git-'));
  try {
    const adapterPath = join(root, 'rn-session-metro.cjs');
    writeFileSync(adapterPath, renderMetroIntegrationAdapter());
    const result = spawnSync(
      process.execPath,
      [
        '-e',
        `const compose = require(${JSON.stringify(adapterPath)}); compose({ resolver: { resolveRequest() {} } });`,
      ],
      { cwd: root, encoding: 'utf8' },
    );

    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('Metro restoration preserves edits after the generated block', () => {
  const original = 'module.exports = { resolver: {} };\n';
  const integrated = previewMetroIntegration(original);
  const withSuffix = `${integrated}module.exports.watchFolders = ['/later'];\n`;

  assert.equal(
    restoreMetroIntegration(withSuffix),
    `${original}module.exports.watchFolders = ['/later'];\n`,
  );
});

test('integration preview refuses shell operators and unknown session-aware commands', () => {
  assert.throws(
    () =>
      previewPackageIntegration({
        scripts: { ios: 'FOO=bar expo run:ios && echo done', android: 'expo run:android' },
      }),
    /SESSION_BUILD_COMMAND_UNSUPPORTED/,
  );
  assert.throws(
    () =>
      previewPackageIntegration({
        scripts: { ios: 'custom-ios-build', android: 'expo run:android' },
      }),
    /SESSION_BUILD_COMMAND_UNSUPPORTED/,
  );
});

test('copied adapter remains a transparent passthrough without the plugin or a session', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-adapter-'));
  try {
    const integrationRoot = join(root, '.rn-agent', 'integration');
    const adapterPath = join(integrationRoot, 'rn-session-adapter.cjs');
    const manifestPath = join(integrationRoot, 'rn-session-integration.json');
    const recorderPath = join(root, 'record.cjs');
    const outputPath = join(root, 'record.json');
    mkdirSync(integrationRoot, { recursive: true });
    writeFileSync(adapterPath, renderProjectAdapter(), { mode: 0o755 });
    writeFileSync(
      manifestPath,
      JSON.stringify({
        version: 1,
        adapter: '.rn-agent/integration/rn-session-adapter.cjs',
        originalScripts: {
          ios: [process.execPath, recorderPath, 'original'],
          android: [process.execPath, recorderPath, 'original'],
        },
      }),
    );
    writeFileSync(
      recorderPath,
      "require('node:fs').writeFileSync(process.env.ADAPTER_RECORD,JSON.stringify({args:process.argv.slice(2),port:process.env.RCT_METRO_PORT??null}))",
    );

    const result = spawnSync(process.execPath, [adapterPath, 'ios', 'user-arg'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, ADAPTER_RECORD: outputPath },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(outputPath, 'utf8')), {
      args: ['original', 'user-arg'],
      port: null,
    });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('plugin-absent passthrough preserves bare RN iOS and Android argv', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-bare-passthrough-'));
  try {
    const integrationRoot = join(root, '.rn-agent', 'integration');
    const adapterPath = join(integrationRoot, 'rn-session-adapter.cjs');
    const recorderPath = join(root, 'record.cjs');
    mkdirSync(integrationRoot, { recursive: true });
    writeFileSync(adapterPath, renderProjectAdapter(), { mode: 0o755 });
    writeFileSync(
      join(integrationRoot, 'rn-session-integration.json'),
      JSON.stringify({
        version: 1,
        adapter: '.rn-agent/integration/rn-session-adapter.cjs',
        originalScripts: {
          ios: [process.execPath, recorderPath, 'npx', 'react-native', 'run-ios'],
          android: [process.execPath, recorderPath, 'npx', 'react-native', 'run-android'],
        },
      }),
    );
    writeFileSync(
      recorderPath,
      "require('node:fs').appendFileSync(process.env.ADAPTER_RECORD,JSON.stringify(process.argv.slice(2))+'\\n')",
    );
    const outputPath = join(root, 'record.jsonl');
    for (const platform of ['ios', 'android']) {
      const result = spawnSync(process.execPath, [adapterPath, platform, '--user-flag'], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, ADAPTER_RECORD: outputPath },
      });
      assert.equal(result.status, 0, result.stderr);
    }
    const calls = readFileSync(outputPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.deepEqual(calls, [
      ['npx', 'react-native', 'run-ios', '--user-flag'],
      ['npx', 'react-native', 'run-android', '--user-flag'],
    ]);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('confirmed integration writes package and Metro sentinels together', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-apply-'));
  try {
    writeFileSync(join(root, 'package.json'), `${JSON.stringify(packageJson)}\n`);
    writeFileSync(join(root, 'metro.config.js'), 'module.exports = { serializer: {} };\n');
    const sessionCli = join(root, 'rn-session.js');
    writeFileSync(sessionCli, '');

    const applied = applyPackageIntegration({ appRoot: root, sessionCli });

    assert.equal(
      applied.packageJson.scripts.ios,
      'node .rn-agent/integration/rn-session-adapter.cjs ios',
    );
    assert.match(
      readFileSync(join(root, 'metro.config.js'), 'utf8'),
      /rn-dev-agent session integration/,
    );
    assert.match(
      readFileSync(join(root, '.rn-agent/integration/authority-marker.js'), 'utf8'),
      /status:'unavailable'/,
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('confirmed integration rejects a symlinked .rn-agent ancestor before writing', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-apply-symlink-'));
  const external = mkdtempSync(join(tmpdir(), 'rn-session-integration-external-'));
  try {
    writeFileSync(join(root, 'package.json'), `${JSON.stringify(packageJson)}\n`);
    writeFileSync(join(root, 'metro.config.js'), 'module.exports = { serializer: {} };\n');
    symlinkSync(external, join(root, '.rn-agent'));

    assert.throws(
      () => applyPackageIntegration({ appRoot: root, sessionCli: join(root, 'rn-session.js') }),
      /SESSION_INTEGRATION_PATH_UNSAFE/,
    );
    assert.equal(existsSync(join(external, 'integration')), false);
  } finally {
    rmSync(root, { force: true, recursive: true });
    rmSync(external, { force: true, recursive: true });
  }
});

test('confirmed integration never mutates through a replaced integration ancestor', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-apply-swap-'));
  try {
    const packagePath = join(root, 'package.json');
    const metroPath = join(root, 'metro.config.js');
    const packageBefore = `${JSON.stringify(packageJson)}\n`;
    const metroBefore = 'module.exports = { serializer: {} };\n';
    writeFileSync(packagePath, packageBefore);
    writeFileSync(metroPath, metroBefore);

    assert.throws(
      () =>
        applyPackageIntegration(
          { appRoot: root, sessionCli: join(root, 'rn-session.js') },
          {
            beforeCommit: () => {
              renameSync(
                join(root, '.rn-agent', 'integration'),
                join(root, '.rn-agent', 'integration-original'),
              );
              mkdirSync(join(root, '.rn-agent', 'integration'));
            },
          },
        ),
      /SESSION_INTEGRATION_PATH_UNSAFE/,
    );
    assert.deepEqual(readdirSync(join(root, '.rn-agent', 'integration')), []);
    assert.equal(readFileSync(packagePath, 'utf8'), packageBefore);
    assert.equal(readFileSync(metroPath, 'utf8'), metroBefore);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('signed marker writes retain the bound integration directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-marker-swap-'));
  const integrationPath = join(root, '.rn-agent', 'integration');
  mkdirSync(integrationPath, { recursive: true });
  const markerPath = join(integrationPath, 'authority-marker.js');
  writeFileSync(markerPath, 'before\n');
  const directory = openBoundDirectory(integrationPath);
  try {
    assert.throws(
      () =>
        writeBoundDirectoryFile(directory, 'authority-marker.js', Buffer.from('after\n'), 0o600, {
          beforeCommit: () => {
            renameSync(integrationPath, join(root, '.rn-agent', 'integration-original'));
            mkdirSync(integrationPath);
          },
        }),
      /SESSION_INTEGRATION_PATH_UNSAFE/,
    );
    assert.deepEqual(readdirSync(integrationPath), []);
    assert.equal(
      readFileSync(join(root, '.rn-agent', 'integration-original', 'authority-marker.js'), 'utf8'),
      'before\n',
    );
  } finally {
    closeBoundDirectory(directory);
    rmSync(root, { force: true, recursive: true });
  }
});

test('bound subdirectories reject a symlink back to the retained ancestor', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-bound-root-'));
  const externalRoot = mkdtempSync(join(tmpdir(), 'rn-session-bound-root-external-'));
  const external = join(externalRoot, 'agent');
  const agentPath = join(root, '.rn-agent');
  const integrationPath = join(agentPath, 'integration');
  mkdirSync(integrationPath, { recursive: true });
  const markerPath = join(integrationPath, 'authority-marker.js');
  writeFileSync(markerPath, 'before\n');
  const agent = openBoundDirectory(agentPath);
  const integration = openBoundSubdirectory(agent, 'integration');
  try {
    assert.throws(
      () =>
        writeBoundDirectoryFile(integration, 'authority-marker.js', Buffer.from('after\n'), 0o600, {
          beforeCommit: () => {
            renameSync(agentPath, external);
            symlinkSync(external, agentPath, 'dir');
          },
        }),
      /SESSION_INTEGRATION_PATH_UNSAFE/,
    );
    assert.equal(
      readFileSync(join(external, 'integration', 'authority-marker.js'), 'utf8'),
      'before\n',
    );
  } finally {
    closeBoundDirectory(integration);
    closeBoundDirectory(agent);
    rmSync(root, { force: true, recursive: true });
    rmSync(externalRoot, { force: true, recursive: true });
  }
});

test('bound CAS rolls back an ancestor switched and restored during mutation', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-bound-switch-'));
  const externalRoot = mkdtempSync(join(tmpdir(), 'rn-session-bound-switch-external-'));
  const agentPath = join(root, '.rn-agent');
  const external = join(externalRoot, 'agent');
  const unrelatedPath = join(root, 'unrelated-root');
  const integrationPath = join(agentPath, 'integration');
  const markerPath = join(integrationPath, 'authority-marker.js');
  mkdirSync(integrationPath, { recursive: true });
  writeFileSync(markerPath, 'before\n', { mode: 0o600 });
  const agent = openBoundDirectory(agentPath);
  const integration = openBoundSubdirectory(agent, 'integration');
  try {
    const switcher = spawn(
      process.execPath,
      [
        '-e',
        `const fs=require('node:fs');setTimeout(()=>{fs.writeFileSync(${JSON.stringify(
          unrelatedPath,
        )},'noise');fs.renameSync(${JSON.stringify(
          agentPath,
        )},${JSON.stringify(external)});fs.symlinkSync(${JSON.stringify(external)},${JSON.stringify(
          agentPath,
        )},'dir');fs.unlinkSync(${JSON.stringify(
          agentPath,
        )});fs.renameSync(${JSON.stringify(external)},${JSON.stringify(agentPath)})},100)`,
      ],
      { stdio: 'ignore' },
    );
    switcher.unref();
    assert.throws(
      () =>
        casBoundDirectoryFiles(
          integration,
          [
            {
              expected: Buffer.from('before\n'),
              mode: 0o600,
              name: 'authority-marker.js',
              replacement: Buffer.from('after\n'),
            },
          ],
          { afterCaptureDelayMs: 1_000 },
        ),
      /SESSION_INTEGRATION_PATH_UNSAFE/,
    );
    assert.equal(readFileSync(markerPath, 'utf8'), 'before\n');
  } finally {
    closeBoundDirectory(integration);
    closeBoundDirectory(agent);
    rmSync(root, { force: true, recursive: true });
    rmSync(externalRoot, { force: true, recursive: true });
  }
});

test('bound CAS rejects a restored integration-directory switch', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-bound-integration-switch-'));
  const externalRoot = mkdtempSync(join(tmpdir(), 'rn-session-bound-integration-switch-external-'));
  const agentPath = join(root, '.rn-agent');
  const integrationPath = join(agentPath, 'integration');
  const external = join(externalRoot, 'integration');
  const markerPath = join(integrationPath, 'authority-marker.js');
  mkdirSync(integrationPath, { recursive: true });
  writeFileSync(markerPath, 'before\n', { mode: 0o600 });
  const agent = openBoundDirectory(agentPath);
  const integration = openBoundSubdirectory(agent, 'integration');
  try {
    const switcher = spawn(
      process.execPath,
      [
        '-e',
        `const fs=require('node:fs');setTimeout(()=>{fs.renameSync(${JSON.stringify(
          integrationPath,
        )},${JSON.stringify(external)});fs.symlinkSync(${JSON.stringify(external)},${JSON.stringify(
          integrationPath,
        )},'dir');fs.writeFileSync(${JSON.stringify(
          join(external, 'swap-noise'),
        )},'noise');fs.unlinkSync(${JSON.stringify(
          join(external, 'swap-noise'),
        )});fs.unlinkSync(${JSON.stringify(
          integrationPath,
        )});fs.renameSync(${JSON.stringify(external)},${JSON.stringify(integrationPath)})},100)`,
      ],
      { stdio: 'ignore' },
    );
    switcher.unref();
    assert.throws(
      () =>
        casBoundDirectoryFiles(
          integration,
          [
            {
              expected: Buffer.from('before\n'),
              mode: 0o600,
              name: 'authority-marker.js',
              replacement: Buffer.from('after\n'),
            },
          ],
          { afterCaptureDelayMs: 1_000 },
        ),
      /SESSION_INTEGRATION_PATH_UNSAFE/,
    );
    assert.equal(readFileSync(markerPath, 'utf8'), 'before\n');
  } finally {
    closeBoundDirectory(integration);
    closeBoundDirectory(agent);
    rmSync(root, { force: true, recursive: true });
    rmSync(externalRoot, { force: true, recursive: true });
  }
});

test('bound CAS rejects an external switch during transaction mutation', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-bound-observed-switch-'));
  const externalRoot = mkdtempSync(join(tmpdir(), 'rn-session-bound-observed-switch-external-'));
  const agentPath = join(root, '.rn-agent');
  const integrationPath = join(agentPath, 'integration');
  const external = join(externalRoot, 'integration');
  const readyPath = join(externalRoot, 'ready');
  const markerPath = join(integrationPath, 'authority-marker.js');
  mkdirSync(integrationPath, { recursive: true });
  writeFileSync(markerPath, 'before\n', { mode: 0o600 });
  const agent = openBoundDirectory(agentPath);
  const integration = openBoundSubdirectory(agent, 'integration');
  try {
    const switcher = spawn(
      process.execPath,
      [
        '-e',
        `const fs=require('node:fs');const integration=${JSON.stringify(
          integrationPath,
        )};const external=${JSON.stringify(external)};let switched=false;const watcher=fs.watch(integration,(event,name)=>{if(switched||!name||!String(name).startsWith('.rn-bound-'))return;switched=true;fs.renameSync(integration,external);fs.symlinkSync(external,integration,'dir');fs.unlinkSync(integration);fs.renameSync(external,integration);watcher.close()});fs.writeFileSync(${JSON.stringify(
          readyPath,
        )},'ready');setTimeout(()=>process.exit(0),5000)`,
      ],
      { stdio: 'ignore' },
    );
    switcher.unref();
    const waitState = new Int32Array(new SharedArrayBuffer(4));
    const readyDeadline = Date.now() + 5_000;
    while (!existsSync(readyPath) && Date.now() < readyDeadline) {
      Atomics.wait(waitState, 0, 0, 10);
    }
    assert.equal(existsSync(readyPath), true);
    assert.throws(
      () =>
        casBoundDirectoryFiles(
          integration,
          [
            {
              expected: Buffer.from('before\n'),
              mode: 0o600,
              name: 'authority-marker.js',
              replacement: Buffer.from('after\n'),
            },
          ],
          { afterCaptureDelayMs: 1_000 },
        ),
      /SESSION_INTEGRATION_PATH_UNSAFE/,
    );
    assert.equal(readFileSync(markerPath, 'utf8'), 'before\n');
  } finally {
    closeBoundDirectory(integration);
    closeBoundDirectory(agent);
    rmSync(root, { force: true, recursive: true });
    rmSync(externalRoot, { force: true, recursive: true });
  }
});

test('bound CAS retains cleanup after a late integration-directory switch', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-bound-late-switch-'));
  const externalRoot = mkdtempSync(join(tmpdir(), 'rn-session-bound-late-switch-external-'));
  const agentPath = join(root, '.rn-agent');
  const integrationPath = join(agentPath, 'integration');
  const external = join(externalRoot, 'integration');
  const markerPath = join(integrationPath, 'authority-marker.js');
  mkdirSync(integrationPath, { recursive: true });
  writeFileSync(markerPath, 'before\n', { mode: 0o600 });
  const agent = openBoundDirectory(agentPath);
  const integration = openBoundSubdirectory(agent, 'integration');
  try {
    const switcher = spawn(
      process.execPath,
      [
        '-e',
        `const fs=require('node:fs');setTimeout(()=>{fs.renameSync(${JSON.stringify(
          integrationPath,
        )},${JSON.stringify(external)});fs.symlinkSync(${JSON.stringify(external)},${JSON.stringify(
          integrationPath,
        )},'dir');fs.unlinkSync(${JSON.stringify(
          integrationPath,
        )});fs.renameSync(${JSON.stringify(external)},${JSON.stringify(integrationPath)})},100)`,
      ],
      { stdio: 'ignore' },
    );
    switcher.unref();
    const result = casBoundDirectoryFiles(
      integration,
      [
        {
          expected: Buffer.from('before\n'),
          mode: 0o600,
          name: 'authority-marker.js',
          replacement: Buffer.from('after\n'),
        },
      ],
      { afterLockReleaseDelayMs: 1_000 },
    );
    assert.equal(result.committed, true);
    assert.equal(result.cleanupPending, true);
    assert.match(result.cleanupError ?? '', /ancestor changed/);
    assert.match(result.cleanupObligation?.transactionId ?? '', /^[0-9a-f-]{36}$/);
    assert.equal(readFileSync(markerPath, 'utf8'), 'after\n');
    assert.equal(
      integration.pendingCleanups.has(result.cleanupObligation?.transactionId ?? ''),
      true,
    );
  } finally {
    closeBoundDirectory(integration);
    closeBoundDirectory(agent);
    rmSync(root, { force: true, recursive: true });
    rmSync(externalRoot, { force: true, recursive: true });
  }
});

test('bound CAS fails closed on unrelated ancestor-directory churn', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-bound-unrelated-churn-'));
  const agentPath = join(root, '.rn-agent');
  const integrationPath = join(agentPath, 'integration');
  const markerPath = join(integrationPath, 'authority-marker.js');
  const rootChurnPath = join(root, 'unrelated-root');
  const agentChurnPath = join(agentPath, 'unrelated-agent');
  mkdirSync(integrationPath, { recursive: true });
  writeFileSync(markerPath, 'before\n', { mode: 0o600 });
  const agent = openBoundDirectory(agentPath);
  const integration = openBoundSubdirectory(agent, 'integration');
  try {
    const churn = spawn(
      process.execPath,
      [
        '-e',
        `const fs=require('node:fs');setTimeout(()=>{fs.writeFileSync(${JSON.stringify(
          rootChurnPath,
        )},'root');fs.writeFileSync(${JSON.stringify(
          agentChurnPath,
        )},'agent');setTimeout(()=>{fs.unlinkSync(${JSON.stringify(
          rootChurnPath,
        )});fs.unlinkSync(${JSON.stringify(agentChurnPath)})},100)},100)`,
      ],
      { stdio: 'ignore' },
    );
    churn.unref();
    assert.throws(
      () =>
        casBoundDirectoryFiles(
          integration,
          [
            {
              expected: Buffer.from('before\n'),
              mode: 0o600,
              name: 'authority-marker.js',
              replacement: Buffer.from('after\n'),
            },
          ],
          { afterCaptureDelayMs: 1_000 },
        ),
      /SESSION_INTEGRATION_PATH_UNSAFE/,
    );
    assert.equal(readFileSync(markerPath, 'utf8'), 'before\n');
  } finally {
    closeBoundDirectory(integration);
    closeBoundDirectory(agent);
    rmSync(root, { force: true, recursive: true });
  }
});

test('bound recovery retains cleanup after a transient ancestor switch', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-bound-recovery-switch-'));
  const externalRoot = mkdtempSync(join(tmpdir(), 'rn-session-bound-recovery-switch-external-'));
  const agentPath = join(root, '.rn-agent');
  const external = join(externalRoot, 'agent');
  const integrationPath = join(agentPath, 'integration');
  const markerPath = join(integrationPath, 'authority-marker.js');
  mkdirSync(integrationPath, { recursive: true });
  writeFileSync(markerPath, 'before\n', { mode: 0o600 });
  const agent = openBoundDirectory(agentPath);
  const integration = openBoundSubdirectory(agent, 'integration');
  try {
    const result = casBoundDirectoryFiles(
      integration,
      [
        {
          expected: Buffer.from('before\n'),
          expectedMode: 0o600,
          mode: 0o600,
          name: 'authority-marker.js',
          replacement: Buffer.from('after\n'),
        },
      ],
      {
        beforeCleanupRecovery: () => {
          const switcher = spawn(
            process.execPath,
            [
              '-e',
              `const fs=require('node:fs');setTimeout(()=>{fs.renameSync(${JSON.stringify(
                agentPath,
              )},${JSON.stringify(external)});fs.symlinkSync(${JSON.stringify(
                external,
              )},${JSON.stringify(agentPath)},'dir');fs.unlinkSync(${JSON.stringify(
                agentPath,
              )});fs.renameSync(${JSON.stringify(external)},${JSON.stringify(agentPath)})},100)`,
            ],
            { stdio: 'ignore' },
          );
          switcher.unref();
        },
        cleanupRecoveryDelayMs: 1_000,
        failCleanupAfterCommit: true,
      },
    );
    assert.equal(result.committed, true);
    assert.equal(result.cleanupPending, true);
    assert.match(result.cleanupError ?? '', /ancestor changed/);
    assert.match(result.cleanupObligation?.transactionId ?? '', /^[0-9a-f-]{36}$/);
    assert.equal(readFileSync(markerPath, 'utf8'), 'after\n');
    assert.equal(
      readdirSync(integrationPath).some((name) => name.endsWith('.journal')),
      true,
    );
  } finally {
    closeBoundDirectory(integration);
    closeBoundDirectory(agent);
    rmSync(root, { force: true, recursive: true });
    rmSync(externalRoot, { force: true, recursive: true });
  }
});

test('bound child adoption rejects a newly symlinked parent ancestor', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-bound-adoption-'));
  const externalRoot = mkdtempSync(join(tmpdir(), 'rn-session-bound-adoption-external-'));
  const external = join(externalRoot, 'agent');
  const agentPath = join(root, '.rn-agent');
  const integrationPath = join(agentPath, 'integration');
  mkdirSync(integrationPath, { recursive: true });
  writeFileSync(join(integrationPath, 'authority-marker.js'), 'before\n');
  const agent = openBoundDirectory(agentPath);
  try {
    assert.throws(
      () =>
        openBoundSubdirectory(agent, 'integration', {
          afterChildBind: () => {
            renameSync(agentPath, external);
            symlinkSync(external, agentPath, 'dir');
          },
        }),
      /SESSION_INTEGRATION_PATH_UNSAFE/,
    );
    assert.equal(
      readFileSync(join(external, 'integration', 'authority-marker.js'), 'utf8'),
      'before\n',
    );
  } finally {
    closeBoundDirectory(agent);
    rmSync(root, { force: true, recursive: true });
    rmSync(externalRoot, { force: true, recursive: true });
  }
});

test('optional child lookup rejects a restored parent ancestor switch', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-bound-optional-switch-'));
  const externalRoot = mkdtempSync(join(tmpdir(), 'rn-session-bound-optional-switch-external-'));
  const agentPath = join(root, '.rn-agent');
  const external = join(externalRoot, 'agent');
  mkdirSync(agentPath);
  const agent = openBoundDirectory(agentPath);
  try {
    const switcher = spawn(
      process.execPath,
      [
        '-e',
        `const fs=require('node:fs');setTimeout(()=>{fs.renameSync(${JSON.stringify(
          agentPath,
        )},${JSON.stringify(external)});fs.symlinkSync(${JSON.stringify(
          external,
        )},${JSON.stringify(agentPath)},'dir');fs.unlinkSync(${JSON.stringify(
          agentPath,
        )});fs.renameSync(${JSON.stringify(external)},${JSON.stringify(agentPath)})},100)`,
      ],
      { stdio: 'ignore' },
    );
    switcher.unref();
    assert.throws(
      () =>
        openOptionalBoundSubdirectory(agent, 'integration', {
          optionalMissingDelayMs: 1_000,
        }),
      /SESSION_INTEGRATION_PATH_UNSAFE/,
    );
  } finally {
    closeBoundDirectory(agent);
    rmSync(root, { force: true, recursive: true });
    rmSync(externalRoot, { force: true, recursive: true });
  }
});

test('bound app-worker recovery rebinds retained descendants', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-bound-rebind-'));
  const agentPath = join(root, '.rn-agent');
  const integrationPath = join(agentPath, 'integration');
  mkdirSync(integrationPath, { recursive: true });
  writeFileSync(join(root, 'package.json'), 'before\n');
  writeFileSync(join(integrationPath, 'authority-marker.js'), 'marker\n');
  const app = openBoundDirectory(root);
  const agent = openBoundSubdirectory(app, '.rn-agent');
  const integration = openBoundSubdirectory(agent, 'integration');
  try {
    assert.throws(
      () =>
        casBoundDirectoryFiles(
          app,
          [
            {
              expected: Buffer.from('before\n'),
              mode: 0o600,
              name: 'package.json',
              replacement: Buffer.from('after\n'),
            },
          ],
          { afterCaptureDelayMs: 5_000, timeoutMs: 1_000 },
        ),
      /SESSION_INTEGRATION_PATH_UNSAFE/,
    );
    assert.equal(
      readBoundDirectoryFiles(integration, ['authority-marker.js'])[0]?.contents?.toString('utf8'),
      'marker\n',
    );
  } finally {
    closeBoundDirectory(integration);
    closeBoundDirectory(agent);
    closeBoundDirectory(app);
    rmSync(root, { force: true, recursive: true });
  }
});

test('bounded CAS recovery restores a file captured during worker timeout', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-bound-timeout-'));
  const markerPath = join(root, 'authority-marker.js');
  writeFileSync(markerPath, 'before\n');
  const directory = openBoundDirectory(root);
  try {
    assert.throws(
      () =>
        casBoundDirectoryFiles(
          directory,
          [
            {
              expected: Buffer.from('before\n'),
              mode: 0o600,
              name: 'authority-marker.js',
              replacement: Buffer.from('after\n'),
            },
          ],
          { afterCaptureDelayMs: 5_000, timeoutMs: 1_000 },
        ),
      /SESSION_INTEGRATION_PATH_UNSAFE/,
    );
    assert.equal(readFileSync(markerPath, 'utf8'), 'before\n');
    assert.deepEqual(readdirSync(root), ['authority-marker.js']);
  } finally {
    closeBoundDirectory(directory);
    rmSync(root, { force: true, recursive: true });
  }
});

test('bounded CAS recovery refuses a journal-less timeout outcome', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-bound-unknown-'));
  const markerPath = join(root, 'authority-marker.js');
  writeFileSync(markerPath, 'before\n', { mode: 0o600 });
  const directory = openBoundDirectory(root);
  try {
    assert.throws(
      () =>
        casBoundDirectoryFiles(
          directory,
          [
            {
              expected: Buffer.from('before\n'),
              mode: 0o600,
              name: 'authority-marker.js',
              replacement: Buffer.from('after\n'),
            },
          ],
          { afterLockReleaseDelayMs: 1_000, timeoutMs: 100 },
        ),
      /transaction outcome is unknown/,
    );
    assert.equal(readFileSync(markerPath, 'utf8'), 'after\n');
  } finally {
    closeBoundDirectory(directory);
    rmSync(root, { force: true, recursive: true });
  }
});

test('bounded CAS recovery leaves untouched later writes absent', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-bound-untouched-'));
  const firstPath = join(root, 'first.js');
  const secondPath = join(root, 'second.js');
  writeFileSync(firstPath, 'first-before\n');
  writeFileSync(secondPath, 'second-before\n');
  const directory = openBoundDirectory(root);
  try {
    const remover = spawn(
      process.execPath,
      ['-e', `setTimeout(() => require('node:fs').unlinkSync(${JSON.stringify(secondPath)}), 300)`],
      { stdio: 'ignore' },
    );
    remover.unref();
    assert.throws(
      () =>
        casBoundDirectoryFiles(
          directory,
          [
            {
              expected: Buffer.from('first-before\n'),
              mode: 0o600,
              name: 'first.js',
              replacement: Buffer.from('first-after\n'),
            },
            {
              expected: Buffer.from('second-before\n'),
              mode: 0o600,
              name: 'second.js',
              replacement: Buffer.from('second-after\n'),
            },
          ],
          { afterCaptureDelayMs: 5_000, timeoutMs: 1_000 },
        ),
      /SESSION_INTEGRATION_PATH_UNSAFE/,
    );
    assert.equal(readFileSync(firstPath, 'utf8'), 'first-before\n');
    assert.equal(existsSync(secondPath), false);
    assert.deepEqual(readdirSync(root), ['first.js']);
  } finally {
    closeBoundDirectory(directory);
    rmSync(root, { force: true, recursive: true });
  }
});

test('bounded CAS recovery resumes after its first timeout', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-bound-recovery-timeout-'));
  const markerPath = join(root, 'authority-marker.js');
  writeFileSync(markerPath, 'before\n', { mode: 0o600 });
  const directory = openBoundDirectory(root);
  try {
    assert.throws(
      () =>
        casBoundDirectoryFiles(
          directory,
          [
            {
              expected: Buffer.from('before\n'),
              mode: 0o600,
              name: 'authority-marker.js',
              replacement: Buffer.from('after\n'),
            },
          ],
          {
            afterReplacementDelayMs: 1_000,
            recoveryDelayAfterUnlinkMs: 1_000,
            recoveryTimeoutMs: 250,
            timeoutMs: 250,
          },
        ),
      /SESSION_INTEGRATION_PATH_UNSAFE/,
    );
    assert.equal(readFileSync(markerPath, 'utf8'), 'before\n');
    assert.deepEqual(readdirSync(root), ['authority-marker.js']);
  } finally {
    closeBoundDirectory(directory);
    rmSync(root, { force: true, recursive: true });
  }
});

test('bound CAS rejects concurrent mode changes', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-bound-mode-'));
  const markerPath = join(root, 'authority-marker.js');
  writeFileSync(markerPath, 'before\n', { mode: 0o600 });
  const directory = openBoundDirectory(root);
  try {
    chmodSync(markerPath, 0o644);
    assert.throws(
      () =>
        casBoundDirectoryFiles(directory, [
          {
            expected: Buffer.from('before\n'),
            expectedMode: 0o600,
            mode: 0o600,
            name: 'authority-marker.js',
            replacement: Buffer.from('after\n'),
          },
        ]),
      /SESSION_INTEGRATION_CONFLICT/,
    );
    assert.equal(readFileSync(markerPath, 'utf8'), 'before\n');
    assert.equal(statSync(markerPath).mode & 0o777, 0o644);
  } finally {
    closeBoundDirectory(directory);
    rmSync(root, { force: true, recursive: true });
  }
});

test('bound CAS can change mode when the expected mode is omitted', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-bound-mode-change-'));
  const markerPath = join(root, 'authority-marker.js');
  writeFileSync(markerPath, 'before\n', { mode: 0o644 });
  const directory = openBoundDirectory(root);
  try {
    casBoundDirectoryFiles(directory, [
      {
        expected: Buffer.from('before\n'),
        mode: 0o600,
        name: 'authority-marker.js',
        replacement: Buffer.from('after\n'),
      },
    ]);
    assert.equal(readFileSync(markerPath, 'utf8'), 'after\n');
    if (process.platform !== 'win32') {
      assert.equal(statSync(markerPath).mode & 0o777, 0o600);
    }
  } finally {
    closeBoundDirectory(directory);
    rmSync(root, { force: true, recursive: true });
  }
});

test('committed bound CAS succeeds when artifact cleanup needs recovery', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-bound-committed-cleanup-'));
  const markerPath = join(root, 'authority-marker.js');
  writeFileSync(markerPath, 'before\n', { mode: 0o600 });
  const directory = openBoundDirectory(root);
  try {
    casBoundDirectoryFiles(
      directory,
      [
        {
          expected: Buffer.from('before\n'),
          expectedMode: 0o600,
          mode: 0o600,
          name: 'authority-marker.js',
          replacement: Buffer.from('after\n'),
        },
      ],
      { failCleanupAfterCommit: true },
    );
    assert.equal(readFileSync(markerPath, 'utf8'), 'after\n');
    assert.deepEqual(readdirSync(root), ['authority-marker.js']);
  } finally {
    closeBoundDirectory(directory);
    rmSync(root, { force: true, recursive: true });
  }
});

test('bound CAS returns committed state when cleanup recovery remains unavailable', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-bound-cleanup-pending-'));
  const markerPath = join(root, 'authority-marker.js');
  writeFileSync(markerPath, 'before\n', { mode: 0o600 });
  const directory = openBoundDirectory(root);
  try {
    const result = casBoundDirectoryFiles(
      directory,
      [
        {
          expected: Buffer.from('before\n'),
          expectedMode: 0o600,
          mode: 0o600,
          name: 'authority-marker.js',
          replacement: Buffer.from('after\n'),
        },
      ],
      { failCleanupAfterCommit: true, failCleanupRecovery: true },
    );
    assert.equal(result.committed, true);
    assert.equal(result.cleanupPending, true);
    assert.match(result.cleanupError ?? '', /cleanup recovery unavailable/);
    assert.match(result.cleanupObligation?.transactionId ?? '', /^[0-9a-f-]{36}$/);
    assert.equal(readFileSync(markerPath, 'utf8'), 'after\n');
  } finally {
    closeBoundDirectory(directory);
    rmSync(root, { force: true, recursive: true });
  }
});

test('bound CAS replaces a blocked cleanup worker before returning', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-bound-cleanup-timeout-'));
  const markerPath = join(root, 'authority-marker.js');
  writeFileSync(markerPath, 'before\n', { mode: 0o600 });
  const directory = openBoundDirectory(root);
  try {
    const result = casBoundDirectoryFiles(
      directory,
      [
        {
          expected: Buffer.from('before\n'),
          expectedMode: 0o600,
          mode: 0o600,
          name: 'authority-marker.js',
          replacement: Buffer.from('after\n'),
        },
      ],
      {
        cleanupRecoveryDelayMs: 5_000,
        failCleanupAfterCommit: true,
        recoveryTimeoutMs: 100,
      },
    );
    assert.equal(result.cleanupPending, false);
    assert.equal(readFileSync(markerPath, 'utf8'), 'after\n');
    assert.deepEqual(readdirSync(root), ['authority-marker.js']);
    assert.equal(
      readBoundDirectoryFiles(directory, ['authority-marker.js'])[0]?.contents?.toString('utf8'),
      'after\n',
    );
  } finally {
    closeBoundDirectory(directory);
    rmSync(root, { force: true, recursive: true });
  }
});

test('bound CAS preserves known commit after cleanup retry failure', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-bound-cleanup-retry-failure-'));
  const markerPath = join(root, 'authority-marker.js');
  writeFileSync(markerPath, 'before\n', { mode: 0o600 });
  const directory = openBoundDirectory(root);
  try {
    const result = casBoundDirectoryFiles(
      directory,
      [
        {
          expected: Buffer.from('before\n'),
          expectedMode: 0o600,
          mode: 0o600,
          name: 'authority-marker.js',
          replacement: Buffer.from('after\n'),
        },
      ],
      {
        cleanupRecoveryDelayMs: 5_000,
        failCleanupAfterCommit: true,
        failCleanupRecovery: true,
        recoveryTimeoutMs: 100,
      },
    );
    assert.equal(result.committed, true);
    assert.equal(result.cleanupPending, true);
    assert.match(result.cleanupObligation?.transactionId ?? '', /^[0-9a-f-]{36}$/);
    assert.match(result.cleanupError ?? '', /cleanup recovery unavailable/);
    assert.equal(readFileSync(markerPath, 'utf8'), 'after\n');
  } finally {
    closeBoundDirectory(directory);
    rmSync(root, { force: true, recursive: true });
  }
});

test(
  'bound cleanup obligations survive close and reopen',
  { skip: process.platform === 'win32' },
  () => {
    const root = mkdtempSync(join(tmpdir(), 'rn-session-bound-cleanup-reopen-'));
    const markerPath = join(root, 'authority-marker.js');
    writeFileSync(markerPath, 'before\n', { mode: 0o600 });
    const directory = openBoundDirectory(root);
    try {
      const result = casBoundDirectoryFiles(
        directory,
        [
          {
            expected: Buffer.from('before\n'),
            expectedMode: 0o600,
            mode: 0o600,
            name: 'authority-marker.js',
            replacement: Buffer.from('after\n'),
          },
        ],
        { failCleanupAfterCommit: true, failCleanupRecovery: true },
      );
      assert.equal(result.cleanupPending, true);
      chmodSync(root, 0o500);
      assert.throws(() => closeBoundDirectory(directory), /bound-directory cleanup/);
      chmodSync(root, 0o700);
      const reopened = openBoundDirectory(root);
      try {
        assert.equal(readFileSync(markerPath, 'utf8'), 'after\n');
        assert.deepEqual(readdirSync(root), ['authority-marker.js']);
      } finally {
        closeBoundDirectory(reopened);
      }
    } finally {
      chmodSync(root, 0o700);
      if (!directory.closed) closeBoundDirectory(directory);
      rmSync(root, { force: true, recursive: true });
    }
  },
);

test(
  'an already-open worker resolves a stopped owner journal before its next CAS',
  { skip: process.platform === 'win32' },
  () => {
    const root = mkdtempSync(join(tmpdir(), 'rn-session-bound-already-open-recovery-'));
    const markerPath = join(root, 'authority-marker.js');
    writeFileSync(markerPath, 'before\n', { mode: 0o600 });
    const first = openBoundDirectory(root);
    const second = openBoundDirectory(root);
    try {
      const result = casBoundDirectoryFiles(
        first,
        [
          {
            expected: Buffer.from('before\n'),
            expectedMode: 0o600,
            mode: 0o600,
            name: 'authority-marker.js',
            replacement: Buffer.from('after\n'),
          },
        ],
        { failCleanupAfterCommit: true, failCleanupRecovery: true },
      );
      assert.equal(result.cleanupPending, true);
      chmodSync(root, 0o500);
      assert.throws(() => closeBoundDirectory(first), /bound-directory cleanup/);
      chmodSync(root, 0o700);
      const next = casBoundDirectoryFiles(second, [
        {
          expected: Buffer.from('after\n'),
          expectedMode: 0o600,
          mode: 0o600,
          name: 'authority-marker.js',
          replacement: Buffer.from('final\n'),
        },
      ]);
      assert.equal(next.cleanupPending, false);
      assert.equal(readFileSync(markerPath, 'utf8'), 'final\n');
      assert.deepEqual(readdirSync(root), ['authority-marker.js']);
    } finally {
      chmodSync(root, 0o700);
      if (!first.closed) closeBoundDirectory(first);
      closeBoundDirectory(second);
      rmSync(root, { force: true, recursive: true });
    }
  },
);

test(
  'read-only bound directory open does not create transaction files',
  { skip: process.platform === 'win32' },
  () => {
    const root = mkdtempSync(join(tmpdir(), 'rn-session-bound-read-only-'));
    chmodSync(root, 0o500);
    const directory = openBoundDirectory(root);
    const controlPath = directory.worker.controlPath;
    try {
      assert.deepEqual(readdirSync(root), []);
    } finally {
      closeBoundDirectory(directory);
      chmodSync(root, 0o700);
      assert.equal(existsSync(controlPath), false);
      rmSync(root, { force: true, recursive: true });
    }
  },
);

test('bound discovery quarantines unauthenticated journals without applying them', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-bound-forged-journal-'));
  const journal = join(root, '.rn-bound-11111111-1111-1111-1111-111111111111.journal');
  const markerPath = join(root, 'authority-marker.js');
  writeFileSync(markerPath, 'before\n', { mode: 0o600 });
  writeFileSync(
    journal,
    JSON.stringify({
      version: 1,
      name: '.rn-bound-11111111-1111-1111-1111-111111111111.journal',
      owner: 'forged',
      state: 'committed',
      writes: [],
    }),
    { mode: 0o600 },
  );
  const directory = openBoundDirectory(root);
  try {
    assert.equal(readFileSync(markerPath, 'utf8'), 'before\n');
    assert.equal(
      readdirSync(root).some((name) => name.startsWith('.rn-bound-') && name.includes('.invalid-')),
      true,
    );
  } finally {
    closeBoundDirectory(directory);
    rmSync(root, { force: true, recursive: true });
  }
});

test('bound discovery preserves an invalid journal across a fast ancestor swap', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-bound-discovery-switch-'));
  const externalRoot = mkdtempSync(join(tmpdir(), 'rn-session-bound-discovery-switch-external-'));
  const agentPath = join(root, '.rn-agent');
  const external = join(externalRoot, 'agent');
  const integrationPath = join(agentPath, 'integration');
  const journalPath = join(
    integrationPath,
    '.rn-bound-11111111-1111-1111-1111-111111111111.journal',
  );
  mkdirSync(integrationPath, { recursive: true });
  writeFileSync(journalPath, '{', { mode: 0o600 });
  const agent = openBoundDirectory(agentPath);
  try {
    assert.throws(
      () =>
        openBoundSubdirectory(agent, 'integration', {
          afterChildBind: () => {
            const switcher = spawn(
              process.execPath,
              [
                '-e',
                `const fs=require('node:fs');setTimeout(()=>{fs.renameSync(${JSON.stringify(
                  agentPath,
                )},${JSON.stringify(external)});fs.symlinkSync(${JSON.stringify(
                  external,
                )},${JSON.stringify(agentPath)},'dir');fs.unlinkSync(${JSON.stringify(
                  agentPath,
                )});fs.renameSync(${JSON.stringify(external)},${JSON.stringify(agentPath)})},100)`,
              ],
              { stdio: 'ignore' },
            );
            switcher.unref();
          },
          discoveryQuarantineDelayMs: 1_000,
        }),
      /SESSION_INTEGRATION_PATH_UNSAFE/,
    );
    assert.equal(readFileSync(journalPath, 'utf8'), '{');
    assert.deepEqual(
      readdirSync(integrationPath).filter((name) => name.includes('.invalid-')),
      [],
    );
  } finally {
    closeBoundDirectory(agent);
    rmSync(root, { force: true, recursive: true });
    rmSync(externalRoot, { force: true, recursive: true });
  }
});

test('bound directory groups attempt every close and preserve the primary error', () => {
  const firstRoot = mkdtempSync(join(tmpdir(), 'rn-session-bound-close-first-'));
  const secondRoot = mkdtempSync(join(tmpdir(), 'rn-session-bound-close-second-'));
  const first = openBoundDirectory(firstRoot);
  const second = openBoundDirectory(secondRoot);
  first.pendingCleanups.set('11111111-1111-1111-1111-111111111111', {
    journal: '.rn-bound-11111111-1111-1111-1111-111111111111.journal',
    knownCommitted: false,
    writes: [],
  });
  second.pendingCleanups.set('22222222-2222-2222-2222-222222222222', {
    journal: '.rn-bound-22222222-2222-2222-2222-222222222222.journal',
    knownCommitted: false,
    writes: [],
  });
  try {
    assert.throws(
      () => closeBoundDirectories([first, second], new Error('primary failure')),
      (error) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.errors.length, 3);
        assert.match(error.errors[0].message, /primary failure/);
        return true;
      },
    );
    assert.equal(first.closed, true);
    assert.equal(second.closed, true);
  } finally {
    rmSync(firstRoot, { force: true, recursive: true });
    rmSync(secondRoot, { force: true, recursive: true });
  }
});

test('bound workers exit when their owner disconnects', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-bound-owner-exit-'));
  const pidPath = join(root, 'worker.pid');
  try {
    const moduleUrl = new URL('../../../dist/session/bound-directory.js', import.meta.url).href;
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        "const {writeFileSync}=await import('node:fs');const {openBoundDirectory}=await import(process.argv[1]);const directory=openBoundDirectory(process.argv[2]);writeFileSync(process.argv[3],String(directory.worker.pid));process.exit(0);",
        moduleUrl,
        root,
        pidPath,
      ],
      { encoding: 'utf8', timeout: 5_000 },
    );
    assert.equal(result.status, 0, result.stderr);
    const workerPid = Number(readFileSync(pidPath, 'utf8'));
    const deadline = Date.now() + 3_000;
    let alive = true;
    while (alive && Date.now() < deadline) {
      try {
        process.kill(workerPid, 0);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      } catch {
        alive = false;
      }
    }
    assert.equal(alive, false);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('confirmed integration preserves concurrent package inputs', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-apply-conflict-'));
  try {
    const packagePath = join(root, 'package.json');
    const metroPath = join(root, 'metro.config.js');
    const packageBefore = `${JSON.stringify(packageJson)}\n`;
    const concurrentMetro = 'module.exports = { concurrent: true };\n';
    writeFileSync(packagePath, packageBefore);
    writeFileSync(metroPath, 'module.exports = { serializer: {} };\n');

    assert.throws(
      () =>
        applyPackageIntegration(
          { appRoot: root, sessionCli: join(root, 'rn-session.js') },
          { beforeCommit: () => writeFileSync(metroPath, concurrentMetro) },
        ),
      /SESSION_INTEGRATION_CONFLICT/,
    );
    assert.equal(readFileSync(packagePath, 'utf8'), packageBefore);
    assert.equal(readFileSync(metroPath, 'utf8'), concurrentMetro);
    assert.equal(existsSync(join(root, '.rn-agent')), true);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('integration pre-read rejects a newly symlinked agent ancestor', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-preread-root-'));
  const externalRoot = mkdtempSync(join(tmpdir(), 'rn-session-preread-external-'));
  const externalAgent = join(externalRoot, '.rn-agent');
  mkdirSync(join(externalAgent, 'integration'), { recursive: true });
  writeFileSync(
    join(externalAgent, 'integration', 'rn-session-integration.json'),
    '{"version":1}\n',
  );
  writeFileSync(join(root, 'package.json'), `${JSON.stringify(packageJson)}\n`);
  writeFileSync(join(root, 'metro.config.js'), 'module.exports = {};\n');
  try {
    assert.throws(
      () =>
        readPackageIntegrationInputs(root, {
          afterAppRead: () => symlinkSync(externalAgent, join(root, '.rn-agent'), 'dir'),
        }),
      /SESSION_INTEGRATION_PATH_UNSAFE/,
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
    rmSync(externalRoot, { force: true, recursive: true });
  }
});

test('integration rolls back committed files when cleanup remains pending', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-cleanup-rollback-'));
  const packageBefore = `${JSON.stringify(packageJson)}\n`;
  const metroBefore = 'module.exports = {};\n';
  writeFileSync(join(root, 'package.json'), packageBefore);
  writeFileSync(join(root, 'metro.config.js'), metroBefore);
  try {
    assert.throws(
      () =>
        applyPackageIntegration(
          { appRoot: root, sessionCli: join(root, 'rn-session.js') },
          {
            boundOperationDependencies: {
              failCleanupAfterCommit: true,
              failCleanupRecovery: true,
            },
          },
        ),
      (error) => {
        assert.ok(error instanceof Error);
        assert.match(
          [
            error.message,
            ...(error instanceof AggregateError ? error.errors.map((entry) => String(entry)) : []),
          ].join('\n'),
          /committed cleanup remains pending|bound-directory cleanup/,
        );
        return true;
      },
    );
    assert.equal(readFileSync(join(root, 'package.json'), 'utf8'), packageBefore);
    assert.equal(readFileSync(join(root, 'metro.config.js'), 'utf8'), metroBefore);
    for (const name of [
      'rn-session-integration.json',
      'rn-session-adapter.cjs',
      'rn-session-metro.cjs',
      'authority-marker.js',
    ]) {
      assert.equal(existsSync(join(root, '.rn-agent', 'integration', name)), false);
    }
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('confirmed integration rejects app-root replacement before commit', () => {
  const parent = mkdtempSync(join(tmpdir(), 'rn-session-app-root-parent-'));
  const root = join(parent, 'app');
  const displaced = join(parent, 'displaced');
  mkdirSync(root);
  try {
    const packagePath = join(root, 'package.json');
    const metroPath = join(root, 'metro.config.js');
    writeFileSync(packagePath, `${JSON.stringify(packageJson)}\n`);
    writeFileSync(metroPath, 'module.exports = {};\n');

    assert.throws(
      () =>
        applyPackageIntegration(
          { appRoot: root, sessionCli: join(root, 'rn-session.js') },
          {
            beforeCommit: () => {
              renameSync(root, displaced);
              mkdirSync(root);
            },
          },
        ),
      (error) => {
        assert.ok(error instanceof Error);
        assert.match(
          [
            error.message,
            ...(error instanceof AggregateError ? error.errors.map((entry) => String(entry)) : []),
          ].join('\n'),
          /SESSION_INTEGRATION_PATH_UNSAFE|bound-directory cleanup/,
        );
        return true;
      },
    );
    assert.equal(
      readFileSync(join(displaced, 'package.json'), 'utf8'),
      `${JSON.stringify(packageJson)}\n`,
    );
    assert.equal(
      readFileSync(join(displaced, 'metro.config.js'), 'utf8'),
      'module.exports = {};\n',
    );
  } finally {
    rmSync(parent, { force: true, recursive: true });
  }
});

test(
  'confirmed integration preserves concurrent Metro mode changes',
  { skip: process.platform === 'win32' },
  () => {
    const root = mkdtempSync(join(tmpdir(), 'rn-session-apply-mode-conflict-'));
    try {
      const packagePath = join(root, 'package.json');
      const metroPath = join(root, 'metro.config.js');
      const metroBefore = 'module.exports = { serializer: {} };\n';
      writeFileSync(packagePath, `${JSON.stringify(packageJson)}\n`);
      writeFileSync(metroPath, metroBefore, { mode: 0o644 });

      assert.throws(
        () =>
          applyPackageIntegration(
            { appRoot: root, sessionCli: join(root, 'rn-session.js') },
            { beforeCommit: () => chmodSync(metroPath, 0o600) },
          ),
        /SESSION_INTEGRATION_CONFLICT/,
      );
      assert.equal(readFileSync(metroPath, 'utf8'), metroBefore);
      assert.equal(statSync(metroPath).mode & 0o777, 0o600);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  },
);

test('confirmed integration keeps the shared .rn-agent corpus continuously available', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-shared-root-'));
  try {
    const sharedPath = join(root, '.rn-agent', 'actions', 'existing.yaml');
    mkdirSync(join(root, '.rn-agent', 'actions'), { recursive: true });
    writeFileSync(sharedPath, 'appId: example\n');
    writeFileSync(join(root, 'package.json'), `${JSON.stringify(packageJson)}\n`);
    writeFileSync(join(root, 'metro.config.js'), 'module.exports = {};\n');

    applyPackageIntegration(
      { appRoot: root, sessionCli: join(root, 'rn-session.js') },
      { beforeCommit: () => assert.equal(readFileSync(sharedPath, 'utf8'), 'appId: example\n') },
    );

    assert.equal(readFileSync(sharedPath, 'utf8'), 'appId: example\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('integration rollback preserves edits made after its own write', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-rollback-cas-'));
  try {
    const packagePath = join(root, 'package.json');
    const metroPath = join(root, 'metro.config.js');
    const concurrentPackage = `${JSON.stringify({
      ...packageJson,
      concurrent: true,
    })}\n`;
    const concurrentMetro = 'module.exports = { concurrent: true };\n';
    writeFileSync(packagePath, `${JSON.stringify(packageJson)}\n`);
    writeFileSync(metroPath, 'module.exports = {};\n');

    assert.throws(() =>
      applyPackageIntegration(
        { appRoot: root, sessionCli: join(root, 'rn-session.js') },
        {
          afterWrite: (path) => {
            if (path !== metroPath) return;
            writeFileSync(metroPath, concurrentMetro);
            writeFileSync(packagePath, concurrentPackage);
          },
        },
      ),
    );
    assert.equal(readFileSync(packagePath, 'utf8'), concurrentPackage);
    assert.equal(readFileSync(metroPath, 'utf8'), concurrentMetro);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  'integration reads reject non-regular inputs without blocking',
  { skip: process.platform === 'win32' },
  () => {
    const root = mkdtempSync(join(tmpdir(), 'rn-session-input-fifo-'));
    try {
      const fifo = join(root, 'package.json');
      execFileSync('mkfifo', [fifo]);
      assert.throws(
        () => readRegularFileNoFollow(root, fifo),
        /integration input is not a regular file/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  'confirmed integration and restoration preserve private input modes',
  { skip: process.platform === 'win32' },
  () => {
    const root = mkdtempSync(join(tmpdir(), 'rn-session-restore-'));
    try {
      const packagePath = join(root, 'package.json');
      const metroPath = join(root, 'metro.config.js');
      writeFileSync(packagePath, `${JSON.stringify(packageJson)}\n`, { mode: 0o600 });
      const metroBefore = 'module.exports = { serializer: {} };\n';
      writeFileSync(metroPath, metroBefore, { mode: 0o600 });
      const sessionCli = join(root, 'rn-session.js');
      writeFileSync(sessionCli, '');

      applyPackageIntegration({ appRoot: root, sessionCli });
      assert.equal(statSync(packagePath).mode & 0o777, 0o600);
      assert.equal(statSync(metroPath).mode & 0o777, 0o600);
      restorePackageIntegrationFiles({ appRoot: root });

      assert.deepEqual(JSON.parse(readFileSync(packagePath, 'utf8')), packageJson);
      assert.equal(readFileSync(metroPath, 'utf8'), metroBefore);
      assert.equal(statSync(packagePath).mode & 0o777, 0o600);
      assert.equal(statSync(metroPath).mode & 0o777, 0o600);
      assert.throws(
        () => readFileSync(join(root, '.rn-agent/integration/rn-session-integration.json')),
        /ENOENT/,
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  },
);

test('restoration refuses package scripts edited after integration', () => {
  const preview = previewPackageIntegration(packageJson);
  const edited = {
    ...preview.packageJson,
    scripts: {
      ...preview.packageJson.scripts,
      ios: 'expo run:ios --device',
    },
  };

  assert.throws(
    () => restorePackageIntegration(edited, preview.manifest),
    /SESSION_INTEGRATION_CONFLICT/,
  );
});

test('confirmed restoration rejects a manifest Metro path outside the app root', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-restore-path-'));
  const external = mkdtempSync(join(tmpdir(), 'rn-session-restore-external-'));
  try {
    writeFileSync(join(root, 'package.json'), `${JSON.stringify(packageJson)}\n`);
    writeFileSync(join(root, 'metro.config.js'), 'module.exports = {};\n');
    const externalConfig = join(external, 'metro.config.js');
    writeFileSync(externalConfig, 'external\n');
    applyPackageIntegration({ appRoot: root, sessionCli: join(root, 'rn-session.js') });
    const manifestPath = join(root, '.rn-agent/integration/rn-session-integration.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.metroConfig = `../${join(external, 'metro.config.js')}`;
    writeFileSync(manifestPath, JSON.stringify(manifest));

    assert.throws(
      () => restorePackageIntegrationFiles({ appRoot: root }),
      /SESSION_INTEGRATION_PATH_UNSAFE/,
    );
    assert.equal(readFileSync(externalConfig, 'utf8'), 'external\n');
  } finally {
    rmSync(root, { force: true, recursive: true });
    rmSync(external, { force: true, recursive: true });
  }
});

test('copied adapter accepts build identity only from the package-local session CLI', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-adapter-'));
  try {
    const integrationRoot = join(root, '.rn-agent', 'integration');
    const binRoot = join(root, 'bin');
    const adapterPath = join(integrationRoot, 'rn-session-adapter.cjs');
    const outputPath = join(root, 'record.json');
    const completionPath = join(root, 'completion.json');
    const sessionCliPath = join(root, 'rn-session.cjs');
    mkdirSync(integrationRoot, { recursive: true });
    mkdirSync(binRoot, { recursive: true });
    writeFileSync(adapterPath, renderProjectAdapter(), { mode: 0o755 });
    writeFileSync(
      join(integrationRoot, 'rn-session-integration.json'),
      JSON.stringify({
        version: 1,
        adapter: '.rn-agent/integration/rn-session-adapter.cjs',
        sessionCli: sessionCliPath,
        originalScripts: {
          ios: ['npx', 'expo', 'run:ios'],
          android: ['npx', 'expo', 'run:android'],
        },
      }),
    );
    const fakeNpx = join(binRoot, 'npx');
    writeFileSync(
      fakeNpx,
      "#!/usr/bin/env node\nrequire('node:fs').writeFileSync(process.env.ADAPTER_RECORD,JSON.stringify({args:process.argv.slice(2),port:process.env.RCT_METRO_PORT,session:process.env.RN_DEV_AGENT_SESSION_ID}))\n",
    );
    chmodSync(fakeNpx, 0o755);
    writeFileSync(
      sessionCliPath,
      "const fs=require('node:fs');const args=process.argv.slice(2);if(args[0]==='prepare-build'){process.stdout.write(JSON.stringify({platform:'ios',deviceId:'session-ios-device',appId:'dev.example',metroPort:8341,sessionId:'session-ios',buildToken:'build-token-ios'}));}else{fs.writeFileSync(process.env.ADAPTER_COMPLETION,JSON.stringify({args,session:process.env.RN_DEV_AGENT_SESSION_ID}));process.stdout.write('{\"receipt\":true}\\n');}",
    );

    const result = spawnSync(process.execPath, [adapterPath, 'ios'], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binRoot}:${process.env.PATH}`,
        ADAPTER_RECORD: outputPath,
        ADAPTER_COMPLETION: completionPath,
        RN_DEV_AGENT_SESSION_BUILD_JSON: JSON.stringify({
          platform: 'ios',
          deviceId: 'foreign-device',
          appId: 'dev.foreign',
          metroPort: 9999,
          sessionId: 'foreign-session',
          buildToken: 'foreign-token',
        }),
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(outputPath, 'utf8')), {
      args: ['expo', 'run:ios', '--device', 'session-ios-device', '--port', '8341', '--no-bundler'],
      port: '8341',
      session: 'session-ios',
    });
    assert.deepEqual(JSON.parse(readFileSync(completionPath, 'utf8')), {
      args: ['complete-build', 'ios', 'build-token-ios'],
      session: 'session-ios',
    });
    assert.match(result.stdout, /"receipt":true/);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
