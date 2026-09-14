#!/usr/bin/env node
// build-host-runtimes.ts — the SINGLE WRITER for every derived artifact in the
// distributed plugin package packages/claude-plugin. Both marketplaces (Claude
// and Codex) copy ONLY that directory (no repo siblings, no npm install step),
// so it must be self-contained: one bundled runtime, native runner sources,
// runner manifest, templates, helper scripts, and the Codex adapters generated
// from the packages/codex-plugin authoring tree all live inside it.
// CI verifies by regenerating and diffing (scripts/check-dist-fresh.sh) —
// hand-editing any generated copy is always wrong; edit the source and rerun:
//   corepack yarn build:host-runtimes
const {
  chmodSync,
  constants,
  cpSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { spawnSync } = require('node:child_process');
const { basename, dirname, join } = require('node:path');

const repoRoot = dirname(__dirname);
const coreRoot = join(repoRoot, 'packages', 'rn-dev-agent-core');
const corePackageJson = join(coreRoot, 'package.json');
const codexPluginRoot = join(repoRoot, 'packages', 'codex-plugin');
const claudePluginRoot = join(repoRoot, 'packages', 'claude-plugin');
const observeWebDistSource = join(coreRoot, 'dist', 'observability', 'web-dist');
const darwinProcessBirthHelper = join(coreRoot, 'native', 'darwin-process-birth');
const darwinProcessBirthManifest = `${darwinProcessBirthHelper}.json`;
const linuxConditionalPublicationHelpers = ['x64', 'arm64'].map((architecture) =>
  join(coreRoot, 'native', `linux-conditional-publication-${architecture}`),
);
const sourceMapPath = join(repoRoot, 'packages', 'shared-agent-knowledge', 'source-map.json');
const maestroRunnerPinManifest = join(coreRoot, 'src', 'domain', 'maestro-runner-pin.json');
const sourceMap = JSON.parse(readFileSync(sourceMapPath, 'utf8'));
const codexAdaptation = sourceMap.hostAdaptations?.codex;
if (!codexAdaptation) {
  console.error('build-host-runtimes: source-map.json is missing hostAdaptations.codex');
  process.exit(1);
}
const CODEX_COMMAND_SKILLS = codexAdaptation.commandSkills;
if (
  !Array.isArray(CODEX_COMMAND_SKILLS) ||
  CODEX_COMMAND_SKILLS.length !== 17 ||
  new Set(CODEX_COMMAND_SKILLS).size !== 17
) {
  console.error('build-host-runtimes: Codex command-skill inventory must contain 17 unique names');
  process.exit(1);
}
const CODEX_DOMAIN_SKILLS = codexAdaptation.adaptedDomainSkills ?? [];
if (CODEX_DOMAIN_SKILLS.length !== 11 || new Set(CODEX_DOMAIN_SKILLS).size !== 11) {
  console.error('build-host-runtimes: Codex domain-skill inventory must contain 11 unique names');
  process.exit(1);
}
for (const name of CODEX_COMMAND_SKILLS) {
  if (CODEX_DOMAIN_SKILLS.includes(name)) {
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

const processBirthHelperBuild = spawnSync(
  process.execPath,
  [join(repoRoot, 'scripts', 'build-darwin-process-birth-helper.ts')],
  {
    cwd: repoRoot,
    stdio: 'inherit',
  },
);
if (processBirthHelperBuild.error) {
  console.error(
    `build-host-runtimes: failed to build Darwin process helper: ${processBirthHelperBuild.error.message}`,
  );
  process.exit(1);
}
if (processBirthHelperBuild.status !== 0) {
  process.exit(processBirthHelperBuild.status ?? 1);
}
const conditionalPublicationHelperBuild = spawnSync(
  process.execPath,
  [join(repoRoot, 'scripts', 'build-linux-conditional-publication-helper.ts')],
  { cwd: repoRoot, stdio: 'inherit' },
);
if (conditionalPublicationHelperBuild.error) {
  console.error(
    `build-host-runtimes: failed to verify Linux publication helpers: ${conditionalPublicationHelperBuild.error.message}`,
  );
  process.exit(1);
}
if (conditionalPublicationHelperBuild.status !== 0) {
  process.exit(conditionalPublicationHelperBuild.status ?? 1);
}

const RUNTIME_ENTRIES = [
  'supervisor.js',
  'index.js',
  'learned-actions.js',
  'sqlite-warning-filter.js',
  'startup-integrity-loader.js',
  'startup-integrity-register.js',
  'rn-session.js',
  'session-doctor.js',
  'experience-trends.js',
  'worktree-inheritance.js',
  'workflow-check.js',
  'maestro-runner-pin.js',
];

// Helper scripts the packaged hooks, skills, and Codex playbooks invoke at
// runtime. The SessionStart hook (hooks/detect-rn-project.sh) resolves them
// from ${CLAUDE_PLUGIN_ROOT}/scripts; a marketplace install has no repo scripts/.
const SHARED_HOST_HELPER_SCRIPTS = [
  'collect-feedback.sh',
  'generate_pr_body.sh',
  'expo_ensure_running.sh',
  'eas_resolve_artifact.sh',
  'check-vercel-rules.mjs',
  'snapshot_state.sh',
  'ensure-maestro-runner.sh',
];

const CLAUDE_HELPER_SCRIPTS = [
  'mcp-bridge-probe.mjs',
  'ensure-cdp-deps.sh',
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
chmodSync(join(coreRoot, 'dist', 'supervisor.js'), 0o755);
chmodSync(join(coreRoot, 'dist', 'experience-trends.js'), 0o755);

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

function requireSource(path, label) {
  if (!existsSync(path)) {
    console.error(`build-host-runtimes: missing ${label} at ${path}`);
    process.exit(1);
  }
}

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

function runEsbuild(entry, outfile, label, { createRequireBanner = true } = {}) {
  const result = spawnSync(
    esbuild,
    [
      entry,
      '--bundle',
      '--platform=node',
      '--format=esm',
      '--packages=bundle',
      ...(createRequireBanner
        ? [
            '--banner:js=import { createRequire as __rnCreateRequire } from "node:module"; const require = __rnCreateRequire(import.meta.url);',
          ]
        : []),
      `--outfile=${outfile}`,
      '--log-level=warning',
    ],
    { cwd: repoRoot, stdio: 'inherit' },
  );
  if (result.error) {
    console.error(
      `build-host-runtimes: failed to run esbuild for ${label}: ${result.error.message}`,
    );
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const RUNNER_BUILD_OUTPUT = {
  'rn-fast-runner': ['build', join('RnFastRunner', 'DerivedData')],
  'rn-android-runner': ['.gradle', join('app', 'build')],
};

// One bundled runtime, executed by both hosts from packages/claude-plugin.
const runtimeRoot = join(claudePluginRoot, 'rn-dev-agent-core');
mkdirSync(join(runtimeRoot, 'dist'), { recursive: true });
for (const nativeRoot of [coreRoot, runtimeRoot]) {
  const target = join(nativeRoot, 'dist', 'native', 'darwin-process-birth');
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(darwinProcessBirthHelper, target, constants.COPYFILE_FICLONE);
  copyFileSync(darwinProcessBirthManifest, `${target}.json`, constants.COPYFILE_FICLONE);
  chmodSync(target, 0o755);
  for (const helper of linuxConditionalPublicationHelpers) {
    const linuxTarget = join(nativeRoot, 'dist', 'native', basename(helper));
    copyFileSync(helper, linuxTarget, constants.COPYFILE_FICLONE);
    copyFileSync(`${helper}.json`, `${linuxTarget}.json`, constants.COPYFILE_FICLONE);
    chmodSync(linuxTarget, 0o755);
  }
}

for (const file of RUNTIME_ENTRIES) {
  runEsbuild(join(coreRoot, 'dist', file), join(runtimeRoot, 'dist', file), `dist/${file}`);
}

writeFileSync(
  join(runtimeRoot, 'package.json'),
  JSON.stringify(
    {
      name: 'rn-dev-agent-core',
      version: corePackage.version,
      private: true,
      type: 'module',
      engines: corePackage.engines,
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

// Codex surface, generated from the packages/codex-plugin authoring tree into
// the same distributed directory. Codex selects it through .codex-plugin/
// plugin.json (explicit codex-skills/ and codex.mcp.json paths, empty hooks),
// so Claude's default skills/, commands/, hooks/ stay Claude-only.
const codexManifestSource = join(codexPluginRoot, '.codex-plugin', 'plugin.json');
const codexMcpSource = join(codexPluginRoot, '.mcp.json');
const codexLauncherSource = join(codexPluginRoot, 'bin', 'cdp-supervisor.js');
const healthSource = join(codexPluginRoot, 'src', 'plugin-health.ts');
const codexAgentsTemplateSource = join(codexPluginRoot, 'src', 'AGENTS-MD-TEMPLATE.md');
requireSource(codexManifestSource, 'Codex manifest source');
requireSource(codexMcpSource, 'Codex MCP source');
requireSource(codexLauncherSource, 'Codex launcher source');
requireSource(healthSource, 'Codex health source');
requireSource(codexAgentsTemplateSource, 'Codex AGENTS template');

mkdirSync(join(claudePluginRoot, '.codex-plugin'), { recursive: true });
copyFileSync(codexManifestSource, join(claudePluginRoot, '.codex-plugin', 'plugin.json'));
copyFileSync(codexMcpSource, join(claudePluginRoot, 'codex.mcp.json'));
copyFileSync(codexAgentsTemplateSource, join(claudePluginRoot, 'AGENTS-MD-TEMPLATE.md'));

const binRoot = join(claudePluginRoot, 'bin');
rmSync(binRoot, { recursive: true, force: true });
mkdirSync(binRoot, { recursive: true });
copyFileSync(codexLauncherSource, join(binRoot, 'cdp-supervisor.js'));
// The outer Claude package is not an ES module; the launchers need their own
// contained boundary so `node <file>` runs them as ESM.
writeFileSync(
  join(binRoot, 'package.json'),
  JSON.stringify({ private: true, type: 'module' }, null, 2) + '\n',
  'utf8',
);
runEsbuild(healthSource, join(binRoot, 'plugin-health.js'), 'bin/plugin-health.js', {
  createRequireBanner: false,
});

copyCleanDir(join(codexPluginRoot, 'commands'), join(claudePluginRoot, 'codex-commands'));
copyCleanDir(join(codexPluginRoot, 'agents'), join(claudePluginRoot, 'codex-agents'));
copyCleanDir(join(codexPluginRoot, 'templates'), join(claudePluginRoot, 'codex-templates'));

const codexSkillsRoot = join(claudePluginRoot, 'codex-skills');
rmSync(codexSkillsRoot, { recursive: true, force: true });
mkdirSync(codexSkillsRoot, { recursive: true });
for (const name of CODEX_DOMAIN_SKILLS) {
  const source = join(codexPluginRoot, 'skills', name);
  requireSource(join(source, 'SKILL.md'), `Codex domain skill skills/${name}`);
  cpSync(source, join(codexSkillsRoot, name), { recursive: true });
}

// Generate the exact seventeen explicit-only Codex workflow skill adapters. The
// long workflow bodies stay in package-local codex-commands/*.md; these
// marker-owned wrappers provide a native $skill surface without relying on
// Codex's best-effort command migration.
for (const name of CODEX_COMMAND_SKILLS) {
  const commandPath = join(codexPluginRoot, 'commands', `${name}.md`);
  requireSource(commandPath, `Codex workflow playbook commands/${name}.md`);
  const command = readFileSync(commandPath, 'utf8');
  const description =
    command.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? `Run the ${name} workflow.`;
  const skillRoot = join(codexSkillsRoot, name);
  mkdirSync(join(skillRoot, 'agents'), { recursive: true });
  writeFileSync(
    join(skillRoot, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${JSON.stringify(`Explicit Codex workflow: ${description}`)}\n---\n<!-- GENERATED by scripts/build-host-runtimes.ts from packages/shared-agent-knowledge/source-map.json. DO NOT EDIT. -->\n\n# ${name}\n\nInvoke this workflow explicitly as \`$rn-dev-agent:${name} [request text]\`.\n\nThe exact text after the skill mention is the conceptual **request**. It is user-message data, not a shell variable or a Claude command-template substitution. Preserve it while applying the workflow's documented grammar; pass only separately parsed and validated values to MCP tools or package helpers. Never use \`eval\` or interpolate the raw request into a shell command.\n\nRead [the complete package-local workflow](../../codex-commands/${name}.md) before acting. Resolve that file and every helper relative to this exact \`SKILL.md\` path; never scan Codex caches or rely on a plugin-root environment variable. If a required \`cdp\` MCP tool is absent from the active task, stop and use the read-only discovery diagnosis. Do not substitute raw Maestro for rn-dev-agent strict proof.\n`,
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

mkdirSync(join(claudePluginRoot, 'scripts'), { recursive: true });
copyFileSync(
  join(repoRoot, 'runner-manifest.json'),
  join(claudePluginRoot, 'runner-manifest.json'),
);
copyFileSync(
  join(repoRoot, 'CLAUDE-MD-TEMPLATE.md'),
  join(claudePluginRoot, 'CLAUDE-MD-TEMPLATE.md'),
);
copyFileSync(
  join(repoRoot, 'scripts', 'record_proof.sh'),
  join(claudePluginRoot, 'scripts', 'record_proof.sh'),
);
for (const runnerName of ['rn-fast-runner', 'rn-android-runner']) {
  const target = join(claudePluginRoot, 'scripts', runnerName);
  copyCleanDir(join(repoRoot, 'packages', runnerName), target, RUNNER_BUILD_OUTPUT[runnerName]);
}
for (const script of [...SHARED_HOST_HELPER_SCRIPTS, ...CLAUDE_HELPER_SCRIPTS]) {
  copyFileSync(join(repoRoot, 'scripts', script), join(claudePluginRoot, 'scripts', script));
}
copyFileSync(
  maestroRunnerPinManifest,
  join(claudePluginRoot, 'scripts', 'maestro-runner-pin.json'),
);
