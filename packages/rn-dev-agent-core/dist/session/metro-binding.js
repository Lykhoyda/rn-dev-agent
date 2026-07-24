import { execFileSync } from 'node:child_process';
import { cwdForPort, pathMatchesRoot } from '../cdp/metro-cwd.js';
import { readProcessBirth } from './process-birth.js';
function numericListener(output, emptyStatus) {
    const value = String(output).trim();
    if (!value)
        return { status: emptyStatus };
    const candidates = value.split(/\s+/);
    if (candidates.some((candidate) => !/^\d+$/.test(candidate))) {
        return { status: 'unknown' };
    }
    const pids = new Set(candidates.map(Number));
    const [pid] = pids;
    return pids.size === 1 && Number.isSafeInteger(pid) && pid > 0
        ? { status: 'listening', pid }
        : { status: 'unknown' };
}
export function probeMetroListener(port, platform = process.platform, execute = execFileSync) {
    try {
        if (platform === 'win32') {
            const output = execute('powershell.exe', [
                '-NoProfile',
                '-NonInteractive',
                '-Command',
                `$connections = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object LocalPort -eq ${port}); ` +
                    `if ($connections.Count -eq 0) { 'ABSENT' } else { $connections.OwningProcess | Sort-Object -Unique }`,
            ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2_000 });
            return String(output).trim() === 'ABSENT'
                ? { status: 'absent' }
                : numericListener(output, 'unknown');
        }
        if (platform === 'linux') {
            const output = execute('ss', ['-H', '-ltnp', `sport = :${port}`], {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore'],
                timeout: 2_000,
            });
            const value = String(output).trim();
            if (!value)
                return { status: 'absent' };
            const pids = new Set([...value.matchAll(/pid=(\d+)/g)].map((match) => Number(match[1])));
            const [pid] = pids;
            return pids.size === 1 && Number.isSafeInteger(pid) && pid > 0
                ? { status: 'listening', pid }
                : { status: 'unknown' };
        }
        if (platform === 'darwin') {
            const output = execute('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'pipe'],
                timeout: 2_000,
            });
            return numericListener(output, 'unknown');
        }
        return { status: 'unknown' };
    }
    catch (error) {
        const failure = error;
        return platform === 'darwin' &&
            failure.status === 1 &&
            !String(failure.stdout ?? '').trim() &&
            !String(failure.stderr ?? '').trim()
            ? { status: 'absent' }
            : { status: 'unknown' };
    }
}
export function metroListenerPid(port, platform = process.platform, execute = execFileSync) {
    const probe = probeMetroListener(port, platform, execute);
    return probe.status === 'listening' ? probe.pid : null;
}
async function fetchMetroStatus(port) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2_000);
    try {
        const response = await fetch(`http://127.0.0.1:${port}/status`, {
            signal: controller.signal,
        });
        if (!response.ok)
            throw new Error(`HTTP ${response.status}`);
        return await response.text();
    }
    finally {
        clearTimeout(timer);
    }
}
export async function captureMetroBinding(input, dependencies = {}) {
    if (!Number.isSafeInteger(input.port) ||
        input.port < 1 ||
        input.port > 65_535 ||
        !Number.isSafeInteger(input.pid) ||
        input.pid < 1 ||
        !input.instanceId ||
        !Number.isSafeInteger(input.buildGeneration) ||
        input.buildGeneration < 1) {
        throw new Error('METRO_AUTHORITY_MISMATCH: Metro binding is incomplete');
    }
    const listenerPid = (dependencies.listenerPid ?? metroListenerPid)(input.port);
    if (listenerPid !== input.pid) {
        throw new Error('METRO_AUTHORITY_MISMATCH: Metro process does not own the claimed listener');
    }
    const birth = (dependencies.readBirth ?? readProcessBirth)(input.pid);
    if (!birth) {
        throw new Error('PROCESS_BIRTH_UNAVAILABLE: Metro process birth could not be proven conservatively');
    }
    const status = await (dependencies.fetchStatus ?? fetchMetroStatus)(input.port);
    if (!status.includes('packager-status:running')) {
        throw new Error('METRO_AUTHORITY_MISMATCH: claimed Metro endpoint is not running');
    }
    const servingRoot = (dependencies.servingRoot ?? cwdForPort)(input.port);
    if (!servingRoot || !pathMatchesRoot(servingRoot, input.sourceRoot)) {
        throw new Error('METRO_AUTHORITY_MISMATCH: Metro serving root does not match the source worktree');
    }
    return {
        port: input.port,
        pid: input.pid,
        birth: birth.token,
        instanceId: input.instanceId,
        servingRoot,
        buildGeneration: input.buildGeneration,
    };
}
