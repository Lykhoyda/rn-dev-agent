import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findProjectRoot } from './nav-graph/storage.js';

interface AppConfig {
  expo?: {
    ios?: { bundleIdentifier?: string };
    android?: { package?: string };
    slug?: string;
  };
  ios?: { bundleIdentifier?: string };
  android?: { package?: string };
}

/**
 * Read bundle ID / package name from app.json or app.config.json.
 * Returns the platform-appropriate ID, or falls back cross-platform.
 */
export function readAppId(projectRoot: string, platform: string): string | null {
  for (const filename of ['app.json', 'app.config.json']) {
    const p = join(projectRoot, filename);
    if (!existsSync(p)) continue;
    try {
      const raw = JSON.parse(readFileSync(p, 'utf-8')) as AppConfig;
      const expo = raw.expo ?? raw;
      const iosBundleId = (expo as AppConfig['expo'])?.ios?.bundleIdentifier;
      const androidPkg = (expo as AppConfig['expo'])?.android?.package;
      if (platform === 'android') return androidPkg ?? iosBundleId ?? null;
      return iosBundleId ?? androidPkg ?? null;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Resolve bundle ID by finding the project root and reading app config.
 * Returns null if project root or config cannot be determined.
 */
export function resolveBundleId(platform: string): string | null {
  const projectRoot = findProjectRoot();
  if (!projectRoot) return null;
  return readAppId(projectRoot, platform);
}

/**
 * Read the Expo slug from app.json (used for Maestro app ID resolution).
 */
export function readExpoSlug(): string | null {
  const projectRoot = findProjectRoot();
  if (!projectRoot) return null;
  for (const filename of ['app.json', 'app.config.json']) {
    const p = join(projectRoot, filename);
    if (!existsSync(p)) continue;
    try {
      const raw = JSON.parse(readFileSync(p, 'utf-8')) as AppConfig;
      return raw.expo?.slug ?? null;
    } catch {
      continue;
    }
  }
  return null;
}
