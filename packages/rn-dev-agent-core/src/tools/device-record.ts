import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { ToolResult } from '../utils.js';
import { okResult, failResult, warnResult } from '../utils.js';
import { pathHasTraversal } from '../domain/path-safety.js';
import { probeProcessBirth } from '../session/process-birth.js';
import { getWorkerAuthorityRuntime, type WorkerAuthorityRuntime } from '../session/runtime.js';
import { stopBoundRecorder } from '../session/process-cleanup.js';

// Safe by construction: only execFile (argv-based, no shell), never exec.
// Mirrors the pattern in device-permission.ts and other shell-wrapping tools.
const execFileAsync = promisify(execFile);

const START_TIMEOUT_MS = 10_000;
const STATUS_TIMEOUT_MS = 5_000;
const GIF_TIMEOUT_MS = 60_000;

export interface DeviceRecordArgs {
  action: 'start' | 'stop' | 'status';
  platform?: 'ios' | 'android';
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
  sessionId?: string;
  claimEpoch?: number;
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
  if (!runtimes || typeof runtimes !== 'object') return [];
  const out: SimctlDevice[] = [];
  for (const list of Object.values(runtimes)) {
    if (!Array.isArray(list)) continue;
    for (const device of list) {
      if (
        device &&
        device.state === 'Booted' &&
        typeof device.udid === 'string' &&
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
  state: 'device' | 'offline' | 'unauthorized';
}

export function parseAllAdbDevices(stdout: string): AdbDevice[] {
  const out: AdbDevice[] = [];
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('List of devices')) continue;
    // Match any serial — not just `emulator-NNNN` — so physical devices count
    // toward multi-device ambiguity detection.
    const m = line.match(/^(\S+)\s+(device|offline|unauthorized)\b/);
    if (!m) continue;
    out.push({ serial: m[1], state: m[2] as 'device' | 'offline' | 'unauthorized' });
  }
  return out;
}

async function listBootedIosUdids(): Promise<SimctlDevice[]> {
  try {
    const { stdout } = await execFileAsync('xcrun', ['simctl', 'list', '-j', 'devices', 'booted'], {
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
    const { stdout } = await execFileAsync('adb', ['devices'], {
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
    return parseAllAdbDevices(stdout).filter((d) => d.state === 'device');
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
  reason: 'AMBIGUOUS';
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
    return { ok: false, reason: 'AMBIGUOUS', candidates };
  }
  if (candidates.length === 1) {
    return { ok: true, deviceId: candidates[0].id, autoSelected: true, totalAvailable: 1 };
  }
  return { ok: false, reason: 'AMBIGUOUS', candidates };
}

function compactUnique(paths: Array<string | undefined>): string[] {
  const out: string[] = [];
  for (const path of paths) {
    if (!path || out.includes(path)) continue;
    out.push(path);
  }
  return out;
}

export function candidateRecordScripts(
  baseDir = dirname(fileURLToPath(import.meta.url)),
): string[] {
  const codexPluginRoot = process.env.RN_DEV_AGENT_CODEX_PLUGIN_ROOT;
  const claudePluginRoot = process.env.CLAUDE_PLUGIN_ROOT;

  return compactUnique([
    process.env.RN_DEV_AGENT_RECORD_PROOF_SCRIPT,
    codexPluginRoot ? join(codexPluginRoot, 'scripts', 'record_proof.sh') : undefined,
    claudePluginRoot ? join(claudePluginRoot, 'scripts', 'record_proof.sh') : undefined,
    claudePluginRoot ? join(claudePluginRoot, '..', '..', 'scripts', 'record_proof.sh') : undefined,
    // Bundled Codex runtime: <plugin>/rn-dev-agent-core/dist.
    join(baseDir, '..', '..', 'scripts', 'record_proof.sh'),
    // Source core bundle: packages/rn-dev-agent-core/dist/supervisor.js.
    join(baseDir, '..', '..', '..', 'scripts', 'record_proof.sh'),
    // Source module build: packages/rn-dev-agent-core/dist/tools/device-record.js.
    join(baseDir, '..', '..', '..', '..', 'scripts', 'record_proof.sh'),
  ]);
}

export function resolveRecordScript(baseDir = dirname(fileURLToPath(import.meta.url))): string {
  if (process.env.RN_DEV_AGENT_RECORD_PROOF_SCRIPT) {
    return process.env.RN_DEV_AGENT_RECORD_PROOF_SCRIPT;
  }
  const candidates = candidateRecordScripts(baseDir);
  return candidates.find((path) => existsSync(path)) ?? candidates[0];
}

function getRecordScript(): string {
  return resolveRecordScript();
}

function defaultOutputPath(platform: 'ios' | 'android'): string {
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
  processBirth: string;
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
  const re = /^(ios|android): pid=(\d+) birth=(\S+) status=(\w+) output=(.*?)\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stdout)) !== null) {
    active.push({
      platform: m[1],
      pid: Number(m[2]),
      processBirth: m[3],
      status: m[4],
      output: m[5].trim(),
    });
  }
  return active;
}

function recordingScope(args: Required<Pick<DeviceRecordArgs, 'sessionId' | 'claimEpoch' | 'platform' | 'deviceId'>>): string {
  return createHash('sha256')
    .update(`${args.sessionId}\0${args.claimEpoch}\0${args.platform}\0${args.deviceId}`)
    .digest('hex');
}

export function bindRecorderSession(
  runtime: WorkerAuthorityRuntime,
  args: DeviceRecordArgs,
): {
  registry: ReturnType<WorkerAuthorityRuntime['requireAvailable']>['registry'];
  session: ReturnType<WorkerAuthorityRuntime['requireAvailable']>['session'];
  status: Exclude<ReturnType<WorkerAuthorityRuntime['status']>, { available: false }>;
  platform: 'ios' | 'android';
  deviceId: string;
} {
  const available = runtime.requireAvailable();
  const status = runtime.status();
  if (!status.available) throw new Error(`${status.code}: ${status.reason}`);
  const device = status.bindings.device as Record<string, unknown> | undefined;
  const platform = device?.platform;
  const deviceId = device?.deviceId;
  if (
    (platform !== 'ios' && platform !== 'android') ||
    typeof deviceId !== 'string' ||
    !deviceId
  ) {
    throw new Error('DEVICE_AUTHORITY_MISMATCH: recorder requires an exact claimed device');
  }
  if (args.platform !== undefined && args.platform !== platform) {
    throw new Error('DEVICE_AUTHORITY_MISMATCH: recorder platform contradicts the session');
  }
  if (args.deviceId !== undefined && args.deviceId !== deviceId) {
    throw new Error('DEVICE_AUTHORITY_MISMATCH: recorder device contradicts the session');
  }
  args.platform = platform;
  args.deviceId = deviceId;
  args.sessionId = status.sessionId;
  args.claimEpoch = status.claimEpoch;
  return { ...available, status, platform, deviceId };
}

async function runStart(
  args: DeviceRecordArgs,
  runtime: WorkerAuthorityRuntime,
): Promise<ToolResult> {
  let authority;
  try {
    authority = bindRecorderSession(runtime, args);
  } catch (error) {
    return failResult(error instanceof Error ? error.message : String(error), {
      code: 'SESSION_STALE',
    });
  }
  const platform = authority.platform;
  if (args.outputPath && pathHasTraversal(args.outputPath)) {
    return failResult(
      `device_record: outputPath "${args.outputPath}" contains '..' traversal segments — refuse to write to a path that escapes its parent directory`,
      { code: 'INVALID_PATH' },
    );
  }
  const outputPath = args.outputPath ?? defaultOutputPath(platform);

  // GH #173 sub-issue 1: pre-flight multi-device disambiguation. The shell
  // script's `simctl io booted` / `adb devices` resolution picks
  // non-deterministically when more than one device is booted/connected,
  // and silently captures the wrong one. Refuse to start until the
  // caller pins a target with `deviceId`.
  const candidates =
    platform === 'ios'
      ? (await listBootedIosUdids()).map((d) => ({ id: d.udid, label: d.name }))
      : (await listConnectedAndroidDevices()).map((d) => ({ id: d.serial }));

  if (candidates.length === 0) {
    return failResult(
      platform === 'ios' ? 'No iOS simulator booted.' : 'No Android device connected.',
      { code: 'NO_DEVICE' },
    );
  }

  const resolution = resolveTargetDevice(candidates, args.deviceId);
  if (!resolution.ok) {
    const list = resolution.candidates
      .map((c) => `  - ${c.id}${c.label ? ` (${c.label})` : ''}`)
      .join('\n');
    const argName = platform === 'ios' ? 'UDID' : 'serial';
    return failResult(
      `device_record: ${resolution.candidates.length} ${platform} ${argName === 'UDID' ? 'simulators booted' : 'devices connected'} — refusing to auto-pick to avoid recording the wrong device. ` +
        `Pass deviceId=<${argName}> to disambiguate:\n${list}`,
      { code: 'DEVICE_AMBIGUOUS', platform, candidates: resolution.candidates },
    );
  }

  args.platform = platform;
  args.deviceId = resolution.deviceId;
  if (authority.status.bindings.recorder) {
    return failResult('Recording already in progress for this session and device.', {
      code: 'ALREADY_RECORDING',
    });
  }
  const scope = recordingScope({
    sessionId: authority.status.sessionId,
    claimEpoch: authority.status.claimEpoch,
    platform,
    deviceId: resolution.deviceId,
  });
  const script = getRecordScript();
  const claimKey = `${platform}:${resolution.deviceId}`;
  const scriptArgs = ['start', platform, outputPath, '--scope', scope];
  scriptArgs.push(platform === 'ios' ? '--udid' : '--serial', resolution.deviceId);

  try {
    authority.registry.updateBindings(authority.session, {
      bindings: {
        recorder: {
          phase: 'starting',
          platform,
          deviceId: resolution.deviceId,
          output: outputPath,
          scope,
          script,
          claimKey,
          sessionId: authority.status.sessionId,
          claimEpoch: authority.status.claimEpoch,
        },
      },
      claimResources: [{ type: 'recorder', key: claimKey }],
    });
    const { stdout } = await execFileAsync(script, scriptArgs, {
      timeout: START_TIMEOUT_MS,
    });
    const parsed = parseStartOutput(stdout);
    if (!parsed) {
      throw new Error(`Recording started but could not parse PID/output. Raw: ${stdout.trim()}`);
    }
    const processIdentity = probeProcessBirth(parsed.pid);
    if (processIdentity.status !== 'present') {
      throw new Error('Recording started but its process identity could not be proven');
    }
    await execFileAsync(
      script,
      ['bind-identity', scope, String(parsed.pid), processIdentity.birth.token],
      { timeout: STATUS_TIMEOUT_MS },
    );
    authority.registry.updateBindings(authority.session, {
      bindings: {
        recorder: {
          phase: 'recording',
          platform,
          deviceId: resolution.deviceId,
          output: parsed.output,
          scope,
          pid: parsed.pid,
          processBirth: processIdentity.birth.token,
          script,
          claimKey,
          sessionId: authority.status.sessionId,
          claimEpoch: authority.status.claimEpoch,
        },
      },
    });
    return okResult({
      action: 'start',
      platform,
      deviceId: resolution.deviceId,
      autoSelected: resolution.autoSelected,
      output: parsed.output,
      pid: parsed.pid,
      processBirth: processIdentity.birth.token,
      note: 'Call device_record action=stop to finalize. Android caps at 180s; iOS has no inherent cap but xcrun simctl io may stall on long captures.',
    });
  } catch (e: unknown) {
    const aborted = await stopBoundRecorder({
      phase: 'starting',
      platform,
      deviceId: resolution.deviceId,
      output: outputPath,
      scope,
      script,
      claimKey,
      sessionId: authority.status.sessionId,
      claimEpoch: authority.status.claimEpoch,
    })
      .then(() => true)
      .catch(() => false);
    if (aborted) {
      authority.registry.updateBindings(authority.session, {
        bindings: { recorder: null },
        releaseResources: [{ type: 'recorder', key: claimKey }],
      });
    }
    const err = e as { stderr?: string; message?: string };
    const detail = (err.stderr || '').trim() || (err.message || '').trim() || String(e);
    if (/No iOS simulator booted/.test(detail)) {
      return failResult('No iOS simulator booted.', { code: 'NO_DEVICE' });
    }
    if (/No Android device connected/.test(detail)) {
      return failResult('No Android device connected.', { code: 'NO_DEVICE' });
    }
    if (/Recording already in progress/.test(detail)) {
      return failResult(`Recording already in progress for ${platform}. Call action=stop first.`, {
        code: 'ALREADY_RECORDING',
      });
    }
    return failResult(`record_proof.sh start failed: ${detail}`);
  }
}

async function runStop(
  args: DeviceRecordArgs,
  runtime: WorkerAuthorityRuntime,
): Promise<ToolResult> {
  let authority;
  try {
    authority = bindRecorderSession(runtime, args);
  } catch (error) {
    return failResult(error instanceof Error ? error.message : String(error), {
      code: 'SESSION_STALE',
    });
  }
  const recording = authority.status.bindings.recorder as Record<string, unknown> | undefined;
  if (!recording) {
    return warnResult({ saved: [] }, 'No active recording for this session and device.', {
      code: 'NO_ACTIVE_RECORDING',
    });
  }
  let stopOutput = '';
  try {
    stopOutput = await stopBoundRecorder(recording);
    const claimKey = String(recording.claimKey ?? '');
    authority.registry.updateBindings(authority.session, {
      bindings: { recorder: null },
      releaseResources: claimKey ? [{ type: 'recorder', key: claimKey }] : [],
    });
  } catch (e: unknown) {
    const err = e as { stderr?: string; message?: string };
    const detail = (err.stderr || '').trim() || (err.message || '').trim() || String(e);
    return failResult(`record_proof.sh stop failed: ${detail}`);
  }

  const saved = parseStopOutput(stopOutput);
  if (saved.length === 0) {
    if (/No active recordings/i.test(stopOutput)) {
      return warnResult({ saved: [] }, 'No active recordings to stop.', {
        code: 'NO_ACTIVE_RECORDING',
      });
    }
    return warnResult(
      { saved: [] },
      `Stop ran but no saved file detected. Raw: ${stopOutput.trim().slice(0, 400)}`,
    );
  }

  if (!args.gif) {
    return okResult({ action: 'stop', saved });
  }

  // Guard against the multi-platform clobber: a single user-supplied gifPath
  // would be reused for every saved recording, so the second conversion
  // overwrites the first. Force the caller to omit gifPath when stopping
  // multiple recordings (the per-recording default already produces unique
  // paths derived from each saved file).
  if (args.gifPath && saved.length > 1) {
    return failResult(
      `gifPath cannot be combined with ${saved.length} active recordings — each recording would write to the same file. Omit gifPath to auto-derive per-recording GIF paths, or stop one platform at a time.`,
      { code: 'GIFPATH_AMBIGUOUS' },
    );
  }

  const gifs: Array<{ source: string; gifPath: string; sizeBytes: number }> = [];
  const gifWarnings: string[] = [];
  for (const rec of saved) {
    const gifPath = args.gifPath ?? rec.path.replace(/\.[^.]+$/, '.gif');
    try {
      const { stdout: gifStdout } = await execFileAsync(
        getRecordScript(),
        ['convert-gif', rec.path, gifPath],
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
      { action: 'stop', saved, gifs: [] },
      `Saved ${saved.length} recording(s) but all GIF conversions failed. ${gifWarnings.join(' ')}`,
    );
  }
  return okResult({
    action: 'stop',
    saved,
    gifs,
    ...(gifWarnings.length > 0 ? { gifWarnings } : {}),
  });
}

async function readScopedStatus(script: string, scope: string): Promise<ActiveRecording[]> {
  const { stdout } = await execFileAsync(script, ['status', scope], {
    timeout: STATUS_TIMEOUT_MS,
  });
  return parseStatusOutput(stdout);
}

async function runStatus(
  args: DeviceRecordArgs,
  runtime: WorkerAuthorityRuntime,
): Promise<ToolResult> {
  let authority;
  try {
    authority = bindRecorderSession(runtime, args);
  } catch (error) {
    return failResult(error instanceof Error ? error.message : String(error), {
      code: 'SESSION_STALE',
    });
  }
  const recording = authority.status.bindings.recorder as Record<string, unknown> | undefined;
  if (!recording) return okResult({ action: 'status', active: [] });
  try {
    const active = await readScopedStatus(
      String(recording.script ?? ''),
      String(recording.scope ?? ''),
    );
    return okResult({ action: 'status', active });
  } catch (e: unknown) {
    const err = e as { stderr?: string; message?: string };
    const detail = (err.stderr || '').trim() || (err.message || '').trim() || String(e);
    return failResult(`record_proof.sh status failed: ${detail}`);
  }
}

export function createDeviceRecordHandler(deps: {
  runtime?: WorkerAuthorityRuntime;
} = {}): (args: DeviceRecordArgs) => Promise<ToolResult> {
  const runtime = deps.runtime ?? getWorkerAuthorityRuntime();
  return async (args) => {
    if (args.action === 'start') return runStart(args, runtime);
    if (args.action === 'stop') return runStop(args, runtime);
    if (args.action === 'status') return runStatus(args, runtime);
    return failResult(
      `Unknown action: "${(args as { action: string }).action}". Expected start, stop, or status.`,
    );
  };
}
