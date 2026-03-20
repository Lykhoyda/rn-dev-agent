import { spawn } from 'node:child_process';
import type { CDPClient } from '../cdp-client.js';
import type { ToolResult } from '../utils.js';
import { okResult, failResult, warnResult } from '../utils.js';

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
    try { parsed = JSON.parse(result.value); } catch { return []; }

    let raw: Array<{ level?: string; text?: string; timestamp?: string }>;
    if (Array.isArray(parsed)) {
      raw = parsed;
    } else if (parsed && typeof parsed === 'object' && 'entries' in parsed && Array.isArray((parsed as { entries: unknown[] }).entries)) {
      raw = (parsed as { entries: Array<{ level?: string; text?: string; timestamp?: string }> }).entries;
    } else {
      return [];
    }

    return raw.map(e => ({
      source: 'js_console' as const,
      level: e.level ?? 'log',
      text: e.text ?? '',
      timestamp: normalizeTimestamp(e.timestamp),
    }));
  } catch {
    return [];
  }
}

function collectNativeIos(durationMs: number, signal: AbortSignal): Promise<LogEntry[]> {
  return new Promise<LogEntry[]>((resolve, reject) => {
    const entries: LogEntry[] = [];
    let killedByUs = false;

    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn('xcrun', [
        'simctl', 'spawn', 'booted', 'log', 'stream',
        '--style', 'ndjson',
        '--level', 'debug',
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      reject(err instanceof Error ? err : new Error('Failed to spawn xcrun'));
      return;
    }

    const killMs = durationMs > 0 ? durationMs : 100;
    const kill = () => { killedByUs = true; proc.kill('SIGTERM'); };
    const timeout = setTimeout(kill, killMs);

    const onAbort = () => { clearTimeout(timeout); kill(); };
    signal.addEventListener('abort', onAbort, { once: true });

    let stderrBuf = '';
    proc.stderr!.on('data', (chunk: Buffer) => { stderrBuf += chunk.toString('utf8'); });

    let buf = '';
    proc.stdout!.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const entry = parseIosNdjson(line);
        if (entry) entries.push(entry);
      }
    });

    proc.on('close', (code) => {
      clearTimeout(timeout);
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
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
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
      Default: 'log', Info: 'info', Debug: 'debug', Error: 'error', Fault: 'error',
    };
    return {
      source: 'native_ios',
      level: levelMap[messageType] ?? 'log',
      text: String(obj.eventMessage ?? ''),
      timestamp: ts,
    };
  } catch {
    return null;
  }
}

function collectNativeAndroid(durationMs: number, signal: AbortSignal): Promise<LogEntry[]> {
  return new Promise<LogEntry[]>((resolve, reject) => {
    const entries: LogEntry[] = [];
    const year = new Date().getFullYear();
    const tzOffsetMs = new Date().getTimezoneOffset() * 60_000;
    const killMs = durationMs > 0 ? durationMs : 100;
    let killedByUs = false;

    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn('adb', [
        'logcat', '-v', 'threadtime', '-T', '1',
        '-s', 'ReactNative:V', 'ReactNativeJS:V', 'AndroidRuntime:E', 'DEBUG:V',
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      reject(err instanceof Error ? err : new Error('Failed to spawn adb'));
      return;
    }

    const kill = () => { killedByUs = true; proc.kill('SIGTERM'); };
    const timeout = setTimeout(kill, killMs);

    const onAbort = () => { clearTimeout(timeout); kill(); };
    signal.addEventListener('abort', onAbort, { once: true });

    let stderrBuf = '';
    proc.stderr!.on('data', (chunk: Buffer) => { stderrBuf += chunk.toString('utf8'); });

    let buf = '';
    proc.stdout!.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const entry = parseLogcatLine(line, year, tzOffsetMs);
        if (entry) entries.push(entry);
      }
    });

    proc.on('close', (code) => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
      if (buf.trim()) {
        const entry = parseLogcatLine(buf, year, tzOffsetMs);
        if (entry) entries.push(entry);
      }
      if (!killedByUs && code !== 0 && entries.length === 0) {
        reject(new Error(`adb logcat exited ${code}: ${stderrBuf.slice(0, 200)}`));
      } else {
        resolve(entries);
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
      reject(err);
    });
  });
}

const LOGCAT_RE = /^(\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2}\.\d{3})\s+(\d+)\s+\d+\s+([VDIWEFS])\s+([\w./-]+)\s*:\s*(.*)$/;

const ANDROID_LEVEL_MAP: Record<string, string> = {
  V: 'debug', D: 'debug', I: 'info', W: 'warn', E: 'error', F: 'error', S: 'log',
};

function parseLogcatLine(line: string, year: number, tzOffsetMs: number): LogEntry | null {
  const m = LOGCAT_RE.exec(line);
  if (!m) return null;

  const [, date, time, pidStr, priority, tag, message] = m;
  const localDate = new Date(`${year}-${date}T${time}`);
  const utcDate = new Date(localDate.getTime() + tzOffsetMs);

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
    const hardDeadline = setTimeout(
      () => controller.abort(),
      Math.max(args.durationMs + 2000, 5000),
    );

    try {
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
              errors.js_console = 'CDP connected but helpers not ready — app may still be loading. Retry in a few seconds.';
            } else {
              errors.js_console = 'CDP not connected — skipped. Call cdp_status first to connect.';
            }
            break;
          }
          case 'native_ios':
            promises.push({ source, promise: collectNativeIos(args.durationMs, controller.signal) });
            break;
          case 'native_android':
            promises.push({ source, promise: collectNativeAndroid(args.durationMs, controller.signal) });
            break;
        }
      }

      if (promises.length === 0) {
        if (Object.keys(errors).length > 0) {
          const msg = Object.entries(errors).map(([s, e]) => `${s}: ${e}`).join('; ');
          return failResult(`All sources unavailable: ${msg}`);
        }
        return failResult('No valid sources specified');
      }

      const settled = await Promise.allSettled(promises.map(p => p.promise));

      let allEntries: LogEntry[] = [];
      for (let i = 0; i < settled.length; i++) {
        const result = settled[i];
        if (result.status === 'fulfilled') {
          allEntries.push(...result.value);
        } else {
          const src = promises[i].source;
          errors[src] = result.reason instanceof Error ? result.reason.message : String(result.reason);
        }
      }

      allEntries = allEntries
        .filter(e => matchesFilters(e, args.filter, args.logLevel))
        .sort((a, b) => a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0);

      const data = {
        count: allEntries.length,
        entries: allEntries,
        durationMs: args.durationMs,
        sources: args.sources,
      };

      const hasErrors = Object.keys(errors).length > 0;
      if (hasErrors && allEntries.length === 0) {
        const msg = Object.entries(errors).map(([s, e]) => `${s}: ${e}`).join('; ');
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
