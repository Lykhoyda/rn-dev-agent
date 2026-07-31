import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { createBuildLaunchPlan } from '../../../dist/session/build-adapter.js';
import { renderProjectAdapter } from '../../../dist/session/package-integration.js';

// These tests drive the SHIPPED @expo/cli argv resolution and bundler-props guard, not a model.
const packageRequire = createRequire(import.meta.url);
const expoCliRoot = dirname(packageRequire.resolve('@expo/cli/package.json'));
const { assertWithOptionsArgs } = packageRequire(join(expoCliRoot, 'build/src/utils/args.js')) as {
  assertWithOptionsArgs: (
    schema: Record<string, unknown>,
    options: { argv: string[]; permissive: boolean },
  ) => Record<string, unknown>;
};
const { resolveBundlerPropsAsync } = packageRequire(
  join(expoCliRoot, 'build/src/run/resolveBundlerProps.js'),
) as {
  resolveBundlerPropsAsync: (
    projectRoot: string,
    options: { bundler?: boolean; port?: number },
  ) => Promise<{ shouldStartBundler: boolean; port: number | null }>;
};

const PORT_NO_BUNDLER_REJECTION = '--port and --no-bundler are mutually exclusive arguments';

// Tripwire: fails if a future @expo/cli changes the mapping resolveShippedBundlerProps mirrors.
test('shipped Expo run:ios still maps --port/--no-bundler argv the mirrored way', () => {
  const runIosSource = readFileSync(join(expoCliRoot, 'build/src/run/ios/index.js'), 'utf8');
  assert.match(runIosSource, /'--no-bundler': Boolean/);
  assert.match(runIosSource, /'--port': Number/);
  assert.match(runIosSource, /'-p': '--port'/);
  assert.match(runIosSource, /bundler: !args\['--no-bundler'\]/);
  assert.match(runIosSource, /port: args\['--port'\]/);
});

const parserProjectRoot = mkdtempSync(join(tmpdir(), 'expo-parser-project-'));
after(() => rmSync(parserProjectRoot, { force: true, recursive: true }));

async function resolveShippedBundlerProps(expoArgv: string[]) {
  const args = assertWithOptionsArgs(
    { '--no-bundler': Boolean, '--port': Number, '-p': '--port' },
    { argv: expoArgv, permissive: true },
  );
  return resolveBundlerPropsAsync(parserProjectRoot, {
    bundler: !args['--no-bundler'],
    port: args['--port'] as number | undefined,
  });
}

test('a --port plus --no-bundler command shape is rejected by the shipped Expo CLI guard', async () => {
  await assert.rejects(
    resolveShippedBundlerProps([
      '--device',
      'F66756F3-A867-47EB-97E1-2B85D1902D4E',
      '--port',
      '8248',
      '--no-bundler',
    ]),
    (error: Error) => error.message === PORT_NO_BUNDLER_REJECTION,
  );
});

test('repaired build plan passes the shipped Expo CLI resolution with managed authority intact', async () => {
  const session = {
    platform: 'ios' as const,
    deviceId: 'F66756F3-A867-47EB-97E1-2B85D1902D4E',
    appId: 'com.rndevagent.testapp',
    metroPort: 8248,
    sessionId: 'session-fixture',
    simulator: true,
  };
  for (const original of [
    ['npx', 'expo', 'run:ios'],
    ['npx', 'expo', 'run:ios', '--port', '8248'],
    ['npx', 'expo', 'run:ios', '-p', '8248'],
  ]) {
    const plan = createBuildLaunchPlan({ platform: 'ios', command: original, session });
    assert.equal(plan.mode, 'session');
    const expoArgv = plan.command.slice(3);
    const props = await resolveShippedBundlerProps(expoArgv);
    assert.equal(props.shouldStartBundler, false, 'Expo must never start its own bundler');
    assert.equal(plan.env.RCT_METRO_PORT, '8248');
    assert.equal(plan.env.EXPO_PACKAGER_PROXY_URL, 'http://127.0.0.1:8248');
    assert.deepEqual(plan.postInstall?.command.slice(-2), [
      '--initialUrl',
      'http://127.0.0.1:8248',
    ]);
  }
});

test('generated adapter argv passes the shipped Expo CLI resolution end to end', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-adapter-expo-parser-'));
  try {
    const integrationRoot = join(root, '.rn-agent', 'integration');
    const binRoot = join(root, 'bin');
    const adapterPath = join(integrationRoot, 'rn-session-adapter.cjs');
    const outputPath = join(root, 'record.json');
    const startupPath = join(root, 'startup.json');
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
    writeFileSync(
      join(binRoot, 'npx'),
      "#!/usr/bin/env node\nrequire('node:fs').writeFileSync(process.env.ADAPTER_RECORD,JSON.stringify({args:process.argv.slice(2)}))\n",
    );
    chmodSync(join(binRoot, 'npx'), 0o755);
    writeFileSync(
      join(binRoot, 'xcrun'),
      "#!/usr/bin/env node\nconst fs=require('node:fs');const args=process.argv.slice(2);if(args[0]==='simctl'&&args[1]==='get_app_container'){process.stdout.write('/tmp/exact.app\\n');process.exit(0);}if(args[0]==='simctl'&&args[1]==='launch'){fs.writeFileSync(process.env.ADAPTER_STARTUP,JSON.stringify(args));process.exit(0);}process.exit(12);\n",
    );
    chmodSync(join(binRoot, 'xcrun'), 0o755);
    writeFileSync(
      sessionCliPath,
      "const args=process.argv.slice(2);if(args[0]==='prepare-build'){process.stdout.write(JSON.stringify({platform:'ios',deviceId:'F66756F3-A867-47EB-97E1-2B85D1902D4E',appId:'com.rndevagent.testapp',metroPort:8248,sessionId:'session-fixture',buildToken:'owned-build-token',simulator:true}));}else{process.stdout.write('{}\\n');}",
    );

    const result = spawnSync(process.execPath, [adapterPath, 'ios'], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binRoot}:${process.env.PATH}`,
        ADAPTER_RECORD: outputPath,
        ADAPTER_STARTUP: startupPath,
      },
    });
    assert.equal(result.status, 0, result.stderr);

    const recorded = JSON.parse(readFileSync(outputPath, 'utf8')) as { args: string[] };
    assert.deepEqual(recorded.args.slice(0, 2), ['expo', 'run:ios']);
    const props = await resolveShippedBundlerProps(recorded.args.slice(2));
    assert.equal(props.shouldStartBundler, false);
    assert.deepEqual(JSON.parse(readFileSync(startupPath, 'utf8')), [
      'simctl',
      'launch',
      '--terminate-running-process',
      'F66756F3-A867-47EB-97E1-2B85D1902D4E',
      'com.rndevagent.testapp',
      '--initialUrl',
      'http://127.0.0.1:8248',
    ]);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
