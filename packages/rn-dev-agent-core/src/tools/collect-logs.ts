import { execFile as execFileCb, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { getActiveSession } from '../agent-device-wrapper.js';
import type { CDPClient } from '../cdp-client.js';
import type { ToolResult } from '../utils.js';
import { okResult, failResult, warnResult } from '../utils.js';

const execFile = promisify(execFileCb);

type LogSource = 'js_console' | 'native_ios' | 'native_android';

function normalizeTimestamp(ts?: string): string {
  if (!ts) return new Date().toISOString();
  try {
    return new Date(ts.replace(' ', 'T').replace(/\+0000$/, 'Z')).toISOString();
  } catch {
    return new Date().toISOString();
  }
}

interface LogEntry {
  source: LogSource;
  level: string;
  text: string;
  timestamp: string;
  pid?: number;
  tag?: string;
}

interface CollectLogsArgs {
  sources: LogSource[];
  durationMs: number;
  limit: number;
  filter?: string;
  logLevel?: string;
}

async function collectJsConsole(
  client: CDPClient,
  level: string,
  limit: number,
): Promise<LogEntry[]> {
  try {
    const getExpr = client.bridgeDetected
      ? `__RN_DEV_BRIDGE__.getConsole(${JSON.stringify({ level, limit })})`
      : `__RN_AGENT.getConsole(${JSON.stringify({ level, limit })})`;

    const result = await client.evaluate(getExpr);
    if (result.error || typeof result.value !== 'string') return [];

    let parsed: unknown;
    try {
      parsed = JSON.parse(result.value);
    } catch {
      return [];
    }

    let raw: Array<{
      level?: string;
      text?: string;
      message?: string;
      timestamp?: string | number;
    }>;
    if (Array.isArray(parsed)) {
      raw = parsed;
    } else if (
      parsed &&
      typeof parsed === 'object' &&
      'entries' in parsed &&
      Array.isArray((parsed as { entries: unknown[] }).entries)
    ) {
      raw = (parsed as { entries: typeof raw }).entries;
    } else {
      return [];
    }

    return raw.map((e) => ({
      source: 'js_console' as const,
      level: e.level ?? 'log',
      text: e.message ?? e.text ?? '',
      timestamp: normalizeTimestamp(
        typeof e.timestamp === 'number' ? new Date(e.timestamp).toISOString() : e.timestamp,
      ),
    }));
  } catch {
    return [];
  }
}

const SIGKILL_GRACE_MS = 1500;

export function parseIosAppPid(launchctlList: string, bundleId: string): number | null {
  for (const line of launchctlList.split('\n')) {
    const columns = line.trim().split(/\s+/);
    if (!/^\d+$/.test(columns[0] ?? '')) continue;
    const label = columns.slice(2).join(' ');
    if (
      label === bundleId ||
      label.startsWith(`UIKitApplication:${bundleId}[`) ||
      label.startsWith(`UIKitApplication:${bundleId}<`)
    ) {
      return Number(columns[0]);
    }
  }
  return null;
}

export function buildIosLogStreamArgs(deviceId: string, pid: number | null): string[] {
  return [
    'simctl',
    'spawn',
    deviceId,
    'log',
    'stream',
    '--style',
    'ndjson',
    '--level',
    'debug',
    // A null pid means the app is not running (crashed, or not yet launched):
    // the device stays exactly scoped, but pinning to a dead pid would drop the
    // crash trail and the post-relaunch pid entirely.
    ...(pid === null ? [] : ['--predicate', `processIdentifier == ${pid}`]),
  ];
}

const PID_PROBE_TIMEOUT_MS = 5_000;

// A probe that could not run leaves the scope unresolved and must fail closed;
// only a probe that ran and proved the app absent may widen to device scope.
async function resolveIosAppPid(
  deviceId: string,
  bundleId: string,
  signal: AbortSignal,
): Promise<number | null> {
  let stdout: string;
  try {
    ({ stdout } = await execFile('xcrun', ['simctl', 'spawn', deviceId, 'launchctl', 'list'], {
      timeout: PID_PROBE_TIMEOUT_MS,
      signal,
    }));
  } catch (err) {
    throw new Error(
      `exact iOS log scope unresolved on ${deviceId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return parseIosAppPid(stdout, bundleId);
}

async function collectNativeIos(
  durationMs: number,
  signal: AbortSignal,
  deviceId: string,
  bundleId: string,
  onResolvedPid?: (pid: number | null) => void,
): Promise<LogEntry[]> {
  if (signal.aborted) return [];
  const pid = await resolveIosAppPid(deviceId, bundleId, signal);
  onResolvedPid?.(pid);

  return new Promise<LogEntry[]>((resolve, reject) => {
    const entries: LogEntry[] = [];
    let killed = false;
    let killedByUs = false;
    let settled = false;

    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn('xcrun', buildIosLogStreamArgs(deviceId, pid), {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      reject(err instanceof Error ? err : new Error('Failed to spawn xcrun'));
      return;
    }

    const killMs = durationMs > 0 ? durationMs : 100;
    let sigkillTimer: NodeJS.Timeout | undefined;
    const kill = () => {
      if (killed) return;
      killed = true;
      killedByUs = true;
      proc.kill('SIGTERM');
      sigkillTimer = setTimeout(() => proc.kill('SIGKILL'), SIGKILL_GRACE_MS);
    };
    const timeout = setTimeout(kill, killMs);

    const onAbort = () => {
      clearTimeout(timeout);
      kill();
    };
    signal.addEventListener('abort', onAbort, { once: true });

    if (signal.aborted) {
      clearTimeout(timeout);
      kill();
    }

    let stderrBuf = '';
    proc.stderr!.on('data', (chunk: Buffer) => {
      if (killed || settled) return;
      stderrBuf += chunk.toString('utf8');
    });

    let buf = '';
    proc.stdout!.on('data', (chunk: Buffer) => {
      if (killed || settled) return;
      buf += chunk.toString('utf8');
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const entry = parseIosNdjson(line);
        if (entry) entries.push(entry);
      }
    });

    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (sigkillTimer) clearTimeout(sigkillTimer);
      signal.removeEventListener('abort', onAbort);
      if (buf.trim()) {
        const entry = parseIosNdjson(buf);
        if (entry) entries.push(entry);
      }
      if (!killedByUs && code !== 0 && entries.length === 0) {
        reject(new Error(`xcrun simctl log stream exited ${code}: ${stderrBuf.slice(0, 200)}`));
      } else {
        resolve(entries);
      }
    });

    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (sigkillTimer) clearTimeout(sigkillTimer);
      signal.removeEventListener('abort', onAbort);
      killed = true;
      try {
        proc.kill('SIGKILL');
      } catch {
        /* process may not exist */
      }
      reject(err);
    });
  });
}

function parseIosNdjson(line: string): LogEntry | null {
  if (!line.trim()) return null;
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    const ts = normalizeTimestamp(typeof obj.timestamp === 'string' ? obj.timestamp : undefined);
    const messageType = String(obj.messageType ?? 'Default');
    const levelMap: Record<string, string> = {
      Default: 'log',
      Info: 'info',
      Debug: 'debug',
      Error: 'error',
      Fault: 'error',
    };
    const pid = Number(obj.processIdentifier);
    return {
      source: 'native_ios',
      level: levelMap[messageType] ?? 'log',
      text: String(obj.eventMessage ?? ''),
      timestamp: ts,
      ...(Number.isInteger(pid) && pid > 0 ? { pid } : {}),
    };
  } catch {
    return null;
  }
}

export function buildAndroidLogcatArgs(serial: string): string[] {
  return [
    '-s',
    serial,
    'logcat',
    '-v',
    'threadtime',
    '-T',
    '1',
    '-s',
    'ReactNative:V',
    'ReactNativeJS:V',
    'AndroidRuntime:E',
    'DEBUG:V',
  ];
}

function collectNativeAndroid(
  durationMs: number,
  signal: AbortSignal,
  serial: string,
): Promise<LogEntry[]> {
  if (signal.aborted) return Promise.resolve([]);

  return new Promise<LogEntry[]>((resolve, reject) => {
    const entries: LogEntry[] = [];
    const year = new Date().getFullYear();
    const killMs = durationMs > 0 ? durationMs : 100;
    let killed = false;
    let killedByUs = false;
    let settled = false;

    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn('adb', buildAndroidLogcatArgs(serial), { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      reject(err instanceof Error ? err : new Error('Failed to spawn adb'));
      return;
    }

    let sigkillTimer: NodeJS.Timeout | undefined;
    const kill = () => {
      if (killed) return;
      killed = true;
      killedByUs = true;
      proc.kill('SIGTERM');
      sigkillTimer = setTimeout(() => proc.kill('SIGKILL'), SIGKILL_GRACE_MS);
    };
    const timeout = setTimeout(kill, killMs);

    const onAbort = () => {
      clearTimeout(timeout);
      kill();
    };
    signal.addEventListener('abort', onAbort, { once: true });

    if (signal.aborted) {
      clearTimeout(timeout);
      kill();
    }

    let stderrBuf = '';
    proc.stderr!.on('data', (chunk: Buffer) => {
      if (killed || settled) return;
      stderrBuf += chunk.toString('utf8');
    });

    let buf = '';
    proc.stdout!.on('data', (chunk: Buffer) => {
      if (killed || settled) return;
      buf += chunk.toString('utf8');
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const entry = parseLogcatLine(line, year);
        if (entry) entries.push(entry);
      }
    });

    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (sigkillTimer) clearTimeout(sigkillTimer);
      signal.removeEventListener('abort', onAbort);
      if (buf.trim()) {
        const entry = parseLogcatLine(buf, year);
        if (entry) entries.push(entry);
      }
      if (!killedByUs && code !== 0 && entries.length === 0) {
        reject(new Error(`adb logcat exited ${code}: ${stderrBuf.slice(0, 200)}`));
      } else {
        resolve(entries);
      }
    });

    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (sigkillTimer) clearTimeout(sigkillTimer);
      signal.removeEventListener('abort', onAbort);
      killed = true;
      try {
        proc.kill('SIGKILL');
      } catch {
        /* process may not exist */
      }
      reject(err);
    });
  });
}

const LOGCAT_RE =
  /^(\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2}\.\d{3})\s+(\d+)\s+\d+\s+([VDIWEFS])\s+([\w./-]+)\s*:\s*(.*)$/;

const ANDROID_LEVEL_MAP: Record<string, string> = {
  V: 'debug',
  D: 'debug',
  I: 'info',
  W: 'warn',
  E: 'error',
  F: 'error',
  S: 'log',
};

export function parseLogcatLine(line: string, year: number): LogEntry | null {
  const m = LOGCAT_RE.exec(line);
  if (!m) return null;

  const [, date, time, pidStr, priority, tag, message] = m;
  // logcat emits device-LOCAL wall-clock with no offset. `new Date("...T...")`
  // (no trailing Z) already parses in the local zone, so getTime() is already
  // the correct UTC epoch — the previous `+ tzOffsetMs` double-shifted every
  // entry by the host's UTC offset, corrupting both the reported time and the
  // cross-source merge-sort ordering.
  const utcDate = new Date(`${year}-${date}T${time}`);

  return {
    source: 'native_android',
    level: ANDROID_LEVEL_MAP[priority] ?? 'log',
    text: message,
    timestamp: utcDate.toISOString(),
    pid: parseInt(pidStr, 10),
    tag,
  };
}

function matchesFilters(entry: LogEntry, filter?: string, logLevel?: string): boolean {
  if (filter && !entry.text.toLowerCase().includes(filter.toLowerCase())) return false;
  if (logLevel && logLevel !== 'all' && entry.level !== logLevel) return false;
  return true;
}

export function createCollectLogsHandler(getClient: () => CDPClient) {
  return async (args: CollectLogsArgs): Promise<ToolResult> => {
    const promises: Array<{ source: LogSource; promise: Promise<LogEntry[]> }> = [];
    const errors: Partial<Record<LogSource, string>> = {};

    const controller = new AbortController();
    // The iOS native collector spends up to PID_PROBE_TIMEOUT_MS resolving the
    // exact app pid BEFORE the log stream starts, so a deadline measured from
    // handler entry silently truncates the requested capture window.
    const hardDeadline = setTimeout(
      () => controller.abort(),
      Math.max(args.durationMs + PID_PROBE_TIMEOUT_MS + 2000, 5000),
    );

    try {
      const session = getActiveSession();
      const scopes: Partial<Record<LogSource, Record<string, unknown>>> = {};
      for (const source of args.sources) {
        switch (source) {
          case 'js_console': {
            const client = getClient();
            if (client.isConnected && client.helpersInjected) {
              promises.push({
                source,
                promise: collectJsConsole(client, args.logLevel ?? 'all', 200),
              });
            } else if (client.isConnected) {
              errors.js_console =
                'CDP connected but helpers not ready — app may still be loading. Retry in a few seconds.';
            } else {
              errors.js_console = 'CDP not connected — skipped. Call cdp_status first to connect.';
            }
            break;
          }
          case 'native_ios':
            if (session?.platform !== 'ios' || !session.deviceId || !session.appId) {
              errors.native_ios =
                'No exact iOS app session — native logs require an open session with deviceId and appId.';
              break;
            }
            scopes.native_ios = {
              deviceId: session.deviceId,
              appId: session.appId,
              process: 'unresolved',
            };
            promises.push({
              source,
              promise: collectNativeIos(
                args.durationMs,
                controller.signal,
                session.deviceId,
                session.appId,
                (pid) => {
                  scopes.native_ios = {
                    ...scopes.native_ios,
                    process:
                      pid === null ? 'app-not-running-device-scoped' : 'resolved-current-pid',
                    ...(pid === null ? {} : { pid }),
                  };
                },
              ),
            });
            break;
          case 'native_android':
            if (session?.platform !== 'android' || !session.deviceId) {
              errors.native_android =
                'No exact Android session — native logs require an open session with an adb serial.';
              break;
            }
            scopes.native_android = { serial: session.deviceId };
            promises.push({
              source,
              promise: collectNativeAndroid(args.durationMs, controller.signal, session.deviceId),
            });
            break;
        }
      }

      if (promises.length === 0) {
        if (Object.keys(errors).length > 0) {
          const msg = Object.entries(errors)
            .map(([s, e]) => `${s}: ${e}`)
            .join('; ');
          return failResult(`All sources unavailable: ${msg}`);
        }
        return failResult('No valid sources specified');
      }

      const settled = await Promise.allSettled(promises.map((p) => p.promise));

      let allEntries: LogEntry[] = [];
      for (let i = 0; i < settled.length; i++) {
        const result = settled[i];
        if (result.status === 'fulfilled') {
          allEntries.push(...result.value);
        } else {
          const src = promises[i].source;
          errors[src] =
            result.reason instanceof Error ? result.reason.message : String(result.reason);
        }
      }

      allEntries = allEntries
        .filter((e) => matchesFilters(e, args.filter, args.logLevel))
        .sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));

      const totalBeforeLimit = allEntries.length;
      if (allEntries.length > args.limit) {
        allEntries = allEntries.slice(-args.limit);
      }

      const data = {
        count: allEntries.length,
        total: totalBeforeLimit,
        truncated: totalBeforeLimit > args.limit,
        entries: allEntries,
        durationMs: args.durationMs,
        sources: args.sources,
        scopes,
      };

      const hasErrors = Object.keys(errors).length > 0;
      if (hasErrors && allEntries.length === 0) {
        const msg = Object.entries(errors)
          .map(([s, e]) => `${s}: ${e}`)
          .join('; ');
        return failResult(`All collectors failed: ${msg}`);
      }
      if (hasErrors) {
        return warnResult(data, 'Some sources failed', { errors });
      }
      return okResult(data);
    } finally {
      clearTimeout(hardDeadline);
    }
  };
}
