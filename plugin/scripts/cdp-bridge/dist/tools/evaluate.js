import { okResult, failResult, withConnection } from '../utils.js';
export function createEvaluateHandler(getClient) {
    return withConnection(getClient, async (args, client) => {
        const result = await client.evaluate(args.expression, args.awaitPromise);
        if (result.error) {
            return failResult(`Evaluation error: ${result.error}`);
        }
        return okResult({ value: result.value });
    });
}
