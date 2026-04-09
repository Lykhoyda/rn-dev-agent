import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const configuredLevel: LogLevel = (
  (process.env.LOG_LEVEL ?? process.env.RN_DEV_AGENT_LOG_LEVEL ?? 'warn') as LogLevel
);

function resolveLogPath(): string | null {
  if (configuredLevel !== 'debug' && configuredLevel !== 'info') return null;

  const pluginData = process.env.CLAUDE_PLUGIN_DATA;
  if (pluginData) {
    try {
      if (!existsSync(pluginData)) mkdirSync(pluginData, { recursive: true });
      return join(pluginData, 'cdp-bridge.log');
    } catch { /* fall through */ }
  }

  const fallbackDir = join(homedir(), '.claude', 'logs');
  try {
    if (!existsSync(fallbackDir)) mkdirSync(fallbackDir, { recursive: true });
    return join(fallbackDir, 'rn-dev-agent-cdp-bridge.log');
  } catch { /* fall through */ }

  return join(tmpdir(), 'rn-dev-agent-cdp-bridge.log');
}

const logFilePath = resolveLogPath();

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[configuredLevel];
}

function formatMessage(level: LogLevel, tag: string, msg: string): string {
  const ts = new Date().toISOString();
  return `${ts} [${level.toUpperCase()}] [${tag}] ${msg}`;
}

function writeLog(level: LogLevel, tag: string, msg: string): void {
  if (!shouldLog(level)) return;
  const formatted = formatMessage(level, tag, msg);

  if (level === 'error' || level === 'warn') {
    console.error(formatted);
  } else if (configuredLevel === 'debug' || configuredLevel === 'info') {
    console.error(formatted);
  }

  if (logFilePath) {
    try { appendFileSync(logFilePath, formatted + '\n'); } catch { /* best-effort */ }
  }
}

export const logger = {
  debug: (tag: string, msg: string) => writeLog('debug', tag, msg),
  info: (tag: string, msg: string) => writeLog('info', tag, msg),
  warn: (tag: string, msg: string) => writeLog('warn', tag, msg),
  error: (tag: string, msg: string) => writeLog('error', tag, msg),
  get logFilePath(): string | null { return logFilePath; },
  get level(): LogLevel { return configuredLevel; },
};
