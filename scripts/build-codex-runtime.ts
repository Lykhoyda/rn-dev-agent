#!/usr/bin/env node
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
const runtimeRoot = join(repoRoot, 'packages', 'codex-plugin', 'rn-dev-agent-core');
const codexPluginRoot = join(repoRoot, 'packages', 'codex-plugin');
const packageJson = join(runtimeRoot, 'package.json');
const observeWebDistSource = join(coreRoot, 'dist', 'observability', 'web-dist');
const observeWebDistTarget = join(runtimeRoot, 'dist', 'observability', 'web-dist');
const observeWebDistBundledTarget = join(runtimeRoot, 'dist', 'web-dist');
const esbuild = join(
  repoRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'esbuild.cmd' : 'esbuild',
);

const entries = ['supervisor.js', 'index.js', 'learned-actions.js'].map((file) => ({
  input: join(coreRoot, 'dist', file),
  output: join(runtimeRoot, 'dist', file),
}));

for (const entry of entries) {
  if (!existsSync(entry.input)) {
    console.error(`build-codex-runtime: missing core runtime entry at ${entry.input}`);
    console.error('Run: corepack yarn workspace rn-dev-agent-core build');
    process.exit(1);
  }
}

if (!existsSync(observeWebDistSource)) {
  console.error(`build-codex-runtime: missing observe web bundle at ${observeWebDistSource}`);
  console.error('Run: corepack yarn workspace rn-dev-agent-core build:web');
  process.exit(1);
}

if (!existsSync(esbuild)) {
  console.error(`build-codex-runtime: missing esbuild binary at ${esbuild}`);
  console.error('Run: corepack yarn install');
  process.exit(1);
}

const corePackage = JSON.parse(readFileSync(corePackageJson, 'utf8'));
mkdirSync(join(runtimeRoot, 'dist'), { recursive: true });
mkdirSync(join(codexPluginRoot, 'scripts'), { recursive: true });
writeFileSync(
  packageJson,
  JSON.stringify(
    {
      name: 'rn-dev-agent-core-codex-runtime',
      version: corePackage.version,
      private: true,
      type: 'module',
    },
    null,
    2,
  ) + '\n',
  'utf8',
);

function copyCleanDir(source, target) {
  rmSync(target, { recursive: true, force: true });
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, { recursive: true });
}

copyCleanDir(observeWebDistSource, observeWebDistTarget);
copyCleanDir(observeWebDistSource, observeWebDistBundledTarget);
copyFileSync(join(repoRoot, 'runner-manifest.json'), join(codexPluginRoot, 'runner-manifest.json'));
copyCleanDir(
  join(repoRoot, 'packages', 'rn-fast-runner'),
  join(codexPluginRoot, 'scripts', 'rn-fast-runner'),
);
copyCleanDir(
  join(repoRoot, 'packages', 'rn-android-runner'),
  join(codexPluginRoot, 'scripts', 'rn-android-runner'),
);

for (const path of [
  join(codexPluginRoot, 'scripts', 'rn-fast-runner', 'build'),
  join(codexPluginRoot, 'scripts', 'rn-fast-runner', 'RnFastRunner', 'DerivedData'),
  join(codexPluginRoot, 'scripts', 'rn-android-runner', '.gradle'),
  join(codexPluginRoot, 'scripts', 'rn-android-runner', 'app', 'build'),
]) {
  rmSync(path, { recursive: true, force: true });
}

for (const entry of entries) {
  const result = spawnSync(
    esbuild,
    [
      entry.input,
      '--bundle',
      '--platform=node',
      '--format=esm',
      '--packages=bundle',
      '--banner:js=import { createRequire as __rnCreateRequire } from "node:module"; const require = __rnCreateRequire(import.meta.url);',
      `--outfile=${entry.output}`,
      '--log-level=warning',
    ],
    {
      cwd: repoRoot,
      stdio: 'inherit',
    },
  );

  if (result.error) {
    console.error(`build-codex-runtime: failed to run esbuild: ${result.error.message}`);
    process.exit(1);
  }

  if (result.status !== 0) process.exit(result.status ?? 1);
}
