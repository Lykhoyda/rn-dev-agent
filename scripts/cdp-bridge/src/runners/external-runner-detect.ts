import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

interface LegacyDaemonInfo { pid: number; port: number; token?: string }

export interface LegacyWarning {
  message: string;
  pid: number;
  port: number;
}

const DEFAULT_DAEMON_PATH = join(homedir(), '.agent-device', 'daemon.json');

export interface DetectDeps {
  readDaemonFile?: () => Promise<LegacyDaemonInfo | null>;
}

async function defaultRead(): Promise<LegacyDaemonInfo | null> {
  try {
    const raw = await readFile(DEFAULT_DAEMON_PATH, 'utf8');
    const parsed = JSON.parse(raw) as LegacyDaemonInfo;
    if (typeof parsed.pid === 'number' && typeof parsed.port === 'number') {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * GH #105 / rn-device iOS-MVP §3.7: detect a globally-installed external
 * XCTest-based runner daemon. Both could compete for the iOS Simulator's
 * automation channel. Returns a warning the caller surfaces at session-open.
 *
 * Returns null when no daemon is detected (common case).
 */
export async function detectLegacyAgentDevice(
  deps: DetectDeps = {},
): Promise<LegacyWarning | null> {
  const read = deps.readDaemonFile ?? defaultRead;
  try {
    const info = await read();
    if (!info) return null;
    return {
      message: `rn-device detected a globally-installed external runner daemon ` +
               `(PID ${info.pid}, port ${info.port}). ` +
               `If iOS interactions appear flaky, set RN_DEVICE_KILL_LEGACY=1 ` +
               `to terminate it at session open.`,
      pid: info.pid,
      port: info.port,
    };
  } catch {
    return null;
  }
}

export interface AndroidExternalRunnerWarning {
  platform: 'android';
  code: 'ANDROID_UIAUTOMATOR_COMPETITOR';
  message: string;
  processLines: string[];
}

export async function detectAndroidExternalRunner(
  execFileImpl: typeof execFile = execFile,
  serialArgs: string[] = [],
): Promise<AndroidExternalRunnerWarning | null> {
  try {
    // Accept either a callback-style execFile (production default) or an
    // async shim (unit tests). promisify on an async function returns a
    // never-resolving Promise (Node DEP0174), so when the caller passes a
    // function that already returns a Promise, use it directly.
    const bin = 'adb';
    const argv = [...serialArgs, 'shell', 'ps', '-A'];
    const opts = { timeout: 2_000, encoding: 'utf8' as const };
    const run = execFileImpl === execFile
      ? promisify(execFileImpl)
      : (execFileImpl as unknown as (
          b: string,
          a: string[],
          o: typeof opts,
        ) => Promise<{ stdout: string }>);
    const { stdout } = await run(bin, argv, opts);
    const lines = stdout
      .split('\n')
      .filter((line) => /uiautomator|agent-device|AgentDevice/i.test(line))
      .filter((line) => !/dev\.lykhoyda\.rndevagent\.androidrunner/.test(line));

    if (lines.length === 0) return null;

    return {
      platform: 'android',
      code: 'ANDROID_UIAUTOMATOR_COMPETITOR',
      message: 'A competing Android UIAutomator or agent-device process is running. Stop it before enabling RN_ANDROID_RUNNER=1 to avoid focus and input contention.',
      processLines: lines,
    };
  } catch {
    return null;
  }
}
