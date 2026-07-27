import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  type Stats,
} from 'node:fs';
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
  readDescriptor?: (fd: number) => Buffer;
  run?: (command: string, args: readonly string[]) => string;
  runVerifiedHelper?: (path: string, pid: number, requirement: string) => string;
  canonicalize?: (path: string) => string;
  lstat?: (path: string) => Pick<Stats, 'dev' | 'ino' | 'mode' | 'size' | 'uid'> & {
    isFile(): boolean;
  };
  helperPath?: () => string;
  open?: (path: string, flags: number) => number;
  close?: (fd: number) => void;
  fstat?: (fd: number) => Pick<Stats, 'dev' | 'ino' | 'mode' | 'size' | 'uid'> & {
    isFile(): boolean;
  };
  uid?: number;
}

export interface VerifiedDarwinProcessBirthHelper {
  path: string;
  requirement: string;
}

const DARWIN_HELPER_MANIFEST = {
  sourceSha256: '99a8025ab1c3cfbe32db184f6e030216d75c535143bd4684a2a89aac61c54c4a',
  recipeSha256: '4f40539bce137f7bcae4731fd1494fae5704cba5327177d7f2a2a47aec95afb3',
  stableBinarySha256: '6b5db7f7a6933f3d11d4c53ecafba9c3ef82c2533faf4bfe07a11b3cb4022dea',
  binarySha256: 'fee005927e8d680b1589574211002d8809e3478446b97d3c9291157ea57b0dd5',
  cdhashes: [
    '1e67841d4d49a5e5088d283e26430130f017b989',
    '7f25b0eca55913e522781923a16c6b0cd98bb4fc',
  ],
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

const VERIFIED_HELPER_SCRIPT = `
set -euo pipefail
helper_pid=
cleanup() {
  if [[ -n "$helper_pid" ]]; then
    /bin/kill -CONT "$helper_pid" 2>/dev/null || true
    /bin/kill -KILL "$helper_pid" 2>/dev/null || true
    wait "$helper_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT HUP INT TERM
coproc "$1" "$2" --hold
helper_pid=$!
IFS= read -r -p result
attempt=0
state=
while (( attempt < 100 )); do
  state=$(/bin/ps -p "$helper_pid" -o state= 2>/dev/null || true)
  [[ "$state" == T* ]] && break
  [[ -z "$state" || "$state" == Z* ]] && exit 1
  /bin/sleep 0.01
  (( attempt += 1 ))
done
[[ "$state" == T* ]]
/usr/bin/codesign --verify --strict "-R=$3" "$1" >/dev/null 2>&1
/usr/bin/codesign --verify --strict "+$helper_pid" >/dev/null 2>&1
live_cdhash=$(
  /usr/bin/codesign --display --verbose=4 "+$helper_pid" 2>&1 |
    /usr/bin/awk -F= '/^CDHash=/{print tolower($2); exit}'
)
[[ "$live_cdhash" != *[^0-9a-f]* ]]
[[ "\${#live_cdhash}" == 40 ]]
expected_cdhash="H\\"\${live_cdhash}\\""
[[ "$3" == *"$expected_cdhash"* ]]
/bin/kill -CONT "$helper_pid"
attempt=0
while (( attempt < 100 )); do
  state=$(/bin/ps -p "$helper_pid" -o state= 2>/dev/null || true)
  [[ -z "$state" || "$state" == Z* ]] && break
  /bin/sleep 0.01
  (( attempt += 1 ))
done
[[ -z "$state" || "$state" == Z* ]]
wait "$helper_pid" 2>/dev/null || true
helper_pid=
trap - EXIT HUP INT TERM
print -r -- "$result"
`;

function defaultRunVerifiedHelper(path: string, pid: number, requirement: string): string {
  return execFileSync(
    '/bin/zsh',
    ['-f', '-c', VERIFIED_HELPER_SCRIPT, 'rn-process-birth', path, String(pid), requirement],
    {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2_000,
    },
  );
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

export function darwinProcessBirthRequirement(): string {
  return `(${DARWIN_HELPER_MANIFEST.cdhashes.map((cdhash) => `cdhash H"${cdhash}"`).join(' or ')})`;
}

function verifyDarwinProcessBirthHelper(
  dependencies: ProcessBirthDependencies,
): VerifiedDarwinProcessBirthHelper {
  const helper = (dependencies.helperPath ?? darwinProcessBirthHelperPath)();
  const manifestPath = `${helper}.json`;
  const canonicalize = dependencies.canonicalize ?? realpathSync;
  const metadata = dependencies.lstat ?? lstatSync;
  const descriptorMetadata = dependencies.fstat ?? fstatSync;
  const readBinary = dependencies.readBinary ?? ((path: string) => readFileSync(path));
  const readDescriptor =
    dependencies.readDescriptor ??
    ((fd: number) => {
      const size = descriptorMetadata(fd).size;
      const buffer = Buffer.alloc(size);
      let offset = 0;
      while (offset < size) {
        const bytesRead = readSync(fd, buffer, offset, size - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      return buffer.subarray(0, offset);
    });
  const open = dependencies.open ?? openSync;
  const close = dependencies.close ?? closeSync;
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
  const manifestBytes = readBinary(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as Record<string, unknown>;
  if (
    Object.entries(DARWIN_HELPER_MANIFEST).some(
      ([key, expected]) => JSON.stringify(manifest[key]) !== JSON.stringify(expected),
    )
  ) {
    throw new Error('Darwin process-birth helper provenance is invalid');
  }

  const fd = open(helper, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = descriptorMetadata(fd);
    if (
      !opened.isFile() ||
      !sameFile(helperBefore, opened) ||
      createHash('sha256').update(readDescriptor(fd)).digest('hex') !==
        DARWIN_HELPER_MANIFEST.binarySha256 ||
      !sameFile(manifestBefore, metadata(manifestPath))
    ) {
      throw new Error('Darwin process-birth helper changed during verification');
    }
    return {
      path: helper,
      requirement: darwinProcessBirthRequirement(),
    };
  } catch (error) {
    throw error;
  } finally {
    close(fd);
  }
}

export async function withVerifiedDarwinProcessBirthHelper<T>(
  callback: (helper: VerifiedDarwinProcessBirthHelper) => Promise<T>,
): Promise<T> {
  return callback(verifyDarwinProcessBirthHelper({}));
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
  const runVerifiedHelper = dependencies.runVerifiedHelper ?? defaultRunVerifiedHelper;

  try {
    if (platform === 'darwin') {
      const observedPid = run('/bin/ps', ['-p', String(pid), '-o', 'pid=']).trim();
      if (observedPid.length === 0) return { status: 'absent' };
      if (Number(observedPid) !== pid) return { status: 'unknown' };
      const helper = verifyDarwinProcessBirthHelper(dependencies);
      const processInfo = runVerifiedHelper(helper.path, pid, helper.requirement).trim();
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
