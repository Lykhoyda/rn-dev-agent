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
 * Failure behavior (updated by GH #136 PR-B): callers on the explicit-platform
 * or raw-only routes HARD-FAIL with an actionable SCREENSHOT_FAILED — falling
 * through to another backend was the wrong-platform regression vector. Only
 * the Android runner-error path still falls back here (see device-list.ts).
 * Since GH #422 this raw path is also the primary iOS pixel backend.
 *
 * Test seams (`_setForTest`, `_resetForTest`) follow the GH #136 picker
 * precedent — allow unit tests to inject resolver/capturer fakes without
 * spawning real `xcrun`/`adb` subprocesses.
 */
import { execFile, spawn } from 'node:child_process';
import { createWriteStream, unlinkSync } from 'node:fs';
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

// GH #422: the single-pick parseSimctlBootedUDID was removed — first-booted
// selection was a silent wrong-device capture once raw became the primary iOS
// path. All resolution goes through parseSimctlBootedAll + exactly-one.
export function parseSimctlBootedAll(jsonText: string): string[] {
  let data: SimctlListPayload;
  try {
    data = JSON.parse(jsonText) as SimctlListPayload;
  } catch {
    return [];
  }
  const runtimes = data?.devices;
  if (!runtimes || typeof runtimes !== 'object') return [];
  const udids: string[] = [];
  for (const [runtime, list] of Object.entries(runtimes)) {
    // GH #422 hardening: a booted paired watchOS/tvOS sim must not make the
    // single iOS sim look ambiguous to resolveIosUdid, nor be counted as an
    // iOS device.
    if (!runtime.includes('SimRuntime.iOS')) continue;
    if (!Array.isArray(list)) continue;
    for (const device of list) {
      if (
        device &&
        device.state === 'Booted' &&
        typeof device.udid === 'string' &&
        device.udid.length > 0
      ) {
        udids.push(device.udid);
      }
    }
  }
  return udids;
}

async function defaultSimctlBootedJson(): Promise<string> {
  const { stdout } = await execFileAsync('xcrun', ['simctl', 'list', '-j', 'devices', 'booted'], {
    timeout: 5000,
    maxBuffer: 1024 * 1024,
  });
  return stdout;
}

export async function resolveIosUdid(
  explicit?: string,
  probe: () => Promise<string> = defaultSimctlBootedJson,
): Promise<string | undefined> {
  if (explicit) return explicit;
  try {
    const all = parseSimctlBootedAll(await probe());
    return all.length === 1 ? all[0] : undefined;
  } catch {
    return undefined;
  }
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
    // GH #422: raw is the primary iOS pixel path now, so a no-session resolve
    // must be unambiguous — with several booted iOS sims, first-pick was a
    // silent wrong-device capture. Callers with a session pass its UDID.
    const all = parseSimctlBootedAll(stdout);
    return all.length === 1 ? all[0] : null;
  } catch {
    return null;
  }
};

/** #210: resolve the booted iOS simulator UDID (reuses the simctl probe used for raw screenshots). null if none booted. */
export async function resolveBootedIosUdid(): Promise<string | null> {
  return defaultIosResolver();
}

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

// Honor the requested format via the path extension, matching how the
// agent-device path infers format. Writing JPEG bytes into a `.png` file
// (the prior hardcoded `--type=jpeg`) produced a mislabeled image because
// the downstream sips resize only re-encodes `.jpe?g` paths.
export function simctlScreenshotType(path: string): 'png' | 'jpeg' {
  return /\.png$/i.test(path) ? 'png' : 'jpeg';
}

const defaultIosCapturer: RawCapturer = async (udid, path) => {
  try {
    await execFileAsync(
      'xcrun',
      ['simctl', 'io', udid, 'screenshot', `--type=${simctlScreenshotType(path)}`, path],
      {
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
      },
    );
    return true;
  } catch {
    return false;
  }
};

/**
 * Pure decision helper exported for unit tests. Returns the success/failure
 * verdict only when BOTH the WriteStream finished AND adb's exit code is
 * known — Node doesn't order `out.on('finish')` and `proc.on('close')`, so
 * we wait for both before settling. Deepsec scan (2026-05-12) caught the
 * prior single-track version reporting success on stream-finish even when
 * adb exited non-zero afterwards.
 */
export type CaptureOutcome = 'success' | 'failure' | 'pending';
export function resolveCaptureOutcome(
  streamFinished: boolean,
  procCode: number | null,
): CaptureOutcome {
  if (!streamFinished) return 'pending';
  if (procCode === null) return 'pending';
  return procCode === 0 ? 'success' : 'failure';
}

// Android needs the binary screen bytes piped to a file. execFile can't redirect
// stdout, so spawn directly and pipe to a write stream — no shell, so the path
// is safely passed as a literal filename, not interpolated into a command string.
//
// Two-track settle: success requires BOTH the WriteStream 'finish' event (all
// bytes drained to disk) AND adb's 'close' event with exit code 0. Either
// alone is insufficient: 'finish' before non-zero close = truncated/partial
// file reported as success (deepsec 2026-05-12 finding); 'close' before
// 'finish' = success reported before bytes hit disk (earlier multi-LLM
// review finding). On any failure path, the partial file is unlinked so
// `resizeWithSips` never sees a corrupt artifact.
const defaultAndroidCapturer: RawCapturer = async (emuId, path) =>
  new Promise<boolean>((resolve) => {
    let settled = false;
    let streamFinished = false;
    let procCode: number | null = null;
    const proc = spawn('adb', ['-s', emuId, 'exec-out', 'screencap', '-p'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out = createWriteStream(path);
    const cleanupPartial = (): void => {
      try {
        unlinkSync(path);
      } catch {
        /* file may not exist yet — ignore */
      }
    };
    const timer = setTimeout(() => {
      if (settled) return;
      proc.kill();
      out.destroy();
      cleanupPartial();
      settle(false);
    }, 15_000);
    const settle = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const maybeSettle = (): void => {
      const outcome = resolveCaptureOutcome(streamFinished, procCode);
      if (outcome === 'pending') return;
      if (outcome === 'failure') {
        out.destroy();
        cleanupPartial();
      }
      settle(outcome === 'success');
    };
    proc.stdout.pipe(out);
    out.on('finish', () => {
      streamFinished = true;
      maybeSettle();
    });
    out.on('error', () => {
      cleanupPartial();
      settle(false);
    });
    proc.on('error', () => {
      out.destroy();
      cleanupPartial();
      settle(false);
    });
    proc.on('close', (code) => {
      procCode = code;
      maybeSettle();
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

export type RawScreenshotFailureReason = 'no-device' | 'capture-failed';

export type RawScreenshotResult =
  | { ok: true; path: string }
  | { ok: false; reason: RawScreenshotFailureReason };

export async function tryRawScreenshot(
  platform: 'ios' | 'android',
  path: string,
  preferredDeviceId?: string,
): Promise<RawScreenshotResult> {
  const resolver = platform === 'ios' ? iosResolver : androidResolver;
  const capturer = platform === 'ios' ? iosCapturer : androidCapturer;
  // GH #422: raw is now the PRIMARY iOS pixel path, so it must inherit the
  // session's device binding — with two booted sims, "first booted" could
  // capture the wrong one. No session → single-booted resolution as before.
  const id = preferredDeviceId ?? (await resolver());
  if (!id) return { ok: false, reason: 'no-device' };
  try {
    const ok = await capturer(id, path);
    return ok ? { ok: true, path } : { ok: false, reason: 'capture-failed' };
  } catch {
    // Raw is the primary iOS path since GH #422 — a thrown capturer error
    // (fs validation, spawn failure) must honor the result contract.
    return { ok: false, reason: 'capture-failed' };
  }
}
