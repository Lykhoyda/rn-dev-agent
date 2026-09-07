import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
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

  const autolinkingCliPath = join(
    root,
    'node_modules',
    'expo-modules-autolinking',
    'bin',
    'expo-modules-autolinking.js',
  );
  mkdirSync(dirname(autolinkingCliPath), { recursive: true });
  writeFileSync(autolinkingCliPath, '#!/usr/bin/env node\nconsole.log("autolinking");\n');
  chmodSync(autolinkingCliPath, 0o755);

  const expoUpdatesRoot = join(root, 'node_modules', 'expo-updates');
  const cliPath = join(expoUpdatesRoot, 'bin', 'cli.js');
  mkdirSync(dirname(cliPath), { recursive: true });
  writeFileSync(
    join(expoUpdatesRoot, 'package.json'),
    JSON.stringify({
      name: 'expo-updates',
      version: '0.0.0',
      main: 'bin/cli.js',
    }),
  );
  // Stands in for `runtimeversion:resolve` under the fingerprint policy: @expo/fingerprint shells
  // out to git through PATH for the repository root and ignore rules, and to `node <autolinking
  // cli>` through PATH for the core autolinking sources. Both names must resolve to an admitted
  // binary before execvp reaches a host PATH entry the profile denies.
  writeFileSync(
    cliPath,
    `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const probe = (command, args) => {
  const result = spawnSync(command, args, { cwd: process.cwd(), encoding: 'utf8' });
  return { code: result.error ? result.error.code : null, status: result.status };
};
const git = (args) => probe('git', args);
console.log(
  JSON.stringify({
    args: process.argv.slice(2),
    help: git(['--help']),
    root: git(['rev-parse', '--show-toplevel']),
    ignored: git(['check-ignore', '-q', 'ignored.txt']),
    tracked: git(['check-ignore', '-q', 'tracked.txt']),
    autolinking: probe('node', [
      ${JSON.stringify(autolinkingCliPath)},
      'react-native-config',
      '--json',
      '--platform',
      'ios',
    ]),
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
console.log(JSON.stringify({ cli: run(${JSON.stringify(
      cliPath,
    )}), intruder: run(${JSON.stringify(intruderPath)}) }));
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

function enforcementPlan(
  harness: Harness,
  protectedRuntimeRoots: readonly string[] = [],
): ManagedMetroEnforcementPlan | null {
  const enforcement = prepareManagedMetroEnforcement({
    platform: 'darwin',
    appRoot: harness.root,
    sourceRoot: harness.root,
    runtimeRoot: harness.runtimeRoot,
    nodeExecutable: realpathSync(process.execPath),
    nodeVersion: process.version,
    commandExecutable: harness.commandPath,
    commandArguments: [],
    protectedRuntimeRoots,
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
  for (const [name, target] of [
    ['git', gitPath],
    ['node', realpathSync(process.execPath)],
  ]) {
    const shim = join(harness.metroBinRoot, name);
    rmSync(shim, { force: true });
    symlinkSync(target, shim);
  }
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
    autolinking: { code: string | null; status: number | null };
  };
  assert.deepEqual(resolved.args, ['runtimeversion:resolve', '--platform', 'ios']);
  assert.deepEqual(resolved.help, { code: null, status: 0 });
  assert.deepEqual(resolved.root, { code: null, status: 0 });
  assert.deepEqual(resolved.ignored, { code: null, status: 0 });
  assert.deepEqual(resolved.tracked, { code: null, status: 1 });
  assert.deepEqual(
    resolved.autolinking,
    { code: null, status: 0 },
    'the core autolinking sources must be computed, not silently dropped on a denied spawn',
  );
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
        assert.equal(
          utility.expoUpdatesCli,
          realpathSync(join(harness.root, 'node_modules', 'expo-updates', 'bin', 'cli.js')),
        );
        if (!utility.git) {
          // No verified developer git on this host: the lane cannot be proven end to end here.
          assert.notEqual(utility.outcome, 'admitted', JSON.stringify(utility));
          return;
        }
        assert.equal(utility.outcome, 'admitted', JSON.stringify(utility));
        assert.equal(
          utility.gitRepositoryRoots.length > 0,
          layout === 'linked',
          JSON.stringify(utility.gitRepositoryRoots),
        );

        const plan = enforcementPlan(harness, [harness.metroBinRoot]);
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
      rmSync(join(harness.root, 'node_modules'), {
        force: true,
        recursive: true,
      });
      assert.deepEqual(
        resolveManagedMetroManifestUtility({
          platform: 'darwin',
          appRoot: harness.root,
          sourceRoot: harness.root,
        }),
        {
          outcome: 'expo-updates-cli-unresolved',
          expoUpdatesCli: null,
          git: null,
          gitRepositoryRoots: [],
        },
      );
      const plan = enforcementPlan(harness);
      if (!plan) return;
      assert.equal(plan.manifestUtility, 'expo-updates-cli-unresolved');
    } finally {
      rmSync(harness.base, { force: true, recursive: true });
    }
  },
);

test(
  'an expo-updates CLI outside the supported dependency roots adds no grant and keeps enforcement on',
  { skip: unsupportedPlatform },
  () => {
    const harness = createHarness();
    try {
      const external = join(harness.base, 'external', 'expo-updates', 'bin');
      mkdirSync(external, { recursive: true });
      const externalCli = join(external, 'cli.js');
      writeFileSync(externalCli, '#!/usr/bin/env node\nconsole.log("external");\n');
      chmodSync(externalCli, 0o755);
      const resolveFrom = () => externalCli;
      assert.deepEqual(
        resolveManagedMetroManifestUtility(
          {
            platform: 'darwin',
            appRoot: harness.root,
            sourceRoot: harness.root,
          },
          { resolveFrom },
        ),
        {
          outcome: 'expo-updates-cli-unowned',
          expoUpdatesCli: null,
          git: null,
          gitRepositoryRoots: [],
        },
      );

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
        { resolveFrom },
      );
      if (enforcement.status !== 'enforced') {
        assert.ok(
          ['sandbox-executable-unverified', 'node-runtime-unverified'].includes(enforcement.reason),
          JSON.stringify(enforcement),
        );
        return;
      }
      assert.equal(enforcement.manifestUtility, 'expo-updates-cli-unowned');

      writeFileSync(harness.profilePath, enforcement.profile);
      const probePath = join(harness.root, 'external-cli-probe.cjs');
      writeFileSync(
        probePath,
        `const { spawnSync } = require('node:child_process');
const result = spawnSync(${JSON.stringify(externalCli)}, ['runtimeversion:resolve', '--platform', 'ios'], {
  encoding: 'utf8',
});
console.log(JSON.stringify({ code: result.error ? result.error.code : null, status: result.status }));
`,
      );
      const probe = spawnSync(
        '/usr/bin/sandbox-exec',
        ['-f', harness.profilePath, realpathSync(process.execPath), probePath],
        { cwd: harness.root, encoding: 'utf8', env: { ...process.env, HOME: harness.metroHome } },
      );
      assert.equal(probe.status, 0, probe.stderr);
      assert.deepEqual(JSON.parse(probe.stdout.trim()), { code: 'EPERM', status: null });
    } finally {
      rmSync(harness.base, { force: true, recursive: true });
    }
  },
);

function developerDirProbes(harness: Harness, developerRoot: string) {
  return {
    run: (command: string, args: readonly string[]) => {
      if (command === '/usr/bin/xcode-select') {
        return {
          status: 0,
          stdout: `${developerRoot}\n`,
          stderr: '',
          signal: null,
        };
      }
      if (command === '/usr/bin/codesign' && args[0] === '--verify') {
        return { status: 0, stdout: '', stderr: '', signal: null };
      }
      return {
        status: 0,
        stdout: '',
        stderr: [
          'Identifier=com.apple.git',
          'CDHash=0123456789abcdef0123456789abcdef01234567',
          'Authority=Software Signing',
          'Authority=Apple Code Signing Certification Authority',
          'Authority=Apple Root CA',
        ].join('\n'),
        signal: null,
      };
    },
    stat: (path: string) => ({
      isFile: () => true,
      uid: path.endsWith('/usr/bin/git') ? 0 : 501,
      mode: 0o100755,
    }),
    readBytes: () => Buffer.from(`gitdir: ${join(harness.root, '.git')}\n`),
  };
}

test(
  'a developer directory reached through a symlink still admits the canonical git',
  { skip: unsupportedPlatform },
  () => {
    const harness = createHarness();
    try {
      const versioned = join(harness.base, 'Xcode-16.4.0.app', 'Contents', 'Developer');
      mkdirSync(join(versioned, 'usr', 'bin'), { recursive: true });
      writeFileSync(join(versioned, 'usr', 'bin', 'git'), '#!/bin/sh\nexit 0\n');
      const linked = join(harness.base, 'Xcode.app');
      symlinkSync(join(harness.base, 'Xcode-16.4.0.app'), linked);

      const utility = resolveManagedMetroManifestUtility(
        { platform: 'darwin', appRoot: harness.root, sourceRoot: harness.root },
        developerDirProbes(harness, join(linked, 'Contents', 'Developer')),
      );

      assert.equal(utility.outcome, 'admitted', JSON.stringify(utility));
      assert.equal(utility.git, join(versioned, 'usr', 'bin', 'git'));
    } finally {
      rmSync(harness.base, { force: true, recursive: true });
    }
  },
);

test(
  'an unverifiable developer git names the reason instead of reporting a silent admission',
  { skip: unsupportedPlatform },
  () => {
    const harness = createHarness();
    const cli = realpathSync(join(harness.root, 'node_modules', 'expo-updates', 'bin', 'cli.js'));
    try {
      assert.deepEqual(
        resolveManagedMetroManifestUtility(
          {
            platform: 'darwin',
            appRoot: harness.root,
            sourceRoot: harness.root,
          },
          {
            run: () => ({
              status: 1,
              stdout: '',
              stderr: 'no developer dir',
              signal: null,
            }),
          },
        ),
        {
          outcome: 'developer-dir-unavailable',
          expoUpdatesCli: cli,
          git: null,
          gitRepositoryRoots: [],
        },
      );

      const developerRoot = join(harness.base, 'Developer');
      mkdirSync(join(developerRoot, 'usr', 'bin'), { recursive: true });
      writeFileSync(join(developerRoot, 'usr', 'bin', 'git'), '#!/bin/sh\nexit 0\n');
      const untrusted = resolveManagedMetroManifestUtility(
        { platform: 'darwin', appRoot: harness.root, sourceRoot: harness.root },
        {
          ...developerDirProbes(harness, developerRoot),
          stat: () => ({ isFile: () => true, uid: 501, mode: 0o100777 }),
        },
      );
      assert.equal(untrusted.outcome, 'developer-git-untrusted');
      assert.equal(untrusted.git, null);
      assert.equal(untrusted.expoUpdatesCli, cli);
    } finally {
      rmSync(harness.base, { force: true, recursive: true });
    }
  },
);

test(
  'the sandboxed Metro child cannot remove or repoint the launcher-owned git shim',
  { skip: unsupportedPlatform },
  () => {
    const harness = createHarness();
    try {
      const shim = join(harness.metroBinRoot, 'git');
      rmSync(shim, { force: true });
      symlinkSync('/usr/bin/true', shim);
      assert.ok(existsSync(shim), 'the launcher creates the shim outside the sandbox');

      const plan = enforcementPlan(harness, [harness.metroBinRoot]);
      if (!plan) return;
      writeFileSync(harness.profilePath, plan.profile);

      const probePath = join(harness.root, 'shim-write-probe.cjs');
      writeFileSync(
        probePath,
        `const { unlinkSync, writeFileSync } = require('node:fs');
const attempt = (run) => {
  try {
    run();
    return null;
  } catch (error) {
    return error.code;
  }
};
console.log(
  JSON.stringify({
    unlinkShim: attempt(() => unlinkSync(${JSON.stringify(shim)})),
    createInBinRoot: attempt(() =>
      writeFileSync(${JSON.stringify(join(harness.metroBinRoot, 'intruder'))}, 'x'),
    ),
    writeElsewhereInRuntimeRoot: attempt(() =>
      writeFileSync(${JSON.stringify(join(harness.runtimeRoot, 'control.txt'))}, 'x'),
    ),
  }),
);
`,
      );

      const result = spawnSync(
        '/usr/bin/sandbox-exec',
        ['-f', harness.profilePath, realpathSync(process.execPath), probePath],
        { cwd: harness.root, encoding: 'utf8', env: { ...process.env, HOME: harness.metroHome } },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout.trim()), {
        unlinkShim: 'EPERM',
        createInBinRoot: 'EPERM',
        writeElsewhereInRuntimeRoot: null,
      });
      assert.ok(existsSync(shim), 'the shim survives the sandboxed write attempts');
    } finally {
      rmSync(harness.base, { force: true, recursive: true });
    }
  },
);
