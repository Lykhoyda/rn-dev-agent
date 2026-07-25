import { execFileSync } from 'node:child_process';
import { readlinkSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { findProjectRoot } from '../nav-graph/storage.js';

export const CWD_LSOF_TIMEOUT_MS = 800;

export type ExecFn = (cmd: string, args: string[]) => string;

const defaultExec: ExecFn = (cmd, args) =>
  execFileSync(cmd, args, {
    timeout: CWD_LSOF_TIMEOUT_MS,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });

export function _resetMetroCwdCacheForTest(): void {
  // Retained for compatibility with older tests and callers.
}

export function parseLsofPid(stdout: string): number | null {
  for (const line of stdout.split('\n')) {
    const n = parseInt(line.trim(), 10);
    if (!isNaN(n) && n > 0) return n;
  }
  return null;
}

export function parseLsofCwd(stdout: string): string | null {
  for (const line of stdout.split('\n')) {
    if (line.startsWith('n')) {
      const path = line.slice(1).trim();
      if (path) return path;
    }
  }
  return null;
}

export function pidForPort(port: number, exec: ExecFn = defaultExec): number | null {
  try {
    return parseLsofPid(exec('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN']));
  } catch {
    return null;
  }
}

export function cwdForProcess(
  pid: number,
  platform: NodeJS.Platform = process.platform,
  exec: ExecFn = defaultExec,
  readLink: typeof readlinkSync = readlinkSync,
): string | null {
  try {
    if (platform === 'linux') {
      return realpathOrResolve(readLink(`/proc/${pid}/cwd`));
    }
    if (platform === 'darwin') {
      const cwd = parseLsofCwd(exec('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']));
      return cwd ? realpathOrResolve(cwd) : null;
    }
    if (platform === 'win32') {
      const commandLine = exec('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" -ErrorAction Stop).CommandLine`,
      ]);
      const explicitRoot =
        /(?:^|\s)--(?:projectRoot|project-root)(?:=|\s+)(?:"([^"]+)"|'([^']+)'|(\S+))/i.exec(
          commandLine,
        );
      const root = explicitRoot?.[1] ?? explicitRoot?.[2] ?? explicitRoot?.[3];
      return root ? realpathOrResolve(root) : null;
    }
    return null;
  } catch {
    return null;
  }
}

function realpathOrResolve(p: string): string {
  try {
    return realpathSync(resolve(p));
  } catch {
    return resolve(p);
  }
}

export function cwdForPort(port: number, exec: ExecFn = defaultExec): string | null {
  if (exec === defaultExec && process.platform !== 'darwin') return null;
  const pid = pidForPort(port, exec);
  if (pid == null) return null;
  return cwdForProcess(pid, 'darwin', exec);
}

export function pathMatchesRoot(
  servingCwd: string | null,
  projectRoot: string | null | undefined,
): boolean {
  if (!servingCwd || !projectRoot) return false;
  const a = realpathOrResolve(servingCwd);
  const b = realpathOrResolve(projectRoot);
  if (a === b) return true;
  return a.startsWith(b + sep) || b.startsWith(a + sep);
}

export function pathIsWithinRoot(
  candidate: string | null,
  root: string | null | undefined,
): boolean {
  if (!candidate || !root) return false;
  const canonicalCandidate = realpathOrResolve(candidate);
  const canonicalRoot = realpathOrResolve(root);
  return canonicalCandidate === canonicalRoot || canonicalCandidate.startsWith(canonicalRoot + sep);
}

export function resolveBridgeProjectRoot(): string | null {
  const root = findProjectRoot();
  return root ? realpathOrResolve(root) : null;
}
