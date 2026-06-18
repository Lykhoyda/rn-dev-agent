import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { ToolResult } from "../utils.js";
import { okResult, failResult, warnResult } from "../utils.js";
import { detectPlatform } from "./platform-utils.js";
import { pathHasTraversal } from "../domain/path-safety.js";

// Safe by construction: only execFile (argv-based, no shell), never exec.
// Mirrors the pattern in device-permission.ts and other shell-wrapping tools.
const execFileAsync = promisify(execFile);

const START_TIMEOUT_MS = 10_000;
const STOP_TIMEOUT_MS = 60_000;
const STATUS_TIMEOUT_MS = 5_000;
const GIF_TIMEOUT_MS = 60_000;

export interface DeviceRecordArgs {
  action: "start" | "stop" | "status";
  platform?: "ios" | "android";
  outputPath?: string;
  gif?: boolean;
  gifPath?: string;
  /**
   * GH #173 (sub-issue 1): explicit target identifier for multi-device
   * scenarios. iOS UDID for `simctl io <UDID> recordVideo`, Android
   * serial for `adb -s <SERIAL> shell screenrecord`. Required when more
   * than one device of the same platform is booted/connected — without
   * it, `simctl io booted` and `adb devices` pick non-deterministically
   * and silently capture the wrong device (the user's reported pain).
   */
  deviceId?: string;
}

interface SimctlDevice {
  udid: string;
  state: string;
  name?: string;
}
interface SimctlListPayload {
  devices?: Record<string, SimctlDevice[]>;
}

export function parseAllBootedIosDevices(jsonText: string): SimctlDevice[] {
  let data: SimctlListPayload;
  try {
    data = JSON.parse(jsonText) as SimctlListPayload;
  } catch {
    return [];
  }
  const runtimes = data?.devices;
  if (!runtimes || typeof runtimes !== "object") return [];
  const out: SimctlDevice[] = [];
  for (const list of Object.values(runtimes)) {
    if (!Array.isArray(list)) continue;
    for (const device of list) {
      if (
        device &&
        device.state === "Booted" &&
        typeof device.udid === "string" &&
        device.udid.length > 0
      ) {
        out.push({ udid: device.udid, state: device.state, name: device.name });
      }
    }
  }
  return out;
}

export interface AdbDevice {
  serial: string;
  state: "device" | "offline" | "unauthorized";
}

export function parseAllAdbDevices(stdout: string): AdbDevice[] {
  const out: AdbDevice[] = [];
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("List of devices")) continue;
    // Match any serial — not just `emulator-NNNN` — so physical devices count
    // toward multi-device ambiguity detection.
    const m = line.match(/^(\S+)\s+(device|offline|unauthorized)\b/);
    if (!m) continue;
    out.push({ serial: m[1], state: m[2] as "device" | "offline" | "unauthorized" });
  }
  return out;
}

async function listBootedIosUdids(): Promise<SimctlDevice[]> {
  try {
    const { stdout } = await execFileAsync("xcrun", ["simctl", "list", "-j", "devices", "booted"], {
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
    return parseAllBootedIosDevices(stdout);
  } catch {
    return [];
  }
}

async function listConnectedAndroidDevices(): Promise<AdbDevice[]> {
  try {
    const { stdout } = await execFileAsync("adb", ["devices"], {
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
    return parseAllAdbDevices(stdout).filter((d) => d.state === "device");
  } catch {
    return [];
  }
}

export interface DeviceResolution {
  ok: true;
  deviceId: string;
  autoSelected: boolean;
  totalAvailable: number;
}

export interface DeviceResolutionAmbiguous {
  ok: false;
  reason: "AMBIGUOUS";
  candidates: Array<{ id: string; label?: string }>;
}

/**
 * Pre-flight target resolution for `device_record start`. Returns the
 * device id to use, or a structured ambiguity error listing the
 * candidates the caller must pick from. Pure: takes the candidate list
 * as input so the unit tests don't need to spawn xcrun/adb.
 *
 * Rules:
 *   - 0 candidates → caller's NO_DEVICE path handles it (we don't fire here)
 *   - 1 candidate  → auto-select, mark autoSelected: true
 *   - >1 + explicit deviceId matches a candidate → use it
 *   - >1 + explicit deviceId does NOT match → AMBIGUOUS with the full list
 *     (so caller sees the exact valid ids — typos surface fast)
 *   - >1 + no deviceId → AMBIGUOUS (the GH #173 bug fix surface)
 */
export function resolveTargetDevice(
  candidates: Array<{ id: string; label?: string }>,
  deviceId: string | undefined,
): DeviceResolution | DeviceResolutionAmbiguous {
  // An explicit deviceId is authoritative regardless of candidate count.
  // If the user said "record on X", we must record on X or refuse — silently
  // picking a different device is the exact bug GH #173 reports.
  if (deviceId) {
    if (candidates.some((c) => c.id === deviceId)) {
      return { ok: true, deviceId, autoSelected: false, totalAvailable: candidates.length };
    }
    return { ok: false, reason: "AMBIGUOUS", candidates };
  }
  if (candidates.length === 1) {
    return { ok: true, deviceId: candidates[0].id, autoSelected: true, totalAvailable: 1 };
  }
  return { ok: false, reason: "AMBIGUOUS", candidates };
}

function getPluginRoot(): string {
  if (process.env.CLAUDE_PLUGIN_ROOT) return process.env.CLAUDE_PLUGIN_ROOT;
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
}

function getRecordScript(): string {
  return join(getPluginRoot(), "scripts", "record_proof.sh");
}

function defaultOutputPath(platform: "ios" | "android"): string {
  return `/tmp/rn-dev-agent-proof-${platform}-${Date.now()}.mp4`;
}

export function parseStartOutput(stdout: string): { pid: number; output: string } | null {
  const match = stdout.match(
    /Recording started: platform=(?:ios|android) pid=(\d+) output=(.+?)\s*$/m,
  );
  if (!match) return null;
  return { pid: Number(match[1]), output: match[2].trim() };
}

export interface SavedRecording {
  path: string;
  sizeBytes: number;
}

export function parseStopOutput(stdout: string): SavedRecording[] {
  const saved: SavedRecording[] = [];
  const re = /^Saved: (.+?) \((\d+) bytes\)\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stdout)) !== null) {
    saved.push({ path: m[1].trim(), sizeBytes: Number(m[2]) });
  }
  return saved;
}

export interface ActiveRecording {
  platform: string;
  pid: number;
  status: string;
  output: string;
}

export function parseStatusOutput(stdout: string): ActiveRecording[] {
  if (/^No active recordings/m.test(stdout)) return [];
  const active: ActiveRecording[] = [];
  // `(.*?)` allows the output field to be empty — record_proof.sh emits
  // `output=` with no value when the .path sidecar is missing (orphaned
  // .pid file from a crashed prior session). We still want operators to see
  // the dangling pid row instead of silently dropping it.
  const re = /^(ios|android): pid=(\d+) status=(\w+) output=(.*?)\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stdout)) !== null) {
    active.push({
      platform: m[1],
      pid: Number(m[2]),
      status: m[3],
      output: m[4].trim(),
    });
  }
  return active;
}

async function runStart(args: DeviceRecordArgs): Promise<ToolResult> {
  const platform = args.platform ?? (await detectPlatform());
  if (!platform) {
    return failResult(
      "No iOS simulator or Android device detected. Boot a device or pass platform explicitly.",
      { code: "NO_DEVICE" },
    );
  }
  if (platform !== "ios" && platform !== "android") {
    return failResult(`Unknown platform: "${platform}". Expected ios or android.`);
  }
  if (args.outputPath && pathHasTraversal(args.outputPath)) {
    return failResult(
      `device_record: outputPath "${args.outputPath}" contains '..' traversal segments — refuse to write to a path that escapes its parent directory`,
      { code: "INVALID_PATH" },
    );
  }
  const outputPath = args.outputPath ?? defaultOutputPath(platform);

  // GH #173 sub-issue 1: pre-flight multi-device disambiguation. The shell
  // script's `simctl io booted` / `adb devices` resolution picks
  // non-deterministically when more than one device is booted/connected,
  // and silently captures the wrong one. Refuse to start until the
  // caller pins a target with `deviceId`.
  const candidates =
    platform === "ios"
      ? (await listBootedIosUdids()).map((d) => ({ id: d.udid, label: d.name }))
      : (await listConnectedAndroidDevices()).map((d) => ({ id: d.serial }));

  if (candidates.length === 0) {
    return failResult(
      platform === "ios" ? "No iOS simulator booted." : "No Android device connected.",
      { code: "NO_DEVICE" },
    );
  }

  const resolution = resolveTargetDevice(candidates, args.deviceId);
  if (!resolution.ok) {
    const list = resolution.candidates
      .map((c) => `  - ${c.id}${c.label ? ` (${c.label})` : ""}`)
      .join("\n");
    const argName = platform === "ios" ? "UDID" : "serial";
    return failResult(
      `device_record: ${resolution.candidates.length} ${platform} ${argName === "UDID" ? "simulators booted" : "devices connected"} — refusing to auto-pick to avoid recording the wrong device. ` +
        `Pass deviceId=<${argName}> to disambiguate:\n${list}`,
      { code: "DEVICE_AMBIGUOUS", platform, candidates: resolution.candidates },
    );
  }

  const scriptArgs = ["start", platform, outputPath];
  // Only forward an explicit id when we're picking from >1 candidate; the
  // single-device case keeps the script's existing `booted`/auto path so
  // we don't regress any environment where simctl's `booted` shorthand
  // works differently than passing the literal UDID (defensive — both
  // should be equivalent on Apple's side).
  if (!resolution.autoSelected) {
    scriptArgs.push(platform === "ios" ? "--udid" : "--serial", resolution.deviceId);
  }

  try {
    const { stdout } = await execFileAsync(getRecordScript(), scriptArgs, {
      timeout: START_TIMEOUT_MS,
    });
    const parsed = parseStartOutput(stdout);
    if (!parsed) {
      return failResult(`Recording started but could not parse PID/output. Raw: ${stdout.trim()}`);
    }
    return okResult({
      action: "start",
      platform,
      deviceId: resolution.deviceId,
      autoSelected: resolution.autoSelected,
      output: parsed.output,
      pid: parsed.pid,
      note: "Call device_record action=stop to finalize. Android caps at 180s; iOS has no inherent cap but xcrun simctl io may stall on long captures.",
    });
  } catch (e: unknown) {
    const err = e as { stderr?: string; message?: string };
    const detail = (err.stderr || "").trim() || (err.message || "").trim() || String(e);
    if (/No iOS simulator booted/.test(detail)) {
      return failResult("No iOS simulator booted.", { code: "NO_DEVICE" });
    }
    if (/No Android device connected/.test(detail)) {
      return failResult("No Android device connected.", { code: "NO_DEVICE" });
    }
    if (/Recording already in progress/.test(detail)) {
      return failResult(`Recording already in progress for ${platform}. Call action=stop first.`, {
        code: "ALREADY_RECORDING",
      });
    }
    return failResult(`record_proof.sh start failed: ${detail}`);
  }
}

async function runStop(args: DeviceRecordArgs): Promise<ToolResult> {
  let stopOutput = "";
  try {
    const { stdout } = await execFileAsync(getRecordScript(), ["stop"], {
      timeout: STOP_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    });
    stopOutput = stdout;
  } catch (e: unknown) {
    const err = e as { stderr?: string; message?: string };
    const detail = (err.stderr || "").trim() || (err.message || "").trim() || String(e);
    return failResult(`record_proof.sh stop failed: ${detail}`);
  }

  const saved = parseStopOutput(stopOutput);
  if (saved.length === 0) {
    if (/No active recordings/i.test(stopOutput)) {
      return warnResult({ saved: [] }, "No active recordings to stop.", {
        code: "NO_ACTIVE_RECORDING",
      });
    }
    return warnResult(
      { saved: [] },
      `Stop ran but no saved file detected. Raw: ${stopOutput.trim().slice(0, 400)}`,
    );
  }

  if (!args.gif) {
    return okResult({ action: "stop", saved });
  }

  // Guard against the multi-platform clobber: a single user-supplied gifPath
  // would be reused for every saved recording, so the second conversion
  // overwrites the first. Force the caller to omit gifPath when stopping
  // multiple recordings (the per-recording default already produces unique
  // paths derived from each saved file).
  if (args.gifPath && saved.length > 1) {
    return failResult(
      `gifPath cannot be combined with ${saved.length} active recordings — each recording would write to the same file. Omit gifPath to auto-derive per-recording GIF paths, or stop one platform at a time.`,
      { code: "GIFPATH_AMBIGUOUS" },
    );
  }

  const gifs: Array<{ source: string; gifPath: string; sizeBytes: number }> = [];
  const gifWarnings: string[] = [];
  for (const rec of saved) {
    const gifPath = args.gifPath ?? rec.path.replace(/\.[^.]+$/, ".gif");
    try {
      const { stdout: gifStdout } = await execFileAsync(
        getRecordScript(),
        ["convert-gif", rec.path, gifPath],
        { timeout: GIF_TIMEOUT_MS },
      );
      const sizeMatch = gifStdout.match(/GIF created: .+? \((\d+) bytes\)/);
      if (!sizeMatch) {
        gifWarnings.push(`GIF conversion for ${rec.path} produced no parsable size.`);
        continue;
      }
      gifs.push({ source: rec.path, gifPath, sizeBytes: Number(sizeMatch[1]) });
    } catch (e: unknown) {
      const err = e as { stderr?: string; message?: string };
      gifWarnings.push(
        `GIF conversion failed for ${rec.path}: ${(err.stderr || err.message || String(e)).trim()}`,
      );
    }
  }

  if (gifs.length === 0 && gifWarnings.length > 0) {
    return warnResult(
      { action: "stop", saved, gifs: [] },
      `Saved ${saved.length} recording(s) but all GIF conversions failed. ${gifWarnings.join(" ")}`,
    );
  }
  return okResult({
    action: "stop",
    saved,
    gifs,
    ...(gifWarnings.length > 0 ? { gifWarnings } : {}),
  });
}

async function runStatus(): Promise<ToolResult> {
  try {
    const { stdout } = await execFileAsync(getRecordScript(), ["status"], {
      timeout: STATUS_TIMEOUT_MS,
    });
    const active = parseStatusOutput(stdout);
    return okResult({ action: "status", active });
  } catch (e: unknown) {
    const err = e as { stderr?: string; message?: string };
    const detail = (err.stderr || "").trim() || (err.message || "").trim() || String(e);
    return failResult(`record_proof.sh status failed: ${detail}`);
  }
}

export function createDeviceRecordHandler(): (args: DeviceRecordArgs) => Promise<ToolResult> {
  return async (args) => {
    if (args.action === "start") return runStart(args);
    if (args.action === "stop") return runStop(args);
    if (args.action === "status") return runStatus();
    return failResult(
      `Unknown action: "${(args as { action: string }).action}". Expected start, stop, or status.`,
    );
  };
}
