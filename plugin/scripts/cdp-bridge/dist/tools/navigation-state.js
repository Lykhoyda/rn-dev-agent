import { okResult, failResult, withConnection } from '../utils.js';
export function createNavigationStateHandler(getClient) {
    return withConnection(getClient, async (_args, client) => {
        const expr = client.bridgeDetected
            ? '__RN_DEV_BRIDGE__.getNavState()'
            : '__RN_AGENT.getNavState()';
        const result = await client.evaluate(expr);
        if (result.error) {
            return failResult(`Navigation state error: ${result.error}`);
        }
        if (typeof result.value !== 'string') {
            return failResult('Unexpected response from getNavState — expected JSON string');
        }
        const parsed = JSON.parse(result.value);
        if (parsed.error) {
            return failResult(`Navigation state error: ${parsed.error}`);
        }
        return okResult(parsed);
    });
}
