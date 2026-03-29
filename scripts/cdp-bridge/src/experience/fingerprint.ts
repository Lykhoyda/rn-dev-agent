import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { EnvironmentFingerprint } from './types.js';

const KEY_DEPS = [
  '@tanstack/react-query',
  'zustand',
  'nativewind',
  '@react-navigation/native',
  'expo-router',
  '@shopify/flash-list',
  'react-native-reanimated',
  'react-native-gesture-handler',
  'redux',
  '@reduxjs/toolkit',
  'react-hook-form',
  'react-native-mmkv',
];

function readJson(path: string): Record<string, unknown> | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function findProjectRoot(): string | null {
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = join(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function extractVersion(deps: Record<string, unknown>, name: string): string | null {
  const ver = deps[name];
  if (typeof ver === 'string') return ver.replace(/^[\^~>=<]/, '');
  return null;
}

function extractKeyDeps(allDeps: Record<string, unknown>): string[] {
  const found: string[] = [];
  for (const dep of KEY_DEPS) {
    const ver = extractVersion(allDeps, dep);
    if (ver) {
      const major = ver.split('.')[0];
      found.push(`${dep}@${major}.x`);
    }
  }
  return found;
}

export function captureFingerprint(): EnvironmentFingerprint {
  let root: string | null = null;
  try { root = findProjectRoot(); } catch { /* cwd gone */ }
  const fp: EnvironmentFingerprint = {
    rn_version: null,
    expo_sdk: null,
    engine: null,
    architecture: null,
    bridgeless: null,
    platform: null,
    device: null,
    metro_port: 8081,
    key_deps: [],
  };

  if (!root) return fp;

  const pkg = readJson(join(root, 'package.json'));
  if (!pkg) return fp;

  const allDeps: Record<string, unknown> = {
    ...(pkg.dependencies as Record<string, unknown> || {}),
    ...(pkg.devDependencies as Record<string, unknown> || {}),
  };

  fp.rn_version = extractVersion(allDeps, 'react-native');
  fp.expo_sdk = extractVersion(allDeps, 'expo');
  fp.key_deps = extractKeyDeps(allDeps);

  fp.engine = allDeps['hermes-engine'] ? 'hermes' : (allDeps['jsc-android'] ? 'jsc' : 'hermes');

  const appJson = readJson(join(root, 'app.json'));
  if (appJson) {
    const expo = appJson.expo as Record<string, unknown> | undefined;
    if (expo) {
      const newArch = expo.newArchEnabled;
      if (typeof newArch === 'boolean') {
        fp.architecture = newArch ? 'fabric' : 'old';
        fp.bridgeless = newArch;
      }
      const platforms = expo.platforms as string[] | undefined;
      if (platforms?.length === 1) {
        fp.platform = platforms[0] as 'ios' | 'android';
      }
    }
  }

  return fp;
}
