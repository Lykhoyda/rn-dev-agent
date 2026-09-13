import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface RunningProductVersion {
  coreVersion: string;
  pluginVersion?: string;
}

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

function readNamedPackageVersion(startDir: string, packageName: string): string | null {
  let cursor = startDir;
  for (let i = 0; i < 8; i++) {
    const parsed = readPackageNameVersion(join(cursor, 'package.json'));
    if (parsed?.name === packageName && typeof parsed.version === 'string' && parsed.version) {
      return parsed.version;
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return null;
}

function readPluginManifestVersion(startDir: string): string | null {
  const candidates = [
    join(startDir, '..', '..', '..', '.claude-plugin', 'plugin.json'),
    join(startDir, '..', '..', '..', '.codex-plugin', 'plugin.json'),
    join(startDir, '..', '..', '..', 'claude-plugin', '.claude-plugin', 'plugin.json'),
    join(startDir, '..', '..', '..', 'codex-plugin', '.codex-plugin', 'plugin.json'),
  ];
  for (const candidate of candidates) {
    const parsed = readPackageNameVersion(candidate);
    if (typeof parsed?.version === 'string' && parsed.version) return parsed.version;
  }
  return null;
}

export function readRunningProductVersion(
  fromUrl: string = import.meta.url,
): RunningProductVersion | null {
  const startDir = dirname(fileURLToPath(fromUrl));
  return projectRunningProductVersion({
    coreVersion: readNamedPackageVersion(startDir, 'rn-dev-agent-core'),
    pluginVersion: readPluginManifestVersion(startDir),
  });
}

export function withRunningProduct<T extends Record<string, unknown>>(
  data: T,
  product: RunningProductVersion | null = readRunningProductVersion(),
): T | (T & { product: RunningProductVersion }) {
  return product ? { product, ...data } : data;
}
