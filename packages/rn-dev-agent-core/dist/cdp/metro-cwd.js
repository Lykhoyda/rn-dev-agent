import { execFileSync } from 'node:child_process';
import { readlinkSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { findProjectRoot } from '../nav-graph/storage.js';
import { resolveTrustedSystemExecutable, } from '../util/trusted-system-executable.js';
export const CWD_LSOF_TIMEOUT_MS = 800;
const defaultExec = (cmd, args) => execFileSync(cmd, args, {
    timeout: CWD_LSOF_TIMEOUT_MS,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
});
export function _resetMetroCwdCacheForTest() {
    // Retained for compatibility with older tests and callers.
}
export function parseLsofPid(stdout) {
    for (const line of stdout.split('\n')) {
        const n = parseInt(line.trim(), 10);
        if (!isNaN(n) && n > 0)
            return n;
    }
    return null;
}
export function parseLsofCwd(stdout) {
    for (const line of stdout.split('\n')) {
        if (line.startsWith('n')) {
            const path = line.slice(1).trim();
            if (path)
                return path;
        }
    }
    return null;
}
export function pidForPort(port, exec = defaultExec, platform = process.platform, executableDependencies = {}) {
    try {
        if (platform === 'win32') {
            const powershell = resolveTrustedSystemExecutable('powershell', platform, executableDependencies);
            if (!powershell)
                return null;
            const output = exec(powershell, [
                '-NoProfile',
                '-NonInteractive',
                '-Command',
                `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction Stop | Select-Object -First 1 -ExpandProperty OwningProcess)`,
            ]);
            const pid = Number.parseInt(output.trim(), 10);
            return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
        }
        const lsof = resolveTrustedSystemExecutable('lsof', platform, executableDependencies);
        return lsof
            ? parseLsofPid(exec(lsof, ['-ti', `tcp:${port}`, '-sTCP:LISTEN']))
            : null;
    }
    catch {
        return null;
    }
}
export function parseWindowsMetroRoot(commandLine) {
    const explicitRoot = /(?:^|\s)--(?:projectRoot|project-root)(?:=|\s+)(?:"([^"]+)"|'([^']+)'|(\S+))/i.exec(commandLine);
    const explicit = explicitRoot?.[1] ?? explicitRoot?.[2] ?? explicitRoot?.[3];
    return explicit ?? null;
}
export function cwdForProcess(pid, platform = process.platform, exec = defaultExec, readLink = readlinkSync, executableDependencies = {}) {
    try {
        if (platform === 'linux') {
            return realpathOrResolve(readLink(`/proc/${pid}/cwd`));
        }
        if (platform === 'darwin') {
            const lsof = resolveTrustedSystemExecutable('lsof', platform, executableDependencies);
            if (!lsof)
                return null;
            const cwd = parseLsofCwd(exec(lsof, ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']));
            return cwd ? realpathOrResolve(cwd) : null;
        }
        if (platform === 'win32') {
            const powershell = resolveTrustedSystemExecutable('powershell', platform, executableDependencies);
            if (!powershell)
                return null;
            const commandLine = exec(powershell, [
                '-NoProfile',
                '-NonInteractive',
                '-Command',
                `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" -ErrorAction Stop).CommandLine`,
            ]);
            const root = parseWindowsMetroRoot(commandLine);
            return root ? realpathOrResolve(root) : null;
        }
        return null;
    }
    catch {
        return null;
    }
}
function realpathOrResolve(p) {
    try {
        return realpathSync(resolve(p));
    }
    catch {
        return resolve(p);
    }
}
export function cwdForPort(port, exec = defaultExec, platform = process.platform, executableDependencies = {}) {
    const pid = pidForPort(port, exec, platform, executableDependencies);
    if (pid == null)
        return null;
    return cwdForProcess(pid, platform, exec, readlinkSync, executableDependencies);
}
export function pathMatchesRoot(servingCwd, projectRoot) {
    if (!servingCwd || !projectRoot)
        return false;
    const a = realpathOrResolve(servingCwd);
    const b = realpathOrResolve(projectRoot);
    if (a === b)
        return true;
    return a.startsWith(b + sep) || b.startsWith(a + sep);
}
export function pathIsWithinRoot(candidate, root) {
    if (!candidate || !root)
        return false;
    const canonicalCandidate = realpathOrResolve(candidate);
    const canonicalRoot = realpathOrResolve(root);
    return canonicalCandidate === canonicalRoot || canonicalCandidate.startsWith(canonicalRoot + sep);
}
export function resolveBridgeProjectRoot() {
    const root = findProjectRoot();
    return root ? realpathOrResolve(root) : null;
}
