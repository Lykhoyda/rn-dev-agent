import { okResult, failResult, withConnection } from '../utils.js';
import { shouldShowMetroClearHint, METRO_CLEAR_HINT_TEXT } from './metro-clear-hint.js';
export function createConsoleLogHandler(getClient) {
    return withConnection(getClient, async (args, client) => {
        if (args.clear) {
            const clearResult = await client.evaluate(client.helperExpr('clearConsole()'));
            if (clearResult.error) {
                return failResult(`Failed to clear console: ${clearResult.error}`);
            }
            return okResult({ cleared: true });
        }
        const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);
        const level = args.level ?? 'all';
        const opts = JSON.stringify({ level, limit });
        const result = await client.evaluate(client.helperExpr(`getConsole(${opts})`));
        if (result.error) {
            return failResult(`Console log error: ${result.error}`);
        }
        if (typeof result.value !== 'string') {
            return failResult('Unexpected response from getConsole — expected JSON string');
        }
        let parsed;
        try {
            parsed = JSON.parse(result.value);
        }
        catch {
            return failResult(`Failed to parse console response: ${result.value.slice(0, 200)}`);
        }
        let entries;
        if (Array.isArray(parsed)) {
            entries = parsed;
        }
        else if (parsed && typeof parsed === 'object' && 'entries' in parsed && Array.isArray(parsed.entries)) {
            entries = parsed.entries;
        }
        else {
            return failResult('Unexpected response from getConsole — expected array or { entries }');
        }
        // M11: include hint when buffer has stayed empty for >60s since connect.
        // Console has no per-buffer lastPush (queries in-app __RN_AGENT.getConsole),
        // so connectedAt is the only reference point.
        const hint = shouldShowMetroClearHint({ connectedAt: client.connectedAt, now: client.now }, entries.length === 0) ? METRO_CLEAR_HINT_TEXT : undefined;
        const resultOpts = hint ? { meta: { hint } } : undefined;
        return okResult({ count: entries.length, entries }, resultOpts);
    });
}
