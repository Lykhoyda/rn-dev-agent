import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { ToolResult } from '../utils.js';
import { okResult, failResult, warnResult } from '../utils.js';
import { detectPlatform } from './platform-utils.js';

// Safe by construction: only execFile (argv-based, no shell), never exec.
// Mirrors the pattern in device-permission.ts and other shell-wrapping tools.
const execFileAsync = promisify(execFile);

const START_TIMEOUT_MS = 10_000;
const STOP_TIMEOUT_MS = 60_000;
const STATUS_TIMEOUT_MS = 5_000;
const GIF_TIMEOUT_MS = 60_000;

export interface DeviceRecordArgs {
  action: 'start' | 'stop' | 'status';
  platform?: 'ios' | 'android';
  outputPath?: string;
  gif?: boolean;
  gifPath?: string;
}

function getPluginRoot(): string {
  if (process.env.CLAUDE_PLUGIN_ROOT) return process.env.CLAUDE_PLUGIN_ROOT;
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
}

function getRecordScript(): string {
  return join(getPluginRoot(), 'scripts', 'record_proof.sh');
}

function defaultOutputPath(platform: 'ios' | 'android'): string {
  return `/tmp/rn-dev-agent-proof-${platform}-${Date.now()}.mp4`;
}

export function parseStartOutput(stdout: string): { pid: number; output: string } | null {
  const match = stdout.match(/Recording started: platform=(?:ios|android) pid=(\d+) output=(.+?)\s*$/m);
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
      'No iOS simulator or Android device detected. Boot a device or pass platform explicitly.',
      { code: 'NO_DEVICE' },
    );
  }
  if (platform !== 'ios' && platform !== 'android') {
    return failResult(`Unknown platform: "${platform}". Expected ios or android.`);
  }
  const outputPath = args.outputPath ?? defaultOutputPath(platform);

  try {
    const { stdout } = await execFileAsync(
      getRecordScript(),
      ['start', platform, outputPath],
      { timeout: START_TIMEOUT_MS },
    );
    const parsed = parseStartOutput(stdout);
    if (!parsed) {
      return failResult(`Recording started but could not parse PID/output. Raw: ${stdout.trim()}`);
    }
    return okResult({
      action: 'start',
      platform,
      output: parsed.output,
      pid: parsed.pid,
      note: 'Call device_record action=stop to finalize. Android caps at 180s; iOS has no inherent cap but xcrun simctl io may stall on long captures.',
    });
  } catch (e: unknown) {
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

async function runStop(args: DeviceRecordArgs): Promise<ToolResult> {
  let stopOutput = '';
  try {
    const { stdout } = await execFileAsync(getRecordScript(), ['stop'], {
      timeout: STOP_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    });
    stopOutput = stdout;
  } catch (e: unknown) {
    const err = e as { stderr?: string; message?: string };
    const detail = (err.stderr || '').trim() || (err.message || '').trim() || String(e);
    return failResult(`record_proof.sh stop failed: ${detail}`);
  }

  const saved = parseStopOutput(stopOutput);
  if (saved.length === 0) {
    if (/No active recordings/i.test(stopOutput)) {
      return warnResult({ saved: [] }, 'No active recordings to stop.', { code: 'NO_ACTIVE_RECORDING' });
    }
    return warnResult({ saved: [] }, `Stop ran but no saved file detected. Raw: ${stopOutput.trim().slice(0, 400)}`);
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

async function runStatus(): Promise<ToolResult> {
  try {
    const { stdout } = await execFileAsync(getRecordScript(), ['status'], { timeout: STATUS_TIMEOUT_MS });
    const active = parseStatusOutput(stdout);
    return okResult({ action: 'status', active });
  } catch (e: unknown) {
    const err = e as { stderr?: string; message?: string };
    const detail = (err.stderr || '').trim() || (err.message || '').trim() || String(e);
    return failResult(`record_proof.sh status failed: ${detail}`);
  }
}

export function createDeviceRecordHandler(): (args: DeviceRecordArgs) => Promise<ToolResult> {
  return async (args) => {
    if (args.action === 'start') return runStart(args);
    if (args.action === 'stop') return runStop(args);
    if (args.action === 'status') return runStatus();
    return failResult(`Unknown action: "${(args as { action: string }).action}". Expected start, stop, or status.`);
  };
}
