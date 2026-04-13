import { okResult, failResult, withConnection } from '../utils.js';
export function createNetworkBodyHandler(getClient) {
    return withConnection(getClient, async (args, client) => {
        if (!args.requestId) {
            return failResult('requestId is required. Use cdp_network_log to find request IDs.');
        }
        if (client.networkMode !== 'cdp') {
            return failResult('Network.getResponseBody requires CDP network mode (RN 0.83+). ' +
                'Current mode: ' + client.networkMode, { hint: 'The hook-based fallback does not capture response bodies.' });
        }
        const entry = client.networkBuffer.findLast(e => e.id === args.requestId);
        if (!entry) {
            return failResult(`Request ${args.requestId} not found in network buffer. It may have been evicted (buffer holds last 100 requests).`);
        }
        try {
            const result = await client.send('Network.getResponseBody', { requestId: args.requestId });
            let body = result.body ?? '';
            const maxLen = args.maxLength ?? 10000;
            const truncated = body.length > maxLen;
            if (truncated) {
                body = body.slice(0, maxLen);
            }
            return okResult({
                requestId: args.requestId,
                url: entry.url,
                status: entry.status,
                base64Encoded: result.base64Encoded ?? false,
                bodyLength: (result.body ?? '').length,
                body,
            }, { truncated });
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes('No resource with given identifier') || msg.includes('No data found')) {
                return failResult(`Response body not available for ${args.requestId}. The response may not have finished loading, or the body was not retained by the engine.`, { hint: 'Check that the request has bodyAvailable: true in cdp_network_log output.' });
            }
            return failResult(`Failed to get response body: ${msg}`);
        }
    });
}
