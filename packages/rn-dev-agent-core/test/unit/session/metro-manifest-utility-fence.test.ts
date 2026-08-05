import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { renderMetroIntegrationAdapter } from '../../../dist/session/package-integration.js';

const unsupportedPlatform = process.platform === 'win32';

interface Harness {
  adapterPath: string;
  environment: NodeJS.ProcessEnv;
  expoManifestModulePath: string;
  expoUpdatesCliPath: string;
  integration: string;
  probePath: string;
  probeOutput: string;
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
  const root = mkdtempSync(join(tmpdir(), `rn-manifest-fence-${name}-`));
  execFileSync('git', ['init', '-q', root]);
  const integration = join(root, '.rn-agent', 'integration');
  mkdirSync(integration, { recursive: true });
  const adapterPath = join(integration, 'rn-session-metro.cjs');
  writeFileSync(adapterPath, renderMetroIntegrationAdapter());
  const expoCliRoot = join(root, 'node_modules', '@expo', 'cli');
  const expoManifestModulePath = join(
    expoCliRoot,
    'build',
    'src',
    'start',
    'server',
    'middleware',
    'ExpoGoManifestHandlerMiddleware.js',
  );
  mkdirSync(dirname(expoManifestModulePath), { recursive: true });
  writeFileSync(join(expoCliRoot, 'package.json'), JSON.stringify({ name: '@expo/cli' }));
  writeFileSync(
    expoManifestModulePath,
    `class ExpoGoManifestHandlerMiddleware {
  constructor(operation) { this.operation = operation; }
  handleRequestAsync() { return this.operation(); }
}
exports.ExpoGoManifestHandlerMiddleware = ExpoGoManifestHandlerMiddleware;
`,
  );
  const expoUpdatesRoot = join(root, 'node_modules', 'expo-updates');
  const expoUpdatesCliPath = join(expoUpdatesRoot, 'bin', 'cli.js');
  mkdirSync(dirname(expoUpdatesCliPath), { recursive: true });
  writeFileSync(
    join(expoUpdatesRoot, 'package.json'),
    JSON.stringify({ name: 'expo-updates', bin: { 'expo-updates': 'bin/cli.js' } }),
  );
  const probeOutput = join(root, 'probe-environment.txt');
  const probePath = join(root, 'platform-utility');
  writeFileSync(
    probePath,
    `#!/bin/sh
: > ${JSON.stringify(probeOutput)}
printenv >> ${JSON.stringify(probeOutput)}
if [ -e /dev/fd/9 ]; then echo "RN_PROBE_EVIDENCE_DESCRIPTOR=visible" >> ${JSON.stringify(probeOutput)}; fi
echo "RN_PROBE_ARGS=$*" >> ${JSON.stringify(probeOutput)}
exit 0
`,
  );
  chmodSync(probePath, 0o755);
  writeFileSync(
    expoUpdatesCliPath,
    `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(probeOutput)}, Object.entries(process.env).map(([key, value]) => key + '=' + value).join('\\n') + '\\nRN_PROBE_ARGS=' + process.argv.slice(2).join(' ') + '\\n');
if (process.env.PROBE_SLEEP === '1') setTimeout(() => {}, 30000);
`,
  );
  chmodSync(expoUpdatesCliPath, 0o755);
  return {
    adapterPath,
    environment: metroPolicyEnvironment(adapterPath),
    expoManifestModulePath,
    expoUpdatesCliPath,
    integration,
    probePath,
    probeOutput,
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

const manifestPreamble = (harness: Harness) =>
  `${composePreamble(harness)}
const { ExpoGoManifestHandlerMiddleware } = require(${JSON.stringify(harness.expoManifestModulePath)});
const runManifest = (operation) => new ExpoGoManifestHandlerMiddleware(operation).handleRequestAsync();`;

test(
  'manifest utilities run outside bundle authority with every session capability stripped',
  { skip: unsupportedPlatform },
  () => {
    const harness = createHarness('capability');
    try {
      const result = runFenced(
        harness,
        `${manifestPreamble(harness)}
runManifest(() => {
  const child = childProcess.spawn(${JSON.stringify(harness.expoUpdatesCliPath)}, ['runtimeversion:resolve', '--platform', 'ios']);
  child.once('exit', (code) => { if (code !== 0) process.exit(2); });
});`,
      );
      assert.equal(result.status, 0, result.stderr);

      const observed = readFileSync(harness.probeOutput, 'utf8').split('\n').filter(Boolean);
      const leaked = observed.filter(
        (line) => line.startsWith('RN_DEV_AGENT_') || line.startsWith('NODE_OPTIONS='),
      );
      assert.deepEqual(leaked, [], `manifest utility inherited session capability: ${leaked}`);
      assert.equal(
        observed.includes('RN_PROBE_EVIDENCE_DESCRIPTOR=visible'),
        false,
        'manifest utility inherited the Metro evidence descriptor',
      );
      assert.ok(observed.includes('RN_PROBE_ARGS=runtimeversion:resolve --platform ios'));

      const observations = readObservations(harness);
      const utility = observations.filter((entry) => entry.kind === 'unattested-utility');
      assert.equal(utility.length, 1);
      const record = JSON.parse(utility[0]!.value) as {
        command: string;
        lane: string;
        proofBearing: boolean;
      };
      assert.equal(record.command, harness.expoUpdatesCliPath);
      assert.equal(record.lane, 'manifest-utility');
      assert.equal(record.proofBearing, false);
      assert.equal(
        observations.some((entry) => entry.kind === 'launch'),
        false,
        'a manifest utility must never be recorded as an attested descendant launch',
      );
    } finally {
      rmSync(harness.root, { force: true, recursive: true });
    }
  },
);

test(
  'PATH substitution cannot impersonate the canonical Expo updates utility',
  { skip: unsupportedPlatform },
  () => {
    const harness = createHarness('path-substitution');
    try {
      const maliciousBin = join(harness.root, 'malicious-bin');
      mkdirSync(maliciousBin, { recursive: true });
      const substituted = join(maliciousBin, 'expo-updates');
      writeFileSync(
        substituted,
        `#!/bin/sh
: > ${JSON.stringify(harness.probeOutput)}
printenv >> ${JSON.stringify(harness.probeOutput)}
exit 0
`,
      );
      chmodSync(substituted, 0o755);
      const environment = {
        ...harness.environment,
        PATH: `${maliciousBin}:${harness.environment.PATH ?? ''}`,
      };
      const result = runFenced(
        harness,
        `${manifestPreamble(harness)}
runManifest(() => {
  try { childProcess.spawn('expo-updates', ['runtimeversion:resolve', '--platform', 'ios']); }
  catch (error) {
    if (error?.code === 'RN_DEV_AGENT_UNSUPPORTED_DESCENDANT_EXECUTION') process.exit(0);
  }
  process.exit(2);
});`,
        environment,
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
  'config load and deferred callbacks remain strict by default',
  { skip: unsupportedPlatform },
  () => {
    const harness = createHarness('attested-scope');
    try {
      const result = runFenced(
        harness,
        `const compose = require(${JSON.stringify(harness.adapterPath)});
const childProcess = require('node:child_process');
const probe = ${JSON.stringify(harness.probePath)};
const refusals = [];
const attempt = (run) => { try { run(); refusals.push('accepted'); } catch (error) { refusals.push(error?.code); } };
setTimeout(() => {
  attempt(() => childProcess.spawnSync(probe, []));
  if (refusals.length !== 6) process.exit(3);
  if (refusals.some((code) => code !== 'RN_DEV_AGENT_UNSUPPORTED_DESCENDANT_EXECUTION')) process.exit(4);
}, 1);
attempt(() => childProcess.spawnSync(probe, []));
const scoped = compose({
  resolver: { resolveRequest: () => { attempt(() => childProcess.spawnSync(probe, [])); return {}; } },
  serializer: { getPolyfills: () => { attempt(() => childProcess.spawnSync(probe, [])); attempt(() => childProcess.execFileSync(probe, [])); return []; } },
  transformer: { getTransformOptions: () => { attempt(() => childProcess.spawnSync(probe, [])); return {}; } },
});
scoped.serializer.getPolyfills({ platform: 'ios' });
scoped.resolver.resolveRequest({}, 'x', 'ios');
scoped.transformer.getTransformOptions([], {}, () => []);
`,
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(
        readObservations(harness).some((entry) => entry.kind === 'unattested-utility'),
        false,
        'a descendant of bundle-producing code must never reach the manifest utility lane',
      );
    } finally {
      rmSync(harness.root, { force: true, recursive: true });
    }
  },
);

test(
  'async continuations of bundle-producing callbacks stay inside the attested subtree',
  { skip: unsupportedPlatform },
  () => {
    const harness = createHarness('attested-async');
    try {
      const result = runFenced(
        harness,
        `const compose = require(${JSON.stringify(harness.adapterPath)});
const childProcess = require('node:child_process');
const probe = ${JSON.stringify(harness.probePath)};
const scoped = compose({
  transformer: {
    getTransformOptions: async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      try { childProcess.spawnSync(probe, []); } catch (error) { return { code: error?.code }; }
      return { code: 'accepted' };
    },
  },
});
scoped.transformer.getTransformOptions([], {}, () => []).then((result) => {
  if (result.code !== 'RN_DEV_AGENT_UNSUPPORTED_DESCENDANT_EXECUTION') {
    console.error(JSON.stringify(result));
    process.exit(3);
  }
});`,
      );
      assert.equal(result.status, 0, result.stderr);
    } finally {
      rmSync(harness.root, { force: true, recursive: true });
    }
  },
);

test(
  'attested descendants cannot launch unattested transitive children',
  { skip: unsupportedPlatform },
  () => {
    const harness = createHarness('transitive');
    try {
      const descendant = join(harness.root, 'descendant.cjs');
      writeFileSync(
        descendant,
        `const childProcess = require('node:child_process');
const results = [];
for (const run of [
  () => childProcess.spawnSync(${JSON.stringify(harness.probePath)}, []),
  () => childProcess.execFileSync(${JSON.stringify(harness.probePath)}, []),
]) {
  try { run(); results.push('accepted'); } catch (error) { results.push(error?.code); }
}
if (results.some((code) => code !== 'RN_DEV_AGENT_UNSUPPORTED_DESCENDANT_EXECUTION')) {
  console.error(JSON.stringify(results));
  process.exit(5);
}
`,
      );
      const result = runFenced(
        harness,
        `${composePreamble(harness)}
const child = childProcess.spawnSync(process.execPath, [${JSON.stringify(descendant)}]);
if (child.status !== 0) { console.error(String(child.stderr)); process.exit(child.status || 2); }`,
      );
      assert.equal(result.status, 0, result.stderr);
      const observations = readObservations(harness);
      assert.equal(
        observations.some((entry) => entry.kind === 'launch'),
        true,
        'the Node descendant itself must still be attested',
      );
      assert.equal(
        observations.some((entry) => entry.kind === 'unattested-utility'),
        false,
      );
    } finally {
      rmSync(harness.root, { force: true, recursive: true });
    }
  },
);

test(
  'the manifest utility adapter refuses shells, interpreters, project scripts, and argument drift',
  { skip: unsupportedPlatform },
  () => {
    const harness = createHarness('refusals');
    try {
      const result = runFenced(
        harness,
        `${manifestPreamble(harness)}
const probe = ${JSON.stringify(harness.probePath)};
const refusals = [];
const attempt = (run) => { try { run(); refusals.push('accepted'); } catch (error) { refusals.push(error?.code); } };
runManifest(() => {
  attempt(() => childProcess.exec(probe));
  attempt(() => childProcess.spawn('/bin/sh', ['-c', 'true']));
  attempt(() => childProcess.spawn('/usr/bin/osascript', ['-e', 'return 1']));
  attempt(() => childProcess.spawn('node', ['-e', 'process.exit(0)']));
  attempt(() => childProcess.spawn(probe, []));
  attempt(() => childProcess.spawn(${JSON.stringify(harness.expoUpdatesCliPath)}, ['runtimeversion:resolve', '--platform', 'web']));
  attempt(() => childProcess.spawnSync(${JSON.stringify(harness.expoUpdatesCliPath)}, ['runtimeversion:resolve', '--platform', 'ios']));
  attempt(() => childProcess.execFile(${JSON.stringify(harness.expoUpdatesCliPath)}, ['runtimeversion:resolve', '--platform', 'ios']));
  attempt(() => childProcess.spawn(${JSON.stringify(harness.expoUpdatesCliPath)}, ['runtimeversion:resolve', '--platform', 'ios'], { shell: true }));
  if (refusals.length !== 9 || refusals.some((code) => code !== 'RN_DEV_AGENT_UNSUPPORTED_DESCENDANT_EXECUTION')) process.exit(3);
});`,
      );
      assert.equal(result.status, 0, result.stderr);
    } finally {
      rmSync(harness.root, { force: true, recursive: true });
    }
  },
);

test(
  'the utility adapter is closed outside the verified manifest boundary',
  { skip: unsupportedPlatform },
  () => {
    const harness = createHarness('unsettled');
    try {
      const result = runFenced(
        harness,
        `const childProcess = require('node:child_process');
let code;
try { childProcess.spawn(${JSON.stringify(harness.expoUpdatesCliPath)}, ['runtimeversion:resolve', '--platform', 'ios']); code = 'accepted'; }
catch (error) { code = error?.code; }
if (code !== 'RN_DEV_AGENT_UNSUPPORTED_DESCENDANT_EXECUTION') { console.error(code); process.exit(3); }
require(${JSON.stringify(harness.adapterPath)})({});
try { childProcess.spawn(${JSON.stringify(harness.expoUpdatesCliPath)}, ['runtimeversion:resolve', '--platform', 'ios']); code = 'accepted'; }
catch (error) { code = error?.code; }
if (code !== 'RN_DEV_AGENT_UNSUPPORTED_DESCENDANT_EXECUTION') process.exit(4);`,
      );
      assert.equal(result.status, 0, result.stderr);
    } finally {
      rmSync(harness.root, { force: true, recursive: true });
    }
  },
);

test(
  'manifest utility children stay killable through the fenced lifecycle',
  { skip: unsupportedPlatform },
  () => {
    const harness = createHarness('lifecycle');
    try {
      const result = runFenced(
        harness,
        `${manifestPreamble(harness)}
runManifest(() => {
  const child = childProcess.spawn(${JSON.stringify(harness.expoUpdatesCliPath)}, ['runtimeversion:resolve', '--platform', 'ios'], { env: { ...process.env, PROBE_SLEEP: '1' } });
  child.once('spawn', () => {
    if (child.kill('SIGTERM') !== true) process.exit(3);
  });
  child.once('exit', () => process.exit(0));
});
setTimeout(() => process.exit(4), 10000);`,
      );
      assert.equal(result.status, 0, result.stderr);
    } finally {
      rmSync(harness.root, { force: true, recursive: true });
    }
  },
);
