import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface RunningProductVersion {
  coreVersion: string;
  pluginVersion?: string;
}

const EXECUTING_CORE_PACKAGE_NAME = 'rn-dev-agent-core';

const productByModuleUrl = new Map<string, RunningProductVersion | null>();
const loadedModuleUrl = import.meta.url;

export function projectRunningProductVersion(input: {
  coreVersion: string | null;
  pluginVersion: string | null;
}): RunningProductVersion | null {
  if (typeof input.coreVersion !== 'string' || input.coreVersion.length === 0) return null;
  if (
    typeof input.pluginVersion === 'string' &&
    input.pluginVersion.length > 0 &&
    input.pluginVersion !== input.coreVersion
  ) {
    return { coreVersion: input.coreVersion, pluginVersion: input.pluginVersion };
  }
  return { coreVersion: input.coreVersion };
}

function readPackageNameVersion(path: string): { name?: unknown; version?: unknown } | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as { name?: unknown; version?: unknown };
  } catch {
    return null;
  }
}

function findExecutingCorePackage(startDir: string): { version: string; dir: string } | null {
  let cursor = startDir;
  for (let i = 0; i < 8; i++) {
    const parsed = readPackageNameVersion(join(cursor, 'package.json'));
    if (
      typeof parsed?.name === 'string' &&
      parsed.name === EXECUTING_CORE_PACKAGE_NAME &&
      typeof parsed.version === 'string' &&
      parsed.version
    ) {
      return { version: parsed.version, dir: cursor };
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return null;
}

function envPluginRoot(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

function launchingHostManifestCandidates(): string[] {
  const candidates: string[] = [];
  const codex =
    envPluginRoot('RN_DEV_AGENT_CODEX_PLUGIN_ROOT') ?? envPluginRoot('CODEX_PLUGIN_ROOT');
  const claude = envPluginRoot('CLAUDE_PLUGIN_ROOT');
  if (codex) candidates.push(join(codex, '.codex-plugin', 'plugin.json'));
  if (claude) candidates.push(join(claude, '.claude-plugin', 'plugin.json'));
  return candidates;
}

function pluginManifestCandidates(packageDir: string): string[] {
  const hostRoot = join(packageDir, '..');
  return [
    join(hostRoot, '.claude-plugin', 'plugin.json'),
    join(hostRoot, '.codex-plugin', 'plugin.json'),
    join(hostRoot, 'claude-plugin', '.claude-plugin', 'plugin.json'),
    join(hostRoot, 'codex-plugin', '.codex-plugin', 'plugin.json'),
  ];
}

function readPluginManifestVersion(packageDir: string): string | null {
  for (const candidate of [
    ...launchingHostManifestCandidates(),
    ...pluginManifestCandidates(packageDir),
  ]) {
    const parsed = readPackageNameVersion(candidate);
    if (typeof parsed?.version === 'string' && parsed.version) return parsed.version;
  }
  return null;
}

function resolveRunningProductVersion(fromUrl: string): RunningProductVersion | null {
  const executing = findExecutingCorePackage(dirname(fileURLToPath(fromUrl)));
  if (!executing) return null;
  return projectRunningProductVersion({
    coreVersion: executing.version,
    pluginVersion: readPluginManifestVersion(executing.dir),
  });
}

function cachedRunningProductVersion(fromUrl: string): RunningProductVersion | null {
  if (productByModuleUrl.has(fromUrl)) return productByModuleUrl.get(fromUrl) ?? null;
  const product = resolveRunningProductVersion(fromUrl);
  productByModuleUrl.set(fromUrl, product);
  return product;
}

cachedRunningProductVersion(loadedModuleUrl);

export function readRunningProductVersion(
  fromUrl: string = loadedModuleUrl,
): RunningProductVersion | null {
  return cachedRunningProductVersion(fromUrl);
}

export function withRunningProduct<T extends Record<string, unknown>>(
  data: T,
  product: RunningProductVersion | null = readRunningProductVersion(),
): T | (T & { product: RunningProductVersion }) {
  return product ? { product, ...data } : data;
}
