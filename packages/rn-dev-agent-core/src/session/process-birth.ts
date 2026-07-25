import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

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
  run?: (command: string, args: readonly string[]) => string;
}

function defaultRun(command: string, args: readonly string[]): string {
  return execFileSync(command, [...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: command === '/usr/bin/swift' ? 10_000 : 2_000,
  });
}

function token(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\0')).digest('hex');
}

const DARWIN_PROCESS_BIRTH_PROBE = `import Darwin
guard CommandLine.arguments.count == 2,
      let pid = Int32(CommandLine.arguments[1]) else {
  exit(2)
}
var info = proc_bsdinfo()
let expectedSize = Int32(MemoryLayout<proc_bsdinfo>.size)
let observedSize = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, expectedSize)
guard observedSize == expectedSize, info.pbi_pid == pid else {
  exit(3)
}
print("\\(info.pbi_pid):\\(info.pbi_start_tvsec):\\(info.pbi_start_tvusec)")
`;

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
      const processInfo = run('/usr/bin/swift', [
        '-e',
        DARWIN_PROCESS_BIRTH_PROBE,
        String(pid),
      ]).trim();
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
          token: token([
            platform,
            bootSession.toLowerCase(),
            processMatch[2],
            processMatch[3],
          ]),
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
