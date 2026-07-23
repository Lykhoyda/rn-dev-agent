import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface InstalledArtifactIdentity {
  platform: 'ios' | 'android';
  deviceId: string;
  appId: string;
  artifactDigest: string;
}

interface InstallProbeDependencies {
  runText?: (command: string, args: readonly string[]) => string;
  runBuffer?: (command: string, args: readonly string[]) => Buffer;
  read?: (path: string) => Buffer;
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
    };
  }

  const packageOutput = text('adb', ['-s', target.deviceId, 'shell', 'pm', 'path', target.appId]);
  const apkPaths = packageOutput
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('package:'))
    .map((line) => line.slice('package:'.length))
    .sort();
  if (!apkPaths.length) {
    throw new Error('APP_INSTALL_IDENTITY_CHANGED: exact Android package was not found');
  }
  return {
    ...target,
    artifactDigest: digest(
      apkPaths.map((path) => buffer('adb', ['-s', target.deviceId, 'exec-out', 'cat', path])),
    ),
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
    expected.artifactDigest !== observed.artifactDigest
  ) {
    throw new Error(
      'APP_INSTALL_IDENTITY_CHANGED: installed artifact no longer matches the session build',
    );
  }
}
