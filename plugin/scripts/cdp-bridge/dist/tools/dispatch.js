import { okResult, failResult, withConnection } from '../utils.js';
export function createDispatchHandler(getClient) {
    return withConnection(getClient, async (args, client) => {
        const opts = JSON.stringify({
            action: args.action,
            payload: args.payload,
            readPath: args.readPath,
        });
        const expression = client.bridgeDetected
            ? `__RN_DEV_BRIDGE__.dispatchAction(${opts})`
            : `__RN_AGENT.dispatchAction(${opts})`;
        const result = await client.evaluate(expression);
        if (result.error) {
            return failResult(`Dispatch error: ${result.error}`);
        }
        if (typeof result.value !== 'string') {
            return failResult('Unexpected response from dispatchAction');
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
            if ('__agent_error' in obj) {
                return failResult(String(obj.__agent_error));
            }
        }
        return okResult(parsed);
    });
}
