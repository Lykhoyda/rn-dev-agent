import type { CDPClient } from '../cdp-client.js';
import { okResult, failResult, warnResult, withConnection } from '../utils.js';

export function createComponentTreeHandler(getClient: () => CDPClient) {
  return withConnection(getClient, async (args: { filter?: string; depth: number }, client) => {
    const depth = Math.min(Math.max(args.depth, 1), 12);
    const opts: Record<string, unknown> = { maxDepth: depth };
    if (args.filter !== undefined) opts.filter = args.filter;

    const result = await client.evaluate(
      `__RN_AGENT.getTree(${JSON.stringify(opts)})`
    );

    if (result.error) {
      return failResult(`Component tree error: ${result.error}`);
    }

    if (typeof result.value !== 'string') {
      return failResult('Unexpected response from getTree — expected JSON string');
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(result.value) as Record<string, unknown>;
    } catch {
      return failResult('Failed to parse component tree response');
    }

    if (parsed.error) {
      return failResult(`Component tree error: ${parsed.error}`);
    }

    if (parsed.warning === 'APP_HAS_REDBOX') {
      return warnResult(
        { message: parsed.message ?? 'App is showing an error screen. Use cdp_error_log to read the error, fix the code, then cdp_reload.' },
        'APP_HAS_REDBOX',
      );
    }

    return okResult(parsed);
  });
}
