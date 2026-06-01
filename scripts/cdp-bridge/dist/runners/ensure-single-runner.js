import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const DAEMON_JSON = join(homedir(), '.agent-device', 'daemon.json');
const DAEMON_LOCK = join(homedir(), '.agent-device', 'daemon.lock');
const DAEMON_FILES = [DAEMON_JSON, DAEMON_LOCK];
const SIGKILL_GRACE_MS = 500;
/**
 * GH#202: parse `ps -A -o pid=,args=` output and return the PIDs of stale
 * legacy `AgentDeviceRunner*` processes bound to `udid`. Conservative by
 * design: a line must reference both the legacy runner AND the target UDID,
 * and must NOT be our own RnFastRunner. A leak whose argv omits the UDID
 * matches nothing here (no false kill) rather than being guessed at.
 */
export function selectLegacyRunnerPids(psOutput, udid) {
    const pids = [];
    for (const line of psOutput.split('\n')) {
        if (!line.includes('AgentDeviceRunner'))
            continue;
        if (line.includes('RnFastRunner'))
            continue;
        if (!udid || !line.includes(udid))
            continue;
        const m = line.trim().match(/^(\d+)\b/);
        if (m)
            pids.push(Number(m[1]));
    }
    return pids;
}
/** GH#202: remove orphaned daemon files only when their PID is dead or absent. */
export function shouldRemoveDaemonFiles(daemonPid, isAlive) {
    if (daemonPid === null)
        return true;
    return !isAlive(daemonPid);
}
function defaultDeps() {
    return {
        listProcesses: () => {
            try {
                return execFileSync('ps', ['-A', '-o', 'pid=,args='], { encoding: 'utf8', timeout: 3_000 });
            }
            catch {
                return '';
            }
        },
        kill: (pid, signal) => process.kill(pid, signal),
        isAlive: (pid) => {
            try {
                process.kill(pid, 0);
                return true;
            }
            catch {
                return false;
            }
        },
        readDaemonPid: () => {
            try {
                const parsed = JSON.parse(readFileSync(DAEMON_JSON, 'utf8'));
                return typeof parsed.pid === 'number' ? parsed.pid : null;
            }
            catch {
                return null;
            }
        },
        fileExists: (path) => existsSync(path),
        removeFile: (path) => unlinkSync(path),
        delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    };
}
/**
 * GH#202 Phase 1: enforce a single iOS interaction runner.
 *  - With `udid` (device-open): SIGTERM/SIGKILL stale AgentDeviceRunner procs
 *    scoped to that simulator.
 *  - Always: remove orphaned ~/.agent-device/daemon.{json,lock} when the
 *    daemon PID is dead. A live daemon is left alone (it may belong to a
 *    different project's Android session).
 * Never touches a live process at startup (no udid -> no process scan).
 */
export async function ensureSingleRunner(opts = {}, deps = defaultDeps()) {
    const timings = {};
    const killedPids = [];
    const removedFiles = [];
    const warnings = [];
    if (opts.udid) {
        const t = Date.now();
        let psOut = '';
        try {
            psOut = deps.listProcesses();
        }
        catch (err) {
            warnings.push(`ps failed: ${msg(err)}`);
        }
        for (const pid of selectLegacyRunnerPids(psOut, opts.udid)) {
            try {
                deps.kill(pid, 'SIGTERM');
                await deps.delay(SIGKILL_GRACE_MS);
                if (deps.isAlive(pid))
                    deps.kill(pid, 'SIGKILL');
                killedPids.push(pid);
            }
            catch (err) {
                warnings.push(`kill ${pid} failed: ${msg(err)}`);
            }
        }
        timings.scopedKill = Date.now() - t;
    }
    const tFiles = Date.now();
    if (DAEMON_FILES.some((f) => deps.fileExists(f))) {
        let daemonPid = null;
        try {
            daemonPid = deps.readDaemonPid();
        }
        catch {
            daemonPid = null;
        }
        if (shouldRemoveDaemonFiles(daemonPid, deps.isAlive)) {
            for (const f of DAEMON_FILES) {
                if (!deps.fileExists(f))
                    continue;
                try {
                    deps.removeFile(f);
                    removedFiles.push(f);
                }
                catch (err) {
                    warnings.push(`rm ${f} failed: ${msg(err)}`);
                }
            }
        }
        else {
            warnings.push(`Left ${DAEMON_JSON} in place — daemon PID ${daemonPid} is alive (may belong to another project).`);
        }
    }
    timings.fileCleanup = Date.now() - tFiles;
    return { killedPids, removedFiles, warnings, meta: { timings_ms: timings } };
}
function msg(err) {
    return err instanceof Error ? err.message : String(err);
}
