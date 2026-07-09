import { okResult, failResult, withConnection } from '../utils.js';
export function createStoreStateHandler(getClient) {
    return withConnection(getClient, async (args, client) => {
        const pathArg = args.path !== undefined ? JSON.stringify(args.path) : 'undefined';
        const typeArg = args.storeType ? JSON.stringify(args.storeType) : 'undefined';
        const expression = client.bridgeWithFallback(`getStoreState(${pathArg}, ${typeArg})`);
        const result = await client.evaluate(expression);
        if (result.error) {
            return failResult(`Store state error: ${result.error}`);
        }
        if (typeof result.value !== 'string') {
            return failResult('Unexpected response from getStoreState — expected JSON string');
        }
        let parsed;
        try {
            parsed = JSON.parse(result.value);
        }
        catch {
            return okResult({ raw: result.value });
        }
        if (parsed !== null && typeof parsed === 'object') {
            const obj = parsed;
            if ('__agent_truncated' in obj) {
                return okResult({ warning: 'Store state exceeds 30KB. Use a path parameter to query a specific slice.' }, { truncated: true, meta: { originalLength: obj.originalLength } });
            }
            if ('__agent_error' in obj) {
                return failResult(`Store state error: ${obj.__agent_error}`, {
                    hint: obj.hint,
                    hint2: obj.hint2,
                });
            }
        }
        return okResult(parsed);
    });
}
