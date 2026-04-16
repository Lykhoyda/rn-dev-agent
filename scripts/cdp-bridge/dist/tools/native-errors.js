import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { okResult, failResult } from '../utils.js';
const execFile = promisify(execFileCb);
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
export function parseIOSLog(stdout) {
    const entries = [];
    for (const line of stdout.split('\n')) {
        if (!IOS_NOISE_PATTERNS.some(p => p.test(line)))
            continue;
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
export function parseAndroidLog(stdout) {
    const entries = [];
    for (const line of stdout.split('\n')) {
        if (!ANDROID_NOISE_PATTERNS.some(p => p.test(line)))
            continue;
        const tsMatch = line.match(/^(\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+)/);
        const timestamp = tsMatch ? tsMatch[1] : new Date().toISOString();
        const level = /FATAL|F\//.test(line) ? 'fatal' : 'error';
        entries.push({
            timestamp,
            source: 'android-logcat',
            level,
            message: line.trim(),
        });
    }
    return dedupeByMessage(entries);
}
function dedupeByMessage(entries) {
    const seen = new Set();
    const out = [];
    // Drop the leading timestamp so "same error at different times" collapses.
    const TS_PREFIX = /^(?:\d{4}-)?\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}\.\d+\s*/;
    for (const e of entries) {
        const key = e.message.replace(TS_PREFIX, '').replace(/\s+/g, ' ').slice(0, 200);
        if (seen.has(key))
            continue;
        seen.add(key);
        out.push(e);
    }
    return out;
}
async function defaultRunIOS(sinceSeconds) {
    const { stdout } = await execFile('xcrun', [
        'simctl',
        'spawn',
        'booted',
        'log',
        'show',
        '--style',
        'compact',
        '--last',
        `${sinceSeconds}s`,
    ], { timeout: 10_000, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
    return stdout;
}
async function defaultRunAndroid(sinceSeconds) {
    // adb logcat -d dumps recent buffer; -v time for parseable timestamps;
    // filter by severity (E/F) and cap via -t lines proxy for "last N seconds"
    // (logcat doesn't have an explicit "last Ns" flag; ~100 lines/s is a safe upper bound).
    const { stdout } = await execFile('adb', ['logcat', '-d', '-v', 'time', '-t', `${sinceSeconds * 100}`, '*:E'], { timeout: 10_000, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
    return stdout;
}
export async function readNativeErrors(opts = {}) {
    const platform = (opts.platform ?? 'ios').toLowerCase();
    const sinceSeconds = opts.sinceSeconds ?? 60;
    const limit = opts.limit ?? 10;
    try {
        if (platform === 'android') {
            const out = await (opts.runAndroid ?? (() => defaultRunAndroid(sinceSeconds)))();
            return parseAndroidLog(out).slice(-limit);
        }
        const out = await (opts.runIOS ?? (() => defaultRunIOS(sinceSeconds)))();
        return parseIOSLog(out).slice(-limit);
    }
    catch {
        // Native log tool unavailable (no xcrun / no adb) — return empty rather than throw.
        return [];
    }
}
export function createNativeErrorsHandler(getClient) {
    return async (args) => {
        const client = getClient();
        const platform = args.platform
            ?? client.connectedTarget?.platform
            ?? 'ios';
        try {
            const entries = await readNativeErrors({
                platform,
                sinceSeconds: args.sinceSeconds,
                limit: args.limit,
            });
            return okResult({
                platform,
                count: entries.length,
                entries,
                hint: entries.length === 0
                    ? 'No native errors found. If the app is broken but this returned empty, try increasing sinceSeconds (default 60).'
                    : 'Native errors captured. If these happened before __RN_AGENT injected, they explain why cdp_error_log/cdp_console_log look empty.',
            });
        }
        catch (err) {
            return failResult(err instanceof Error ? err.message : String(err));
        }
    };
}
