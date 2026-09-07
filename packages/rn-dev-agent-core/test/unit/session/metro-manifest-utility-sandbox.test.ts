import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import {
  prepareManagedMetroEnforcement,
  resolveManagedMetroManifestUtility,
  type ManagedMetroEnforcementPlan,
} from '../../../dist/session/managed-metro-enforcement.js';

const unsupportedPlatform = process.platform !== 'darwin';

interface Harness {
  base: string;
  commandPath: string;
  intruderPath: string;
  metroBinRoot: string;
  metroHome: string;
  profilePath: string;
  root: string;
  runtimeRoot: string;
}

function git(cwd: string, args: readonly string[]): void {
  execFileSync(
    'git',
    ['-c', 'user.email=fixture@example.com', '-c', 'user.name=Fixture', ...args],
    {
      cwd,
      stdio: 'ignore',
    },
  );
}

function createHarness(layout: 'plain' | 'linked' = 'plain'): Harness {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'rn-manifest-sandbox-')));
  const primary = join(base, 'primary');
  mkdirSync(primary, { recursive: true });
  execFileSync('git', ['init', '-q', primary]);
  writeFileSync(join(primary, '.gitignore'), 'ignored.txt\n');
  writeFileSync(join(primary, 'tracked.txt'), 'tracked');
  git(primary, ['add', '-A']);
  git(primary, ['commit', '-qm', 'fixture']);

  let root = primary;
  if (layout === 'linked') {
    root = join(base, 'linked');
    git(primary, ['worktree', 'add', '-q', '-b', 'linked-fixture', root]);
  }
  writeFileSync(join(root, 'ignored.txt'), 'ignored');

  const runtimeRoot = join(root, '.rn-agent', 'runtime');
  const metroHome = join(runtimeRoot, 'metro-home');
  const metroBinRoot = join(runtimeRoot, 'metro-bin');
  mkdirSync(metroHome, { recursive: true });
  mkdirSync(metroBinRoot, { recursive: true });

  const expoUpdatesRoot = join(root, 'node_modules', 'expo-updates');
  const cliPath = join(expoUpdatesRoot, 'bin', 'cli.js');
  mkdirSync(dirname(cliPath), { recursive: true });
  writeFileSync(
    join(expoUpdatesRoot, 'package.json'),
    JSON.stringify({ name: 'expo-updates', version: '0.0.0', main: 'bin/cli.js' }),
  );
  // Stands in for `runtimeversion:resolve` under the fingerprint policy: @expo/fingerprint shells
  // out to git through PATH to read the repository root and the ignore rules.
  writeFileSync(
    cliPath,
    `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const git = (args) => {
  const result = spawnSync('git', args, { cwd: process.cwd(), encoding: 'utf8' });
  return { code: result.error ? result.error.code : null, status: result.status };
};
console.log(
  JSON.stringify({
    args: process.argv.slice(2),
    help: git(['--help']),
    root: git(['rev-parse', '--show-toplevel']),
    ignored: git(['check-ignore', '-q', 'ignored.txt']),
    tracked: git(['check-ignore', '-q', 'tracked.txt']),
  }),
);
`,
  );
  chmodSync(cliPath, 0o755);

  const intruderPath = join(expoUpdatesRoot, 'bin', 'intruder.js');
  writeFileSync(intruderPath, '#!/usr/bin/env node\nconsole.log("intruder");\n');
  chmodSync(intruderPath, 0o755);

  const commandPath = join(root, 'metro-command.cjs');
  writeFileSync(
    commandPath,
    `const { spawnSync } = require('node:child_process');
const run = (executable) => {
  const result = spawnSync(executable, ['runtimeversion:resolve', '--platform', 'ios'], {
    cwd: ${JSON.stringify(root)},
    encoding: 'utf8',
  });
  return { code: result.error ? result.error.code : null, status: result.status, stdout: (result.stdout || '').trim() };
};
console.log(JSON.stringify({ cli: run(${JSON.stringify(cliPath)}), intruder: run(${JSON.stringify(intruderPath)}) }));
`,
  );

  return {
    base,
    commandPath,
    intruderPath,
    metroBinRoot,
    metroHome,
    profilePath: join(runtimeRoot, 'profile.sb'),
    root,
    runtimeRoot,
  };
}

function enforcementPlan(harness: Harness): ManagedMetroEnforcementPlan | null {
  const enforcement = prepareManagedMetroEnforcement({
    platform: 'darwin',
    appRoot: harness.root,
    sourceRoot: harness.root,
    runtimeRoot: harness.runtimeRoot,
    nodeExecutable: realpathSync(process.execPath),
    nodeVersion: process.version,
    commandExecutable: harness.commandPath,
    commandArguments: [],
    port: 8099,
    instanceId: 'manifest-utility-sandbox',
    runtimeInputs: [],
  });
  if (enforcement.status !== 'enforced') {
    // This host cannot enforce at all, so manifest-utility admission is not provable here.
    assert.ok(
      ['sandbox-executable-unverified', 'node-runtime-unverified'].includes(enforcement.reason),
      JSON.stringify(enforcement),
    );
    return null;
  }
  return enforcement;
}

function runManifestLane(harness: Harness, plan: ManagedMetroEnforcementPlan, gitPath: string) {
  writeFileSync(harness.profilePath, plan.profile);
  const shim = join(harness.metroBinRoot, 'git');
  rmSync(shim, { force: true });
  symlinkSync(gitPath, shim);
  return spawnSync(
    '/usr/bin/sandbox-exec',
    ['-f', harness.profilePath, realpathSync(process.execPath), harness.commandPath],
    {
      cwd: harness.root,
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: harness.metroHome,
        PATH: [harness.metroBinRoot, process.env.PATH].filter(Boolean).join(':'),
      },
    },
  );
}

function assertFingerprintProbesSucceeded(stdout: string): void {
  const observed = JSON.parse(stdout.trim()) as {
    cli: { code: string | null; status: number | null; stdout: string };
    intruder: { code: string | null; status: number | null };
  };
  assert.equal(observed.cli.code, null, 'the expo-updates CLI must be admitted, not EPERM');
  assert.equal(observed.cli.status, 0);
  const resolved = JSON.parse(observed.cli.stdout) as {
    args: string[];
    help: { code: string | null; status: number | null };
    root: { code: string | null; status: number | null };
    ignored: { code: string | null; status: number | null };
    tracked: { code: string | null; status: number | null };
  };
  assert.deepEqual(resolved.args, ['runtimeversion:resolve', '--platform', 'ios']);
  assert.deepEqual(resolved.help, { code: null, status: 0 });
  assert.deepEqual(resolved.root, { code: null, status: 0 });
  assert.deepEqual(resolved.ignored, { code: null, status: 0 });
  assert.deepEqual(resolved.tracked, { code: null, status: 1 });
  assert.equal(
    observed.intruder.code,
    'EPERM',
    'only the canonical expo-updates CLI may execute in the manifest utility lane',
  );
}

for (const layout of ['plain', 'linked'] as const) {
  test(
    `the manifest utility lane resolves a fingerprint runtime version under the enforced profile in a ${layout} git repository`,
    { skip: unsupportedPlatform },
    () => {
      const harness = createHarness(layout);
      try {
        const utility = resolveManagedMetroManifestUtility({
          platform: 'darwin',
          appRoot: harness.root,
          sourceRoot: harness.root,
        });
        assert.equal(utility.status, 'admitted', JSON.stringify(utility));
        if (utility.status !== 'admitted') return;
        assert.equal(
          utility.expoUpdatesCli,
          realpathSync(join(harness.root, 'node_modules', 'expo-updates', 'bin', 'cli.js')),
        );
        if (!utility.git) {
          // No verified developer git on this host: the lane cannot be proven end to end here.
          return;
        }
        assert.equal(
          utility.gitRepositoryRoots.length > 0,
          layout === 'linked',
          JSON.stringify(utility.gitRepositoryRoots),
        );

        const plan = enforcementPlan(harness);
        if (!plan) return;
        const result = runManifestLane(harness, plan, utility.git);
        assert.equal(result.status, 0, result.stderr);
        assertFingerprintProbesSucceeded(result.stdout);
      } finally {
        rmSync(harness.base, { force: true, recursive: true });
      }
    },
  );
}

test(
  'projects without expo-updates admit no manifest utility executables',
  { skip: unsupportedPlatform },
  () => {
    const harness = createHarness();
    try {
      rmSync(join(harness.root, 'node_modules'), { force: true, recursive: true });
      assert.deepEqual(
        resolveManagedMetroManifestUtility({
          platform: 'darwin',
          appRoot: harness.root,
          sourceRoot: harness.root,
        }),
        { status: 'absent' },
      );
      const plan = enforcementPlan(harness);
      if (!plan) return;
      assert.equal(plan.profile.includes('expo-updates'), false);
      assert.equal(plan.profile.includes('/usr/bin/git'), false);
    } finally {
      rmSync(harness.base, { force: true, recursive: true });
    }
  },
);

test(
  'an expo-updates CLI outside the supported dependency roots refuses enforcement instead of failing silently',
  { skip: unsupportedPlatform },
  () => {
    const harness = createHarness();
    try {
      const external = join(harness.base, 'external', 'expo-updates', 'bin');
      mkdirSync(external, { recursive: true });
      writeFileSync(join(external, 'cli.js'), 'module.exports = {};\n');
      const utility = resolveManagedMetroManifestUtility(
        { platform: 'darwin', appRoot: harness.root, sourceRoot: harness.root },
        { resolveFrom: () => join(external, 'cli.js') },
      );
      assert.deepEqual(utility, { status: 'unowned' });

      const enforcement = prepareManagedMetroEnforcement(
        {
          platform: 'darwin',
          appRoot: harness.root,
          sourceRoot: harness.root,
          runtimeRoot: harness.runtimeRoot,
          nodeExecutable: realpathSync(process.execPath),
          nodeVersion: process.version,
          commandExecutable: harness.commandPath,
          commandArguments: [],
          port: 8099,
          instanceId: 'manifest-utility-unowned',
          runtimeInputs: [],
        },
        { resolveFrom: () => join(external, 'cli.js') },
      );
      assert.deepEqual(enforcement, {
        status: 'unsupported',
        reason: 'manifest-utility-unowned',
      });
    } finally {
      rmSync(harness.base, { force: true, recursive: true });
    }
  },
);
