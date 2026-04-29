import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import type { CDPClient } from '../cdp-client.js';
import type { ToolResult } from '../utils.js';
import { okResult, failResult } from '../utils.js';

const execFile = promisify(execFileCb);

export interface NativeError {
  timestamp: string;
  source: 'ios-simctl-log' | 'android-logcat';
  level: 'error' | 'warn' | 'fatal';
  message: string;
}

/**
 * B114 (D642): patterns that indicate the kind of native-module or JS-runtime
 * failure that fires BEFORE __RN_AGENT injects — so CDP's error tools stay
 * empty while the app is actually broken. Case-insensitive match; dedupe by
 * substring on the message text.
 */
const IOS_NOISE_PATTERNS = [
  /Cannot find native module/i,
  /Module \w+ is not a registered callable module/i,
  /Attempting to invoke/i,
  /RedBox/i,
  /RCTFatal/i,
  /JavaScriptRequired/i,
  /Unhandled JS Exception/i,
  /Bundle URL|Bundle download/i,
  /"App entry not found"/i,
];

const ANDROID_NOISE_PATTERNS = [
  /Cannot find native module/i,
  /Module \w+ is not a registered callable module/i,
  /FATAL EXCEPTION/i,
  /ReactNative.*ERROR/i,
  /AndroidRuntime.*Error/i,
  /Could not connect to development server/i,
];

/**
 * Parse simctl log compact output. Format per line:
 *   "2026-04-16 22:15:00.000 Df  [123:456] com.foo: message text"
 * We match error/warn lines and extract timestamp + message. Exported for tests.
 */
export function parseIOSLog(stdout: string): NativeError[] {
  const entries: NativeError[] = [];
  for (const line of stdout.split('\n')) {
    if (!IOS_NOISE_PATTERNS.some(p => p.test(line))) continue;
    const tsMatch = line.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+)/);
    const timestamp = tsMatch ? tsMatch[1] : new Date().toISOString();
    entries.push({
      timestamp,
      source: 'ios-simctl-log',
      level: /fatal|redbox|rctfatal/i.test(line) ? 'fatal' : 'error',
      message: line.trim(),
    });
  }
  return dedupeByMessage(entries);
}

/**
 * Parse adb logcat -v time output. Format per line:
 *   "04-16 22:15:00.000 E/Tag  (123): message"
 */
export function parseAndroidLog(stdout: string): NativeError[] {
  const entries: NativeError[] = [];
  for (const line of stdout.split('\n')) {
    if (!ANDROID_NOISE_PATTERNS.some(p => p.test(line))) continue;
    const tsMatch = line.match(/^(\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+)/);
    const timestamp = tsMatch ? tsMatch[1] : new Date().toISOString();
    const level: 'error' | 'fatal' = /FATAL|F\//.test(line) ? 'fatal' : 'error';
    entries.push({
      timestamp,
      source: 'android-logcat',
      level,
      message: line.trim(),
    });
  }
  return dedupeByMessage(entries);
}

function dedupeByMessage(entries: NativeError[]): NativeError[] {
  const seen = new Set<string>();
  const out: NativeError[] = [];
  // Drop the leading timestamp so "same error at different times" collapses.
  const TS_PREFIX = /^(?:\d{4}-)?\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}\.\d+\s*/;
  for (const e of entries) {
    const key = e.message.replace(TS_PREFIX, '').replace(/\s+/g, ' ').slice(0, 200);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

export interface ReadNativeErrorsOptions {
  platform?: string;
  sinceSeconds?: number;
  limit?: number;
  runIOS?: () => Promise<string>;
  runAndroid?: () => Promise<string>;
}

async function defaultRunIOS(sinceSeconds: number): Promise<string> {
  const { stdout } = await execFile(
    'xcrun',
    [
      'simctl',
      'spawn',
      'booted',
      'log',
      'show',
      '--style',
      'compact',
      '--last',
      `${sinceSeconds}s`,
    ],
    { timeout: 10_000, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
  );
  return stdout;
}

async function defaultRunAndroid(sinceSeconds: number): Promise<string> {
  // adb logcat -d dumps recent buffer; -v time for parseable timestamps;
  // filter by severity (E/F) and cap via -t lines proxy for "last N seconds"
  // (logcat doesn't have an explicit "last Ns" flag; ~100 lines/s is a safe upper bound).
  const { stdout } = await execFile(
    'adb',
    ['logcat', '-d', '-v', 'time', '-t', `${sinceSeconds * 100}`, '*:E'],
    { timeout: 10_000, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
  );
  return stdout;
}

export interface NativeErrorsResult {
  ok: boolean;
  entries: NativeError[];
  /** True when the underlying log command failed (xcrun/adb missing, timeout, permission). */
  unavailable: boolean;
  /** Failure detail when `unavailable` is true; empty otherwise. */
  error: string;
  /** Which command was attempted (for diagnostics). */
  command: string;
}

export async function readNativeErrors(opts: ReadNativeErrorsOptions = {}): Promise<NativeErrorsResult> {
  const platform = (opts.platform ?? 'ios').toLowerCase();
  const sinceSeconds = opts.sinceSeconds ?? 60;
  const limit = opts.limit ?? 10;
  const command = platform === 'android' ? 'adb logcat' : 'xcrun simctl spawn ... log show';

  try {
    if (platform === 'android') {
      const out = await (opts.runAndroid ?? (() => defaultRunAndroid(sinceSeconds)))();
      return { ok: true, entries: parseAndroidLog(out).slice(-limit), unavailable: false, error: '', command };
    }
    const out = await (opts.runIOS ?? (() => defaultRunIOS(sinceSeconds)))();
    return { ok: true, entries: parseIOSLog(out).slice(-limit), unavailable: false, error: '', command };
  } catch (err) {
    // CDP-016: surface tool-unavailability as a structured failure. Returning
    // [] previously made "no native errors" indistinguishable from "the log
    // tool itself failed", which let agents conclude the app was clean while
    // the diagnostic surface was actually offline.
    return {
      ok: false,
      entries: [],
      unavailable: true,
      error: err instanceof Error ? err.message : String(err),
      command,
    };
  }
}

export function createNativeErrorsHandler(getClient: () => CDPClient) {
  return async (args: { platform?: string; sinceSeconds?: number; limit?: number }): Promise<ToolResult> => {
    const client = getClient();
    const platform =
      args.platform
      ?? (client.connectedTarget?.platform as string | undefined)
      ?? 'ios';

    try {
      const result = await readNativeErrors({
        platform,
        sinceSeconds: args.sinceSeconds,
        limit: args.limit,
      });

      // CDP-016: when the log tool itself is unavailable, fail loudly so
      // callers cannot mistake "diagnostic offline" for "no native errors".
      if (result.unavailable) {
        return failResult(
          `Native log tool unavailable (${result.command}): ${result.error}`,
          'NATIVE_LOG_UNAVAILABLE',
          {
            platform,
            command: result.command,
            hint: platform === 'ios'
              ? 'Verify Xcode command-line tools are installed (xcode-select --install) and a simulator is booted.'
              : 'Verify the Android SDK is installed and adb is on PATH (e.g. via $ANDROID_HOME/platform-tools).',
          },
        );
      }

      const entries = result.entries;
      return okResult({
        platform,
        count: entries.length,
        entries,
        hint:
          entries.length === 0
            ? 'No native errors found. If the app is broken but this returned empty, try increasing sinceSeconds (default 60).'
            : 'Native errors captured. If these happened before __RN_AGENT injected, they explain why cdp_error_log/cdp_console_log look empty.',
      });
    } catch (err) {
      return failResult(err instanceof Error ? err.message : String(err));
    }
  };
}
