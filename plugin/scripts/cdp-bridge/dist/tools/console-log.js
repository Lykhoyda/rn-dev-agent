import { okResult, failResult, withConnection } from '../utils.js';
export function createConsoleLogHandler(getClient) {
    return withConnection(getClient, async (args, client) => {
        if (args.clear) {
            const clearExpr = client.bridgeDetected ? '__RN_DEV_BRIDGE__.clearConsole()' : '__RN_AGENT.clearConsole()';
            const clearResult = await client.evaluate(clearExpr);
            if (clearResult.error) {
                return failResult(`Failed to clear console: ${clearResult.error}`);
            }
            return okResult({ cleared: true });
        }
        const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);
        const level = args.level ?? 'all';
        const getExpr = client.bridgeDetected
            ? `__RN_DEV_BRIDGE__.getConsole(${JSON.stringify({ level, limit })})`
            : `__RN_AGENT.getConsole(${JSON.stringify({ level, limit })})`;
        const result = await client.evaluate(getExpr);
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
        return okResult({ count: entries.length, entries });
    });
}
