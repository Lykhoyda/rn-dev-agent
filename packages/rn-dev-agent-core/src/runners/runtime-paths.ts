import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

function compactUnique(paths: Array<string | undefined>): string[] {
  const out: string[] = [];
  for (const path of paths) {
    if (!path || out.includes(path)) continue;
    out.push(path);
  }
  return out;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function candidateNativeRunnerDirs(
  runnerName: 'rn-fast-runner' | 'rn-android-runner',
  baseDir = import.meta.dirname,
): string[] {
  const runnerRoot = process.env.RN_DEV_AGENT_NATIVE_RUNNER_ROOT;
  const repoRoot = process.env.RN_DEV_AGENT_ROOT;
  const codexPluginRoot = process.env.RN_DEV_AGENT_CODEX_PLUGIN_ROOT;
  const claudePluginRoot = process.env.CLAUDE_PLUGIN_ROOT;

  return compactUnique([
    runnerRoot ? join(runnerRoot, runnerName) : undefined,
    repoRoot ? join(repoRoot, 'packages', runnerName) : undefined,
    repoRoot ? join(repoRoot, 'scripts', runnerName) : undefined,
    codexPluginRoot ? join(codexPluginRoot, 'scripts', runnerName) : undefined,
    claudePluginRoot ? join(claudePluginRoot, '..', runnerName) : undefined,
    claudePluginRoot ? join(claudePluginRoot, '..', '..', 'packages', runnerName) : undefined,
    claudePluginRoot ? join(claudePluginRoot, '..', '..', 'scripts', runnerName) : undefined,
    claudePluginRoot ? join(claudePluginRoot, 'scripts', runnerName) : undefined,
    // Bundled Codex runtime: <plugin>/rn-dev-agent-core/dist.
    join(baseDir, '..', '..', 'scripts', runnerName),
    // Source checkout: packages/rn-dev-agent-core/dist/runners.
    // Also covers the legacy scripts/cdp-bridge/dist/runners layout.
    join(baseDir, '..', '..', '..', runnerName),
    // Legacy source checkout: packages/rn-dev-agent-core/dist/runners before runner package split.
    join(baseDir, '..', '..', '..', '..', 'scripts', runnerName),
  ]);
}

export function resolveNativeRunnerDir(
  runnerName: 'rn-fast-runner' | 'rn-android-runner',
  baseDir = import.meta.dirname,
): string {
  const candidates = candidateNativeRunnerDirs(runnerName, baseDir);
  return candidates.find(isDirectory) ?? candidates[0];
}

export function candidateRunnerManifestFiles(baseDir = import.meta.dirname): string[] {
  const repoRoot = process.env.RN_DEV_AGENT_ROOT;
  const codexPluginRoot = process.env.RN_DEV_AGENT_CODEX_PLUGIN_ROOT;
  const claudePluginRoot = process.env.CLAUDE_PLUGIN_ROOT;

  return compactUnique([
    process.env.RN_DEV_AGENT_RUNNER_MANIFEST,
    repoRoot ? join(repoRoot, 'runner-manifest.json') : undefined,
    codexPluginRoot ? join(codexPluginRoot, 'runner-manifest.json') : undefined,
    claudePluginRoot ? join(claudePluginRoot, '..', '..', 'runner-manifest.json') : undefined,
    claudePluginRoot ? join(claudePluginRoot, 'runner-manifest.json') : undefined,
    // Bundled Codex runtime: <plugin>/rn-dev-agent-core/dist.
    join(baseDir, '..', '..', 'runner-manifest.json'),
    // Migrated source checkout: packages/rn-dev-agent-core/dist/runners.
    join(baseDir, '..', '..', '..', '..', 'runner-manifest.json'),
    // Legacy source checkout: scripts/cdp-bridge/dist/runners.
    join(baseDir, '..', '..', '..', 'runner-manifest.json'),
  ]);
}

export function candidatePluginManifestFiles(baseDir = import.meta.dirname): string[] {
  const codexPluginRoot = process.env.RN_DEV_AGENT_CODEX_PLUGIN_ROOT;
  const claudePluginRoot = process.env.CLAUDE_PLUGIN_ROOT;

  return compactUnique([
    process.env.RN_DEV_AGENT_PLUGIN_MANIFEST,
    codexPluginRoot ? join(codexPluginRoot, '.codex-plugin', 'plugin.json') : undefined,
    claudePluginRoot ? join(claudePluginRoot, '.claude-plugin', 'plugin.json') : undefined,
    claudePluginRoot ? join(claudePluginRoot, 'plugin.json') : undefined,
    // Bundled Codex runtime: <plugin>/rn-dev-agent-core/dist.
    join(baseDir, '..', '..', '.codex-plugin', 'plugin.json'),
    // Migrated source checkout: packages/rn-dev-agent-core/dist/runners.
    join(baseDir, '..', '..', '..', 'claude-plugin', '.claude-plugin', 'plugin.json'),
    join(baseDir, '..', '..', '..', 'claude-plugin', 'plugin.json'),
    // Core package fallback. This is enough for artifact versioning in Codex.
    join(baseDir, '..', 'package.json'),
    join(baseDir, '..', '..', 'package.json'),
  ]);
}

export function firstExistingFile(candidates: string[]): string | null {
  return candidates.find((path) => existsSync(path)) ?? null;
}
