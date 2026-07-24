import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import {
  applyPackageIntegration,
  previewMetroIntegration,
  previewPackageIntegration,
  renderMetroIntegrationAdapter,
  renderProjectAdapter,
  restoreMetroIntegration,
  restorePackageIntegrationFiles,
  restorePackageIntegration,
} from '../../../dist/session/package-integration.js';

const packageJson = {
  name: 'fixture-app',
  scripts: {
    ios: 'expo run:ios',
    android: 'npx react-native run-android --mode debug',
    test: 'jest',
  },
};

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

test('confirmed integration can be transactionally restored through its public file surface', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-restore-'));
  try {
    writeFileSync(join(root, 'package.json'), `${JSON.stringify(packageJson)}\n`);
    const metroBefore = 'module.exports = { serializer: {} };\n';
    writeFileSync(join(root, 'metro.config.js'), metroBefore);
    const sessionCli = join(root, 'rn-session.js');
    writeFileSync(sessionCli, '');

    applyPackageIntegration({ appRoot: root, sessionCli });
    restorePackageIntegrationFiles({ appRoot: root });

    assert.deepEqual(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')), packageJson);
    assert.equal(readFileSync(join(root, 'metro.config.js'), 'utf8'), metroBefore);
    assert.throws(
      () => readFileSync(join(root, '.rn-agent/integration/rn-session-integration.json')),
      /ENOENT/,
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('copied adapter injects the active session into literal package scripts', () => {
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
      "require('node:fs').writeFileSync(process.env.ADAPTER_COMPLETION,JSON.stringify({args:process.argv.slice(2),session:process.env.RN_DEV_AGENT_SESSION_ID}));process.stdout.write('{\"receipt\":true}\\n')",
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
          deviceId: 'session-ios-device',
          appId: 'dev.example',
          metroPort: 8341,
          sessionId: 'session-ios',
          buildToken: 'build-token-ios',
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
