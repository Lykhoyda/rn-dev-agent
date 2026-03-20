import type { CDPClient } from '../cdp-client.js';
import { okResult, failResult, withConnection } from '../utils.js';

export function createDispatchHandler(getClient: () => CDPClient) {
  return withConnection(getClient, async (args: { action: string; payload?: unknown; readPath?: string }, client) => {
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

    let parsed: unknown;
    try {
      parsed = JSON.parse(result.value);
    } catch {
      return okResult({ raw: result.value });
    }

    if (parsed !== null && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      if ('__agent_error' in obj) {
        return failResult(String(obj.__agent_error));
      }
    }

    return okResult(parsed);
  });
}
