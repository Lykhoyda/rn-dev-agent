/**
 * GH #136 PR-A: raw-command screenshot path for explicit-platform disambiguation.
 *
 * When `device_screenshot` is called with explicit `platform: 'ios' | 'android'`
 * (i.e., the caller actually passed the field, not inferred from CDP target),
 * we bypass agent-device entirely and shell out to `xcrun simctl io` or
 * `adb -s <emu> exec-out screencap -p`. This sidesteps the agent-device CLI's
 * `--platform` routing issue when both an iOS sim and an Android emu are
 * booted simultaneously (the field-reported bug from issue #136 #1).
 *
 * On any failure (resolution fails, command errors), the caller falls through
 * to the existing `runAgentDevice` path — no behavior change for users who
 * don't pass `platform` or who run a single device.
 *
 * Test seams (`_setForTest`, `_resetForTest`) follow the GH #136 picker
 * precedent — allow unit tests to inject resolver/capturer fakes without
 * spawning real `xcrun`/`adb` subprocesses.
 */
import { execFile, spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type RawResolver = () => Promise<string | null>;
export type RawCapturer = (idOrUdid: string, path: string) => Promise<boolean>;

interface SimctlDevice {
  udid: string;
  state: string;
}
interface SimctlListPayload {
  devices?: Record<string, SimctlDevice[]>;
}

export function parseSimctlBootedUDID(jsonText: string): string | null {
  let data: SimctlListPayload;
  try {
    data = JSON.parse(jsonText) as SimctlListPayload;
  } catch {
    return null;
  }
  const runtimes = data?.devices;
  if (!runtimes || typeof runtimes !== 'object') return null;
  for (const list of Object.values(runtimes)) {
    if (!Array.isArray(list)) continue;
    for (const device of list) {
      if (device && device.state === 'Booted' && typeof device.udid === 'string' && device.udid.length > 0) {
        return device.udid;
      }
    }
  }
  return null;
}

const EMU_LINE = /^(emulator-\d+)\s+device\b/;

export function parseAdbDevicesEmu(stdout: string): string | null {
  const lines = stdout.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('List of devices')) continue;
    const match = trimmed.match(EMU_LINE);
    if (match) return match[1];
  }
  return null;
}

const defaultIosResolver: RawResolver = async () => {
  try {
    const { stdout } = await execFileAsync('xcrun', ['simctl', 'list', '-j', 'devices', 'booted'], {
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
    return parseSimctlBootedUDID(stdout);
  } catch {
    return null;
  }
};

const defaultAndroidResolver: RawResolver = async () => {
  try {
    const { stdout } = await execFileAsync('adb', ['devices'], {
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
    return parseAdbDevicesEmu(stdout);
  } catch {
    return null;
  }
};

const defaultIosCapturer: RawCapturer = async (udid, path) => {
  try {
    await execFileAsync('xcrun', ['simctl', 'io', udid, 'screenshot', '--type=jpeg', path], {
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    });
    return true;
  } catch {
    return false;
  }
};

// Android needs the binary screen bytes piped to a file. execFile can't redirect
// stdout, so spawn directly and pipe to a write stream — no shell, so the path
// is safely passed as a literal filename, not interpolated into a command string.
//
// Settle ordering matters: `pipe()` auto-ends `out` when `proc.stdout` ends, but
// `out.end()` is async — bytes can remain buffered after the child exits. We
// resolve `true` only on the WriteStream's `'finish'` event (post-flush) so
// `resizeWithSips` never reads a truncated PNG. Multi-LLM review caught this.
const defaultAndroidCapturer: RawCapturer = async (emuId, path) =>
  new Promise<boolean>((resolve) => {
    let settled = false;
    const proc = spawn('adb', ['-s', emuId, 'exec-out', 'screencap', '-p'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = createWriteStream(path);
    const timer = setTimeout(() => {
      if (settled) return;
      proc.kill();
      out.destroy();
      settle(false);
    }, 15_000);
    const settle = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    proc.stdout.pipe(out);
    out.on('finish', () => settle(true));
    out.on('error', () => settle(false));
    proc.on('error', () => {
      out.destroy();
      settle(false);
    });
    proc.on('close', (code) => {
      if (code === 0) return; // success path settles via `out.on('finish')`
      out.destroy();
      settle(false);
    });
  });

let iosResolver: RawResolver = defaultIosResolver;
let androidResolver: RawResolver = defaultAndroidResolver;
let iosCapturer: RawCapturer = defaultIosCapturer;
let androidCapturer: RawCapturer = defaultAndroidCapturer;

export interface TestOverrides {
  iosResolver?: RawResolver;
  androidResolver?: RawResolver;
  iosCapturer?: RawCapturer;
  androidCapturer?: RawCapturer;
}

export function _setForTest(overrides: TestOverrides): void {
  if (overrides.iosResolver) iosResolver = overrides.iosResolver;
  if (overrides.androidResolver) androidResolver = overrides.androidResolver;
  if (overrides.iosCapturer) iosCapturer = overrides.iosCapturer;
  if (overrides.androidCapturer) androidCapturer = overrides.androidCapturer;
}

export function _resetForTest(): void {
  iosResolver = defaultIosResolver;
  androidResolver = defaultAndroidResolver;
  iosCapturer = defaultIosCapturer;
  androidCapturer = defaultAndroidCapturer;
}

export interface RawScreenshotResult {
  ok: true;
  path: string;
}

export async function tryRawScreenshot(
  platform: 'ios' | 'android',
  path: string,
): Promise<RawScreenshotResult | null> {
  const resolver = platform === 'ios' ? iosResolver : androidResolver;
  const capturer = platform === 'ios' ? iosCapturer : androidCapturer;
  const id = await resolver();
  if (!id) return null;
  const ok = await capturer(id, path);
  return ok ? { ok: true, path } : null;
}
