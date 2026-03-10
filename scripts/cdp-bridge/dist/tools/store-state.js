import { textResult, errorResult, withConnection } from '../utils.js';
export function createStoreStateHandler(getClient) {
    return withConnection(getClient, async (args, client) => {
        const expression = args.path !== undefined
            ? `__RN_AGENT.getStoreState(${JSON.stringify(args.path)})`
            : '__RN_AGENT.getStoreState()';
        const result = await client.evaluate(expression);
        if (result.error) {
            return errorResult(`Store state error: ${result.error}`);
        }
        if (typeof result.value !== 'string') {
            return errorResult('Unexpected response from getStoreState — expected JSON string');
        }
        const raw = result.value;
        if (raw.endsWith('...[TRUNCATED]')) {
            return textResult(JSON.stringify({
                warning: 'TRUNCATED',
                message: 'Store state exceeds 30KB. Use a path parameter to query a specific slice.',
                partial: raw,
            }));
        }
        let parsed;
        try {
            parsed = JSON.parse(raw);
        }
        catch {
            return textResult(raw);
        }
        if (parsed !== null && typeof parsed === 'object' && '__agent_error' in parsed) {
            const obj = parsed;
            return errorResult(`Store state error: ${obj.__agent_error}`);
        }
        return textResult(raw);
    });
}
