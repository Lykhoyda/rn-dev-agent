import { spawn } from 'node:child_process';
import { unlinkSync } from 'node:fs';
const OUTPUT_LIMIT = 10 * 1024 * 1024;
const TERM_GRACE_MS = 500;
const ABSENCE_CONFIRM_MS = 2_000;
const POLL_MS = 25;
const activeCleanupRefusals = new Map();
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function cleanupKey(platform, deviceId) {
    return `${platform}:${deviceId}`;
}
function cleanupRefusal(pgid) {
    return {
        processGroup: 'owned-process-group',
        manualCommand: `kill -TERM -${pgid}`,
    };
}
function groupPresence(pgid, signalGroup) {
    try {
        signalGroup(pgid, 0);
        return 'present';
    }
    catch (error) {
        return error.code === 'ESRCH' ? 'absent' : 'unknown';
    }
}
async function waitForGroupAbsence(pgid, signalGroup, delay, timeoutMs = ABSENCE_CONFIRM_MS) {
    const deadline = Date.now() + timeoutMs;
    while (true) {
        const presence = groupPresence(pgid, signalGroup);
        if (presence !== 'present')
            return presence;
        if (Date.now() >= deadline)
            return 'present';
        await delay(POLL_MS);
    }
}
function observeChildTerminal(child, timeoutMs) {
    let stop = () => { };
    const result = new Promise((resolve) => {
        let settled = false;
        let timer;
        const done = (value) => {
            if (settled)
                return;
            settled = true;
            if (timer)
                clearTimeout(timer);
            resolve(value);
        };
        child.once('error', (error) => done({ code: null, signal: null, timedOut: false, error: error.message }));
        child.once('close', (code, signal) => done({ code, signal, timedOut: false }));
        timer = setTimeout(() => done({ code: null, signal: 'SIGTERM', timedOut: true }), timeoutMs);
        stop = () => done({ code: null, signal: null, timedOut: false });
    });
    return { result, stop };
}
function activeRefusal(platform, deviceId, signalGroup) {
    if (!deviceId)
        return null;
    const key = cleanupKey(platform, deviceId);
    const refusal = activeCleanupRefusals.get(key);
    if (!refusal)
        return null;
    if (groupPresence(refusal.pgid, signalGroup) === 'absent') {
        activeCleanupRefusals.delete(key);
        return null;
    }
    return refusal.public;
}
export async function spawnManagedProcessGroup(bin, args, options, dependencies = {}) {
    const spawnProcess = dependencies.spawn ?? spawn;
    const delay = dependencies.sleep ?? sleep;
    const signalGroup = dependencies.signalGroup ??
        ((pgid, signal) => {
            if (process.platform === 'win32')
                process.kill(pgid, signal);
            else
                process.kill(-pgid, signal);
        });
    const refusal = activeRefusal(options.platform, options.deviceId, signalGroup);
    if (refusal) {
        return {
            stdout: '',
            stderr: '',
            code: null,
            signal: null,
            timedOut: false,
            cleanupProven: false,
            cleanupEscalated: false,
            cleanupRefusal: refusal,
            error: 'AUTOMATION_CLEANUP_UNPROVEN: a prior owned process group remains unproven',
        };
    }
    let child;
    try {
        child = spawnProcess(bin, args, {
            detached: process.platform !== 'win32',
            env: options.env ?? process.env,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
    }
    catch (error) {
        return {
            stdout: '',
            stderr: '',
            code: null,
            signal: null,
            timedOut: false,
            cleanupProven: true,
            cleanupEscalated: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
    const terminalObserver = observeChildTerminal(child, options.timeoutMs);
    const pid = child.pid;
    if (!pid) {
        const terminal = await terminalObserver.result;
        return {
            stdout: '',
            stderr: '',
            code: null,
            signal: null,
            timedOut: false,
            cleanupProven: true,
            cleanupEscalated: false,
            error: terminal.error ?? 'Managed automation process did not expose a PID',
        };
    }
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let overflow = false;
    const collect = (target) => (chunk) => {
        if (outputBytes >= OUTPUT_LIMIT) {
            overflow = true;
            return;
        }
        const remaining = OUTPUT_LIMIT - outputBytes;
        target.push(chunk.subarray(0, remaining));
        outputBytes += Math.min(chunk.length, remaining);
        if (chunk.length > remaining)
            overflow = true;
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    const terminal = await terminalObserver.result;
    let cleanupEscalated = false;
    let presence = await waitForGroupAbsence(pid, signalGroup, delay, terminal.timedOut ? 0 : 250);
    if (terminal.timedOut || overflow || presence === 'present') {
        try {
            signalGroup(pid, 'SIGTERM');
        }
        catch { }
        presence = await waitForGroupAbsence(pid, signalGroup, delay, TERM_GRACE_MS);
        if (presence === 'present') {
            cleanupEscalated = true;
            try {
                signalGroup(pid, 'SIGKILL');
            }
            catch { }
            presence = await waitForGroupAbsence(pid, signalGroup, delay);
        }
    }
    const cleanupProven = presence === 'absent';
    const unproven = cleanupProven ? undefined : cleanupRefusal(pid);
    if (unproven && options.deviceId) {
        activeCleanupRefusals.set(cleanupKey(options.platform, options.deviceId), {
            pgid: pid,
            public: unproven,
        });
    }
    return {
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        code: terminal.code,
        signal: terminal.signal,
        timedOut: terminal.timedOut,
        cleanupProven,
        cleanupEscalated,
        ...(unproven ? { cleanupRefusal: unproven } : {}),
        ...(overflow
            ? { error: 'Maestro output exceeded 10 MiB' }
            : terminal.error
                ? { error: terminal.error }
                : {}),
    };
}
export function removeTemporaryInlineFlow(path) {
    try {
        unlinkSync(path);
    }
    catch { }
}
