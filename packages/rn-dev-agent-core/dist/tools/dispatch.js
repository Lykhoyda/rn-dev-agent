import { okResult, failResult, withConnection } from '../utils.js';
export function createDispatchHandler(getClient) {
    return withConnection(getClient, async (args, client) => {
        let payload = args.payload;
        if (typeof args.payloadJson === 'string') {
            try {
                payload = JSON.parse(args.payloadJson);
            }
            catch (e) {
                return failResult(`Invalid payloadJson — must be valid JSON literal (e.g. '"42"' for the string "42"): ${e.message}`);
            }
        }
        const opts = JSON.stringify({
            action: args.action,
            payload: payload,
            readPath: args.readPath,
        });
        const result = await client.evaluate(client.helperExpr(`dispatchAction(${opts})`));
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
