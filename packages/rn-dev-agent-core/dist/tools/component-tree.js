import { okResult, failResult, warnResult, withConnection } from '../utils.js';
export function createComponentTreeHandler(getClient) {
    return withConnection(getClient, async (args, client) => {
        const depth = Math.min(Math.max(args.depth, 1), 12);
        const opts = { maxDepth: depth };
        if (args.filter !== undefined)
            opts.filter = args.filter;
        // GH #321: salient digest — only actionable nodes (+ text), no props/state.
        if (args.interactiveOnly === true)
            opts.interactiveOnly = true;
        const result = await client.evaluate(`__RN_AGENT.getTree(${JSON.stringify(opts)})`);
        if (result.error) {
            return failResult(`Component tree error: ${result.error}`);
        }
        if (typeof result.value !== 'string') {
            return failResult('Unexpected response from getTree — expected JSON string');
        }
        let parsed;
        try {
            parsed = JSON.parse(result.value);
        }
        catch {
            return failResult('Failed to parse component tree response');
        }
        // GH #409: the capture-time quality verdict renders once, as
        // meta.treeVerdict — absent for stale injected helpers (< v34).
        const verdict = parsed.verdict;
        const meta = verdict ? { treeVerdict: verdict } : undefined;
        if (parsed.error) {
            return failResult(`Component tree error: ${parsed.error}`, meta);
        }
        if (parsed.warning === 'APP_HAS_REDBOX') {
            return warnResult({
                message: parsed.message ??
                    'App is showing an error screen. Use cdp_error_log to read the error, fix the code, then cdp_reload.',
            }, 'APP_HAS_REDBOX', meta);
        }
        if (parsed.tree === null &&
            Array.isArray(verdict?.reasons) &&
            verdict.reasons.includes('scan-budget-exhausted')) {
            parsed.message =
                'Component tree is unavailable because the renderer scan budget was exhausted; narrow the existing filter/depth or retry after the UI settles.';
        }
        if (verdict)
            delete parsed.verdict;
        return okResult(parsed, meta ? { meta } : undefined);
    });
}
