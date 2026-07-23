import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
function defaultRun(command, args) {
    return execFileSync(command, [...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 2_000,
    });
}
function token(parts) {
    return createHash('sha256').update(parts.join('\0')).digest('hex');
}
export function readProcessBirth(pid, dependencies = {}) {
    const probe = probeProcessBirth(pid, dependencies);
    return probe.status === 'present' ? probe.birth : null;
}
export function probeProcessBirth(pid, dependencies = {}) {
    if (!Number.isSafeInteger(pid) || pid <= 0)
        return { status: 'unknown' };
    const platform = dependencies.platform ?? process.platform;
    const read = dependencies.read ?? ((path) => readFileSync(path, 'utf8'));
    const run = dependencies.run ?? defaultRun;
    if (platform === 'darwin')
        return { status: 'unknown' };
    try {
        if (platform === 'linux') {
            const boot = read('/proc/sys/kernel/random/boot_id').trim();
            let stat;
            try {
                stat = read(`/proc/${pid}/stat`).trim();
            }
            catch (error) {
                return error.code === 'ENOENT'
                    ? { status: 'absent' }
                    : { status: 'unknown' };
            }
            const commandEnd = stat.lastIndexOf(')');
            const fields = commandEnd >= 0
                ? stat
                    .slice(commandEnd + 1)
                    .trim()
                    .split(/\s+/)
                : [];
            const started = fields[19];
            if (!boot || !started || !/^\d+$/.test(started))
                return { status: 'unknown' };
            return {
                status: 'present',
                birth: { pid, source: 'linux-proc', token: token([platform, boot, started]) },
            };
        }
        if (platform === 'win32') {
            const script = `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; ` +
                `if ($null -eq $p) { 'ABSENT' } else { $p.StartTime.ToUniversalTime().Ticks }`;
            const started = run('powershell.exe', [
                '-NoProfile',
                '-NonInteractive',
                '-Command',
                script,
            ]).trim();
            if (started === 'ABSENT')
                return { status: 'absent' };
            if (!/^\d+$/.test(started))
                return { status: 'unknown' };
            return {
                status: 'present',
                birth: { pid, source: 'windows-powershell', token: token([platform, started]) },
            };
        }
    }
    catch {
        return { status: 'unknown' };
    }
    return { status: 'unknown' };
}
export function processBirthMatches(expected, dependencies = {}) {
    const observed = readProcessBirth(expected.pid, dependencies);
    return observed !== null && observed.token === expected.token;
}
