import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync, type Stats } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ProcessBirth {
  pid: number;
  source: 'darwin-libproc' | 'linux-proc' | 'windows-powershell';
  token: string;
}

export type ProcessBirthProbe =
  | { status: 'present'; birth: ProcessBirth }
  | { status: 'absent' }
  | { status: 'unknown' };

interface ProcessBirthDependencies {
  platform?: NodeJS.Platform;
  read?: (path: string) => string;
  readBinary?: (path: string) => Buffer;
  run?: (command: string, args: readonly string[]) => string;
  canonicalize?: (path: string) => string;
  lstat?: (path: string) => Pick<Stats, 'dev' | 'ino' | 'mode' | 'size' | 'uid'> & {
    isFile(): boolean;
  };
  helperPath?: () => string;
  uid?: number;
}

const DARWIN_HELPER_MANIFEST = {
  sourceSha256: '54b3387a83580c5a782f3aedfb1984b62ed84faeadeca295fb90e533d9ecc137',
  recipeSha256: 'ff4a62e1c242f6123eb7232eae6e823ee808d18d9e138814dbe19f516cae2313',
  stableBinarySha256: 'cb08e04b81369c8f1acb5d52508841f72317c30b15bcf966f2963f54e0033ff1',
  binarySha256: '08a196d403db4245ff162d8d7585aa4c2c6e784029a4a6fab8ac69b14951d9dc',
} as const;

function defaultRun(command: string, args: readonly string[]): string {
  try {
    return execFileSync(command, [...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2_000,
    });
  } catch (error) {
    if (
      command === '/bin/ps' &&
      typeof error === 'object' &&
      error !== null &&
      'status' in error &&
      error.status === 1
    ) {
      return '';
    }
    throw error;
  }
}

function token(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\0')).digest('hex');
}

export function darwinProcessBirthHelperPath(): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(moduleDirectory, 'native', 'darwin-process-birth'),
    join(moduleDirectory, '..', 'native', 'darwin-process-birth'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return candidates[0];
}

function sameFile(
  before: Pick<Stats, 'dev' | 'ino' | 'mode' | 'size' | 'uid'>,
  after: Pick<Stats, 'dev' | 'ino' | 'mode' | 'size' | 'uid'>,
): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.mode === after.mode &&
    before.size === after.size &&
    before.uid === after.uid
  );
}

function verifyDarwinProcessBirthHelper(
  dependencies: ProcessBirthDependencies,
  run: (command: string, args: readonly string[]) => string,
): string {
  const helper = (dependencies.helperPath ?? darwinProcessBirthHelperPath)();
  const manifestPath = `${helper}.json`;
  const canonicalize = dependencies.canonicalize ?? realpathSync;
  const metadata = dependencies.lstat ?? lstatSync;
  const readBinary = dependencies.readBinary ?? ((path: string) => readFileSync(path));
  const uid = dependencies.uid ?? process.getuid?.();

  if (canonicalize(helper) !== helper || canonicalize(manifestPath) !== manifestPath) {
    throw new Error('Darwin process-birth helper path is not canonical');
  }
  const helperBefore = metadata(helper);
  const manifestBefore = metadata(manifestPath);
  const trustedOwners = new Set([0, ...(uid === undefined ? [] : [uid])]);
  if (
    !helperBefore.isFile() ||
    !manifestBefore.isFile() ||
    !trustedOwners.has(helperBefore.uid) ||
    !trustedOwners.has(manifestBefore.uid) ||
    (helperBefore.mode & 0o022) !== 0 ||
    (manifestBefore.mode & 0o022) !== 0 ||
    (helperBefore.mode & 0o111) === 0
  ) {
    throw new Error('Darwin process-birth helper metadata is untrusted');
  }
  const helperBytes = readBinary(helper);
  const manifestBytes = readBinary(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as Record<string, unknown>;
  if (
    Object.keys(DARWIN_HELPER_MANIFEST).some(
      (key) => manifest[key] !== DARWIN_HELPER_MANIFEST[key as keyof typeof DARWIN_HELPER_MANIFEST],
    ) ||
    createHash('sha256').update(helperBytes).digest('hex') !== DARWIN_HELPER_MANIFEST.binarySha256
  ) {
    throw new Error('Darwin process-birth helper provenance is invalid');
  }
  if (!sameFile(helperBefore, metadata(helper)) || !sameFile(manifestBefore, metadata(manifestPath))) {
    throw new Error('Darwin process-birth helper changed during verification');
  }
  run('/usr/bin/codesign', ['--verify', '--strict', helper]);
  if (!sameFile(helperBefore, metadata(helper))) {
    throw new Error('Darwin process-birth helper changed after signature verification');
  }
  return helper;
}

export function readProcessBirth(
  pid: number,
  dependencies: ProcessBirthDependencies = {},
): ProcessBirth | null {
  const probe = probeProcessBirth(pid, dependencies);
  return probe.status === 'present' ? probe.birth : null;
}

export function probeProcessBirth(
  pid: number,
  dependencies: ProcessBirthDependencies = {},
): ProcessBirthProbe {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { status: 'unknown' };

  const platform = dependencies.platform ?? process.platform;
  const read = dependencies.read ?? ((path: string) => readFileSync(path, 'utf8'));
  const run = dependencies.run ?? defaultRun;

  try {
    if (platform === 'darwin') {
      const observedPid = run('/bin/ps', ['-p', String(pid), '-o', 'pid=']).trim();
      if (observedPid.length === 0) return { status: 'absent' };
      if (Number(observedPid) !== pid) return { status: 'unknown' };
      const helper = verifyDarwinProcessBirthHelper(dependencies, run);
      const processInfo = run(helper, [String(pid)]).trim();
      const processMatch = /^(\d+):(\d+):(\d+)$/.exec(processInfo);
      if (!processMatch || Number(processMatch[1]) !== pid) return { status: 'unknown' };
      const bootSession = run('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid']).trim();
      if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(bootSession)) {
        return { status: 'unknown' };
      }
      return {
        status: 'present',
        birth: {
          pid,
          source: 'darwin-libproc',
          token: token([platform, bootSession.toLowerCase(), processMatch[2], processMatch[3]]),
        },
      };
    }

    if (platform === 'linux') {
      const boot = read('/proc/sys/kernel/random/boot_id').trim();
      let stat: string;
      try {
        stat = read(`/proc/${pid}/stat`).trim();
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ENOENT'
          ? { status: 'absent' }
          : { status: 'unknown' };
      }
      const commandEnd = stat.lastIndexOf(')');
      const fields =
        commandEnd >= 0
          ? stat
              .slice(commandEnd + 1)
              .trim()
              .split(/\s+/)
          : [];
      const started = fields[19];
      if (!boot || !started || !/^\d+$/.test(started)) return { status: 'unknown' };
      return {
        status: 'present',
        birth: { pid, source: 'linux-proc', token: token([platform, boot, started]) },
      };
    }

    if (platform === 'win32') {
      const script =
        `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; ` +
        `if ($null -eq $p) { 'ABSENT' } else { $p.StartTime.ToUniversalTime().Ticks }`;
      const started = run('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        script,
      ]).trim();
      if (started === 'ABSENT') return { status: 'absent' };
      if (!/^\d+$/.test(started)) return { status: 'unknown' };
      return {
        status: 'present',
        birth: { pid, source: 'windows-powershell', token: token([platform, started]) },
      };
    }
  } catch {
    return { status: 'unknown' };
  }

  return { status: 'unknown' };
}

export function processBirthMatches(
  expected: Pick<ProcessBirth, 'pid' | 'token'>,
  dependencies: ProcessBirthDependencies = {},
): boolean {
  const observed = readProcessBirth(expected.pid, dependencies);
  return observed !== null && observed.token === expected.token;
}
