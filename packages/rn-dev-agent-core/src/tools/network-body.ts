import type { CDPClient } from '../cdp-client.js';
import { okResult, failResult, withConnection } from '../utils.js';
import { drainNetworkHookBuffer } from '../cdp/net-hook-drain.js';

export function createNetworkBodyHandler(getClient: () => CDPClient) {
  return withConnection(
    getClient,
    async (args: { requestId: string; maxLength?: number; device?: string }, client) => {
      if (!args.requestId) {
        return failResult('requestId is required. Use cdp_network_log to find request IDs.');
      }

      const scope = args.device ?? client.activeDeviceKey;
      const entry = client.networkBufferManager.getByKey(scope, args.requestId);
      if (!entry) {
        return failResult(
          `Request ${args.requestId} not found in network buffer. It may have been evicted (buffer holds last 100 requests).`,
        );
      }

      const maxLen = args.maxLength ?? 10000;

      // CDP path: Network.getResponseBody (RN 0.83+)
      if (client.networkMode === 'cdp') {
        try {
          const result = (await client.send('Network.getResponseBody', {
            requestId: args.requestId,
          })) as {
            body?: string;
            base64Encoded?: boolean;
          };

          let body = result.body ?? '';
          const truncated = body.length > maxLen;
          if (truncated) body = body.slice(0, maxLen);

          return okResult(
            {
              requestId: args.requestId,
              url: entry.url,
              status: entry.status,
              base64Encoded: result.base64Encoded ?? false,
              bodyLength: (result.body ?? '').length,
              body,
              source: 'cdp',
            },
            { truncated },
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes('No resource with given identifier') || msg.includes('No data found')) {
            return failResult(
              `Response body not available for ${args.requestId}. The response may not have finished loading.`,
              { hint: 'Check that the request has bodyAvailable: true in cdp_network_log output.' },
            );
          }
          return failResult(`Failed to get response body: ${msg}`);
        }
      }

      // D597: Hook fallback — read from JS-side __RN_AGENT_RESPONSE_BODIES__ cache.
      if (client.networkMode === 'hook') {
        if (!/^[A-Za-z0-9._-]{1,128}$/.test(args.requestId)) {
          return failResult(
            `Invalid requestId shape: expected alphanumeric / ./_/- (e.g. CDP id "12345.67" or test fixture "hook-req1"); got ${String(args.requestId).slice(0, 80)}`,
          );
        }
        await drainNetworkHookBuffer(client);
        try {
          const cache = (await client.send('Runtime.evaluate', {
            expression: 'globalThis.__RN_AGENT_RESPONSE_BODIES__',
            returnByValue: false,
          })) as { result?: { objectId?: string } };
          const objectId = cache.result?.objectId;
          if (!objectId) {
            return failResult(
              'Response body cache not available. The network hook may not have been injected yet.',
              { hint: 'Make a request first, then query its body.' },
            );
          }

          const result = (await client.send('Runtime.callFunctionOn', {
            objectId,
            functionDeclaration:
              'function(requestId) { const body = this.get(requestId); return JSON.stringify(body === undefined ? { error: "not_found" } : { body }); }',
            arguments: [{ value: args.requestId }],
            returnByValue: true,
          })) as {
            result?: { value?: unknown };
            exceptionDetails?: unknown;
          };
          if (result.exceptionDetails || typeof result.result?.value !== 'string') {
            return failResult('Failed to read body from hook cache');
          }

          const parsed = JSON.parse(result.result.value) as { error?: string; body?: string };
          if (parsed.error === 'not_found') {
            return failResult(
              `Response body for ${args.requestId} not in cache. It may have been evicted (cache holds last 50 bodies) or the request failed.`,
            );
          }

          let body = parsed.body ?? '';
          const truncated = body.length > maxLen;
          if (truncated) body = body.slice(0, maxLen);

          return okResult(
            {
              requestId: args.requestId,
              url: entry.url,
              status: entry.status,
              base64Encoded: false,
              bodyLength: (parsed.body ?? '').length,
              body,
              source: 'hook',
            },
            { truncated },
          );
        } catch (err) {
          return failResult(
            `Failed to read body from hook cache: ${err instanceof Error ? err.message : err}`,
          );
        }
      }

      return failResult(
        'Network monitoring is not active. Neither CDP Network domain nor hook fallback is enabled.',
        { hint: 'Call cdp_status to check network capabilities.' },
      );
    },
  );
}
