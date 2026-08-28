import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  closeSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  pinnedNativeSpawnConventions,
  renderMetroIntegrationAdapter,
} from '../../../dist/session/package-integration.js';

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
  const doubleSpawnShim = join(root, 'double-spawn-shim.cjs');
  writeFileSync(
    doubleSpawnShim,
    `const childProcess = require('node:child_process');
const originalSpawn = childProcess.ChildProcess.prototype.spawn;
childProcess.ChildProcess.prototype.spawn = function (options) {
  this._handle.spawn(process.execPath, [], null, [], [], 0, undefined, undefined);
  return Reflect.apply(originalSpawn, this, [options]);
};
`,
  );
  // Substitutes a foreign executable for the authorized one while the fence's one-shot
  // authorization is live, so admission is tested on argument content rather than arity.
  const forgedFileShim = join(root, 'forged-file-shim.cjs');
  writeFileSync(
    forgedFileShim,
    `const childProcess = require('node:child_process');
const originalSpawn = childProcess.ChildProcess.prototype.spawn;
childProcess.ChildProcess.prototype.spawn = function (options) {
  let outcome;
  try {
    outcome =
      'errno:' +
      this._handle.spawn(
        '/nonexistent-rn-dev-agent-forged',
        options.args,
        options.cwd,
        options.envPairs,
        options.stdio,
        0,
        options.uid,
        options.gid,
      );
  } catch (error) {
    outcome = 'threw:' + error.code;
  }
  console.log(outcome);
  return Reflect.apply(originalSpawn, this, [options]);
};
`,
  );
  // Every argument is a member of the authorized options, but `cwd` sits in the file slot and
  // the authorized file is parked in an ignored ninth argument. A membership-only admission
  // rule accepts this and executes the cwd path; positional authentication refuses it.
  const permutedArgumentShim = join(root, 'permuted-argument-shim.cjs');
  writeFileSync(
    permutedArgumentShim,
    `const childProcess = require('node:child_process');
const originalSpawn = childProcess.ChildProcess.prototype.spawn;
childProcess.ChildProcess.prototype.spawn = function (options) {
  let outcome;
  try {
    outcome =
      'errno:' +
      this._handle.spawn(
        options.cwd,
        options.args,
        options.uid,
        options.envPairs,
        options.stdio,
        0,
        options.uid,
        options.gid,
        options.file,
      );
  } catch (error) {
    outcome = 'threw:' + error.code;
  }
  console.log(outcome);
  return Reflect.apply(originalSpawn, this, [options]);
};
`,
  );
  // Writes a marker so "no child ran" is observable rather than inferred.
  const markerPath = join(root, 'child-ran.marker');
  const markerEntry = join(root, 'marker-child.cjs');
  writeFileSync(
    markerEntry,
    `require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'ran');\n`,
  );
  return {
    root,
    integration,
    adapterPath,
    childEntry,
    markerEntry,
    markerPath,
    versionShim,
    doubleSpawnShim,
    forgedFileShim,
    permutedArgumentShim,
  };
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
  const environment = { ...process.env };
  delete environment.NODE_OPTIONS;
  for (const name of Object.keys(environment)) {
    if (name.startsWith('RN_DEV_AGENT_')) delete environment[name];
  }
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      `const processWrap = process.binding('process_wrap');
       const originalSpawn = processWrap.Process.prototype.spawn;
       let observedArity = null;
       processWrap.Process.prototype.spawn = function (...args) {
         observedArity = args.length;
         return Reflect.apply(originalSpawn, this, args);
       };
       const child = require('node:child_process').spawn(process.execPath, ['-e', 'process.exit(0)']);
       child.once('error', (error) => { console.error(error.stack || error); process.exit(2); });
       child.once('exit', (code) => {
         if (code !== 0) process.exit(3);
         process.stdout.write(JSON.stringify({
           observedArity,
           hasConstants: Boolean(processWrap.constants),
           nodeVersion: process.versions.node,
         }));
       });`,
    ],
    { encoding: 'utf8', env: environment },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const observed = JSON.parse(result.stdout) as {
    observedArity: number;
    hasConstants: boolean;
    nodeVersion: string;
  };
  assert.ok(
    observed.observedArity === 1 || observed.observedArity === 8,
    `Node ${observed.nodeVersion} invoked native spawn with arity ${observed.observedArity}`,
  );
  const observedConvention = observed.observedArity === 1 ? 'object' : 'positional';
  assert.equal(
    observedConvention,
    observed.hasConstants ? 'positional' : 'object',
    'process_wrap constants disagree with the observed native spawn invocation',
  );
  const pinned = pinnedNativeSpawnConventions(observed.nodeVersion);
  if (pinned.length > 0) {
    assert.ok(
      pinned.includes(observedConvention),
      `Node ${observed.nodeVersion} is pinned as ${JSON.stringify(pinned)} but invokes ${observedConvention}`,
    );
  }
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

// Representative odd-major coverage. Node 99 is unpinned, so the pre-content-authentication
// fence refused every descendant here and killed managed Metro on the first NativeWind
// bundle request. Admission now authenticates argument content, so an unpinned major is
// fully functional and the table records drift as evidence only.
test('an unpinned Node major still admits an authorized descendant and records drift evidence', () => {
  const project = fencedProject('rn-session-metro-convention-unpinned-');
  const result = runFenced(
    project,
    `const compose = require(${JSON.stringify(project.adapterPath)});
     compose({});
     const childProcess = require('node:child_process');
     const child = childProcess.fork(${JSON.stringify(project.childEntry)}, [], { execArgv: ['--no-warnings'] });
     child.once('error', (error) => { console.error('fork refused ' + error.code); process.exit(5); });
     child.once('exit', (code) => process.exit(code === 0 ? 0 : 6));`,
    project.versionShim,
  );
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.ok(
    result.runtimeLoads.includes('RN_DEV_AGENT_DESCENDANT_CONVENTION_UNVERIFIED'),
    'the unpinned major was not recorded as signed drift evidence',
  );
  assert.ok(
    !result.runtimeLoads.includes('RN_DEV_AGENT_UNSUPPORTED_DESCENDANT_EXECUTION'),
    'an unpinned major must not refuse an authorized descendant',
  );
});

// A forged argument is the refusal that must survive: it reports Node's own errno so a
// listener-bearing caller sees an ordinary spawn failure, and it is signed as evidence.
test('a forged spawn argument is refused by errno on this host convention', () => {
  const project = fencedProject('rn-session-metro-convention-forged-');
  const result = runFenced(
    project,
    `const compose = require(${JSON.stringify(project.adapterPath)});
     compose({});
     const childProcess = require('node:child_process');
     try {
       childProcess.spawn(process.execPath, [${JSON.stringify(project.childEntry)}]);
       console.error('the forged call did not consume the one-shot authorization');
       process.exit(7);
     } catch (error) {
       if (error.code !== 'RN_DEV_AGENT_UNSUPPORTED_DESCENDANT_EXECUTION') {
         console.error('unexpected error ' + error.code);
         process.exit(8);
       }
       process.exit(0);
     }`,
    project.forgedFileShim,
  );
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  // Contained, not thrown: the requester gets the errno Node reports for any denied spawn.
  assert.match(
    result.stdout,
    /^errno:-\d+$/m,
    `a forged argument must be refused by errno, got ${JSON.stringify(result.stdout)}`,
  );
  assert.ok(
    result.runtimeLoads.includes('RN_DEV_AGENT_UNSUPPORTED_DESCENDANT_EXECUTION'),
    'the forged-argument refusal was not recorded as signed evidence',
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

test('an eight-argument native call without live authorization cannot detach a child', () => {
  const project = fencedProject('rn-session-metro-convention-expired-');
  const result = runFenced(
    project,
    `const compose = require(${JSON.stringify(project.adapterPath)});
     compose({});
     const diagnosticsChannel = require('node:diagnostics_channel');
     const childProcess = require('node:child_process');
     let nativeHandle;
     diagnosticsChannel.subscribe('child_process', ({ process: constructed }) => {
       nativeHandle = constructed._handle;
     });
     const child = childProcess.spawn(process.execPath, [${JSON.stringify(project.childEntry)}]);
     child.once('error', (error) => { console.error('child error ' + error.code); process.exit(13); });
     child.once('spawn', () => {
       try {
         nativeHandle.spawn(process.execPath, [], null, [], [], 0, undefined, undefined);
         console.error('expired native authorization returned an errno');
         process.exit(14);
       } catch (error) {
         if (error.code !== 'RN_DEV_AGENT_UNSUPPORTED_DESCENDANT_EXECUTION') {
           console.error('unexpected error ' + error.code);
           process.exit(15);
         }
       }
     });
     child.once('exit', (code) => process.exit(code === 0 ? 0 : 16));`,
  );
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
});

test('a contained native refusal consumes its one-shot authorization', () => {
  const project = fencedProject('rn-session-metro-convention-one-shot-');
  const result = runFenced(
    project,
    `const compose = require(${JSON.stringify(project.adapterPath)});
     compose({});
     const childProcess = require('node:child_process');
     try {
       const child = childProcess.spawn(process.execPath, [${JSON.stringify(project.childEntry)}]);
       child.kill();
       console.error('second native spawn reused the authorization');
       process.exit(17);
     } catch (error) {
       if (error.code !== 'RN_DEV_AGENT_UNSUPPORTED_DESCENDANT_EXECUTION') {
         console.error('unexpected error ' + error.code);
         process.exit(18);
       }
       process.exit(0);
     }`,
    project.doubleSpawnShim,
  );
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.ok(
    result.runtimeLoads.includes('RN_DEV_AGENT_UNSUPPORTED_DESCENDANT_EXECUTION'),
    'the contained first refusal was not recorded as signed evidence',
  );
});

// Regression: an order-agnostic membership rule admitted this permutation, substituting the
// authorized `cwd` for the executable. Position is part of the authentication.
test(
  'a permuted spawn argument list cannot substitute the executable',
  { skip: hostConvention !== 'positional' ? 'host uses the object spawn convention' : false },
  () => {
    const project = fencedProject('rn-session-metro-convention-permuted-');
    const result = runFenced(
      project,
      `const compose = require(${JSON.stringify(project.adapterPath)});
     compose({});
     const childProcess = require('node:child_process');
     const child = childProcess.spawn(process.execPath, [${JSON.stringify(project.childEntry)}], {
       cwd: require('node:path').dirname(process.execPath),
     });
     child.once('error', (error) => { console.error('authorized spawn refused ' + error.code); process.exit(21); });
     child.once('exit', (code) => process.exit(code === 0 ? 0 : 22));`,
      project.permutedArgumentShim,
    );
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    // The permutation is an unrecognised shape, so it is a hard identity refusal, never an errno
    // and never a spawn of the cwd path.
    assert.match(
      result.stdout,
      /^threw:RN_DEV_AGENT_UNSUPPORTED_DESCENDANT_EXECUTION$/m,
      `a permuted argument list must be refused outright, got ${JSON.stringify(result.stdout)}`,
    );
    assert.doesNotMatch(
      result.stdout,
      /^errno:/m,
      'a permuted argument list must not reach the native spawn at all',
    );
  },
);

// The consequence of the one-shot: a forged eight-argument call inside an active authorization is
// contained AND retires the authorization, so Node's own call that follows it is refused outright.
// A forged re-entrant call therefore cannot execute and cannot leave a second admitted spawn.
test("a forged native call retires the authorization so Node's own spawn is refused", () => {
  const project = fencedProject('rn-session-metro-convention-consequence-');
  const result = runFenced(
    project,
    `const compose = require(${JSON.stringify(project.adapterPath)});
     compose({});
     const childProcess = require('node:child_process');
     try {
       childProcess.spawn(process.execPath, [${JSON.stringify(project.markerEntry)}]);
       console.error('Node own spawn was admitted after a forged call');
       process.exit(31);
     } catch (error) {
       if (error.code !== 'RN_DEV_AGENT_UNSUPPORTED_DESCENDANT_EXECUTION') {
         console.error('unexpected error ' + error.code);
         process.exit(32);
       }
       process.exit(0);
     }`,
    project.doubleSpawnShim,
  );
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.equal(
    existsSync(project.markerPath),
    false,
    'no child may run once a forged call has retired the authorization',
  );
  const violations = result.runtimeLoads
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { kind?: string; value?: string })
    .filter(
      (entry) =>
        entry.kind === 'violation' &&
        String(entry.value ?? '').includes('RN_DEV_AGENT_UNSUPPORTED_DESCENDANT_EXECUTION'),
    );
  assert.equal(
    violations.length,
    1,
    `exactly one signed violation must be recorded, got ${violations.length}`,
  );
});
