import type { CDPClient } from '../cdp-client.js';
import { okResult, failResult, withConnection } from '../utils.js';

export function createStoreStateHandler(getClient: () => CDPClient) {
  return withConnection(getClient, async (args: { path?: string; storeType?: string }, client) => {
    const pathArg = args.path !== undefined ? JSON.stringify(args.path) : 'undefined';
    const typeArg = args.storeType ? JSON.stringify(args.storeType) : 'undefined';
    const agentExpr = `__RN_AGENT.getStoreState(${pathArg}, ${typeArg})`;
    const expression = client.bridgeDetected
      ? `(function() { try { var r = __RN_DEV_BRIDGE__.getStoreState(${pathArg}, ${typeArg}); var p = JSON.parse(r); if (p && (p.__agent_error || p.error)) return ${agentExpr}; return r; } catch(e) { return ${agentExpr}; } })()`
      : agentExpr;

    const result = await client.evaluate(expression);

    if (result.error) {
      return failResult(`Store state error: ${result.error}`);
    }

    if (typeof result.value !== 'string') {
      return failResult('Unexpected response from getStoreState — expected JSON string');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(result.value);
    } catch {
      return okResult({ raw: result.value });
    }

    if (parsed !== null && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      if ('__agent_truncated' in obj) {
        return okResult(
          { warning: 'Store state exceeds 30KB. Use a path parameter to query a specific slice.' },
          { truncated: true, meta: { originalLength: obj.originalLength } },
        );
      }
      if ('__agent_error' in obj) {
        return failResult(`Store state error: ${obj.__agent_error}`, {
          hint: obj.hint as string | undefined,
          hint2: obj.hint2 as string | undefined,
        });
      }
    }

    return okResult(parsed);
  });
}
