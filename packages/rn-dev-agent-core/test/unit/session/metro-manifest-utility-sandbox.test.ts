import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
  commandPath: string;
  intruderPath: string;
  metroHome: string;
  profilePath: string;
  root: string;
}

function createHarness(): Harness {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'rn-manifest-sandbox-')));
  const runtimeRoot = join(root, '.rn-agent', 'runtime');
  const metroHome = join(runtimeRoot, 'metro-home');
  mkdirSync(metroHome, { recursive: true });
  execFileSync('git', ['init', '-q', root]);
  writeFileSync(join(root, '.gitignore'), 'ignored.txt\n');
  writeFileSync(join(root, 'ignored.txt'), 'ignored');
  writeFileSync(join(root, 'tracked.txt'), 'tracked');

  const expoUpdatesRoot = join(root, 'node_modules', 'expo-updates');
  const cliPath = join(expoUpdatesRoot, 'bin', 'cli.js');
  mkdirSync(dirname(cliPath), { recursive: true });
  writeFileSync(join(expoUpdatesRoot, 'package.json'), JSON.stringify({ name: 'expo-updates' }));
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

  const intruderPath = join(root, 'node_modules', 'expo-updates', 'bin', 'intruder.js');
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
    commandPath,
    intruderPath,
    metroHome,
    profilePath: join(runtimeRoot, 'profile.sb'),
    root,
  };
}

function enforcementPlan(harness: Harness): ManagedMetroEnforcementPlan {
  const enforcement = prepareManagedMetroEnforcement({
    platform: 'darwin',
    appRoot: harness.root,
    sourceRoot: harness.root,
    runtimeRoot: join(harness.root, '.rn-agent', 'runtime'),
    nodeExecutable: realpathSync(process.execPath),
    nodeVersion: process.version,
    commandExecutable: harness.commandPath,
    commandArguments: [],
    port: 8099,
    instanceId: 'manifest-utility-sandbox',
    runtimeInputs: [],
  });
  assert.equal(enforcement.status, 'enforced', JSON.stringify(enforcement));
  return enforcement as ManagedMetroEnforcementPlan;
}

test(
  'the manifest utility lane resolves a fingerprint runtime version under the enforced profile',
  { skip: unsupportedPlatform },
  () => {
    const harness = createHarness();
    try {
      const utility = resolveManagedMetroManifestUtility({
        platform: 'darwin',
        appRoot: harness.root,
        sourceRoot: harness.root,
      });
      assert.equal(
        utility.expoUpdatesCli,
        realpathSync(join(harness.root, 'node_modules', 'expo-updates', 'bin', 'cli.js')),
      );
      if (!utility.git) {
        // No verified developer git on this host: the lane cannot be proven end to end here.
        return;
      }

      const plan = enforcementPlan(harness);
      writeFileSync(harness.profilePath, plan.profile);
      const result = spawnSync(
        '/usr/bin/sandbox-exec',
        ['-f', harness.profilePath, realpathSync(process.execPath), harness.commandPath],
        {
          cwd: harness.root,
          encoding: 'utf8',
          env: {
            ...process.env,
            HOME: harness.metroHome,
            PATH: [dirname(utility.git), process.env.PATH].filter(Boolean).join(':'),
          },
        },
      );
      assert.equal(result.status, 0, result.stderr);
      const observed = JSON.parse(result.stdout.trim()) as {
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
    } finally {
      rmSync(harness.root, { force: true, recursive: true });
    }
  },
);

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
        { expoUpdatesCli: null, git: null, gitConfigRoot: null },
      );
      const plan = enforcementPlan(harness);
      assert.equal(plan.profile.includes('expo-updates'), false);
      assert.equal(plan.profile.includes('/usr/bin/git'), false);
    } finally {
      rmSync(harness.root, { force: true, recursive: true });
    }
  },
);
