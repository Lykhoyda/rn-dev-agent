import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
const LEVEL_ORDER = { debug: 0, info: 1, warn: 2, error: 3 };
const configuredLevel = (process.env.LOG_LEVEL ?? process.env.RN_DEV_AGENT_LOG_LEVEL ?? 'warn');
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
        catch { /* fall through */ }
    }
    const fallbackDir = join(homedir(), '.claude', 'logs');
    try {
        if (!existsSync(fallbackDir))
            mkdirSync(fallbackDir, { recursive: true });
        return join(fallbackDir, 'rn-dev-agent-cdp-bridge.log');
    }
    catch { /* fall through */ }
    return join(tmpdir(), 'rn-dev-agent-cdp-bridge.log');
}
const logFilePath = resolveLogPath();
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
    if (logFilePath) {
        try {
            appendFileSync(logFilePath, formatted + '\n');
        }
        catch { /* best-effort */ }
    }
}
export const logger = {
    debug: (tag, msg) => writeLog('debug', tag, msg),
    info: (tag, msg) => writeLog('info', tag, msg),
    warn: (tag, msg) => writeLog('warn', tag, msg),
    error: (tag, msg) => writeLog('error', tag, msg),
    get logFilePath() { return logFilePath; },
    get level() { return configuredLevel; },
};
