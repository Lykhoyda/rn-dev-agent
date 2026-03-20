import type { CDPClient } from '../cdp-client.js';
import { okResult, failResult, withConnection } from '../utils.js';

export function createEvaluateHandler(getClient: () => CDPClient) {
  return withConnection(getClient, async (args: { expression: string; awaitPromise: boolean }, client) => {
    const result = await client.evaluate(args.expression, args.awaitPromise);

    if (result.error) {
      return failResult(`Evaluation error: ${result.error}`);
    }

    return okResult({ value: result.value });
  });
}
