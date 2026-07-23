import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
const DARWIN_PROCESS_BIRTH_SCRIPT = String.raw `
import ctypes
import errno
import sys

class ProcBsdInfo(ctypes.Structure):
    _fields_ = [
        ("flags", ctypes.c_uint32),
        ("status", ctypes.c_uint32),
        ("xstatus", ctypes.c_uint32),
        ("pid", ctypes.c_uint32),
        ("ppid", ctypes.c_uint32),
        ("uid", ctypes.c_uint32),
        ("gid", ctypes.c_uint32),
        ("ruid", ctypes.c_uint32),
        ("rgid", ctypes.c_uint32),
        ("svuid", ctypes.c_uint32),
        ("svgid", ctypes.c_uint32),
        ("comm", ctypes.c_char * 16),
        ("name", ctypes.c_char * 32),
        ("nfiles", ctypes.c_uint32),
        ("pgid", ctypes.c_uint32),
        ("pjobc", ctypes.c_uint32),
        ("e_tdev", ctypes.c_uint32),
        ("e_tpgid", ctypes.c_uint32),
        ("nice", ctypes.c_int32),
        ("start_tvsec", ctypes.c_uint64),
        ("start_tvusec", ctypes.c_uint64),
    ]

pid = int(sys.argv[1])
info = ProcBsdInfo()
libproc = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
libproc.proc_pidinfo.argtypes = [
    ctypes.c_int,
    ctypes.c_int,
    ctypes.c_uint64,
    ctypes.c_void_p,
    ctypes.c_int,
]
libproc.proc_pidinfo.restype = ctypes.c_int
size = ctypes.sizeof(info)
result = libproc.proc_pidinfo(pid, 3, 0, ctypes.byref(info), size)

if result == 0:
    print("ABSENT" if ctypes.get_errno() == errno.ESRCH else "UNKNOWN")
elif result != size or info.pid != pid:
    print("UNKNOWN")
else:
    print(f"{info.pid}:{info.start_tvsec}:{info.start_tvusec}")
`;
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
    try {
        if (platform === 'darwin') {
            const processInfo = run('/usr/bin/python3', [
                '-I',
                '-S',
                '-c',
                DARWIN_PROCESS_BIRTH_SCRIPT,
                String(pid),
            ]).trim();
            if (processInfo === 'ABSENT')
                return { status: 'absent' };
            const match = /^(\d+):(\d+):(\d+)$/.exec(processInfo);
            if (!match || Number(match[1]) !== pid || match[2] === '0' || Number(match[3]) > 999_999) {
                return { status: 'unknown' };
            }
            const bootSession = run('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid']).trim();
            if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(bootSession)) {
                return { status: 'unknown' };
            }
            return {
                status: 'present',
                birth: {
                    pid,
                    source: 'darwin-libproc',
                    token: token([platform, bootSession.toLowerCase(), match[2], match[3]]),
                },
            };
        }
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
