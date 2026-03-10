import { textResult, errorResult, withConnection } from '../utils.js';
export function createEvaluateHandler(getClient) {
    return withConnection(getClient, async (args, client) => {
        const result = await client.evaluate(args.expression, args.awaitPromise);
        if (result.error) {
            return errorResult(`Evaluation error: ${result.error}`);
        }
        const text = typeof result.value === 'string'
            ? result.value
            : JSON.stringify(result.value, null, 2);
        return textResult(text ?? 'undefined');
    });
}
