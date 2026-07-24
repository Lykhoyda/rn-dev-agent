import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface InstalledArtifactIdentity {
  platform: 'ios' | 'android';
  deviceId: string;
  appId: string;
  artifactDigest: string;
  installGeneration: string;
}

interface InstallProbeDependencies {
  runText?: (command: string, args: readonly string[]) => string;
  runBuffer?: (command: string, args: readonly string[]) => Buffer;
  read?: (path: string) => Buffer;
  stat?: (path: string) => { ino: number | bigint; size: number; mtimeMs: number };
}

function runText(command: string, args: readonly string[]): string {
  return execFileSync(command, [...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 10_000,
    maxBuffer: 8 * 1024 * 1024,
  });
}

function runBuffer(command: string, args: readonly string[]): Buffer {
  return execFileSync(command, [...args], {
    encoding: 'buffer',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 30_000,
    maxBuffer: 512 * 1024 * 1024,
  });
}

function digest(parts: readonly Buffer[]): string {
  const hash = createHash('sha256');
  for (const part of parts) {
    hash.update(part);
    hash.update('\0');
  }
  return hash.digest('hex');
}

function generation(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\0')).digest('hex');
}

function androidApkPaths(
  target: Pick<InstalledArtifactIdentity, 'deviceId' | 'appId'>,
  text: (command: string, args: readonly string[]) => string,
): string[] {
  return text('adb', ['-s', target.deviceId, 'shell', 'pm', 'path', target.appId])
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('package:'))
    .map((line) => line.slice('package:'.length))
    .sort();
}

export function captureInstallGeneration(
  target: Pick<InstalledArtifactIdentity, 'platform' | 'deviceId' | 'appId'>,
  dependencies: InstallProbeDependencies = {},
): string {
  const text = dependencies.runText ?? runText;
  if (target.platform === 'ios') {
    const appPath = text('xcrun', [
      'simctl',
      'get_app_container',
      target.deviceId,
      target.appId,
      'app',
    ]).trim();
    if (!appPath) {
      throw new Error('APP_INSTALL_IDENTITY_CHANGED: exact iOS app container was not found');
    }
    const infoPath = join(appPath, 'Info.plist');
    const executable = text('plutil', [
      '-extract',
      'CFBundleExecutable',
      'raw',
      '-o',
      '-',
      infoPath,
    ]).trim();
    if (!executable) {
      throw new Error('APP_INSTALL_IDENTITY_CHANGED: iOS executable identity is unavailable');
    }
    const stat = dependencies.stat ?? statSync;
    const metadata = [infoPath, join(appPath, executable)].map((path) => {
      const value = stat(path);
      return `${path}:${String(value.ino)}:${value.size}:${value.mtimeMs}`;
    });
    return generation(metadata);
  }

  const apkPaths = androidApkPaths(target, text);
  if (!apkPaths.length) {
    throw new Error('APP_INSTALL_IDENTITY_CHANGED: exact Android package was not found');
  }
  const metadata = text('adb', [
    '-s',
    target.deviceId,
    'shell',
    'stat',
    '-c',
    '%n:%i:%s:%Y',
    ...apkPaths,
  ])
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .sort();
  if (metadata.length !== apkPaths.length) {
    throw new Error('APP_INSTALL_IDENTITY_CHANGED: Android install generation is unavailable');
  }
  return generation(metadata);
}

export function captureInstalledArtifact(
  target: Pick<InstalledArtifactIdentity, 'platform' | 'deviceId' | 'appId'>,
  dependencies: InstallProbeDependencies = {},
): InstalledArtifactIdentity {
  const text = dependencies.runText ?? runText;
  const buffer = dependencies.runBuffer ?? runBuffer;
  const read = dependencies.read ?? readFileSync;

  if (target.platform === 'ios') {
    const appPath = text('xcrun', [
      'simctl',
      'get_app_container',
      target.deviceId,
      target.appId,
      'app',
    ]).trim();
    if (!appPath) {
      throw new Error('APP_INSTALL_IDENTITY_CHANGED: exact iOS app container was not found');
    }
    const infoPath = join(appPath, 'Info.plist');
    const executable = text('plutil', [
      '-extract',
      'CFBundleExecutable',
      'raw',
      '-o',
      '-',
      infoPath,
    ]).trim();
    if (!executable) {
      throw new Error('APP_INSTALL_IDENTITY_CHANGED: iOS executable identity is unavailable');
    }
    return {
      ...target,
      artifactDigest: digest([read(infoPath), read(join(appPath, executable))]),
      installGeneration: captureInstallGeneration(target, dependencies),
    };
  }

  const apkPaths = androidApkPaths(target, text);
  if (!apkPaths.length) {
    throw new Error('APP_INSTALL_IDENTITY_CHANGED: exact Android package was not found');
  }
  return {
    ...target,
    artifactDigest: digest(
      apkPaths.map((path) => buffer('adb', ['-s', target.deviceId, 'exec-out', 'cat', path])),
    ),
    installGeneration: captureInstallGeneration(target, dependencies),
  };
}

export function verifyInstalledArtifact(
  expected: InstalledArtifactIdentity,
  observed: InstalledArtifactIdentity,
): void {
  if (
    expected.platform !== observed.platform ||
    expected.deviceId !== observed.deviceId ||
    expected.appId !== observed.appId ||
    expected.artifactDigest !== observed.artifactDigest ||
    expected.installGeneration !== observed.installGeneration
  ) {
    throw new Error(
      'APP_INSTALL_IDENTITY_CHANGED: installed artifact no longer matches the session build',
    );
  }
}
