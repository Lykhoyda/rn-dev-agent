import { textResult, errorResult, withConnection } from '../utils.js';
export function createComponentTreeHandler(getClient) {
    return withConnection(getClient, async (args, client) => {
        const depth = Math.min(Math.max(args.depth, 1), 6);
        const filterArg = args.filter !== undefined ? JSON.stringify(args.filter) : 'undefined';
        const result = await client.evaluate(`__RN_AGENT.getTree(${depth}, ${filterArg})`);
        if (result.error) {
            return errorResult(`Component tree error: ${result.error}`);
        }
        if (typeof result.value !== 'string') {
            return errorResult('Unexpected response from getTree — expected JSON string');
        }
        const parsed = JSON.parse(result.value);
        if (parsed.error) {
            return errorResult(`Component tree error: ${parsed.error}`);
        }
        if (parsed.warning === 'APP_HAS_REDBOX') {
            return textResult(JSON.stringify({
                warning: 'APP_HAS_REDBOX',
                message: parsed.message ?? 'App is showing an error screen. Use cdp_error_log to read the error, fix the code, then cdp_reload.',
            }));
        }
        return textResult(result.value);
    });
}
