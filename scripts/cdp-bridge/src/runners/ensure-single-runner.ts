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
export function selectLegacyRunnerPids(psOutput: string, udid: string): number[] {
  const pids: number[] = [];
  for (const line of psOutput.split('\n')) {
    if (!line.includes('AgentDeviceRunner')) continue;
    if (line.includes('RnFastRunner')) continue;
    if (!udid || !line.includes(udid)) continue;
    const m = line.trim().match(/^(\d+)\b/);
    if (m) pids.push(Number(m[1]));
  }
  return pids;
}

/** GH#202: remove orphaned daemon files only when their PID is dead or absent. */
export function shouldRemoveDaemonFiles(
  daemonPid: number | null,
  isAlive: (pid: number) => boolean,
): boolean {
  if (daemonPid === null) return true;
  return !isAlive(daemonPid);
}

export interface EnsureSingleRunnerResult {
  killedPids: number[];
  removedFiles: string[];
  warnings: string[];
  meta: { timings_ms: Record<string, number> };
}

export interface EnsureSingleRunnerDeps {
  listProcesses: () => string;
  kill: (pid: number, signal: NodeJS.Signals) => void;
  isAlive: (pid: number) => boolean;
  readDaemonPid: () => number | null;
  fileExists: (path: string) => boolean;
  removeFile: (path: string) => void;
  delay: (ms: number) => Promise<void>;
}

function defaultDeps(): EnsureSingleRunnerDeps {
  return {
    // Let a `ps` failure (timeout / EAGAIN under load) PROPAGATE to the
    // caller's try/catch, which records a warning. Swallowing it here and
    // returning '' made single-runner enforcement degrade to a silent no-op
    // with no operator signal — exactly when the machine is busy.
    listProcesses: () =>
      execFileSync('ps', ['-A', '-o', 'pid=,args='], { encoding: 'utf8', timeout: 3_000 }),
    kill: (pid, signal) => process.kill(pid, signal),
    isAlive: (pid) => {
      try { process.kill(pid, 0); return true; } catch { return false; }
    },
    readDaemonPid: () => {
      try {
        const parsed = JSON.parse(readFileSync(DAEMON_JSON, 'utf8')) as { pid?: unknown };
        return typeof parsed.pid === 'number' ? parsed.pid : null;
      } catch {
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
export async function ensureSingleRunner(
  opts: { udid?: string } = {},
  deps: EnsureSingleRunnerDeps = defaultDeps(),
): Promise<EnsureSingleRunnerResult> {
  const timings: Record<string, number> = {};
  const killedPids: number[] = [];
  const removedFiles: string[] = [];
  const warnings: string[] = [];

  if (opts.udid) {
    const t = Date.now();
    let psOut = '';
    try { psOut = deps.listProcesses(); } catch (err) { warnings.push(`ps failed: ${msg(err)}`); }
    for (const pid of selectLegacyRunnerPids(psOut, opts.udid)) {
      try {
        deps.kill(pid, 'SIGTERM');
        await deps.delay(SIGKILL_GRACE_MS);
        if (deps.isAlive(pid)) deps.kill(pid, 'SIGKILL');
        killedPids.push(pid);
      } catch (err) {
        warnings.push(`kill ${pid} failed: ${msg(err)}`);
      }
    }
    timings.scopedKill = Date.now() - t;
  }

  const tFiles = Date.now();
  if (DAEMON_FILES.some((f) => deps.fileExists(f))) {
    let daemonPid: number | null = null;
    try { daemonPid = deps.readDaemonPid(); } catch { daemonPid = null; }
    if (shouldRemoveDaemonFiles(daemonPid, deps.isAlive)) {
      for (const f of DAEMON_FILES) {
        if (!deps.fileExists(f)) continue;
        try { deps.removeFile(f); removedFiles.push(f); }
        catch (err) { warnings.push(`rm ${f} failed: ${msg(err)}`); }
      }
    } else {
      warnings.push(`Left ${DAEMON_JSON} in place — daemon PID ${daemonPid} is alive (may belong to another project).`);
    }
  }
  timings.fileCleanup = Date.now() - tFiles;

  return { killedPids, removedFiles, warnings, meta: { timings_ms: timings } };
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
