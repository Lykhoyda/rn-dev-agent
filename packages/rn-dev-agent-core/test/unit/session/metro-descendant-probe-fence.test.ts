import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { renderMetroIntegrationAdapter } from '../../../dist/session/package-integration.js';

const unsupportedPlatform = process.platform === 'win32';
const systemBinDirectories = new Set(['/bin', '/usr/bin', '/sbin', '/usr/sbin']);

function systemCommand(name: string): string | null {
  const located = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' });
  if (located.status !== 0) return null;
  const resolved = located.stdout.trim();
  return systemBinDirectories.has(dirname(resolved)) ? resolved : null;
}

const systemGetconf = systemCommand('getconf');
const systemLdd = systemCommand('ldd');

interface Harness {
  adapterPath: string;
  detectLibcPath: string;
  environment: NodeJS.ProcessEnv;
  integration: string;
  nativeWindChild: string;
  probePath: string;
  root: string;
}

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

function createHarness(name: string): Harness {
  const root = mkdtempSync(join(tmpdir(), `rn-probe-fence-${name}-`));
  execFileSync('git', ['init', '-q', root]);
  const integration = join(root, '.rn-agent', 'integration');
  mkdirSync(integration, { recursive: true });
  const adapterPath = join(integration, 'rn-session-metro.cjs');
  writeFileSync(adapterPath, renderMetroIntegrationAdapter());
  const detectLibcRoot = join(root, 'node_modules', 'detect-libc');
  const detectLibcPath = join(detectLibcRoot, 'lib', 'detect-libc.js');
  mkdirSync(dirname(detectLibcPath), { recursive: true });
  writeFileSync(join(detectLibcRoot, 'package.json'), JSON.stringify({ name: 'detect-libc' }));
  writeFileSync(
    detectLibcPath,
    `const { spawnSync } = require('node:child_process');
const command = process.env.RN_PROBE_COMMAND || 'getconf';
const args = process.env.RN_PROBE_ARGS
  ? JSON.parse(process.env.RN_PROBE_ARGS)
  : command === 'ldd' ? ['--version'] : ['GNU_LIBC_VERSION'];
module.exports = spawnSync(command, args, { encoding: 'utf8', env: process.env });
`,
  );
  const nativeWindChild = join(
    root,
    'node_modules',
    'nativewind',
    'dist',
    'metro',
    'tailwind',
    'v3',
    'child.js',
  );
  mkdirSync(dirname(nativeWindChild), { recursive: true });
  writeFileSync(
    join(root, 'node_modules', 'nativewind', 'package.json'),
    JSON.stringify({ name: 'nativewind' }),
  );
  writeFileSync(
    nativeWindChild,
    `if (process.send) process.send({ ok: true });
setTimeout(() => process.exit(0), 50);
`,
  );
  const probePath = join(root, 'getconf');
  writeFileSync(
    probePath,
    `#!/bin/sh
exit 0
`,
  );
  chmodSync(probePath, 0o755);
  const environment = metroPolicyEnvironment(adapterPath);
  environment.RN_DEV_AGENT_METRO_CONTENT_ROOT = root;
  environment.RN_DEV_AGENT_METRO_APP_ROOT = root;
  environment.RN_DEV_AGENT_METRO_ALLOWED_CODE_ROOTS = JSON.stringify([root]);
  return {
    adapterPath,
    detectLibcPath,
    environment,
    integration,
    nativeWindChild,
    probePath,
    root,
  };
}

function runFenced(harness: Harness, script: string, environment?: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, ['-e', script], {
    cwd: harness.root,
    encoding: 'utf8',
    env: environment ?? harness.environment,
  });
}

function readObservations(harness: Harness): Array<{ kind: string; value: string }> {
  return readFileSync(join(harness.integration, 'metro-runtime-loads.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { kind: string; value: string });
}

const composePreamble = (harness: Harness) =>
  `const compose = require(${JSON.stringify(harness.adapterPath)}); const childProcess = require('node:child_process'); const config = compose({});`;

test(
  'canonical detect-libc module load may run Linux getconf and ldd probes without authority',
  { skip: unsupportedPlatform },
  () => {
    const harness = createHarness('libc-probe');
    try {
      assert.ok(systemGetconf, 'test host must provide a system getconf');
      const getconf = runFenced(
        harness,
        `${composePreamble(harness)}
require(${JSON.stringify(harness.detectLibcPath)});
`,
      );
      assert.equal(getconf.status, 0, `${getconf.stdout}\n${getconf.stderr}`);
      if (systemLdd) {
        const ldd = runFenced(
          harness,
          `${composePreamble(harness)}
require(${JSON.stringify(harness.detectLibcPath)});
`,
          { ...harness.environment, RN_PROBE_COMMAND: 'ldd' },
        );
        assert.equal(ldd.status, 0, `${ldd.stdout}\n${ldd.stderr}`);
      }
      const observations = readObservations(harness);
      const utilities = observations
        .filter((entry) => entry.kind === 'unattested-utility')
        .map(
          (entry) =>
            JSON.parse(entry.value) as {
              command: string;
              lane: string;
              proofBearing: boolean;
            },
        );
      const getconfUtility = utilities.filter(
        (entry) =>
          entry.command === 'getconf' &&
          entry.lane === 'libc-probe' &&
          entry.proofBearing === false,
      );
      assert.equal(getconfUtility.length, 1, JSON.stringify(utilities));
      if (systemLdd) {
        const lddUtility = utilities.filter(
          (entry) =>
            entry.command === 'ldd' && entry.lane === 'libc-probe' && entry.proofBearing === false,
        );
        assert.equal(lddUtility.length, 1, JSON.stringify(utilities));
      }
      assert.equal(
        observations.some((entry) => entry.kind === 'launch'),
        false,
        'a libc probe must never be recorded as an attested descendant launch',
      );
      const drifted = runFenced(
        harness,
        `${composePreamble(harness)}
try {
  require(${JSON.stringify(harness.detectLibcPath)});
  process.exit(3);
} catch (error) {
  if (error?.code !== 'RN_DEV_AGENT_UNSUPPORTED_DESCENDANT_EXECUTION') throw error;
}
`,
        { ...harness.environment, RN_PROBE_ARGS: JSON.stringify(['GNU_LIBC_VERSION', '--extra']) },
      );
      assert.equal(drifted.status, 0, drifted.stderr);
    } finally {
      rmSync(harness.root, { force: true, recursive: true });
    }
  },
);

test(
  'PATH substitution cannot impersonate the Linux libc probes',
  { skip: unsupportedPlatform },
  () => {
    const harness = createHarness('libc-path');
    try {
      const result = runFenced(
        harness,
        `${composePreamble(harness)}
try {
  require(${JSON.stringify(harness.detectLibcPath)});
  process.exit(3);
} catch (error) {
  if (error?.code !== 'RN_DEV_AGENT_UNSUPPORTED_DESCENDANT_EXECUTION') throw error;
}
`,
        {
          ...harness.environment,
          PATH: `${harness.root}:${harness.environment.PATH ?? ''}`,
        },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(
        readObservations(harness).some((entry) => entry.kind === 'unattested-utility'),
        false,
      );
    } finally {
      rmSync(harness.root, { force: true, recursive: true });
    }
  },
);

test(
  'bundle-producing callbacks cannot use the libc-probe lane',
  { skip: unsupportedPlatform },
  () => {
    const harness = createHarness('libc-scope');
    try {
      const result = runFenced(
        harness,
        `${composePreamble(harness)}
const refusals = [];
const attempt = (run) => { try { run(); refusals.push('accepted'); } catch (error) { refusals.push(error?.code); } };
const scoped = compose({
  transformer: {
    getTransformOptions: () => {
      attempt(() => childProcess.spawnSync('getconf', ['GNU_LIBC_VERSION']));
      attempt(() => childProcess.spawnSync('ldd', ['--version']));
      return {};
    },
  },
});
scoped.transformer.getTransformOptions([], {}, () => []);
if (refusals.length !== 2 || refusals.some((code) => code !== 'RN_DEV_AGENT_UNSUPPORTED_DESCENDANT_EXECUTION')) {
  console.error(JSON.stringify(refusals));
  process.exit(3);
}
`,
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(
        readObservations(harness).some((entry) => entry.kind === 'unattested-utility'),
        false,
      );
    } finally {
      rmSync(harness.root, { force: true, recursive: true });
    }
  },
);

test(
  'NativeWind Tailwind CLI forks stay attested Node descendants',
  { skip: unsupportedPlatform },
  () => {
    const harness = createHarness('nativewind-fork');
    try {
      const parent = join(harness.root, 'nativewind-parent.cjs');
      writeFileSync(
        parent,
        `const compose = require(${JSON.stringify(harness.adapterPath)});
compose({});
const childProcess = require('node:child_process');
const child = childProcess.fork(${JSON.stringify(harness.nativeWindChild)}, {
  stdio: 'pipe',
  env: { ...process.env },
});
child.once('error', (error) => {
  console.error(error);
  process.exit(2);
});
child.once('message', () => process.exit(0));
child.once('exit', (code) => process.exit(code === 0 ? 3 : code || 3));
`,
      );
      const result = spawnSync(process.execPath, [parent], {
        cwd: harness.root,
        encoding: 'utf8',
        env: harness.environment,
      });
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      const observations = readObservations(harness);
      assert.equal(
        observations.some((entry) => entry.kind === 'launch'),
        true,
        'the NativeWind Tailwind child must be an attested descendant launch',
      );
      assert.equal(
        observations.some((entry) => entry.kind === 'unattested-utility'),
        false,
        'the NativeWind Tailwind child must not enter a utility lane',
      );
    } finally {
      rmSync(harness.root, { force: true, recursive: true });
    }
  },
);

test(
  'unrelated process control stays refused beside the probe and toolchain exceptions',
  { skip: unsupportedPlatform },
  () => {
    const harness = createHarness('forbidden');
    try {
      const result = runFenced(
        harness,
        `${composePreamble(harness)}
const refusals = [];
const attempt = (run) => { try { run(); refusals.push('accepted'); } catch (error) { refusals.push(error?.code); } };
attempt(() => childProcess.spawnSync('true', []));
attempt(() => process.kill(process.pid, 0));
attempt(() => childProcess.exec('getconf GNU_LIBC_VERSION'));
if (refusals.length !== 3 || refusals.some((code) => code !== 'RN_DEV_AGENT_UNSUPPORTED_DESCENDANT_EXECUTION')) {
  console.error(JSON.stringify(refusals));
  process.exit(3);
}
`,
      );
      assert.equal(result.status, 0, result.stderr);
    } finally {
      rmSync(harness.root, { force: true, recursive: true });
    }
  },
);
