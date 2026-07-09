#!/usr/bin/env node
// build-host-runtimes.ts — the SINGLE WRITER for every derived artifact in the
// host plugin packages (Claude + Codex). Marketplace installs copy ONLY the
// plugin package directory (no repo siblings, no npm install step), so each
// host package must be self-contained: bundled runtime, native runner sources,
// runner manifest, templates, and helper scripts all live inside the package.
// CI verifies by regenerating and diffing (scripts/check-dist-fresh.sh) —
// hand-editing any generated copy is always wrong; edit the source and rerun:
//   corepack yarn build:host-runtimes
const {
  cpSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { spawnSync } = require('node:child_process');
const { dirname, join } = require('node:path');

const repoRoot = dirname(__dirname);
const coreRoot = join(repoRoot, 'packages', 'rn-dev-agent-core');
const corePackageJson = join(coreRoot, 'package.json');
const codexPluginRoot = join(repoRoot, 'packages', 'codex-plugin');
const claudePluginRoot = join(repoRoot, 'packages', 'claude-plugin');
const observeWebDistSource = join(coreRoot, 'dist', 'observability', 'web-dist');
const esbuild = join(
  repoRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'esbuild.cmd' : 'esbuild',
);

const RUNTIME_ENTRIES = ['supervisor.js', 'index.js', 'learned-actions.js'];

// Helper scripts the Claude package's hooks and skills invoke at runtime.
// The SessionStart hook (hooks/detect-rn-project.sh) resolves them from
// ${CLAUDE_PLUGIN_ROOT}/scripts; a marketplace install has no repo scripts/.
const CLAUDE_HELPER_SCRIPTS = [
  'mcp-bridge-probe.mjs',
  'ensure-cdp-deps.sh',
  'ensure-maestro-runner.sh',
  'ensure-idb-companion.sh',
  'ensure-idb.sh',
  'ensure-ffmpeg.sh',
  'ensure-troubleshooting-doc.sh',
  'ensure-android-ready.sh',
  'check-physical-devices.sh',
  'check-vercel-rules.mjs',
];

for (const file of RUNTIME_ENTRIES) {
  if (!existsSync(join(coreRoot, 'dist', file))) {
    console.error(`build-host-runtimes: missing core runtime entry at dist/${file}`);
    console.error('Run: corepack yarn workspace rn-dev-agent-core build');
    process.exit(1);
  }
}

if (!existsSync(observeWebDistSource)) {
  console.error(`build-host-runtimes: missing observe web bundle at ${observeWebDistSource}`);
  console.error('Run: corepack yarn workspace rn-dev-agent-core build:web');
  process.exit(1);
}

if (!existsSync(esbuild)) {
  console.error(`build-host-runtimes: missing esbuild binary at ${esbuild}`);
  console.error('Run: corepack yarn install');
  process.exit(1);
}

const corePackage = JSON.parse(readFileSync(corePackageJson, 'utf8'));

function copyCleanDir(source, target, excludeSubdirs = []) {
  rmSync(target, { recursive: true, force: true });
  mkdirSync(dirname(target), { recursive: true });
  const excluded = excludeSubdirs.map((sub) => join(source, sub));
  cpSync(source, target, {
    recursive: true,
    // Prune build output at copy time: DerivedData's compilation cache is a
    // hardlink/clone-dedup'd store, so copying it materializes multi-GB of
    // transient data (ENOSPC) even when the source du reads small.
    filter: (src) => !excluded.includes(src),
  });
}

const RUNNER_BUILD_OUTPUT = {
  'rn-fast-runner': ['build', join('RnFastRunner', 'DerivedData')],
  'rn-android-runner': ['.gradle', join('app', 'build')],
};

// Bundle each runtime entry ONCE into the Codex package, then byte-copy into
// the Claude package — the two host runtimes are identical by construction
// (check-agent-package-sync.sh asserts it).
const codexRuntimeRoot = join(codexPluginRoot, 'rn-dev-agent-core');
const claudeRuntimeRoot = join(claudePluginRoot, 'rn-dev-agent-core');
mkdirSync(join(codexRuntimeRoot, 'dist'), { recursive: true });
mkdirSync(join(claudeRuntimeRoot, 'dist'), { recursive: true });

for (const file of RUNTIME_ENTRIES) {
  const result = spawnSync(
    esbuild,
    [
      join(coreRoot, 'dist', file),
      '--bundle',
      '--platform=node',
      '--format=esm',
      '--packages=bundle',
      '--banner:js=import { createRequire as __rnCreateRequire } from "node:module"; const require = __rnCreateRequire(import.meta.url);',
      `--outfile=${join(codexRuntimeRoot, 'dist', file)}`,
      '--log-level=warning',
    ],
    {
      cwd: repoRoot,
      stdio: 'inherit',
    },
  );

  if (result.error) {
    console.error(`build-host-runtimes: failed to run esbuild: ${result.error.message}`);
    process.exit(1);
  }

  if (result.status !== 0) process.exit(result.status ?? 1);
  copyFileSync(join(codexRuntimeRoot, 'dist', file), join(claudeRuntimeRoot, 'dist', file));
}

for (const [runtimeRoot, runtimeName] of [
  [codexRuntimeRoot, 'rn-dev-agent-core-codex-runtime'],
  [claudeRuntimeRoot, 'rn-dev-agent-core-claude-runtime'],
]) {
  writeFileSync(
    join(runtimeRoot, 'package.json'),
    JSON.stringify(
      {
        name: runtimeName,
        version: corePackage.version,
        private: true,
        type: 'module',
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );
  copyCleanDir(observeWebDistSource, join(runtimeRoot, 'dist', 'observability', 'web-dist'));
  copyCleanDir(observeWebDistSource, join(runtimeRoot, 'dist', 'web-dist'));
}

for (const hostRoot of [codexPluginRoot, claudePluginRoot]) {
  mkdirSync(join(hostRoot, 'scripts'), { recursive: true });
  copyFileSync(join(repoRoot, 'runner-manifest.json'), join(hostRoot, 'runner-manifest.json'));
  copyFileSync(join(repoRoot, 'CLAUDE-MD-TEMPLATE.md'), join(hostRoot, 'CLAUDE-MD-TEMPLATE.md'));
  copyFileSync(
    join(repoRoot, 'scripts', 'record_proof.sh'),
    join(hostRoot, 'scripts', 'record_proof.sh'),
  );
  for (const runnerName of ['rn-fast-runner', 'rn-android-runner']) {
    const target = join(hostRoot, 'scripts', runnerName);
    copyCleanDir(join(repoRoot, 'packages', runnerName), target, RUNNER_BUILD_OUTPUT[runnerName]);
  }
}

for (const script of CLAUDE_HELPER_SCRIPTS) {
  copyFileSync(join(repoRoot, 'scripts', script), join(claudePluginRoot, 'scripts', script));
}
