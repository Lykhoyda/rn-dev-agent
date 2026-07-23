import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { findProjectRoot } from '../nav-graph/storage.js';
export const CWD_LSOF_TIMEOUT_MS = 800;
const defaultExec = (cmd, args) => execFileSync(cmd, args, {
    timeout: CWD_LSOF_TIMEOUT_MS,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
});
const pidCwdCache = new Map();
export function _resetMetroCwdCacheForTest() {
    pidCwdCache.clear();
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
export function pidForPort(port, exec = defaultExec) {
    try {
        return parseLsofPid(exec('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN']));
    }
    catch {
        return null;
    }
}
function cwdForPid(pid, exec) {
    if (pidCwdCache.has(pid))
        return pidCwdCache.get(pid) ?? null;
    let cwd = null;
    try {
        cwd = parseLsofCwd(exec('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']));
    }
    catch {
        cwd = null;
    }
    pidCwdCache.set(pid, cwd);
    return cwd;
}
function realpathOrResolve(p) {
    try {
        return realpathSync(resolve(p));
    }
    catch {
        return resolve(p);
    }
}
export function cwdForPort(port, exec = defaultExec) {
    if (exec === defaultExec && process.platform !== 'darwin')
        return null;
    const pid = pidForPort(port, exec);
    if (pid == null)
        return null;
    const cwd = cwdForPid(pid, exec);
    return cwd ? realpathOrResolve(cwd) : null;
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
export function resolveBridgeProjectRoot() {
    const root = findProjectRoot();
    return root ? realpathOrResolve(root) : null;
}
