import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { stopAndroidRunner } from './rn-android-runner-client.js';
import { getAdbSerial } from '../agent-device-wrapper.js';

const execFile = promisify(execFileCb);

const DAEMON_JSON = join(homedir(), '.agent-device', 'daemon.json');
const DAEMON_LOCK = join(homedir(), '.agent-device', 'daemon.lock');
const DAEMON_FILES = [DAEMON_JSON, DAEMON_LOCK];
const SIGKILL_GRACE_MS = 500;
const ADB_TIMEOUT_MS = 5_000;

// The two packages our in-tree Android runner installs (see
// rn-android-runner-client.ts:18 — INSTRUMENTATION). Force-stopping these frees
// the device-side UiAutomation slot for maestro-runner's UIAutomator2 server.
// We force-stop ONLY these — never a foreign UIAutomator2 package (that overreach
// is what killed the MCP server in the #237 repro's `pkill -f agent-device`).
export const OWNED_PACKAGES = [
  'dev.lykhoyda.rndevagent.androidrunner.test',
  'dev.lykhoyda.rndevagent.androidrunner',
] as const;

/**
 * Self-kill guard: never SIGTERM/SIGKILL our own process or our parent. The
 * legacy daemon PID is read from ~/.agent-device/daemon.json, which can hold a
 * stale, OS-recycled PID — without this guard a recycled PID matching our own
 * tree would kill the MCP server (the exact collateral of `pkill -f agent-device`).
 */
export function isProtectedPid(pid: number, selfPid: number, parentPid: number): boolean {
  return pid === selfPid || pid === parentPid;
}

export interface ReleaseAndroidSlotResult {
  deviceId: string;
  stoppedOwnRunner: boolean;
  forceStoppedPackages: string[];
  killedDaemonPids: number[];
  removedFiles: string[];
  warnings: string[];
  meta: { timings_ms: Record<string, number> };
}

export interface ReleaseAndroidSlotDeps {
  stopOwnRunner: (deviceId?: string, signal?: AbortSignal) => Promise<void>;
  adbForceStop: (pkg: string, serial: string[], signal?: AbortSignal) => Promise<void>;
  resolveSerial: (deviceId?: string) => string[];
  readDaemonPid: () => number | null;
  isAlive: (pid: number) => boolean;
  protectedPids: () => { selfPid: number; parentPid: number };
  kill: (pid: number, sig: NodeJS.Signals) => void;
  fileExists: (p: string) => boolean;
  removeFile: (p: string) => void;
  delay: (ms: number) => Promise<void>;
  killLegacy: () => boolean;
  now: () => number;
}

function defaultDeps(): ReleaseAndroidSlotDeps {
  return {
    stopOwnRunner: (deviceId, signal) => stopAndroidRunner(deviceId, signal),
    adbForceStop: async (pkg, serial, signal) => {
      await execFile('adb', [...serial, 'shell', 'am', 'force-stop', pkg], {
        timeout: ADB_TIMEOUT_MS,
        encoding: 'utf8',
        signal,
      });
    },
    resolveSerial: (deviceId) => (deviceId ? ['-s', deviceId] : getAdbSerial()),
    readDaemonPid: () => {
      try {
        const parsed = JSON.parse(readFileSync(DAEMON_JSON, 'utf8')) as { pid?: unknown };
        return typeof parsed.pid === 'number' ? parsed.pid : null;
      } catch {
        return null;
      }
    },
    isAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },
    protectedPids: () => ({ selfPid: process.pid, parentPid: process.ppid }),
    kill: (pid, sig) => process.kill(pid, sig),
    fileExists: (p) => existsSync(p),
    removeFile: (p) => unlinkSync(p),
    delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    killLegacy: () => process.env.RN_DEVICE_KILL_LEGACY !== '0',
    now: () => Date.now(),
  };
}

export class ExactAndroidDeviceRequiredError extends Error {
  readonly code = 'EXACT_ANDROID_DEVICE_REQUIRED' as const;

  constructor(cause?: unknown) {
    super(
      'Refusing to release the Android interaction slot without an exact serial. ' +
        'When multiple adb targets are attached, open or bind a session to the intended device, ' +
        'pass deviceId, or set ANDROID_SERIAL, then retry. No device was mutated.',
      cause === undefined ? undefined : { cause },
    );
    this.name = 'ExactAndroidDeviceRequiredError';
  }
}

function resolveExactSerialArgs(
  deps: ReleaseAndroidSlotDeps,
  deviceId: string | undefined,
): string[] {
  try {
    return deps.resolveSerial(deviceId);
  } catch (err) {
    throw new ExactAndroidDeviceRequiredError(err);
  }
}

function exactSerial(deviceId: string | undefined, serialArgs: string[]): string {
  const serial = serialArgs.length === 2 && serialArgs[0] === '-s' ? serialArgs[1] : undefined;
  if (
    !serial ||
    (deviceId !== undefined && serial !== deviceId) ||
    serial.length > 256 ||
    /\s/.test(serial)
  ) {
    throw new ExactAndroidDeviceRequiredError();
  }
  return serial;
}

/**
 * GH#237 + GH#653: release the single Android UiAutomation slot before an L3
 * Maestro flow. Serial resolution is intentionally the first operation: without
 * one exact target this refuses before stopping a runner, force-stopping a
 * package, or touching legacy state. Once scoped, cleanup remains best-effort
 * and idempotent; each failure is returned as a warning for the caller to expose.
 * MUST run inside the held arbiter `flow` lease (no concurrent device_* can
 * re-grab the slot between release and bind).
 */
export async function releaseAndroidInteractionSlot(
  opts: { deviceId?: string; includeLegacy?: boolean; signal?: AbortSignal } = {},
  deps: ReleaseAndroidSlotDeps = defaultDeps(),
): Promise<ReleaseAndroidSlotResult> {
  opts.signal?.throwIfAborted();
  const serialArgs = resolveExactSerialArgs(deps, opts.deviceId);
  const deviceId = exactSerial(opts.deviceId, serialArgs);
  const timings: Record<string, number> = {};
  const warnings: string[] = [];
  const forceStoppedPackages: string[] = [];
  const killedDaemonPids: number[] = [];
  const removedFiles: string[] = [];
  let stoppedOwnRunner = false;

  // Step 1 — our own runner (always; it is our resource). Secondary cleanup:
  // kills the host `am instrument` handle + removes the adb forward. Does NOT
  // reliably free the device-side slot on its own (system_server keeps it).
  const tStop = deps.now();
  try {
    await deps.stopOwnRunner(deviceId, opts.signal);
    opts.signal?.throwIfAborted();
    stoppedOwnRunner = true;
  } catch (err) {
    opts.signal?.throwIfAborted();
    warnings.push(`stopping the Android runner failed: ${msg(err)}`);
  }
  timings.stopOwnRunner = deps.now() - tStop;

  // Step 2 — force-stop OUR instrumentation packages. THE decisive slot-release:
  // tears down the device-side instrumentation the SIGTERM left alive.
  const tForceStop = deps.now();
  for (const pkg of OWNED_PACKAGES) {
    opts.signal?.throwIfAborted();
    try {
      await deps.adbForceStop(pkg, serialArgs, opts.signal);
      opts.signal?.throwIfAborted();
      forceStoppedPackages.push(pkg);
    } catch (err) {
      opts.signal?.throwIfAborted();
      warnings.push(`am force-stop ${pkg} failed: ${msg(err)}`);
    }
  }
  timings.forceStop = deps.now() - tForceStop;

  // Step 3 — legacy agent-device daemon (gated by RN_DEVICE_KILL_LEGACY; may
  // belong to another project, so kill by SPECIFIC pid, never pkill, guarded
  // against our own process tree).
  const tLegacy = deps.now();
  if (opts.includeLegacy !== false && deps.killLegacy()) {
    try {
      const pid = deps.readDaemonPid();
      let keepFiles = false;
      if (pid !== null && deps.isAlive(pid)) {
        const { selfPid, parentPid } = deps.protectedPids();
        if (isProtectedPid(pid, selfPid, parentPid)) {
          warnings.push(
            `Refusing to kill agent-device daemon PID ${pid} — it is our own process/parent.`,
          );
          keepFiles = true;
        } else {
          try {
            deps.kill(pid, 'SIGTERM');
            await deps.delay(SIGKILL_GRACE_MS);
            if (deps.isAlive(pid)) deps.kill(pid, 'SIGKILL');
            killedDaemonPids.push(pid);
          } catch (err) {
            warnings.push(`kill daemon ${pid} failed: ${msg(err)}`);
            keepFiles = true;
          }
        }
      }
      if (!keepFiles) {
        for (const f of DAEMON_FILES) {
          if (!deps.fileExists(f)) continue;
          try {
            deps.removeFile(f);
            removedFiles.push(f);
          } catch (err) {
            warnings.push(`rm ${f} failed: ${msg(err)}`);
          }
        }
      }
    } catch (err) {
      warnings.push(`legacy daemon cleanup failed: ${msg(err)}`);
    }
  }
  timings.legacyDaemon = deps.now() - tLegacy;

  return {
    deviceId,
    stoppedOwnRunner,
    forceStoppedPackages,
    killedDaemonPids,
    removedFiles,
    warnings,
    meta: { timings_ms: timings },
  };
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
