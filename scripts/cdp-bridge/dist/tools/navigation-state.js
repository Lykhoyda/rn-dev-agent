import { textResult, errorResult, withConnection } from '../utils.js';
export function createNavigationStateHandler(getClient) {
    return withConnection(getClient, async (_args, client) => {
        const result = await client.evaluate('__RN_AGENT.getNavState()');
        if (result.error) {
            return errorResult(`Navigation state error: ${result.error}`);
        }
        if (typeof result.value !== 'string') {
            return errorResult('Unexpected response from getNavState — expected JSON string');
        }
        const parsed = JSON.parse(result.value);
        if (parsed.error) {
            return errorResult(`Navigation state error: ${parsed.error}`);
        }
        return textResult(result.value);
    });
}
