import assert from 'node:assert/strict';
import { ChildProcess } from 'node:child_process';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { renderMetroIntegrationAdapter } from '../../../dist/session/package-integration.js';

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

function fencedProject(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  execFileSync('git', ['init', '-q', root]);
  const integration = join(root, '.rn-agent', 'integration');
  mkdirSync(integration, { recursive: true });
  const adapterPath = join(integration, 'rn-session-metro.cjs');
  writeFileSync(adapterPath, renderMetroIntegrationAdapter());
  const childEntry = join(root, 'child.cjs');
  writeFileSync(childEntry, 'process.exit(0);\n');
  const versionShim = join(root, 'version-shim.cjs');
  writeFileSync(
    versionShim,
    "Object.defineProperty(process.versions, 'node', { value: '99.0.0', configurable: true });\n",
  );
  return { root, integration, adapterPath, childEntry, versionShim };
}

function runFenced(project: ReturnType<typeof fencedProject>, source: string, preload?: string) {
  const environment = metroPolicyEnvironment(project.adapterPath);
  if (preload) {
    environment.NODE_OPTIONS = `--require=${JSON.stringify(preload)} --require=${JSON.stringify(project.adapterPath)}`;
  }
  const runtimeLoads = join(project.integration, 'metro-runtime-loads.jsonl');
  const descriptor = openSync(runtimeLoads, 'a');
  try {
    const result = spawnSync(process.execPath, ['-e', source], {
      cwd: project.root,
      env: environment,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe', 'ignore', 'ignore', 'ignore', 'ignore', 'ignore', 'ignore'],
    });
    return { ...result, runtimeLoads: readFileSync(runtimeLoads, 'utf8') };
  } finally {
    closeSync(descriptor);
  }
}

const hostConvention = (() => {
  const binding = (process as unknown as { binding(name: string): unknown }).binding(
    'process_wrap',
  ) as { constants?: unknown };
  return binding && binding.constants ? 'positional' : 'object';
})();

test('Node still calls the native process handle with a convention the fence knows', () => {
  const source = String(ChildProcess.prototype.spawn);
  const objectConvention = /this\._handle\.spawn\(\s*options\s*\)/.test(source);
  const positionalConvention =
    /this\._handle\.spawn\(/.test(source) &&
    ['options.file', 'options.args', 'options.cwd', 'options.envPairs', 'options.stdio'].every(
      (field) => source.includes(field),
    );
  assert.ok(
    objectConvention || positionalConvention,
    `ChildProcess.prototype.spawn on Node ${process.versions.node} uses an unrecognized calling convention:\n${source}`,
  );
  assert.equal(
    objectConvention ? 'object' : 'positional',
    hostConvention,
    'process_wrap constants disagree with the observed ChildProcess.prototype.spawn source',
  );
});

test('an authorized descendant fork is admitted under this host convention', () => {
  const project = fencedProject('rn-session-metro-convention-admit-');
  const result = runFenced(
    project,
    `const compose = require(${JSON.stringify(project.adapterPath)});
     compose({});
     const childProcess = require('node:child_process');
     const child = childProcess.fork(${JSON.stringify(project.childEntry)}, [], { execArgv: ['--no-warnings'] });
     child.once('error', (error) => { console.error('fork error ' + error.code); process.exit(3); });
     child.once('exit', (code) => process.exit(code === 0 ? 0 : 4));`,
  );
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.ok(
    !result.runtimeLoads.includes('RN_DEV_AGENT_UNSUPPORTED_DESCENDANT_EXECUTION'),
    'an admitted descendant recorded a refusal violation',
  );
});

test('an unverified Node convention refuses descendants without killing the fenced process', () => {
  const project = fencedProject('rn-session-metro-convention-unverified-');
  const result = runFenced(
    project,
    `const compose = require(${JSON.stringify(project.adapterPath)});
     compose({});
     const childProcess = require('node:child_process');
     const child = childProcess.fork(${JSON.stringify(project.childEntry)}, [], { execArgv: ['--no-warnings'] });
     child.once('error', (error) => {
       if (error.code !== 'EACCES') { console.error('unexpected error code ' + error.code); process.exit(5); }
       console.log('contained');
       process.exit(0);
     });
     child.once('exit', () => {});
     setTimeout(() => { console.error('no error event'); process.exit(6); }, 10000).unref();`,
    project.versionShim,
  );
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /contained/);
  assert.ok(
    result.runtimeLoads.includes('RN_DEV_AGENT_DESCENDANT_CONVENTION_UNVERIFIED'),
    'the install-time convention refusal was not recorded as signed evidence',
  );
  assert.ok(
    result.runtimeLoads.includes('RN_DEV_AGENT_UNSUPPORTED_DESCENDANT_EXECUTION'),
    'the contained native spawn refusal was not recorded as signed evidence',
  );
});

test(
  'the recomputed positional spawn flags authenticate a detached descendant',
  { skip: hostConvention !== 'positional' ? 'host uses the object spawn convention' : false },
  () => {
    const project = fencedProject('rn-session-metro-convention-flags-');
    // Node folds detached/windowsHide/windowsVerbatimArguments into one positional
    // bitmask. The fence recomputes it from the binding's own constants, so a wrong
    // bit value refuses this spawn instead of admitting it.
    const result = runFenced(
      project,
      `const compose = require(${JSON.stringify(project.adapterPath)});
     compose({});
     const childProcess = require('node:child_process');
     const child = childProcess.spawn(process.execPath, [${JSON.stringify(project.childEntry)}], {
       detached: true,
       windowsHide: true,
     });
     child.once('error', (error) => { console.error('detached spawn refused ' + error.code); process.exit(11); });
     child.once('exit', (code) => process.exit(code === 0 ? 0 : 12));`,
    );
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.ok(
      !result.runtimeLoads.includes('RN_DEV_AGENT_UNSUPPORTED_DESCENDANT_EXECUTION'),
      'a correctly flagged detached descendant recorded a refusal violation',
    );
  },
);

test('a raw native handle spawn is still a hard refusal, not a contained errno', () => {
  const project = fencedProject('rn-session-metro-convention-raw-');
  const result = runFenced(
    project,
    `const compose = require(${JSON.stringify(project.adapterPath)});
     compose({});
     const childProcess = require('node:child_process');
     try {
       new childProcess.ChildProcess().spawn({ file: process.execPath, args: [process.execPath, ${JSON.stringify(project.childEntry)}] });
       console.error('raw handle spawn was accepted');
       process.exit(9);
     } catch (error) {
       if (error.code !== 'RN_DEV_AGENT_UNSUPPORTED_DESCENDANT_EXECUTION') {
         console.error('unexpected error ' + error.code);
         process.exit(10);
       }
       console.log('threw');
       process.exit(0);
     }`,
  );
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /threw/);
});
