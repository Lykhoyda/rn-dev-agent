import { createWriteStream, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
const LEVEL_ORDER = { debug: 0, info: 1, warn: 2, error: 3 };
const configuredLevel = (process.env.LOG_LEVEL ??
    process.env.RN_DEV_AGENT_LOG_LEVEL ??
    'warn');
function resolveLogPath() {
    if (configuredLevel !== 'debug' && configuredLevel !== 'info')
        return null;
    const pluginData = process.env.CLAUDE_PLUGIN_DATA;
    if (pluginData) {
        try {
            if (!existsSync(pluginData))
                mkdirSync(pluginData, { recursive: true });
            return join(pluginData, 'cdp-bridge.log');
        }
        catch {
            /* fall through */
        }
    }
    const fallbackDir = join(homedir(), '.claude', 'logs');
    try {
        if (!existsSync(fallbackDir))
            mkdirSync(fallbackDir, { recursive: true });
        return join(fallbackDir, 'rn-dev-agent-cdp-bridge.log');
    }
    catch {
        /* fall through */
    }
    return join(tmpdir(), 'rn-dev-agent-cdp-bridge.log');
}
const logFilePath = resolveLogPath();
// Append via a buffered WriteStream rather than appendFileSync so logging never
// blocks the event loop on the hot path (writeLog runs per tool call at
// debug/info). A single stream preserves write order; errors are swallowed
// (best-effort logging). File-backed streams don't keep the process alive.
let logStream = null;
function getLogStream() {
    if (!logFilePath)
        return null;
    if (!logStream) {
        try {
            logStream = createWriteStream(logFilePath, { flags: 'a' });
            logStream.on('error', () => {
                /* disk error — drop best-effort logs */
            });
        }
        catch {
            return null;
        }
    }
    return logStream;
}
function shouldLog(level) {
    return LEVEL_ORDER[level] >= LEVEL_ORDER[configuredLevel];
}
function formatMessage(level, tag, msg) {
    const ts = new Date().toISOString();
    return `${ts} [${level.toUpperCase()}] [${tag}] ${msg}`;
}
function writeLog(level, tag, msg) {
    if (!shouldLog(level))
        return;
    const formatted = formatMessage(level, tag, msg);
    if (level === 'error' || level === 'warn') {
        console.error(formatted);
    }
    else if (configuredLevel === 'debug' || configuredLevel === 'info') {
        console.error(formatted);
    }
    const stream = getLogStream();
    if (stream) {
        try {
            stream.write(formatted + '\n');
        }
        catch {
            /* best-effort */
        }
    }
}
export const logger = {
    debug: (tag, msg) => writeLog('debug', tag, msg),
    info: (tag, msg) => writeLog('info', tag, msg),
    warn: (tag, msg) => writeLog('warn', tag, msg),
    error: (tag, msg) => writeLog('error', tag, msg),
    get logFilePath() {
        return logFilePath;
    },
    get level() {
        return configuredLevel;
    },
};
