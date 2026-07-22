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
const sourceMapPath = join(repoRoot, 'packages', 'shared-agent-knowledge', 'source-map.json');
const sourceMap = JSON.parse(readFileSync(sourceMapPath, 'utf8'));
const codexAdaptation = sourceMap.hostAdaptations?.codex;
if (!codexAdaptation) {
  console.error('build-host-runtimes: source-map.json is missing hostAdaptations.codex');
  process.exit(1);
}
const CODEX_COMMAND_SKILLS = codexAdaptation.commandSkills;
if (
  !Array.isArray(CODEX_COMMAND_SKILLS) ||
  CODEX_COMMAND_SKILLS.length !== 15 ||
  new Set(CODEX_COMMAND_SKILLS).size !== 15
) {
  console.error('build-host-runtimes: Codex command-skill inventory must contain 15 unique names');
  process.exit(1);
}
const CODEX_DOMAIN_SKILLS = new Set(codexAdaptation.adaptedDomainSkills ?? []);
for (const name of CODEX_COMMAND_SKILLS) {
  if (CODEX_DOMAIN_SKILLS.has(name)) {
    console.error(`build-host-runtimes: Codex command skill collides with domain skill: ${name}`);
    process.exit(1);
  }
}
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
const SHARED_HOST_HELPER_SCRIPTS = [
  'collect-feedback.sh',
  'expo_ensure_running.sh',
  'eas_resolve_artifact.sh',
  'check-vercel-rules.mjs',
  'snapshot_state.sh',
];

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

// Generate the exact fifteen explicit-only Codex workflow skill adapters. The
// long workflow bodies stay in package-local commands/*.md; these marker-owned
// wrappers provide a native $skill surface without relying on Codex's
// best-effort command migration.
for (const name of CODEX_COMMAND_SKILLS) {
  const commandPath = join(codexPluginRoot, 'commands', `${name}.md`);
  if (!existsSync(commandPath)) {
    console.error(`build-host-runtimes: missing Codex workflow playbook: commands/${name}.md`);
    process.exit(1);
  }
  const command = readFileSync(commandPath, 'utf8');
  const description =
    command.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? `Run the ${name} workflow.`;
  const skillRoot = join(codexPluginRoot, 'skills', name);
  rmSync(skillRoot, { recursive: true, force: true });
  mkdirSync(join(skillRoot, 'agents'), { recursive: true });
  writeFileSync(
    join(skillRoot, 'SKILL.md'),
    `<!-- GENERATED by scripts/build-host-runtimes.ts from packages/shared-agent-knowledge/source-map.json. DO NOT EDIT. -->\n---\nname: ${name}\ndescription: ${JSON.stringify(`Explicit Codex workflow: ${description}`)}\n---\n\n# ${name}\n\nInvoke this workflow explicitly as \`$rn-dev-agent:${name} [request text]\`.\n\nThe exact text after the skill mention is the conceptual **request**. It is user-message data, not a shell variable or a Claude command-template substitution. Preserve it while applying the workflow's documented grammar; pass only separately parsed and validated values to MCP tools or package helpers. Never use \`eval\` or interpolate the raw request into a shell command.\n\nRead [the complete package-local workflow](../../commands/${name}.md) before acting. Resolve that file and every helper relative to this exact \`SKILL.md\` path; never scan Codex caches or rely on a plugin-root environment variable. If a required \`cdp\` MCP tool is absent from the active task, stop and use the read-only discovery diagnosis. Do not substitute raw Maestro for rn-dev-agent strict proof.\n`,
    'utf8',
  );
  const displayName = name
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
  writeFileSync(
    join(skillRoot, 'agents', 'openai.yaml'),
    `# GENERATED by scripts/build-host-runtimes.ts. DO NOT EDIT.\ninterface:\n  display_name: ${JSON.stringify(displayName)}\n  short_description: ${JSON.stringify(`Run the ${name} workflow explicitly`)}\n  default_prompt: ${JSON.stringify(`Use $rn-dev-agent:${name} to run this workflow.`)}\npolicy:\n  allow_implicit_invocation: false\n`,
    'utf8',
  );
}

// Build the read-only Codex package health executable from TypeScript. Its
// installed package identity comes from import.meta.url, never from cache scans.
const healthSource = join(codexPluginRoot, 'src', 'plugin-health.ts');
if (!existsSync(healthSource)) {
  console.error(`build-host-runtimes: missing Codex health source at ${healthSource}`);
  process.exit(1);
}
const healthOutput = join(codexPluginRoot, 'bin', 'plugin-health.js');
const healthBuild = spawnSync(
  esbuild,
  [
    healthSource,
    '--bundle',
    '--platform=node',
    '--format=esm',
    '--packages=bundle',
    `--outfile=${healthOutput}`,
    '--log-level=warning',
  ],
  { cwd: repoRoot, stdio: 'inherit' },
);
if (healthBuild.error) {
  console.error(
    `build-host-runtimes: failed to build Codex health program: ${healthBuild.error.message}`,
  );
  process.exit(1);
}
if (healthBuild.status !== 0) process.exit(healthBuild.status ?? 1);

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
  mkdirSync(join(runtimeRoot, 'schemas'), { recursive: true });
  copyFileSync(
    join(coreRoot, 'schemas', 'proof-receipt.schema.json'),
    join(runtimeRoot, 'schemas', 'proof-receipt.schema.json'),
  );
}

const codexAgentsTemplateSource = join(codexPluginRoot, 'src', 'AGENTS-MD-TEMPLATE.md');
if (!existsSync(codexAgentsTemplateSource)) {
  console.error(
    `build-host-runtimes: missing Codex AGENTS template at ${codexAgentsTemplateSource}`,
  );
  process.exit(1);
}
copyFileSync(codexAgentsTemplateSource, join(codexPluginRoot, 'AGENTS-MD-TEMPLATE.md'));

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

for (const hostRoot of [codexPluginRoot, claudePluginRoot]) {
  for (const script of SHARED_HOST_HELPER_SCRIPTS) {
    copyFileSync(join(repoRoot, 'scripts', script), join(hostRoot, 'scripts', script));
  }
}

for (const script of CLAUDE_HELPER_SCRIPTS) {
  copyFileSync(join(repoRoot, 'scripts', script), join(claudePluginRoot, 'scripts', script));
}
