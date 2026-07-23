import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export interface ProcessBirth {
  pid: number;
  source: 'darwin-ps' | 'linux-proc' | 'windows-powershell';
  token: string;
}

interface ProcessBirthDependencies {
  platform?: NodeJS.Platform;
  read?: (path: string) => string;
  run?: (command: string, args: readonly string[]) => string;
}

function defaultRun(command: string, args: readonly string[]): string {
  return execFileSync(command, [...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 2_000,
  });
}

function token(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\0')).digest('hex');
}

export function readProcessBirth(
  pid: number,
  dependencies: ProcessBirthDependencies = {},
): ProcessBirth | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;

  const platform = dependencies.platform ?? process.platform;
  const read = dependencies.read ?? ((path: string) => readFileSync(path, 'utf8'));
  const run = dependencies.run ?? defaultRun;

  try {
    if (platform === 'darwin') return null;

    if (platform === 'linux') {
      const boot = read('/proc/sys/kernel/random/boot_id').trim();
      const stat = read(`/proc/${pid}/stat`).trim();
      const commandEnd = stat.lastIndexOf(')');
      const fields =
        commandEnd >= 0
          ? stat
              .slice(commandEnd + 1)
              .trim()
              .split(/\s+/)
          : [];
      const started = fields[19];
      if (!boot || !started || !/^\d+$/.test(started)) return null;
      return { pid, source: 'linux-proc', token: token([platform, boot, started]) };
    }

    if (platform === 'win32') {
      const script = `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`;
      const started = run('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        script,
      ]).trim();
      if (!/^\d+$/.test(started)) return null;
      return { pid, source: 'windows-powershell', token: token([platform, started]) };
    }
  } catch {
    return null;
  }

  return null;
}

export function processBirthMatches(
  expected: Pick<ProcessBirth, 'pid' | 'token'>,
  dependencies: ProcessBirthDependencies = {},
): boolean {
  const observed = readProcessBirth(expected.pid, dependencies);
  return observed !== null && observed.token === expected.token;
}
