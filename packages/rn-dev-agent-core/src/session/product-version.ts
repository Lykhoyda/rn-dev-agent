import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface RunningProductVersion {
  coreVersion: string;
  pluginVersion?: string;
}

const EXECUTING_CORE_PACKAGE_NAMES = new Set([
  'rn-dev-agent-core',
  'rn-dev-agent-core-claude-runtime',
  'rn-dev-agent-core-codex-runtime',
]);

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

function findExecutingCorePackage(
  startDir: string,
): { name: string; version: string; dir: string } | null {
  let cursor = startDir;
  for (let i = 0; i < 8; i++) {
    const parsed = readPackageNameVersion(join(cursor, 'package.json'));
    if (
      typeof parsed?.name === 'string' &&
      EXECUTING_CORE_PACKAGE_NAMES.has(parsed.name) &&
      typeof parsed.version === 'string' &&
      parsed.version
    ) {
      return { name: parsed.name, version: parsed.version, dir: cursor };
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return null;
}

function pluginManifestCandidates(packageDir: string, packageName: string): string[] {
  const hostRoot = join(packageDir, '..');
  const claudeHost = join(hostRoot, '.claude-plugin', 'plugin.json');
  const codexHost = join(hostRoot, '.codex-plugin', 'plugin.json');
  const claudeSource = join(hostRoot, 'claude-plugin', '.claude-plugin', 'plugin.json');
  const codexSource = join(hostRoot, 'codex-plugin', '.codex-plugin', 'plugin.json');
  if (packageName === 'rn-dev-agent-core-codex-runtime') {
    return [codexHost, claudeHost, codexSource, claudeSource];
  }
  if (packageName === 'rn-dev-agent-core-claude-runtime') {
    return [claudeHost, codexHost, claudeSource, codexSource];
  }
  return [claudeHost, codexHost, claudeSource, codexSource];
}

function readPluginManifestVersion(packageDir: string, packageName: string): string | null {
  for (const candidate of pluginManifestCandidates(packageDir, packageName)) {
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
    pluginVersion: readPluginManifestVersion(executing.dir, executing.name),
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
