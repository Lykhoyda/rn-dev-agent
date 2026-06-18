import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { stopAndroidRunner } from "./rn-android-runner-client.js";
import { getAdbSerial } from "../agent-device-wrapper.js";

const execFile = promisify(execFileCb);

const DAEMON_JSON = join(homedir(), ".agent-device", "daemon.json");
const DAEMON_LOCK = join(homedir(), ".agent-device", "daemon.lock");
const DAEMON_FILES = [DAEMON_JSON, DAEMON_LOCK];
const SIGKILL_GRACE_MS = 500;
const ADB_TIMEOUT_MS = 5_000;

// The two packages our in-tree Android runner installs (see
// rn-android-runner-client.ts:18 — INSTRUMENTATION). Force-stopping these frees
// the device-side UiAutomation slot for maestro-runner's UIAutomator2 server.
// We force-stop ONLY these — never a foreign UIAutomator2 package (that overreach
// is what killed the MCP server in the #237 repro's `pkill -f agent-device`).
export const OWNED_PACKAGES = [
  "dev.lykhoyda.rndevagent.androidrunner.test",
  "dev.lykhoyda.rndevagent.androidrunner",
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
  stoppedOwnRunner: boolean;
  forceStoppedPackages: string[];
  killedDaemonPids: number[];
  removedFiles: string[];
  warnings: string[];
  meta: { timings_ms: Record<string, number> };
}

export interface ReleaseAndroidSlotDeps {
  stopOwnRunner: (deviceId?: string) => Promise<void>;
  adbForceStop: (pkg: string, serial: string[]) => Promise<void>;
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
    stopOwnRunner: (deviceId) => stopAndroidRunner(deviceId),
    adbForceStop: async (pkg, serial) => {
      await execFile("adb", [...serial, "shell", "am", "force-stop", pkg], {
        timeout: ADB_TIMEOUT_MS,
        encoding: "utf8",
      });
    },
    resolveSerial: (deviceId) => (deviceId ? ["-s", deviceId] : getAdbSerial()),
    readDaemonPid: () => {
      try {
        const parsed = JSON.parse(readFileSync(DAEMON_JSON, "utf8")) as { pid?: unknown };
        return typeof parsed.pid === "number" ? parsed.pid : null;
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
    killLegacy: () => process.env.RN_DEVICE_KILL_LEGACY !== "0",
    now: () => Date.now(),
  };
}

/**
 * GH#237: release the single Android UiAutomation slot before an L3 Maestro flow.
 * Best-effort and idempotent — every step records a warning on failure and never
 * throws, so a flow is never blocked by a cleanup hiccup (and the auto-repair
 * re-entrancy path can call it again safely). MUST run inside the held arbiter
 * `flow` lease (no concurrent device_* can re-grab the slot between release and bind).
 */
export async function releaseAndroidInteractionSlot(
  opts: { deviceId?: string } = {},
  deps: ReleaseAndroidSlotDeps = defaultDeps(),
): Promise<ReleaseAndroidSlotResult> {
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
    await deps.stopOwnRunner(opts.deviceId);
    stoppedOwnRunner = true;
  } catch (err) {
    warnings.push(`stopping the Android runner failed: ${msg(err)}`);
  }
  timings.stopOwnRunner = deps.now() - tStop;

  // Step 2 — force-stop OUR instrumentation packages. THE decisive slot-release:
  // tears down the device-side instrumentation the SIGTERM left alive.
  const tForceStop = deps.now();
  try {
    const serial = deps.resolveSerial(opts.deviceId);
    for (const pkg of OWNED_PACKAGES) {
      try {
        await deps.adbForceStop(pkg, serial);
        forceStoppedPackages.push(pkg);
      } catch (err) {
        warnings.push(`am force-stop ${pkg} failed: ${msg(err)}`);
      }
    }
  } catch (err) {
    warnings.push(`resolveSerial failed: ${msg(err)}`);
  }
  timings.forceStop = deps.now() - tForceStop;

  // Step 3 — legacy agent-device daemon (gated by RN_DEVICE_KILL_LEGACY; may
  // belong to another project, so kill by SPECIFIC pid, never pkill, guarded
  // against our own process tree).
  const tLegacy = deps.now();
  if (deps.killLegacy()) {
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
            deps.kill(pid, "SIGTERM");
            await deps.delay(SIGKILL_GRACE_MS);
            if (deps.isAlive(pid)) deps.kill(pid, "SIGKILL");
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
